import Foundation

// MARK: - Capabilities (filled in at launch from AVFoundation; the UI is driven entirely by this)

public enum LensKind: String, Codable, Sendable { case ultraWide, wide, telephoto, other }

public struct LensInfo: Codable, Sendable, Identifiable, Equatable {
    public var id: String                       // AVCaptureDevice.uniqueID
    public var kind: LensKind
    public var name: String                     // "Ultra Wide 13 mm", "Main 24 mm", "Telephoto 3× 77 mm"
    public var equivalentFocalLengthMM: Double?
    public var fNumber: Double?                 // fixed aperture (no f-stop control exists)
    public var minimumFocusDistanceMM: Double?
    public var supportsManualFocus: Bool
    public var isoMin: Float, isoMax: Float
    public var shutterMinSeconds: Double, shutterMaxSeconds: Double
    public var exposureBiasMin: Float, exposureBiasMax: Float
    public var maxPhotoWidth: Int, maxPhotoHeight: Int
    public var supportsRAW: Bool
    public var supportsProRAW: Bool
    public var supportsMaximumQualityPhoto: Bool
    public var supportsStabilization: Bool
    public var supportsLensLockAgainstSwitching: Bool

    public init(id: String, kind: LensKind, name: String, equivalentFocalLengthMM: Double? = nil, fNumber: Double? = nil,
                minimumFocusDistanceMM: Double? = nil, supportsManualFocus: Bool = true,
                isoMin: Float = 25, isoMax: Float = 6400, shutterMinSeconds: Double = 1.0 / 8000, shutterMaxSeconds: Double = 1.0,
                exposureBiasMin: Float = -8, exposureBiasMax: Float = 8, maxPhotoWidth: Int = 4032, maxPhotoHeight: Int = 3024,
                supportsRAW: Bool = false, supportsProRAW: Bool = false, supportsMaximumQualityPhoto: Bool = true,
                supportsStabilization: Bool = true, supportsLensLockAgainstSwitching: Bool = true) {
        self.id = id; self.kind = kind; self.name = name; self.equivalentFocalLengthMM = equivalentFocalLengthMM; self.fNumber = fNumber
        self.minimumFocusDistanceMM = minimumFocusDistanceMM; self.supportsManualFocus = supportsManualFocus
        self.isoMin = isoMin; self.isoMax = isoMax; self.shutterMinSeconds = shutterMinSeconds; self.shutterMaxSeconds = shutterMaxSeconds
        self.exposureBiasMin = exposureBiasMin; self.exposureBiasMax = exposureBiasMax
        self.maxPhotoWidth = maxPhotoWidth; self.maxPhotoHeight = maxPhotoHeight
        self.supportsRAW = supportsRAW; self.supportsProRAW = supportsProRAW; self.supportsMaximumQualityPhoto = supportsMaximumQualityPhoto
        self.supportsStabilization = supportsStabilization; self.supportsLensLockAgainstSwitching = supportsLensLockAgainstSwitching
    }

    /// Capture formats this lens can really deliver. Nothing is offered that the hardware cannot do.
    public var availableFormats: [CaptureFormat] {
        var f: [CaptureFormat] = [.standard]
        if supportsMaximumQualityPhoto { f.append(.maximumQuality) }
        if supportsRAW { f.append(.raw) }
        if supportsProRAW { f.append(.proRAW) }
        return f
    }

    public var focusModel: FocusDistanceModel { FocusDistanceModel(minimumFocusDistanceMM: minimumFocusDistanceMM) }
    public var optics: FocusStepPlanner.Optics {
        FocusStepPlanner.Optics(fNumber: fNumber, equivalentFocalLengthMM: equivalentFocalLengthMM,
                                cropFactor: FocusStepPlanner.Optics.typicalCropFactor(equivalentFocalLength: equivalentFocalLengthMM))
    }
}

public struct CameraCapabilities: Codable, Sendable, Equatable {
    public var lenses: [LensInfo]
    public var hasLiDAR: Bool
    public var supportsDepthData: Bool
    public var hasTorch: Bool
    public var deviceModel: String
    public init(lenses: [LensInfo], hasLiDAR: Bool = false, supportsDepthData: Bool = false, hasTorch: Bool = false, deviceModel: String = "") {
        self.lenses = lenses; self.hasLiDAR = hasLiDAR; self.supportsDepthData = supportsDepthData; self.hasTorch = hasTorch; self.deviceModel = deviceModel
    }

    public func lens(id: String) -> LensInfo? { lenses.first { $0.id == id } }
    public var defaultLens: LensInfo? { lenses.first { $0.kind == .wide } ?? lenses.first }
    public var anyRAW: Bool { lenses.contains { $0.supportsRAW } }
    public var anyProRAW: Bool { lenses.contains { $0.supportsProRAW } }
}

