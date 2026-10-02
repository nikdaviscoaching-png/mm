import Foundation

/// Gaussian / Laplacian pyramids over planes and colour images.
public enum Pyramid {

    public static func gaussian(_ p: Plane, levels: Int) -> [Plane] {
        var out = [p]
        for _ in 1..<max(1, levels) {
            guard let last = out.last, last.width > 1 || last.height > 1 else { break }
            out.append(Filters.reduce(last))
        }
        return out
    }

    /// `levels` Laplacian bands followed by the Gaussian residual (count = levels + 1, fewer if the image runs out).
    public static func laplacian(_ p: Plane, levels: Int) -> [Plane] {
        let g = gaussian(p, levels: levels + 1)
        var out: [Plane] = []
        for i in 0..<(g.count - 1) {
            let up = Filters.expand(g[i + 1], toWidth: g[i].width, toHeight: g[i].height)
            out.append(Filters.subtract(g[i], up))
        }
        out.append(g[g.count - 1])
        return out
    }

    public static func collapse(_ lap: [Plane]) -> Plane {
        guard var cur = lap.last else { return Plane(width: 0, height: 0) }
        for i in stride(from: lap.count - 2, through: 0, by: -1) {
            let up = Filters.expand(cur, toWidth: lap[i].width, toHeight: lap[i].height)
            cur = Filters.combine(lap[i], up) { $0 + $1 }
        }
        return cur
    }

    /// Dimensions of each level for an image of the given size.
    public static func levelSizes(width: Int, height: Int, count: Int) -> [(width: Int, height: Int)] {
        var out: [(Int, Int)] = [(width, height)]
        for _ in 1..<max(1, count) {
            let l = out[out.count - 1]
            if l.0 <= 1 && l.1 <= 1 { break }
            out.append(((l.0 + 1) / 2, (l.1 + 1) / 2))
        }
        return out.map { (width: $0.0, height: $0.1) }
    }

    /// Pyramid levels needed for a halo of `halo` pixels to cover the support of the coarsest level.
    public static func haloFor(levels: Int) -> Int { 4 << levels }
}
