import XCTest
@testable import SpecimenCore

final class SuperResolutionTests: XCTestCase {

    // Analytic scene in "low-resolution pixel units": broad blobs for registration plus fine detail above the LR Nyquist rate.
    static func truth(_ x: Double, _ y: Double) -> Double {
        var v = 0.5
        v += 0.25 * sin(x * 0.11) * cos(y * 0.07)
        v += 0.20 * exp(-((x - 40) * (x - 40) + (y - 52) * (y - 52)) / 180)
        v -= 0.20 * exp(-((x - 75) * (x - 75) + (y - 30) * (y - 30)) / 120)
        v += 0.12 * sin(2 * .pi * (0.62 * x + 0.21 * y))
        v += 0.10 * sin(2 * .pi * (-0.18 * x + 0.71 * y))
        let r = ((x - 58) * (x - 58) + (y - 62) * (y - 62)).squareRoot()
        v += 0.18 * (sin(r * 2.1) > 0 ? 1 : -1) * exp(-r * r / 400)
        return min(max(v, 0), 1)
    }

    /// One LR observation: box integral of the truth over each pixel, shifted by (ox, oy) LR pixels.
    static func frame(size: Int, ox: Double, oy: Double, sub: Int = 4, patch: ((Int, Int, Double) -> Double)? = nil) -> RGBA8Image {
        let img = RGBA8Image(width: size, height: size)
        for j in 0..<size { for i in 0..<size {
            var s = 0.0
            for b in 0..<sub { for a in 0..<sub { s += truth(Double(i) + ox + (Double(a) + 0.5) / Double(sub), Double(j) + oy + (Double(b) + 0.5) / Double(sub)) } }
            var v = s / Double(sub * sub)
            if let patch { v = patch(i, j, v) }
            let g = UInt8(max(0, min(255, (v * 255).rounded())))
            let q = img.bytes + (j * size + i) * 4
            q[0] = g; q[1] = UInt8(max(0, min(255, Int(g) + 6))); q[2] = UInt8(max(0, Int(g) - 6)); q[3] = 255
        } }
        return img
    }

    /// High-resolution answer key (2× grid) = box integral of the truth over each HR pixel.
    static func answer(size: Int) -> [Double] {
        var out = [Double](repeating: 0, count: size * 2 * size * 2)
        for j in 0..<size * 2 { for i in 0..<size * 2 {
            var s = 0.0
            for b in 0..<4 { for a in 0..<4 { s += truth((Double(i) + (Double(a) + 0.5) / 4) / 2, (Double(j) + (Double(b) + 0.5) / 4) / 2) } }
            out[j * size * 2 + i] = s / 16
        } }
        return out
    }

    func run(_ frames: [RGBA8Image], settings: UpscaleSettings = { var s = UpscaleSettings(); s.referenceIndex = 0; return s }(), cancel: @escaping @Sendable () -> Bool = { false }) throws -> (RGBA8Image, SRReport) {
        let W = frames[0].width * 2, H = frames[0].height * 2
        let out = RGBA8Image(width: W, height: H)
        let o = SRMutablePointer(out.bytes)
        let rep = try SuperResolution.upscale(frames: frames, settings: settings, isCancelled: cancel) { rect, bytes in
            for r in 0..<rect.height { (o.p + ((rect.y + r) * W + rect.x) * 4).update(from: bytes + r * rect.width * 4, count: rect.width * 4) }
        }
        return (out, rep)
    }

    func psnr(_ img: RGBA8Image, _ ans: [Double], margin: Int = 8) -> Double {
        var se = 0.0, n = 0.0
        for y in margin..<img.height - margin { for x in margin..<img.width - margin {
            let q = img.bytes + (y * img.width + x) * 4
            let d = Double(q[1] ) / 255 - 6.0 / 255 * 0 - ans[y * img.width + x]    // green = grey + 6/255 offset, compare to truth + offset
            let dd = d - 6.0 / 255
            se += dd * dd; n += 1
        } }
        return 10 * log10(1 / max(se / n, 1e-12))
    }

    func bilinear2x(_ f: RGBA8Image) -> RGBA8Image {
        let o = RGBA8Image(width: f.width * 2, height: f.height * 2)
        for y in 0..<o.height { for x in 0..<o.width {
            let sx = min(max((Float(x) + 0.5) * 0.5 - 0.5, 0), Float(f.width - 1)), sy = min(max((Float(y) + 0.5) * 0.5 - 0.5, 0), Float(f.height - 1))
            let x0 = Int(sx), y0 = Int(sy), x1 = min(x0 + 1, f.width - 1), y1 = min(y0 + 1, f.height - 1), tx = sx - Float(x0), ty = sy - Float(y0)
            for c in 0..<4 {
                @inline(__always) func p(_ xx: Int, _ yy: Int) -> Float { Float(f.bytes[(yy * f.width + xx) * 4 + c]) }
                o.bytes[(y * o.width + x) * 4 + c] = UInt8(((p(x0, y0) * (1 - tx) + p(x1, y0) * tx) * (1 - ty) + (p(x0, y1) * (1 - tx) + p(x1, y1) * tx) * ty).rounded())
            }
        } }
        return o
    }

