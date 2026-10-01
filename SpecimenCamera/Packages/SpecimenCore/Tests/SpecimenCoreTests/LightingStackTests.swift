import XCTest
@testable import SpecimenCore
import SpecimenTestKit

final class LightingStackTests: XCTestCase {
    let W = 512, H = 384

    func run(_ frames: [RGBImage], options: LightingStackOptions = .init()) throws -> (RGBImage, LightingAnalysis) {
        let sink = MemorySink(width: frames[0].width, height: frames[0].height)
        let a = try LightingStackEngine.run(frames: frames.map { MemoryFrame($0) }, sink: sink, options: options)
        return (sink.result, a)
    }

    func luma(_ img: RGBImage) -> Plane { img.luma(.displayP3) }

    // MARK: acceptance #12 — glare present in one source is replaced from a clean one

    func testBroadClippedGlareInBaseIsReplacedFromCleanFrames() throws {
        let s = SyntheticLighting.standardScenario()
        var o = LightingStackOptions(); o.preferredBase = 0            // frame 0 has the big clipped glare
        let (r, a) = try run(s.frames, options: o)
        XCTAssertEqual(a.baseIndex, 0)
        let core = PixelRect(x: 130, y: 90, width: 50, height: 60)
        XCTAssertGreaterThan(ImageMetrics.meanLuma(s.frames[0], in: core), 0.9, "premise: base glare is blown out")
        let clean = ImageMetrics.meanLuma(s.clean[0], in: core)
        let got = ImageMetrics.meanLuma(r, in: core)
        XCTAssertEqual(got, clean, accuracy: 0.08, "glare core should come back to the specimen's real brightness")
        XCTAssertLessThan(ImageMetrics.maxLuma(r, in: core), 0.97)
        let cr = ImageMetrics.meanColor(r, in: core), cc = ImageMetrics.meanColor(s.clean[0], in: core)
        XCTAssertEqual(cr.0, cc.0, accuracy: 0.08); XCTAssertEqual(cr.1, cc.1, accuracy: 0.08); XCTAssertEqual(cr.2, cc.2, accuracy: 0.08)
        // overall closer to the defect-free rendering than the base frame was
        XCTAssertGreaterThan(ImageMetrics.psnr(r, s.clean[0]), ImageMetrics.psnr(s.frames[0], s.clean[0]) + 5)
    }

    // MARK: acceptance #13 — a narrow polished highlight is kept

    func testNarrowPolishedHighlightSurvives() throws {
        // Base frame: a thin, unclipped polished highlight and nothing else wrong. Other frames: glare elsewhere,
        // no highlight at that spot. The highlight is bright, but it is narrow and keeps its tone — it must stay.
        let streak = Streak(cx: 0.45, cy: 0.38, radius: 0.30, startAngle: 2.2, endAngle: 3.4, thickness: 3.5, peak: 0.45)
        let specs = [LightingFrameSpec(shadeAngle: 0, streaks: [streak]),
                     LightingFrameSpec(shadeAngle: 1.6, glares: [GlareBlob(cx: 0.72, cy: 0.30, sigma: 0.07, amplitude: 3.5)]),
                     LightingFrameSpec(shadeAngle: 3.1, glares: [GlareBlob(cx: 0.30, cy: 0.80, sigma: 0.06, amplitude: 3.0)]),
                     LightingFrameSpec(shadeAngle: 4.7)]
        let s = SyntheticLighting.make(specs: specs)
        var o = LightingStackOptions(); o.preferredBase = 0
        let (r, _) = try run(s.frames, options: o)
        let spot = PixelRect(x: 68, y: 128, width: 20, height: 22)
        let baseMax = ImageMetrics.maxLuma(s.frames[0], in: spot)
        let cleanMax = ImageMetrics.maxLuma(s.clean[0], in: spot)
        XCTAssertGreaterThan(baseMax, cleanMax + 0.12, "premise: the streak is clearly brighter than the stone")
        XCTAssertLessThan(baseMax, 0.995, "premise: it is not a clipped blob")
        let got = ImageMetrics.maxLuma(r, in: spot)
        XCTAssertGreaterThan(got - cleanMax, 0.85 * (baseMax - cleanMax), "highlight kept at ≥85 % of its excess brightness (\(got) vs \(baseMax))")
        XCTAssertGreaterThan(ImageMetrics.sharpness(r, in: spot), 0.9 * ImageMetrics.sharpness(s.frames[0], in: spot), "and it stays crisp, not smeared")
        // whole-image: the result is the base frame there (no matte look, nothing averaged away)
        XCTAssertGreaterThan(ImageMetrics.psnr(r, s.frames[0], in: PixelRect(x: 40, y: 100, width: 100, height: 80)), 40)
    }

