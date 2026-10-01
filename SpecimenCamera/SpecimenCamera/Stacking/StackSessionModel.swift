import Foundation
import Combine
import UIKit
import SpecimenCore

enum ShootMode: String, CaseIterable, Identifiable {
    case single = "SINGLE", focus = "FOCUS", lighting = "LIGHTING", combined = "COMBINED"
    var id: String { rawValue }
    var stackType: StackType? {
        switch self { case .single: return nil; case .focus: return .focus; case .lighting: return .lighting; case .combined: return .combined }
    }
}

enum FrameCountChoice: Equatable { case auto, manual(Int) }

/// UI-facing workflow for FOCUS / LIGHTING / COMBINED stacks. Hardware-independent logic lives in `StackCaptureCoordinator`
/// and `FocusStepPlanner` (unit-tested); this class connects them to the camera, motion sensors, preflight checks and the UI.
@MainActor
final class StackSessionModel: ObservableObject {
    @Published var mode: ShootMode = .single { didSet { if mode != oldValue { modeChanged() } } }
    @Published private(set) var nearFocus: Float?
    @Published private(set) var farFocus: Float?
    @Published var frameCountChoice: FrameCountChoice = .auto { didSet { refreshPlan() } }
    @Published private(set) var plan: FocusPlan?
    @Published private(set) var isActive = false
    @Published private(set) var isBusy = false
    @Published private(set) var project: StackProject?
    @Published private(set) var statusText = ""
    @Published private(set) var motionWarning: String?
    @Published private(set) var issues: [PreflightIssue] = []
    @Published private(set) var lockedSummary: String?
    @Published var errorMessage: String?
    @Published private(set) var capturedFrames = 0
    @Published private(set) var lightPositions = 0
    @Published private(set) var thumbnails: [UIImage] = []
    /// Seconds left on the shutter delay (0 = not counting).
    @Published private(set) var countdown = 0

    private let camera: CameraController
    private let motion: MotionService
    private let processing: ProcessingService
    private let settings: AppSettings
    private let status: DeviceStatus
    private var coordinator: StackCaptureCoordinator?
    private var eventTask: Task<Void, Never>?
    private var bag = Set<AnyCancellable>()

    init(camera: CameraController, motion: MotionService, processing: ProcessingService, settings: AppSettings, status: DeviceStatus) {
        self.camera = camera; self.motion = motion; self.processing = processing; self.settings = settings; self.status = status
        camera.$interruption.removeDuplicates().sink { [weak self] msg in
            Task { @MainActor in
                guard let self, let c = self.coordinator else { return }
                if let msg { await c.interrupt(reason: msg); self.statusText = "Interrupted: \(msg). Frames kept." } else { await c.resume(); self.statusText = "Camera is back — continue." }
            }
        }.store(in: &bag)
        camera.$activeLensID.removeDuplicates().sink { [weak self] _ in self?.lensChanged() }.store(in: &bag)
        settings.$stackDensity.sink { [weak self] _ in DispatchQueue.main.async { self?.refreshPlan() } }.store(in: &bag)
        motion.onMoved = { [weak self] drift in
            Task { @MainActor in
                guard let self else { return }
                self.motionWarning = String(format: "The phone moved %.1f° — keep it fixed. Alignment corrects small shifts.", drift)
                await self.coordinator?.motionDetected(driftDegrees: drift)
            }
        }
    }

    // MARK: Focus range

    var canSetFocusRange: Bool { camera.activeLens?.supportsManualFocus ?? false }

    func setNear() { nearFocus = camera.displayedLensPosition; refreshPlan() }
    func setFar() { farFocus = camera.displayedLensPosition; refreshPlan() }
    func clearRange() { nearFocus = nil; farFocus = nil; plan = nil }

    private func lensChanged() {
        // Lens positions mean different things on different modules: a stored NEAR/FAR would be wrong.
        if !isActive { clearRange() }
    }

