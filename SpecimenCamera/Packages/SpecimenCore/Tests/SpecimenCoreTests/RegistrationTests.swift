import XCTest
@testable import SpecimenCore
import SpecimenTestKit

final class RegistrationTests: XCTestCase {
    let W = 512, H = 384

    /// NOTE: `warp(img, T)` produces a frame whose reference→frame transform is T⁻¹ (frame(q) = img(T(q))).
    /// Max corner disagreement (px) between two transforms.
    func cornerError(_ a: Affine2D, _ b: Affine2D) -> Double {
        var m = 0.0
        for (x, y) in [(0.0, 0.0), (Double(W), 0), (0, Double(H)), (Double(W), Double(H)), (Double(W) / 2, Double(H) / 2)] {
            let p = a.apply(x, y), q = b.apply(x, y)
            m = max(m, hypot(p.x - q.x, p.y - q.y))
        }
        return m
    }

    func warped(_ img: RGBImage, _ t: Affine2D) -> RGBImage {
        Resample.warp(img, sourceOrigin: (0, 0), transform: t, outputRect: PixelRect(x: 0, y: 0, width: W, height: H))
    }

    func estimate(_ ref: RGBImage, _ frm: RGBImage, rot: Bool = true) -> (Affine2D, Double) {
        var o = RegistrationOptions(); o.estimateRotationScale = rot
        let r = ImageRegistration.estimate(reference: ImageRegistration.normalize(ref.luma(.displayP3)),
                                           frame: ImageRegistration.normalize(frm.luma(.displayP3)), options: o)
        return (r.transform, r.confidence)
    }

    func testRecoversTranslation() {
        let tex = SyntheticSpecimen.texture(width: W, height: H, seed: 21)
        let t = Affine2D(a: 1, b: 0, tx: 2.7, c: 0, d: 1, ty: -1.3)
        let (est, conf) = estimate(tex, warped(tex, t))
        XCTAssertLessThan(cornerError(est, t.inverted()!), 0.1, "est \(est)")
        XCTAssertGreaterThan(conf, 0.9)
    }

    func testRecoversSimilarity() {
        let tex = SyntheticSpecimen.texture(width: W, height: H, seed: 22)
        let t = Affine2D.similarity(scale: 1.004, rotation: 0.003, translation: (-3.1, 2.2), center: (255.5, 191.5))
        let (est, _) = estimate(tex, warped(tex, t))
        XCTAssertLessThan(cornerError(est, t.inverted()!), 0.15, "est \(est)")
    }

    func testRecoversLargeShift() {
        let tex = SyntheticSpecimen.texture(width: W, height: H, seed: 23)
        let t = Affine2D(a: 1, b: 0, tx: 14, c: 0, d: 1, ty: -9)
        let (est, _) = estimate(tex, warped(tex, t))
        XCTAssertLessThan(cornerError(est, t.inverted()!), 0.2)
    }

    func testIdentityStaysIdentity() {
        let tex = SyntheticSpecimen.texture(width: W, height: H, seed: 24)
        let (est, conf) = estimate(tex, tex)
        XCTAssertLessThan(cornerError(est, .identity), 0.02)
        XCTAssertGreaterThan(conf, 0.99)
    }

    func testRobustToIlluminationChangeAndGlare() {
        let tex = SyntheticSpecimen.texture(width: W, height: H, seed: 25)
        let t = Affine2D(a: 1, b: 0, tx: 1.8, c: 0, d: 1, ty: 2.4)
        var frm = warped(tex, t)
        // gradient + gain illumination change, a big clipped glare blob and a coloured reflection
        for y in 0..<H { for x in 0..<W {
            let shade = 0.7 + 0.5 * Float(x) / Float(W)
            let gl = 2.5 * expf(-(powf(Float(x) - 150, 2) + powf(Float(y) - 120, 2)) / (2 * 40 * 40))
            let mg = (x > 330 && x < 430 && y > 200 && y < 330) ? Float(0.35) : 0
            frm.r[x, y] = min(1, frm.r[x, y] * shade + gl + mg)
            frm.g[x, y] = min(1, frm.g[x, y] * shade + gl)
            frm.b[x, y] = min(1, frm.b[x, y] * shade + gl + mg)
        }}
        let (est, conf) = estimate(tex, frm)
        XCTAssertLessThan(cornerError(est, t.inverted()!), 0.25, "est \(est) conf \(conf)")
    }

    func testRobustToDefocusDifference() {
        let s = SyntheticFocus.make(width: W, height: H, frames: 8, seed: 5, noise: 0.003, jitter: false, breathing: 0)
        let t = Affine2D(a: 1, b: 0, tx: 1.4, c: 0, d: 1, ty: -0.9)
        // frame 1 vs a shifted copy of frame 2 (different parts are sharp in each)
        let (est, _) = estimate(s.frames[1], warped(s.frames[2], t))
        XCTAssertLessThan(cornerError(est, t.inverted()!), 0.2, "est \(est)")
    }

    func testSeriesChainingAndFullResolutionScaling() throws {
        // 1024×768 so the proxy factor is > 1 and scaledUp is exercised
        let W2 = 1024, H2 = 768
        let tex = SyntheticSpecimen.texture(width: W2, height: H2, seed: 26)
        let rect = PixelRect(x: 0, y: 0, width: W2, height: H2)
        let truth = [Affine2D(a: 1, b: 0, tx: -4.2, c: 0, d: 1, ty: 1.1), .identity,
                     Affine2D.similarity(scale: 1.001, rotation: 0.001, translation: (3.3, -2.6), center: (511.5, 383.5))]
        let frames = truth.map { MemoryFrame(Resample.warp(tex, sourceOrigin: (0, 0), transform: $0, outputRect: rect)) as any FrameSource }
        var opts = RegistrationOptions(); opts.maxProxyPixels = 200_000        // forces factor 2
        let al = try ImageRegistrationEngine.align(frames: frames, referenceIndex: 1, options: opts)
        for (a, t) in zip(al, truth) {
            XCTAssertFalse(a.failed)
            var m = 0.0
            for (x, y) in [(0.0, 0.0), (1024.0, 768.0), (512.0, 384.0)] {
                let p = a.transform.apply(x, y), q = t.inverted()!.apply(x, y); m = max(m, hypot(p.x - q.x, p.y - q.y))
            }
            XCTAssertLessThan(m, 0.3, "alignment \(a.transform) vs truth \(t)")
        }
    }

    func testUnrelatedImagesAreRejected() throws {
        let a = MemoryFrame(SyntheticSpecimen.texture(width: W, height: H, seed: 30))
        var rng = SplitMix64(seed: 1)
        var noise = RGBImage(width: W, height: H)
        for i in 0..<noise.r.count { noise.r.pixels[i] = rng.uniform(); noise.g.pixels[i] = rng.uniform(); noise.b.pixels[i] = rng.uniform() }
        let al = try ImageRegistrationEngine.align(frames: [a, MemoryFrame(noise)], referenceIndex: 0)
        XCTAssertTrue(al[1].failed)
        XCTAssertEqual(al[1].transform, .identity)
    }
}
