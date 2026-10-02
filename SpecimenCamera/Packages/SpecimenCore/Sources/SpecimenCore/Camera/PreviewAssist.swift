import Foundation

/// Viewfinder exposure assist: how much brighter than the photo the LIVE VIEW is allowed to be while ISO and shutter are manual.
/// It only changes what the camera's preview stream looks like; the photo is always taken with the user's own settings (the app
/// switches to them for the instant of capture and back again afterwards).
public enum PreviewAssist: String, Codable, Sendable, CaseIterable {
    case off, match, plus1, plus2, plus3

    /// Short label for the on-screen chip.
    public var title: String {
        switch self { case .off: return "OFF"; case .match: return "MATCH"; case .plus1: return "+1 EV"; case .plus2: return "+2 EV"; case .plus3: return "+3 EV" }
    }

    /// Extra brightness on top of "same as the photo", in stops.
    public var stops: Double {
        switch self { case .off, .match: return 0; case .plus1: return 1; case .plus2: return 2; case .plus3: return 3 }
    }

    public var explanation: String {
        switch self {
        case .off: return "Live view shows the photo's exact exposure (can be dark or laggy with a slow shutter)."
        case .match: return "Same brightness as the photo, but smooth: the live view uses a faster shutter and higher ISO."
        case .plus1, .plus2, .plus3: return "Brighter than the photo by \(Int(stops)) stop\(stops > 1 ? "s" : "") so you can see and focus. The photo is unaffected."
        }
    }

    /// Next setting when the on-screen chip is tapped.
    public var next: PreviewAssist {
        switch self { case .match: return .plus1; case .plus1: return .plus2; case .plus2: return .plus3; case .plus3: return .off; case .off: return .match }
    }
}

public struct PreviewExposure: Sendable, Equatable {
    public var iso: Float
    public var shutterSeconds: Double
}

public enum PreviewAssistPlanner {
    /// Longest shutter the live view will use to reach the target when ISO alone cannot (about 15 frames per second).
    public static let slowestPreferredShutter = 1.0 / 15
    /// Shutter the live view prefers (smooth, 30 frames per second).
    public static let preferredShutter = 1.0 / 30

    /// The exposure for the live view, or nil when it should simply use the photo's own settings.
    ///
    /// Same total exposure (ISO × shutter) as the photo times 2^stops, delivered with a shutter no slower than 1/30 s: the ISO
    /// goes up instead. If the sensor's maximum ISO is not enough, the shutter lengthens again, but never beyond what the photo
    /// itself uses (or 1/15 s) and never beyond what the device allows.
    public static func plan(iso: Float, shutter: Double, assist: PreviewAssist, minISO: Float, maxISO: Float,
                            minShutter: Double, maxShutter: Double) -> PreviewExposure? {
        guard assist != .off, iso > 0, shutter > 0, maxISO > 0 else { return nil }
        let target = Double(iso) * shutter * pow(2, assist.stops)
        var s = min(shutter, preferredShutter)
        var i = target / s
        if i > Double(maxISO) {
            i = Double(maxISO)
            s = min(target / i, max(shutter, slowestPreferredShutter))
        }
        i = max(i, Double(minISO))
        s = min(max(s, minShutter), maxShutter)
        // nothing to change: the photo's own settings already do the job
        if abs(Double(iso) - i) / Double(iso) < 0.02 && abs(shutter - s) / shutter < 0.02 { return nil }
        return PreviewExposure(iso: Float(i), shutterSeconds: s)
    }
}
