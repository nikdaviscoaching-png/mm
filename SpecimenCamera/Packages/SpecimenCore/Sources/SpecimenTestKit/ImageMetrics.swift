import Foundation
import SpecimenCore

public enum ImageMetrics {
    public static func mse(_ a: RGBImage, _ b: RGBImage, in rect: PixelRect? = nil, mask: Plane? = nil) -> Double {
        var s = 0.0, n = 0.0
        let r = rect ?? PixelRect(x: 0, y: 0, width: a.width, height: a.height)
        for y in r.y..<r.maxY { for x in r.x..<r.maxX {
            let wgt = Double(mask?[x, y] ?? 1)
            if wgt <= 0 { continue }
            let dr = Double(a.r[x, y] - b.r[x, y]), dg = Double(a.g[x, y] - b.g[x, y]), db = Double(a.b[x, y] - b.b[x, y])
            s += wgt * (dr * dr + dg * dg + db * db) / 3; n += wgt
        }}
        return n > 0 ? s / n : 0
    }

    public static func psnr(_ a: RGBImage, _ b: RGBImage, in rect: PixelRect? = nil, mask: Plane? = nil) -> Double {
        let m = mse(a, b, in: rect, mask: mask)
        return m <= 1e-12 ? 99 : -10 * log10(m)
    }

    /// Mean gradient magnitude of luma — a crude sharpness number for comparing regions.
    public static func sharpness(_ img: RGBImage, in rect: PixelRect? = nil) -> Double {
        let y = img.luma(.rec709)
        let g = Filters.gradientMagnitude(y)
        let r = rect ?? PixelRect(x: 0, y: 0, width: img.width, height: img.height)
        var s = 0.0
        for yy in r.y..<r.maxY { for xx in r.x..<r.maxX { s += Double(g[xx, yy]) } }
        return s / Double(max(1, r.pixelCount))
    }

    public static func meanLuma(_ img: RGBImage, in rect: PixelRect) -> Double {
        let y = img.luma(.rec709)
        var s = 0.0
        for yy in rect.y..<rect.maxY { for xx in rect.x..<rect.maxX { s += Double(y[xx, yy]) } }
        return s / Double(max(1, rect.pixelCount))
    }

    public static func maxLuma(_ img: RGBImage, in rect: PixelRect) -> Float {
        let y = img.luma(.rec709)
        var m: Float = 0
        for yy in rect.y..<rect.maxY { for xx in rect.x..<rect.maxX { m = max(m, y[xx, yy]) } }
        return m
    }

    public static func meanColor(_ img: RGBImage, in rect: PixelRect) -> (Double, Double, Double) {
        var r = 0.0, g = 0.0, b = 0.0
        for yy in rect.y..<rect.maxY { for xx in rect.x..<rect.maxX { r += Double(img.r[xx, yy]); g += Double(img.g[xx, yy]); b += Double(img.b[xx, yy]) } }
        let n = Double(max(1, rect.pixelCount))
        return (r / n, g / n, b / n)
    }

    /// Grid montage for eyeballing: images are placed left-to-right, wrapped at `columns`, scaled to a common cell size.
    public static func montage(_ images: [RGBImage], columns: Int, cell: (Int, Int)? = nil) -> RGBImage {
        guard let first = images.first else { return RGBImage(width: 1, height: 1) }
        let cw = cell?.0 ?? first.width, ch = cell?.1 ?? first.height
        let rows = (images.count + columns - 1) / columns
        var out = RGBImage(width: cw * columns, height: ch * rows, value: 0.1)
        for (i, im) in images.enumerated() {
            let fitted = (im.width == cw && im.height == ch) ? im : RGBImage(
                r: Filters.resizeBilinear(im.r, toWidth: cw, toHeight: ch), g: Filters.resizeBilinear(im.g, toWidth: cw, toHeight: ch), b: Filters.resizeBilinear(im.b, toWidth: cw, toHeight: ch))
            out.paste(fitted, atX: (i % columns) * cw, y: (i / columns) * ch)
        }
        return out
    }
}
