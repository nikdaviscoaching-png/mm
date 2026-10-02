import XCTest
@testable import SpecimenCore

final class PlanningTests: XCTestCase {
    let mainOptics = FocusStepPlanner.Optics(fNumber: 1.78, equivalentFocalLengthMM: 24, cropFactor: 3.6)
    let model = FocusDistanceModel(minimumFocusDistanceMM: 120)

    func testDistanceModelEndpointsAndRoundTrip() {
        XCTAssertEqual(model.distanceMM(lensPosition: 0)!, 120, accuracy: 1e-9)
        XCTAssertNil(model.distanceMM(lensPosition: 1))
        for lp in stride(from: 0.0, through: 0.95, by: 0.05) {
            XCTAssertEqual(model.lensPosition(diopters: model.diopters(lensPosition: lp)), lp, accuracy: 1e-9)
        }
        XCTAssertFalse(FocusDistanceModel(minimumFocusDistanceMM: nil).isCalibrated)
    }

    func testDepthOfFieldIsPlausibleForAMainCamera() {
        let d = FocusStepPlanner.depthOfFieldDiopters(mainOptics)!
        XCTAssertGreaterThan(d, 0.1); XCTAssertLessThan(d, 1.5)          // order of 0.3 D
        XCTAssertNil(FocusStepPlanner.depthOfFieldDiopters(.init(fNumber: nil, equivalentFocalLengthMM: 24)))
        // longer lens → much shallower DoF → more frames
        let tele = FocusStepPlanner.Optics(fNumber: 2.8, equivalentFocalLengthMM: 120, cropFactor: 7.6)
        XCTAssertGreaterThan(FocusStepPlanner.autoCount(near: 0.0, far: 0.5, model: model, optics: tele), FocusStepPlanner.autoCount(near: 0.0, far: 0.5, model: model, optics: mainOptics))
    }

    func testAutoCountIsSmallNotWasteful() {
        let n = FocusStepPlanner.autoCount(near: 0.05, far: 0.30, model: model, optics: mainOptics)
        XCTAssertGreaterThanOrEqual(n, 2); XCTAssertLessThanOrEqual(n, 25)
        let dense = FocusStepPlanner.autoCount(near: 0.05, far: 0.30, model: model, optics: mainOptics, density: .conservative)
        let econ = FocusStepPlanner.autoCount(near: 0.05, far: 0.30, model: model, optics: mainOptics, density: .economical)
        XCTAssertGreaterThanOrEqual(dense, n); XCTAssertLessThanOrEqual(econ, n)
    }

    func testPlanEndpointsMonotonicAndUniformInDiopters() {
        let p = FocusStepPlanner.plan(near: 0.1, far: 0.6, model: model, optics: mainOptics, manualCount: 8)
        XCTAssertEqual(p.count, 8)
        XCTAssertEqual(p.positions.first, 0.1); XCTAssertEqual(p.positions.last, 0.6)
        for i in 1..<p.count { XCTAssertGreaterThan(p.positions[i], p.positions[i - 1]) }
        let steps = (1..<p.count).map { Double(p.positions[$0] - p.positions[$0 - 1]) }
        XCTAssertEqual(steps.max()! - steps.min()!, 0, accuracy: 1e-5)
    }

    func testPlanWorksWhenFarIsNearerThanNearAndWhenIdentical() {
        let rev = FocusStepPlanner.plan(near: 0.6, far: 0.1, model: model, optics: mainOptics, manualCount: 5)
        XCTAssertEqual(rev.positions.first, 0.6); XCTAssertEqual(rev.positions.last, 0.1)
        for i in 1..<rev.count { XCTAssertLessThan(rev.positions[i], rev.positions[i - 1]) }
        let same = FocusStepPlanner.plan(near: 0.3, far: 0.3, model: model, optics: mainOptics, manualCount: nil)
        XCTAssertEqual(same.count, 1)
    }

    func testFallsBackToEmpiricalSteppingWithoutOptics() {
        let p = FocusStepPlanner.plan(near: 0.0, far: 0.4, model: FocusDistanceModel(minimumFocusDistanceMM: nil), optics: nil, manualCount: nil)
        XCTAssertFalse(p.usedOpticsEstimate)
        XCTAssertGreaterThanOrEqual(p.count, 5); XCTAssertLessThanOrEqual(p.count, 20)
        XCTAssertTrue(p.note.contains("empirical"))
    }

    func testManualCountAndLimits() {
        XCTAssertEqual(FocusStepPlanner.plan(near: 0, far: 1, model: model, optics: nil, manualCount: 30).count, 30)
        XCTAssertEqual(FocusStepPlanner.plan(near: 0, far: 1, model: model, optics: nil, manualCount: 5000).count, FocusStepPlanner.maximumFrames)
        XCTAssertEqual(FocusStepPlanner.plan(near: 0, far: 1, model: model, optics: nil, manualCount: 1).count, 2)
    }

    func testPreflightEstimatesAndIssues() {
        let est = StackPreflight.estimate(type: .combined, groupSizes: [6, 6, 6, 6], format: .proRAW, width: 8064, height: 6048, keepSources: false)
        XCTAssertGreaterThan(est.sourceBytes, 24 * 100_000_000)             // 24 × ~146 MB ProRAW
        XCTAssertGreaterThan(est.workingPeakBytes, 6 * 290_000_000)         // ≥ 6 developed 48 MP frames
        let tiny = StackPreflight.check(estimate: est, availableBytes: 2_000_000_000, batteryLevel: 0.5, isCharging: false, thermal: .nominal)
        XCTAssertTrue(tiny.contains { if case .insufficientStorage = $0 { return true } else { return false } })
        XCTAssertTrue(tiny.contains { $0.isBlocking })
        let fine = StackPreflight.check(estimate: est, availableBytes: 200_000_000_000, batteryLevel: 0.9, isCharging: false, thermal: .nominal)
        XCTAssertTrue(fine.isEmpty)
        let battery = StackPreflight.check(estimate: est, availableBytes: 200_000_000_000, batteryLevel: 0.05, isCharging: false, thermal: .nominal)
        XCTAssertEqual(battery, [.criticalBattery(0.05)])
        XCTAssertTrue(StackPreflight.check(estimate: est, availableBytes: 200_000_000_000, batteryLevel: 0.05, isCharging: true, thermal: .nominal).isEmpty)
        XCTAssertEqual(StackPreflight.check(estimate: est, availableBytes: 200_000_000_000, batteryLevel: nil, isCharging: false, thermal: .serious), [.thermalSerious])
    }

    func testThermalPolicyReducesConcurrencyNotQuality() {
        XCTAssertEqual(ThermalPolicy.concurrency(thermal: .nominal, cores: 6, lowPowerMode: false), 2)
        XCTAssertEqual(ThermalPolicy.concurrency(thermal: .fair, cores: 6, lowPowerMode: false), 1)
        XCTAssertEqual(ThermalPolicy.concurrency(thermal: .serious, cores: 6, lowPowerMode: false), 1)
        XCTAssertEqual(ThermalPolicy.concurrency(thermal: .critical, cores: 6, lowPowerMode: false), 0)      // pause
        XCTAssertEqual(ThermalPolicy.concurrency(thermal: .nominal, cores: 6, lowPowerMode: true), 1)
        XCTAssertEqual(ThermalPolicy.concurrency(thermal: .nominal, cores: 1, lowPowerMode: false), 1)
        XCTAssertNotNil(ThermalPolicy.userMessage(.serious)); XCTAssertNil(ThermalPolicy.userMessage(.nominal))
    }
}