    static let offsets: [(Double, Double)] = [(0, 0), (0.37, 0.21), (0.71, 0.55), (-0.30, 0.43), (0.18, -0.62)]
    let N = 96
    var burst: [RGBA8Image] { Self.offsets.map { Self.frame(size: N, ox: $0.0, oy: $0.1) } }

    func testRegistrationRecoversSubPixelMotion() {
        let fs = burst
        let ref = SRPyramid(frame: fs[0])
        let noise = SRMath.estimateNoise(ref.levels[0])
        for k in 1..<fs.count {
            let a = SRRegistration.align(ref: ref, cand: SRPyramid(frame: fs[k]), noise: noise)
            XCTAssertTrue(a.isUsable, "frame \(k) residual \(a.residual)")
            // a point at reference x appears at candidate x − ox
            let (u, v) = a.map(160.5 / 2, 160.5 / 2)
            XCTAssertEqual(u, 160.5 / 2 - Float(Self.offsets[k].0), accuracy: 0.15, "frame \(k) u")
            XCTAssertEqual(v, 160.5 / 2 - Float(Self.offsets[k].1), accuracy: 0.15, "frame \(k) v")
        }
    }

    func testMergeBeatsSingleFrameUpscale() throws {
        let ans = Self.answer(size: N)
        let (sr, rep) = try run(burst)
        XCTAssertEqual(sr.width, N * 2); XCTAssertEqual(sr.height, N * 2)
        XCTAssertEqual(rep.usedFrames.count, 5)
        let a = psnr(sr, ans), b = psnr(bilinear2x(burst[0]), ans)
        print("SR \(a) dB  bilinear \(b) dB")
        for lv in SRDetailLevel.allCases { var st = UpscaleSettings(); st.detail = lv; st.referenceIndex = 0; print("  detail \(lv): \(psnr(try run(burst, settings: st).0, ans)) dB") }
        XCTAssertGreaterThan(a, b + 1.5)
    }

    func testSingleFrameStillWorks() throws {
        let ans = Self.answer(size: N)
        var s = UpscaleSettings(); s.detail = .natural; s.referenceIndex = 0
        let (sr, _) = try run([burst[0]], settings: s)
        let a = psnr(sr, ans), b = psnr(bilinear2x(burst[0]), ans)
        print("single SR \(a) dB  bilinear \(b) dB")
        XCTAssertEqual(sr.width, N * 2)
        XCTAssertGreaterThan(a, b - 1.0)
    }

    func testSingleFrameRegionsAreNotBlocky() throws {
        var s = UpscaleSettings(); s.detail = .natural; s.referenceIndex = 0
        let (sr, _) = try run([burst[0]], settings: s)
        let bl = bilinear2x(burst[0])
        func energy(_ i: RGBA8Image) -> Double {
            var e = 0.0
            for y in 8..<i.height - 8 { for x in 8..<i.width - 8 { let d = Double(i.bytes[(y * i.width + x + 1) * 4 + 1]) - Double(i.bytes[(y * i.width + x) * 4 + 1]); e += d * d } }
            return e
        }
        XCTAssertGreaterThan(energy(sr), 0.85 * energy(bl), "not softer than a normal enlargement")
    }

    func testMovingObjectDoesNotGhost() throws {
        // a bright square present only in frames 2 and 3, at different places
        let fs: [RGBA8Image] = Self.offsets.enumerated().map { k, o in
            Self.frame(size: N, ox: o.0, oy: o.1, patch: { i, j, v in
                if k == 2 && i >= 20 && i < 32 && j >= 20 && j < 32 { return 1 }
                if k == 3 && i >= 24 && i < 36 && j >= 24 && j < 36 { return 1 }
                return v })
        }
        let ans = Self.answer(size: N)
        let (sr, _) = try run(fs)
        // region where only the moving squares were: result must stay close to the reference scene, not average in white
        var worst = 0.0
        for y in 40..<72 { for x in 40..<72 {
            let g = Double(sr.bytes[(y * sr.width + x) * 4 + 1]) / 255 - 6.0 / 255
            worst = max(worst, abs(g - ans[y * sr.width + x]))
        } }
        XCTAssertLessThan(worst, 0.2, "no ghost of the moving squares (max error \(worst))")
    }