public enum LensNaming {
    /// Names a lens by what it physically is, with its 35 mm-equivalent focal length — never a generic zoom factor.
    public static func name(kind: LensKind, equivalentFocalLengthMM f: Double?, mainEquivalentMM main: Double? = 24) -> String {
        let mm = f.map { " \(Int($0.rounded())) mm" } ?? ""
        switch kind {
        case .ultraWide: return "Ultra Wide" + mm
        case .wide: return "Main" + mm
        case .telephoto:
            if let f, let m = main, m > 0 {
                let ratio = f / m
                let r = (ratio * 2).rounded() / 2
                let rs = r == r.rounded() ? String(Int(r)) : String(r)
                return "Telephoto \(rs)×" + mm
            }
            return "Telephoto" + mm
        case .other: return "Camera" + mm
        }
    }

    public static func kind(forEquivalentFocalLength f: Double) -> LensKind {
        if f < 18 { return .ultraWide }
        if f < 40 { return .wide }
        return .telephoto
    }
}

// MARK: - Real exposure values

public enum ExposureScales {
    static let isoStops: [Float] = [25, 32, 40, 50, 64, 80, 100, 125, 160, 200, 250, 320, 400, 500, 640, 800, 1000, 1250, 1600, 2000, 2500, 3200, 4000, 5000, 6400, 8000, 10000, 12800]

    /// ISO values the hardware actually accepts, as familiar numbers (plus the exact minimum if it is not a stop).
    public static func isoValues(min lo: Float, max hi: Float) -> [Float] {
        var v = isoStops.filter { $0 >= lo - 0.5 && $0 <= hi + 0.5 }
        if v.isEmpty { v = [lo] }
        if let f = v.first, f - lo > 1.5 { v.insert(lo.rounded(), at: 0) }
        return v
    }

    static let shutterStops: [Double] = {
        // third-stop series of denominators from 1/8000 up to 1 s, then whole seconds
        let denoms: [Double] = [8000, 6400, 5000, 4000, 3200, 2500, 2000, 1600, 1250, 1000, 800, 640, 500, 400, 320, 250, 200, 160, 125, 100, 80, 60, 50, 40, 30, 25, 20, 15, 13, 10, 8, 6, 5, 4, 3, 2.5, 2]
        return denoms.map { 1 / $0 } + [0.6, 0.8, 1, 1.3, 1.6, 2, 2.5, 3, 4, 5, 6, 8, 10, 15, 20, 30]
    }()

    public static func shutterValues(min lo: Double, max hi: Double) -> [Double] {
        shutterStops.filter { $0 >= lo * 0.98 && $0 <= hi * 1.02 }
    }

    /// 1/3-stop exposure-compensation steps within the device's range.
    public static func biasValues(min lo: Float, max hi: Float, limit: Float = 3) -> [Float] {
        let top = Swift.min(hi, limit), bottom = Swift.max(lo, -limit)
        var out: [Float] = []
        var v = (bottom * 3).rounded(.up) / 3
        while v <= top + 1e-4 { out.append((v * 3).rounded() / 3); v += 1.0 / 3 }
        return out
    }

    public static func nearest<T: BinaryFloatingPoint>(_ value: T, in list: [T]) -> T? {
        list.min { abs($0 - value) < abs($1 - value) }
    }

    /// "1/125", "0.5 s", "2 s".
    public static func shutterLabel(_ seconds: Double) -> String {
        if seconds >= 0.95 { return seconds == seconds.rounded() ? "\(Int(seconds)) s" : String(format: "%.1f s", seconds) }
        if seconds > 0.4 { return String(format: "%.1f s", seconds) }
        let d = 1 / seconds
        let nearest = [8000.0, 6400, 5000, 4000, 3200, 2500, 2000, 1600, 1250, 1000, 800, 640, 500, 400, 320, 250, 200, 160, 125, 100, 80, 60, 50, 40, 30, 25, 20, 15, 13, 10, 8, 6, 5, 4, 3, 2.5, 2]
            .min { abs($0 - d) < abs($1 - d) } ?? d
        let shown = abs(nearest - d) / d < 0.04 ? nearest : d
        return "1/\(shown == shown.rounded() ? String(Int(shown)) : String(format: "%.1f", shown))"
    }

    public static func isoLabel(_ iso: Float) -> String { "ISO \(Int(iso.rounded()))" }
    public static func biasLabel(_ ev: Float) -> String { ev == 0 ? "±0" : String(format: "%+.1f", ev) }
}

// MARK: - Manual focus control

