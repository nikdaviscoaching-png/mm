import Foundation

/// Affine map from reference pixel coordinates to candidate pixel coordinates (index convention: pixel i has its centre at i).
///   u = a·x + b·y + c      v = d·x + e·y + f
public struct AffineWarp: Sendable, Equatable {
    public var a: Float = 1, b: Float = 0, c: Float = 0, d: Float = 0, e: Float = 1, f: Float = 0
    public init() {}
    public init(a: Float, b: Float, c: Float, d: Float, e: Float, f: Float) { self.a = a; self.b = b; self.c = c; self.d = d; self.e = e; self.f = f }
    public static let identity = AffineWarp()
    @inline(__always) public func apply(_ x: Float, _ y: Float) -> (Float, Float) { (a * x + b * y + c, d * x + e * y + f) }
    /// The same map expressed one pyramid level finer: p' = 2p + 0.5 (pixel centres).
    func finer() -> AffineWarp {
        AffineWarp(a: a, b: b, c: 2 * c + 0.5 - 0.5 * (a + b), d: d, e: e, f: 2 * f + 0.5 - 0.5 * (d + e))
    }
}

/// Local residual motion after the global affine: a coarse grid of displacement vectors in FULL-resolution pixels.
public struct FlowField: Sendable {
    public let step: Float
    public let origin: Float
    public let cols: Int
    public let rows: Int
    public var dx: [Float]
    public var dy: [Float]
    public func sample(_ x: Float, _ y: Float) -> (Float, Float) {
        let gx = min(max((x - origin) / step, 0), Float(cols - 1)), gy = min(max((y - origin) / step, 0), Float(rows - 1))
        let x0 = Int(gx), y0 = Int(gy), x1 = min(x0 + 1, cols - 1), y1 = min(y0 + 1, rows - 1)
        let tx = gx - Float(x0), ty = gy - Float(y0)
        @inline(__always) func s(_ a: [Float]) -> Float {
            (a[y0 * cols + x0] * (1 - tx) + a[y0 * cols + x1] * tx) * (1 - ty) + (a[y1 * cols + x0] * (1 - tx) + a[y1 * cols + x1] * tx) * ty
        }
        return (s(dx), s(dy))
    }
}

public struct SRFrameAlignment: Sendable {
    public var affine: AffineWarp
    public var flow: FlowField?
    /// Normalised post-alignment luminance error relative to noise (≈1 for a perfect match).
    public var residual: Float
    public var isUsable: Bool
    @inline(__always) public func map(_ x: Float, _ y: Float) -> (Float, Float) {
        let (u, v) = affine.apply(x, y)
        guard let f = flow else { return (u, v) }
        let (dx, dy) = f.sample(x, y)
        return (u + dx, v + dy)
    }
    public static let identity = SRFrameAlignment(affine: .identity, flow: nil, residual: 0, isUsable: true)
}

enum SRRegistration {
    /// Aligns `cand` to `ref`. Returns the alignment in FULL-resolution coordinates.
    static func align(ref: SRPyramid, cand: SRPyramid, noise: Float) -> SRFrameAlignment {
        let top = ref.levels.count - 1
        // 1. coarse integer translation search at the coarsest level
        var A = coarseSearch(ref.levels[top], cand.levels[top], radius: 6)
        // 2. robust affine Gauss-Newton, coarse to fine
        var level = top
        while true {
            let iters = level == 0 ? 4 : 8
            A = refineAffine(ref.levels[level], cand.levels[level], A, iterations: iters, noise: noise)
            if level == 0 { break }
            A = A.finer(); level -= 1
        }
        // level 0 is half resolution → full-resolution coordinates
        let full = A.finer()
        let det = full.a * full.e - full.b * full.d
        let sane = det > 0.9 && det < 1.1 && abs(full.b) < 0.05 && abs(full.d) < 0.05 && full.c.isFinite && full.f.isFinite
        guard sane else { return SRFrameAlignment(affine: full, flow: nil, residual: 99, isUsable: false) }
        // 3. local residual flow at level 0 (half resolution), lifted to full-resolution geometry
        let flow = localFlow(ref.levels[0], cand.levels[0], A, noise: noise)
        let res = residual(ref.levels[0], cand.levels[0], A, flow, noise: noise)
        var fl: FlowField?
        if let flow {
            let scale: Float = 2     // level 0 → full resolution
            fl = FlowField(step: flow.step * scale, origin: flow.origin * scale + (scale - 1) / 2, cols: flow.cols, rows: flow.rows,
                           dx: flow.dx.map { $0 * scale }, dy: flow.dy.map { $0 * scale })
        }
        return SRFrameAlignment(affine: full, flow: fl, residual: res, isUsable: res < 6)
    }

