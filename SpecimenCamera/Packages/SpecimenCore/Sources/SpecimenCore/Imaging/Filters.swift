import Foundation

/// Serial, deterministic filters. Parallelism is applied at the tile / frame level by the pipelines,
/// never inside a filter, so tile workers never oversubscribe the CPU.
public enum Filters {

    // MARK: Kernels

    public static func gaussianKernel(sigma: Float) -> [Float] {
        let s = max(sigma, 0.05)
        let radius = max(1, Int(ceil(3.0 * s)))
        var k = [Float](repeating: 0, count: 2 * radius + 1)
        var sum: Float = 0
        for i in -radius...radius {
            let v = expf(-Float(i * i) / (2 * s * s))
            k[i + radius] = v; sum += v
        }
        for i in 0..<k.count { k[i] /= sum }
        return k
    }

    // MARK: Separable convolution (edge replicate)

    public static func convolveSeparable(_ p: Plane, kernel: [Float]) -> Plane {
        let w = p.width, h = p.height
        guard w > 0, h > 0 else { return p }
        let r = kernel.count / 2
        var tmp = Plane(width: w, height: h)
        var out = Plane(width: w, height: h)
        var row = [Float](repeating: 0, count: w + 2 * r)
        p.pixels.withUnsafeBufferPointer { src in
            tmp.pixels.withUnsafeMutableBufferPointer { dst in
                kernel.withUnsafeBufferPointer { k in
                    row.withUnsafeMutableBufferPointer { rb in
                        for y in 0..<h {
                            let base = y * w
                            for i in 0..<r { rb[i] = src[base] }
                            for x in 0..<w { rb[r + x] = src[base + x] }
                            for i in 0..<r { rb[r + w + i] = src[base + w - 1] }
                            for x in 0..<w {
                                var acc: Float = 0
                                for i in 0..<k.count { acc += k[i] * rb[x + i] }
                                dst[base + x] = acc
                            }
                        }
                    }
                }
            }
        }
        tmp.pixels.withUnsafeBufferPointer { src in
            out.pixels.withUnsafeMutableBufferPointer { dst in
                kernel.withUnsafeBufferPointer { k in
                    for y in 0..<h {
                        let ob = y * w
                        for x in 0..<w { dst[ob + x] = 0 }
                        for i in 0..<k.count {
                            let sy = min(max(y + i - r, 0), h - 1)
                            let sb = sy * w
                            let kv = k[i]
                            for x in 0..<w { dst[ob + x] += kv * src[sb + x] }
                        }
                    }
                }
            }
        }
        return out
    }

    public static func gaussianBlur(_ p: Plane, sigma: Float) -> Plane {
        if sigma <= 0.01 { return p }
        return convolveSeparable(p, kernel: gaussianKernel(sigma: sigma))
    }

    /// Mean over a (2r+1)² window, edges replicated. O(1) per pixel via running sums.
    public static func boxBlur(_ p: Plane, radius r: Int) -> Plane {
        if r <= 0 { return p }
        let w = p.width, h = p.height
        guard w > 0, h > 0 else { return p }
        var tmp = Plane(width: w, height: h)
        var out = Plane(width: w, height: h)
        let inv = 1 / Float(2 * r + 1)
        p.pixels.withUnsafeBufferPointer { src in
            tmp.pixels.withUnsafeMutableBufferPointer { dst in
                for y in 0..<h {
                    let base = y * w
                    var acc: Float = 0
                    for i in -r...r { acc += src[base + min(max(i, 0), w - 1)] }
                    for x in 0..<w {
                        dst[base + x] = acc * inv
                        let add = src[base + min(x + r + 1, w - 1)]
                        let sub = src[base + max(x - r, 0)]
                        acc += add - sub
                    }
                }
            }
        }
        var col = [Float](repeating: 0, count: w)
        tmp.pixels.withUnsafeBufferPointer { src in
            out.pixels.withUnsafeMutableBufferPointer { dst in
                col.withUnsafeMutableBufferPointer { c in
                    for i in -r...r {
                        let sb = min(max(i, 0), h - 1) * w
                        for x in 0..<w { c[x] += src[sb + x] }
                    }
                    for y in 0..<h {
                        let ob = y * w
                        for x in 0..<w { dst[ob + x] = c[x] * inv }
                        let addB = min(y + r + 1, h - 1) * w
                        let subB = max(y - r, 0) * w
                        for x in 0..<w { c[x] += src[addB + x] - src[subB + x] }
                    }
                }
            }
        }
        return out
    }

