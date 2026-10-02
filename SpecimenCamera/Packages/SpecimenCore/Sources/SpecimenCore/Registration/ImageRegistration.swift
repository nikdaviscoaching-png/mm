import Foundation

public struct RegistrationOptions: Sendable {
    /// Longest side budget for the proxy used for estimation (full-res transform is derived from it).
    public var maxProxyPixels: Int = 1_800_000
    public var minLevelSize: Int = 40
    public var iterationsPerLevel: Int = 25
    /// Estimate rotation and scale as well as translation (focus breathing needs scale).
    public var estimateRotationScale: Bool = true
    /// Below this correlation the estimate is rejected (identity returned and `failed` flagged).
    public var minConfidence: Double = 0.25
    /// A start from "no shift" is accepted without trying another when its confidence reaches this.
    public var acceptConfidence: Double = 0.6
    /// The coarse shift search must beat "no shift" by this much correlation before it replaces the zero start.
    public var shiftSearchMargin: Double = 0.05
    public init() {}
}

public struct FrameAlignment: Sendable, Equatable, Codable {
    /// Reference → frame transform at full resolution.
    public var transform: Affine2D
    /// Weighted zero-mean correlation of the aligned normalised images, 0…1.
    public var confidence: Double
    public var failed: Bool
    public init(transform: Affine2D, confidence: Double, failed: Bool) {
        self.transform = transform; self.confidence = confidence; self.failed = failed
    }
    public static let identity = FrameAlignment(transform: .identity, confidence: 1, failed: false)
}

/// Robust, illumination-tolerant registration of two grayscale planes with a similarity model
/// (translation, rotation, uniform scale), coarse-to-fine Gauss-Newton with Cauchy re-weighting.
///
/// Why this and not feature matching: focus-stack frames differ in *which* details are sharp, and
/// lighting-stack frames differ in highlights/shading; both defeat feature descriptors on glossy, banded
/// stones, whereas locally contrast-normalised structure plus robust weighting copes with both.
public enum ImageRegistration {

    /// Local contrast normalisation: (I − mean) / (local std + ε). Removes illumination gradients and gain,
    /// keeps the structure (band edges, crystal borders) that must line up.
    public static func normalize(_ luma: Plane, sigma: Float = 6) -> Plane {
        let mean = Filters.gaussianBlur(luma, sigma: sigma)
        var dev = Filters.subtract(luma, mean)
        let sq = Filters.gaussianBlur(dev.mapped { $0 * $0 }, sigma: sigma)
        for i in 0..<dev.count { dev.pixels[i] = dev.pixels[i] / (sqrtf(sq.pixels[i]) + 0.02) }
        return dev.mapped { max(-3, min(3, $0)) }
    }

    struct Params { var tx = 0.0, ty = 0.0, theta = 0.0, s = 0.0 }

    static func transform(_ p: Params, width: Int, height: Int) -> Affine2D {
        Affine2D.similarity(scale: 1 + p.s, rotation: p.theta, translation: (p.tx, p.ty),
                            center: (Double(width - 1) / 2, Double(height - 1) / 2))
    }

    @inline(__always)
    static func bilinear(_ pl: UnsafeBufferPointer<Float>, _ w: Int, _ h: Int, _ x: Float, _ y: Float) -> Float {
        let x0 = Int(floorf(x)), y0 = Int(floorf(y))
        let fx = x - Float(x0), fy = y - Float(y0)
        let x1 = x0 + 1, y1 = y0 + 1
        let a = pl[y0 * w + x0], b = pl[y0 * w + x1], c = pl[y1 * w + x0], d = pl[y1 * w + x1]
        return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy
    }

