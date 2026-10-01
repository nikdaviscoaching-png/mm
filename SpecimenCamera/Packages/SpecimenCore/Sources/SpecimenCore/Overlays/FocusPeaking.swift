import Foundation

public enum PeakingSensitivity: String, Codable, Sendable, CaseIterable {
    case off, low, medium, high
    public var title: String { rawValue.capitalized }
    /// Minimum fine-scale edge strength (0…255 luma units) for a pixel to count as an in-focus edge.
    var baseThreshold: Float {
        switch self { case .off: return .infinity; case .low: return 28; case .medium: return 18; case .high: return 11 }
    }
}

public enum PeakingColor: String, Codable, Sendable, CaseIterable {
    case red, yellow, green, cyan, blue, magenta, white
    public var title: String { rawValue.capitalized }
    /// sRGB components 0…1.
    public var rgb: (Float, Float, Float) {
        switch self {
        case .red: return (1, 0.05, 0.05)
        case .yellow: return (1, 0.9, 0)
        case .green: return (0.1, 1, 0.1)
        case .cyan: return (0, 0.9, 1)
        case .blue: return (0.2, 0.4, 1)
        case .magenta: return (1, 0, 0.9)
        case .white: return (1, 1, 1)
        }
    }
}

/// Focus peaking: marks genuinely in-focus, high-frequency edges — not blur, not flat noise.
///
/// Measure: the modified Laplacian at step 1 (|L(x−1) − 2L(x) + L(x+1)| + the vertical counterpart). A crisp edge of
/// contrast C gives ≈C at the pixels beside the edge; the same edge blurred over W pixels gives only ≈C/W, so an absolute
/// threshold separates them, and it tracks focus live. Two guards keep it from painting noise: the threshold is raised to
/// a multiple of the frame's own noise floor (median response), and a pixel is only marked if at least two neighbours also
/// respond (real edges are connected; sensor noise is speckle).
///
/// The Metal kernel in the app implements exactly this (threshold computed on the CPU from a sparse sample).
public enum FocusPeaking {

    public static func response(_ luma: UnsafeBufferPointer<UInt8>, x: Int, y: Int, width w: Int) -> Float {
        let i = y * w + x
        let c = Float(luma[i]) * 2
        let h = abs(c - Float(luma[i - 1]) - Float(luma[i + 1]))
        let v = abs(c - Float(luma[i - w]) - Float(luma[i + w]))
        return h + v
    }

    /// Noise-adaptive threshold for a frame (computed from a sparse sample of responses).
    public static func threshold(luma: UnsafeBufferPointer<UInt8>, width w: Int, height h: Int, sensitivity: PeakingSensitivity) -> Float {
        guard sensitivity != .off, w > 8, h > 8 else { return .infinity }
        var sample: [Float] = []
        sample.reserveCapacity((w / 7) * (h / 7))
        var y = 3
        while y < h - 3 { var x = 3; while x < w - 3 { sample.append(response(luma, x: x, y: y, width: w)); x += 7 }; y += 7 }
        return threshold(fromSampledResponses: sample, sensitivity: sensitivity)
    }

    /// Same threshold from responses sampled elsewhere (the app samples the camera buffer directly and feeds the GPU kernel
    /// the resulting value, so GPU and CPU paths share one rule).
    public static func threshold(fromSampledResponses responses: [Float], sensitivity: PeakingSensitivity) -> Float {
        guard sensitivity != .off else { return .infinity }
        var sample = responses
        sample.sort()
        // The 30th percentile tracks sensor noise even in a textured scene (most pixels are still flat-ish), where the
        // median would be inflated by real detail. For Gaussian noise 7× this value sits well above the noise tail.
        let p30 = sample.isEmpty ? 0 : sample[Int(Float(sample.count - 1) * 0.3)]
        let noiseFloor = min(p30 * 7.0, 170)
        return max(sensitivity.baseThreshold, noiseFloor)
    }

    /// Fraction of the threshold used for the neighbour-support test.
    public static let supportFraction: Float = 0.6
    /// Neighbours (of 8) that must respond for a pixel to be marked.
    public static let requiredNeighbours = 2

