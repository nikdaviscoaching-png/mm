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

    func testPeakingOverlayIsRedByDefaultAndOnePixelWide() {
        var mask = [UInt8](repeating: 0, count: 20 * 20); mask[10 * 20 + 10] = 255
        let o = FocusPeaking.overlayBGRA(mask: mask, width: 20, height: 20, color: .red)
        let center = (10 * 20 + 10) * 4
        XCTAssertGreaterThan(o[center + 2], 200); XCTAssertLessThan(o[center + 1], 40); XCTAssertEqual(o[center + 3], UInt8(0.9 * 255))
        XCTAssertEqual(o[(10 * 20 + 11) * 4 + 3], 0, "the CPU fallback no longer thickens the marker")
        XCTAssertEqual(PeakingColor.allCases.first, .red)
    }

    // MARK: Fine ridge peaking

    /// Gaussian-blurred straight edge (`deg` = angle of its normal), pixel-integrated like a sensor.
    func edgeLuma(sigma: Double, deg: Double, contrast: Double = 100, size: Int = 96, phase: Double = 0.3, noise: Double = 0, seed: UInt64 = 1) -> [Float] {
        let th = deg * .pi / 180, nx = cos(th), ny = sin(th)
        var out = [Float](repeating: 0, count: size * size)
        let cx = Double(size) / 2 + phase, cy = Double(size) / 2 + phase * 0.7
        var rng = SplitMix64(seed: seed)
        for y in 0..<size { for x in 0..<size {
            var acc = 0.0
            for sy in 0..<4 { for sx in 0..<4 {
                let d = (Double(x) + (Double(sx) + 0.5) / 4 - cx) * nx + (Double(y) + (Double(sy) + 0.5) / 4 - cy) * ny
                acc += 0.5 * (1 + erf(d / (sigma * 2.0.squareRoot())))
            }}
            out[y * size + x] = 60 + Float(contrast * acc / 16) + Float(noise * Double(rng.gaussian()))
        }}
        return out
    }

    /// Fraction of the edge's length that carries a ridge pixel, and the ridge pixels per unit of edge length.
    func edgeStats(_ r: PeakingRidges, deg: Double, size: Int = 96) -> (coverage: Double, perLength: Double) {
        let th = deg * .pi / 180
        // the edge line crosses the image centre; its length inside the image, and its direction (tangent)
        let tx = -sin(th), ty = cos(th)
        let length = Double(size) / max(abs(tx), abs(ty))
        var marked = 0
        for y in 0..<size { for x in 0..<size where r.flag[y * size + x] != 0 {
            // only count ridge pixels near the real edge (ignore image borders)
            if x < 4 || y < 4 || x >= size - 4 || y >= size - 4 { continue }
            marked += 1
        }}
        // steps along the tangent in 1 px increments: is there a ridge pixel within 1.2 px of the true line there?
        var hit = 0, total = 0
        var t = -length / 2 + 6
        while t < length / 2 - 6 {
            let px = Double(size) / 2 + 0.3 + tx * t, py = Double(size) / 2 + 0.21 + ty * t
            if px > 5, py > 5, px < Double(size) - 5, py < Double(size) - 5 {
                total += 1
                var found = false
                for dy in -2...2 { for dx in -2...2 {
                    let ix = Int(px) + dx, iy = Int(py) + dy
                    if r.flag[iy * size + ix] != 0, hypot(Double(ix) + 0.5 - px, Double(iy) + 0.5 - py) < 1.2 { found = true }
                }}
                if found { hit += 1 }
            }
            t += 1
        }
        return (Double(hit) / Double(max(total, 1)), Double(marked) / length)
    }

    func testRidgesAreOnePixelThinAtAnyAngle() {
        for deg in [0.0, 20, 45, 70, 90] {
            let l = edgeLuma(sigma: 0.6, deg: deg)
            let r = FocusPeaking.ridges(luma: l, width: 96, height: 96, sensitivity: .medium)
            let s = edgeStats(r, deg: deg)
            XCTAssertGreaterThan(s.coverage, 0.95, "edge at \(deg)° must be continuous (\(s.coverage))")
            // a one-pixel-wide digital line has |cos θ| + |sin θ| pixels per unit length (1 axis-aligned … 1.41 diagonal); a band
            // (the old Laplacian result) has several times that
            let th = deg * .pi / 180
            XCTAssertLessThan(s.perLength, abs(cos(th)) + abs(sin(th)) + 0.15, "edge at \(deg)° must be a single-pixel line, not a band (\(s.perLength) ridge px per px of edge)")
        }
    }

    func testSteepnessSeparatesCrispFromSoftIndependentOfContrastAndAngle() {
        for contrast in [45.0, 200] { for deg in [0.0, 45, 70] {
            let crisp = FocusPeaking.ridges(luma: edgeLuma(sigma: 0.6, deg: deg, contrast: contrast), width: 96, height: 96, sensitivity: .medium)
            let soft = FocusPeaking.ridges(luma: edgeLuma(sigma: 2.0, deg: deg, contrast: contrast), width: 96, height: 96, sensitivity: .medium)
            XCTAssertGreaterThan(edgeStats(crisp, deg: deg).coverage, 0.9, "crisp edge, contrast \(contrast), \(deg)°")
            XCTAssertLessThan(edgeStats(soft, deg: deg).coverage, 0.05, "soft edge must not be marked, contrast \(contrast), \(deg)°")
        }}
    }

    func testSensitivityControlsHowSoftAnEdgeStillCounts() {
        func coverage(_ sigma: Double, _ sens: PeakingSensitivity) -> Double {
            let vals = [0.0, 45, 70].map { deg in edgeStats(FocusPeaking.ridges(luma: edgeLuma(sigma: sigma, deg: deg), width: 96, height: 96, sensitivity: sens), deg: deg).coverage }
            return vals.reduce(0, +) / 3
        }
        // slightly soft edge (σ 1.3): only HIGH marks it
        XCTAssertLessThan(coverage(1.3, .low), 0.1); XCTAssertLessThan(coverage(1.3, .medium), 0.3); XCTAssertGreaterThan(coverage(1.3, .high), 0.8)
        // very crisp edge (σ 0.5): every level marks it
        for sens in [PeakingSensitivity.low, .medium, .high] { XCTAssertGreaterThan(coverage(0.5, sens), 0.9, "\(sens)") }
        // clearly defocused (σ 2.5): nothing marks it
        for sens in [PeakingSensitivity.low, .medium, .high] { XCTAssertLessThan(coverage(2.5, sens), 0.05, "\(sens)") }
    }

    func testEdgesStayContinuousInNoiseAndNoiseDrawsNothing() {
        // moderate sensor noise (σ 4 on a 100-level edge): the line must remain mostly intact
        let n4 = FocusPeaking.ridges(luma: edgeLuma(sigma: 0.7, deg: 20, contrast: 100, noise: 4), width: 96, height: 96, sensitivity: .medium)
        XCTAssertGreaterThan(edgeStats(n4, deg: 20).coverage, 0.8)
        // pure noise: next to nothing, even at the most sensitive level
        var rng = SplitMix64(seed: 9)
        for sigma in [3.0, 8.0] {
            let l = (0..<(300 * 200)).map { _ in Float(128 + sigma * Double(rng.gaussian())) }
            let r = FocusPeaking.ridges(luma: l, width: 300, height: 200, sensitivity: .high)
            XCTAssertLessThan(Double(r.markedCount) / Double(l.count), 0.002, "noise σ \(sigma)")
        }
    }

    func testRidgeDirectionIsTheEdgeTangent() {
        for deg in [10.0, 40, 75] {
            let r = FocusPeaking.ridges(luma: edgeLuma(sigma: 0.6, deg: deg), width: 96, height: 96, sensitivity: .medium)
            var errs: [Double] = []
            for i in 0..<r.flag.count where r.flag[i] != 0 {
                let x = i % 96, y = i / 96
                if x < 8 || y < 8 || x > 87 || y > 87 { continue }
                let a = Double(r.angle[i]) / 255 * .pi                         // tangent angle
                let want = (deg + 90) * .pi / 180
                var d = abs(a - want).truncatingRemainder(dividingBy: .pi); d = min(d, .pi - d)
                errs.append(d * 180 / .pi)
            }
            XCTAssertGreaterThan(errs.count, 40)
            XCTAssertLessThan(errs.sorted()[errs.count / 2], 4, "median direction error at \(deg)° (degrees)")
        }
    }

    func testRoiAnalysisMatchesFullAnalysisInsideTheRegion() {
        let l = edgeLuma(sigma: 0.7, deg: 33, size: 96)
        let full = FocusPeaking.ridges(luma: l, width: 96, height: 96, threshold: 18, minSteepness: 1.27)
        let roi = PixelRect(x: 20, y: 20, width: 50, height: 50)
        let part = FocusPeaking.ridges(luma: l, width: 96, height: 96, threshold: 18, minSteepness: 1.27, region: roi)
        for y in (roi.y + 1)..<(roi.maxY - 1) { for x in (roi.x + 1)..<(roi.maxX - 1) { XCTAssertEqual(full.flag[y * 96 + x], part.flag[y * 96 + x]) } }
    }

    func testGPUParamsLayoutMatchesTheShader() {
        typealias P = PeakingGPUParams
        XCTAssertEqual(MemoryLayout<P>.size, 96); XCTAssertEqual(MemoryLayout<P>.stride, 96); XCTAssertEqual(MemoryLayout<P>.alignment, 16)
        XCTAssertEqual(MemoryLayout<P>.offset(of: \P.threshold), 0); XCTAssertEqual(MemoryLayout<P>.offset(of: \P.showVideo), 24)
        XCTAssertEqual(MemoryLayout<P>.offset(of: \P.peakColor), 32); XCTAssertEqual(MemoryLayout<P>.offset(of: \P.roiOrigin), 48)
        XCTAssertEqual(MemoryLayout<P>.offset(of: \P.roiSize), 56); XCTAssertEqual(MemoryLayout<P>.offset(of: \P.viewScale), 64)
        XCTAssertEqual(MemoryLayout<P>.offset(of: \P.segHalfLength), 72); XCTAssertEqual(MemoryLayout<P>.offset(of: \P.cOrigin), 80)
        XCTAssertEqual(MemoryLayout<P>.offset(of: \P.cSize), 88)
    }

    // MARK: Hairline rendering (screen resolution)

    /// Width (screen px, full width at half maximum) of the rendered line, measured across a horizontal run of ridge pixels.
    func renderedWidth(viewScale: Float) -> (fwhm: Float, minAlongLine: Float) {
        var r = PeakingRidges(width: 40, height: 40)
        for x in 8..<32 { r.flag[20 * 40 + x] = 255; r.angle[20 * 40 + x] = 0 }     // horizontal ridge (tangent angle 0)
        let outW = Int(24 * viewScale), outH = Int(10 * viewScale)
        let img = PeakingRenderer.render(r, region: (x: 8, y: 15, width: 24, height: 10), outWidth: outW, outHeight: outH)
        let cx = outW / 2
        var fwhm: Float = 0
        for y in 0..<outH { fwhm += img[y * outW + cx] }                           // coverage integrated across the line = its width
        var minAlong: Float = 1
        let cy = Int((20.5 - 15) * viewScale)
        for x in Int(2 * viewScale)..<(outW - Int(2 * viewScale)) { minAlong = min(minAlong, (cy - 1...cy + 1).map { img[$0 * outW + x] }.max()!) }
        return (fwhm, minAlong)
    }

    func testHairlineStaysFineAndContinuousAtOneFourAndEightTimesZoom() {
        // viewScale = screen pixels per camera pixel: ~0.3 at 1x on a full-size buffer, ~1.2 at 4x, ~2.3 at 8x
        for (zoom, scale) in [(1, Float(1.0)), (4, 1.2), (8, 2.3), (8, 6.5)] {
            let m = renderedWidth(viewScale: scale)
            XCTAssertLessThan(m.fwhm, 2.2, "line at \(zoom)x (scale \(scale)) must be a hairline, was \(m.fwhm) px wide")
            XCTAssertGreaterThan(m.fwhm, 0.9, "line at \(zoom)x must still be visible")
            XCTAssertGreaterThan(m.minAlongLine, 0.7, "line at \(zoom)x must not break into dashes")
        }
    }

    func testDiagonalHairlineJoinsIntoOneContour() {
        var r = PeakingRidges(width: 40, height: 40)
        for i in 6..<34 { r.flag[i * 40 + i] = 255; r.angle[i * 40 + i] = UInt8((Double.pi / 4) / Double.pi * 255 + 0.5) }   // tangent 45°
        let scale: Float = 4
        let img = PeakingRenderer.render(r, region: (x: 0, y: 0, width: 40, height: 40), outWidth: 160, outHeight: 160)
        // every point along the diagonal (inside the run) is covered; a point 3 camera px (12 screen px) off the line is not
        for k in stride(from: 10.0, to: 30.0, by: 0.7) {
            let on = img[Int((k + 0.5) * Double(scale)) * 160 + Int((k + 0.5) * Double(scale))]
            let off = img[Int((k + 0.5) * Double(scale)) * 160 + Int((k + 3.5) * Double(scale))]
            XCTAssertGreaterThan(on, 0.85, "gap in the contour at \(k)"); XCTAssertLessThan(off, 0.02)
        }
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
