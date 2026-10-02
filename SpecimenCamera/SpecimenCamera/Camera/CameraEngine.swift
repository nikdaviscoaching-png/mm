import AVFoundation
import CoreMedia
import ImageIO
import SpecimenCore

enum CameraEngineError: LocalizedError {
    case notAuthorized, noDevice, configuration(String), capture(String)
    var errorDescription: String? {
        switch self {
        case .notAuthorized: return "Camera access is not allowed. Enable it in Settings › SPECIMEN CAMERA › Camera."
        case .noDevice: return "No rear camera is available."
        case .configuration(let s): return "Camera setup failed: \(s)"
        case .capture(let s): return "Capture failed: \(s)"
        }
    }
}

/// What the camera is doing right now, read straight from AVCaptureDevice (so the UI shows real values).
struct LiveSnapshot: Equatable, Sendable {
    var iso: Float = 0
    var exposureSeconds: Double = 0
    var exposureTargetOffset: Float = 0
    var lensPosition: Float = 0
    var isAdjustingFocus = false
    var isAdjustingExposure = false
    var kelvin: Float = 0
    var tint: Float = 0
    var focusModeDescription = "AF"
    var exposureModeDescription = "AE"
    var whiteBalanceModeDescription = "AWB"
    var activeFormatWidth = 0
    var activeFormatHeight = 0
    /// The photo sizes this lens really delivers in the running session (not assumed): standard HEIF/RAW, and maximum.
    var standardPhotoWidth = 0
    var standardPhotoHeight = 0
    var maxPhotoWidth = 0
    var maxPhotoHeight = 0
}

/// How exposure is being driven. AVFoundation only offers fully-automatic or fully-manual (ISO + shutter together), so
/// the two "priority" modes are implemented as a real control loop on the camera's own exposure-target offset.
enum ExposureDrive: Equatable, Sendable {
    case auto
    case manual(iso: Float, shutter: Double)
    case shutterPriority(shutter: Double)    // ISO follows the meter
    case isoPriority(iso: Float)             // shutter follows the meter
}

/// Owns the AVCaptureSession. All device configuration happens on `sessionQueue`.
/// Thread-safety: mutable state is touched only on `sessionQueue` (or, for the few `nonisolated` readers, immutable).
final class CameraEngine: NSObject, @unchecked Sendable {

