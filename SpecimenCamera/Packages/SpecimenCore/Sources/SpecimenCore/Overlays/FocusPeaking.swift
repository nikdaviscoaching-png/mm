import Foundation

public enum PeakingSensitivity: String, Codable, Sendable, CaseIterable {
    case off, low, medium, high
    public var title: String { rawValue.capitalized }
    /// Minimum edge strength (0…255 luma units across one pixel step: a crisp black/white step scores its own contrast).
    public var baseThreshold: Float {
        switch self { case .off: return .infinity; case .low: return 28; case .medium: return 18; case .high: return 11 }
    }
    /// Minimum edge *steepness* (see `FocusPeaking`): 1 accepts any edge, 2 only perfectly crisp steps. Measured values:
    /// an edge blurred by σ px reads ≈1.65 (σ 0.5), 1.40 (0.9), 1.31 (1.1), 1.21 (1.4), 1.14 (1.8), 1.08 (2.4) at any angle.
    /// LOW keeps σ ≲ 0.8, MEDIUM σ ≲ 1.1, HIGH σ ≲ 1.5, so HIGH also marks edges that are slightly soft.
    public var minSteepness: Float {
        switch self { case .off: return .infinity; case .low: return 1.40; case .medium: return 1.27; case .high: return 1.18 }
    }
}

public enum PeakingColor: String, Codable, Sendable, CaseIterable {
    case red, yellow, green, cyan, blue, magenta, white
    public var title: String { rawValue.capitalized }
    /// sRGB components 0…1.
    public var rgb: (Float, Float, Float) {
        switch self {
        case .red: return (1, 0.05, 0.05)
        case .yellow: return (1, 0.9, 0)
        case .green: return (0.1, 1, 0.1)
        case .cyan: return (0, 0.9, 1)
        case .blue: return (0.2, 0.4, 1)
        case .magenta: return (1, 0, 0.9)
        case .white: return (1, 1, 1)
        }
    }
}

/// Thin ridge map of the in-focus edges: one flag per pixel plus the direction of the edge there.
public struct PeakingRidges: Sendable, Equatable {
    public let width: Int, height: Int
    /// 255 on the single-pixel ridge of every in-focus edge, else 0.
    public var flag: [UInt8]
    /// Direction ALONG the edge (tangent): 0…255 encodes 0…π, in image coordinates (x right, y down).
    public var angle: [UInt8]
    public var markedCount: Int { flag.reduce(0) { $0 + ($1 != 0 ? 1 : 0) } }
    public init(width: Int, height: Int) {
        self.width = width; self.height = height
        flag = [UInt8](repeating: 0, count: width * height); angle = flag
    }
}

/// Focus peaking as **fine edge traces**: marks the one-pixel ridge of genuinely in-focus edges, not areas.
///
/// Why the old approach looked like blobs: it thresholded a Laplacian, which responds on *both sides* of an edge and across
/// the whole soft transition, then thickened the result. At 4–8× magnification every marked pixel became a block.
///
/// Method (all on the luma at the camera buffer's own resolution):
///  1. **Edge strength** `G1` = Sobel gradient magnitude (÷4, so a crisp step scores its contrast).
///  2. **Thinning**: non-maximum suppression along the gradient direction keeps only the ridge pixel of each edge.
///  3. **Steepness**: the slope across ±1 pixel divided by the slope across ±2 pixels, both measured along the gradient
///     direction. A perfectly crisp step gives 2, a ramp wider than ~4 px gives 1, so this separates in-focus edges from
///     merely high-contrast soft ones independent of contrast and of edge angle (the sensitivity setting is the cut-off).
///  4. **Noise guard**: the strength threshold is raised to a multiple of the frame's own noise floor, and a ridge pixel
///     needs at least one ridge neighbour (real edges are connected lines; sensor noise is speckle).
///
/// The Metal kernels in the app implement exactly this (the threshold is computed on the CPU from a sparse sample), and
/// `PeakingRenderer` below is the reference for how the ridges are drawn as hairlines at screen resolution.
public enum FocusPeaking {

    // MARK: Luma and gradients

