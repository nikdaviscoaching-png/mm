import Foundation

/// Integer pixel rectangle. May extend outside an image; sources clamp (replicate edge) on read.
public struct PixelRect: Equatable, Hashable, Sendable, Codable {
    public var x: Int
    public var y: Int
    public var width: Int
    public var height: Int

    public init(x: Int, y: Int, width: Int, height: Int) {
        self.x = x; self.y = y; self.width = width; self.height = height
    }

    public var maxX: Int { x + width }
    public var maxY: Int { y + height }
    public var isEmpty: Bool { width <= 0 || height <= 0 }
    public var pixelCount: Int { max(0, width) * max(0, height) }

    public func outset(_ d: Int) -> PixelRect {
        PixelRect(x: x - d, y: y - d, width: width + 2 * d, height: height + 2 * d)
    }

    public func intersection(_ o: PixelRect) -> PixelRect {
        let x0 = max(x, o.x), y0 = max(y, o.y)
        let x1 = min(maxX, o.maxX), y1 = min(maxY, o.maxY)
        return PixelRect(x: x0, y: y0, width: max(0, x1 - x0), height: max(0, y1 - y0))
    }

    public func offset(dx: Int, dy: Int) -> PixelRect {
        PixelRect(x: x + dx, y: y + dy, width: width, height: height)
    }
}

/// 2×3 affine transform: x' = a·x + b·y + tx, y' = c·x + d·y + ty.
///
/// Convention used throughout the registration code: a frame's transform maps **reference coordinates to
/// frame coordinates**. Sampling the frame at `T(p)` for every reference pixel `p` yields the aligned image.
/// Pixel centres sit at integer coordinates.
public struct Affine2D: Equatable, Sendable, Codable {
    public var a: Double, b: Double, tx: Double
    public var c: Double, d: Double, ty: Double

    public init(a: Double, b: Double, tx: Double, c: Double, d: Double, ty: Double) {
        self.a = a; self.b = b; self.tx = tx; self.c = c; self.d = d; self.ty = ty
    }

    public static let identity = Affine2D(a: 1, b: 0, tx: 0, c: 0, d: 1, ty: 0)

    @inline(__always)
    public func apply(_ x: Double, _ y: Double) -> (x: Double, y: Double) {
        (a * x + b * y + tx, c * x + d * y + ty)
    }

    public var determinant: Double { a * d - b * c }

    public func inverted() -> Affine2D? {
        let det = determinant
        guard abs(det) > 1e-12 else { return nil }
        let ia = d / det, ib = -b / det, ic = -c / det, id = a / det
        return Affine2D(a: ia, b: ib, tx: -(ia * tx + ib * ty), c: ic, d: id, ty: -(ic * tx + id * ty))
    }

    /// `self ∘ other` — applies `other` first, then `self`.
    public func concatenating(_ other: Affine2D) -> Affine2D {
        Affine2D(
            a: a * other.a + b * other.c, b: a * other.b + b * other.d, tx: a * other.tx + b * other.ty + tx,
            c: c * other.a + d * other.c, d: c * other.b + d * other.d, ty: c * other.tx + d * other.ty + ty)
    }

    /// Similarity (uniform scale + rotation) about `center`, followed by a translation.
    public static func similarity(scale: Double, rotation: Double, translation: (x: Double, y: Double),
                                  center: (x: Double, y: Double) = (0, 0)) -> Affine2D {
        let cs = scale * cos(rotation), sn = scale * sin(rotation)
        // p' = R·S·(p - center) + center + translation
        let tx = center.x + translation.x - (cs * center.x - sn * center.y)
        let ty = center.y + translation.y - (sn * center.x + cs * center.y)
        return Affine2D(a: cs, b: -sn, tx: tx, c: sn, d: cs, ty: ty)
    }

    /// Re-expresses a transform estimated on an image downscaled by `factor` (pixel-centre aligned box
    /// downscale: proxy p = (full + 0.5)/factor - 0.5) so that it applies to full-resolution coordinates.
    public func scaledUp(by factor: Double) -> Affine2D {
        let toProxy = Affine2D(a: 1 / factor, b: 0, tx: 0.5 / factor - 0.5, c: 0, d: 1 / factor, ty: 0.5 / factor - 0.5)
        let toFull = Affine2D(a: factor, b: 0, tx: 0.5 * factor - 0.5, c: 0, d: factor, ty: 0.5 * factor - 0.5)
        return toFull.concatenating(self).concatenating(toProxy)
    }

    /// Largest displacement (in pixels) this transform causes over an image of the given size.
    public func maxDisplacement(width: Int, height: Int) -> Double {
        var m = 0.0
        for (px, py) in [(0.0, 0.0), (Double(width), 0.0), (0.0, Double(height)), (Double(width), Double(height))] {
            let q = apply(px, py)
            m = max(m, hypot(q.x - px, q.y - py))
        }
        return m
    }

    public var scale: Double { sqrt(abs(determinant)) }
    public var rotation: Double { atan2(c - b, a + d) }
}

/// A tile to process: `core` is written to the output, `padded` (core + halo) is what gets read.
public struct Tile: Sendable, Equatable {
    public let index: Int
    public let core: PixelRect
    public let padded: PixelRect
}

public struct TileGrid: Sendable {
    public let imageWidth: Int
    public let imageHeight: Int
    public let tileSize: Int
    public let halo: Int
    public let tiles: [Tile]

    public init(imageWidth: Int, imageHeight: Int, tileSize: Int, halo: Int) {
        self.imageWidth = imageWidth; self.imageHeight = imageHeight
        self.tileSize = tileSize; self.halo = halo
        var out: [Tile] = []
        var y = 0
        while y < imageHeight {
            let h = min(tileSize, imageHeight - y)
            var x = 0
            while x < imageWidth {
                let w = min(tileSize, imageWidth - x)
                let core = PixelRect(x: x, y: y, width: w, height: h)
                out.append(Tile(index: out.count, core: core, padded: core.outset(halo)))
                x += tileSize
            }
            y += tileSize
        }
        tiles = out
    }
}