    let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "app.specimencamera.session")
    private let videoQueue = DispatchQueue(label: "app.specimencamera.video", qos: .userInitiated)
    private let photoOutput = AVCapturePhotoOutput()
    private let videoOutput = AVCaptureVideoDataOutput()

    private var devices: [String: AVCaptureDevice] = [:]
    private var capabilities = CameraCapabilities(lenses: [])
    private var device: AVCaptureDevice?
    private var input: AVCaptureDeviceInput?
    private var rotationCoordinator: AVCaptureDevice.RotationCoordinator?
    private var rotationObservation: NSKeyValueObservation?
    private weak var previewLayer: AVCaptureVideoPreviewLayer?
    private var observations: [NSKeyValueObservation] = []
    private var inFlight: [Int64: PhotoCaptureDelegate] = [:]
    private var largestDims: CMVideoDimensions?
    private var standardDims: CMVideoDimensions?
    private var stackPrioritization: AVCapturePhotoOutput.QualityPrioritization = .quality
    private var analysisHighRes = false
    private var configured = false
    private var runningObservation: NSKeyValueObservation?

    // Live (drag) focus: values are coalesced so a fast drag never queues a backlog of lens moves.
    private let lensLock = NSLock()
    private var pendingLens: Float?
    private var lensDrainScheduled = false

    // Bright preview for manual exposure: the preview runs on a faster-shutter / higher-ISO equivalent; the real values are
    // restored for the instant of capture. `boostSuspended` is true while a stack holds the camera at its locked values.
    private var previewAssist: PreviewAssist = .off
    private var boostSuspended = false
    private var realManual: (iso: Float, shutter: Double)?
    private var previewExposureActive = false

    // Orientation is frozen for the duration of a stack: a phone lying nearly flat on a stand can flip between rotation
    // angles from one frame to the next, which would give frames of different pixel dimensions.
    private var frozenCaptureAngle: CGFloat?
    private var frozenPreviewAngle: CGFloat?

    // exposure-priority loop (sessionQueue only)
    private var drive: ExposureDrive = .auto
    private var priorityTimer: DispatchSourceTimer?
    private var priorityPrevAbsOffset: Float = 0
    private var priorityWorsened = 0
    private var prioritySign: Float = 1
    private var lastLivePost = CFAbsoluteTimeGetCurrent()

    // callbacks (set once before use)
    var onLive: (@Sendable (LiveSnapshot) -> Void)?
    var onInterruption: (@Sendable (String?) -> Void)?
    var onRunningChanged: (@Sendable (Bool) -> Void)?
    var onVideoFrame: (@Sendable (CVPixelBuffer) -> Void)?
    var onError: (@Sendable (String) -> Void)?

    override init() {
        super.init()
        NotificationCenter.default.addObserver(self, selector: #selector(sessionWasInterrupted(_:)), name: AVCaptureSession.wasInterruptedNotification, object: session)
        NotificationCenter.default.addObserver(self, selector: #selector(sessionInterruptionEnded(_:)), name: AVCaptureSession.interruptionEndedNotification, object: session)
        NotificationCenter.default.addObserver(self, selector: #selector(sessionRuntimeError(_:)), name: AVCaptureSession.runtimeErrorNotification, object: session)
        runningObservation = session.observe(\.isRunning, options: [.new]) { [weak self] s, _ in self?.onRunningChanged?(s.isRunning) }
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    // MARK: - Configuration

    func configure(capabilities: CameraCapabilities, devices: [String: AVCaptureDevice], initialLensID: String) async throws {
        try await onQueue {
            self.capabilities = capabilities; self.devices = devices
            guard let dev = devices[initialLensID] ?? devices.values.first else { throw CameraEngineError.noDevice }
            self.session.beginConfiguration()
            if self.session.canSetSessionPreset(.photo) { self.session.sessionPreset = .photo }
            do { try self.attach(device: dev) } catch { self.session.commitConfiguration(); throw error }
            if self.session.canAddOutput(self.photoOutput) { self.session.addOutput(self.photoOutput) }
            self.videoOutput.alwaysDiscardsLateVideoFrames = true
            self.videoOutput.setSampleBufferDelegate(self, queue: self.videoQueue)
            if self.session.canAddOutput(self.videoOutput) { self.session.addOutput(self.videoOutput) }
            self.session.commitConfiguration()
            self.configurePhotoOutput()
            self.updateRotation()
            self.applyVideoOutputSettings()
            self.configured = true
        }
    }

    /// Switches to another *physical* module. Physical devices are used directly (never the virtual multi-camera), so iOS
    /// cannot switch lenses or enter macro mode behind our back.
    func setLens(_ id: String) async throws {
        try await onQueue {
            guard let dev = self.devices[id] else { throw CameraEngineError.noDevice }
            guard dev.uniqueID != self.device?.uniqueID else { return }
            self.stopPriorityLoop()
            self.session.beginConfiguration()
            let previousInput = self.input
            if let old = previousInput { self.session.removeInput(old) }
            do { try self.attach(device: dev) } catch {
                if let old = previousInput, self.session.canAddInput(old) { self.session.addInput(old) }   // keep the old lens working
                self.session.commitConfiguration(); throw error
            }
            self.session.commitConfiguration()
            self.configurePhotoOutput()
            self.updateRotation()
            self.applyVideoOutputSettings()
            self.drive = .auto
            self.realManual = nil; self.previewExposureActive = false
        }
    }

    private func attach(device dev: AVCaptureDevice) throws {
        let input = try AVCaptureDeviceInput(device: dev)
        guard session.canAddInput(input) else { throw CameraEngineError.configuration("cannot add input for \(dev.localizedName)") }
        session.addInput(input)
        self.input = input
        self.device = dev
        observeDevice(dev)
        Log.camera.info("physical camera selected: \(dev.localizedName, privacy: .public)")
    }

    private func configurePhotoOutput() {
        guard let dev = device else { return }
        let dims = dev.activeFormat.supportedMaxPhotoDimensions.sorted { Int($0.width) * Int($0.height) < Int($1.width) * Int($1.height) }
        standardDims = dims.first
        largestDims = dims.last
        if let big = largestDims, photoOutput.maxPhotoDimensions.width != big.width || photoOutput.maxPhotoDimensions.height != big.height { photoOutput.maxPhotoDimensions = big }
        photoOutput.maxPhotoQualityPrioritization = .quality
        // Follows what this module supports (a flag left on from a previous lens must not carry over).
        if photoOutput.isAppleProRAWEnabled != photoOutput.isAppleProRAWSupported { photoOutput.isAppleProRAWEnabled = photoOutput.isAppleProRAWSupported }
        // Zero Shutter Lag and responsive capture return frames from *before* the shutter press. In a focus stack that
        // would be a frame captured while the lens was still moving, so they are switched off.
        // Order matters: responsive capture / fast prioritization depend on zero shutter lag, so they go off first.
        if photoOutput.isResponsiveCaptureSupported, photoOutput.isResponsiveCaptureEnabled { photoOutput.isResponsiveCaptureEnabled = false }
        if photoOutput.isFastCapturePrioritizationSupported, photoOutput.isFastCapturePrioritizationEnabled { photoOutput.isFastCapturePrioritizationEnabled = false }
        if photoOutput.isZeroShutterLagSupported, photoOutput.isZeroShutterLagEnabled { photoOutput.isZeroShutterLagEnabled = false }
        if let c = videoOutput.connection(with: .video), c.isVideoStabilizationSupported { c.preferredVideoStabilizationMode = .off }
    }

    func attachPreviewLayer(_ layer: AVCaptureVideoPreviewLayer) {
        sessionQueue.async {
            self.previewLayer = layer
            self.updateRotation()
        }
    }

    /// Keeps preview, overlay buffers and captured photos upright relative to gravity.
    private func updateRotation() {
        guard let dev = device else { return }
        rotationObservation = nil
        let coordinator = AVCaptureDevice.RotationCoordinator(device: dev, previewLayer: previewLayer)
        rotationCoordinator = coordinator
        applyPreviewRotation(coordinator.videoRotationAngleForHorizonLevelPreview)
        rotationObservation = coordinator.observe(\.videoRotationAngleForHorizonLevelPreview, options: [.new]) { [weak self] c, _ in
            self?.sessionQueue.async { self?.applyPreviewRotation(c.videoRotationAngleForHorizonLevelPreview) }
        }
    }

    private func applyPreviewRotation(_ requested: CGFloat) {
        let angle = frozenPreviewAngle ?? requested
        for conn in [previewLayer?.connection, videoOutput.connection(with: .video)].compactMap({ $0 }) where conn.isVideoRotationAngleSupported(angle) {
            conn.videoRotationAngle = angle
        }
    }

    func start() {
        sessionQueue.async {
            guard self.configured, !self.session.isRunning else { return }
            self.session.startRunning()
            self.onRunningChanged?(self.session.isRunning)
        }
    }

    func stop() {
        sessionQueue.async {
            self.stopPriorityLoop()
            if self.session.isRunning { self.session.stopRunning() }
            self.onRunningChanged?(false)
        }
    }

    // MARK: - Interruptions

    @objc private func sessionWasInterrupted(_ n: Notification) {
        var text = "Camera interrupted"
        if let raw = n.userInfo?[AVCaptureSessionInterruptionReasonKey] as? Int, let reason = AVCaptureSession.InterruptionReason(rawValue: raw) {
            switch reason {
            case .videoDeviceNotAvailableInBackground: text = "App moved to the background"
            case .audioDeviceInUseByAnotherClient, .videoDeviceInUseByAnotherClient: text = "Camera is in use by another app or call"
            case .videoDeviceNotAvailableWithMultipleForegroundApps: text = "Camera unavailable while multitasking"
            case .videoDeviceNotAvailableDueToSystemPressure: text = "Camera paused: the phone is too hot"
            default: text = "Camera interrupted"
            }
        }
        Log.camera.notice("session interrupted: \(text, privacy: .public)")
        onInterruption?(text)
    }

    @objc private func sessionInterruptionEnded(_ n: Notification) {
        Log.camera.notice("session interruption ended")
        onInterruption?(nil)
    }

    @objc private func sessionRuntimeError(_ n: Notification) {
        let err = (n.userInfo?[AVCaptureSessionErrorKey] as? AVError)
        Log.camera.error("runtime error: \(err?.localizedDescription ?? "unknown", privacy: .public)")
        onError?(err?.localizedDescription ?? "Camera error")
        if err?.code == .mediaServicesWereReset {
            sessionQueue.async { if !self.session.isRunning { self.session.startRunning() } }
        }
    }

    // MARK: - Live state (KVO)

    private func observeDevice(_ dev: AVCaptureDevice) {
        observations.removeAll()
        // No `.new` values requested: some of these are struct-valued (white-balance gains); we re-read the device instead.
        func watch<V>(_ kp: KeyPath<AVCaptureDevice, V>) {
            observations.append(dev.observe(kp, options: []) { [weak self] _, _ in
                guard let self else { return }
                self.sessionQueue.async { self.postLive() }
            })
        }
        watch(\.lensPosition); watch(\.iso); watch(\.exposureDuration); watch(\.isAdjustingFocus)
        watch(\.isAdjustingExposure); watch(\.deviceWhiteBalanceGains); watch(\.exposureTargetOffset)
    }

    private func postLive(force: Bool = false) {
        let now = CFAbsoluteTimeGetCurrent()
        guard force || now - lastLivePost > 0.08 else { return }
        lastLivePost = now
        guard let snap = snapshotNow() else { return }
        onLive?(snap)
    }

    private func snapshotNow() -> LiveSnapshot? {
        guard let d = device else { return nil }
        var s = LiveSnapshot()
        s.iso = d.iso
        s.exposureSeconds = CMTimeGetSeconds(d.exposureDuration)
        s.exposureTargetOffset = d.exposureTargetOffset
        s.lensPosition = d.lensPosition
        s.isAdjustingFocus = d.isAdjustingFocus
        s.isAdjustingExposure = d.isAdjustingExposure
        let g = clampedGains(d, d.deviceWhiteBalanceGains)
        let tt = d.temperatureAndTintValues(for: g)
        s.kelvin = tt.temperature; s.tint = tt.tint
        switch d.focusMode { case .continuousAutoFocus: s.focusModeDescription = "AF-C"; case .autoFocus: s.focusModeDescription = "AF"; case .locked: s.focusModeDescription = "MF/LOCK"; @unknown default: break }
        switch d.exposureMode { case .continuousAutoExposure, .autoExpose: s.exposureModeDescription = "AE"; case .locked: s.exposureModeDescription = "AE-L"; case .custom: s.exposureModeDescription = "M"; @unknown default: break }
        switch d.whiteBalanceMode { case .continuousAutoWhiteBalance, .autoWhiteBalance: s.whiteBalanceModeDescription = "AWB"; case .locked: s.whiteBalanceModeDescription = "WB-L"; @unknown default: break }
        let dims = CMVideoFormatDescriptionGetDimensions(d.activeFormat.formatDescription)
        s.activeFormatWidth = Int(dims.width); s.activeFormatHeight = Int(dims.height)
        s.standardPhotoWidth = Int(standardDims?.width ?? 0); s.standardPhotoHeight = Int(standardDims?.height ?? 0)
        s.maxPhotoWidth = Int(largestDims?.width ?? 0); s.maxPhotoHeight = Int(largestDims?.height ?? 0)
        return s
    }

    func requestSnapshot() { sessionQueue.async { self.postLive(force: true) } }

    // MARK: - Exposure

    func setExposure(_ newDrive: ExposureDrive) async throws {
        try await onQueue {
            guard let d = self.device else { throw CameraEngineError.noDevice }
            self.stopPriorityLoop()
            self.drive = newDrive
            self.realManual = nil; self.previewExposureActive = false
            try d.lockForConfiguration(); defer { d.unlockForConfiguration() }
            switch newDrive {
            case .auto:
                if d.isExposureModeSupported(.continuousAutoExposure) { d.exposureMode = .continuousAutoExposure }
            case .manual(let iso, let shutter):
                self.realManual = (iso, shutter)
                self.applyManualRespectingPreview(d)
            case .shutterPriority(let shutter):
                self.applyCustom(d, iso: d.iso, shutter: shutter)
                self.startPriorityLoop()
            case .isoPriority(let iso):
                self.applyCustom(d, iso: iso, shutter: CMTimeGetSeconds(d.exposureDuration))
                self.startPriorityLoop()
            }
        }
    }

    // MARK: Preview exposure assist (viewfinder only)

    func setPreviewAssist(_ mode: PreviewAssist) {
        sessionQueue.async {
            self.previewAssist = mode
            guard self.realManual != nil, let d = self.device, (try? d.lockForConfiguration()) != nil else { return }
            defer { d.unlockForConfiguration() }
            self.applyManualRespectingPreview(d)
        }
    }

    /// sessionQueue, device locked. Applies the photo's manual exposure, or its brighter/faster preview equivalent.
    private func applyManualRespectingPreview(_ d: AVCaptureDevice) {
        guard let m = realManual else { return }
        let f = d.activeFormat
        if !boostSuspended, let p = PreviewAssistPlanner.plan(iso: m.iso, shutter: m.shutter, assist: previewAssist, minISO: f.minISO, maxISO: f.maxISO,
                                                              minShutter: CMTimeGetSeconds(f.minExposureDuration), maxShutter: CMTimeGetSeconds(f.maxExposureDuration)) {
            applyCustom(d, iso: p.iso, shutter: p.shutterSeconds)
            previewExposureActive = true
        } else {
            applyCustom(d, iso: m.iso, shutter: m.shutter)
            previewExposureActive = false
        }
    }

    /// Before a photo: if the preview is running on boosted values, switch to the real ones and wait until the sensor has them.
    private func switchToRealExposureForCapture() async {
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            sessionQueue.async {
                guard self.previewExposureActive, let m = self.realManual, let d = self.device, (try? d.lockForConfiguration()) != nil else { cont.resume(); return }
                self.previewExposureActive = false
                let once = OneShot()
                let f = d.activeFormat
                let sec = min(max(m.shutter, CMTimeGetSeconds(f.minExposureDuration)), CMTimeGetSeconds(f.maxExposureDuration))
                d.setExposureModeCustom(duration: CMTime(seconds: sec, preferredTimescale: 1_000_000_000), iso: min(max(m.iso, f.minISO), f.maxISO)) { _ in
                    once.fire { cont.resume() }
                }
                d.unlockForConfiguration()
                self.sessionQueue.asyncAfter(deadline: .now() + 1.5) { once.fire { cont.resume() } }     // never wait longer than this
            }
        }
        try? await Task.sleep(nanoseconds: 120_000_000)       // first frames after a change can still carry the old exposure
    }

    private func resumePreviewExposure() {
        sessionQueue.async {
            guard self.realManual != nil, !self.boostSuspended, self.previewAssist != .off, let d = self.device, (try? d.lockForConfiguration()) != nil else { return }
            defer { d.unlockForConfiguration() }
            self.applyManualRespectingPreview(d)
        }
    }

    private func applyCustom(_ d: AVCaptureDevice, iso: Float, shutter: Double) {
        let f = d.activeFormat
        let isoC = min(max(iso, f.minISO), f.maxISO)
        let lo = CMTimeGetSeconds(f.minExposureDuration), hi = CMTimeGetSeconds(f.maxExposureDuration)
        let sec = min(max(shutter, lo), hi)
        d.setExposureModeCustom(duration: CMTime(seconds: sec, preferredTimescale: 1_000_000_000), iso: isoC, completionHandler: nil)
    }

    func setExposureBias(_ ev: Float) async throws {
        try await onQueue {
            guard let d = self.device else { throw CameraEngineError.noDevice }
            try d.lockForConfiguration(); defer { d.unlockForConfiguration() }
            d.setExposureTargetBias(min(max(ev, d.minExposureTargetBias), d.maxExposureTargetBias), completionHandler: nil)
        }
    }

    /// Real control loop for the two priority modes, driven by the camera's own metering (`exposureTargetOffset`).
    /// Self-calibrating: if a correction makes the offset worse twice in a row the sign is flipped.
    private func startPriorityLoop() {
        stopPriorityLoop()
        priorityPrevAbsOffset = 0; priorityWorsened = 0; prioritySign = 1
        let t = DispatchSource.makeTimerSource(queue: sessionQueue)
        t.schedule(deadline: .now() + 0.3, repeating: 0.25)
        t.setEventHandler { [weak self] in self?.priorityTick() }
        priorityTimer = t
        t.resume()
    }

    private func stopPriorityLoop() { priorityTimer?.cancel(); priorityTimer = nil }

    private func priorityTick() {
        guard let d = device, d.exposureMode == .custom else { return }
        let offset = d.exposureTargetOffset
        let absOff = abs(offset)
        if absOff > priorityPrevAbsOffset + 0.05 { priorityWorsened += 1 } else { priorityWorsened = 0 }
        if priorityWorsened >= 2 { prioritySign = -prioritySign; priorityWorsened = 0 }
        priorityPrevAbsOffset = absOff
        guard absOff > 0.12 else { return }
        let correction = Float(pow(2.0, Double(-offset * prioritySign * 0.7)))
        do {
            try d.lockForConfiguration(); defer { d.unlockForConfiguration() }
            switch drive {
            case .shutterPriority(let shutter): applyCustom(d, iso: d.iso * correction, shutter: shutter)
            case .isoPriority(let iso): applyCustom(d, iso: iso, shutter: CMTimeGetSeconds(d.exposureDuration) * Double(correction))
            default: break
            }
        } catch { Log.camera.error("priority loop could not lock device") }
    }

    // MARK: - White balance

    func setWhiteBalanceAuto() async throws {
        try await onQueue {
            guard let d = self.device else { throw CameraEngineError.noDevice }
            try d.lockForConfiguration(); defer { d.unlockForConfiguration() }
            if d.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) { d.whiteBalanceMode = .continuousAutoWhiteBalance }
        }
    }

    /// Freezes white balance at the current auto value; returns it.
    @discardableResult
    func lockWhiteBalance() async throws -> (kelvin: Float, tint: Float) {
        try await onQueue {
            guard let d = self.device else { throw CameraEngineError.noDevice }
            try d.lockForConfiguration(); defer { d.unlockForConfiguration() }
            let g = self.clampedGains(d, d.deviceWhiteBalanceGains)
            if d.isLockingWhiteBalanceWithCustomDeviceGainsSupported { d.setWhiteBalanceModeLocked(with: g, completionHandler: nil) }
            let tt = d.temperatureAndTintValues(for: g)
            return (kelvin: tt.temperature, tint: tt.tint)
        }
    }

    func setWhiteBalance(kelvin: Float, tint: Float) async throws {
        try await onQueue {
            guard let d = self.device else { throw CameraEngineError.noDevice }
            guard d.isLockingWhiteBalanceWithCustomDeviceGainsSupported else { throw CameraEngineError.configuration("manual white balance is not supported by this camera") }
            try d.lockForConfiguration(); defer { d.unlockForConfiguration() }
            let tt = AVCaptureDevice.WhiteBalanceTemperatureAndTintValues(temperature: kelvin, tint: tint)
            let gains = self.clampedGains(d, d.deviceWhiteBalanceGains(for: tt))
            d.setWhiteBalanceModeLocked(with: gains, completionHandler: nil)
        }
    }

    private func clampedGains(_ d: AVCaptureDevice, _ g: AVCaptureDevice.WhiteBalanceGains) -> AVCaptureDevice.WhiteBalanceGains {
        let m = d.maxWhiteBalanceGain
        return AVCaptureDevice.WhiteBalanceGains(redGain: min(max(g.redGain, 1), m), greenGain: min(max(g.greenGain, 1), m), blueGain: min(max(g.blueGain, 1), m))
    }

    // MARK: - Focus

    func setFocusContinuousAuto() async throws {
        try await onQueue {
            guard let d = self.device else { throw CameraEngineError.noDevice }
            try d.lockForConfiguration(); defer { d.unlockForConfiguration() }
            if d.isFocusModeSupported(.continuousAutoFocus) { d.focusMode = .continuousAutoFocus }
        }
    }

    /// Tap-to-focus (also meters exposure at the point when exposure is automatic).
    func focus(atDevicePoint p: CGPoint) async throws {
        try await onQueue {
            guard let d = self.device else { throw CameraEngineError.noDevice }
            try d.lockForConfiguration(); defer { d.unlockForConfiguration() }
            if d.isFocusPointOfInterestSupported { d.focusPointOfInterest = p }
            if d.isFocusModeSupported(.autoFocus) { d.focusMode = .autoFocus }
            if d.isExposurePointOfInterestSupported, case .auto = self.drive { d.exposurePointOfInterest = p; if d.isExposureModeSupported(.continuousAutoExposure) { d.exposureMode = .continuousAutoExposure } }
        }
    }

    func lockFocus() async throws {
        try await onQueue {
            guard let d = self.device else { throw CameraEngineError.noDevice }
            try d.lockForConfiguration(); defer { d.unlockForConfiguration() }
            if d.isFocusModeSupported(.locked) { d.focusMode = .locked }
        }
    }

    /// Moves the lens and returns when the camera reports the position has been applied (or after a 2 s safety timeout, so a
    /// lost completion callback can never hang a whole stack).
    func setLensPosition(_ position: Float) async throws {
        let d0: AVCaptureDevice? = await onQueueValue { self.device }
        guard let dev = d0 else { throw CameraEngineError.noDevice }
        guard dev.isLockingFocusWithCustomLensPositionSupported else { throw CameraEngineError.configuration("this camera does not support manual focus") }
        let p = min(max(position, 0), 1)
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            let once = OneShot()
            sessionQueue.async {
                guard let d = self.device, (try? d.lockForConfiguration()) != nil else { once.fire { cont.resume() }; return }
                d.setFocusModeLocked(lensPosition: p) { _ in once.fire { cont.resume() } }
                d.unlockForConfiguration()
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + 2.0) { once.fire { cont.resume() } }
        }
    }

    /// Fire-and-forget lens move for dragging the focus slider: no waiting for the lens to settle, and moves arriving faster
    /// than the camera can apply them are coalesced to the latest one.
    func setLensPositionLive(_ position: Float) {
        let p = min(max(position, 0), 1)
        lensLock.lock(); pendingLens = p; let schedule = !lensDrainScheduled; lensDrainScheduled = true; lensLock.unlock()
        if schedule { sessionQueue.async { self.drainLiveLens() } }
    }

    private func drainLiveLens() {
        lensLock.lock(); let p = pendingLens; pendingLens = nil; lensDrainScheduled = false; lensLock.unlock()
        guard let p, let d = device, d.isLockingFocusWithCustomLensPositionSupported, (try? d.lockForConfiguration()) != nil else { return }
        d.setFocusModeLocked(lensPosition: p, completionHandler: nil)
        d.unlockForConfiguration()
    }

    func currentLensPosition() async -> Float { await onQueueValue { self.device?.lensPosition ?? 0 } }

    // MARK: - Stacks

    /// Pins everything a stack must not change. Focus is pinned too unless `plan.pinnedLensPosition == nil` (focus stack).
    func lockForStack(_ plan: LockPlan, prioritization: StackQuality) async throws {
        // FOCUS/COMBINED series run unattended at the real, locked exposure. A LIGHTING stack keeps the preview assist between frames
        // (you are moving lights and need to see); every capture still switches to the real exposure first.
        let suspendAssist = plan.pinnedLensPosition == nil
        await onQueueVoid { self.boostSuspended = suspendAssist }
        try await setLens(plan.lensID)
        await onQueueVoid { self.freezeRotation() }
        try await setExposure(.manual(iso: plan.iso, shutter: plan.shutterSeconds))
        try await setWhiteBalance(kelvin: plan.whiteBalanceKelvin, tint: plan.tint)
        if let lp = plan.pinnedLensPosition { try await setLensPosition(lp) } else { try await lockFocus() }
        await onQueueVoid {
            switch prioritization {
            case .fast: self.stackPrioritization = .speed
            case .high: self.stackPrioritization = .balanced
            case .maximum: self.stackPrioritization = .quality
            }
        }
        // allow the sensor to settle on the locked exposure/white balance before the first frame
        try? await Task.sleep(nanoseconds: 400_000_000)
    }

    func releaseStackLock() async {
        await onQueueVoid {
            self.stackPrioritization = .quality
            self.frozenCaptureAngle = nil; self.frozenPreviewAngle = nil
            self.updateRotation()
            self.boostSuspended = false
        }
        resumePreviewExposure()
    }

    private func freezeRotation() {
        guard let rc = rotationCoordinator else { return }
        frozenCaptureAngle = rc.videoRotationAngleForHorizonLevelCapture
        frozenPreviewAngle = rc.videoRotationAngleForHorizonLevelPreview
        applyPreviewRotation(rc.videoRotationAngleForHorizonLevelPreview)
    }

    // MARK: - Overlay buffer size

    /// Standard: preview-sized buffers (fast peaking); High: the format's full size (best for 4×/8× focus magnification).
    /// The size is chosen with `deliversPreviewSizedOutputBuffers`; width/height must NOT be set while that flag is on
    /// (AVFoundation raises an exception, which is what the `.photo` preset's default state would trigger).
    func setAnalysisHighResolution(_ high: Bool) {
        sessionQueue.async {
            guard high != self.analysisHighRes else { return }
            self.analysisHighRes = high
            self.applyVideoOutputSettings()
        }
    }

    /// sessionQueue only.
    private func applyVideoOutputSettings() {
        let wantPreviewSized = !analysisHighRes
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        if videoOutput.deliversPreviewSizedOutputBuffers != wantPreviewSized { videoOutput.deliversPreviewSizedOutputBuffers = wantPreviewSized }
        // Pixel format only: no width/height keys.
        videoOutput.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        Log.overlay.info("overlay buffers: \(wantPreviewSized ? "preview-sized" : "full size", privacy: .public)")
    }

    // MARK: - Photo capture

    func capturePhoto(format: CaptureFormat, into directory: URL, fileName: String, prioritizationOverride: AVCapturePhotoOutput.QualityPrioritization? = nil) async throws -> CapturedFrameInfo {
        await switchToRealExposureForCapture()
        do {
            let info = try await captureNow(format: format, into: directory, fileName: fileName, prioritizationOverride: prioritizationOverride)
            resumePreviewExposure()
            return info
        } catch {
            resumePreviewExposure()
            throw error
        }
    }

    private func captureNow(format: CaptureFormat, into directory: URL, fileName: String, prioritizationOverride: AVCapturePhotoOutput.QualityPrioritization?) async throws -> CapturedFrameInfo {
        let once = OneShot()
        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<CapturedFrameInfo, Error>) in
            sessionQueue.async {
                guard self.configured, self.session.isRunning else { once.fire { cont.resume(throwing: CameraEngineError.capture("the camera is not running")) }; return }
                guard let settings = self.makePhotoSettings(format, override: prioritizationOverride) else {
                    once.fire { cont.resume(throwing: CameraEngineError.capture("\(format.title) is not supported by this camera")) }; return
                }
                let destination = directory.appendingPathComponent(fileName)
                let uid = settings.uniqueID
                let delegate = PhotoCaptureDelegate(destination: destination, format: format) { [weak self] result in
                    self?.sessionQueue.async { self?.inFlight[uid] = nil }
                    once.fire { cont.resume(with: result) }
                }
                self.inFlight[uid] = delegate
                if let conn = self.photoOutput.connection(with: .video) {
                    let angle = self.frozenCaptureAngle ?? self.rotationCoordinator?.videoRotationAngleForHorizonLevelCapture
                    if let angle, conn.isVideoRotationAngleSupported(angle) { conn.videoRotationAngle = angle }
                }
                self.photoOutput.capturePhoto(with: settings, delegate: delegate)
                // A capture that never reports back must not leave the shutter dead: give up after a generous time.
                self.sessionQueue.asyncAfter(deadline: .now() + 40) {
                    once.fire {
                        self.inFlight[uid] = nil
                        Log.camera.error("capture timed out (\(format.title, privacy: .public))")
                        cont.resume(throwing: CameraEngineError.capture("the camera did not deliver the photo (timed out)"))
                    }
                }
            }
        }
    }

    /// Builds validated photo settings. Returns nil rather than ever constructing a combination AVFoundation would reject
    /// (invalid settings raise an Objective-C exception that Swift cannot catch).
    private func makePhotoSettings(_ format: CaptureFormat, override: AVCapturePhotoOutput.QualityPrioritization?) -> AVCapturePhotoSettings? {
        let prio = override ?? stackPrioritization
        switch format {
        case .standard, .maximumQuality:
            let codecs = photoOutput.availablePhotoCodecTypes
            let codec: AVVideoCodecType = codecs.contains(.hevc) ? .hevc : .jpeg
            let s = AVCapturePhotoSettings(format: [AVVideoCodecKey: codec])
            if format == .maximumQuality, let big = largestDims, big.width <= photoOutput.maxPhotoDimensions.width { s.maxPhotoDimensions = big }
            else if let std = standardDims { s.maxPhotoDimensions = std }
            s.photoQualityPrioritization = format == .maximumQuality ? .quality : minPrioritization(prio, .balanced)
            if photoOutput.supportedFlashModes.contains(.off) { s.flashMode = .off }
            return s
        case .raw:
            let raws = photoOutput.availableRawPhotoPixelFormatTypes
            guard let bayer = raws.first(where: { AVCapturePhotoOutput.isBayerRAWPixelFormat($0) }) else { return nil }
            let s = AVCapturePhotoSettings(rawPixelFormatType: bayer)
            if let std = standardDims { s.maxPhotoDimensions = std }
            if photoOutput.supportedFlashModes.contains(.off) { s.flashMode = .off }
            return s
        case .proRAW:
            guard photoOutput.isAppleProRAWEnabled else { return nil }
            let raws = photoOutput.availableRawPhotoPixelFormatTypes
            guard let pro = raws.first(where: { AVCapturePhotoOutput.isAppleProRAWPixelFormat($0) }) else { return nil }
            let s = AVCapturePhotoSettings(rawPixelFormatType: pro)
            if let big = largestDims, big.width <= photoOutput.maxPhotoDimensions.width { s.maxPhotoDimensions = big }
            if photoOutput.supportedFlashModes.contains(.off) { s.flashMode = .off }
            return s
        }
    }

    private func minPrioritization(_ a: AVCapturePhotoOutput.QualityPrioritization, _ b: AVCapturePhotoOutput.QualityPrioritization) -> AVCapturePhotoOutput.QualityPrioritization {
        a.rawValue <= b.rawValue ? a : b
    }

    // MARK: - Queue helpers

    private func onQueue<T>(_ body: @escaping () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { cont in
            sessionQueue.async { cont.resume(with: Result { try body() }) }
        }
    }

    private func onQueueValue<T>(_ body: @escaping () -> T) async -> T {
        await withCheckedContinuation { cont in sessionQueue.async { cont.resume(returning: body()) } }
    }

    private func onQueueVoid(_ body: @escaping () -> Void) async {
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in sessionQueue.async { body(); cont.resume() } }
    }
}

