import Foundation

/// Scale estimation. Accuracy matters more than pretence: every estimate carries an uncertainty and a plain-language
/// verdict; nothing here ever labels a rough number as precise.
public enum ScaleEstimator {

    /// Manual reference: two points the user placed on an object of known length (card, ruler, calibration scale).
    public static func fromReference(pixelDistance: Double, knownLengthMM: Double, pointPlacementErrorPixels: Double = 1.5) -> (scale: ScaleMetadata, uncertaintyFraction: Double)? {
        guard pixelDistance > 1, knownLengthMM > 0 else { return nil }
        let ppm = pixelDistance / knownLengthMM
        let unc = min(max(pointPlacementErrorPixels * 2 / pixelDistance, 0.002), 0.5)
        let note = String(format: "±%.1f %% (manual reference, %.0f mm over %.0f px)", unc * 100, knownLengthMM, pixelDistance)
        return (ScaleMetadata(pixelsPerMillimeter: ppm, method: .manualReference, accuracyNote: note), unc)
    }

    public enum LiDARVerdict: Equatable, Sendable {
        case reliable(uncertaintyFraction: Double)
        case rough(uncertaintyFraction: Double, reason: String)
        case notRecommended(reason: String)
        public var uncertaintyFraction: Double? {
            switch self { case .reliable(let u), .rough(let u, _): return u; case .notRecommended: return nil }
        }
    }

    /// The LiDAR depth error is on the order of ±1 cm and it does not return trustworthy depth very close to the sensor, so
    /// small specimens photographed at macro distance cannot be measured to useful accuracy this way.
    public static func assessLiDAR(distanceMM: Double, errorMM: Double = 10) -> LiDARVerdict {
        if distanceMM < 250 { return .notRecommended(reason: "Closer than about 25 cm the LiDAR scanner is not accurate enough to size a specimen. Use a reference object instead.") }
        let unc = errorMM / distanceMM
        if unc <= 0.03 { return .reliable(uncertaintyFraction: unc) }
        if unc <= 0.08 { return .rough(uncertaintyFraction: unc, reason: "Roughly ±\(Int((unc * 100).rounded())) % — fine for a size hint, not for a listing dimension.") }
        return .notRecommended(reason: "Uncertainty would exceed 8 %. Use a reference object instead.")
    }

    /// Pinhole scale from camera-to-subject distance and the focal length expressed in pixels of the *final image*.
    public static func fromDistance(distanceMM: Double, focalLengthPixels: Double) -> Double? {
        guard distanceMM > 0, focalLengthPixels > 0 else { return nil }
        return focalLengthPixels / distanceMM
    }

    public static func millimeters(pixels: Double, scale: ScaleMetadata) -> Double { pixels / scale.pixelsPerMillimeter }

    /// Focal length in pixels of the final image, from the 35 mm-equivalent focal length (defined on the 43.27 mm diagonal).
    /// Valid for the module's native aspect ratio; the result is an estimate (sensor size is inferred, not read).
    public static func focalLengthPixels(equivalentFocalLengthMM f: Double, imageWidth w: Int, imageHeight h: Int) -> Double? {
        guard f > 0, w > 0, h > 0 else { return nil }
        let a = Double(max(w, h)), b = Double(min(w, h))
        // sensor width (long side) as a fraction of its diagonal: a / hypot(a, b); f_px = f_eq · (diag_px / 43.27 mm)
        return f * hypot(a, b) / 43.27
    }
}

public enum ScaleBar {
    /// Picks a "nice" bar length (1, 2, 5 × 10ⁿ mm) that spans roughly `targetFraction` of the image width.
    public static func choose(pixelsPerMillimeter: Double, imageWidthPixels: Int, targetFraction: Double = 0.2) -> (lengthMM: Double, pixels: Double, label: String) {
        let targetMM = Double(imageWidthPixels) * targetFraction / pixelsPerMillimeter
        let mag = pow(10, floor(log10(max(targetMM, 1e-6))))
        let nice = [1.0, 2, 5, 10].map { $0 * mag }.min { abs($0 - targetMM) < abs($1 - targetMM) } ?? mag
        let label = nice >= 10 ? "\(Int(nice.rounded())) mm" : (nice >= 1 ? (nice == nice.rounded() ? "\(Int(nice)) mm" : String(format: "%.1f mm", nice)) : String(format: "%.1f mm", nice))
        return (nice, nice * pixelsPerMillimeter, label)
    }
}
