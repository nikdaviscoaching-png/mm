import Foundation
import SpecimenCore

/// Additive white (or tinted) glare blob with a Gaussian falloff — broad specular washout when amplitude is large.
public struct GlareBlob: Sendable {
    public var cx: Float, cy: Float          // centre as a fraction of width / height
    public var sigma: Float                  // fraction of image width
    public var amplitude: Float              // linear-light addition at the core
    public var tint: (Float, Float, Float) = (1, 1, 1)
    public init(cx: Float, cy: Float, sigma: Float, amplitude: Float, tint: (Float, Float, Float) = (1, 1, 1)) {
        self.cx = cx; self.cy = cy; self.sigma = sigma; self.amplitude = amplitude; self.tint = tint
    }
}

/// Thin curved highlight along a circular arc — the narrow, controlled polish highlight that must survive.
public struct Streak: Sendable {
    public var cx: Float, cy: Float          // circle centre (fractions of width/height)
    public var radius: Float                 // fraction of width
    public var startAngle: Float, endAngle: Float
    public var thickness: Float              // px (FWHM-ish)
    public var peak: Float                   // linear-light addition
    public init(cx: Float, cy: Float, radius: Float, startAngle: Float, endAngle: Float, thickness: Float, peak: Float) {
        self.cx = cx; self.cy = cy; self.radius = radius; self.startAngle = startAngle; self.endAngle = endAngle
        self.thickness = thickness; self.peak = peak
    }
}

/// Soft-edged rectangle that multiplies the diffuse (shadow / muddy region) or adds colour (reflection of a coloured object).
public struct RegionEffect: Sendable {
    public var x0: Float, y0: Float, x1: Float, y1: Float   // fractions
    public var gain: Float = 1
    public var add: (Float, Float, Float) = (0, 0, 0)       // linear-light addition
    public var feather: Float = 6                           // px
    public init(x0: Float, y0: Float, x1: Float, y1: Float, gain: Float = 1, add: (Float, Float, Float) = (0, 0, 0), feather: Float = 6) {
        self.x0 = x0; self.y0 = y0; self.x1 = x1; self.y1 = y1; self.gain = gain; self.add = add; self.feather = feather
    }
}

public struct LightingFrameSpec: Sendable {
    public var shadeAngle: Float = 0         // direction of the smooth illumination gradient (rad)
    public var shadeAmount: Float = 0.18
    public var gain: Float = 1
    public var glares: [GlareBlob] = []
    public var streaks: [Streak] = []
    public var regions: [RegionEffect] = []
    public init(shadeAngle: Float = 0, shadeAmount: Float = 0.18, gain: Float = 1, glares: [GlareBlob] = [], streaks: [Streak] = [], regions: [RegionEffect] = []) {
        self.shadeAngle = shadeAngle; self.shadeAmount = shadeAmount; self.gain = gain
        self.glares = glares; self.streaks = streaks; self.regions = regions
    }
}

public struct LightingSeries {
    public var frames: [RGBImage]            // display-encoded
    public var specs: [LightingFrameSpec]
    public var diffuse: RGBImage             // encoded, unshaded diffuse texture
    /// Defect-free rendering of each frame (diffuse × shading × gain, no glare/streak/tint/shadow) — encoded.
    public var clean: [RGBImage]
}

public enum SyntheticLighting {

    public static func shade(_ spec: LightingFrameSpec, x: Float, y: Float, width: Float, height: Float) -> Float {
        let u = x / width - 0.5, v = y / height - 0.5
        return spec.gain * (1 + spec.shadeAmount * (cosf(spec.shadeAngle) * u + sinf(spec.shadeAngle) * v) * 2)
    }