/// Maps a control value to a lens position and back, plus a fine-adjust path. The curve gives the near end — where macro
/// focusing happens and a hair of lens travel is millimetres of depth — more of the travel.
public enum ManualFocusMapping {
    public static let gamma = 1.8

    public static func lensPosition(control x: Double) -> Float { Float(pow(min(max(x, 0), 1), gamma)) }
    public static func control(lensPosition lp: Float) -> Double { pow(Double(min(max(lp, 0), 1)), 1 / gamma) }

    /// Moves a lens position by a drag. `dragFraction` is the drag distance divided by the control's length (+ = toward
    /// infinity). Coarse drags traverse the full range; fine mode is 25× slower for tiny macro steps.
    public static func apply(drag dragFraction: Double, to lp: Float, fine: Bool) -> Float {
        let sensitivity = fine ? 0.04 : 1.0
        let x = control(lensPosition: lp) + dragFraction * sensitivity
        return lensPosition(control: x)
    }

    /// Single nudge for ± buttons in fine mode (1/1000 of the lens range, at least).
    public static func nudge(_ lp: Float, steps: Int, stepSize: Float = 0.002) -> Float {
        min(max(lp + Float(steps) * stepSize, 0), 1)
    }

    public static func label(lensPosition lp: Float, model: FocusDistanceModel) -> String {
        let n = String(format: "%.3f", lp)
        guard model.isCalibrated, let d = model.distanceMM(lensPosition: Double(lp)) else { return n }
        if d >= 1000 { return "\(n)  ≈\(String(format: "%.1f", d / 1000)) m" }
        return "\(n)  ≈\(Int(d.rounded())) mm"
    }
}

// MARK: - Stack locking

public enum ExposureMode: String, Codable, Sendable { case auto, manual }
public enum FocusMode: String, Codable, Sendable { case autofocus, autofocusLocked, manual }
public enum WhiteBalanceMode: String, Codable, Sendable { case auto, locked, manualKelvin }

public struct CameraSettings: Codable, Sendable, Equatable {
    public var lensID: String
    public var exposureMode: ExposureMode = .auto
    public var iso: Float = 100
    public var shutterSeconds: Double = 1.0 / 60
    public var exposureBias: Float = 0
    public var whiteBalanceMode: WhiteBalanceMode = .auto
    public var kelvin: Float = 5000
    public var tint: Float = 0
    public var focusMode: FocusMode = .autofocus
    public var lensPosition: Float = 0.5
    public var format: CaptureFormat = .standard
    public init(lensID: String) { self.lensID = lensID }
}

/// What must be pinned before a stack starts, so that only the intended variable changes.
public struct LockPlan: Codable, Sendable, Equatable {
    public var lensID: String
    public var iso: Float
    public var shutterSeconds: Double
    public var whiteBalanceKelvin: Float
    public var tint: Float
    /// Lighting stacks pin focus; focus stacks leave it free (the coordinator drives it); both disable continuous AF.
    public var pinnedLensPosition: Float?
    public var format: CaptureFormat
    public var disableAutoLensSwitching = true
    public var disableContinuousAutofocus = true
    /// Human-readable list of what auto settings were frozen (shown to the user: "Locked: ISO 64, 1/60, 5200 K").
    public var frozenAutoSettings: [String]
}

public enum StackLockPolicy {
    public static func plan(current s: CameraSettings, type: StackType, lens: LensInfo) -> LockPlan {
        var frozen: [String] = []
        if s.exposureMode == .auto { frozen.append("exposure (ISO \(Int(s.iso)), \(ExposureScales.shutterLabel(s.shutterSeconds)))") }
        if s.whiteBalanceMode == .auto { frozen.append("white balance (\(Int(s.kelvin)) K)") }
        if s.focusMode == .autofocus && type == .lighting { frozen.append("focus") }
        let iso = min(max(s.iso, lens.isoMin), lens.isoMax)
        let shutter = min(max(s.shutterSeconds, lens.shutterMinSeconds), lens.shutterMaxSeconds)
        return LockPlan(lensID: s.lensID, iso: iso, shutterSeconds: shutter, whiteBalanceKelvin: s.kelvin, tint: s.tint,
                        pinnedLensPosition: type == .lighting ? s.lensPosition : nil, format: s.format, frozenAutoSettings: frozen)
    }

    /// True if a captured frame's exposure still matches the lock (within a third of a stop on the product ISO×shutter).
    public static func exposureHolds(plan: LockPlan, iso: Float?, shutter: Double?) -> Bool {
        guard let iso, let shutter else { return true }
        let want = Double(plan.iso) * plan.shutterSeconds, got = Double(iso) * shutter
        guard want > 0, got > 0 else { return true }
        return abs(log2(got / want)) <= 1.0 / 3
    }
}
