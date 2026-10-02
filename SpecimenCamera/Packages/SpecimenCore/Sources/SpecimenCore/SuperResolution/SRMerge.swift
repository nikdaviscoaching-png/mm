import Foundation

/// Planar RGB float result of a tile merge plus how much genuine multi-frame information each pixel received.
public struct SRTileResult: Sendable {
    public var rect: SRRect
    public var rgba: [UInt8]
    public var confidence: [Float]
}

/// 0…255 per half-resolution pixel: how much a candidate frame can be trusted at that place of the reference.
struct SRTrustMap: Sendable {
    let width: Int, height: Int
    var data: [UInt8]
    @inline(__always) func at(_ hx: Int, _ hy: Int) -> Float {
        Float(data[min(max(hy, 0), height - 1) * width + min(max(hx, 0), width - 1)]) * (1.0 / 255.0)
    }
}

enum SRMerge {
    static let reconstructionSigma: Float = 0.35   // tuned on the synthetic ground-truth scene (0.45 was softer: -1.2 dB vs 0.35)
    static let supportSquared: Float = 2.25
    static let lutSize = 256

    /// Trust maps: the candidate warped into reference coordinates must agree with the reference within noise plus a
    /// gradient-dependent allowance (tiny residual misregistration at sharp detail is not motion).
    static func trustMap(refSmooth: FloatPlane, cand: FloatPlane, alignment: SRFrameAlignment, noise: Float) -> SRTrustMap {
        let w = refSmooth.width, h = refSmooth.height
        let candSmooth = SRMath.blur(cand, sigma: 1.0)
        let baseSigma = max(noise * 1.5, 1.0)
        let misreg: Float = 0.35, tolerance: Float = 2.0
        var raw = [UInt8](repeating: 0, count: w * h)
        refSmooth.data.withUnsafeBufferPointer { rb in
            let rp = SRConstPointer(rb.baseAddress!)
            raw.withUnsafeMutableBufferPointer { ob in
                let op = SRMutablePointer(ob.baseAddress!)
                srParallelFor(h) { y in
                    for x in 0..<w {
                        let (u, v) = alignment.map(2 * Float(x) + 0.5, 2 * Float(y) + 0.5)
                        let hx = (u - 0.5) / 2, hy = (v - 0.5) / 2
                        if hx < 0 || hy < 0 || hx > Float(w - 1) || hy > Float(h - 1) { op.p[y * w + x] = 0; continue }
                        let r = rp.p[y * w + x]
                        let gx = (rp.p[y * w + min(x + 1, w - 1)] - rp.p[y * w + max(x - 1, 0)]) * 0.5
                        let gy = (rp.p[min(y + 1, h - 1) * w + x] - rp.p[max(y - 1, 0) * w + x]) * 0.5
                        let gm = (gx * gx + gy * gy).squareRoot()
                        let sigma = (baseSigma * baseSigma + (gm * misreg) * (gm * misreg)).squareRoot()
                        let z = abs(candSmooth.bilinear(hx, hy) - r) / (tolerance * sigma)
                        op.p[y * w + x] = UInt8(max(0, min(255, expf(-0.5 * z * z) * 255)))
                    }
                }
            }
        }
        // 3×3 minimum: shrink trusted regions near moving-object boundaries
        var out = raw
        for y in 0..<h { for x in 0..<w {
            var m: UInt8 = 255
            for oy in -1...1 { for ox in -1...1 { m = min(m, raw[min(max(y + oy, 0), h - 1) * w + min(max(x + ox, 0), w - 1)]) } }
            out[y * w + x] = m
        } }
        return SRTrustMap(width: w, height: h, data: out)
    }