    /// Luma (0…255, same weights as the GPU kernel) from BGRA bytes.
    public static func luma(bgra: UnsafeBufferPointer<UInt8>, width w: Int, height h: Int, bytesPerRow: Int) -> [Float] {
        var out = [Float](repeating: 0, count: w * h)
        for y in 0..<h { for x in 0..<w {
            let i = y * bytesPerRow + x * 4
            out[y * w + x] = 0.2110 * Float(bgra[i + 2]) + 0.7148 * Float(bgra[i + 1]) + 0.0742 * Float(bgra[i])
        }}
        return out
    }

    public static func luma(_ bytes: [UInt8]) -> [Float] { bytes.map { Float($0) } }

    @inline(__always)
    static func at(_ l: UnsafeBufferPointer<Float>, _ x: Int, _ y: Int, _ w: Int, _ h: Int) -> Float {
        l[min(max(y, 0), h - 1) * w + min(max(x, 0), w - 1)]
    }

    /// Sobel gradient ÷ 4 (units: luma per pixel step across the neighbours, i.e. a crisp step gives its contrast).
    @inline(__always)
    static func gradient(_ l: UnsafeBufferPointer<Float>, _ x: Int, _ y: Int, _ w: Int, _ h: Int) -> (Float, Float) {
        let a = at(l, x - 1, y - 1, w, h), b = at(l, x, y - 1, w, h), c = at(l, x + 1, y - 1, w, h)
        let d = at(l, x - 1, y, w, h), f = at(l, x + 1, y, w, h)
        let g = at(l, x - 1, y + 1, w, h), hh = at(l, x, y + 1, w, h), i = at(l, x + 1, y + 1, w, h)
        return (((c + 2 * f + i) - (a + 2 * d + g)) * 0.25, ((g + 2 * hh + i) - (a + 2 * b + c)) * 0.25)
    }

    /// Bilinear luma at a continuous position (pixel k covers [k, k+1), its centre is k + 0.5), edges clamped.
    @inline(__always)
    static func bilinear(_ l: UnsafeBufferPointer<Float>, _ x: Float, _ y: Float, _ w: Int, _ h: Int) -> Float {
        let fx = x - 0.5, fy = y - 0.5
        let x0 = Int(floorf(fx)), y0 = Int(floorf(fy))
        let tx = fx - Float(x0), ty = fy - Float(y0)
        let a = at(l, x0, y0, w, h), b = at(l, x0 + 1, y0, w, h), c = at(l, x0, y0 + 1, w, h), d = at(l, x0 + 1, y0 + 1, w, h)
        return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty
    }

    /// Edge steepness along the gradient direction `n` (unit vector): the slope measured across ±1 pixel divided by the slope
    /// measured across ±2 pixels (as `2·|d1| / |d2|`). Measuring along the gradient itself makes it independent of the edge angle.
    /// Returns `(|d1|·2, |d2|)`; the edge passes when `2·|d1| ≥ minSteepness·|d2|`.
    @inline(__always)
    static func steepnessTerms(_ l: UnsafeBufferPointer<Float>, _ x: Int, _ y: Int, _ nx: Float, _ ny: Float, _ w: Int, _ h: Int) -> (Float, Float) {
        let cx = Float(x) + 0.5, cy = Float(y) + 0.5
        let d1 = bilinear(l, cx + nx, cy + ny, w, h) - bilinear(l, cx - nx, cy - ny, w, h)
        let d2 = bilinear(l, cx + 2 * nx, cy + 2 * ny, w, h) - bilinear(l, cx - 2 * nx, cy - 2 * ny, w, h)
        return (2 * abs(d1), abs(d2))
    }

    @inline(__always) static func length(_ v: (Float, Float)) -> Float { sqrtf(v.0 * v.0 + v.1 * v.1) }

    /// Edge strength used for the noise statistics (sampled sparsely by the app on the camera buffer).
    public static func strength(luma l: UnsafeBufferPointer<Float>, x: Int, y: Int, width w: Int, height h: Int) -> Float {
        length(gradient(l, x, y, w, h))
    }

    // MARK: Threshold