    public static func make(width: Int = 512, height: Int = 384, specs: [LightingFrameSpec], seed: UInt64 = 7, noise: Float = 0.002) -> LightingSeries {
        let diffuse = SyntheticSpecimen.texture(width: width, height: height, seed: seed)
        let lin = ColorMath.toLinear(diffuse)
        var rng = SplitMix64(seed: seed &+ 5)
        var frames: [RGBImage] = [], cleans: [RGBImage] = []
        let W = Float(width), H = Float(height)
        for spec in specs {
            var img = RGBImage(width: width, height: height), clean = RGBImage(width: width, height: height)
            for y in 0..<height {
                for x in 0..<width {
                    let fx = Float(x), fy = Float(y)
                    let sh = shade(spec, x: fx, y: fy, width: W, height: H)
                    var c = (lin.r[x, y] * sh, lin.g[x, y] * sh, lin.b[x, y] * sh)
                    clean.r[x, y] = c.0; clean.g[x, y] = c.1; clean.b[x, y] = c.2
                    for r in spec.regions {
                        let m = rectMask(fx, fy, r, W, H)
                        c = (c.0 * (1 + (r.gain - 1) * m) + r.add.0 * m, c.1 * (1 + (r.gain - 1) * m) + r.add.1 * m, c.2 * (1 + (r.gain - 1) * m) + r.add.2 * m)
                    }
                    for g in spec.glares {
                        let dx = fx - g.cx * W, dy = fy - g.cy * H, s = g.sigma * W
                        let a = g.amplitude * expf(-(dx * dx + dy * dy) / (2 * s * s))
                        c = (c.0 + a * g.tint.0, c.1 + a * g.tint.1, c.2 + a * g.tint.2)
                    }
                    for st in spec.streaks {
                        let dx = fx - st.cx * W, dy = fy - st.cy * H
                        let rr = hypotf(dx, dy), ang = atan2f(dy, dx)
                        let d = rr - st.radius * W
                        let sigma = st.thickness / 2.355
                        var prof = expf(-d * d / (2 * sigma * sigma))
                        // fade the ends of the arc
                        let t = (ang - st.startAngle) / max(st.endAngle - st.startAngle, 1e-3)
                        prof *= smoothstep(0, 0.12, t) * (1 - smoothstep(0.88, 1, t))
                        let a = st.peak * prof
                        c = (c.0 + a, c.1 + a, c.2 + a)
                    }
                    img.r[x, y] = c.0; img.g[x, y] = c.1; img.b[x, y] = c.2
                }
            }
            var enc = ColorMath.toEncoded(img)
            for j in 0..<enc.r.count {
                enc.r.pixels[j] += noise * rng.gaussian(); enc.g.pixels[j] += noise * rng.gaussian(); enc.b.pixels[j] += noise * rng.gaussian()
            }
            frames.append(enc.mapped { min(max($0, 0), 1) })
            cleans.append(ColorMath.toEncoded(clean).mapped { min(max($0, 0), 1) })
        }
        return LightingSeries(frames: frames, specs: specs, diffuse: diffuse, clean: cleans)
    }

    static func rectMask(_ x: Float, _ y: Float, _ r: RegionEffect, _ W: Float, _ H: Float) -> Float {
        let f = max(r.feather, 0.5)
        let mx = smoothstep(r.x0 * W - f, r.x0 * W + f, x) * (1 - smoothstep(r.x1 * W - f, r.x1 * W + f, x))
        let my = smoothstep(r.y0 * H - f, r.y0 * H + f, y) * (1 - smoothstep(r.y1 * H - f, r.y1 * H + f, y))
        return mx * my
    }

    // MARK: Reusable scenarios (shared by tests, lab CLI and the app's debug screen)

    /// Four light positions. Frame 0 (the natural "base") carries a broad clipped glare at (0.30, 0.32) and a thin,
    /// unclipped polished highlight; the others are clean at that spot but each has its own problems elsewhere:
    /// glare (1, 3), a magenta phone reflection (2) and a muddy shadow over the base's glare area (3).
    public static func standardScenario(width: Int = 512, height: Int = 384, seed: UInt64 = 7) -> LightingSeries {
        let streak0 = Streak(cx: 0.45, cy: 0.38, radius: 0.30, startAngle: 2.2, endAngle: 3.4, thickness: 3.5, peak: 0.45)
        let specs = [
            LightingFrameSpec(shadeAngle: 0.0, glares: [GlareBlob(cx: 0.30, cy: 0.32, sigma: 0.07, amplitude: 3.5)], streaks: [streak0]),
            LightingFrameSpec(shadeAngle: 1.6, glares: [GlareBlob(cx: 0.72, cy: 0.30, sigma: 0.07, amplitude: 3.5)]),
            LightingFrameSpec(shadeAngle: 3.1, regions: [RegionEffect(x0: 0.52, y0: 0.50, x1: 0.78, y1: 0.80, add: (0.30, 0.0, 0.26))]),
            LightingFrameSpec(shadeAngle: 4.7, gain: 0.95, glares: [GlareBlob(cx: 0.72, cy: 0.74, sigma: 0.06, amplitude: 3.0)],
                              regions: [RegionEffect(x0: 0.12, y0: 0.14, x1: 0.46, y1: 0.52, gain: 0.07, feather: 10)]),
        ]
        return make(width: width, height: height, specs: specs, seed: seed)
    }
}
