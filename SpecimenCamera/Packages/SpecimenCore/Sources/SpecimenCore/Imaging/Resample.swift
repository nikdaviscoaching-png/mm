import Foundation

public enum Resample {

    @inline(__always)
    static func catmullRomWeights(_ t: Float) -> (Float, Float, Float, Float) {
        let t2 = t * t, t3 = t2 * t
        return (-0.5 * t3 + t2 - 0.5 * t,
                1.5 * t3 - 2.5 * t2 + 1,
                -1.5 * t3 + 2 * t2 + 0.5 * t,
                0.5 * t3 - 0.5 * t2)
    }

    /// Renders `outputRect` (absolute reference coordinates) of the image `source` — whose top-left sits at
    /// absolute coordinates `sourceOrigin` — through `transform` (reference → frame) using Catmull-Rom
    /// bicubic interpolation. Source pixels outside `source` replicate the edge.
    public static func warp(_ source: RGBImage, sourceOrigin: (x: Int, y: Int), transform: Affine2D,
                            outputRect: PixelRect) -> RGBImage {
        var out = RGBImage(width: outputRect.width, height: outputRect.height)
        let sw = source.width, sh = source.height
        source.r.pixels.withUnsafeBufferPointer { sr in
        source.g.pixels.withUnsafeBufferPointer { sg in
        source.b.pixels.withUnsafeBufferPointer { sb in
        out.r.pixels.withUnsafeMutableBufferPointer { dr in
        out.g.pixels.withUnsafeMutableBufferPointer { dg in
        out.b.pixels.withUnsafeMutableBufferPointer { db in
            for oy in 0..<outputRect.height {
                for ox in 0..<outputRect.width {
                    let p = transform.apply(Double(outputRect.x + ox), Double(outputRect.y + oy))
                    let fx = Float(p.x - Double(sourceOrigin.x)), fy = Float(p.y - Double(sourceOrigin.y))
                    let x0 = Int(floorf(fx)), y0 = Int(floorf(fy))
                    let (wx0, wx1, wx2, wx3) = catmullRomWeights(fx - Float(x0))
                    let (wy0, wy1, wy2, wy3) = catmullRomWeights(fy - Float(y0))
                    var ar: Float = 0, ag: Float = 0, ab: Float = 0
                    for j in 0..<4 {
                        let wy: Float = j == 0 ? wy0 : (j == 1 ? wy1 : (j == 2 ? wy2 : wy3))
                        let yy = min(max(y0 - 1 + j, 0), sh - 1) * sw
                        let i0 = min(max(x0 - 1, 0), sw - 1) + yy, i1 = min(max(x0, 0), sw - 1) + yy
                        let i2 = min(max(x0 + 1, 0), sw - 1) + yy, i3 = min(max(x0 + 2, 0), sw - 1) + yy
                        ar += wy * (wx0 * sr[i0] + wx1 * sr[i1] + wx2 * sr[i2] + wx3 * sr[i3])
                        ag += wy * (wx0 * sg[i0] + wx1 * sg[i1] + wx2 * sg[i2] + wx3 * sg[i3])
                        ab += wy * (wx0 * sb[i0] + wx1 * sb[i1] + wx2 * sb[i2] + wx3 * sb[i3])
                    }
                    let o = oy * outputRect.width + ox
                    dr[o] = min(max(ar, 0), 1); dg[o] = min(max(ag, 0), 1); db[o] = min(max(ab, 0), 1)
                }
            }
        }}}}}}
        return out
    }

    /// Source rectangle (absolute frame coordinates) needed to render `outputRect` through `transform`.
    public static func sourceBounds(for outputRect: PixelRect, transform: Affine2D, margin: Int = 3) -> PixelRect {
        var minX = Double.infinity, minY = Double.infinity, maxX = -Double.infinity, maxY = -Double.infinity
        for (px, py) in [(outputRect.x, outputRect.y), (outputRect.maxX, outputRect.y), (outputRect.x, outputRect.maxY), (outputRect.maxX, outputRect.maxY)] {
            let q = transform.apply(Double(px), Double(py))
            minX = min(minX, q.x); maxX = max(maxX, q.x); minY = min(minY, q.y); maxY = max(maxY, q.y)
        }
        let x0 = Int(floor(minX)) - margin, y0 = Int(floor(minY)) - margin
        let x1 = Int(ceil(maxX)) + margin, y1 = Int(ceil(maxY)) + margin
        return PixelRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0)
    }
}