    func testTilesAreSeamless() throws {
        var a = UpscaleSettings(); a.tileSize = 64; a.referenceIndex = 0
        var b = UpscaleSettings(); b.tileSize = 1024; b.referenceIndex = 0
        let (ta, _) = try run(burst, settings: a), (tb, _) = try run(burst, settings: b)
        var maxD = 0
        for i in 0..<ta.byteCount { maxD = max(maxD, abs(Int(ta.bytes[i]) - Int(tb.bytes[i]))) }
        XCTAssertLessThanOrEqual(maxD, 2, "tile borders must not show (max difference \(maxD))")
    }

    func testSharpenAddsNoHalos() {
        let w = 64, h = 32
        var rgba = [UInt8](repeating: 255, count: w * h * 4)
        for y in 0..<h { for x in 0..<w { let v: UInt8 = x < 32 ? 60 : 190; for c in 0..<3 { rgba[(y * w + x) * 4 + c] = v } } }
        var s = UpscaleSettings(); s.detail = .natural
        SRDetail.finish(rgba: &rgba, width: w, height: h, confidence: [Float](repeating: 0, count: w * h), settings: s, ai: nil)
        var lo: UInt8 = 255, hi: UInt8 = 0
        for y in 0..<h { for x in 0..<w { let v = rgba[(y * w + x) * 4 + 1]; lo = min(lo, v); hi = max(hi, v) } }
        XCTAssertGreaterThanOrEqual(Int(lo), 60 - 8); XCTAssertLessThanOrEqual(Int(hi), 190 + 8)
    }

    struct NoisyAI: UpscaleAIProvider {
        func detailLuma(for rect: SRRect, outputScale: Int, reference: RGBA8Image) -> [Float]? {
            (0..<rect.width * rect.height).map { 128 + Float(($0 * 7919) % 61) - 30 }
        }
    }

    func testAIDetailIsLimitedInFlatAreas() {
        let w = 48, h = 48
        var rgba = [UInt8](repeating: 128, count: w * h * 4)
        for i in 0..<w * h { rgba[i * 4 + 3] = 255 }
        var s = UpscaleSettings(); s.detail = .natural; s.aiStrength = 1
        let ai = (0..<w * h).map { 128 + Float(($0 * 7919) % 61) - 30 }
        SRDetail.finish(rgba: &rgba, width: w, height: h, confidence: [Float](repeating: 0, count: w * h), settings: s, ai: ai)
        var worst = 0
        for i in 0..<w * h { worst = max(worst, abs(Int(rgba[i * 4 + 1]) - 128)) }
        XCTAssertLessThanOrEqual(worst, 16, "AI may add at most a bounded amount of luminance detail (changed by \(worst))")
        // and without AI strength nothing changes
        var plain = [UInt8](repeating: 128, count: w * h * 4)
        s.aiStrength = 0
        SRDetail.finish(rgba: &plain, width: w, height: h, confidence: [Float](repeating: 0, count: w * h), settings: s, ai: ai)
        XCTAssertEqual(plain[1], 128)
    }

    func testUnusableFrameIsRejectedAndTheRestStillMerge() throws {
        var fs = burst
        // frame 4 replaced by an unrelated image (grossly unusable)
        let junk = RGBA8Image(width: N, height: N)
        for i in 0..<N * N { let v = UInt8((i * 2654435761 >> 7) & 255); junk.bytes[i * 4] = v; junk.bytes[i * 4 + 1] = v; junk.bytes[i * 4 + 2] = v }
        fs[4] = junk
        let ans = Self.answer(size: N)
        let (sr, rep) = try run(fs)
        XCTAssertTrue(rep.rejectedFrames.contains(4), "rejected \(rep.rejectedFrames) residuals \(rep.residuals)")
        print("residuals", rep.residuals)
        XCTAssertGreaterThan(psnr(sr, ans), psnr(bilinear2x(fs[0]), ans) + 1.0)
    }

    func testCancellationStopsTheRun() {
        XCTAssertThrowsError(try run(burst, cancel: { true })) { XCTAssertEqual($0 as? SRError, .cancelled) }
    }

    func testThroughputIsReasonableOnAMegapixelOutput() throws {
        let fs = Self.offsets.map { Self.frame(size: 600, ox: $0.0 * 0.5, oy: $0.1 * 0.5, sub: 2) }
        let t0 = Date()
        let (out, rep) = try run(fs)
        let secs = Date().timeIntervalSince(t0), mp = Double(out.width * out.height) / 1e6
        print("1.4 MP output, 5 frames: \(secs) s (\(secs / mp) s per output MP, \(ProcessInfo.processInfo.activeProcessorCount) cores)")
        XCTAssertEqual(rep.usedFrames.count, 5)
        XCTAssertLessThan(secs / mp, 3.0)
    }
}