    /// Noise-adaptive threshold from a sparse sample of the frame (every 7th pixel, optionally inside a region).
    public static func threshold(luma: [Float], width w: Int, height h: Int, sensitivity: PeakingSensitivity, region: PixelRect? = nil) -> Float {
        guard sensitivity != .off, w > 8, h > 8 else { return .infinity }
        let r = region ?? PixelRect(x: 0, y: 0, width: w, height: h)
        var sample: [Float] = []
        luma.withUnsafeBufferPointer { l in
            var y = max(r.y, 3)
            while y < min(r.maxY, h - 3) {
                var x = max(r.x, 3)
                while x < min(r.maxX, w - 3) { sample.append(strength(luma: l, x: x, y: y, width: w, height: h)); x += 7 }
                y += 7
            }
        }
        return threshold(fromSampledResponses: sample, sensitivity: sensitivity)
    }

    /// Same threshold from strengths sampled elsewhere (the app samples the camera buffer itself and hands the GPU kernel the
    /// result, so both paths share one rule).
    public static func threshold(fromSampledResponses responses: [Float], sensitivity: PeakingSensitivity) -> Float {
        guard sensitivity != .off else { return .infinity }
        var sample = responses
        sample.sort()
        // The 30th percentile tracks sensor noise even in a textured scene (most pixels are still flat-ish). For Gaussian
        // noise the strength is Rayleigh distributed and 5.5× this value sits beyond its 99.9th percentile.
        let p30 = sample.isEmpty ? 0 : sample[Int(Float(sample.count - 1) * 0.3)]
        let noiseFloor = min(p30 * 5.5, 170)
        return max(sensitivity.baseThreshold, noiseFloor)
    }

    /// Threshold and steepness cut-off together. When the frame is noisy (the noise floor, not the sensitivity setting, sets the
    /// threshold) edge steepness cannot be measured reliably, so the steepness gate relaxes towards "any edge".
    public static func parameters(fromSampledResponses responses: [Float], sensitivity: PeakingSensitivity) -> (threshold: Float, minSteepness: Float) {
        guard sensitivity != .off else { return (.infinity, .infinity) }
        let t = threshold(fromSampledResponses: responses, sensitivity: sensitivity)
        let relax = min(max(sensitivity.baseThreshold / max(t, 1e-3), 0.3), 1)
        return (t, 1 + (sensitivity.minSteepness - 1) * relax)
    }

    // MARK: Ridges

    /// Ridge candidates (steps 1–3). `region` limits the work to part of the image, as the GPU does when magnified.
    public static func candidates(luma: [Float], width w: Int, height h: Int, threshold: Float, minSteepness: Float,
                                  region: PixelRect? = nil) -> PeakingRidges {
        var out = PeakingRidges(width: w, height: h)
        guard w > 4, h > 4, threshold.isFinite else { return out }
        let r = region ?? PixelRect(x: 0, y: 0, width: w, height: h)
        luma.withUnsafeBufferPointer { l in
            for y in max(r.y, 0)..<min(r.maxY, h) {
                for x in max(r.x, 0)..<min(r.maxX, w) {
                    let g = gradient(l, x, y, w, h)
                    let G = length(g)
                    if G < threshold { continue }
                    // direction of the gradient, quantised to four axes (the NMS neighbours)
                    let ax = abs(g.0), ay = abs(g.1)
                    let nx: Int, ny: Int
                    if ay <= 0.4142 * ax { nx = g.0 >= 0 ? 1 : -1; ny = 0 }
                    else if ax <= 0.4142 * ay { nx = 0; ny = g.1 >= 0 ? 1 : -1 }
                    else { nx = g.0 >= 0 ? 1 : -1; ny = g.1 >= 0 ? 1 : -1 }
                    let gPlus = length(gradient(l, x + nx, y + ny, w, h))
                    let gMinus = length(gradient(l, x - nx, y - ny, w, h))
                    if !(G > gMinus && G >= gPlus) { continue }                  // not the ridge of this edge
                    let (d1, d2) = steepnessTerms(l, x, y, g.0 / G, g.1 / G, w, h)
                    if d1 < minSteepness * d2 { continue }                         // too soft: not in focus
                    var theta = atan2f(g.1, g.0) + 1.5707963                       // tangent = gradient rotated by 90°
                    theta -= Float.pi * floorf(theta / Float.pi)                   // → [0, π)
                    out.flag[y * w + x] = 255
                    out.angle[y * w + x] = UInt8(min(max((theta / Float.pi * 255).rounded(), 0), 255))
                }
            }
        }
        return out
    }