    func refreshPlan() {
        guard let near = nearFocus, let far = farFocus, let lens = camera.activeLens else { plan = nil; return }
        var manual: Int? = nil
        if case .manual(let n) = frameCountChoice { manual = n }
        plan = FocusStepPlanner.plan(near: near, far: far, model: lens.focusModel, optics: lens.optics, density: settings.stackDensity, manualCount: manual)
    }

    var statusLine: String {
        guard mode != .single else { return "" }
        return statusText
    }

    private func modeChanged() {
        if isActive { return }
        statusText = ""
        errorMessage = nil
        issues = []
    }

    // MARK: Start / capture

    /// The user's shutter delay (Settings). Lets the phone settle after the tap; also used before single photos.
    func waitShutterDelay() async {
        var n = settings.shutterDelaySeconds
        while n > 0 { countdown = n; try? await Task.sleep(nanoseconds: 1_000_000_000); n -= 1 }
        countdown = 0
    }

    /// Whether the shutter button can start or continue the current mode.
    var canStartFocusLike: Bool { (mode == .focus || mode == .combined) && plan != nil && nearFocus != nil && farFocus != nil }

    func start() async {
        guard let type = mode.stackType, !isActive, !isBusy else { return }
        guard let lens = camera.activeLens else { return }
        if type != .lighting, plan == nil { errorMessage = "Set NEAR and FAR focus first."; return }
        if type != .lighting, !lens.supportsManualFocus { errorMessage = "This camera cannot be focused manually, so focus stacks are not available."; return }
        if type != .lighting, (plan?.count ?? 0) < 2 { errorMessage = "NEAR and FAR are at the same focus position. Move the focus to the far end of the specimen and press SET FAR again."; return }
        // preflight
        let groups: [Int] = {
            switch type {
            case .focus: return [plan?.count ?? 0]
            case .lighting: return Array(repeating: 1, count: 6)
            case .combined: return Array(repeating: plan?.count ?? 0, count: 4)
            }
        }()
        let dims = camera.photoSize(for: camera.captureFormat)
        let est = StackPreflight.estimate(type: type, groupSizes: groups, format: camera.captureFormat, width: dims.width, height: dims.height, keepSources: settings.keepSourceFrames)
        issues = status.preflight(estimate: est)
        if issues.contains(where: { $0.isBlocking }) { errorMessage = issues.first(where: { $0.isBlocking })?.message; return }

        isBusy = true; defer { isBusy = false }
        var setup = StackSetup(type: type, configuration: CaptureConfiguration(), settings: camera.currentSettings(), lens: lens)
        setup.collectionID = processing.library.activeCollection.id
        setup.quality = settings.stackQuality; setup.keepSourceFrames = settings.keepSourceFrames
        setup.finalFormat = settings.defaultFinalFormat; setup.saveDestination = settings.saveDestination
        if type != .lighting { setup.focusPlan = plan; setup.nearFocus = nearFocus; setup.farFocus = farFocus }
        setup.configuration.format = camera.captureFormat
        setup.configuration.width = dims.width; setup.configuration.height = dims.height

        let driver = StackCameraDriver(engine: camera.engine, quality: { [settings] in settings.stackQuality })
        let c = StackCaptureCoordinator(store: processing.store, camera: driver, settleSeconds: 0.35)
        coordinator = c
        eventTask?.cancel()
        eventTask = Task { [weak self] in
            for await e in c.events { await MainActor.run { self?.handle(e) } }
        }
        do {
            let p = try await c.begin(setup)
            project = p; isActive = true; capturedFrames = 0; lightPositions = 0; thumbnails = []
            if let lock = await c.lockedSettings() {
                camera.adoptStackLocks(lock)
                lockedSummary = "LOCKED: ISO \(Int(lock.iso)) · \(ExposureScales.shutterLabel(lock.shutterSeconds)) · \(Int(lock.whiteBalanceKelvin)) K"
            }
            camera.setUserControlsLocked(true)
            motion.beginStackMonitoring()
            motionWarning = nil
            statusText = type == .lighting ? "LIGHTING STACK — capture frame 1" : "STACK READY — keep the phone fixed"
            ScreenAwake.hold("stack")
        } catch {
            errorMessage = error.localizedDescription
            coordinator = nil
        }
    }

