import XCTest
@testable import SpecimenCore
import SpecimenTestKit

final class ImagingTests: XCTestCase {

    func testGaussianPreservesMeanAndSmooths() {
        var p = Plane(width: 64, height: 48)
        p[32, 24] = 1
        let b = Filters.gaussianBlur(p, sigma: 2)
        XCTAssertEqual(b.pixels.reduce(0, +), 1, accuracy: 1e-4)
        XCTAssertLessThan(b[32, 24], 0.1)
        XCTAssertEqual(b[32, 24], b[33, 24] + (b[32, 24] - b[33, 24]), accuracy: 1e-6)
        XCTAssertEqual(b[30, 24], b[34, 24], accuracy: 1e-6)
    }

    func testBoxBlurMatchesBruteForce() {
        var rng = SplitMix64(seed: 5)
        var p = Plane(width: 23, height: 17)
        for i in 0..<p.count { p.pixels[i] = rng.uniform() }
        let r = 3
        let fast = Filters.boxBlur(p, radius: r)
        for y in 0..<p.height { for x in 0..<p.width {
            var s: Float = 0
            for j in -r...r { for i in -r...r { s += p.clamped(x + i, y + j) } }
            XCTAssertEqual(fast[x, y], s / Float((2 * r + 1) * (2 * r + 1)), accuracy: 1e-4)
        }}
    }

    func testLaplacianPyramidReconstructsExactly() {
        for (w, h) in [(64, 48), (65, 37), (100, 3)] {
            var rng = SplitMix64(seed: UInt64(w))
            var p = Plane(width: w, height: h)
            for i in 0..<p.count { p.pixels[i] = rng.uniform() }
            let lap = Pyramid.laplacian(p, levels: 4)
            let back = Pyramid.collapse(lap)
            XCTAssertEqual(back.width, w); XCTAssertEqual(back.height, h)
            for i in 0..<p.count { XCTAssertEqual(back.pixels[i], p.pixels[i], accuracy: 1e-4) }
        }
    }

    func testBoxDownscaleAverages() {
        var p = Plane(width: 4, height: 4)
        for i in 0..<16 { p.pixels[i] = Float(i) }
        let d = Filters.boxDownscale(p, factor: 2)
        XCTAssertEqual(d[0, 0], (0 + 1 + 4 + 5) / 4)
        XCTAssertEqual(d[1, 1], (10 + 11 + 14 + 15) / 4)
    }

    func testGuidedFilterKeepsEdgesOfGuide() {
        var guide = Plane(width: 40, height: 40)
        var input = Plane(width: 40, height: 40)
        for y in 0..<40 { for x in 0..<40 {
            guide[x, y] = x < 20 ? 0.1 : 0.9
            input[x, y] = x < 22 ? 0 : 1     // misaligned edge
        }}
        let out = Filters.guidedFilter(guide: guide, input: input, radius: 4, epsilon: 1e-3)
        XCTAssertLessThan(out[14, 20], 0.1)
        XCTAssertGreaterThan(out[26, 20], 0.9)
        XCTAssertGreaterThan(out[21, 20], 0.3)    // pulled toward the guide's edge position (input is 0 there)
    }

    func testTransformAlgebra() {
        let t = Affine2D.similarity(scale: 1.01, rotation: 0.02, translation: (3, -2), center: (50, 40))
        let inv = t.inverted()!
        let p = t.apply(12, 7)
        let q = inv.apply(p.x, p.y)
        XCTAssertEqual(q.x, 12, accuracy: 1e-9); XCTAssertEqual(q.y, 7, accuracy: 1e-9)
        XCTAssertEqual(t.scale, 1.01, accuracy: 1e-9)
        XCTAssertEqual(t.rotation, 0.02, accuracy: 1e-9)
        // proxy → full conversion: a pure proxy translation of 1.5px at factor 4 is 6px at full res
        let proxy = Affine2D(a: 1, b: 0, tx: 1.5, c: 0, d: 1, ty: -0.5)
        let full = proxy.scaledUp(by: 4)
        XCTAssertEqual(full.tx, 6, accuracy: 1e-9); XCTAssertEqual(full.ty, -2, accuracy: 1e-9)
        XCTAssertEqual(full.a, 1, accuracy: 1e-12)
    }

    func testWarpIdentityAndIntegerShift() {
        let img = SyntheticSpecimen.texture(width: 80, height: 60, seed: 2)
        let rect = PixelRect(x: 0, y: 0, width: 80, height: 60)
        let same = Resample.warp(img, sourceOrigin: (0, 0), transform: .identity, outputRect: rect)
        XCTAssertLessThan(ImageMetrics.mse(same, img), 1e-10)
        let shift = Affine2D(a: 1, b: 0, tx: 3, c: 0, d: 1, ty: 2)   // out(p) = img(p + (3,2))
        let s = Resample.warp(img, sourceOrigin: (0, 0), transform: shift, outputRect: rect)
        XCTAssertEqual(s.g[10, 10], img.g[13, 12], accuracy: 1e-5)
    }