    // MARK: Pyramid primitives (Burt–Adelson 5-tap)

    private static let reduceKernel: [Float] = [1, 4, 6, 4, 1].map { $0 / 16 }

    public static func reduce(_ p: Plane) -> Plane {
        let blurred = convolveSeparable(p, kernel: reduceKernel)
        let w = (p.width + 1) / 2, h = (p.height + 1) / 2
        var out = Plane(width: w, height: h)
        for y in 0..<h {
            for x in 0..<w { out[x, y] = blurred[min(2 * x, p.width - 1), min(2 * y, p.height - 1)] }
        }
        return out
    }

    /// Burt–Adelson EXPAND to an exact target size (target is 2·size or 2·size−1).
    public static func expand(_ p: Plane, toWidth tw: Int, toHeight th: Int) -> Plane {
        let w = p.width, h = p.height
        var horiz = Plane(width: tw, height: h)
        for y in 0..<h {
            for x in 0..<tw {
                let k = x >> 1
                let v: Float
                if x & 1 == 0 {
                    v = (p.clamped(k - 1, y) + 6 * p.clamped(k, y) + p.clamped(k + 1, y)) * 0.125
                } else {
                    v = (p.clamped(k, y) + p.clamped(k + 1, y)) * 0.5
                }
                horiz[x, y] = v
            }
        }
        var out = Plane(width: tw, height: th)
        for y in 0..<th {
            let k = y >> 1
            for x in 0..<tw {
                let v: Float
                if y & 1 == 0 {
                    v = (horiz.clamped(x, k - 1) + 6 * horiz.clamped(x, k) + horiz.clamped(x, k + 1)) * 0.125
                } else {
                    v = (horiz.clamped(x, k) + horiz.clamped(x, k + 1)) * 0.5
                }
                out[x, y] = v
            }
        }
        _ = w
        return out
    }

    // MARK: Resampling

    /// Area-average downscale by an integer factor (pixel-centre aligned). Partial edge blocks average what exists.
    public static func boxDownscale(_ p: Plane, factor f: Int) -> Plane {
        if f <= 1 { return p }
        let w = (p.width + f - 1) / f, h = (p.height + f - 1) / f
        var out = Plane(width: w, height: h)
        p.pixels.withUnsafeBufferPointer { src in
            out.pixels.withUnsafeMutableBufferPointer { dst in
                for y in 0..<h {
                    let y0 = y * f, y1 = min(y0 + f, p.height)
                    for x in 0..<w {
                        let x0 = x * f, x1 = min(x0 + f, p.width)
                        var s: Float = 0
                        for yy in y0..<y1 { for xx in x0..<x1 { s += src[yy * p.width + xx] } }
                        dst[y * w + x] = s / Float((y1 - y0) * (x1 - x0))
                    }
                }
            }
        }
        return out
    }

    public static func resizeBilinear(_ p: Plane, toWidth tw: Int, toHeight th: Int) -> Plane {
        if tw == p.width && th == p.height { return p }
        var out = Plane(width: tw, height: th)
        let sx = Float(p.width) / Float(tw), sy = Float(p.height) / Float(th)
        for y in 0..<th {
            let fy = (Float(y) + 0.5) * sy - 0.5
            let y0 = Int(floorf(fy)); let ty = fy - Float(y0)
            for x in 0..<tw {
                let fx = (Float(x) + 0.5) * sx - 0.5
                let x0 = Int(floorf(fx)); let tx = fx - Float(x0)
                let a = p.clamped(x0, y0), b = p.clamped(x0 + 1, y0)
                let c = p.clamped(x0, y0 + 1), d = p.clamped(x0 + 1, y0 + 1)
                out[x, y] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty
            }
        }
        return out
    }

