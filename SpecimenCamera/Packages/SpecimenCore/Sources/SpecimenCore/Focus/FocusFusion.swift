import Foundation

public struct FocusStackOptions: Sendable {
    /// Laplacian bands (plus residual). Halo follows from this.
    public var levels = 5
    /// Core tile edge in pixels; must be a multiple of 2^(levels+1) so pyramid phases agree across tiles.
    public var tileSize = 768
    public var concurrency = 2
    /// Live worker limit (thermal management); asked before every tile. nil = fixed `concurrency`.
    public var concurrencyProvider: (@Sendable () -> Int)? = nil
    /// Sharpness of the per-pixel frame selection (higher → closer to a hard maximum, lower → more averaging).
    public var selectionPower: Float = 8.0
    /// Weight of the multi-signal focus map relative to the per-band coefficient energy.
    public var focusMapPower: Float = 1.5
    public var saliencySigma: Float = 1.5
    /// Window (σ, px) of the RMS aggregation inside the focus map: smaller = crisper decisions at depth edges.
    public var focusAggregationSigma: Float = 2.0
    /// Extra focus-map term measured over a wide window so textureless regions follow the decision of the
    /// detail around them instead of averaging blurred and sharp frames. 0 disables.
    public var widePower: Float = 3.5
    public var wideSigma: Float = 8.0
    public var noiseSigma: Float? = nil
    /// Coefficient energy below `noiseDeadZone`× the calibrated noise energy is treated as zero, and the weighting
    /// softens with `noiseSoftness`× noise energy, so differences smaller than sensor noise never drive selection.
    public var noiseDeadZone: Float = 1.5
    public var noiseSoftness: Float = 2.0
    public var signalWeights = FocusSignalWeights()
    public init() {}

    public static func preset(_ q: StackQuality) -> FocusStackOptions {
        var o = FocusStackOptions()
        switch q {
        case .fast: o.levels = 4; o.tileSize = 768
        case .high: o.levels = 5
        case .maximum: o.levels = 6; o.tileSize = 896
        }
        o.tileSize = max(o.tileSize, 2 << o.levels) / (2 << o.levels) * (2 << o.levels)
        return o
    }

    var halo: Int { Pyramid.haloFor(levels: levels) }
}

public enum StackQuality: String, Sendable, Codable, CaseIterable {
    case fast, high, maximum
    public var title: String {
        switch self { case .fast: return "FAST PREVIEW"; case .high: return "HIGH QUALITY"; case .maximum: return "MAXIMUM QUALITY" }
    }
}

public struct FocusStackReport: Sendable {
    public var frameCount: Int
    public var noiseSigma: Float
    /// How many output pixels (at full resolution) each frame contributed most to — handy for sanity checks.
    public var dominantPixels: [Int]
}

/// Focus-stack fusion: per-band, per-pixel soft selection of Laplacian-pyramid coefficients using weights
/// derived from both the band's own coefficient energy and the multi-signal focus map. Local decisions
/// everywhere (never "sharpest whole frame"), blended in linear light, tile-streamed so memory is bounded
/// regardless of frame count or resolution.
public enum FocusStackEngine {

    public static func fuse(frames: [any FrameSource], sink: any FrameSink, options: FocusStackOptions = .init(),
                            progress: ProgressSlice? = nil, isCancelled: CancelCheck? = nil) throws -> FocusStackReport {
        guard let first = frames.first else { throw SpecimenError.insufficientFrames(needed: 1, got: 0) }
        let W = first.width, H = first.height
        for (i, f) in frames.enumerated() where f.width != W || f.height != H {
            throw SpecimenError.dimensionMismatch("frame \(i) is \(f.width)×\(f.height), expected \(W)×\(H)")
        }
        if frames.count == 1 {
            try copy(frames[0], to: sink, tileSize: options.tileSize)
            return FocusStackReport(frameCount: 1, noiseSigma: 0, dominantPixels: [W * H])
        }
        var normalized = options
        // Pyramid phase must agree between tiles: tile size is a multiple of 2^(levels+1).
        let unit = 2 << normalized.levels
        normalized.tileSize = max(unit, (normalized.tileSize + unit - 1) / unit * unit)
        let options = normalized
        let k = first.colorSpace.luma
        let sigma: Float
        if let s = options.noiseSigma { sigma = s } else {
            let mid = frames[frames.count / 2]
            let cr = PixelRect(x: max(0, W / 2 - 256), y: max(0, H / 2 - 256), width: min(512, W), height: min(512, H))
            sigma = FocusMapBuilder.estimateNoise(luma: try mid.read(region: cr).luma(k))
        }
        let builder = FocusMapBuilder(noiseSigma: sigma, luma: k, weights: options.signalWeights, aggregationSigma: options.focusAggregationSigma)
        let calib = BandNoiseCalibration.make(levels: options.levels, sigma: options.saliencySigma)
        let grid = TileGrid(imageWidth: W, imageHeight: H, tileSize: options.tileSize, halo: options.halo)
        let dominant = Counter(frames.count)
        try TileRunner.run(tiles: grid.tiles, concurrency: options.concurrency, concurrencyProvider: options.concurrencyProvider, isCancelled: isCancelled, onTileDone: { done, total in
            progress?.report(.blending, done, total, sub: Double(done) / Double(total))
        }, work: { tile in
            let out = try fuseTile(frames: frames, tile: tile, options: options, builder: builder, calib: calib, sigma: sigma, dominant: dominant)
            try sink.write(region: tile.core, image: out)
        })
        return FocusStackReport(frameCount: frames.count, noiseSigma: sigma, dominantPixels: dominant.values)
    }