    /// FOCUS: runs the whole series and finishes. COMBINED: one light position per call.
    func captureFocusSeries() async {
        guard let c = coordinator, !isBusy else { return }
        isBusy = true; defer { isBusy = false }
        do {
            try await c.captureFocusSeries()
            await refreshCounts()
            if mode == .focus { await finish() }
        } catch {
            errorMessage = error.localizedDescription
            await refreshCounts()
        }
    }

    func captureLightingFrame() async {
        guard let c = coordinator, !isBusy else { return }
        isBusy = true; defer { isBusy = false }
        do { try await c.captureLightingFrame() } catch { errorMessage = error.localizedDescription }
        await refreshCounts()
    }

    func deleteLast() async {
        guard let c = coordinator else { return }
        try? await c.deleteLast()
        await refreshCounts()
    }

    func retakeLast() async {
        guard let c = coordinator, !isBusy else { return }
        isBusy = true; defer { isBusy = false }
        do { try await c.retakeLast() } catch { errorMessage = error.localizedDescription }
        await refreshCounts()
    }

    /// FINISH: closes capture and hands the project to processing.
    func finish() async {
        guard let c = coordinator else { return }
        do {
            let p = try await c.finish()
            endSession()
            statusText = "Processing…"
            await processing.process(projectID: p.id)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func cancelStack() async {
        if let c = coordinator { await c.discard() }
        endSession()
        statusText = "Stack discarded"
    }

    private func endSession() {
        eventTask?.cancel(); coordinator = nil
        isActive = false; project = nil; motion.endStackMonitoring(); motionWarning = nil; lockedSummary = nil
        ScreenAwake.release("stack")
        camera.setUserControlsLocked(false)
    }

    private func refreshCounts() async {
        guard let c = coordinator, let p = await c.snapshot() else { return }
        project = p
        capturedFrames = p.frameCount
        lightPositions = mode == .focus ? 0 : p.groups.count
        thumbnails = p.groups.compactMap { g in g.frames.first }.suffix(8).compactMap { ThumbnailService.image(for: processing.store.frameURL(project: p, frame: $0), maxPixel: 120) }
    }

    private func handle(_ e: CaptureEvent) {
        switch e {
        case .started(let t): statusText = "\(t.title) STACK STARTED"
        case .focusFrameCaptured(let i, let n, let l):
            statusText = l.map { "LIGHT POSITION \($0 + 1): FOCUS FRAME \(i)/\(n)" } ?? "CAPTURING FOCUS FRAME \(i)/\(n)"
            Log.stack.info("captured focus frame \(i)/\(n)")
            Task { await refreshCounts() }
        case .lightingFrameCaptured(let p):
            statusText = "FRAME \(p) ✓ — MOVE LIGHT → CAPTURE NEXT"
            Log.stack.info("captured lighting frame \(p)")
        case .lightPositionComplete(let p): statusText = "LIGHTING POSITION \(p) COMPLETE → MOVE LIGHT → CAPTURE NEXT"
        case .motionWarning(let m): motionWarning = m
        case .settingsDrifted(let m): errorMessage = m
        case .interrupted(let r): statusText = "Interrupted: \(r)"
        case .frameDeleted: statusText = "Last capture removed"
        case .finished(let n): statusText = "\(n) frames captured"
        case .discarded: statusText = "Discarded"
        }
    }

    func acknowledgeMotion() { motion.acknowledgeMovement(); motionWarning = nil }

    /// Frame-count presets from the spec (5, 10, 15, 20, 30) plus AUTO and any custom number.
    static let presets = FocusStepPlanner.presetCounts
}
