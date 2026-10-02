import Foundation

/// Multi-signal local focus measure.
///
/// No single metric is trusted: fine-scale modified Laplacian, colour gradient (so hue-only band edges count),
/// band-pass energy at two scales (the spatial-domain equivalent of a frequency-band energy ratio) and local
/// contrast are each aggregated over a small window, noise-floor corrected with a calibrated floor, scaled by
/// fixed constants (so every tile is measured identically — no tile-dependent normalisation, no seams) and combined.
public struct FocusSignalWeights: Sendable {
    public var modifiedLaplacian: Float = 0.30
    public var gradient: Float = 0.25
    public var bandFine: Float = 0.20
    public var bandMedium: Float = 0.15
    public var localContrast: Float = 0.10
    public init() {}
}

public struct FocusMapBuilder: Sendable {
    public let noiseSigma: Float            // white-noise σ in the encoded domain
    public let luma: LumaCoefficients
    public let weights: FocusSignalWeights
    public let aggregationSigma: Float
    private let floors: [Float]             // per-signal noise floors (already scaled by noiseSigma)

    // Fixed per-signal scale constants: roughly the response of a crisp, moderately contrasty edge region.
    static let scales: [Float] = [0.20, 0.15, 0.06, 0.05, 0.12]
    static let floorFactor: Float = 1.6

    public init(noiseSigma: Float, luma: LumaCoefficients, weights: FocusSignalWeights = .init(), aggregationSigma: Float = 2.0) {
        self.noiseSigma = max(noiseSigma, 1e-4)
        self.luma = luma; self.weights = weights; self.aggregationSigma = aggregationSigma
        let unit = FocusMapBuilder.signals(of: FocusMapBuilder.unitNoiseTile, luma: luma, sigmaAgg: aggregationSigma)
        // mean response over the interior (avoid edge replication effects)
        floors = unit.map { s -> Float in
            var acc: Double = 0, n = 0.0
            for y in 16..<(s.height - 16) { for x in 16..<(s.width - 16) { acc += Double(s[x, y]); n += 1 } }
            return Float(acc / n) * FocusMapBuilder.floorFactor * max(noiseSigma, 1e-4)
        }
    }

    static let unitNoiseTile: RGBImage = {
        var rng = FocusRNG(seed: 12345)
        var img = RGBImage(width: 96, height: 96)
        for i in 0..<img.r.count { img.r.pixels[i] = rng.gaussian(); img.g.pixels[i] = rng.gaussian(); img.b.pixels[i] = rng.gaussian() }
        return img
    }()

    /// RMS-aggregated signal planes in the order of `scales` (encoded-domain input).
    static func signals(of img: RGBImage, luma k: LumaCoefficients, sigmaAgg: Float) -> [Plane] {
        let y = img.luma(k)
        let w = y.width, h = y.height
        // modified Laplacian, steps 1 and 2 averaged
        var ml = Plane(width: w, height: h)
        for yy in 0..<h { for xx in 0..<w {
            let c = y[xx, yy]
            let a1 = abs(2 * c - y.clamped(xx - 1, yy) - y.clamped(xx + 1, yy)) + abs(2 * c - y.clamped(xx, yy - 1) - y.clamped(xx, yy + 1))
            let a2 = abs(2 * c - y.clamped(xx - 2, yy) - y.clamped(xx + 2, yy)) + abs(2 * c - y.clamped(xx, yy - 2) - y.clamped(xx, yy + 2))
            ml[xx, yy] = 0.5 * (a1 + 0.7 * a2)
        }}
        // colour gradient magnitude (Sobel on each channel)
        var gr = Plane(width: w, height: h)
        let chans = [img.r, img.g, img.b]
        for yy in 0..<h { for xx in 0..<w {
            var e: Float = 0
            for c in chans {
                let gx = (c.clamped(xx + 1, yy - 1) + 2 * c.clamped(xx + 1, yy) + c.clamped(xx + 1, yy + 1)) - (c.clamped(xx - 1, yy - 1) + 2 * c.clamped(xx - 1, yy) + c.clamped(xx - 1, yy + 1))
                let gy = (c.clamped(xx - 1, yy + 1) + 2 * c.clamped(xx, yy + 1) + c.clamped(xx + 1, yy + 1)) - (c.clamped(xx - 1, yy - 1) + 2 * c.clamped(xx, yy - 1) + c.clamped(xx + 1, yy - 1))
                e += gx * gx + gy * gy
            }
            gr[xx, yy] = sqrtf(e / 3) * 0.125
        }}
        let g08 = Filters.gaussianBlur(y, sigma: 0.8), g16 = Filters.gaussianBlur(y, sigma: 1.6), g32 = Filters.gaussianBlur(y, sigma: 3.2)
        let bf = Filters.subtract(g08, g16), bm = Filters.subtract(g16, g32)
        let mean2 = Filters.gaussianBlur(y, sigma: 2), meanSq2 = Filters.gaussianBlur(y.squared(), sigma: 2)
        var lc = Plane(width: w, height: h)
        for i in 0..<lc.count { lc.pixels[i] = sqrtf(max(0, meanSq2.pixels[i] - mean2.pixels[i] * mean2.pixels[i])) }
        return [ml, gr, bf, bm, lc].map { rmsAggregate($0, sigma: sigmaAgg) }
    }

