import Foundation

// Handheld 2x super-resolution: image containers and math helpers.
// Full-resolution frames (48 MP) live in manually allocated RGBA memory, never in ordinary Swift arrays, so a decoder can write
// straight into the one allocation and no extra full-frame copies are made.

public struct SRRect: Sendable, Equatable {
    public var x: Int, y: Int, width: Int, height: Int
    public init(x: Int, y: Int, width: Int, height: Int) { self.x = x; self.y = y; self.width = width; self.height = height }
    public var maxX: Int { x + width }
    public var maxY: Int { y + height }
}

/// Raw pointer wrappers so pixel loops can run in `@Sendable` closures (rows are disjoint by construction).
public struct SRConstPointer<T>: @unchecked Sendable { public let p: UnsafePointer<T>; public init(_ p: UnsafePointer<T>) { self.p = p } }
public struct SRMutablePointer<T>: @unchecked Sendable { public let p: UnsafeMutablePointer<T>; public init(_ p: UnsafeMutablePointer<T>) { self.p = p } }

/// 8-bit RGBA image (display-referred, straight alpha 255) with manually managed storage.
public final class RGBA8Image: @unchecked Sendable {
    public let width: Int
    public let height: Int
    public let bytes: UnsafeMutablePointer<UInt8>

    public init(width: Int, height: Int) {
        precondition(width > 0 && height > 0)
        self.width = width; self.height = height
        bytes = UnsafeMutablePointer<UInt8>.allocate(capacity: width * height * 4)
        bytes.initialize(repeating: 255, count: width * height * 4)
    }

    /// Convenience for tests and small buffers (copies).
    public convenience init(width: Int, height: Int, pixels: [UInt8]) {
        precondition(pixels.count == width * height * 4)
        self.init(width: width, height: height)
        pixels.withUnsafeBufferPointer { src in bytes.update(from: src.baseAddress!, count: pixels.count) }
    }

    deinit { bytes.deallocate() }

    public var byteCount: Int { width * height * 4 }
    @inline(__always) public func luma(_ i: Int) -> Float {
        let q = bytes + i * 4
        return 0.299 * Float(q[0]) + 0.587 * Float(q[1]) + 0.114 * Float(q[2])
    }
}

/// Planar float image with bilinear sampling in "pixel index" coordinates (pixel i has its centre at i).
public struct FloatPlane: Sendable {
    public let width: Int
    public let height: Int
    public var data: [Float]
    public init(width: Int, height: Int, value: Float = 0) { self.width = width; self.height = height; data = [Float](repeating: value, count: width * height) }
    @inline(__always) public func at(_ x: Int, _ y: Int) -> Float { data[min(max(y, 0), height - 1) * width + min(max(x, 0), width - 1)] }
    @inline(__always) public func bilinear(_ x: Float, _ y: Float) -> Float {
        let fx = min(max(x, 0), Float(width - 1)), fy = min(max(y, 0), Float(height - 1))
        let x0 = Int(fx), y0 = Int(fy)
        let x1 = min(x0 + 1, width - 1), y1 = min(y0 + 1, height - 1)
        let tx = fx - Float(x0), ty = fy - Float(y0)
        return data.withUnsafeBufferPointer { d in
            let a = d[y0 * width + x0], b = d[y0 * width + x1], c = d[y1 * width + x0], e = d[y1 * width + x1]
            return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + e * tx) * ty
        }
    }
}

/// Parallel loop over independent rows/items.
public func srParallelFor(_ count: Int, _ body: @escaping @Sendable (Int) -> Void) {
    guard count > 0 else { return }
    let workers = min(count, max(1, ProcessInfo.processInfo.activeProcessorCount))
    let next = SRCounter()
    DispatchQueue.concurrentPerform(iterations: workers) { _ in
        while true { let i = next.take(); if i >= count { break }; body(i) }
    }
}
final class SRCounter: @unchecked Sendable {
    private var v = 0; private let lock = NSLock()
    func take() -> Int { lock.lock(); defer { lock.unlock() }; let r = v; v += 1; return r }
}

enum SRMath {
    /// Binomial (1 3 3 1)/8 anti-aliasing taps centred between pixels 2x and 2x+1 (full-res coordinate 2x+0.5).
    static func downsampleLuma(_ img: RGBA8Image) -> FloatPlane {
        let w = img.width, h = img.height
        let ow = max(1, w / 2), oh = max(1, h / 2)
        // horizontal pass → (ow × h), then vertical pass; rows in parallel
        var tmp = FloatPlane(width: ow, height: h)
        let src = SRConstPointer(UnsafePointer(img.bytes))
        tmp.data.withUnsafeMutableBufferPointer { t in
            let tp = SRMutablePointer(t.baseAddress!)
            srParallelFor(h) { y in
                let row = src.p + y * w * 4
                @inline(__always) func L(_ x: Int) -> Float {
                    let q = row + min(max(x, 0), w - 1) * 4
                    return 0.299 * Float(q[0]) + 0.587 * Float(q[1]) + 0.114 * Float(q[2])
                }
                for x in 0..<ow { tp.p[y * ow + x] = (L(2 * x - 1) + 3 * L(2 * x) + 3 * L(2 * x + 1) + L(2 * x + 2)) * 0.125 }
            }
        }
        var out = FloatPlane(width: ow, height: oh)
        tmp.data.withUnsafeBufferPointer { tb in
            let sp = SRConstPointer(tb.baseAddress!)
            out.data.withUnsafeMutableBufferPointer { o in
                let op = SRMutablePointer(o.baseAddress!)
                srParallelFor(oh) { y in
                    for x in 0..<ow {
                        @inline(__always) func V(_ yy: Int) -> Float { sp.p[min(max(yy, 0), h - 1) * ow + x] }
                        op.p[y * ow + x] = (V(2 * y - 1) + 3 * V(2 * y) + 3 * V(2 * y + 1) + V(2 * y + 2)) * 0.125
                    }
                }
            }
        }
        return out
    }

