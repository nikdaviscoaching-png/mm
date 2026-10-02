import XCTest
@testable import SpecimenCore

final class PreviewAssistTests: XCTestCase {
    func plan(_ iso: Float, _ shutter: Double, _ a: PreviewAssist, maxISO: Float = 3000) -> PreviewExposure? {
        PreviewAssistPlanner.plan(iso: iso, shutter: shutter, assist: a, minISO: 25, maxISO: maxISO, minShutter: 1.0 / 100_000, maxShutter: 1)
    }
    func stops(_ p: PreviewExposure, vs iso: Float, _ shutter: Double) -> Double { log2(Double(p.iso) * p.shutterSeconds / (Double(iso) * shutter)) }

    func testOffUsesThePhotosOwnSettings() { XCTAssertNil(plan(100, 1.0 / 4, .off)) }

    func testMatchKeepsTheBrightnessButMakesTheViewSmooth() {
        let p = plan(100, 1.0 / 4, .match)!
        XCTAssertEqual(p.shutterSeconds, 1.0 / 30, accuracy: 1e-9)             // fast shutter: smooth
        XCTAssertEqual(stops(p, vs: 100, 1.0 / 4), 0, accuracy: 0.02)          // same brightness
        XCTAssertNil(plan(100, 1.0 / 60, .match), "already fast: nothing to do")
    }

    func testEvStepsBrightenByExactlyThatManyStopsWhenTheSensorAllows() {
        for (a, ev) in [(PreviewAssist.plus1, 1.0), (.plus2, 2), (.plus3, 3)] {
            let p = plan(100, 1.0 / 60, a)!
            XCTAssertEqual(stops(p, vs: 100, 1.0 / 60), ev, accuracy: 0.02, "\(a)")
            XCTAssertLessThanOrEqual(p.shutterSeconds, 1.0 / 60 + 1e-9, "the preview shutter never gets slower than the photo's when it is already fast")
        }
    }

    func testSlowPhotoShutterIsReplacedByAFastOneAndTheIsoRises() {
        let p = plan(100, 1.0, .plus1)!
        XCTAssertLessThan(p.shutterSeconds, 1.0 / 14)
        XCTAssertGreaterThan(p.iso, 100)
        XCTAssertLessThanOrEqual(p.iso, 3000)
    }

    func testWhenIsoRunsOutTheShutterLengthensButStaysWithinLimits() {
        // 100 ISO at 1/60 +3 EV = 800 ISO·1/60 fits; ISO 1600 at 1/30 +3 EV needs 12800 ISO: capped, shutter grows to ≤ 1/15
        let p = plan(1600, 1.0 / 30, .plus3)!
        XCTAssertEqual(p.iso, 3000, accuracy: 0.5)
        XCTAssertLessThanOrEqual(p.shutterSeconds, 1.0 / 15 + 1e-9)
        XCTAssertGreaterThan(stops(p, vs: 1600, 1.0 / 30), 0.5, "still brighter than the photo")
        // a photo already at the sensor's limits cannot be brightened further: the planner says "use the photo's own settings"
        XCTAssertNil(PreviewAssistPlanner.plan(iso: 3000, shutter: 0.5, assist: .plus3, minISO: 25, maxISO: 3000, minShutter: 1e-5, maxShutter: 0.6))
        // and the device's own longest shutter is respected
        let q = PreviewAssistPlanner.plan(iso: 2000, shutter: 0.1, assist: .plus3, minISO: 25, maxISO: 3000, minShutter: 1e-5, maxShutter: 0.2)!
        XCTAssertLessThanOrEqual(q.shutterSeconds, 0.2 + 1e-9)
    }

    func testPlanIsAlwaysWithinDeviceRanges() {
        for iso in [25.0, 64, 100, 400, 1600, 3000] as [Float] { for sh in [1.0 / 8000, 1.0 / 250, 1.0 / 30, 1.0 / 4, 1] { for a in PreviewAssist.allCases {
            guard let p = plan(iso, sh, a) else { continue }
            XCTAssertGreaterThanOrEqual(p.iso, 25); XCTAssertLessThanOrEqual(p.iso, 3000.5)
            XCTAssertGreaterThanOrEqual(p.shutterSeconds, 1.0 / 100_000 - 1e-12); XCTAssertLessThanOrEqual(p.shutterSeconds, 1)
        }}}
    }

    func testChipCyclesThroughEverySettingAndBackToOff() {
        var a = PreviewAssist.off; var seen: [PreviewAssist] = []
        for _ in 0..<5 { a = a.next; seen.append(a) }
        XCTAssertEqual(seen, [.match, .plus1, .plus2, .plus3, .off])
    }
}