    /// Estimates the transform (reference → frame, in the planes' own pixel coordinates) and its confidence.
    public static func estimate(reference ref: Plane, frame: Plane, options: RegistrationOptions = .init()) -> (transform: Affine2D, confidence: Double) {
        precondition(ref.width == frame.width && ref.height == frame.height)
        var levelsRef = [ref], levelsFrm = [frame]
        while let l = levelsRef.last, min(l.width, l.height) / 2 >= options.minLevelSize {
            levelsRef.append(Filters.reduce(Filters.gaussianBlur(l, sigma: 0.5)))
            levelsFrm.append(Filters.reduce(Filters.gaussianBlur(levelsFrm[levelsFrm.count - 1], sigma: 0.5)))
        }
        // Gauss-Newton only converges from a nearby start. A hand-held phone moves several percent of the frame between shots,
        // so first look for the best overall shift on the coarsest image (cheap) and start from it when it is clearly better
        // than "no shift". A tripod stack finds its best shift at zero and starts there exactly as before.
        let top = levelsRef.count - 1
        let search = coarseShiftSearch(reference: levelsRef[top], frame: levelsFrm[top])
        var starts = [Params()]
        if (abs(search.dx) > 1 || abs(search.dy) > 1), search.best > search.atZero + options.shiftSearchMargin {
            starts = [Params(tx: Double(search.dx), ty: Double(search.dy)), Params()]       // the found shift first, zero as a fallback
        }
        var best: (p: Params, conf: Double)? = nil
        for start in starts {
            let r = descend(levelsRef, levelsFrm, start: start, options: options)
            if best == nil || r.conf > best!.conf { best = r }
            if r.conf >= options.acceptConfidence { break }
        }
        let w = ref.width, h = ref.height
        return (transform(best!.p, width: w, height: h), best!.conf)
    }

    static func descend(_ levelsRef: [Plane], _ levelsFrm: [Plane], start: Params, options: RegistrationOptions) -> (p: Params, conf: Double) {
        var p = start
        var confidence = 0.0
        for lv in stride(from: levelsRef.count - 1, through: 0, by: -1) {
            let T = levelsRef[lv], I = levelsFrm[lv]
            if lv < levelsRef.count - 1 { p.tx *= 2; p.ty *= 2 }     // pyramid reduce keeps centres aligned
            let (q, conf) = refine(T: T, I: I, start: p, options: options, finest: lv == 0)
            p = q; confidence = conf
        }
        return (p, confidence)
    }

    /// Integer-pixel normalised cross-correlation over a window of shifts on the coarsest pyramid level. `dx, dy` is the
    /// displacement such that frame(x + dx, y + dy) ≈ reference(x, y), the convention of `Params.tx/ty`.
    static func coarseShiftSearch(reference T: Plane, frame I: Plane) -> (dx: Int, dy: Int, best: Double, atZero: Double) {
        let w = T.width, h = T.height
        let radius = max(4, Int(Double(min(w, h)) * 0.35))
        var best = -2.0, bdx = 0, bdy = 0, zero = 0.0
        T.pixels.withUnsafeBufferPointer { tp in
        I.pixels.withUnsafeBufferPointer { ip in
            for dy in -radius...radius {
                for dx in -radius...radius {
                    let x0 = max(0, -dx), x1 = min(w, w - dx), y0 = max(0, -dy), y1 = min(h, h - dy)
                    let n = (x1 - x0) * (y1 - y0)
                    if n < (w * h) / 3 { continue }                 // keep at least a third of the picture overlapping
                    var st = 0.0, si = 0.0, stt = 0.0, sii = 0.0, sti = 0.0
                    for y in y0..<y1 {
                        let trow = y * w, irow = (y + dy) * w + dx
                        for x in x0..<x1 {
                            let a = Double(tp[trow + x]), b = Double(ip[irow + x])
                            st += a; si += b; stt += a * a; sii += b * b; sti += a * b
                        }
                    }
                    let nn = Double(n)
                    let vt = stt / nn - (st / nn) * (st / nn), vi = sii / nn - (si / nn) * (si / nn)
                    let c = (sti / nn - (st / nn) * (si / nn)) / sqrt(max(vt, 1e-12) * max(vi, 1e-12))
                    if dx == 0 && dy == 0 { zero = c }
                    if c > best { best = c; bdx = dx; bdy = dy }
                }
            }
        }}
        return (bdx, bdy, best, zero)
    }

