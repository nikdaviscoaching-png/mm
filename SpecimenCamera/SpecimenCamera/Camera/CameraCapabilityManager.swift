import AVFoundation
import SpecimenCore

enum CameraAuthorization { case notDetermined, authorized, denied }

/// Detects what this iPhone's rear cameras can really do. The UI is driven from the result: nothing is shown for hardware
/// that is not there, and nothing is assumed (no lens list, RAW, ProRAW, focus distance or format is hard-coded).
enum CameraCapabilityManager {

    struct Discovery {
        var capabilities: CameraCapabilities
        var devices: [String: AVCaptureDevice]
    }

    static var authorization: CameraAuthorization {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return .authorized
        case .notDetermined: return .notDetermined
        default: return .denied
        }
    }

    static func requestAccess() async -> Bool { await AVCaptureDevice.requestAccess(for: .video) }

    /// Must run after camera permission is granted. Each physical module is probed in a scratch (never running) session so
    /// photo-format capabilities reflect the real photo format, not the default video format.
    static func discover() -> Discovery {
        let types: [AVCaptureDevice.DeviceType] = [.builtInUltraWideCamera, .builtInWideAngleCamera, .builtInTelephotoCamera]
        let found = AVCaptureDevice.DiscoverySession(deviceTypes: types, mediaType: .video, position: .back).devices
        var devices: [String: AVCaptureDevice] = [:]
        var lenses: [LensInfo] = []
        for dev in found {
            guard var info = probe(dev) else { continue }
            info.id = dev.uniqueID
            devices[dev.uniqueID] = dev
            lenses.append(info)
        }
        lenses.sort { ($0.equivalentFocalLengthMM ?? 0) < ($1.equivalentFocalLengthMM ?? 0) }
        // Name lenses relative to the main camera, now that all focal lengths are known.
        let main = lenses.first { $0.kind == .wide }?.equivalentFocalLengthMM
        for i in lenses.indices {
            lenses[i].name = LensNaming.name(kind: lenses[i].kind, equivalentFocalLengthMM: lenses[i].equivalentFocalLengthMM, mainEquivalentMM: main)
        }
        let hasLiDAR = AVCaptureDevice.default(.builtInLiDARDepthCamera, for: .video, position: .back) != nil
        let caps = CameraCapabilities(lenses: lenses, hasLiDAR: hasLiDAR,
                                      supportsDepthData: hasLiDAR,
                                      hasTorch: found.contains { $0.hasTorch },
                                      deviceModel: deviceModelIdentifier())
        Log.camera.info("camera initialized: \(lenses.map { $0.name }.joined(separator: ", "), privacy: .public) LiDAR=\(hasLiDAR)")
        return Discovery(capabilities: caps, devices: devices)
    }

    private static func probe(_ dev: AVCaptureDevice) -> LensInfo? {
        let kind: LensKind
        switch dev.deviceType {
        case .builtInUltraWideCamera: kind = .ultraWide
        case .builtInWideAngleCamera: kind = .wide
        case .builtInTelephotoCamera: kind = .telephoto
        default: kind = .other
        }
        let scratch = AVCaptureSession()
        scratch.beginConfiguration()
        if scratch.canSetSessionPreset(.photo) { scratch.sessionPreset = .photo }
        guard let input = try? AVCaptureDeviceInput(device: dev), scratch.canAddInput(input) else { scratch.commitConfiguration(); return nil }
        scratch.addInput(input)
        let out = AVCapturePhotoOutput()
        var hasOutput = false
        if scratch.canAddOutput(out) { scratch.addOutput(out); hasOutput = true }
        scratch.commitConfiguration()

        let fmt = dev.activeFormat
        let fov = Double(fmt.videoFieldOfView)
        let feq: Double? = fov > 5 ? 18.0 / tan(fov * .pi / 360) : nil
        let dims = fmt.supportedMaxPhotoDimensions
        let largest = dims.max { Int($0.width) * Int($0.height) < Int($1.width) * Int($1.height) }
        var supportsRAW = false, supportsProRAW = false
        if hasOutput {
            if out.isAppleProRAWSupported { out.isAppleProRAWEnabled = true }
            let raws = out.availableRawPhotoPixelFormatTypes
            supportsRAW = raws.contains { AVCapturePhotoOutput.isBayerRAWPixelFormat($0) }
            supportsProRAW = out.isAppleProRAWSupported && raws.contains { AVCapturePhotoOutput.isAppleProRAWPixelFormat($0) }
        }
        let minFocus = dev.minimumFocusDistance            // mm, -1 if unknown
        let seconds: (CMTime) -> Double = { CMTimeGetSeconds($0) }
        var info = LensInfo(id: dev.uniqueID, kind: kind, name: dev.localizedName, equivalentFocalLengthMM: feq,
                            fNumber: Double(dev.lensAperture), minimumFocusDistanceMM: minFocus > 0 ? Double(minFocus) : nil,
                            supportsManualFocus: dev.isLockingFocusWithCustomLensPositionSupported,
                            isoMin: fmt.minISO, isoMax: fmt.maxISO,
                            shutterMinSeconds: seconds(fmt.minExposureDuration), shutterMaxSeconds: seconds(fmt.maxExposureDuration),
                            exposureBiasMin: dev.minExposureTargetBias, exposureBiasMax: dev.maxExposureTargetBias,
                            maxPhotoWidth: Int(largest?.width ?? 4032), maxPhotoHeight: Int(largest?.height ?? 3024),
                            supportsRAW: supportsRAW, supportsProRAW: supportsProRAW,
                            supportsMaximumQualityPhoto: (largest.map { Int($0.width) * Int($0.height) } ?? 0) > 0,
                            supportsStabilization: fmt.isVideoStabilizationModeSupported(.cinematic) || fmt.isVideoStabilizationModeSupported(.standard),
                            supportsLensLockAgainstSwitching: true)   // physical modules are used directly: the OS never switches them
        info.name = LensNaming.name(kind: kind, equivalentFocalLengthMM: feq)
        return info
    }

    private static func deviceModelIdentifier() -> String {
        var size = 0
        sysctlbyname("hw.machine", nil, &size, nil, 0)
        var machine = [CChar](repeating: 0, count: max(size, 1))
        sysctlbyname("hw.machine", &machine, &size, nil, 0)
        return String(cString: machine)
    }
}
