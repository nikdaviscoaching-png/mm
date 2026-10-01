import Foundation
import SpecimenCore

public struct SplitMix64: Sendable {
    var state: UInt64
    public init(seed: UInt64) { state = seed &+ 0x9E3779B97F4A7C15 }
    public mutating func next() -> UInt64 {
        state = state &+ 0x9E3779B97F4A7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58476D1CE4E5B9
        z = (z ^ (z >> 27)) &* 0x94D049BB133111EB
        return z ^ (z >> 31)
    }
    public mutating func uniform() -> Float { Float(next() >> 40) / Float(1 << 24) }
    public mutating func gaussian() -> Float {
        let u1 = max(uniform(), 1e-7), u2 = uniform()
        return sqrtf(-2 * logf(u1)) * cosf(2 * .pi * u2)
    }
}

public enum Noise {
    @inline(__always)
    static func hash(_ x: Int, _ y: Int, _ seed: UInt64) -> Float {
        var h = UInt64(bitPattern: Int64(x)) &* 0x9E3779B185EBCA87 ^ UInt64(bitPattern: Int64(y)) &* 0xC2B2AE3D27D4EB4F ^ seed &* 0x165667B19E3779F9
        h ^= h >> 33; h = h &* 0xFF51AFD7ED558CCD; h ^= h >> 33; h = h &* 0xC4CEB9FE1A85EC53; h ^= h >> 33
        return Float(h >> 40) / Float(1 << 24)
    }

    public static func value(_ x: Float, _ y: Float, seed: UInt64) -> Float {
        let xi = Int(floorf(x)), yi = Int(floorf(y))
        let fx = x - Float(xi), fy = y - Float(yi)
        let ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10)
        let a = hash(xi, yi, seed), b = hash(xi + 1, yi, seed), c = hash(xi, yi + 1, seed), d = hash(xi + 1, yi + 1, seed)
        return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy
    }

    public static func fbm(_ x: Float, _ y: Float, octaves: Int, seed: UInt64) -> Float {
        var amp: Float = 0.5, f: Float = 1, s: Float = 0, norm: Float = 0
        for o in 0..<octaves {
            s += amp * value(x * f, y * f, seed: seed &+ UInt64(o) * 101)
            norm += amp; amp *= 0.5; f *= 2
        }
        return s / norm
    }
}

/// Procedural stand-in for a banded, grainy, faceted specimen: crisp bands with dark boundaries, fine grain,
/// hairlines, Voronoi crystal facets and one deliberately smooth (low-texture) patch. Display-encoded RGB.
public enum SyntheticSpecimen {
    static let palette: [(Float, Float, Float)] = [
        (0.55, 0.10, 0.07), (0.85, 0.45, 0.12), (0.93, 0.88, 0.75), (0.35, 0.20, 0.12),
        (0.45, 0.55, 0.70), (0.90, 0.90, 0.88), (0.14, 0.09, 0.10), (0.70, 0.25, 0.45),
    ]

    public static func texture(width: Int, height: Int, seed: UInt64 = 1) -> RGBImage {
        var img = RGBImage(width: width, height: height)
        let W = Float(width), H = Float(height)
        for y in 0..<height {
            for x in 0..<width {
                let u = Float(x) / W, v = Float(y) / H * (H / W)
                let wx = u + 0.07 * (Noise.fbm(u * 3, v * 3, octaves: 3, seed: seed) - 0.5)
                let wy = v + 0.07 * (Noise.fbm(u * 3 + 17, v * 3 + 9, octaves: 3, seed: seed + 1) - 0.5)
                let r = hypotf(wx - 0.45, wy - 0.38)
                let bands = r * 16
                let bi = Int(floorf(bands)), f = bands - floorf(bands)
                let ph = Noise.hash(bi, 7, seed)
                let col = palette[Int(ph * Float(palette.count)) % palette.count]
                let shade = 0.82 + 0.3 * f
                let edge = 1 - 0.7 * (1 - smoothstep(0.0, 0.05, f)) * smoothstep(0.0, 0.0, 1)
                // fine grain at ~2-4 px scale
                let grain = 1 + 0.16 * (Noise.fbm(Float(x) / 2.4, Float(y) / 2.4, octaves: 2, seed: seed + 5) - 0.5) * 2
                var c = (col.0 * shade * edge * grain, col.1 * shade * edge * grain, col.2 * shade * edge * grain)

                // Voronoi crystal facets (lower-left zone)
                if u < 0.38 && y > Int(Float(height) * 0.58) {
                    let cell = 26 as Float
                    let cx = Int(floorf(Float(x) / cell)), cy = Int(floorf(Float(y) / cell))
                    var d1: Float = 1e9, d2: Float = 1e9; var nearest = (0, 0)
                    for oy in -1...1 { for ox in -1...1 {
                        let gx = cx + ox, gy = cy + oy
                        let px = (Float(gx) + Noise.hash(gx, gy, seed + 11)) * cell, py = (Float(gy) + Noise.hash(gx, gy, seed + 12)) * cell
                        let d = hypotf(Float(x) - px, Float(y) - py)
                        if d < d1 { d2 = d1; d1 = d; nearest = (gx, gy) } else if d < d2 { d2 = d }
                    }}
                    let k = Noise.hash(nearest.0, nearest.1, seed + 13)
                    let base = palette[Int(k * Float(palette.count)) % palette.count]
                    let g2 = 0.7 + 0.45 * Noise.hash(nearest.0, nearest.1, seed + 14)
                    let line = smoothstep(0.0, 2.2, d2 - d1)
                    c = (base.0 * g2 * line * grain, base.1 * g2 * line * grain, base.2 * g2 * line * grain)
                }
                // hairlines (upper-right zone)
                if u > 0.68 && y < Int(Float(height) * 0.42) {
                    let ang: Float = 0.5
                    let t = (Float(x) * cosf(ang) + Float(y) * sinf(ang)) / 9
                    let d = abs(t - floorf(t) - 0.5) * 9
                    let line = smoothstep(0.35, 1.1, d)
                    c = (0.9 * line + 0.05, 0.86 * line + 0.05, 0.78 * line + 0.05)
                }
                // smooth, low-texture patch (lower-right)
                if u > 0.62 && y > Int(Float(height) * 0.62) {
                    let g = 0.45 + 0.12 * (u - 0.62) / 0.38 + 0.04 * Float(y - Int(Float(height) * 0.62)) / H
                    c = (g * 0.95, g * 0.55, g * 0.35)
                }
                img.r[x, y] = min(max(c.0, 0), 1); img.g[x, y] = min(max(c.1, 0), 1); img.b[x, y] = min(max(c.2, 0), 1)
            }
        }
        return img
    }
}
