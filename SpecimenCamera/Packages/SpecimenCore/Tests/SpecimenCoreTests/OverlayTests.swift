import XCTest
@testable import SpecimenCore
import SpecimenTestKit

final class OverlayTests: XCTestCase {

    func lumaBytes(_ img: RGBImage) -> [UInt8] {
        // preview-style luma from display-encoded RGB
        img.luma(.rec709).pixels.map { UInt8(min(max($0, 0), 1) * 255 + 0.5) }
    }

    func count(_ m: [UInt8], w: Int, in r: PixelRect) -> Int {
        var c = 0
        for y in r.y..<r.maxY { for x in r.x..<r.maxX where m[y * w + x] != 0 { c += 1 } }
        return c
    }

    func testPeakingMarksSharpEdgesAndIgnoresBlur() {
        let tex = SyntheticSpecimen.texture(width: 512, height: 384, seed: 4)
        let blurred = RGBImage(r: Filters.gaussianBlur(tex.r, sigma: 3), g: Filters.gaussianBlur(tex.g, sigma: 3), b: Filters.gaussianBlur(tex.b, sigma: 3))
        let sharp = FocusPeaking.mask(luma: lumaBytes(tex), width: 512, height: 384, sensitivity: .medium).filter { $0 != 0 }.count
        let soft = FocusPeaking.mask(luma: lumaBytes(blurred), width: 512, height: 384, sensitivity: .medium).filter { $0 != 0 }.count
        XCTAssertGreaterThan(sharp, 2000)
        XCTAssertGreaterThan(sharp, soft * 10, "blur must not be painted as in focus (\(sharp) vs \(soft))")
    }

    func testPeakingDoesNotPaintFlatNoise() {
        var rng = SplitMix64(seed: 3)
        for sens in [PeakingSensitivity.low, .medium, .high] {
            var l = [UInt8](repeating: 0, count: 400 * 300)
            for i in 0..<l.count { l[i] = UInt8(min(max(128 + 3 * rng.gaussian(), 0), 255)) }       // σ ≈ 3/255 sensor-ish noise
            let m = FocusPeaking.mask(luma: l, width: 400, height: 300, sensitivity: sens)
            XCTAssertLessThan(Double(m.filter { $0 != 0 }.count) / Double(l.count), 0.002, "noise coverage at \(sens)")
        }
        // even heavier noise: threshold adapts upward
        var l = [UInt8](repeating: 0, count: 400 * 300)
        for i in 0..<l.count { l[i] = UInt8(min(max(128 + 9 * rng.gaussian(), 0), 255)) }
        let heavy = FocusPeaking.mask(luma: l, width: 400, height: 300, sensitivity: .high)
        XCTAssertLessThan(Double(heavy.filter { $0 != 0 }.count) / Double(l.count), 0.01)
    }

    func testPeakingTracksFocusAcrossASeries() {
        let s = SyntheticFocus.make(width: 512, height: 384, frames: 8, seed: 3, noise: 0.002, breathing: 0)
        // left strip = near depth (~0.2), right strip = far depth (~0.85) of the synthetic scene (hairline zone)
        let near = PixelRect(x: 10, y: 240, width: 120, height: 120)       // facets, depth ≈ 0.2–0.3
        let far = PixelRect(x: 380, y: 10, width: 120, height: 130)        // hairlines, depth ≈ 0.7–0.85
        var nearCounts: [Int] = [], farCounts: [Int] = []
        for f in s.frames {
            let m = FocusPeaking.mask(luma: lumaBytes(f), width: 512, height: 384, sensitivity: .medium)
            nearCounts.append(count(m, w: 512, in: near)); farCounts.append(count(m, w: 512, in: far))
        }
        XCTAssertLessThan(nearCounts.firstIndex(of: nearCounts.max()!)!, farCounts.firstIndex(of: farCounts.max()!)!, "peak moves with focus")
        XCTAssertGreaterThan(nearCounts.max()!, 4 * nearCounts[7]); XCTAssertGreaterThan(farCounts.max()!, 3 * farCounts[0])
    }

    func testSensitivityLevelsNest() {
        let tex = SyntheticSpecimen.texture(width: 400, height: 300, seed: 6)
        let blurry = RGBImage(r: Filters.gaussianBlur(tex.r, sigma: 1.2), g: Filters.gaussianBlur(tex.g, sigma: 1.2), b: Filters.gaussianBlur(tex.b, sigma: 1.2))
        let l = lumaBytes(blurry)
        let c = [PeakingSensitivity.off, .low, .medium, .high].map { FocusPeaking.mask(luma: l, width: 400, height: 300, sensitivity: $0).filter { $0 != 0 }.count }
        XCTAssertEqual(c[0], 0)
        XCTAssertLessThanOrEqual(c[1], c[2]); XCTAssertLessThanOrEqual(c[2], c[3])
        XCTAssertGreaterThan(c[3], c[1])
    }

    func testPeakingOverlayIsRedByDefaultAndThickened() {
        var mask = [UInt8](repeating: 0, count: 20 * 20); mask[10 * 20 + 10] = 255
        let o = FocusPeaking.overlayBGRA(mask: mask, width: 20, height: 20, color: .red)
        let center = (10 * 20 + 10) * 4
        XCTAssertGreaterThan(o[center + 2], 200); XCTAssertLessThan(o[center + 1], 40); XCTAssertEqual(o[center + 3], UInt8(0.9 * 255))
        XCTAssertGreaterThan(o[(10 * 20 + 11) * 4 + 3], 0, "marker is one pixel thicker")
        XCTAssertEqual(o[(10 * 20 + 13) * 4 + 3], 0)
        XCTAssertEqual(PeakingColor.allCases.first, .red)
    }

