import XCTest
@testable import SpecimenCore
import SpecimenTestKit

final class FocusStackTests: XCTestCase {
    let W = 512, H = 384

    func fuse(_ frames: [RGBImage], options: FocusStackOptions = .init()) throws -> RGBImage {
        let sink = MemorySink(width: frames[0].width, height: frames[0].height)
        _ = try FocusStackEngine.fuse(frames: frames.map { MemoryFrame($0) }, sink: sink, options: options)
        return sink.result
    }

    func testFusionBeatsEverySingleFrameAndApproachesGroundTruth() throws {
        for seed in [3, 11] as [UInt64] {
            let s = SyntheticFocus.make(width: W, height: H, frames: 8, seed: seed, noise: 0.003, breathing: 0)
            let fused = try fuse(s.frames)
            let psnr = ImageMetrics.psnr(fused, s.groundTruth)
            let best = s.frames.map { ImageMetrics.psnr($0, s.groundTruth) }.max()!
            XCTAssertGreaterThan(psnr, 28.5, "seed \(seed)")
            XCTAssertGreaterThan(psnr, best + 6, "seed \(seed): fused must clearly beat the best single frame")
        }
    }

    func testSharpDetailComesFromMultipleDepths() throws {
        let s = SyntheticFocus.make(width: W, height: H, frames: 8, seed: 3, noise: 0.003, breathing: 0)
        let fused = try fuse(s.frames)
        // regions at clearly different depths: near mesa-ish centre, mid Voronoi, far hairlines
        let regions = [PixelRect(x: 180, y: 130, width: 70, height: 70),   // centre bands
                       PixelRect(x: 20, y: 240, width: 140, height: 120),  // Voronoi facets
                       PixelRect(x: 380, y: 10, width: 120, height: 130)]  // far hairlines
        for r in regions {
            let truth = ImageMetrics.sharpness(s.groundTruth, in: r)
            let got = ImageMetrics.sharpness(fused, in: r)
            let bestSingle = s.frames.map { ImageMetrics.sharpness($0, in: r) }.max()!
            // 1–2 px hairlines keep ≈0.3 px residual defocus between focus planes, hence 80 % rather than ~100 %.
            XCTAssertGreaterThan(got, 0.80 * truth, "region \(r)")
            XCTAssertLessThanOrEqual(got, 1.15 * truth, "no artificial sharpening in \(r)")
            XCTAssertGreaterThanOrEqual(got, bestSingle * 0.93, "fused must be at least as sharp as the best single frame in \(r)")
        }
        // contributions come from several frames
        let sink = MemorySink(width: W, height: H)
        let rep = try FocusStackEngine.fuse(frames: s.frames.map { MemoryFrame($0) }, sink: sink)
        XCTAssertGreaterThanOrEqual(rep.dominantPixels.filter { $0 > W * H / 50 }.count, 5)
    }

    func testFlatRegionNextToBrightDetailIsNotContaminatedByDefocusBleed() throws {
        // Regression: a dark flat Voronoi cell between bright cells used to be pulled toward heavily blurred
        // frames (their bleed looked like "detail").
        let s = SyntheticFocus.make(width: W, height: H, frames: 8, seed: 3, noise: 0.003, breathing: 0)
        let fused = try fuse(s.frames)
        let cell = PixelRect(x: 88, y: 283, width: 14, height: 14)
        let a = ImageMetrics.meanColor(fused, in: cell), t = ImageMetrics.meanColor(s.groundTruth, in: cell)
        XCTAssertEqual(a.0, t.0, accuracy: 0.012); XCTAssertEqual(a.1, t.1, accuracy: 0.012); XCTAssertEqual(a.2, t.2, accuracy: 0.012)
    }

    func testNoiseIsNotAmplifiedInTextureFreeRegion() throws {
        let s = SyntheticFocus.make(width: W, height: H, frames: 8, seed: 3, noise: 0.01, breathing: 0)
        let fused = try fuse(s.frames)
        let patch = PixelRect(x: 350, y: 270, width: 120, height: 90)   // smooth gradient patch
        func std(_ img: RGBImage) -> Double {
            // residual vs heavily blurred version
            let y = img.luma(.displayP3); let lo = Filters.gaussianBlur(y, sigma: 6)
            var s = 0.0
            for yy in patch.y..<patch.maxY { for xx in patch.x..<patch.maxX { let d = Double(y[xx, yy] - lo[xx, yy]); s += d * d } }
            return sqrt(s / Double(patch.pixelCount))
        }
        let single = std(s.frames[4]), stacked = std(fused)
        XCTAssertLessThan(stacked, single * 0.9, "stacking flat regions should average noise down, got \(stacked) vs \(single)")
    }

