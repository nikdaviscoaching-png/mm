import Foundation

public struct LightingStackOptions: Sendable {
    public var levels = 5
    public var tileSize = 768
    public var concurrency = 2
    /// Live worker limit (thermal management); asked before every tile. nil = fixed `concurrency`.
    public var concurrencyProvider: (@Sendable () -> Int)? = nil
    /// Memory budget (bytes) for the proxy-resolution analysis data; the proxy shrinks as the frame count grows.
    public var analysisBudgetBytes = 240_000_000
    public var maxProxyPixels = 1_500_000
    public var minProxyPixels = 300_000
    /// Highlights narrower than this fraction of the long image side count as "narrow polished highlights".
    public var narrowHighlightFraction: Float = 0.012
    /// Selection sharpness among replacement candidates.
    public var qualityPower: Float = 3
    /// A frame replaces the base only where its quality exceeds the base's by `replaceMargin.lowerBound`…`.upperBound`.
    public var replaceMargin: ClosedRange<Float> = 0.12...0.45
    /// Local luminance matching of replacement content to the base's lighting (smooth, low-frequency only).
    public var matchLocalLighting = true
    public var gainSigmaFraction: Float = 0.04
    /// Force a particular frame to be the base (natural lighting reference); nil = chosen automatically.
    public var preferredBase: Int? = nil
    public init() {}

    public static func preset(_ q: StackQuality) -> LightingStackOptions {
        var o = LightingStackOptions()
        switch q {
        case .fast: o.levels = 4; o.maxProxyPixels = 600_000
        case .high: break
        case .maximum: o.levels = 6; o.tileSize = 896; o.maxProxyPixels = 2_000_000
        }
        return o
    }
    var halo: Int { Pyramid.haloFor(levels: levels) }
}

/// Everything the lighting analysis decides, at proxy resolution (full-resolution synthesis consumes it).
public struct LightingAnalysis: Sendable {
    public let proxyFactor: Int
    public let width: Int, height: Int           // proxy dimensions
    public let fullWidth: Int, fullHeight: Int
    public let baseIndex: Int
    public let frameScores: [Float]
    public let quality: [Plane]                  // per-frame region quality 0…1
    public let weights: [Plane]                  // normalised blend weights (sum = 1)
    public let gains: [Plane]                    // per-frame multiplicative linear-light gain (matches the base's lighting)
    /// Fraction of the image (0…1) taken from each frame (weight mass).
    public var contribution: [Float] { weights.map { $0.mean } }
}

/// Region-quality analysis for lighting stacks.
///
/// This is deliberately *not* exposure fusion. Frames are scored on how trustworthy each region is as a record of the
/// specimen, using clipping and its spatial extent, local detail, whitening and colour contamination relative to the
/// other frames, and exposure. Because the real specimen detail stays put while reflections move with the light, a
/// cross-frame comparison separates the two. A natural base frame defines the lighting character; other frames replace
/// it only where they are decisively better, so legitimate polished highlights in the base survive.
public enum LightingAnalysisEngine {

    public static func proxyPixels(frameCount n: Int, options: LightingStackOptions) -> Int {
        let perPixel = 52 * max(n, 1)       // bytes per proxy pixel across the kept per-frame planes
        return min(options.maxProxyPixels, max(options.minProxyPixels, options.analysisBudgetBytes / perPixel))
    }

