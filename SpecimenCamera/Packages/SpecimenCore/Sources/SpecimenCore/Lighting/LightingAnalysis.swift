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
    public let gains: [Plane]                    // per-frame multiplicative linear-light gain (matches the base's lighting for blending)
    /// Natural log of how much brighter (>0) or darker (<0) the frames that were chosen are, in their own exposure, than the
    /// same content on the base's scale (smooth). It bounds the tone adjustment: a region is never pushed beyond what the
    /// better exposed frame itself shows.
    public let restore: Plane
    /// 0…1, smooth: how much of each pixel comes from a frame other than the base. The tone adjustment only acts there.
    public let repaired: Plane
    /// Tone mapping of the extended range that the repair brought in (see `ToneAdjustment`).
    public let tone: ToneAdjustment
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
        // Fine dark structure inside a BLOWN-OUT area (hairline veins, hatching, grain boundaries) must not turn an overexposed
        // patch into "thin highlights": for clipped pixels gaps up to ~2·rc are closed before the width test, so a hatched white
        // patch is one broad region (nothing is recorded in it) while an isolated narrow streak (a real glint) stays narrow.
        let rc = max(1, Int((0.004 * longSide).rounded()))
        func broadRegions(_ m: Plane, closing: Bool = false) -> Plane {
            let c = closing ? Filters.erode(Filters.dilate(m, radius: rc), radius: rc) : m
            return Filters.dilate(Filters.erode(c, radius: rN), radius: rN)
        }

        // Exposure / lighting normalisation --------------------------------------------------------------
        // Frames of one scene taken with different light (or different exposure) are not comparable pixel for pixel: a frame that
        // is simply better lit is brighter everywhere, which the glare cues below would mistake for "added light" and reject. So
        // every frame is first put on the reference frame's SMOOTH lighting/exposure scale; only local anomalies (glare,
        // reflections, shadows) then stand out. Clipping and exposure quality keep using the real, un-normalised values.
        let Y0 = prox.map { $0.luma(k) }
        let YL0 = prox.map { ColorMath.toLinear($0).luma(k) }
        let refIdx = LightingNormalizer.referenceFrame(Y0)
        var scales: [Plane] = []
        for j in 0..<n {
            if j == refIdx { scales.append(Plane(width: w, height: h, value: 1)); continue }
            scales.append(LightingNormalizer.lnGainField(refY: Y0[refIdx], refYL: YL0[refIdx], frameY: Y0[j], frameYL: YL0[j]).mapped { expf($0) })
        }

        // Per-frame features -----------------------------------------------------------------------------
        let noise = FocusMapBuilder.estimateNoise(luma: prox[n / 2].luma(k))
        let builder = FocusMapBuilder(noiseSigma: noise, luma: k, aggregationSigma: 2.0)
        var Y: [Plane] = [], Yn: [Plane] = [], YL: [Plane] = [], detail: [Plane] = []
        var chroma: [(Plane, Plane)] = []
        // clipped broad areas / broad near-white areas / thin clipped streaks (see opening by the narrow-highlight width)
        var broadClip: [Plane] = [], broadBright: [Plane] = [], thinClip: [Plane] = []
        var informative: [Float] = []        // share of pixels that are neither crushed nor clipped, per frame
        for (idx, p) in prox.enumerated() {
            let y = p.luma(k); Y.append(y)
            YL.append(YL0[idx])
            detail.append(builder.map(for: p))
            // the same frame on the reference's lighting scale (for the cross-frame cues)
            var pn = ColorMath.toLinear(p)
            pn.r.multiply(by: scales[idx]); pn.g.multiply(by: scales[idx]); pn.b.multiply(by: scales[idx])
            let pe = ColorMath.toEncoded(pn).mapped { clamp01($0) }
            let yn = pe.luma(k); Yn.append(yn)
            var cr = Plane(width: w, height: h), cb = Plane(width: w, height: h)
            var hard = Plane(width: w, height: h), bright = Plane(width: w, height: h)
            for i in 0..<count {
                let d = yn.pixels[i] + 0.1
                cr.pixels[i] = (pe.r.pixels[i] - yn.pixels[i]) / d
                cb.pixels[i] = (pe.b.pixels[i] - yn.pixels[i]) / d
                hard.pixels[i] = max(p.r.pixels[i], p.g.pixels[i], p.b.pixels[i]) >= 0.985 ? 1 : 0
                bright.pixels[i] = y.pixels[i] >= 0.88 ? 1 : 0
            }
            chroma.append((cr, cb))
            var info: Float = 0
            for i in 0..<count { info += smoothstep(0.03, 0.08, y.pixels[i]) * (1 - hard.pixels[i]) }
            informative.append(info / Float(count))
            // Opening (erode then dilate) keeps broad regions and removes anything narrower than ~2·rN: thin polished
            // highlights are not glare.
            let bc = broadRegions(hard, closing: true)
            broadClip.append(bc)
            broadBright.append(broadRegions(bright))
            thinClip.append(Filters.combine(hard, bc) { max(0, $0 - $1) })
        }
        if isCancelled?() == true { throw SpecimenError.cancelled }

        // Cross-frame references -------------------------------------------------------------------------
        var yRef = Plane(width: w, height: h), yDark = yRef, yChroma = yRef, crRef = yRef, cbRef = yRef, dMax = yRef, yMed = yRef
        let lowIdx = Int(Float(n - 1) * 0.3)
        var tmp = [Float](repeating: 0, count: n)
        var order = [Int](repeating: 0, count: n)
        for i in 0..<count {
            for j in 0..<n { tmp[j] = Yn[j].pixels[i] }
            tmp.sort(); yRef.pixels[i] = tmp[lowIdx]; yMed.pixels[i] = tmp[n / 2]
            // Reflections and glare only ever ADD light, so body colour and "normal" brightness are read from the DARKEST
            // frame — except a frame lying in shadow, which would make every other frame look washed or off-colour (the
            // chroma measure is not shadow-invariant). With ≥3 frames, a frame below half the second-darkest value is
            // treated as shadowed and skipped. With only two frames shadow and clean cannot be told apart by brightness,
            // so the darkest is used. Only frames BRIGHTER than the reference are candidates for contamination.
            for j in 0..<n { order[j] = j }
            order.sort { Yn[$0].pixels[i] < Yn[$1].pixels[i] }
            var refFrame = order[0]
            if n >= 3 {
                let second = Yn[order[1]].pixels[i]
                refFrame = order[n - 1]
                for j in order where Yn[j].pixels[i] >= 0.5 * second { refFrame = j; break }
            }
            yDark.pixels[i] = Yn[refFrame].pixels[i]
            yChroma.pixels[i] = Yn[refFrame].pixels[i]
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
        var Qv: [Plane] = []          // validity for brightness matching: clipping/glare and colour only (dark but measurable pixels count)
        let qSigma = max(0.8, longSide * 0.002)
        for j in 0..<n {
            // Broad regions much brighter than the darkest unshadowed frame are a wash of added light (glare tails,
            // reflections of bright objects) even when nothing clips. Thin additions are legitimate highlights and are
            // removed by the opening, exactly as for clipped areas.
            var added = Plane(width: w, height: h)
            for i in 0..<count {
                let d = ColorMath.decode(yDark.pixels[i]) + 0.06
                let rel = (ColorMath.decode(Yn[j].pixels[i]) - ColorMath.decode(yDark.pixels[i])) / d
                added.pixels[i] = smoothstep(0.5, 1.0, rel) >= 0.5 ? 1 : 0
            }
            let broadAdd = Filters.dilate(Filters.erode(added, radius: rN), radius: rN)
            var glare = Plane(width: w, height: h)
            for i in 0..<count {
                let excess = smoothstep(0.04, 0.22, Yn[j].pixels[i] - yDark.pixels[i])
                glare.pixels[i] = max(max(broadClip[j].pixels[i], broadBright[j].pixels[i] * excess), broadAdd.pixels[i])
            }
            // bloom: washed colour extends past the clipped core
            let zone = Filters.gaussianBlur(Filters.dilate(glare, radius: rN), sigma: Float(rN))
            // Colour deviation from the darkest frame (washed-out or tinted colour). Like clipping, it only counts when it is
            // BROAD: a thin highlight also desaturates its pixels but is legitimate, so the deviation field is grey-opened by
            // the narrow-highlight width before it is used.
            var devField = Plane(width: w, height: h)
            for i in 0..<count {
                let conf = smoothstep(0.03, 0.12, max(Yn[j].pixels[i], yMed.pixels[i]))
                let dcr = chroma[j].0.pixels[i] - crRef.pixels[i], dcb = chroma[j].1.pixels[i] - cbRef.pixels[i]
                devField.pixels[i] = sqrtf(dcr * dcr + dcb * dcb) * conf * smoothstep(0.0, 0.06, Yn[j].pixels[i] - yChroma.pixels[i])
            }
            let devBroad = Filters.dilate(Filters.erode(devField, radius: rN), radius: rN)
            // Broad near-white areas that are not quite clipped have lost contrast too; thin bright highlights are legitimate
            // (the opening removes them), exactly as for clipped areas.
            var nearWhite = Plane(width: w, height: h)
            for i in 0..<count { nearWhite.pixels[i] = Y[j].pixels[i] >= 0.92 ? 1 : 0 }
            let nearWhiteBroad = Filters.gaussianBlur(broadRegions(nearWhite), sigma: Float(rN))
            var q = Plane(width: w, height: h), qv = Plane(width: w, height: h)
            for i in 0..<count {
                let gz = min(1, zone.pixels[i] * 1.25)
                let qClip = 1 - 0.98 * gz - 0.10 * thinClip[j].pixels[i]
                let rel = (detail[j].pixels[i] + 0.15) / (dMax.pixels[i] + 0.15)
                let qDetail = 0.55 + 0.45 * smoothstep(0.15, 0.7, rel)
                let qColor = 0.03 + 0.97 * (1 - smoothstep(0.10, 0.40, devBroad.pixels[i]))
                // dark regions are noisy and lack detail: the ramp reaches full quality only in the comfortable mid-tones
                let qExpo = 0.06 + 0.94 * smoothstep(0.04, 0.22, Y[j].pixels[i])
                let qHigh = 1 - 0.4 * min(1, nearWhiteBroad.pixels[i] * 1.2)
                // A frame much darker than the others at the same spot (after matching their smooth lighting) is shadowed or muddy
                // there — it records the specimen worse, however clean it looks. Needs ≥3 frames to tell shadow from glare.
                var qRel: Float = 1
                if n >= 3 {
                    let rel = ColorMath.decode(Yn[j].pixels[i]) / (ColorMath.decode(yMed.pixels[i]) + 0.01)
                    qRel = 0.15 + 0.85 * smoothstep(0.12, 0.55, rel)
                }
                q.pixels[i] = max(qClip, 0.02) * qDetail * qColor * qExpo * qHigh * qRel
                qv.pixels[i] = max(qClip, 0.02) * qColor
            }
            Qv.append(Filters.gaussianBlur(qv, sigma: qSigma))
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
        // The base defines the lighting character and supplies most of the picture: the cleanest frame (mean quality), weighted by
        // how much of the scene it actually records (pixels neither crushed nor clipped), so a darker or shadier frame that merely
        // lacks glare does not win over a well-exposed one.
        let baseScore: [Float] = (0..<n).map { scores[$0] * informative[$0] * informative[$0] }
        var base = 0
        for j in 1..<n where baseScore[j] > baseScore[base] { base = j }
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

        // Lighting match: a smooth multiplicative gain bringing frame j's lighting and exposure in line with the base's.
        // Broad part: robust field over the well-exposed pixels of both frames (insensitive to glare, clipping and shadow).
        // Local part: residual estimated only where *both* frames are trustworthy, extrapolated smoothly into the defect and
        // fading to zero without support. The blend runs on the base's brightness scale, so every band is consistent.
        var gains = [Plane](repeating: Plane(width: w, height: h, value: 1), count: n)
        var lnGains = [Plane](repeating: Plane(width: w, height: h, value: 0), count: n)
        if options.matchLocalLighting {
            let sg = max(2, longSide * options.gainSigmaFraction)
            for j in 0..<n where j != base {
                let broad = LightingNormalizer.lnGainField(refY: Y[base], refYL: YL[base], frameY: Y[j], frameYL: YL[j])
                var num = Plane(width: w, height: h), den = Plane(width: w, height: h)
                for i in 0..<count {
                    // usable for a brightness ratio: free of glare/colour contamination and neither crushed nor near white in either frame
                    let vb = YL[base].pixels[i], vj = YL[j].pixels[i]
                    let sb = smoothstep(0.002, 0.012, vb) * (1 - smoothstep(0.8, 0.95, vb))
                    let sj = smoothstep(0.002, 0.012, vj) * (1 - smoothstep(0.8, 0.95, vj))
                    let trust = smoothstep(0.3, 0.7, Qv[j].pixels[i]) * smoothstep(0.3, 0.7, Qv[base].pixels[i]) * sb * sj
                    let r = logf(vb + 0.002) - logf(vj + 0.002) - broad.pixels[i]
                    num.pixels[i] = trust * min(max(r, -1.5), 1.5)
                    den.pixels[i] = trust
                }
                let nb = Filters.gaussianBlur(num, sigma: sg), db = Filters.gaussianBlur(den, sigma: sg)
                var g = Plane(width: w, height: h, value: 1), lg = Plane(width: w, height: h, value: 0)
                for i in 0..<count {
                    let r = min(max(broad.pixels[i] + nb.pixels[i] / (db.pixels[i] + 0.02), -4.2), 4.2)
                    lg.pixels[i] = r; g.pixels[i] = expf(r)
                }
                gains[j] = g; lnGains[j] = lg
            }
        }
        // Tone adjustment ---------------------------------------------------------------------------------------
        // Content brought in from a better exposed frame sits on the base's scale, so a recovered highlight lies ABOVE white and a
        // recovered shadow far below black. Only that extended range is compressed (highlights) or lifted (shadows) — monotonic
        // curves, no spatial filtering, so nothing can halo — and only where a repair happened. Everything the base already
        // shows well keeps its exact tone: dark bands stay dark, polished highlights stay bright.
        var restore = Plane(width: w, height: h, value: 0), repaired = Plane(width: w, height: h, value: 0)
        var tone = ToneAdjustment.none
        if options.matchLocalLighting {
            let sl = max(1.5, longSide * 0.012)
            for j in 0..<n where j != base {
                let ws = Filters.gaussianBlur(weights[j], sigma: sl)
                for i in 0..<count {
                    restore.pixels[i] -= ws.pixels[i] * lnGains[j].pixels[i]
                    repaired.pixels[i] += ws.pixels[i]
                }
            }
            repaired = repaired.mapped { clamp01($0) }
            var vals: [Float] = []
            vals.reserveCapacity(count / 8)
            for i in 0..<count where repaired.pixels[i] > 0.5 {
                var v: Float = weights[base].pixels[i] * YL[base].pixels[i]
                for j in 0..<n where j != base { v += weights[j].pixels[i] * gains[j].pixels[i] * YL[j].pixels[i] }
                vals.append(v)
            }
            if vals.count >= max(50, count / 2000) {
                vals.sort()
                // robust extremes (3 % tails): a few overshooting pixels from an imperfect gain must not bend the whole curve
                tone = ToneAdjustment.fit(highPercentile: vals[min(vals.count - 1, Int(Float(vals.count) * 0.97))],
                                          lowPercentile: vals[Int(Float(vals.count) * 0.03)])
            }
        }
        progress?.report(.selectingRegions, 1, 1, sub: 1)
        return LightingAnalysis(proxyFactor: factor, width: w, height: h, fullWidth: W, fullHeight: H, baseIndex: base,
                                frameScores: scores, quality: Q, weights: weights, gains: gains,
                                restore: restore, repaired: repaired, tone: tone)
    }
}