    func testZebraThresholds() {
        var bgra = [UInt8](repeating: 0, count: 4 * 4)
        // px0 white, px1 clipped red only, px2 97 %, px3 90 %
        bgra[0...3] = [255, 255, 255, 255]; bgra[4...7] = [10, 10, 255, 255]; bgra[8...11] = [247, 247, 247, 255]; bgra[12...15] = [230, 230, 230, 255]
        XCTAssertEqual(Zebra.mask(bgra: bgra, width: 4, height: 1, level: .p100), [255, 255, 0, 0])
        XCTAssertEqual(Zebra.mask(bgra: bgra, width: 4, height: 1, level: .p98), [255, 255, 0, 0])
        XCTAssertEqual(Zebra.mask(bgra: bgra, width: 4, height: 1, level: .p95), [255, 255, 255, 0])
        XCTAssertEqual(Zebra.mask(bgra: bgra, width: 4, height: 1, level: .off), [0, 0, 0, 0])
        XCTAssertNotEqual(Zebra.stripe(x: 0, y: 0), Zebra.stripe(x: 5, y: 0))
    }

    func testHistogramCountsAndClipping() {
        let w = 100, h = 100
        var bgra = [UInt8](repeating: 0, count: w * h * 4)
        for i in 0..<(w * h) {
            let v: UInt8 = i < 2000 ? 255 : (i < 3000 ? 0 : 128)
            bgra[i * 4] = v; bgra[i * 4 + 1] = v; bgra[i * 4 + 2] = v; bgra[i * 4 + 3] = 255
        }
        let hist = bgra.withUnsafeBufferPointer { HistogramRenderer.compute(bgra: $0, width: w, height: h, bytesPerRow: w * 4, targetSamples: w * h) }
        XCTAssertEqual(hist.sampleCount, 10_000)
        XCTAssertEqual(hist.luma[255], 2000); XCTAssertEqual(hist.luma[0], 1000)
        XCTAssertEqual(hist.clippedHighlightFraction, 0.2, accuracy: 1e-6); XCTAssertEqual(hist.crushedShadowFraction, 0.1, accuracy: 1e-6)
        XCTAssertEqual(hist.normalized(hist.luma, logScale: false).max()!, 1, accuracy: 1e-6)
        // strided sampling stays proportional
        let sparse = bgra.withUnsafeBufferPointer { HistogramRenderer.compute(bgra: $0, width: w, height: h, bytesPerRow: w * 4, targetSamples: 2500) }
        XCTAssertEqual(Double(sparse.clippedHighlightFraction), 0.2, accuracy: 0.03)
    }

    func testLevelIndicator() {
        let upright = LevelIndicator.state(gx: 0, gy: -1, gz: 0)
        XCTAssertEqual(upright.mode, .horizon); XCTAssertTrue(upright.isLevel); XCTAssertEqual(upright.rollDegrees, 0, accuracy: 1e-6)
        let rolled = LevelIndicator.state(gx: sin(3 * .pi / 180), gy: -cos(3 * .pi / 180), gz: 0)
        XCTAssertEqual(abs(rolled.rollDegrees), 3, accuracy: 1e-6); XCTAssertFalse(rolled.isLevel)
        let landscape = LevelIndicator.state(gx: -1, gy: 0, gz: 0)
        XCTAssertTrue(landscape.isLevel, "landscape holds read level too")
        let flat = LevelIndicator.state(gx: 0, gy: 0, gz: -1)
        XCTAssertEqual(flat.mode, .flat); XCTAssertTrue(flat.isLevel)
        let tilted = LevelIndicator.state(gx: sin(2 * .pi / 180), gy: 0, gz: -cos(2 * .pi / 180))
        XCTAssertEqual(tilted.mode, .flat); XCTAssertEqual(tilted.rollDegrees, 2, accuracy: 1e-6); XCTAssertFalse(tilted.isLevel)
    }

    func testMotionMonitorIgnoresTinyVibrationButFlagsMovement() {
        var m = MotionMonitorLogic()
        let g = (x: 0.0, y: -1.0, z: 0.0)
        // tabletop hum
        for i in 0..<200 { m.ingest(.init(time: Double(i) * 0.01, rotationRate: 0.004, userAcceleration: 0.004, gravity: g)) }
        XCTAssertEqual(m.status, .steady)
        // a brief tap (shorter than the sustain window)
        m.ingest(.init(time: 2.0, rotationRate: 0.2, userAcceleration: 0.1, gravity: g))
        m.ingest(.init(time: 2.05, rotationRate: 0.002, userAcceleration: 0.002, gravity: g))
        XCTAssertNotEqual(m.status, .moved)
        // sustained shake
        m.reset(baseline: g)
        for i in 0..<30 { m.ingest(.init(time: 3.0 + Double(i) * 0.01, rotationRate: 0.2, userAcceleration: 0.1, gravity: g)) }
        XCTAssertEqual(m.status, .moved)
        m.acknowledge()
        XCTAssertEqual(m.status, .steady)
        // slow drift: the phone slowly tips by 0.6°
        m.reset(baseline: g)
        for i in 0...60 {
            let a = Double(i) / 60 * 0.6 * .pi / 180
            m.ingest(.init(time: 10 + Double(i) * 0.1, rotationRate: 0.0005, userAcceleration: 0.0, gravity: (x: sin(a), y: -cos(a), z: 0)))
        }
        XCTAssertEqual(m.status, .moved); XCTAssertEqual(m.driftDegrees, 0.6, accuracy: 0.02)
    }

    func testGridDivisions() {
        XCTAssertEqual(GridStyle.thirds.divisions, 3); XCTAssertEqual(GridStyle.off.divisions, 0); XCTAssertGreaterThan(GridStyle.fine.divisions, 3)
    }
}
