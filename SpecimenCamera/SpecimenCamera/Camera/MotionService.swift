import Foundation
import CoreMotion
import SpecimenCore

/// Core Motion feed: gravity for the level indicator, and movement detection during stacks.
@MainActor
final class MotionService: ObservableObject {
    @Published private(set) var level = LevelIndicator.state(gx: 0, gy: -1, gz: 0)
    @Published private(set) var motionStatus: MotionMonitorLogic.Status = .steady
    @Published private(set) var driftDegrees = 0.0

    private let manager = CMMotionManager()
    private let queue = OperationQueue()
    private var logic = MotionMonitorLogic()
    private var monitoring = false
    var onMoved: ((Double) -> Void)?

    init() { queue.name = "app.specimencamera.motion"; queue.maxConcurrentOperationCount = 1 }

    func start() {
        guard manager.isDeviceMotionAvailable, !manager.isDeviceMotionActive else { return }
        manager.deviceMotionUpdateInterval = 1.0 / 20
        manager.startDeviceMotionUpdates(to: queue) { @Sendable [weak self] motion, _ in
            guard let m = motion else { return }
            let g = m.gravity
            let rot = sqrt(m.rotationRate.x * m.rotationRate.x + m.rotationRate.y * m.rotationRate.y + m.rotationRate.z * m.rotationRate.z)
            let acc = sqrt(m.userAcceleration.x * m.userAcceleration.x + m.userAcceleration.y * m.userAcceleration.y + m.userAcceleration.z * m.userAcceleration.z)
            let t = m.timestamp
            Task { @MainActor in self?.ingest(gx: g.x, gy: g.y, gz: g.z, rotation: rot, acceleration: acc, time: t) }
        }
    }

    func stop() { manager.stopDeviceMotionUpdates() }

    /// Call when a stack starts: movement is measured against the pose at this moment.
    func beginStackMonitoring() {
        monitoring = true
        logic.reset(baseline: nil)
        motionStatus = .steady; driftDegrees = 0
    }

    func endStackMonitoring() { monitoring = false; motionStatus = .steady }

    func acknowledgeMovement() { logic.acknowledge(newBaseline: nil); motionStatus = .steady; driftDegrees = 0 }

    private func ingest(gx: Double, gy: Double, gz: Double, rotation: Double, acceleration: Double, time: TimeInterval) {
        level = LevelIndicator.state(gx: gx, gy: gy, gz: gz)
        guard monitoring else { return }
        let before = logic.status
        let status = logic.ingest(.init(time: time, rotationRate: rotation, userAcceleration: acceleration, gravity: (gx, gy, gz)))
        driftDegrees = logic.driftDegrees
        if status != motionStatus { motionStatus = status }
        if status == .moved, before != .moved { onMoved?(logic.driftDegrees) }
    }
}