    func testBrightnessAloneDoesNotDisqualifyARegion() throws {
        // An un-clipped bright (but tonal) region in the base must stay even though other frames are darker there.
        let specs = [LightingFrameSpec(shadeAngle: 0, glares: [GlareBlob(cx: 0.5, cy: 0.5, sigma: 0.09, amplitude: 0.35)]),
                     LightingFrameSpec(shadeAngle: 1.5), LightingFrameSpec(shadeAngle: 3.0)]
        let s = SyntheticLighting.make(specs: specs)
        var o = LightingStackOptions(); o.preferredBase = 0
        let (r, a) = try run(s.frames, options: o)
        let spot = PixelRect(x: 236, y: 172, width: 40, height: 40)
        let baseL = ImageMetrics.meanLuma(s.frames[0], in: spot)
        XCTAssertEqual(ImageMetrics.meanLuma(r, in: spot), baseL, accuracy: 0.06, "soft unclipped sheen must survive")
        XCTAssertGreaterThan(a.contribution[0], 0.85)
    }

    // MARK: colour contamination

    func testMagentaReflectionInBaseIsReplaced() throws {
        let s = SyntheticLighting.standardScenario()
        var o = LightingStackOptions(); o.preferredBase = 2           // frame 2 carries the magenta phone reflection
        let (r, _) = try run(s.frames, options: o)
        let rc = PixelRect(x: 335, y: 255, width: 50, height: 40)
        let base = ImageMetrics.meanColor(s.frames[2], in: rc), res = ImageMetrics.meanColor(r, in: rc), clean = ImageMetrics.meanColor(s.clean[2], in: rc)
        XCTAssertGreaterThan(base.2 - clean.2, 0.25, "premise: base is clearly magenta here")
        XCTAssertEqual(res.0, clean.0, accuracy: 0.06); XCTAssertEqual(res.1, clean.1, accuracy: 0.06); XCTAssertEqual(res.2, clean.2, accuracy: 0.06)
    }

    // MARK: a dark frame does not win just for lacking glare

    func testMuddyShadowedFrameIsNotPreferredOverWellExposedOne() throws {
        let hole = RegionEffect(x0: 0.2, y0: 0.2, x1: 0.5, y1: 0.55, gain: 0.07, feather: 10)
        let glare = GlareBlob(cx: 0.35, cy: 0.37, sigma: 0.06, amplitude: 3.5)
        let specs = [LightingFrameSpec(shadeAngle: 0, glares: [glare]),                 // base: blown glare
                     LightingFrameSpec(shadeAngle: 3.0, regions: [hole]),               // clean but muddy-dark there
                     LightingFrameSpec(shadeAngle: 1.5), LightingFrameSpec(shadeAngle: 4.5)] // clean and well exposed
        let s = SyntheticLighting.make(specs: specs)
        var o = LightingStackOptions(); o.preferredBase = 0
        let (r, a) = try run(s.frames, options: o)
        let spot = PixelRect(x: 150, y: 110, width: 60, height: 60)
        XCTAssertGreaterThan(ImageMetrics.meanLuma(r, in: spot), 0.8 * ImageMetrics.meanLuma(s.clean[0], in: spot), "must not come out muddy")
        XCTAssertLessThan(a.contribution[1], 0.5 * max(a.contribution[2], a.contribution[3]) + 0.02)
    }

    // MARK: natural look

    func testUndamagedAreasStayExactlyAsInTheBaseFrame() throws {
        let s = SyntheticLighting.standardScenario()
        var o = LightingStackOptions(); o.preferredBase = 0
        let (r, _) = try run(s.frames, options: o)
        // Far from every defect the output is the base frame, bit for bit up to float rounding.
        let far = PixelRect(x: 8, y: 330, width: 100, height: 45)
        XCTAssertGreaterThan(ImageMetrics.psnr(r, s.frames[0], in: far), 45, "no needless changes (no averaging, no matte look)")
        // Next to the repaired glare only the very lowest frequencies shift (coarse-band mask dilation, gain matched).
        let near = PixelRect(x: 8, y: 240, width: 150, height: 130)
        XCTAssertGreaterThan(ImageMetrics.psnr(r, s.frames[0], in: near), 33)
        let hairlines = PixelRect(x: 372, y: 8, width: 130, height: 100)  // frame 1's glare tail does not matter for base 0
        XCTAssertGreaterThan(ImageMetrics.psnr(r, s.frames[0], in: hairlines), 38)
    }