    private static func coarseSearch(_ r: FloatPlane, _ c: FloatPlane, radius: Int) -> AffineWarp {
        var best = Float.greatestFiniteMagnitude, bx = 0, by = 0
        let st = max(1, min(r.width, r.height) / 64)
        for ty in -radius...radius { for tx in -radius...radius {
            var s: Float = 0, n: Float = 0
            var y = radius; while y < r.height - radius { var x = radius; while x < r.width - radius {
                let d = r.at(x, y) - c.at(x + tx, y + ty); s += d * d; n += 1; x += st }; y += st }
            let m = n > 0 ? s / n : Float.greatestFiniteMagnitude
            // tiny bias toward no motion breaks ties on flat images
            let score = m + 1e-4 * Float(tx * tx + ty * ty)
            if score < best { best = score; bx = tx; by = ty }
        } }
        var A = AffineWarp.identity; A.c = Float(bx); A.f = Float(by); return A
    }

    /// Solves the 6×6 system by Gaussian elimination with partial pivoting.
    private static func solve6(_ H: [Double], _ g: [Double]) -> [Double]? {
        var m = H, b = g
        let n = 6
        for col in 0..<n {
            var piv = col
            for r in col + 1..<n where abs(m[r * n + col]) > abs(m[piv * n + col]) { piv = r }
            if abs(m[piv * n + col]) < 1e-12 { return nil }
            if piv != col { for k in 0..<n { m.swapAt(col * n + k, piv * n + k) }; b.swapAt(col, piv) }
            for r in col + 1..<n {
                let f = m[r * n + col] / m[col * n + col]
                for k in col..<n { m[r * n + k] -= f * m[col * n + k] }
                b[r] -= f * b[col]
            }
        }
        var x = [Double](repeating: 0, count: n)
        for r in stride(from: n - 1, through: 0, by: -1) {
            var s = b[r]; for k in r + 1..<n { s -= m[r * n + k] * x[k] }
            x[r] = s / m[r * n + r]
        }
        return x
    }

    private static func refineAffine(_ R: FloatPlane, _ C: FloatPlane, _ start: AffineWarp, iterations: Int, noise: Float) -> AffineWarp {
        var A = start
        let w = R.width, h = R.height
        let cx = Float(w) / 2, cy = Float(h) / 2
        let stride_ = max(1, min(w, h) / 400)
        let thr = max(2.5 * noise, 2)
        for _ in 0..<iterations {
            var H = [Double](repeating: 0, count: 36), g = [Double](repeating: 0, count: 6)
            var count = 0
            var y = 3; while y < h - 3 { var x = 3; while x < w - 3 {
                let (u, v) = A.apply(Float(x), Float(y))
                if u > 2 && v > 2 && u < Float(w - 3) && v < Float(h - 3) {
                    let r = C.bilinear(u, v) - R.data[y * w + x]
                    let wt = Double(thr * thr / (thr * thr + r * r))
                    let gx = (C.bilinear(u + 1, v) - C.bilinear(u - 1, v)) * 0.5, gy = (C.bilinear(u, v + 1) - C.bilinear(u, v - 1)) * 0.5
                    let xc = Float(x) - cx, yc = Float(y) - cy
                    let J: [Double] = [Double(gx * xc), Double(gx * yc), Double(gx), Double(gy * xc), Double(gy * yc), Double(gy)]
                    for i in 0..<6 { g[i] += wt * J[i] * Double(r); for j in 0..<6 { H[i * 6 + j] += wt * J[i] * J[j] } }
                    count += 1
                }
                x += stride_ }; y += stride_ }
            if count < 100 { break }
            for i in 0..<6 { H[i * 6 + i] = H[i * 6 + i] * (1 + 1e-3) + 1e-6 }
            guard let dlt = solve6(H, g.map { -$0 }) else { break }
            // centred parameters: u − cx = a·xc + b·yc + tx
            var tx = A.c + A.a * cx + A.b * cy - cx, ty = A.f + A.d * cx + A.e * cy - cy
            A.a += Float(dlt[0]); A.b += Float(dlt[1]); tx += Float(dlt[2])
            A.d += Float(dlt[3]); A.e += Float(dlt[4]); ty += Float(dlt[5])
            A.c = tx + cx - A.a * cx - A.b * cy; A.f = ty + cy - A.d * cx - A.e * cy
            if abs(dlt[2]) < 0.005 && abs(dlt[5]) < 0.005 { break }
        }
        return A
    }