    static func refine(T: Plane, I: Plane, start: Params, options: RegistrationOptions, finest: Bool) -> (Params, Double) {
        let w = T.width, h = T.height
        var p = start
        // gradient planes of the moving image
        var gx = Plane(width: w, height: h), gy = Plane(width: w, height: h)
        for y in 0..<h { for x in 0..<w {
            gx[x, y] = (I.clamped(x + 1, y) - I.clamped(x - 1, y)) * 0.5
            gy[x, y] = (I.clamped(x, y + 1) - I.clamped(x, y - 1)) * 0.5
        }}
        let cx = Double(w - 1) / 2, cy = Double(h - 1) / 2
        let nParams = options.estimateRotationScale ? 4 : 2
        var lastConf = 0.0
        for iter in 0..<options.iterationsPerLevel {
            var H = [Double](repeating: 0, count: 16), g = [Double](repeating: 0, count: 4)
            let cs = cos(p.theta), sn = sin(p.theta), sc = 1 + p.s
            // first pass: residual scale for robust weights
            var residuals: [Float] = []
            residuals.reserveCapacity(w * h / 4)
            var sumT = 0.0, sumI = 0.0, sumTT = 0.0, sumII = 0.0, sumTI = 0.0, sumW = 0.0
            I.pixels.withUnsafeBufferPointer { ip in
            gx.pixels.withUnsafeBufferPointer { gxp in
            gy.pixels.withUnsafeBufferPointer { gyp in
            T.pixels.withUnsafeBufferPointer { tp in
                // pass A — residual distribution
                var step = 1
                if w * h > 200_000 { step = 2 }
                for y in stride(from: 0, to: h, by: step) { for x in stride(from: 0, to: w, by: step) {
                    let dx = Double(x) - cx, dy = Double(y) - cy
                    let sx = cx + sc * (cs * dx - sn * dy) + p.tx, sy = cy + sc * (sn * dx + cs * dy) + p.ty
                    if sx < 1 || sy < 1 || sx > Double(w - 2) || sy > Double(h - 2) { continue }
                    residuals.append(abs(tp[y * w + x] - bilinear(ip, w, h, Float(sx), Float(sy))))
                }}
                residuals.sort()
                let mad = residuals.isEmpty ? 1 : residuals[residuals.count / 2]
                let scale = Double(max(mad * 1.4826, 0.05)) * 2.0
                // pass B — normal equations
                for y in 0..<h { for x in 0..<w {
                    let dx = Double(x) - cx, dy = Double(y) - cy
                    let rx = cs * dx - sn * dy, ry = sn * dx + cs * dy
                    let sx = cx + sc * rx + p.tx, sy = cy + sc * ry + p.ty
                    if sx < 1 || sy < 1 || sx > Double(w - 2) || sy > Double(h - 2) { continue }
                    let tv = Double(tp[y * w + x])
                    let iv = Double(bilinear(ip, w, h, Float(sx), Float(sy)))
                    let e = tv - iv
                    let wgt = 1 / (1 + (e / scale) * (e / scale))
                    let ix = Double(bilinear(gxp, w, h, Float(sx), Float(sy))), iy = Double(bilinear(gyp, w, h, Float(sx), Float(sy)))
                    // ∂W/∂θ = sc·(−ry, rx);  ∂W/∂s = (rx, ry)
                    let jt = ix * (-sc * ry) + iy * (sc * rx)
                    let js = ix * rx + iy * ry
                    let j = [ix, iy, jt, js]
                    for a in 0..<nParams {
                        g[a] += wgt * j[a] * e
                        for b in 0..<nParams { H[a * 4 + b] += wgt * j[a] * j[b] }
                    }
                    sumW += wgt; sumT += wgt * tv; sumI += wgt * iv
                    sumTT += wgt * tv * tv; sumII += wgt * iv * iv; sumTI += wgt * tv * iv
                }}
            }}}}
            if sumW > 0 {
                let mt = sumT / sumW, mi = sumI / sumW
                let vt = sumTT / sumW - mt * mt, vi = sumII / sumW - mi * mi, cv = sumTI / sumW - mt * mi
                lastConf = max(0, cv / (sqrt(max(vt, 1e-12) * max(vi, 1e-12))))
            }
            // Levenberg–Marquardt-style damped solve
            var A = [Double](repeating: 0, count: 16)
            for a in 0..<nParams { for b in 0..<nParams { A[a * 4 + b] = H[a * 4 + b] } }
            for a in 0..<nParams { A[a * 4 + a] += 1e-3 * max(H[a * 4 + a], 1e-6) + 1e-9 }
            guard let d = solve(A, g, n: nParams) else { break }
            // translation in px, θ in rad (scaled to px at image radius), s dimensionless
            p.tx += d[0]; p.ty += d[1]
            if options.estimateRotationScale { p.theta += d[2]; p.s += d[3] }
            let radius = Double(max(w, h)) / 2
            let move = max(abs(d[0]), abs(d[1]), abs(d[2]) * radius, abs(d[3]) * radius)
            if move < (finest ? 0.002 : 0.01) && iter > 1 { break }
        }
        return (p, lastConf)
    }