    func testWarpedFramePassThroughAndRegionRead() throws {
        let img = SyntheticSpecimen.texture(width: 90, height: 70, seed: 4)
        let base = MemoryFrame(img)
        let wf = WarpedFrame(base: base, transform: Affine2D(a: 1, b: 0, tx: 0.001, c: 0, d: 1, ty: 0))
        XCTAssertTrue(wf.passThrough)
        let moving = WarpedFrame(base: base, transform: .similarity(scale: 1.002, rotation: 0.001, translation: (2.3, -1.4), center: (45, 35)))
        XCTAssertFalse(moving.passThrough)
        // reading in two halves must equal reading whole (tiling invariance of the warp)
        let whole = try moving.read(region: PixelRect(x: 0, y: 0, width: 90, height: 70))
        let left = try moving.read(region: PixelRect(x: 0, y: 0, width: 40, height: 70))
        for y in 0..<70 { for x in 0..<40 { XCTAssertEqual(left.r[x, y], whole.r[x, y], accuracy: 1e-6) } }
    }

    func testScwRoundTripAndEdgeClamp() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("scw-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let img = SyntheticSpecimen.texture(width: 100, height: 75, seed: 9)
        let url = dir.appendingPathComponent("a.scw")
        try ScwWriter.save(img, to: url, colorSpace: .displayP3)
        let f = try ScwFrame(url: url)
        XCTAssertEqual(f.width, 100); XCTAssertEqual(f.height, 75); XCTAssertEqual(f.colorSpace, .displayP3)
        let full = try f.read(region: f.bounds)
        XCTAssertLessThan(ImageMetrics.mse(full, img), 1e-9)       // 16-bit quantisation only
        // region that hangs over the edge replicates it
        let over = try f.read(region: PixelRect(x: 95, y: 70, width: 10, height: 10))
        XCTAssertEqual(over.r[9, 9], img.r[99, 74], accuracy: 1e-4)
        XCTAssertEqual(over.r[0, 9], img.r[95, 74], accuracy: 1e-4)
        // tile-wise write equals whole write
        let url2 = dir.appendingPathComponent("b.scw")
        let w = try ScwWriter(url: url2, width: 100, height: 75, colorSpace: .displayP3)
        for t in TileGrid(imageWidth: 100, imageHeight: 75, tileSize: 32, halo: 0).tiles {
            try w.write(region: t.core, image: img.crop(t.core))
        }
        try w.finish()
        let back = try ScwFrame(url: url2).read(region: f.bounds)
        XCTAssertEqual(back, full)
        // downscaled read
        let proxy = try f.readDownscaled(factor: 4, bandRows: 16)
        XCTAssertEqual(proxy.width, 25); XCTAssertEqual(proxy.height, 19)
        XCTAssertEqual(proxy.g[3, 3], Filters.boxDownscale(full.g, factor: 4)[3, 3], accuracy: 1e-5)
    }

    func testTruncatedAndForeignFilesRejected() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("scw-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let junk = dir.appendingPathComponent("junk.scw")
        try Data(repeating: 7, count: 5000).write(to: junk)
        XCTAssertThrowsError(try ScwFrame(url: junk))
        let url = dir.appendingPathComponent("t.scw")
        try ScwWriter.save(RGBImage(width: 20, height: 20, value: 0.5), to: url)
        let h = try FileHandle(forWritingTo: url); try h.truncate(atOffset: 4096 + 100); try h.close()
        XCTAssertThrowsError(try ScwFrame(url: url))
    }

    func testColorMathRoundTrip() {
        for v in stride(from: Float(0), through: 1, by: 0.05) {
            XCTAssertEqual(ColorMath.decode(ColorMath.encode(v)), v, accuracy: 1e-5)
        }
        XCTAssertEqual(ColorMath.decodeLUT16[65535], 1, accuracy: 1e-6)
    }

    func testTileGridCoversImageExactlyOnce() {
        let g = TileGrid(imageWidth: 130, imageHeight: 70, tileSize: 64, halo: 8)
        var cover = [Int](repeating: 0, count: 130 * 70)
        for t in g.tiles { for y in t.core.y..<t.core.maxY { for x in t.core.x..<t.core.maxX { cover[y * 130 + x] += 1 } } }
        XCTAssertTrue(cover.allSatisfy { $0 == 1 })
        XCTAssertEqual(g.tiles[0].padded, PixelRect(x: -8, y: -8, width: 80, height: 80))
    }
}
