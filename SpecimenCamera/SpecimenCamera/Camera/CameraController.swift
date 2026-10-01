import Foundation
import AVFoundation
import UIKit
import SpecimenCore

/// UI-facing camera state and commands. All hardware work is delegated to `CameraEngine`; this class only decides what the
/// user asked for and publishes what the camera is really doing.
@MainActor
final class CameraController: ObservableObject {

    let engine = CameraEngine()

    @Published private(set) var authorization: CameraAuthorization = CameraCapabilityManager.authorization
    @Published private(set) var capabilities = CameraCapabilities(lenses: [])
    @Published private(set) var activeLensID = ""
    @Published private(set) var live = LiveSnapshot()
    @Published private(set) var isRunning = false
    @Published private(set) var interruption: String?
    @Published var errorMessage: String?
    @Published private(set) var isCapturing = false
    /// True while a stack is running: lens, exposure, white balance, focus and capture format are pinned by the stack, so
    /// nothing the user taps may change them (a tap-to-focus or a lens switch mid-stack would ruin the result).
    @Published private(set) var userControlsLocked = false

    // What the user has asked for (manual vs automatic per parameter)
    @Published var isoManual = false
    @Published var shutterManual = false
    @Published var iso: Float = 100
    @Published var shutter: Double = 1.0 / 60
    @Published var exposureBias: Float = 0
    @Published var wbManual = false
    @Published var wbLocked = false
    @Published var kelvin: Float = 5000
    @Published var tint: Float = 0
    @Published var focusManual = false
    @Published var focusLocked = false
    @Published var lensPosition: Float = 0.5
    @Published var captureFormat: CaptureFormat = .standard

    var activeLens: LensInfo? { capabilities.lens(id: activeLensID) }
    var availableFormats: [CaptureFormat] { activeLens?.availableFormats ?? [.standard] }
    var isoOptions: [Float] { activeLens.map { ExposureScales.isoValues(min: $0.isoMin, max: $0.isoMax) } ?? [] }
    var shutterOptions: [Double] { activeLens.map { ExposureScales.shutterValues(min: $0.shutterMinSeconds, max: $0.shutterMaxSeconds) } ?? [] }
    var biasOptions: [Float] { activeLens.map { ExposureScales.biasValues(min: $0.exposureBiasMin, max: $0.exposureBiasMax) } ?? [] }
    var exposureIsAuto: Bool { !isoManual && !shutterManual }
    var displayedISO: Float { isoManual ? iso : live.iso }
    var displayedShutter: Double { shutterManual ? shutter : live.exposureSeconds }
    var displayedLensPosition: Float { focusManual || focusLocked ? lensPosition : live.lensPosition }
    var displayedKelvin: Float { wbManual ? kelvin : live.kelvin }

    private var configured = false
    private var starting = false

    func setUserControlsLocked(_ locked: Bool) { userControlsLocked = locked }

    /// Pixel size of the photo the given format will really produce on the active lens (read from the running session).
    func photoSize(for format: CaptureFormat) -> (width: Int, height: Int) {
        switch format {
        case .standard, .raw:
            if live.standardPhotoWidth > 0 { return (width: live.standardPhotoWidth, height: live.standardPhotoHeight) }
            return (width: 4032, height: 3024)
        case .maximumQuality, .proRAW:
            if live.maxPhotoWidth > 0 { return (width: live.maxPhotoWidth, height: live.maxPhotoHeight) }
            return (width: activeLens?.maxPhotoWidth ?? 4032, height: activeLens?.maxPhotoHeight ?? 3024)
        }
    }

    init() {
        engine.onLive = { [weak self] snap in Task { @MainActor in self?.live = snap } }
        engine.onInterruption = { [weak self] msg in Task { @MainActor in self?.interruption = msg } }
        engine.onRunningChanged = { [weak self] r in Task { @MainActor in self?.isRunning = r } }
        engine.onError = { [weak self] m in Task { @MainActor in self?.errorMessage = m } }
    }