    /// Step 4: a ridge pixel needs at least one ridge neighbour.
    public static func applySupport(_ c: PeakingRidges, region: PixelRect? = nil) -> PeakingRidges {
        let w = c.width, h = c.height
        var out = PeakingRidges(width: w, height: h)
        let r = region ?? PixelRect(x: 0, y: 0, width: w, height: h)
        for y in max(r.y, 0)..<min(r.maxY, h) {
            for x in max(r.x, 0)..<min(r.maxX, w) where c.flag[y * w + x] != 0 {
                var n = 0
                for dy in -1...1 { for dx in -1...1 where dx != 0 || dy != 0 {
                    let xx = x + dx, yy = y + dy
                    if xx >= 0, yy >= 0, xx < w, yy < h, c.flag[yy * w + xx] != 0 { n += 1 }
                }}
                if n >= 1 { out.flag[y * w + x] = 255; out.angle[y * w + x] = c.angle[y * w + x] }
            }
        }
        return out
    }

    public static func ridges(luma: [Float], width w: Int, height h: Int, threshold: Float, minSteepness: Float, region: PixelRect? = nil) -> PeakingRidges {
        applySupport(candidates(luma: luma, width: w, height: h, threshold: threshold, minSteepness: minSteepness, region: region), region: region)
    }

    public static func ridges(luma: [Float], width w: Int, height h: Int, sensitivity: PeakingSensitivity, region: PixelRect? = nil) -> PeakingRidges {
        guard sensitivity != .off else { return PeakingRidges(width: w, height: h) }
        let p = parameters(luma: luma, width: w, height: h, sensitivity: sensitivity, region: region)
        return ridges(luma: luma, width: w, height: h, threshold: p.threshold, minSteepness: p.minSteepness, region: region)
    }

    /// Sparse-sample the frame (every 7th pixel, inside `region` if given) and derive both cut-offs.
    public static func parameters(luma: [Float], width w: Int, height h: Int, sensitivity: PeakingSensitivity, region: PixelRect? = nil) -> (threshold: Float, minSteepness: Float) {
        guard sensitivity != .off, w > 8, h > 8 else { return (.infinity, .infinity) }
        let r = region ?? PixelRect(x: 0, y: 0, width: w, height: h)
        var sample: [Float] = []
        luma.withUnsafeBufferPointer { l in
            var y = max(r.y, 3)
            while y < min(r.maxY, h - 3) {
                var x = max(r.x, 3)
                while x < min(r.maxX, w - 3) { sample.append(strength(luma: l, x: x, y: y, width: w, height: h)); x += 7 }
                y += 7
            }
        }
        return parameters(fromSampledResponses: sample, sensitivity: sensitivity)
    }

    /// Flag map only (0 / 255), for callers that do not need directions.
    public static func mask(luma: [UInt8], width w: Int, height h: Int, sensitivity: PeakingSensitivity) -> [UInt8] {
        ridges(luma: Self.luma(luma), width: w, height: h, sensitivity: sensitivity).flag
    }

    /// BGRA (premultiplied) image of the ridges, one pixel wide: used by the CPU fallback when Metal is unavailable.
    public static func overlayBGRA(mask: [UInt8], width w: Int, height h: Int, color: PeakingColor, opacity: Float = 0.9) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: w * h * 4)
        let (r, g, b) = color.rgb
        let a = UInt8(min(max(opacity, 0), 1) * 255)
        let af = Float(a) / 255
        for i in 0..<(w * h) where mask[i] != 0 {
            out[i * 4] = UInt8(b * af * 255); out[i * 4 + 1] = UInt8(g * af * 255); out[i * 4 + 2] = UInt8(r * af * 255); out[i * 4 + 3] = a
        }
        return out
    }
}

