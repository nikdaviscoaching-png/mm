import Foundation

/// Full-resolution multiband blend of the lighting stack.
///
/// Per tile: the aligned frames are read at full resolution, matched to the base's local lighting, decomposed into
/// Laplacian bands, and recombined with Gaussian-pyramid copies of the replacement weights (Burt–Adelson). Fine bands
/// switch over a few pixels (detail stays crisp), coarse bands transition over many (no brightness steps or seams).
/// Everything is blended in linear light.
public enum LightingFusionEngine {

    /// Bilinear sample of a proxy plane at full-resolution pixel coordinates (proxy p = (full + 0.5)/f − 0.5).
    static func upsample(_ p: Plane, factor f: Int, region: PixelRect) -> Plane {
        var out = Plane(width: region.width, height: region.height)
        let inv = 1 / Float(f)
        for y in 0..<region.height {
            let fy = (Float(region.y + y) + 0.5) * inv - 0.5
            let y0 = Int(floorf(fy)); let ty = fy - Float(y0)
            for x in 0..<region.width {
                let fx = (Float(region.x + x) + 0.5) * inv - 0.5
                let x0 = Int(floorf(fx)); let tx = fx - Float(x0)
                let a = p.clamped(x0, y0), b = p.clamped(x0 + 1, y0), c = p.clamped(x0, y0 + 1), d = p.clamped(x0 + 1, y0 + 1)
                out.pixels[y * region.width + x] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty
            }
        }
        return out
    }

    public static func blend(frames: [any FrameSource], analysis: LightingAnalysis, sink: any FrameSink,
                             options: LightingStackOptions = .init(), progress: ProgressSlice? = nil,
                             isCancelled: CancelCheck? = nil) throws {
        let n = frames.count
        precondition(n == analysis.weights.count)
        let W = analysis.fullWidth, H = analysis.fullHeight
        let unit = 2 << options.levels
        let tile = max(unit, (options.tileSize + unit - 1) / unit * unit)
        let grid = TileGrid(imageWidth: W, imageHeight: H, tileSize: tile, halo: options.halo)
        let L = options.levels
        let f = analysis.proxyFactor
        let base = analysis.baseIndex
        // Frames that never contribute are never read.
        let used: [Bool] = (0..<n).map { j in j == base || analysis.weights[j].pixels.contains { $0 > 0.002 } }
        try TileRunner.run(tiles: grid.tiles, concurrency: options.concurrency, isCancelled: isCancelled, onTileDone: { done, total in
            progress?.report(.blending, done, total, sub: Double(done) / Double(total))
        }, work: { t in
            let rect = t.padded
            let sizes = Pyramid.levelSizes(width: rect.width, height: rect.height, count: L + 1)
            var acc: [[Plane]] = (0..<3).map { _ in sizes.map { Plane(width: $0.width, height: $0.height) } }
            // Replacement weights per level. At coarse levels the Gaussian-blurred mask would let some of the base's
            // low-frequency contamination (a tint, a glare wash) leak into the middle of a defect that is only a few
            // transition-widths wide, so coarse-level replacement masks are dilated; fine levels stay exact.
            var wPyr = [[Plane]](repeating: [], count: n)
            var replaceSum = sizes.map { Plane(width: $0.width, height: $0.height) }
            for j in 0..<n where used[j] && j != base {
                let wFull = upsample(analysis.weights[j], factor: f, region: rect)
                if wFull.pixels.allSatisfy({ $0 < 1e-5 }) { continue }
                var levelsW = Pyramid.gaussian(wFull, levels: L + 1)
                // A donor may only spread over its neighbourhood where it is itself trustworthy at that scale
                // (eroded quality), otherwise its own glare/tint would leak into the defect it is meant to repair.
                let qLevels = Pyramid.gaussian(upsample(analysis.quality[j], factor: f, region: rect), levels: L + 1)
                for l in 1..<levelsW.count {
                    let trust = qLevels[l].mapped { smoothstep(0.3, 0.6, $0) }
                    var d = Filters.boxBlur(Filters.dilate(levelsW[l], radius: l >= 3 ? 3 : 2), radius: 1)
                    d.multiply(by: trust)
                    // coarse bands carry the wash/tint: push coverage toward full inside the defect
                    levelsW[l] = d.mapped { min($0 * 1.6, 1) }
                }
                wPyr[j] = levelsW
                for l in 0..<levelsW.count { replaceSum[l].addScaled(levelsW[l], 1) }
            }
            // normalise (others cannot exceed 1 in total); base takes the remainder
            for l in 0..<sizes.count {
                for i in 0..<replaceSum[l].count where replaceSum[l].pixels[i] > 1 {
                    let inv = 1 / replaceSum[l].pixels[i]
                    for j in 0..<n where !wPyr[j].isEmpty { wPyr[j][l].pixels[i] *= inv }
                    replaceSum[l].pixels[i] = 1
                }
            }
            var baseW = replaceSum.map { Plane(width: $0.width, height: $0.height, value: 1) }
            for l in 0..<sizes.count { baseW[l].addScaled(replaceSum[l], -1) }
            wPyr[base] = baseW
            for j in 0..<n where used[j] && !wPyr[j].isEmpty {
                var lin = ColorMath.toLinear(try frames[j].read(region: rect))
                if j != base && options.matchLocalLighting {
                    let g = upsample(analysis.gains[j], factor: f, region: rect)
                    lin.r.multiply(by: g); lin.g.multiply(by: g); lin.b.multiply(by: g)
                }
                let pyr = [lin.r, lin.g, lin.b].map { Pyramid.laplacian($0, levels: L) }
                for c in 0..<3 { for l in 0..<pyr[c].count { acc[c][l].addMultiplied(pyr[c][l], wPyr[j][l]) } }
            }
            let fused = RGBImage(r: Pyramid.collapse(acc[0]), g: Pyramid.collapse(acc[1]), b: Pyramid.collapse(acc[2]))
            let off = (t.core.x - rect.x, t.core.y - rect.y)
            try sink.write(region: t.core, image: ColorMath.toEncoded(fused).crop(PixelRect(x: off.0, y: off.1, width: t.core.width, height: t.core.height)))
        })
    }
}

public enum LightingStackEngine {
    /// Analyse + blend. Frames must already be aligned (wrap with `ImageRegistrationEngine.aligned`).
    @discardableResult
    public static func run(frames: [any FrameSource], sink: any FrameSink, options: LightingStackOptions = .init(),
                           progress: ProgressSlice? = nil, isCancelled: CancelCheck? = nil) throws -> LightingAnalysis {
        let a = ProgressSlice(progress?.handler, start: progress?.start ?? 0, span: (progress?.span ?? 1) * 0.35)
        let analysis = try LightingAnalysisEngine.analyze(frames: frames, options: options, progress: a, isCancelled: isCancelled)
        let b = ProgressSlice(progress?.handler, start: (progress?.start ?? 0) + (progress?.span ?? 1) * 0.35, span: (progress?.span ?? 1) * 0.65)
        try LightingFusionEngine.blend(frames: frames, analysis: analysis, sink: sink, options: options, progress: b, isCancelled: isCancelled)
        return analysis
    }
}