    static func copy(_ f: any FrameSource, to sink: any FrameSink, tileSize: Int) throws {
        for t in TileGrid(imageWidth: f.width, imageHeight: f.height, tileSize: tileSize, halo: 0).tiles {
            try sink.write(region: t.core, image: try f.read(region: t.core))
        }
    }

    // MARK: Tile

    static func fuseTile(frames: [any FrameSource], tile: Tile, options: FocusStackOptions, builder: FocusMapBuilder,
                         calib: BandNoiseCalibration, sigma: Float, dominant: Counter) throws -> RGBImage {
        let n = frames.count
        let L = options.levels
        let rect = tile.padded
        let sizes = Pyramid.levelSizes(width: rect.width, height: rect.height, count: L + 1)
        let nBands = sizes.count - 1            // bands before the residual

        // Pass 1: focus maps + per-band saliency (encoded domain), all frames.
        var focusPyr: [[Plane]] = []            // [frame][level]
        var widePyr: [[Plane]] = []
        var saliency: [[Plane]] = []            // [frame][band]
        var base0: [Plane] = []                 // full-res focus map (for diagnostics / dominance)
        for i in 0..<n {
            let enc = try frames[i].read(region: rect)
            let (fmap, fineMap) = builder.maps(for: enc)
            base0.append(fmap)
            focusPyr.append(Pyramid.gaussian(fmap, levels: sizes.count))
            if options.widePower > 0 { widePyr.append(Pyramid.gaussian(Filters.gaussianBlur(fineMap, sigma: options.wideSigma), levels: sizes.count)) }
            var sal: [Plane] = []
            let lapR = Pyramid.laplacian(enc.r, levels: L), lapG = Pyramid.laplacian(enc.g, levels: L), lapB = Pyramid.laplacian(enc.b, levels: L)
            for l in 0..<nBands {
                var e = Plane(width: lapR[l].width, height: lapR[l].height)
                for j in 0..<e.count {
                    let a = lapR[l].pixels[j], b = lapG[l].pixels[j], c = lapB[l].pixels[j]
                    e.pixels[j] = (a * a + b * b + c * c) * (1.0 / 3.0)
                }
                sal.append(Filters.gaussianBlur(e, sigma: options.saliencySigma))
            }
            saliency.append(sal)
        }

        // Normalised per-level weights.
        var weights: [[Plane]] = Array(repeating: [], count: n)    // [frame][level]
        for l in 0..<sizes.count {
            let isResidual = l == nBands
            let w = sizes[l].width, h = sizes[l].height
            let noiseE: Float = isResidual ? 0 : calib.noiseEnergy(level: l, sigma: sigma)
            let eps: Float = isResidual ? 1e-4 : max(noiseE * options.noiseSoftness, 1e-10)
            let dead = noiseE * options.noiseDeadZone
            let epsF: Float = 0.05
            var logits = [Plane](repeating: Plane(width: w, height: h), count: n)
            var maxLogit = Plane(width: w, height: h, value: -Float.greatestFiniteMagnitude)
            for i in 0..<n {
                let fl = focusPyr[i][l]
                let wideL: Plane? = options.widePower > 0 ? widePyr[i][l] : nil
                let sl: Plane? = isResidual ? nil : saliency[i][l]
                var lg = Plane(width: w, height: h)
                for j in 0..<lg.count {
                    var u = options.focusMapPower * logf(max(fl.pixels[j], 0) + epsF)
                    if let wl = wideL { u += options.widePower * logf(max(wl.pixels[j], 0) + epsF) }
                    if let s = sl { u += options.selectionPower * 0.5 * logf(max(s.pixels[j] - dead, 0) + eps) }
                    lg.pixels[j] = u
                    if u > maxLogit.pixels[j] { maxLogit.pixels[j] = u }
                }
                logits[i] = lg
            }
            var sum = Plane(width: w, height: h)
            for i in 0..<n {
                for j in 0..<sum.count {
                    let e = expf(logits[i].pixels[j] - maxLogit.pixels[j])
                    logits[i].pixels[j] = e; sum.pixels[j] += e
                }
            }
            for i in 0..<n {
                var wp = logits[i]
                for j in 0..<wp.count { wp.pixels[j] /= sum.pixels[j] }
                weights[i].append(wp)
            }
        }
        saliency.removeAll(); focusPyr.removeAll(); widePyr.removeAll()

        // Dominance bookkeeping on the finest level of the core region.
        let ox = tile.core.x - rect.x, oy = tile.core.y - rect.y
        var counts = [Int](repeating: 0, count: n)
        for y in 0..<tile.core.height { for x in 0..<tile.core.width {
            var best = 0; var bv: Float = -1
            for i in 0..<n { let v = weights[i][0][ox + x, oy + y]; if v > bv { bv = v; best = i } }
            counts[best] += 1
        }}
        dominant.add(counts)

        // Pass 2: blend linear-light coefficients.
        var acc: [[Plane]] = (0..<3).map { _ in sizes.map { Plane(width: $0.width, height: $0.height) } }
        for i in 0..<n {
            let lin = ColorMath.toLinear(try frames[i].read(region: rect))
            let pyr = [lin.r, lin.g, lin.b].map { Pyramid.laplacian($0, levels: L) }
            for c in 0..<3 {
                for l in 0..<pyr[c].count { acc[c][l].addMultiplied(pyr[c][l], weights[i][l]) }
            }
        }
        let fused = RGBImage(r: Pyramid.collapse(acc[0]), g: Pyramid.collapse(acc[1]), b: Pyramid.collapse(acc[2]))
        return ColorMath.toEncoded(fused).crop(PixelRect(x: ox, y: oy, width: tile.core.width, height: tile.core.height))
    }
}

