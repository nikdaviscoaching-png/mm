import Foundation

public struct CapturedFrameInfo: Sendable, Equatable {
    public var fileName: String
    public var kind: FrameFileKind
    public var byteSize: Int64
    public var iso: Float?
    public var shutterSeconds: Double?
    public init(fileName: String, kind: FrameFileKind, byteSize: Int64, iso: Float? = nil, shutterSeconds: Double? = nil) {
        self.fileName = fileName; self.kind = kind; self.byteSize = byteSize; self.iso = iso; self.shutterSeconds = shutterSeconds
    }
}

public enum CaptureFailure: Error, Sendable, Equatable, LocalizedError {
    case interrupted(String)
    case cameraFailure(String)
    case invalidState(String)
    public var errorDescription: String? {
        switch self {
        case .interrupted(let s): return "Capture interrupted: \(s). Your frames so far are kept."
        case .cameraFailure(let s): return "Camera error: \(s)"
        case .invalidState(let s): return s
        }
    }
}

/// The camera side of a stack. The iOS app implements this on top of AVFoundation; tests use a mock. Everything that must
/// hold still during a stack is pinned through `lockForStack`; only `setLensPosition` (focus stacks) changes anything.
public protocol CameraDriving: Sendable {
    func lockForStack(_ plan: LockPlan) async throws
    func unlockAfterStack() async
    /// Returns once the lens reports it has reached `position`.
    func setLensPosition(_ position: Float) async throws
    /// Captures into `directory/fileName` and returns what was written.
    func capturePhoto(format: CaptureFormat, into directory: URL, fileName: String) async throws -> CapturedFrameInfo
}

public enum CaptureEvent: Sendable, Equatable {
    case started(StackType)
    case focusFrameCaptured(index: Int, of: Int, lightPosition: Int?)
    case lightingFrameCaptured(position: Int)
    case lightPositionComplete(position: Int)
    case motionWarning(String)
    case settingsDrifted(String)
    case interrupted(String)
    case frameDeleted
    case finished(frameCount: Int)
    case discarded
}

public enum CaptureState: Sendable, Equatable {
    case idle
    case ready                       // locked, waiting for the next action
    case capturing
    case interrupted(String)
    case finished
}

public struct StackSetup: Sendable {
    public var type: StackType
    public var configuration: CaptureConfiguration
    public var settings: CameraSettings
    public var lens: LensInfo
    public var collectionID: UUID?
    public var quality: StackQuality = .maximum
    public var keepSourceFrames = false
    public var finalFormat: FinalFormat = .jpeg
    public var saveDestination: SaveDestination = .appLibrary
    public var focusPlan: FocusPlan? = nil
    public var nearFocus: Float? = nil
    public var farFocus: Float? = nil
    public init(type: StackType, configuration: CaptureConfiguration, settings: CameraSettings, lens: LensInfo) {
        self.type = type; self.configuration = configuration; self.settings = settings; self.lens = lens
    }
}