    static func downsample2(_ p: FloatPlane) -> FloatPlane {
        let w = p.width, h = p.height, ow = max(1, w / 2), oh = max(1, h / 2)
        var tmp = FloatPlane(width: ow, height: h)
        for y in 0..<h { for x in 0..<ow { tmp.data[y * ow + x] = (p.at(2 * x - 1, y) + 3 * p.at(2 * x, y) + 3 * p.at(2 * x + 1, y) + p.at(2 * x + 2, y)) * 0.125 } }
        var out = FloatPlane(width: ow, height: oh)
        for y in 0..<oh { for x in 0..<ow { out.data[y * ow + x] = (tmp.at(x, 2 * y - 1) + 3 * tmp.at(x, 2 * y) + 3 * tmp.at(x, 2 * y + 1) + tmp.at(x, 2 * y + 2)) * 0.125 } }
        return out
    }

    static func gaussianKernel(_ sigma: Float) -> [Float] {
        let r = max(1, Int((sigma * 3).rounded(.up)))
        var k = (-r...r).map { expf(-Float($0 * $0) / (2 * sigma * sigma)) }
        let s = k.reduce(0, +); for i in 0..<k.count { k[i] /= s }
        return k
    }

    /// Separable Gaussian blur with edge clamping; rows in parallel.
    static func blur(_ p: FloatPlane, sigma: Float) -> FloatPlane {
        let k = gaussianKernel(sigma), r = k.count / 2, w = p.width, h = p.height
        var tmp = FloatPlane(width: w, height: h), out = FloatPlane(width: w, height: h)
        p.data.withUnsafeBufferPointer { sb in
            let sp = SRConstPointer(sb.baseAddress!)
            tmp.data.withUnsafeMutableBufferPointer { tb in
                let tp = SRMutablePointer(tb.baseAddress!)
                srParallelFor(h) { y in
                    let row = sp.p + y * w
                    for x in 0..<w {
                        var s: Float = 0
                        for j in -r...r { s += k[j + r] * row[min(max(x + j, 0), w - 1)] }
                        tp.p[y * w + x] = s
                    }
                }
            }
        }
        tmp.data.withUnsafeBufferPointer { tb in
            let tp = SRConstPointer(tb.baseAddress!)
            out.data.withUnsafeMutableBufferPointer { ob in
                let op = SRMutablePointer(ob.baseAddress!)
                srParallelFor(h) { y in
                    for x in 0..<w {
                        var s: Float = 0
                        for j in -r...r { s += k[j + r] * tp.p[min(max(y + j, 0), h - 1) * w + x] }
                        op.p[y * w + x] = s
                    }
                }
            }
        }
        return out
    }

    /// Noise standard deviation (plane units) from the 3×3 Laplacian-difference response (removes smooth gradients). Texture only ever
    /// raises it, so the 25th percentile of |response| is used (half-normal: p25 = 0.3186 σ).
    static func estimateNoise(_ p: FloatPlane) -> Float {
        var d: [Float] = []
        let step = max(1, min(p.width, p.height) / 150)
        var y = 1
        while y < p.height - 1 { var x = 1; while x < p.width - 1 {
            let l = 4 * p.at(x, y) - 2 * (p.at(x - 1, y) + p.at(x + 1, y) + p.at(x, y - 1) + p.at(x, y + 1))
                + p.at(x - 1, y - 1) + p.at(x + 1, y - 1) + p.at(x - 1, y + 1) + p.at(x + 1, y + 1)
            d.append(abs(l)); x += step }; y += step }
        guard !d.isEmpty else { return 1 }
        d.sort()
        return max(0.3, d[d.count / 4] / (0.3186 * 6))
    }
}

/// Luma pyramid of one frame. Level 0 is HALF the frame's resolution (an anti-aliased decimation of the full frame), so a full-resolution
/// 48 MP frame never needs a full-resolution float plane.
struct SRPyramid: Sendable {
    var levels: [FloatPlane]
    init(frame: RGBA8Image) {
        var l = [SRMath.downsampleLuma(frame)]
        while min(l.last!.width, l.last!.height) >= 128 && l.count < 6 { l.append(SRMath.downsample2(l.last!)) }
        levels = l
    }
}