    /// Per-cell translation (Lucas-Kanade, reference gradients) after the global affine. Returned in LEVEL-0 (half-res) geometry.
    private static func localFlow(_ R: FloatPlane, _ C: FloatPlane, _ A: AffineWarp, noise: Float) -> FlowField? {
        let w = R.width, h = R.height
        let step: Float = 24, half = 16
        let origin: Float = step / 2
        let cols = max(2, Int((Float(w) - origin) / step) + 1), rows = max(2, Int((Float(h) - origin) / step) + 1)
        var dx = [Float](repeating: .nan, count: cols * rows), dy = dx
        for gy in 0..<rows { for gx in 0..<cols {
            let px = origin + Float(gx) * step, py = origin + Float(gy) * step
            var fx: Float = 0, fy: Float = 0
            var ok = true
            for _ in 0..<4 {
                var sxx: Double = 0, sxy: Double = 0, syy: Double = 0, bx: Double = 0, by: Double = 0, n = 0
                var yy = Int(py) - half; while yy < Int(py) + half { var xx = Int(px) - half; while xx < Int(px) + half {
                    if xx > 1 && yy > 1 && xx < w - 2 && yy < h - 2 {
                        let (u, v) = A.apply(Float(xx), Float(yy))
                        if u > 1 && v > 1 && u < Float(w - 2) && v < Float(h - 2) {
                            let r = C.bilinear(u + fx, v + fy) - R.data[yy * w + xx]
                            let gxv = (R.at(xx + 1, yy) - R.at(xx - 1, yy)) * 0.5, gyv = (R.at(xx, yy + 1) - R.at(xx, yy - 1)) * 0.5
                            sxx += Double(gxv * gxv); sxy += Double(gxv * gyv); syy += Double(gyv * gyv)
                            bx += Double(gxv * r); by += Double(gyv * r); n += 1
                        }
                    }
                    xx += 2 }; yy += 2 }
                let det = sxx * syy - sxy * sxy
                // enough texture in both directions, relative to noise
                let nz = Double(noise * noise)
                let nn = Double(n)
                let minDet = nz * nz * nn * nn * 0.05
                if n < 40 || det < minDet || sxx < nz * nn * 0.5 || syy < nz * nn * 0.5 { ok = false; break }
                let ddx = Float(-(syy * bx - sxy * by) / det), ddy = Float(-(sxx * by - sxy * bx) / det)
                fx += ddx; fy += ddy
                if abs(ddx) < 0.01 && abs(ddy) < 0.01 { break }
            }
            if ok && abs(fx) < 4 && abs(fy) < 4 { dx[gy * cols + gx] = fx; dy[gy * cols + gx] = fy }
        } }
        // fill invalid cells from valid neighbours, then smooth
        var valid = dx.filter { !$0.isNaN }.count
        if valid == 0 { return nil }
        var guardIter = 0
        while valid < dx.count && guardIter < 64 {
            var ndx = dx, ndy = dy
            for gy in 0..<rows { for gx in 0..<cols where dx[gy * cols + gx].isNaN {
                var sx: Float = 0, sy: Float = 0, c: Float = 0
                for oy in -1...1 { for ox in -1...1 {
                    let nx = gx + ox, ny = gy + oy
                    if nx >= 0 && ny >= 0 && nx < cols && ny < rows, !dx[ny * cols + nx].isNaN { sx += dx[ny * cols + nx]; sy += dy[ny * cols + nx]; c += 1 }
                } }
                if c > 0 { ndx[gy * cols + gx] = sx / c; ndy[gy * cols + gx] = sy / c }
            } }
            dx = ndx; dy = ndy; valid = dx.filter { !$0.isNaN }.count; guardIter += 1
        }
        for i in 0..<dx.count where dx[i].isNaN { dx[i] = 0; dy[i] = 0 }
        func med(_ a: [Float]) -> [Float] {
            var o = a
            for gy in 0..<rows { for gx in 0..<cols {
                var v: [Float] = []
                for oy in -1...1 { for ox in -1...1 { let nx = min(max(gx + ox, 0), cols - 1), ny = min(max(gy + oy, 0), rows - 1); v.append(a[ny * cols + nx]) } }
                v.sort(); o[gy * cols + gx] = v[4]
            } }
            return o
        }
        return FlowField(step: step, origin: origin, cols: cols, rows: rows, dx: med(dx), dy: med(dy))
    }

    private static func residual(_ R: FloatPlane, _ C: FloatPlane, _ A: AffineWarp, _ flow: FlowField?, noise: Float) -> Float {
        let w = R.width, h = R.height
        var errs: [Float] = []
        let st = max(2, min(w, h) / 200)
        var y = 4; while y < h - 4 { var x = 4; while x < w - 4 {
            var (u, v) = A.apply(Float(x), Float(y))
            if let f = flow { let (a, b) = f.sample(Float(x), Float(y)); u += a; v += b }
            if u > 2 && v > 2 && u < Float(w - 3) && v < Float(h - 3) { errs.append(abs(C.bilinear(u, v) - R.data[y * w + x])) }
            x += st }; y += st }
        guard errs.count > 50 else { return 99 }
        errs.sort()
        // trimmed mean: ignore the worst 20 % (moving objects)
        let keep = Int(Float(errs.count) * 0.8)
        let m = errs[0..<keep].reduce(0, +) / Float(keep)
        return m / max(noise, 1)
    }
}