// MARK: - Video frames for overlays

extension CameraEngine: AVCaptureVideoDataOutputSampleBufferDelegate {
    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let pb = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        onVideoFrame?(pb)
    }
}

// MARK: - Photo delegate

final class PhotoCaptureDelegate: NSObject, AVCapturePhotoCaptureDelegate, @unchecked Sendable {
    private let destination: URL
    private let format: CaptureFormat
    private let completion: (Result<CapturedFrameInfo, Error>) -> Void
    private var info: CapturedFrameInfo?
    private var failure: Error?

    init(destination: URL, format: CaptureFormat, completion: @escaping (Result<CapturedFrameInfo, Error>) -> Void) {
        self.destination = destination; self.format = format; self.completion = completion
    }

    func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        if let error { failure = error; return }
        let wantsRAW = (format == .raw || format == .proRAW)
        guard photo.isRawPhoto == wantsRAW else { return }      // ignore the companion image of the other kind
        guard let data = photo.fileDataRepresentation() else { failure = CameraEngineError.capture("no image data"); return }
        do {
            try data.write(to: destination, options: .atomic)
            var iso: Float?, shutter: Double?
            if let exif = photo.metadata[kCGImagePropertyExifDictionary as String] as? [String: Any] {
                if let arr = exif[kCGImagePropertyExifISOSpeedRatings as String] as? [NSNumber], let first = arr.first { iso = first.floatValue }
                if let t = exif[kCGImagePropertyExifExposureTime as String] as? NSNumber { shutter = t.doubleValue }
            }
            let kind: FrameFileKind = wantsRAW ? .dng : .heif
            info = CapturedFrameInfo(fileName: destination.lastPathComponent, kind: kind, byteSize: Int64(data.count), iso: iso, shutterSeconds: shutter)
        } catch { failure = error }
    }

    func photoOutput(_ output: AVCapturePhotoOutput, didFinishCaptureFor resolvedSettings: AVCaptureResolvedPhotoSettings, error: Error?) {
        if let error { completion(.failure(error)); return }
        if let failure { completion(.failure(failure)); return }
        if let info { completion(.success(info)) } else { completion(.failure(CameraEngineError.capture("no photo was delivered"))) }
    }
}

/// Runs its body at most once (a continuation must be resumed exactly once).
final class OneShot: @unchecked Sendable {
    private let lock = NSLock()
    private var fired = false
    func fire(_ body: () -> Void) {
        lock.lock(); let go = !fired; fired = true; lock.unlock()
        if go { body() }
    }
}