    public static func analyze(frames: [any FrameSource], options: LightingStackOptions = .init(),
                               progress: ProgressSlice? = nil, isCancelled: CancelCheck? = nil) throws -> LightingAnalysis {
        guard frames.count >= 2 else { throw SpecimenError.insufficientFrames(needed: 2, got: frames.count) }
        let n = frames.count
        let W = frames[0].width, H = frames[0].height
        for (i, f) in frames.enumerated() where f.width != W || f.height != H {
            throw SpecimenError.dimensionMismatch("frame \(i) is \(f.width)×\(f.height), expected \(W)×\(H)")
        }
        let k = frames[0].colorSpace.luma
        let factor = ImageRegistrationEngine.proxyFactor(width: W, height: H, maxPixels: proxyPixels(frameCount: n, options: options))
        var prox: [RGBImage] = []
        for (i, f) in frames.enumerated() {
            if isCancelled?() == true { throw SpecimenError.cancelled }
            prox.append(try f.readDownscaled(factor: factor))
            progress?.report(.analyzingLighting, i + 1, n, sub: Double(i + 1) / Double(n) * 0.4)
        }
        let w = prox[0].width, h = prox[0].height
        let count = w * h
        let longSide = Float(max(w, h))
        let rN = max(1, Int((options.narrowHighlightFraction * longSide).rounded()))

        // Per-frame features -----------------------------------------------------------------------------
        let noise = FocusMapBuilder.estimateNoise(luma: prox[n / 2].luma(k))
        let builder = FocusMapBuilder(noiseSigma: noise, luma: k, aggregationSigma: 2.0)
        var Y: [Plane] = [], YL: [Plane] = [], detail: [Plane] = []
        var chroma: [(Plane, Plane)] = []
        // clipped broad areas / broad near-white areas / thin clipped streaks (see opening by the narrow-highlight width)
        var broadClip: [Plane] = [], broadBright: [Plane] = [], thinClip: [Plane] = []
        for p in prox {
            let y = p.luma(k); Y.append(y)
            YL.append(ColorMath.toLinear(p).luma(k))
            detail.append(builder.map(for: p))
            var cr = Plane(width: w, height: h), cb = Plane(width: w, height: h)
            var hard = Plane(width: w, height: h), bright = Plane(width: w, height: h)
            for i in 0..<count {
                let d = y.pixels[i] + 0.1
                cr.pixels[i] = (p.r.pixels[i] - y.pixels[i]) / d
                cb.pixels[i] = (p.b.pixels[i] - y.pixels[i]) / d
                hard.pixels[i] = max(p.r.pixels[i], p.g.pixels[i], p.b.pixels[i]) >= 0.985 ? 1 : 0
                bright.pixels[i] = y.pixels[i] >= 0.88 ? 1 : 0
            }
            chroma.append((cr, cb))
            // Opening (erode then dilate) keeps broad regions and removes anything narrower than ~2·rN: thin polished
            // highlights are not glare.
            let bc = Filters.dilate(Filters.erode(hard, radius: rN), radius: rN)
            broadClip.append(bc)
            broadBright.append(Filters.dilate(Filters.erode(bright, radius: rN), radius: rN))
            thinClip.append(Filters.combine(hard, bc) { max(0, $0 - $1) })
        }
        if isCancelled?() == true { throw SpecimenError.cancelled }

        // Cross-frame references -------------------------------------------------------------------------
        var yRef = Plane(width: w, height: h), yDark = yRef, yChroma = yRef, crRef = yRef, cbRef = yRef, dMax = yRef, yMed = yRef
        let lowIdx = Int(Float(n - 1) * 0.3)
        var tmp = [Float](repeating: 0, count: n)
        var order = [Int](repeating: 0, count: n)
        for i in 0..<count {
            for j in 0..<n { tmp[j] = Y[j].pixels[i] }
            tmp.sort(); yRef.pixels[i] = tmp[lowIdx]; yMed.pixels[i] = tmp[n / 2]
            // Reflections and glare only ever ADD light, so body colour and "normal" brightness are read from the DARKEST
            // frame — except a frame lying in shadow, which would make every other frame look washed or off-colour (the
            // chroma measure is not shadow-invariant). With ≥3 frames, a frame below half the second-darkest value is
            // treated as shadowed and skipped. With only two frames shadow and clean cannot be told apart by brightness,
            // so the darkest is used. Only frames BRIGHTER than the reference are candidates for contamination.
            for j in 0..<n { order[j] = j }
            order.sort { Y[$0].pixels[i] < Y[$1].pixels[i] }
            var refFrame = order[0]
            if n >= 3 {
                let second = Y[order[1]].pixels[i]
                refFrame = order[n - 1]
                for j in order where Y[j].pixels[i] >= 0.5 * second { refFrame = j; break }
            }
            yDark.pixels[i] = Y[refFrame].pixels[i]
            yChroma.pixels[i] = Y[refFrame].pixels[i]
            crRef.pixels[i] = chroma[refFrame].0.pixels[i]
            cbRef.pixels[i] = chroma[refFrame].1.pixels[i]
            var m: Float = 0
            for j in 0..<n { m = max(m, detail[j].pixels[i]) }
            dMax.pixels[i] = m
        }
        yRef = Filters.gaussianBlur(yRef, sigma: 1)
        dMax = Filters.gaussianBlur(dMax, sigma: 2)

        // Per-frame quality ------------------------------------------------------------------------------
        var Q: [Plane] = []
        let qSigma = max(0.8, longSide * 0.002)
        for j in 0..<n {
            // Broad regions much brighter than the darkest unshadowed frame are a wash of added light (glare tails,
            // reflections of bright objects) even when nothing clips. Thin additions are legitimate highlights and are
            // removed by the opening, exactly as for clipped areas.
            var added = Plane(width: w, height: h)
            for i in 0..<count {
                let d = ColorMath.decode(yDark.pixels[i]) + 0.06
                let rel = (ColorMath.decode(Y[j].pixels[i]) - ColorMath.decode(yDark.pixels[i])) / d
                added.pixels[i] = smoothstep(0.5, 1.0, rel) >= 0.5 ? 1 : 0
            }
            let broadAdd = Filters.dilate(Filters.erode(added, radius: rN), radius: rN)
            var glare = Plane(width: w, height: h)
            for i in 0..<count {
                let excess = smoothstep(0.04, 0.22, Y[j].pixels[i] - yDark.pixels[i])
                glare.pixels[i] = max(max(broadClip[j].pixels[i], broadBright[j].pixels[i] * excess), broadAdd.pixels[i])
            }
            // bloom: washed colour extends past the clipped core
            let zone = Filters.gaussianBlur(Filters.dilate(glare, radius: rN), sigma: Float(rN))
            // Colour deviation from the darkest frame (washed-out or tinted colour). Like clipping, it only counts when it is
            // BROAD: a thin highlight also desaturates its pixels but is legitimate, so the deviation field is grey-opened by
            // the narrow-highlight width before it is used.
            var devField = Plane(width: w, height: h)
            for i in 0..<count {
                let conf = smoothstep(0.03, 0.12, max(Y[j].pixels[i], yMed.pixels[i]))
                let dcr = chroma[j].0.pixels[i] - crRef.pixels[i], dcb = chroma[j].1.pixels[i] - cbRef.pixels[i]
                devField.pixels[i] = sqrtf(dcr * dcr + dcb * dcb) * conf * smoothstep(0.0, 0.06, Y[j].pixels[i] - yChroma.pixels[i])
            }
            let devBroad = Filters.dilate(Filters.erode(devField, radius: rN), radius: rN)
            var q = Plane(width: w, height: h)
            for i in 0..<count {
                let gz = min(1, zone.pixels[i] * 1.25)
                let qClip = 1 - 0.98 * gz - 0.10 * thinClip[j].pixels[i]
                let rel = (detail[j].pixels[i] + 0.15) / (dMax.pixels[i] + 0.15)
                let qDetail = 0.55 + 0.45 * smoothstep(0.15, 0.7, rel)
                let qColor = 0.03 + 0.97 * (1 - smoothstep(0.10, 0.40, devBroad.pixels[i]))
                let qExpo = 0.10 + 0.90 * smoothstep(0.025, 0.14, Y[j].pixels[i])
                q.pixels[i] = max(qClip, 0.02) * qDetail * qColor * qExpo
            }
            let qs = Filters.gaussianBlur(q, sigma: qSigma)
            Q.append(qs)
            progress?.report(.buildingQualityMaps, j + 1, n, sub: 0.4 + Double(j + 1) / Double(n) * 0.35)
            if isCancelled?() == true { throw SpecimenError.cancelled }
        }
        broadClip.removeAll(); broadBright.removeAll(); thinClip.removeAll(); detail.removeAll(); chroma.removeAll()

        // Base frame --------------------------------------------------------------------------------------
        // The repaired composite is about equally good whichever frame is the base (defects get replaced), so the base
        // mainly defines lighting character. The cleanest frame (highest mean quality) is the default; the caller can
        // override with `preferredBase` (the app's reprocess screen exposes this). Automatic "gloss" detection was tried
        // and removed: it was fooled whenever several frames were corrupted at once.
        let scores: [Float] = Q.map { $0.mean }
        var base = 0
        for j in 1..<n where scores[j] > scores[base] { base = j }
        if let pb = options.preferredBase, pb >= 0, pb < n { base = pb }

        // Replacement weights ----------------------------------------------------------------------------
        let (m0, m1) = (options.replaceMargin.lowerBound, options.replaceMargin.upperBound)
        var weights = [Plane](repeating: Plane(width: w, height: h), count: n)
        var u = [Float](repeating: 0, count: n)
        for i in 0..<count {
            let qb = Q[base].pixels[i]
            var rMax: Float = 0, norm: Float = 0
            for j in 0..<n where j != base {
                let a = smoothstep(m0, m1, Q[j].pixels[i] - qb)
                rMax = max(rMax, a)
                u[j] = a * powf(max(Q[j].pixels[i], 1e-4), options.qualityPower); norm += u[j]
            }
            for j in 0..<n where j != base { weights[j].pixels[i] = norm > 0 ? rMax * u[j] / norm : 0 }
            weights[base].pixels[i] = 1 - rMax
        }
        // spatial coherence: drop specks, then edge-aware smoothing guided by the base's own structure
        let guide = Y[base]
        var replaceMass = Plane(width: w, height: h)
        for j in 0..<n where j != base { replaceMass.addScaled(weights[j], 1) }
        let cleaned = Filters.gaussianBlur(replaceMass, sigma: max(1.0, longSide * 0.004)).mapped { smoothstep(0.2, 0.7, $0) }
        for i in 0..<count where replaceMass.pixels[i] > 1e-6 {
            let scale = min(replaceMass.pixels[i], cleaned.pixels[i]) / replaceMass.pixels[i]
            for j in 0..<n where j != base { weights[j].pixels[i] *= scale }
        }
        let gr = max(2, Int(longSide * 0.008))
        for j in 0..<n where j != base {
            weights[j] = Filters.guidedFilter(guide: guide, input: weights[j], radius: gr, epsilon: 2e-3).mapped { clamp01($0) }
        }
        for i in 0..<count {
            var s: Float = 0
            for j in 0..<n where j != base { s += weights[j].pixels[i] }
            if s > 1 { for j in 0..<n where j != base { weights[j].pixels[i] /= s }; s = 1 }
            weights[base].pixels[i] = 1 - s
        }
        progress?.report(.selectingRegions, 1, 1, sub: 0.85)

        // Local lighting match: smooth multiplicative gain bringing frame j's low-frequency lighting in line with the
        // base's, estimated only where *both* frames are trustworthy and extrapolated smoothly into the defect.
        var gains = [Plane](repeating: Plane(width: w, height: h, value: 1), count: n)
        if options.matchLocalLighting {
            let sg = max(2, longSide * options.gainSigmaFraction)
            for j in 0..<n where j != base {
                var num = Plane(width: w, height: h), den = Plane(width: w, height: h)
                for i in 0..<count {
                    let trust = smoothstep(0.45, 0.8, Q[j].pixels[i]) * smoothstep(0.45, 0.8, Q[base].pixels[i])
                    num.pixels[i] = trust * (logf(YL[base].pixels[i] + 0.01) - logf(YL[j].pixels[i] + 0.01))
                    den.pixels[i] = trust
                }
                let nb = Filters.gaussianBlur(num, sigma: sg), db = Filters.gaussianBlur(den, sigma: sg)
                var g = Plane(width: w, height: h, value: 1)
                for i in 0..<count where db.pixels[i] > 1e-3 {
                    g.pixels[i] = min(max(expf(nb.pixels[i] / db.pixels[i]), 0.55), 1.8)
                }
                gains[j] = g
            }
        }
        progress?.report(.selectingRegions, 1, 1, sub: 1)
        return LightingAnalysis(proxyFactor: factor, width: w, height: h, fullWidth: W, fullHeight: H, baseIndex: base,
                                frameScores: scores, quality: Q, weights: weights, gains: gains)
    }
}
