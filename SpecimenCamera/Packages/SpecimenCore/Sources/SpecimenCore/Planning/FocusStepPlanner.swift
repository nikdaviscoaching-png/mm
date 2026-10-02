import Foundation

/// Maps iPhone lens positions (0 = closest focus … 1 = infinity) to focus distance and back.
///
/// Apple does not document the lens-position→distance curve. Thin-lens optics say lens travel is approximately linear in
/// *diopters* (1/distance), so the model is: diopters(lp) = (1 − lp) · (1 / minimumFocusDistance). It is exact at both
/// ends (lp 0 → closest focus, lp 1 → infinity) and a good first-order fit between; it is used for planning only and is
/// never presented to the user as a measurement.
public struct FocusDistanceModel: Sendable, Equatable {
    /// Closest focus distance in millimetres, if the device reports it (AVCaptureDevice.minimumFocusDistance).
    public var minimumFocusDistanceMM: Double?
    public init(minimumFocusDistanceMM: Double?) { self.minimumFocusDistanceMM = minimumFocusDistanceMM }

    /// Fallback when the device does not report a minimum focus distance: a typical rear-camera 120 mm.
    public var effectiveMinimumMM: Double { minimumFocusDistanceMM.flatMap { $0 > 0 ? $0 : nil } ?? 120 }
    public var isCalibrated: Bool { minimumFocusDistanceMM != nil }

    public func diopters(lensPosition lp: Double) -> Double { (1 - min(max(lp, 0), 1)) * 1000 / effectiveMinimumMM }
    public func distanceMM(lensPosition lp: Double) -> Double? {
        let d = diopters(lensPosition: lp)
        return d > 1e-6 ? 1000 / d : nil
    }
    public func lensPosition(diopters d: Double) -> Double { 1 - min(max(d / (1000 / effectiveMinimumMM), 0), 1) }
}

public enum StackDensity: String, Codable, Sendable, CaseIterable {
    case conservative, normal, economical
    /// Step as a fraction of the estimated total depth of field.
    var stepFraction: Double { switch self { case .conservative: return 0.35; case .normal: return 0.5; case .economical: return 0.7 } }
    public var title: String { rawValue.capitalized }
}

public struct FocusPlan: Sendable, Equatable {
    public var positions: [Float]            // lens positions, near → far (or as set), inclusive of both ends
    public var count: Int { positions.count }
    public var estimatedDepthOfFieldDiopters: Double
    public var usedOpticsEstimate: Bool
    public var note: String
}

/// Computes where to place focus frames between SET NEAR and SET FAR.
///
/// AUTO: frames are spaced in diopter space (where depth of field is nearly uniform) by a fraction of the estimated
/// total depth of field `DoF_D ≈ 2·N·c / f²` (N = f-number, c = circle of confusion, f = physical focal length).
/// Apple exposes the f-number (`lensAperture`) and field of view but not the sensor size, so the physical focal length
/// is estimated from the 35 mm-equivalent focal length with a per-lens crop factor; where an input is missing a
/// conservative empirical step is used instead. The result is the fewest frames that still overlap; the user can always
/// override the count (presets or any number).
public enum FocusStepPlanner {
    public static let minimumFrames = 2
    public static let maximumFrames = 120

    public struct Optics: Sendable, Equatable {
        public var fNumber: Double?                 // AVCaptureDevice.lensAperture
        public var equivalentFocalLengthMM: Double? // 35 mm-equivalent
        public var cropFactor: Double               // sensor-size estimate for this lens
        public var circleOfConfusionMM: Double      // acceptable blur diameter on the sensor
        public init(fNumber: Double?, equivalentFocalLengthMM: Double?, cropFactor: Double = 3.6, circleOfConfusionMM: Double = 0.0045) {
            self.fNumber = fNumber; self.equivalentFocalLengthMM = equivalentFocalLengthMM
            self.cropFactor = cropFactor; self.circleOfConfusionMM = circleOfConfusionMM
        }
        /// Typical crop factors for iPhone rear modules, by 35 mm-equivalent focal length. Estimates, documented as such.
        public static func typicalCropFactor(equivalentFocalLength f: Double?) -> Double {
            guard let f else { return 3.6 }
            if f < 18 { return 5.6 }        // ultra wide
            if f < 40 { return 3.6 }        // main
            if f < 90 { return 5.5 }        // 2×/3× tele crops and small tele sensors
            return 7.6                       // 5× tele
        }
    }

    /// Total depth of field expressed in diopters, or nil if optics are insufficient.
    public static func depthOfFieldDiopters(_ o: Optics) -> Double? {
        guard let n = o.fNumber, n > 0, let feq = o.equivalentFocalLengthMM, feq > 0 else { return nil }
        let f = feq / max(o.cropFactor, 1)                  // physical focal length in mm
        let dofPerMM = 2 * n * o.circleOfConfusionMM / (f * f)   // in 1/mm
        return dofPerMM * 1000                                // 1/mm → diopters (1/m)
    }

    public static func autoCount(near: Float, far: Float, model: FocusDistanceModel, optics: Optics, density: StackDensity = .normal) -> Int {
        plan(near: near, far: far, model: model, optics: optics, density: density, manualCount: nil).count
    }

    public static func plan(near: Float, far: Float, model: FocusDistanceModel, optics: Optics?,
                            density: StackDensity = .normal, manualCount: Int?) -> FocusPlan {
        let span = abs(Double(far) - Double(near))
        let dSpan = abs(model.diopters(lensPosition: Double(far)) - model.diopters(lensPosition: Double(near)))
        var count: Int
        var dof: Double = 0
        var used = false
        var note = ""
        if let manual = manualCount {
            count = manual
            note = "manual frame count"
        } else if span < 0.002 {
            count = 1
            note = "near and far are the same focus position"
        } else if let o = optics, let d = depthOfFieldDiopters(o), model.isCalibrated {
            dof = d; used = true
            let step = max(d * density.stepFraction, 1e-4)
            count = Int(ceil(dSpan / step)) + 1
            note = "estimated from depth of field (\(String(format: "%.2f", d)) D) with \(density.title.lowercased()) overlap"
        } else {
            // Empirical fallback: lens position distance per frame ~0.045 conservative … 0.08 economical.
            let perFrame: Double = {
                switch density { case .conservative: return 0.03; case .normal: return 0.045; case .economical: return 0.065 }
            }()
            count = Int(ceil(span / perFrame)) + 1
            note = "empirical stepping (device optics not fully known)"
        }
        count = min(max(count, span < 0.002 && manualCount == nil ? 1 : minimumFrames), maximumFrames)
        if count == 1 { return FocusPlan(positions: [near], estimatedDepthOfFieldDiopters: dof, usedOpticsEstimate: used, note: note) }
        // Space frames uniformly in diopters (≡ uniform lens position under the model).
        let d0 = model.diopters(lensPosition: Double(near)), d1 = model.diopters(lensPosition: Double(far))
        let positions: [Float] = (0..<count).map { i in
            let t = Double(i) / Double(count - 1)
            return Float(model.lensPosition(diopters: d0 + (d1 - d0) * t))
        }
        // Pin the end points exactly to what the user set (avoid model round-trip error).
        var p = positions; p[0] = near; p[count - 1] = far
        return FocusPlan(positions: p, estimatedDepthOfFieldDiopters: dof, usedOpticsEstimate: used, note: note)
    }

    public static let presetCounts = [5, 10, 15, 20, 30]
}
