import Foundation
import SpecimenCore
import SpecimenTestKit

/// Renders the old (thick) and new (hairline) peaking side by side at 1×, ~4× and 8× on a synthetic specimen, so the
/// difference can be judged by eye. `specimen-lab peaking <outdir>`.
func runPeakingLab(out: URL) throws {
    try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
    let W = 1344, H = 1008
    let series = SyntheticFocus.make(width: W, height: H, frames: 8, seed: 3, noise: 0.004, breathing: 0)
    let frame = series.frames[2]
    let luma: [Float] = frame.luma(.rec709).pixels.map { min(max($0, 0), 1) * 255 }

    // new algorithm
    let sens = PeakingSensitivity.medium
    let ridges = FocusPeaking.ridges(luma: luma, width: W, height: H, sensitivity: sens)
    // old algorithm (modified Laplacian + 2-neighbour support + the 3x3 thickening of the old overlay)
    let oldMask = oldPeakingMask(luma: luma, width: W, height: H)
    print("ridge pixels new:", ridges.markedCount, " old (after thickening):", oldMask.filter { $0 }.count)

    func bilinear(_ img: RGBImage, _ x: Float, _ y: Float) -> (Float, Float, Float) {
        let fx = min(max(x - 0.5, 0), Float(W - 1)), fy = min(max(y - 0.5, 0), Float(H - 1))
        let x0 = Int(fx), y0 = Int(fy), x1 = min(x0 + 1, W - 1), y1 = min(y0 + 1, H - 1)
        let tx = fx - Float(x0), ty = fy - Float(y0)
        func ch(_ p: Plane) -> Float { (p[x0, y0] * (1 - tx) + p[x1, y0] * tx) * (1 - ty) + (p[x0, y1] * (1 - tx) + p[x1, y1] * tx) * ty }
        return (ch(img.r), ch(img.g), ch(img.b))
    }

    func view(region: (x: Float, y: Float, w: Float, h: Float), outW: Int, outH: Int, new: Bool) -> RGBImage {
        var o = RGBImage(width: outW, height: outH)
        let cover: [Float] = new ? PeakingRenderer.render(ridges, region: (x: region.x, y: region.y, width: region.w, height: region.h), outWidth: outW, outHeight: outH) : []
        for oy in 0..<outH { for ox in 0..<outW {
            let sx = region.x + (Float(ox) + 0.5) / Float(outW) * region.w, sy = region.y + (Float(oy) + 0.5) / Float(outH) * region.h
            var c = bilinear(frame, sx, sy)
            var a: Float = 0
            if new { a = cover[oy * outW + ox] * 0.92 }
            else {
                let ix = min(max(Int(sx), 0), W - 1), iy = min(max(Int(sy), 0), H - 1)
                if oldMask[iy * W + ix] { a = 0.92 }
            }
            c = (c.0 * (1 - a) + 1.0 * a, c.1 * (1 - a) + 0.05 * a, c.2 * (1 - a) + 0.05 * a)
            o.r[ox, oy] = c.0; o.g[ox, oy] = c.1; o.b[ox, oy] = c.2
        }}
        return o
    }

    // (label, region in source px). viewScale = outW / region.w
    let outW = 1170 / 2, outH = 585 / 2 * 2 / 2 * 2          // keep files small: half the phone's pixel width
    let cases: [(String, (x: Float, y: Float, w: Float, h: Float))] = [
        ("1x", (0, 0, Float(W), Float(H) * 1)),
        ("8x_fullres_buffer", (700, 380, Float(outW) / 2.3, Float(outH) / 2.3)),
        ("8x_preview_buffer", (704, 392, Float(outW) / 6.5, Float(outH) / 6.5)),
    ]
    for (name, r) in cases {
        let ow = outW, oh = Int(Float(ow) * r.h / r.w)
        let old = view(region: r, outW: ow, outH: oh, new: false), new = view(region: r, outW: ow, outH: oh, new: true)
        try PNG.write(ImageMetrics.montage([old, new], columns: 2), to: out.appendingPathComponent("peaking_\(name)_old_vs_new.png"))
        print("wrote peaking_\(name)_old_vs_new.png  (left = old, right = new)")
    }
}

/// The previous algorithm, kept here only for the comparison picture.
func oldPeakingMask(luma: [Float], width w: Int, height h: Int) -> [Bool] {
    var resp = [Float](repeating: 0, count: w * h)
    for y in 1..<(h - 1) { for x in 1..<(w - 1) {
        let c = luma[y * w + x] * 2
        resp[y * w + x] = abs(c - luma[y * w + x - 1] - luma[y * w + x + 1]) + abs(c - luma[(y - 1) * w + x] - luma[(y + 1) * w + x])
    }}
    let t: Float = 18
    var m = [Bool](repeating: false, count: w * h)
    for y in 2..<(h - 2) { for x in 2..<(w - 2) where resp[y * w + x] >= t {
        var n = 0
        for dy in -1...1 { for dx in -1...1 where (dx != 0 || dy != 0) && resp[(y + dy) * w + x + dx] >= t * 0.6 { n += 1 } }
        if n >= 2 { m[y * w + x] = true }
    }}
    var d = [Bool](repeating: false, count: w * h)
    for y in 1..<(h - 1) { for x in 1..<(w - 1) {
        var on = false
        for dy in -1...1 where !on { for dx in -1...1 where !on && m[(y + dy) * w + x + dx] { on = true } }
        d[y * w + x] = on
    }}
    return d
}
