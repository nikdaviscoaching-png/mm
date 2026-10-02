import Foundation

public enum SRError: Error, Equatable, Sendable { case cancelled, noFrames, sizeMismatch }

public struct SRReport: Sendable {
    public var referenceIndex = 0
    public var usedFrames: [Int] = []
    public var rejectedFrames: [Int] = []
    public var residuals: [Float] = []
    public var outputWidth = 0, outputHeight = 0
}

public enum SuperResolution {
    /// Merges `frames` (same size, handheld burst) into one 2× image, tile by tile. `writeTile` receives each finished tile
    /// (output coordinates, tightly packed RGBA) in order; the whole output is never held in memory here.
    @discardableResult
    public static func upscale(frames: [RGBA8Image], settings: UpscaleSettings = UpscaleSettings(), aiProvider: UpscaleAIProvider? = nil,
                               isCancelled: @escaping @Sendable () -> Bool = { false }, progress: @escaping @Sendable (Double) -> Void = { _ in },
                               writeTile: (SRRect, UnsafePointer<UInt8>) -> Void) throws -> SRReport {
        guard let first = frames.first else { throw SRError.noFrames }
        let W = first.width, H = first.height
        guard frames.allSatisfy({ $0.width == W && $0.height == H }) else { throw SRError.sizeMismatch }
        var report = SRReport(); report.outputWidth = W * 2; report.outputHeight = H * 2

        // Registration (sequential: one pyramid at a time keeps peak memory low) ------------------------------------
        let pyramids0 = frames.count > 1 ? SRPyramid(frame: first) : nil
        var refIndex = 0
        var refPyr = pyramids0
        if let fixed = settings.referenceIndex, fixed >= 0, fixed < frames.count {
            refIndex = fixed; refPyr = fixed == 0 ? pyramids0 : SRPyramid(frame: frames[fixed])
        } else if frames.count > 2 {
            // reference = the sharpest frame
            var best: Float = -1
            for (i, f) in frames.enumerated() {
                let p = i == 0 ? pyramids0! : SRPyramid(frame: f)
                let e = sharpness(p.levels[0])
                if e > best { best = e; refIndex = i; refPyr = p }
                if isCancelled() { throw SRError.cancelled }
            }
        }
        report.referenceIndex = refIndex
        var alignments = [SRFrameAlignment?](repeating: nil, count: frames.count)
        var trust = [SRTrustMap?](repeating: nil, count: frames.count)
        report.residuals = [Float](repeating: 0, count: frames.count)
        if let refPyr, frames.count > 1 {
            let noise = SRMath.estimateNoise(refPyr.levels[0])
            let refSmooth = SRMath.blur(refPyr.levels[0], sigma: 1.0)
            for k in 0..<frames.count where k != refIndex {
                if isCancelled() { throw SRError.cancelled }
                let cp = SRPyramid(frame: frames[k])
                let a = SRRegistration.align(ref: refPyr, cand: cp, noise: noise)
                report.residuals[k] = a.residual
                alignments[k] = a
                if a.isUsable {
                    trust[k] = SRMerge.trustMap(refSmooth: refSmooth, cand: cp.levels[0], alignment: a, noise: noise)
                    report.usedFrames.append(k)
                } else { report.rejectedFrames.append(k) }
                progress(0.2 * Double(k + 1) / Double(frames.count))
            }
        }
        report.usedFrames.append(refIndex); report.usedFrames.sort()

        // Tiles --------------------------------------------------------------------------------------------------------
        let outW = W * 2, outH = H * 2
        let ts = max(64, settings.tileSize), halo = 24
        let cols = (outW + ts - 1) / ts, rows = (outH + ts - 1) / ts
        var done = 0
        for ty in 0..<rows { for tx in 0..<cols {
            if isCancelled() { throw SRError.cancelled }
            let core = SRRect(x: tx * ts, y: ty * ts, width: min(ts, outW - tx * ts), height: min(ts, outH - ty * ts))
            let x0 = max(0, core.x - halo), y0 = max(0, core.y - halo)
            let work = SRRect(x: x0, y: y0, width: min(outW, core.maxX + halo) - x0, height: min(outH, core.maxY + halo) - y0)
            var t = SRMerge.mergeTile(frames: frames, referenceIndex: refIndex, alignments: alignments, trust: trust, rect: work)
            let ai = settings.aiStrength > 0 ? aiProvider?.detailLuma(for: work, outputScale: 2, reference: frames[refIndex]) : nil
            SRDetail.finish(rgba: &t.rgba, width: work.width, height: work.height, confidence: t.confidence, settings: settings, ai: ai)
            var crop = [UInt8](repeating: 255, count: core.width * core.height * 4)
            for r in 0..<core.height {
                let s = ((core.y - work.y + r) * work.width + (core.x - work.x)) * 4
                crop.replaceSubrange(r * core.width * 4..<(r + 1) * core.width * 4, with: t.rgba[s..<s + core.width * 4])
            }
            crop.withUnsafeBufferPointer { writeTile(core, $0.baseAddress!) }
            done += 1
            progress(0.2 + 0.8 * Double(done) / Double(cols * rows))
        } }
        return report
    }

    static func sharpness(_ p: FloatPlane) -> Float {
        var s: Float = 0; var n: Float = 0
        let st = max(1, min(p.width, p.height) / 300)
        var y = 1; while y < p.height - 1 { var x = 1; while x < p.width - 1 {
            let gx = p.at(x + 1, y) - p.at(x - 1, y), gy = p.at(x, y + 1) - p.at(x, y - 1)
            s += min(gx * gx + gy * gy, 1600); n += 1; x += st }; y += st }
        return n > 0 ? s / n : 0
    }
}