/// Puts frames of one scene on a common, SMOOTH lighting and exposure scale (see `LightingAnalysisEngine.analyze`).
enum LightingNormalizer {
    /// 0 at the extremes (crushed or blown), 1 in the comfortable middle, for a display-encoded luminance.
    @inline(__always) static func wellExposed(_ y: Float) -> Float { smoothstep(0.04, 0.2, y) * (1 - smoothstep(0.88, 0.99, y)) }

    /// The frame with the most well-exposed pixels.
    static func referenceFrame(_ Y: [Plane]) -> Int {
        var best = 0, bestScore: Float = -1
        for (j, y) in Y.enumerated() {
            var t: Float = 0
            for v in y.pixels { t += wellExposed(v) }
            if t > bestScore { bestScore = t; best = j }
        }
        return best
    }

    /// Natural-log gain field g (same size as the inputs) such that `frameLinear × exp(g)` matches the reference's smooth lighting.
    /// Estimated robustly (local anomalies — glare, reflections, shadows — are down-weighted) on a small copy, then enlarged.
    static func lnGainField(refY: Plane, refYL: Plane, frameY: Plane, frameYL: Plane) -> Plane {
        let w = refY.width, h = refY.height
        let f = max(1, Int(ceil(Float(max(w, h)) / 160)))
        let rY = Filters.boxDownscale(refY, factor: f), rL = Filters.boxDownscale(refYL, factor: f)
        let fY = Filters.boxDownscale(frameY, factor: f), fL = Filters.boxDownscale(frameYL, factor: f)
        let sw = rY.width, sh = rY.height, n = sw * sh
        var lr = [Float](repeating: 0, count: n), valid = [Float](repeating: 0, count: n)
        for i in 0..<n {
            valid[i] = min(wellExposed(rY.pixels[i]), wellExposed(fY.pixels[i]))
            lr[i] = logf(rL.pixels[i] + 0.004) - logf(fL.pixels[i] + 0.004)
        }
        var global: Float = 0
        var field = Plane(width: sw, height: sh, value: 0)
        let sigma = max(2, 0.18 * Float(max(sw, sh)))
        for _ in 0..<4 {
            var num = Plane(width: sw, height: sh), den = Plane(width: sw, height: sh)
            var gn: Float = 0, gd: Float = 0
            for i in 0..<n {
                let r = lr[i] - field.pixels[i]
                let wr = 1 / (1 + (r / 0.35) * (r / 0.35))
                num.pixels[i] = valid[i] * wr * lr[i]; den.pixels[i] = valid[i] * wr
                gn += valid[i] * wr * lr[i]; gd += valid[i] * wr
            }
            if gd > 1e-3 { global = gn / gd }
            let nb = Filters.gaussianBlur(num, sigma: sigma), db = Filters.gaussianBlur(den, sigma: sigma)
            let eps: Float = 0.02          // pulls towards the global value where there is little support
            for i in 0..<n { field.pixels[i] = min(max((nb.pixels[i] + eps * global) / (db.pixels[i] + eps), -4), 4) }
        }
        return Filters.resizeBilinear(field, toWidth: w, toHeight: h)
    }
}