    // MARK: Lifecycle

    func start() async {
        // `.task` and the scene-active notification can both call this at launch: only one may configure the session.
        guard !starting else { return }
        starting = true; defer { starting = false }
        refreshAuthorization()          // the user may have just enabled the camera in Settings and come back
        if authorization == .notDetermined {
            _ = await CameraCapabilityManager.requestAccess()
            authorization = CameraCapabilityManager.authorization
        }
        guard authorization == .authorized else { return }
        if !configured {
            let discovery = await Task.detached(priority: .userInitiated) { CameraCapabilityManager.discover() }.value
            capabilities = discovery.capabilities
            guard let first = discovery.capabilities.defaultLens else { errorMessage = CameraEngineError.noDevice.localizedDescription; return }
            do {
                try await engine.configure(capabilities: discovery.capabilities, devices: discovery.devices, initialLensID: first.id)
                activeLensID = first.id
                configured = true
                syncAfterLensChange()
            } catch { errorMessage = error.localizedDescription; return }
        }
        engine.start()
        engine.requestSnapshot()
    }

    func stop() { engine.stop() }

    func refreshAuthorization() { authorization = CameraCapabilityManager.authorization }

    // MARK: Lens

    func selectLens(_ id: String) async {
        guard !userControlsLocked, id != activeLensID, capabilities.lens(id: id) != nil else { return }
        do {
            try await engine.setLens(id)
            activeLensID = id
            // A different module has different ranges: fall back to automatic rather than carry stale manual values.
            isoManual = false; shutterManual = false; wbManual = false; wbLocked = false; focusManual = false; focusLocked = false
            syncAfterLensChange()
            engine.requestSnapshot()
        } catch { errorMessage = error.localizedDescription }
    }

    private func syncAfterLensChange() {
        if !availableFormats.contains(captureFormat) { captureFormat = .standard }
        if let lens = activeLens {
            iso = min(max(iso, lens.isoMin), lens.isoMax)
            shutter = min(max(shutter, lens.shutterMinSeconds), lens.shutterMaxSeconds)
        }
    }

    // MARK: Exposure

    private func driveFromUI() -> ExposureDrive {
        switch (isoManual, shutterManual) {
        case (true, true): return .manual(iso: iso, shutter: shutter)
        case (false, true): return .shutterPriority(shutter: shutter)
        case (true, false): return .isoPriority(iso: iso)
        case (false, false): return .auto
        }
    }

    private func applyExposure() {
        let drive = driveFromUI()
        Task { do { try await engine.setExposure(drive) } catch { errorMessage = error.localizedDescription } }
    }

    func setISO(_ v: Float) { guard !userControlsLocked else { return }
        if !isoManual { isoManual = true; if !shutterManual { shutter = nearestShutter(live.exposureSeconds) } }
        iso = v; applyExposure()
    }

    func setShutter(_ v: Double) { guard !userControlsLocked else { return }
        if !shutterManual { shutterManual = true; if !isoManual { iso = nearestISO(live.iso) } }
        shutter = v; applyExposure()
    }

    func setISOAuto() { guard !userControlsLocked else { return }; isoManual = false; applyExposure() }
    func setShutterAuto() { guard !userControlsLocked else { return }; shutterManual = false; applyExposure() }

    func setExposureBias(_ ev: Float) { guard !userControlsLocked else { return }
        exposureBias = ev
        Task { do { try await engine.setExposureBias(ev) } catch { errorMessage = error.localizedDescription } }
    }

    private func nearestISO(_ v: Float) -> Float { ExposureScales.nearest(v, in: isoOptions) ?? v }
    private func nearestShutter(_ v: Double) -> Double { ExposureScales.nearest(v, in: shutterOptions) ?? v }

    // MARK: White balance

    func setWhiteBalanceAuto() { guard !userControlsLocked else { return }; wbManual = false; wbLocked = false; Task { try? await engine.setWhiteBalanceAuto() } }

