import Foundation
import SpecimenCore

public struct FocusSeries {
    public var frames: [RGBImage]            // display-encoded
    public var groundTruth: RGBImage         // all-in-focus, display-encoded, in reference geometry
    public var depth: Plane                  // 0…1
    public var focusDepths: [Float]          // depth at which each frame is sharp
    public var trueTransforms: [Affine2D]  // reference → frame
}

/// Depth-dependent defocus: a stack of Gaussian-blurred copies (blurred in linear light) interpolated per
/// pixel by |depth − focusDepth|. Optional per-frame jitter (translation, scale/"breathing", rotation) and noise.
public enum SyntheticFocus {

    public static func depthMap(width: Int, height: Int) -> Plane {
        var d = Plane(width: width, height: height)
        for y in 0..<height {
            for x in 0..<width {
                let u = Float(x) / Float(width), v = Float(y) / Float(height)
                var z = 0.15 + 0.7 * u                         // tilted plane
                let dome = hypotf(u - 0.42, (v - 0.45) * Float(height) / Float(width) * 1.0)
                if dome < 0.2 { z = 0.12 + 0.35 * (1 - dome / 0.2) * 0.0 + 0.0; z = 0.1 }   // near mesa with a hard step edge
                if u > 0.72 && v > 0.55 { z = 0.9 - 0.4 * (v - 0.55) }                       // far shelf, ramped
                d[x, y] = min(max(z, 0), 1)
            }
        }
        return d
    }

    public static func make(width: Int = 512, height: Int = 384, frames n: Int = 8, seed: UInt64 = 3,
                            maxSigma: Float = 4.5, noise: Float = 0.003,
                            jitter: Bool = false, breathing: Float = 0.0006) -> FocusSeries {
        let truth = SyntheticSpecimen.texture(width: width, height: height, seed: seed)
        let depth = depthMap(width: width, height: height)
        let linear = ColorMath.toLinear(truth)
        let levels = 10
        var blurred: [RGBImage] = []
        for k in 0..<levels {
            let s = maxSigma * Float(k) / Float(levels - 1)
            blurred.append(RGBImage(r: Filters.gaussianBlur(linear.r, sigma: s), g: Filters.gaussianBlur(linear.g, sigma: s), b: Filters.gaussianBlur(linear.b, sigma: s)))
        }
        var rng = SplitMix64(seed: seed &+ 99)
        var frames: [RGBImage] = []
        var depths: [Float] = []
        var transforms: [Affine2D] = []
        for i in 0..<n {
            let fd = Float(i) / Float(max(1, n - 1)) * 0.9 + 0.05
            depths.append(fd)
            var img = RGBImage(width: width, height: height)
            for y in 0..<height {
                for x in 0..<width {
                    let s = min(abs(depth[x, y] - fd) * 1.15, 1) * Float(levels - 1)
                    let k0 = min(Int(s), levels - 2), t = s - Float(k0)
                    img.r[x, y] = blurred[k0].r[x, y] * (1 - t) + blurred[k0 + 1].r[x, y] * t
                    img.g[x, y] = blurred[k0].g[x, y] * (1 - t) + blurred[k0 + 1].g[x, y] * t
                    img.b[x, y] = blurred[k0].b[x, y] * (1 - t) + blurred[k0 + 1].b[x, y] * t
                }
            }
            var T = Affine2D.identity
            if jitter || breathing > 0 {
                let sc = 1 + breathing * Float(i - n / 2)
                let tx = jitter ? Double((rng.uniform() - 0.5) * 3.0) : 0, ty = jitter ? Double((rng.uniform() - 0.5) * 3.0) : 0
                let rot = jitter ? Double((rng.uniform() - 0.5) * 0.002) : 0
                T = Affine2D.similarity(scale: Double(sc), rotation: rot, translation: (tx, ty), center: (Double(width) / 2, Double(height) / 2))
                img = Resample.warp(img, sourceOrigin: (0, 0), transform: T, outputRect: PixelRect(x: 0, y: 0, width: width, height: height))
            }
            var enc = ColorMath.toEncoded(img)
            if noise > 0 {
                for j in 0..<enc.r.count {
                    enc.r.pixels[j] += noise * rng.gaussian(); enc.g.pixels[j] += noise * rng.gaussian(); enc.b.pixels[j] += noise * rng.gaussian()
                }
            }
            frames.append(enc.mapped { min(max($0, 0), 1) })
            transforms.append(T)
        }
        return FocusSeries(frames: frames, groundTruth: truth, depth: depth, focusDepths: depths, trueTransforms: transforms)
    }
}