    func testIdenticalFramesProduceThatFrame() throws {
        let s = SyntheticLighting.make(specs: [LightingFrameSpec(), LightingFrameSpec(), LightingFrameSpec()], noise: 0)
        let (r, _) = try run(s.frames)
        XCTAssertGreaterThan(ImageMetrics.psnr(r, s.frames[0]), 60)
    }

    func testTwoFramesWork() throws {
        let s = SyntheticLighting.standardScenario()
        let (r, a) = try run([s.frames[0], s.frames[1]])
        XCTAssertEqual(a.weights.count, 2)
        let core0 = PixelRect(x: 130, y: 90, width: 50, height: 60)   // glare in frame 0, clean in frame 1
        XCTAssertLessThan(ImageMetrics.meanLuma(r, in: core0), 0.6)
    }

    func testWeightsAreAPartitionOfUnity() throws {
        let s = SyntheticLighting.standardScenario()
        let (_, a) = try run(s.frames)
        for i in stride(from: 0, to: a.width * a.height, by: 37) {
            var sum: Float = 0
            for w in a.weights { XCTAssertGreaterThanOrEqual(w.pixels[i], -1e-5); sum += w.pixels[i] }
            XCTAssertEqual(sum, 1, accuracy: 1e-3)
        }
    }

    func testTiledEqualsUntiled() throws {
        let s = SyntheticLighting.make(width: 300, height: 220, specs: SyntheticLighting.standardScenario(width: 300, height: 220).specs)
        var big = LightingStackOptions(); big.tileSize = 1024
        var small = LightingStackOptions(); small.tileSize = 128
        let (a, _) = try run(s.frames, options: big), (b, _) = try run(s.frames, options: small)
        var maxD: Float = 0, sum = 0.0
        for i in 0..<a.r.count { for (p, q) in [(a.r, b.r), (a.g, b.g), (a.b, b.b)] { let d = abs(p.pixels[i] - q.pixels[i]); maxD = max(maxD, d); sum += Double(d) } }
        XCTAssertLessThan(sum / Double(a.r.count * 3), 0.002)
        XCTAssertLessThan(maxD, 0.08, "no seams at tile borders")
    }

    func testAlignedPipelineHandlesShiftedFrames() throws {
        let s = SyntheticLighting.standardScenario()
        let rect = PixelRect(x: 0, y: 0, width: W, height: H)
        let shifts: [Affine2D] = [.identity, Affine2D(a: 1, b: 0, tx: 1.6, c: 0, d: 1, ty: -1.1), Affine2D(a: 1, b: 0, tx: -2.1, c: 0, d: 1, ty: 0.9), Affine2D(a: 1, b: 0, tx: 0.7, c: 0, d: 1, ty: 1.8)]
        let moved = zip(s.frames, shifts).map { Resample.warp($0, sourceOrigin: (0, 0), transform: $1, outputRect: rect) }
        let sources = moved.map { MemoryFrame($0) as any FrameSource }
        let al = try ImageRegistrationEngine.align(frames: sources, referenceIndex: 0)
        XCTAssertTrue(al.allSatisfy { !$0.failed }, "\(al.map { $0.confidence })")
        let sink = MemorySink(width: W, height: H)
        var o = LightingStackOptions(); o.preferredBase = 0
        _ = try LightingStackEngine.run(frames: ImageRegistrationEngine.aligned(sources, al), sink: sink, options: o)
        let core = PixelRect(x: 130, y: 90, width: 50, height: 60)
        XCTAssertLessThan(ImageMetrics.meanLuma(sink.result, in: core), 0.65)
    }

    func testFileBackedMatchesInMemoryAndRejectsBadInput() throws {
        let s = SyntheticLighting.standardScenario(width: 256, height: 192)
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ls-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        var urls: [URL] = []
        for (i, f) in s.frames.enumerated() { let u = dir.appendingPathComponent("l\(i).scw"); try ScwWriter.save(f, to: u); urls.append(u) }
        let out = dir.appendingPathComponent("o.scw")
        let w = try ScwWriter(url: out, width: 256, height: 192, colorSpace: .displayP3)
        try LightingStackEngine.run(frames: urls.map { try ScwFrame(url: $0) }, sink: w); try w.finish()
        let disk = try ScwFrame(url: out).read(region: PixelRect(x: 0, y: 0, width: 256, height: 192))
        let (mem, _) = try run(s.frames)
        XCTAssertGreaterThan(ImageMetrics.psnr(disk, mem), 50)
        XCTAssertThrowsError(try run([s.frames[0]]))
        XCTAssertThrowsError(try LightingStackEngine.run(frames: [MemoryFrame(s.frames[0]), MemoryFrame(RGBImage(width: 10, height: 10))], sink: MemorySink(width: 10, height: 10)))
    }
}