/// Orchestrates capture for FOCUS, LIGHTING and COMBINED stacks.
///  * Locks lens/exposure/white balance (and focus for lighting) before the first frame.
///  * Focus series: moves only the lens position, waits for it to settle, captures, persists the manifest per frame.
///  * Lighting: one frame per user-confirmed light position; combined: a complete focus series per light position.
///  * Interruptions keep every captured frame; `resume` continues where the series stopped.
public actor StackCaptureCoordinator {
    private let store: TemporaryStackStore
    private let camera: any CameraDriving
    private let baseSettleSeconds: Double
    private let sleep: @Sendable (Double) async -> Void
    private(set) public var state: CaptureState = .idle
    private var project: StackProject?
    private var setup: StackSetup?
    private var lockPlan: LockPlan?
    private var continuation: AsyncStream<CaptureEvent>.Continuation?
    public nonisolated let events: AsyncStream<CaptureEvent>

    public init(store: TemporaryStackStore, camera: any CameraDriving, settleSeconds: Double = 0.35,
                sleep: @escaping @Sendable (Double) async -> Void = { try? await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) }) {
        self.store = store; self.camera = camera; self.baseSettleSeconds = settleSeconds; self.sleep = sleep
        var c: AsyncStream<CaptureEvent>.Continuation!
        events = AsyncStream { c = $0 }
        continuation = c
    }

    deinit { continuation?.finish() }

    /// Larger lens moves need longer to damp out before the exposure (macro lenses ring), so settling scales with distance.
    public static func settleTime(base: Double, move: Float) -> Double { base + min(0.6, Double(abs(move)) * 1.5) }

    public func snapshot() -> StackProject? { project }
    public func lockedSettings() -> LockPlan? { lockPlan }

    // MARK: Begin

    @discardableResult
    public func begin(_ setup: StackSetup) async throws -> StackProject {
        guard state == .idle || state == .finished else { throw CaptureFailure.invalidState("A stack is already in progress.") }
        if setup.type != .lighting {
            guard let plan = setup.focusPlan, plan.count >= 2 else { throw CaptureFailure.invalidState("Set NEAR and FAR focus first.") }
        }
        let lock = StackLockPolicy.plan(current: setup.settings, type: setup.type, lens: setup.lens)
        try await camera.lockForStack(lock)
        var p = StackProject(type: setup.type)
        p.configuration = setup.configuration
        p.configuration.lensID = setup.lens.id; p.configuration.lensName = setup.lens.name
        p.configuration.equivalentFocalLength = setup.lens.equivalentFocalLengthMM
        p.configuration.iso = lock.iso; p.configuration.shutterSeconds = lock.shutterSeconds
        p.configuration.whiteBalanceKelvin = lock.whiteBalanceKelvin; p.configuration.whiteBalanceTint = lock.tint
        p.configuration.lensPosition = lock.pinnedLensPosition; p.configuration.format = lock.format
        p.collectionID = setup.collectionID; p.quality = setup.quality; p.keepSourceFrames = setup.keepSourceFrames
        p.finalFormat = setup.finalFormat; p.saveDestination = setup.saveDestination
        p.plannedFocusFrames = setup.focusPlan?.count
        if setup.type == .focus {
            var g = FocusStackGroup(); g.nearFocus = setup.nearFocus; g.farFocus = setup.farFocus
            p.groups = [g]
        }
        try store.createProject(p)
        project = p; self.setup = setup; lockPlan = lock
        state = .ready
        emit(.started(setup.type))
        return p
    }

    // MARK: Focus series (FOCUS, and one light position of COMBINED)

    /// Captures the full focus series for the current group (resuming a partial one). For COMBINED each call is one light position.
    public func captureFocusSeries() async throws {
        guard let setup, var p = project, let plan = setup.focusPlan, setup.type != .lighting else { throw CaptureFailure.invalidState("Focus series is not available for this stack.") }
        guard state == .ready || { if case .interrupted = state { return true } else { return false } }() else { throw CaptureFailure.invalidState("Camera is busy.") }
        state = .capturing
        if setup.type == .combined, p.groups.last.map({ $0.frames.count >= plan.count }) ?? true {
            var g = FocusStackGroup(lightingPosition: p.groups.count); g.nearFocus = setup.nearFocus; g.farFocus = setup.farFocus
            p.groups.append(g); project = p
        }
        let gi = p.groups.count - 1
        var lastPos: Float? = p.groups[gi].frames.last?.focusPosition
        do {
            var i = p.groups[gi].frames.count
            while i < plan.count {
                if Task.isCancelled { throw CaptureFailure.interrupted("cancelled") }
                let pos = plan.positions[i]
                try await camera.setLensPosition(pos)
                await sleep(Self.settleTime(base: baseSettleSeconds, move: pos - (lastPos ?? pos)))
                let name = store.newFrameFileName(project: project!, ext: Self.fileExtension(for: setup.settings.format))
                let info = try await camera.capturePhoto(format: setup.settings.format, into: store.framesDirectory(p.id), fileName: name)
                var f = StackFrame(fileName: info.fileName, kind: info.kind)
                f.focusPosition = pos; f.lightingPosition = p.groups[gi].lightingPosition; f.iso = info.iso; f.shutterSeconds = info.shutterSeconds; f.byteSize = info.byteSize
                project!.groups[gi].frames.append(f)
                try store.save(project!)
                p = project!
                lastPos = pos
                i += 1
                checkDrift(info)
                emit(.focusFrameCaptured(index: i, of: plan.count, lightPosition: p.groups[gi].lightingPosition))
            }
            state = .ready
            if setup.type == .combined { emit(.lightPositionComplete(position: gi + 1)) }
        } catch {
            let reason = (error as? CaptureFailure).flatMap { f -> String? in if case .interrupted(let s) = f { return s } else { return nil } } ?? error.localizedDescription
            state = .interrupted(reason)
            emit(.interrupted(reason))
            throw error
        }
    }

    // MARK: Lighting

    /// Captures one frame at the current light position (LIGHTING stacks). Focus, exposure and white balance stay pinned.
    public func captureLightingFrame() async throws {
        guard let setup, var p = project, setup.type == .lighting else { throw CaptureFailure.invalidState("Lighting capture is not available for this stack.") }
        guard state == .ready || { if case .interrupted = state { return true } else { return false } }() else { throw CaptureFailure.invalidState("Camera is busy.") }
        state = .capturing
        do {
            let name = store.newFrameFileName(project: p, ext: Self.fileExtension(for: setup.settings.format), label: "light")
            let info = try await camera.capturePhoto(format: setup.settings.format, into: store.framesDirectory(p.id), fileName: name)
            var g = FocusStackGroup(lightingPosition: p.groups.count)
            var f = StackFrame(fileName: info.fileName, kind: info.kind)
            f.lightingPosition = g.lightingPosition; f.iso = info.iso; f.shutterSeconds = info.shutterSeconds; f.byteSize = info.byteSize
            f.focusPosition = lockPlan?.pinnedLensPosition
            g.frames = [f]
            p.groups.append(g); project = p
            try store.save(p)
            checkDrift(info)
            state = .ready
            emit(.lightingFrameCaptured(position: p.groups.count))
        } catch {
            let reason = error.localizedDescription
            state = .interrupted(reason); emit(.interrupted(reason)); throw error
        }
    }

    // MARK: Editing

    /// Removes the most recent frame (FOCUS) or light position (LIGHTING/COMBINED) and deletes its file(s).
    public func deleteLast() throws {
        guard var p = project, let setup else { return }
        switch setup.type {
        case .focus:
            guard let f = p.groups[0].frames.last else { return }
            store.removeFrameFile(project: p, frame: f)
            p.groups[0].frames.removeLast()
        case .lighting, .combined:
            guard let g = p.groups.last else { return }
            for f in g.frames { store.removeFrameFile(project: p, frame: f) }
            p.groups.removeLast()
        }
        project = p
        try store.save(p)
        emit(.frameDeleted)
    }

    public func retakeLast() async throws {
        guard let setup else { return }
        try deleteLast()
        switch setup.type {
        case .lighting: try await captureLightingFrame()
        case .focus, .combined: try await captureFocusSeries()
        }
    }

    // MARK: Interruption / motion

    public func interrupt(reason: String) {
        guard state != .idle, state != .finished else { return }
        state = .interrupted(reason)
        emit(.interrupted(reason))
        if let p = project { var q = p; q.failureMessage = reason; try? store.save(q) }
    }

    /// The camera is available again; the next capture call continues the interrupted series.
    public func resume() { if case .interrupted = state { state = .ready } }

    public func motionDetected(driftDegrees: Double) {
        emit(.motionWarning(String(format: "The phone moved %.1f° during the stack — keep it fixed. Small shifts are corrected by alignment.", driftDegrees)))
    }

    // MARK: Finish

    @discardableResult
    public func finish() async throws -> StackProject {
        guard var p = project, let setup else { throw CaptureFailure.invalidState("No stack in progress.") }
        switch setup.type {
        case .focus:
            guard p.groups[0].frames.count >= 2 else { throw CaptureFailure.invalidState("A focus stack needs at least 2 frames.") }
        case .lighting:
            guard p.groups.count >= 2 else { throw CaptureFailure.invalidState("A lighting stack needs at least 2 light positions.") }
        case .combined:
            guard p.groups.count >= 2 else { throw CaptureFailure.invalidState("A combined stack needs at least 2 light positions.") }
            if let plan = setup.focusPlan, p.groups.contains(where: { $0.frames.count < plan.count }) {
                throw CaptureFailure.invalidState("The last light position is incomplete — finish its focus series or delete it.")
            }
        }
        p.status = .readyToProcess
        try store.save(p)
        project = p
        state = .finished
        await camera.unlockAfterStack()
        emit(.finished(frameCount: p.frameCount))
        return p
    }

    /// Throws everything away (explicit user action).
    public func discard() async {
        if let p = project { store.discard(p.id) }
        project = nil; setup = nil; lockPlan = nil
        state = .idle
        await camera.unlockAfterStack()
        emit(.discarded)
    }

    // MARK: Helpers

    private func emit(_ e: CaptureEvent) { continuation?.yield(e) }

    private func checkDrift(_ info: CapturedFrameInfo) {
        if let lock = lockPlan, !StackLockPolicy.exposureHolds(plan: lock, iso: info.iso, shutter: info.shutterSeconds) {
            emit(.settingsDrifted("Exposure changed during the stack (ISO \(Int(info.iso ?? 0)), \(ExposureScales.shutterLabel(info.shutterSeconds ?? 0))). Brightness may differ between frames."))
        }
    }

    public static func fileExtension(for format: CaptureFormat) -> String {
        switch format { case .standard, .maximumQuality: return "heic"; case .raw, .proRAW: return "dng" }
    }
}