    func testTiledEqualsUntiled() throws {
        let s = SyntheticFocus.make(width: 300, height: 220, frames: 5, seed: 8, noise: 0.003, breathing: 0)
        var big = FocusStackOptions(); big.tileSize = 1024
        var small = FocusStackOptions(); small.tileSize = 128
        let a = try fuse(s.frames, options: big), b = try fuse(s.frames, options: small)
        var maxD: Float = 0, sum = 0.0
        for i in 0..<a.r.count {
            for (p, q) in [(a.r, b.r), (a.g, b.g), (a.b, b.b)] { let d = abs(p.pixels[i] - q.pixels[i]); maxD = max(maxD, d); sum += Double(d) }
        }
        XCTAssertLessThan(sum / Double(a.r.count * 3), 0.0015, "mean tile-vs-whole difference")
        XCTAssertLessThan(maxD, 0.06, "no visible seams at tile borders")
    }

    func testAlignThenFuseHandlesJitterAndFocusBreathing() throws {
        let s = SyntheticFocus.make(width: W, height: H, frames: 8, seed: 3, noise: 0.003, jitter: true, breathing: 0.0008)
        let sources = s.frames.map { MemoryFrame($0) as any FrameSource }
        let refIdx = 4
        let al = try ImageRegistrationEngine.align(frames: sources, referenceIndex: refIdx)
        XCTAssertTrue(al.allSatisfy { !$0.failed }, "alignments: \(al.map { $0.confidence })")
        let aligned = ImageRegistrationEngine.aligned(sources, al)
        let sink = MemorySink(width: W, height: H)
        _ = try FocusStackEngine.fuse(frames: aligned, sink: sink)
        let fusedAligned = sink.result
        // ground truth in the reference frame's geometry
        let truthRef = Resample.warp(s.groundTruth, sourceOrigin: (0, 0), transform: s.trueTransforms[refIdx], outputRect: PixelRect(x: 0, y: 0, width: W, height: H))
        let inner = PixelRect(x: 16, y: 16, width: W - 32, height: H - 32)
        let withAlign = ImageMetrics.psnr(fusedAligned, truthRef, in: inner)
        let unaligned = ImageMetrics.psnr(try fuse(s.frames), truthRef, in: inner)
        XCTAssertGreaterThan(withAlign, 25.5, "aligned PSNR \(withAlign)")
        XCTAssertGreaterThan(withAlign, unaligned + 1.5, "alignment must matter: \(withAlign) vs \(unaligned)")
    }

    func testSingleFrameIsPassedThroughAndBadInputRejected() throws {
        let img = SyntheticSpecimen.texture(width: 100, height: 80, seed: 2)
        let out = try fuse([img])
        XCTAssertEqual(out, img)
        let sink = MemorySink(width: 100, height: 80)
        XCTAssertThrowsError(try FocusStackEngine.fuse(frames: [MemoryFrame(img), MemoryFrame(RGBImage(width: 90, height: 80))], sink: sink))
        XCTAssertThrowsError(try FocusStackEngine.fuse(frames: [], sink: sink))
    }

    func testCancellationStopsAndReportsCancelled() throws {
        let s = SyntheticFocus.make(width: 256, height: 192, frames: 4, seed: 2, noise: 0.003, breathing: 0)
        let sink = MemorySink(width: 256, height: 192)
        XCTAssertThrowsError(try FocusStackEngine.fuse(frames: s.frames.map { MemoryFrame($0) }, sink: sink, isCancelled: { true })) {
            XCTAssertEqual($0 as? SpecimenError, .cancelled)
        }
    }

    func testFileBackedPipelineMatchesInMemory() throws {
        let s = SyntheticFocus.make(width: 256, height: 192, frames: 4, seed: 5, noise: 0.003, breathing: 0)
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("fs-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        var urls: [URL] = []
        for (i, f) in s.frames.enumerated() { let u = dir.appendingPathComponent("f\(i).scw"); try ScwWriter.save(f, to: u); urls.append(u) }
        let out = dir.appendingPathComponent("out.scw")
        let w = try ScwWriter(url: out, width: 256, height: 192, colorSpace: .displayP3)
        _ = try FocusStackEngine.fuse(frames: urls.map { try ScwFrame(url: $0) }, sink: w)
        try w.finish()
        let fromDisk = try ScwFrame(url: out).read(region: PixelRect(x: 0, y: 0, width: 256, height: 192))
        let mem = try fuse(s.frames)
        XCTAssertGreaterThan(ImageMetrics.psnr(fromDisk, mem), 55)
    }
}