extension Plane {
    mutating func addMultiplied(_ o: Plane, _ w: Plane) {
        pixels.withUnsafeMutableBufferPointer { d in
            o.pixels.withUnsafeBufferPointer { a in
                w.pixels.withUnsafeBufferPointer { b in
                    for i in 0..<d.count { d[i] += a[i] * b[i] }
                }
            }
        }
    }
}

final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var v: [Int]
    init(_ n: Int) { v = [Int](repeating: 0, count: n) }
    func add(_ o: [Int]) { lock.lock(); for i in 0..<o.count { v[i] += o[i] }; lock.unlock() }
    var values: [Int] { lock.lock(); defer { lock.unlock() }; return v }
}

/// Energy of unit white noise in each Laplacian band (after the saliency window), so flat regions — where all
/// frames hold only noise — get near-equal weights (i.e. noise averaging) instead of arbitrary picks.
struct BandNoiseCalibration: Sendable {
    let unitEnergy: [Float]
    static func make(levels: Int, sigma: Float) -> BandNoiseCalibration {
        let t = FocusMapBuilder.unitNoiseTile
        let big = RGBImage(r: tileUp(t.r), g: tileUp(t.g), b: tileUp(t.b))
        let lap = [big.r, big.g, big.b].map { Pyramid.laplacian($0, levels: levels) }
        var out: [Float] = []
        for l in 0..<levels {
            var e = Plane(width: lap[0][l].width, height: lap[0][l].height)
            for j in 0..<e.count { e.pixels[j] = (pow2(lap[0][l].pixels[j]) + pow2(lap[1][l].pixels[j]) + pow2(lap[2][l].pixels[j])) / 3 }
            let s = Filters.gaussianBlur(e, sigma: sigma)
            var acc: Double = 0, n = 0.0
            let m = max(2, s.width / 5)
            for y in m..<(s.height - m) { for x in m..<(s.width - m) { acc += Double(s[x, y]); n += 1 } }
            out.append(Float(acc / max(n, 1)))
        }
        return BandNoiseCalibration(unitEnergy: out)
    }
    static func pow2(_ v: Float) -> Float { v * v }
    static func tileUp(_ p: Plane) -> Plane {
        // 96×96 noise tile repeated 2×2 with different offsets so coarse bands have enough support
        var o = Plane(width: 192, height: 192)
        for y in 0..<192 { for x in 0..<192 { o[x, y] = p[(x + (y / 96) * 37) % 96, y % 96] } }
        return o
    }
    /// Expected saliency (windowed coefficient energy) of pure noise of σ_n in band `level`.
    func noiseEnergy(level: Int, sigma: Float) -> Float {
        let e = level < unitEnergy.count ? unitEnergy[level] : unitEnergy.last ?? 0
        return e * sigma * sigma
    }
}