/// Monotonic tone adjustment of the extended range that exposure repairs bring in (linear light, luminance-driven, colour kept).
/// Highlights above `knee` are compressed by a soft power curve just far enough that the brightest repaired pixel lands below
/// white; shadows below `shadowKnee` are lifted by a soft power curve. Both are identity over the range the base already shows.
public struct ToneAdjustment: Sendable {
    public var knee: Float = 1, beta: Float = 1                 // beta = 1: identity
    public var shadowKnee: Float = 0, gamma: Float = 1          // gamma = 1: identity
    public static let none = ToneAdjustment()
    public var isIdentity: Bool { beta >= 0.999 && gamma >= 0.999 }

    static func fit(highPercentile hi: Float, lowPercentile lo: Float) -> ToneAdjustment {
        var t = ToneAdjustment()
        let k: Float = 0.62, target: Float = 0.985
        if hi > target {
            t.knee = k
            t.beta = min(1, max(0.3, logf(target / k) / logf(hi / k)))
        }
        // only genuinely crushed values (below ~display 0.06) are lifted; a specimen's own dark bands keep their depth
        let f1: Float = 0.004
        if lo < f1 * 0.8 { t.shadowKnee = f1; t.gamma = 0.6 }
        return t
    }

    /// Luminance multiplier for a pixel of (base-scale) luminance `v`. `lnRestore` bounds the change by what the chosen frame itself
    /// shows (ln of its own brightness over the base-scale value).
    @inline(__always) func multiplier(_ v: Float, lnRestore: Float) -> Float {
        var m: Float = 1
        if beta < 0.999 {
            // soft knee: v · (1 + (v/k)^4)^((β−1)/4) — identity far below the knee, power β far above it, no kink in between
            let u = v / knee, u2 = u * u
            m = max(powf(1 + u2 * u2, (beta - 1) * 0.25), expf(min(lnRestore, 0)))
        }
        if gamma < 0.999 {
            let u = shadowKnee / max(v, 1e-5), u2 = u * u
            m *= min(powf(1 + u2 * u2, (1 - gamma) * 0.25), expf(max(lnRestore, 0)))
        }
        return m
    }
}
