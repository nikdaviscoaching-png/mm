import Foundation

public enum GridStyle: String, Codable, Sendable, CaseIterable {
    case off, thirds, fine
    public var title: String { rawValue.capitalized }
    /// Number of cells per axis.
    public var divisions: Int { switch self { case .off: return 0; case .thirds: return 3; case .fine: return 6 } }
}

/// Level/tilt from Core Motion gravity (device coordinates, units of g: portrait upright ≈ (0, −1, 0), lying face-up ≈ (0, 0, −1)).
public struct LevelState: Sendable, Equatable {
    public enum Mode: Sendable, Equatable { case horizon, flat }
    public var mode: Mode
    /// Horizon mode: rotation about the lens axis in degrees (0 = level). Flat mode: tilt about the device y axis.
    public var rollDegrees: Double
    /// Flat mode: tilt about the device x axis; horizon mode: lens elevation above the horizon.
    public var pitchDegrees: Double
    public var isLevel: Bool
}

public enum LevelIndicator {
    public static func state(gx: Double, gy: Double, gz: Double, toleranceDegrees: Double = 0.5) -> LevelState {
        let mag = max(sqrt(gx * gx + gy * gy + gz * gz), 1e-9)
        let x = gx / mag, y = gy / mag, z = gz / mag
        if abs(z) > 0.8 {
            // Phone lying (almost) flat — copy-stand / tripod pointing down: show a 2-axis bubble.
            let tx = asin(max(-1, min(1, x))) * 180 / .pi
            let ty = asin(max(-1, min(1, y))) * 180 / .pi
            return LevelState(mode: .flat, rollDegrees: tx, pitchDegrees: ty, isLevel: abs(tx) <= toleranceDegrees && abs(ty) <= toleranceDegrees)
        }
        let roll = atan2(x, -y) * 180 / .pi
        let elevation = asin(max(-1, min(1, -z))) * 180 / .pi * -1
        // Level when rolled less than tolerance (mod 90° so landscape orientation also reads level).
        let wrapped = roll.truncatingRemainder(dividingBy: 90)
        let r = abs(wrapped) > 45 ? 90 - abs(wrapped) : abs(wrapped)
        return LevelState(mode: .horizon, rollDegrees: roll, pitchDegrees: elevation, isLevel: r <= toleranceDegrees)
    }
}

/// Detects substantial movement during a stack. Small vibrations that alignment can absorb never trigger a warning,
/// and nothing here ever aborts a capture.
public struct MotionMonitorLogic: Sendable {
    public enum Status: Sendable, Equatable { case steady, vibration, moved }
    public struct Sample: Sendable {
        public var time: TimeInterval
        public var rotationRate: Double          // rad/s magnitude
        public var userAcceleration: Double      // g magnitude
        public var gravity: (x: Double, y: Double, z: Double)
        public init(time: TimeInterval, rotationRate: Double, userAcceleration: Double, gravity: (x: Double, y: Double, z: Double)) {
            self.time = time; self.rotationRate = rotationRate; self.userAcceleration = userAcceleration; self.gravity = gravity
        }
    }

    public var driftWarningDegrees = 0.35
    public var impulseRotationRate = 0.08
    public var impulseAcceleration = 0.05
    public var sustainedSeconds = 0.15
    private var baseline: (x: Double, y: Double, z: Double)?
    private var impulseStart: TimeInterval?
    public private(set) var status: Status = .steady
    public private(set) var driftDegrees = 0.0

    public init() {}

    public mutating func reset(baseline g: (x: Double, y: Double, z: Double)?) {
        baseline = g; impulseStart = nil; status = .steady; driftDegrees = 0
    }

    @discardableResult
    public mutating func ingest(_ s: Sample) -> Status {
        if baseline == nil { baseline = s.gravity }
        if let b = baseline {
            let dot = b.x * s.gravity.x + b.y * s.gravity.y + b.z * s.gravity.z
            let nb = sqrt(b.x * b.x + b.y * b.y + b.z * b.z), ns = sqrt(s.gravity.x * s.gravity.x + s.gravity.y * s.gravity.y + s.gravity.z * s.gravity.z)
            driftDegrees = acos(max(-1, min(1, dot / max(nb * ns, 1e-9)))) * 180 / .pi
        }
        let impulse = s.rotationRate > impulseRotationRate || s.userAcceleration > impulseAcceleration
        if impulse {
            if impulseStart == nil { impulseStart = s.time }
        } else { impulseStart = nil }
        let sustained = impulseStart.map { s.time - $0 >= sustainedSeconds } ?? false
        if driftDegrees > driftWarningDegrees || sustained { status = .moved }
        else if impulse || s.rotationRate > 0.01 || s.userAcceleration > 0.01 { status = status == .moved ? .moved : .vibration }
        else if status != .moved { status = .steady }
        return status
    }

    /// Clears a latched "moved" state (e.g. after the user re-confirms the setup).
    public mutating func acknowledge(newBaseline: (x: Double, y: Double, z: Double)? = nil) {
        status = .steady; impulseStart = nil; driftDegrees = 0
        if let n = newBaseline { baseline = n }
    }
}
