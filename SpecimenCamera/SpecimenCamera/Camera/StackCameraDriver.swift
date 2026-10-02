import Foundation
import AVFoundation
import SpecimenCore

/// Adapts the AVFoundation engine to the `CameraDriving` protocol used by the (hardware-free, unit-tested) coordinator.
final class StackCameraDriver: CameraDriving, @unchecked Sendable {
    private let engine: CameraEngine
    private let quality: @Sendable () -> StackQuality

    init(engine: CameraEngine, quality: @escaping @Sendable () -> StackQuality) {
        self.engine = engine; self.quality = quality
    }

    func lockForStack(_ plan: LockPlan) async throws {
        try await engine.lockForStack(plan, prioritization: quality())
        Log.stack.info("stack locked: ISO \(plan.iso) shutter \(plan.shutterSeconds) WB \(plan.whiteBalanceKelvin) K lens \(plan.lensID, privacy: .public)")
    }

    func unlockAfterStack() async { await engine.releaseStackLock() }

    func setLensPosition(_ position: Float) async throws { try await engine.setLensPosition(position) }

    func capturePhoto(format: CaptureFormat, into directory: URL, fileName: String) async throws -> CapturedFrameInfo {
        try await engine.capturePhoto(format: format, into: directory, fileName: fileName)
    }
}