    func lockWhiteBalance() { guard !userControlsLocked else { return }
        Task {
            do { let v = try await engine.lockWhiteBalance(); kelvin = v.kelvin; tint = v.tint; wbLocked = true; wbManual = false }
            catch { errorMessage = error.localizedDescription }
        }
    }

    func setKelvin(_ k: Float, tint t: Float? = nil) { guard !userControlsLocked else { return }
        wbManual = true; wbLocked = false
        kelvin = k; if let t { tint = t }
        Task { do { try await engine.setWhiteBalance(kelvin: kelvin, tint: tint) } catch { errorMessage = error.localizedDescription } }
    }

    // MARK: Focus

    func setFocusAuto() { guard !userControlsLocked else { return }; focusManual = false; focusLocked = false; Task { try? await engine.setFocusContinuousAuto() } }

    func tapToFocus(devicePoint: CGPoint) { guard !userControlsLocked else { return }
        focusManual = false; focusLocked = false
        Task { do { try await engine.focus(atDevicePoint: devicePoint) } catch { errorMessage = error.localizedDescription } }
    }

    func lockFocusHere() { guard !userControlsLocked else { return }
        Task {
            do { try await engine.lockFocus(); lensPosition = live.lensPosition; focusLocked = true; focusManual = false }
            catch { errorMessage = error.localizedDescription }
        }
    }

    func setLensPosition(_ p: Float) {
        guard !userControlsLocked, activeLens?.supportsManualFocus == true else { return }
        let c = min(max(p, 0), 1)
        if !focusManual { focusManual = true; focusLocked = false }
        lensPosition = c
        Task { try? await engine.setLensPosition(c) }
    }

    // MARK: Settings snapshot for stacks

    func currentSettings() -> CameraSettings {
        var s = CameraSettings(lensID: activeLensID)
        s.exposureMode = exposureIsAuto ? .auto : .manual
        s.iso = displayedISO.isFinite && displayedISO > 0 ? displayedISO : iso
        s.shutterSeconds = displayedShutter > 0 ? displayedShutter : shutter
        s.exposureBias = exposureBias
        s.whiteBalanceMode = wbManual ? .manualKelvin : (wbLocked ? .locked : .auto)
        s.kelvin = displayedKelvin > 0 ? displayedKelvin : kelvin
        s.tint = wbManual || wbLocked ? tint : live.tint
        s.focusMode = focusManual ? .manual : (focusLocked ? .autofocusLocked : .autofocus)
        s.lensPosition = displayedLensPosition
        s.format = captureFormat
        return s
    }

    /// After a stack the camera stays at the locked values; reflect that in the UI as manual.
    func adoptStackLocks(_ plan: LockPlan) {
        isoManual = true; shutterManual = true; iso = plan.iso; shutter = plan.shutterSeconds
        wbManual = true; wbLocked = false; kelvin = plan.whiteBalanceKelvin; tint = plan.tint
        if let lp = plan.pinnedLensPosition { focusManual = true; lensPosition = lp } else { focusLocked = true; focusManual = false }
    }

    // MARK: Single capture

    /// Captures one photo into the app's scratch folder; returns the file and what the camera actually used.
    func captureSingle() async -> (url: URL, info: CapturedFrameInfo)? {
        guard !isCapturing else { return nil }
        isCapturing = true; defer { isCapturing = false }
        let name = "single_\(UUID().uuidString.prefix(8)).\(StackCaptureCoordinator.fileExtension(for: captureFormat))"
        do {
            let override: AVCapturePhotoOutput.QualityPrioritization = captureFormat == .maximumQuality ? .quality : .balanced
            let info = try await engine.capturePhoto(format: captureFormat, into: AppPaths.singles, fileName: name, prioritizationOverride: override)
            return (AppPaths.singles.appendingPathComponent(info.fileName), info)
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }
}