/// Layout of `struct Params` in the app's Metal source: 96 bytes, field for field. Defined here so a unit test can pin the layout
/// the shader expects (the shader text is compiled and run against this file by `tools/msl-shim`).
public struct PeakingGPUParams: Sendable {
    public var threshold: Float = .infinity
    public var minSteepness: Float = 1
    public var zebraThreshold: Float = 2
    public var peakingOn: Float = 0
    public var zebraOn: Float = 0
    public var stripePhase: Float = 0
    public var showVideo: Float = 0
    public var pad0: Float = 0
    public var peakColor = SIMD4<Float>(1, 0.05, 0.05, 0.92)
    public var roiOrigin = SIMD2<Float>(0, 0)
    public var roiSize = SIMD2<Float>(1, 1)
    public var viewScale: Float = 1
    public var lineHalfWidth: Float = 0.7
    public var segHalfLength: Float = PeakingRenderer.segmentHalfLength
    public var pad1: Float = 0
    public var cOrigin = SIMD2<UInt32>(0, 0)
    public var cSize = SIMD2<UInt32>(0, 0)
    public init() {}
}

/// How the ridges are drawn: as hairline segments at SCREEN resolution. Each ridge pixel becomes a short segment along the
/// edge direction (about 1.2 screen pixels wide, whatever the magnification), so neighbouring ridge pixels join into a
/// fine continuous contour that follows the edge. This is the reference for the Metal fragment shader.
public enum PeakingRenderer {
    /// Segment half length in source pixels (a little over half a pixel so diagonal ridge pixels still join).
    public static let segmentHalfLength: Float = 0.75

    /// Line half width in screen pixels, thinner as the view gets more magnified (`viewScale` = screen px per source px).
    public static func lineHalfWidth(viewScale: Float) -> Float {
        0.65 + 0.25 * min(max(1 - (viewScale - 1) / 3, 0), 1)
    }

    @inline(__always) static func smoothstep(_ e0: Float, _ e1: Float, _ x: Float) -> Float {
        let t = min(max((x - e0) / (e1 - e0), 0), 1); return t * t * (3 - 2 * t)
    }

    /// Hairline coverage 0…1 at a point given in source-pixel coordinates (pixel k covers [k, k+1)).
    public static func coverage(_ r: PeakingRidges, x tx: Float, y ty: Float, viewScale: Float) -> Float {
        let halfWidth = lineHalfWidth(viewScale: viewScale)
        let cx = Int(floorf(tx)), cy = Int(floorf(ty))
        var cover: Float = 0
        for dy in -1...1 { for dx in -1...1 {
            let px = cx + dx, py = cy + dy
            if px < 0 || py < 0 || px >= r.width || py >= r.height { continue }
            let i = py * r.width + px
            if r.flag[i] == 0 { continue }
            let a = Float(r.angle[i]) / 255 * Float.pi
            let dirx = cosf(a), diry = sinf(a)
            let ddx = tx - (Float(px) + 0.5), ddy = ty - (Float(py) + 0.5)
            let t = min(max(ddx * dirx + ddy * diry, -segmentHalfLength), segmentHalfLength)
            let perpx = ddx - dirx * t, perpy = ddy - diry * t
            let dist = sqrtf(perpx * perpx + perpy * perpy) * viewScale
            cover = max(cover, 1 - smoothstep(halfWidth - 0.5, halfWidth + 0.5, dist))
        }}
        return cover
    }

    /// Renders the part of the image `region` (source pixels) into an `outWidth × outHeight` coverage image.
    public static func render(_ r: PeakingRidges, region: (x: Float, y: Float, width: Float, height: Float), outWidth: Int, outHeight: Int) -> [Float] {
        let viewScale = Float(outWidth) / region.width
        var out = [Float](repeating: 0, count: outWidth * outHeight)
        for oy in 0..<outHeight { for ox in 0..<outWidth {
            let tx = region.x + (Float(ox) + 0.5) / Float(outWidth) * region.width
            let ty = region.y + (Float(oy) + 0.5) / Float(outHeight) * region.height
            out[oy * outWidth + ox] = coverage(r, x: tx, y: ty, viewScale: viewScale)
        }}
        return out
    }
}