    /// Gaussian elimination with partial pivoting for the n×n (n ≤ 4) system stored with stride 4.
    static func solve(_ A: [Double], _ b: [Double], n: Int) -> [Double]? {
        var m = A, r = b
        for col in 0..<n {
            var piv = col
            for row in (col + 1)..<max(col + 1, n) where abs(m[row * 4 + col]) > abs(m[piv * 4 + col]) { piv = row }
            if abs(m[piv * 4 + col]) < 1e-14 { return nil }
            if piv != col {
                for k in 0..<n { m.swapAt(col * 4 + k, piv * 4 + k) }
                r.swapAt(col, piv)
            }
            for row in (col + 1)..<max(col + 1, n) {
                let f = m[row * 4 + col] / m[col * 4 + col]
                for k in col..<n { m[row * 4 + k] -= f * m[col * 4 + k] }
                r[row] -= f * r[col]
            }
        }
        var x = [Double](repeating: 0, count: 4)
        for row in stride(from: n - 1, through: 0, by: -1) {
            var s = r[row]
            for k in (row + 1)..<max(row + 1, n) { s -= m[row * 4 + k] * x[k] }
            x[row] = s / m[row * 4 + row]
        }
        return x
    }
}

/// Aligns a whole series, chaining neighbours outward from a central reference (adjacent frames look the
/// most alike in both focus and lighting stacks, which keeps each pairwise estimate well conditioned).
public enum ImageRegistrationEngine {

    public static func proxyFactor(width: Int, height: Int, maxPixels: Int) -> Int {
        max(1, Int(ceil(sqrt(Double(width * height) / Double(maxPixels)))))
    }

    public static func align(frames: [any FrameSource], referenceIndex: Int? = nil, options: RegistrationOptions = .init(),
                             luma: LumaCoefficients? = nil,
                             progress: (@Sendable (Int, Int) -> Void)? = nil,
                             isCancelled: @Sendable () -> Bool = { false }) throws -> [FrameAlignment] {
        guard let first = frames.first else { return [] }
        let refIdx = referenceIndex ?? frames.count / 2
        let f = proxyFactor(width: first.width, height: first.height, maxPixels: options.maxProxyPixels)
        let k = luma ?? first.colorSpace.luma
        var proxies: [Plane] = []
        for (i, fr) in frames.enumerated() {
            if isCancelled() { throw SpecimenError.cancelled }
            guard fr.width == first.width, fr.height == first.height else {
                throw SpecimenError.dimensionMismatch("frame \(i) is \(fr.width)×\(fr.height), expected \(first.width)×\(first.height)")
            }
            let small = try fr.readDownscaled(factor: f)
            proxies.append(ImageRegistration.normalize(small.luma(k)))
        }
        var out = [FrameAlignment](repeating: .identity, count: frames.count)
        var done = 0
        func pair(from a: Int, to b: Int) -> FrameAlignment {
            // transform mapping coordinates of frame a to coordinates of frame b
            let est = ImageRegistration.estimate(reference: proxies[a], frame: proxies[b], options: options)
            let ok = est.confidence >= options.minConfidence
            return FrameAlignment(transform: ok ? est.transform.scaledUp(by: Double(f)) : .identity, confidence: est.confidence, failed: !ok)
        }
        if refIdx + 1 < frames.count {
            for i in (refIdx + 1)..<frames.count {
                if isCancelled() { throw SpecimenError.cancelled }
                let e = pair(from: i - 1, to: i)
                out[i] = FrameAlignment(transform: e.transform.concatenating(out[i - 1].transform),
                                        confidence: min(e.confidence, out[i - 1].confidence), failed: e.failed || out[i - 1].failed)
                done += 1; progress?(done, frames.count - 1)
            }
        }
        if refIdx > 0 {
            for i in stride(from: refIdx - 1, through: 0, by: -1) {
                if isCancelled() { throw SpecimenError.cancelled }
                let e = pair(from: i + 1, to: i)
                out[i] = FrameAlignment(transform: e.transform.concatenating(out[i + 1].transform),
                                        confidence: min(e.confidence, out[i + 1].confidence), failed: e.failed || out[i + 1].failed)
                done += 1; progress?(done, frames.count - 1)
            }
        }
        return out
    }

    /// Wraps each frame so that reading it yields reference-aligned pixels (no copies are stored).
    public static func aligned(_ frames: [any FrameSource], _ alignments: [FrameAlignment]) -> [any FrameSource] {
        zip(frames, alignments).map { WarpedFrame(base: $0, transform: $1.transform) as any FrameSource }
    }
}