    // MARK: Pointwise helpers

    public static func combine(_ a: Plane, _ b: Plane, _ f: (Float, Float) -> Float) -> Plane {
        precondition(a.width == b.width && a.height == b.height)
        var out = a
        for i in 0..<a.pixels.count { out.pixels[i] = f(a.pixels[i], b.pixels[i]) }
        return out
    }

    public static func subtract(_ a: Plane, _ b: Plane) -> Plane { combine(a, b) { $0 - $1 } }

    // MARK: Guided filter (He, Sun, Tang) with a single-channel guide

    public static func guidedFilter(guide I: Plane, input p: Plane, radius: Int, epsilon: Float) -> Plane {
        let meanI = boxBlur(I, radius: radius)
        let meanP = boxBlur(p, radius: radius)
        let corrI = boxBlur(combine(I, I) { $0 * $1 }, radius: radius)
        let corrIP = boxBlur(combine(I, p) { $0 * $1 }, radius: radius)
        var a = Plane(width: I.width, height: I.height)
        var b = a
        for i in 0..<I.pixels.count {
            let varI = corrI.pixels[i] - meanI.pixels[i] * meanI.pixels[i]
            let covIP = corrIP.pixels[i] - meanI.pixels[i] * meanP.pixels[i]
            let ai = covIP / (varI + epsilon)
            a.pixels[i] = ai
            b.pixels[i] = meanP.pixels[i] - ai * meanI.pixels[i]
        }
        let ma = boxBlur(a, radius: radius), mb = boxBlur(b, radius: radius)
        var out = Plane(width: I.width, height: I.height)
        for i in 0..<I.pixels.count { out.pixels[i] = ma.pixels[i] * I.pixels[i] + mb.pixels[i] }
        return out
    }

    // MARK: Gradients

    /// Central-difference gradient magnitude (edge replicate).
    public static func gradientMagnitude(_ p: Plane) -> Plane {
        var out = Plane(width: p.width, height: p.height)
        for y in 0..<p.height {
            for x in 0..<p.width {
                let gx = (p.clamped(x + 1, y) - p.clamped(x - 1, y)) * 0.5
                let gy = (p.clamped(x, y + 1) - p.clamped(x, y - 1)) * 0.5
                out[x, y] = sqrtf(gx * gx + gy * gy)
            }
        }
        return out
    }

    // MARK: Morphology (square structuring element via separable min/max)

    public static func dilate(_ p: Plane, radius r: Int) -> Plane { morph(p, radius: r, useMax: true) }
    public static func erode(_ p: Plane, radius r: Int) -> Plane { morph(p, radius: r, useMax: false) }

    private static func morph(_ p: Plane, radius r: Int, useMax: Bool) -> Plane {
        if r <= 0 { return p }
        let w = p.width, h = p.height
        var tmp = Plane(width: w, height: h)
        var out = Plane(width: w, height: h)
        for y in 0..<h {
            for x in 0..<w {
                var v = p[x, y]
                for i in max(0, x - r)...min(w - 1, x + r) {
                    let q = p[i, y]
                    v = useMax ? max(v, q) : min(v, q)
                }
                tmp[x, y] = v
            }
        }
        for y in 0..<h {
            for x in 0..<w {
                var v = tmp[x, y]
                for j in max(0, y - r)...min(h - 1, y + r) {
                    let q = tmp[x, j]
                    v = useMax ? max(v, q) : min(v, q)
                }
                out[x, y] = v
            }
        }
        return out
    }
}