    static func rmsAggregate(_ a: Plane, sigma: Float) -> Plane {
        let g = Filters.gaussianBlur(a.squared(), sigma: sigma)
        return g.mapped { sqrtf(max($0, 0)) }
    }

    /// Focus confidence map (≥ 0, ≈ 0 for blur/flat, larger for crisp detail) for an encoded-domain tile.
    public func map(for encoded: RGBImage) -> Plane { maps(for: encoded).focus }

    /// `focus`: all signals combined. `fine`: only the finest-scale signals (step-1 modified Laplacian and the
    /// fine band-pass). Defocus *bleed* — a blurred bright neighbour leaking into a flat area — carries energy at
    /// medium scales but almost none at the finest, so `fine` is what flat regions may safely inherit.
    public func maps(for encoded: RGBImage) -> (focus: Plane, fine: Plane) {
        let sig = FocusMapBuilder.signals(of: encoded, luma: luma, sigmaAgg: aggregationSigma)
        let wts = [weights.modifiedLaplacian, weights.gradient, weights.bandFine, weights.bandMedium, weights.localContrast]
        var out = Plane(width: encoded.width, height: encoded.height)
        var fine = Plane(width: encoded.width, height: encoded.height)
        for k in [0, 2] {
            let scale = FocusMapBuilder.scales[k], floor = floors[k], wt: Float = k == 0 ? 0.6 : 0.4
            sig[k].pixels.withUnsafeBufferPointer { s in
                fine.pixels.withUnsafeMutableBufferPointer { o in
                    for i in 0..<o.count { o[i] += wt * max(0, s[i] - floor) / scale }
                }
            }
        }
        for k in 0..<sig.count {
            let scale = FocusMapBuilder.scales[k], floor = floors[k], wt = wts[k]
            sig[k].pixels.withUnsafeBufferPointer { s in
                out.pixels.withUnsafeMutableBufferPointer { o in
                    for i in 0..<o.count { o[i] += wt * max(0, s[i] - floor) / scale }
                }
            }
        }
        return (out, fine)
    }

    /// Immerkær fast noise estimate (σ of white noise) from a luma plane; robust median-based.
    public static func estimateNoise(luma y: Plane) -> Float {
        var vals = Plane(width: max(0, y.width - 2), height: max(0, y.height - 2))
        guard vals.width > 0, vals.height > 0 else { return 0.003 }
        for yy in 1..<(y.height - 1) { for xx in 1..<(y.width - 1) {
            let v = y[xx - 1, yy - 1] - 2 * y[xx, yy - 1] + y[xx + 1, yy - 1]
                  - 2 * y[xx - 1, yy] + 4 * y[xx, yy] - 2 * y[xx + 1, yy]
                  + y[xx - 1, yy + 1] - 2 * y[xx, yy + 1] + y[xx + 1, yy + 1]
            vals[xx - 1, yy - 1] = abs(v)
        }}
        // median(|N(0,36σ²)|) = 0.6745·6σ
        return max(0.0005, vals.median() / (0.6745 * 6))
    }
}

/// Small deterministic RNG local to the library (calibration tiles must be identical on every run).
struct FocusRNG {
    var state: UInt64
    init(seed: UInt64) { state = seed &+ 0x9E3779B97F4A7C15 }
    mutating func next() -> UInt64 {
        state = state &+ 0x9E3779B97F4A7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58476D1CE4E5B9
        z = (z ^ (z >> 27)) &* 0x94D049BB133111EB
        return z ^ (z >> 31)
    }
    mutating func uniform() -> Float { Float(next() >> 40) / Float(1 << 24) }
    mutating func gaussian() -> Float {
        let u1 = max(uniform(), 1e-7), u2 = uniform()
        return sqrtf(-2 * logf(u1)) * cosf(2 * .pi * u2)
    }
}
