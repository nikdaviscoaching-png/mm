import Foundation

/// Single-channel Float image. The workhorse of every filter in the package.
public struct Plane: Sendable, Equatable {
    public let width: Int
    public let height: Int
    public var pixels: [Float]

    public init(width: Int, height: Int, value: Float = 0) {
        precondition(width >= 0 && height >= 0)
        self.width = width; self.height = height
        pixels = [Float](repeating: value, count: width * height)
    }

    public init(width: Int, height: Int, pixels: [Float]) {
        precondition(pixels.count == width * height, "pixel count mismatch")
        self.width = width; self.height = height; self.pixels = pixels
    }

    public var count: Int { pixels.count }

    @inline(__always)
    public subscript(x: Int, y: Int) -> Float {
        get { pixels[y * width + x] }
        set { pixels[y * width + x] = newValue }
    }

    @inline(__always)
    public func clamped(_ x: Int, _ y: Int) -> Float {
        let cx = min(max(x, 0), width - 1), cy = min(max(y, 0), height - 1)
        return pixels[cy * width + cx]
    }

    public func mapped(_ f: (Float) -> Float) -> Plane {
        Plane(width: width, height: height, pixels: pixels.map(f))
    }

    public var mean: Float {
        guard !pixels.isEmpty else { return 0 }
        var s = 0.0
        for v in pixels { s += Double(v) }
        return Float(s / Double(pixels.count))
    }

    public var minMax: (min: Float, max: Float) {
        var lo = Float.greatestFiniteMagnitude, hi = -Float.greatestFiniteMagnitude
        for v in pixels { lo = min(lo, v); hi = max(hi, v) }
        return (lo, hi)
    }

    /// Copy of a sub-rectangle. Out-of-range pixels replicate the edge.
    public func crop(_ r: PixelRect) -> Plane {
        var out = Plane(width: r.width, height: r.height)
        let inside = r.x >= 0 && r.y >= 0 && r.maxX <= width && r.maxY <= height
        out.pixels.withUnsafeMutableBufferPointer { dst in
            pixels.withUnsafeBufferPointer { src in
                if inside {
                    for y in 0..<r.height {
                        let s = (r.y + y) * width + r.x
                        let d = y * r.width
                        for x in 0..<r.width { dst[d + x] = src[s + x] }
                    }
                } else {
                    for y in 0..<r.height {
                        let sy = min(max(r.y + y, 0), height - 1)
                        for x in 0..<r.width {
                            let sx = min(max(r.x + x, 0), width - 1)
                            dst[y * r.width + x] = src[sy * width + sx]
                        }
                    }
                }
            }
        }
        return out
    }

    /// Writes `other` into this plane with its top-left at (x, y), clipping to bounds.
    public mutating func paste(_ other: Plane, atX x: Int, y: Int) {
        let r = PixelRect(x: x, y: y, width: other.width, height: other.height).intersection(PixelRect(x: 0, y: 0, width: width, height: height))
        guard !r.isEmpty else { return }
        for yy in r.y..<r.maxY {
            for xx in r.x..<r.maxX { self[xx, yy] = other[xx - x, yy - y] }
        }
    }
}

/// Three-plane colour image holding values in whichever encoding the caller documents
/// (frame sources return display-encoded values; engines convert to linear light internally).
public struct RGBImage: Sendable, Equatable {
    public var r: Plane
    public var g: Plane
    public var b: Plane

    public init(r: Plane, g: Plane, b: Plane) {
        precondition(r.width == g.width && g.width == b.width && r.height == g.height && g.height == b.height)
        self.r = r; self.g = g; self.b = b
    }

    public init(width: Int, height: Int, value: Float = 0) {
        r = Plane(width: width, height: height, value: value)
        g = r; b = r
    }

    public var width: Int { r.width }
    public var height: Int { r.height }
    public var planes: [Plane] { [r, g, b] }

    public func crop(_ rect: PixelRect) -> RGBImage {
        RGBImage(r: r.crop(rect), g: g.crop(rect), b: b.crop(rect))
    }

    public func mapped(_ f: (Float) -> Float) -> RGBImage {
        RGBImage(r: r.mapped(f), g: g.mapped(f), b: b.mapped(f))
    }

    public mutating func paste(_ other: RGBImage, atX x: Int, y: Int) {
        r.paste(other.r, atX: x, y: y); g.paste(other.g, atX: x, y: y); b.paste(other.b, atX: x, y: y)
    }

    /// Weighted luma of the (already linear or encoded) channels.
    public func luma(_ k: LumaCoefficients) -> Plane {
        var out = Plane(width: width, height: height)
        let n = r.count
        out.pixels.withUnsafeMutableBufferPointer { o in
            r.pixels.withUnsafeBufferPointer { pr in
                g.pixels.withUnsafeBufferPointer { pg in
                    b.pixels.withUnsafeBufferPointer { pb in
                        for i in 0..<n { o[i] = k.r * pr[i] + k.g * pg[i] + k.b * pb[i] }
                    }
                }
            }
        }
        return out
    }
}