    /// Returns a w×h mask (0 or 255).
    public static func mask(luma: [UInt8], width w: Int, height h: Int, sensitivity: PeakingSensitivity) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: w * h)
        guard sensitivity != .off, w > 8, h > 8 else { return out }
        luma.withUnsafeBufferPointer { l in
            let t = threshold(luma: l, width: w, height: h, sensitivity: sensitivity)
            let soft = t * supportFraction
            out.withUnsafeMutableBufferPointer { o in
                for y in 2..<(h - 2) {
                    for x in 2..<(w - 2) {
                        let r = response(l, x: x, y: y, width: w)
                        if r < t { continue }
                        // neighbourhood support: ≥ 2 of 8 neighbours above the soft threshold
                        var n = 0
                        for dy in -1...1 { for dx in -1...1 where dx != 0 || dy != 0 {
                            if response(l, x: x + dx, y: y + dy, width: w) >= soft { n += 1 }
                        }}
                        if n >= requiredNeighbours { o[y * w + x] = 255 }
                    }
                }
            }
        }
        return out
    }

    /// Convenience for tests / non-Metal fallback: BGRA overlay (premultiplied) with the mask thickened by one pixel.
    public static func overlayBGRA(mask: [UInt8], width w: Int, height h: Int, color: PeakingColor, opacity: Float = 0.9) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: w * h * 4)
        let (r, g, b) = color.rgb
        let a = UInt8(min(max(opacity, 0), 1) * 255)
        for y in 0..<h { for x in 0..<w {
            var on = false
            for dy in -1...1 where !on { for dx in -1...1 where !on {
                let xx = x + dx, yy = y + dy
                if xx >= 0, yy >= 0, xx < w, yy < h, mask[yy * w + xx] != 0 { on = true }
            }}
            if on {
                let i = (y * w + x) * 4
                let af = Float(a) / 255
                out[i] = UInt8(b * af * 255); out[i + 1] = UInt8(g * af * 255); out[i + 2] = UInt8(r * af * 255); out[i + 3] = a
            }
        }}
        return out
    }
}

public enum ZebraLevel: String, Codable, Sendable, CaseIterable {
    case off, p95, p98, p100
    public var title: String { switch self { case .off: return "Off"; case .p95: return "95%"; case .p98: return "98%"; case .p100: return "100%" } }
    /// Minimum channel value (0…255) that triggers the stripes. 100 % means clipped (254–255 after rounding).
    public var threshold: UInt8? {
        switch self { case .off: return nil; case .p95: return 242; case .p98: return 250; case .p100: return 254 }
    }
}

public enum Zebra {
    /// BGRA input; a pixel is flagged when its brightest channel reaches the threshold, so a clipped red channel on a
    /// saturated reflection is caught even if luma is below white.
    public static func mask(bgra: [UInt8], width w: Int, height h: Int, level: ZebraLevel) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: w * h)
        guard let t = level.threshold else { return out }
        for i in 0..<(w * h) {
            let b = bgra[i * 4], g = bgra[i * 4 + 1], r = bgra[i * 4 + 2]
            if max(r, g, b) >= t { out[i] = 255 }
        }
        return out
    }

    /// Diagonal stripe pattern used by the renderer so zebras are distinguishable from real highlights.
    @inline(__always) public static func stripe(x: Int, y: Int, period: Int = 10) -> Bool { ((x + y) / (period / 2)) % 2 == 0 }
}

public enum HistogramMode: String, Codable, Sendable, CaseIterable {
    case off, luma, rgb
    public var title: String { switch self { case .off: return "Off"; case .luma: return "Luma"; case .rgb: return "RGB" } }
}

public struct HistogramData: Sendable, Equatable {
    public var luma = [Int](repeating: 0, count: 256)
    public var red = [Int](repeating: 0, count: 256)
    public var green = [Int](repeating: 0, count: 256)
    public var blue = [Int](repeating: 0, count: 256)
    public var sampleCount = 0
    public var clippedHighlightFraction: Float = 0     // any channel ≥ 254
    public var crushedShadowFraction: Float = 0        // luma ≤ 2
    public init() {}

    /// Normalised bin heights (0…1) with the tallest bin = 1; a log option keeps tonal tails visible.
    public func normalized(_ bins: [Int], logScale: Bool) -> [Float] {
        let f: [Float] = bins.map { logScale ? log1pf(Float($0)) : Float($0) }
        let m = max(f.max() ?? 1, 1e-6)
        return f.map { $0 / m }
    }
}

public enum HistogramRenderer {
    /// Samples a BGRA buffer on a stride so the cost stays tiny (a ~100×100 sample is plenty for a compact display).
    public static func compute(bgra: UnsafeBufferPointer<UInt8>, width w: Int, height h: Int, bytesPerRow: Int, targetSamples: Int = 20_000) -> HistogramData {
        var d = HistogramData()
        guard w > 0, h > 0 else { return d }
        let step = max(1, Int(sqrt(Double(w * h) / Double(targetSamples))))
        var clipped = 0, crushed = 0
        var y = 0
        while y < h {
            var x = 0
            while x < w {
                let i = y * bytesPerRow + x * 4
                let b = Int(bgra[i]), g = Int(bgra[i + 1]), r = Int(bgra[i + 2])
                let l = (r * 54 + g * 183 + b * 19) >> 8       // Rec.709-ish integer luma
                d.luma[l] += 1; d.red[r] += 1; d.green[g] += 1; d.blue[b] += 1
                if max(r, g, b) >= 254 { clipped += 1 }
                if l <= 2 { crushed += 1 }
                d.sampleCount += 1
                x += step
            }
            y += step
        }
        if d.sampleCount > 0 {
            d.clippedHighlightFraction = Float(clipped) / Float(d.sampleCount)
            d.crushedShadowFraction = Float(crushed) / Float(d.sampleCount)
        }
        return d
    }
}