    /// Weighted sample gathering ("kernel regression") onto the 2× grid for `rect` (output coordinates).
    /// frames[referenceIndex] is always available as fallback; other frames contribute by alignment and trust.
    static func mergeTile(frames: [RGBA8Image], referenceIndex: Int, alignments: [SRFrameAlignment?], trust: [SRTrustMap?], rect: SRRect) -> SRTileResult {
        let n = frames.count
        let W = frames[0].width, H = frames[0].height
        var lut = [Float](repeating: 0, count: lutSize)
        for i in 0..<lutSize { let d2 = (Float(i) + 0.5) * supportSquared / Float(lutSize); lut[i] = expf(-d2 / (2 * reconstructionSigma * reconstructionSigma)) }
        let lutScale = Float(lutSize) / supportSquared
        var rgba = [UInt8](repeating: 255, count: rect.width * rect.height * 4)
        var conf = [Float](repeating: 0, count: rect.width * rect.height)
        let used: [Int] = (0..<n).filter { $0 == referenceIndex || (alignments[$0]?.isUsable == true && trust[$0] != nil) }
        rgba.withUnsafeMutableBufferPointer { ob in
            conf.withUnsafeMutableBufferPointer { cb in
                let op = SRMutablePointer(ob.baseAddress!), cp = SRMutablePointer(cb.baseAddress!)
                let frameP = frames.map { SRConstPointer(UnsafePointer($0.bytes)) }
                lut.withUnsafeBufferPointer { lb in
                    let lutP = SRConstPointer(lb.baseAddress!)
                    srParallelFor(rect.height) { ry in
                        let oy = rect.y + ry
                        let yr = (Float(oy) + 0.5) * 0.5 - 0.5
                        for rx in 0..<rect.width {
                            let ox = rect.x + rx
                            let xr = (Float(ox) + 0.5) * 0.5 - 0.5
                            var sr: Float = 0, sg: Float = 0, sb: Float = 0, sw: Float = 0, others: Float = 0
                            for k in used {
                                var u = xr, v = yr, t: Float = 1
                                if k != referenceIndex {
                                    let a = alignments[k]!
                                    (u, v) = a.map(xr, yr)
                                    let tm = trust[k]!
                                    t = tm.at(Int(((xr - 0.5) / 2).rounded()), Int(((yr - 0.5) / 2).rounded()))
                                    if t < 0.02 { continue }
                                }
                                let px = frameP[k].p
                                let x0 = Int((u - 1.5).rounded(.up)), x1 = Int((u + 1.5).rounded(.down))
                                let y0 = Int((v - 1.5).rounded(.up)), y1 = Int((v + 1.5).rounded(.down))
                                var wk: Float = 0
                                var yy = y0
                                while yy <= y1 {
                                    let dy = Float(yy) - v
                                    let cy = min(max(yy, 0), H - 1)
                                    var xx = x0
                                    while xx <= x1 {
                                        let dx = Float(xx) - u
                                        let d2 = dx * dx + dy * dy
                                        if d2 <= supportSquared {
                                            let wgt = lutP.p[min(lutSize - 1, Int(d2 * lutScale))] * t
                                            let q = px + (cy * W + min(max(xx, 0), W - 1)) * 4
                                            sr += wgt * Float(q[0]); sg += wgt * Float(q[1]); sb += wgt * Float(q[2]); wk += wgt
                                        }
                                        xx += 1
                                    }
                                    yy += 1
                                }
                                sw += wk
                                if k != referenceIndex { others += wk }
                            }
                            let o = (ry * rect.width + rx) * 4
                            let inv = sw > 0 ? 1 / sw : 0
                            op.p[o] = UInt8(max(0, min(255, sr * inv + 0.5)))
                            op.p[o + 1] = UInt8(max(0, min(255, sg * inv + 0.5)))
                            op.p[o + 2] = UInt8(max(0, min(255, sb * inv + 0.5)))
                            op.p[o + 3] = 255
                            cp.p[ry * rect.width + rx] = sw > 0 ? others / sw : 0
                        }
                    }
                }
            }
        }
        return SRTileResult(rect: rect, rgba: rgba, confidence: conf)
    }
}