public enum ZebraLevel: String, Codable, Sendable, CaseIterable {
    case off, p95, p98, p100
    public var title: String { switch self { case .off: return "Off"; case .p95: return "95%"; case .p98: return "98%"; case .p100: return "100%" } }
    /// Minimum channel value (0…255) that triggers the stripes. 100 % means clipped (254–255 after rounding).
    public var threshold: UInt8? {
        switch self { case .off: return nil; case .p95: return 242; case .p98: return 250; case .p100: return 254 }
    }
}

public enum Zebra {
    /// BGRA input; a pixel is flagged when its brightest channel reaches the threshold, so a clipped red channel on a
    /// saturated reflection is caught even if luma is below white.
    public static func mask(bgra: [UInt8], width w: Int, height h: Int, level: ZebraLevel) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: w * h)
        guard let t = level.threshold else { return out }
        for i in 0..<(w * h) {
            let b = bgra[i * 4], g = bgra[i * 4 + 1], r = bgra[i * 4 + 2]
            if max(r, g, b) >= t { out[i] = 255 }
        }
        return out
    }

    /// Diagonal stripe pattern used by the renderer so zebras are distinguishable from real highlights.
    @inline(__always) public static func stripe(x: Int, y: Int, period: Int = 10) -> Bool { ((x + y) / (period / 2)) % 2 == 0 }
}

public enum HistogramMode: String, Codable, Sendable, CaseIterable {
    case off, luma, rgb
    public var title: String { switch self { case .off: return "Off"; case .luma: return "Luma"; case .rgb: return "RGB" } }
}

public struct HistogramData: Sendable, Equatable {
    public var luma = [Int](repeating: 0, count: 256)
    public var red = [Int](repeating: 0, count: 256)
    public var green = [Int](repeating: 0, count: 256)
    public var blue = [Int](repeating: 0, count: 256)
    public var sampleCount = 0
    public var clippedHighlightFraction: Float = 0     // any channel ≥ 254
    public var crushedShadowFraction: Float = 0        // luma ≤ 2
    public init() {}

    /// Normalised bin heights (0…1) with the tallest bin = 1; a log option keeps tonal tails visible.
    public func normalized(_ bins: [Int], logScale: Bool) -> [Float] {
        let f: [Float] = bins.map { logScale ? log1pf(Float($0)) : Float($0) }
        let m = max(f.max() ?? 1, 1e-6)
        return f.map { $0 / m }
    }
}

public enum HistogramRenderer {
    /// Samples a BGRA buffer on a stride so the cost stays tiny (a ~100×100 sample is plenty for a compact display).
    public static func compute(bgra: UnsafeBufferPointer<UInt8>, width w: Int, height h: Int, bytesPerRow: Int, targetSamples: Int = 20_000) -> HistogramData {
        var d = HistogramData()
        guard w > 0, h > 0 else { return d }
        let step = max(1, Int(sqrt(Double(w * h) / Double(targetSamples))))
        var clipped = 0, crushed = 0
        var y = 0
        while y < h {
            var x = 0
            while x < w {
                let i = y * bytesPerRow + x * 4
                let b = Int(bgra[i]), g = Int(bgra[i + 1]), r = Int(bgra[i + 2])
                let l = (r * 54 + g * 183 + b * 19) >> 8       // Rec.709-ish integer luma
                d.luma[l] += 1; d.red[r] += 1; d.green[g] += 1; d.blue[b] += 1
                if max(r, g, b) >= 254 { clipped += 1 }
                if l <= 2 { crushed += 1 }
                d.sampleCount += 1
                x += step
            }
            y += step
        }
        if d.sampleCount > 0 {
            d.clippedHighlightFraction = Float(clipped) / Float(d.sampleCount)
            d.crushedShadowFraction = Float(crushed) / Float(d.sampleCount)
        }
        return d
    }
}
