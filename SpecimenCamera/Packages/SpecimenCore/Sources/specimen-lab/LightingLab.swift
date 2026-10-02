import Foundation
import SpecimenCore
import SpecimenTestKit

/// Same-position tripod scenarios (3–5 frames) for judging the lighting stack by eye and by numbers.
/// `specimen-lab tripod <outdir> [scenario]` where scenario = bracket | lamps | mixed.
func runTripodLab(out: URL, only: String?) throws {
    try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
    for name in ["bracket", "lamps", "mixed", "bracket2"] where only == nil || only == name {
        let s = tripodScenario(name)
        var opts = LightingStackOptions()
        for a in CommandLine.arguments.dropFirst(4) {
            let kv = a.split(separator: "="); guard kv.count == 2, let v = Float(kv[1]) else { continue }
            switch kv[0] { case "power": opts.qualityPower = v; case "gain": opts.matchLocalLighting = v > 0; case "base": opts.preferredBase = Int(v); default: break }
        }
        let sink = MemorySink(width: 512, height: 384)
        let t0 = Date()
        let an = try LightingStackEngine.run(frames: s.frames.map { MemoryFrame($0) }, sink: sink, options: opts)
        let r = sink.result
        print("== \(name): time \(String(format: "%.2f", Date().timeIntervalSince(t0))) s, base \(an.baseIndex), contribution \(an.contribution.map { String(format: "%.2f", $0) })")
        func stats(_ img: RGBImage) -> String {
            var clip = 0, crush = 0, good = 0
            let y = img.luma(.displayP3)
            for i in 0..<img.r.count {
                if max(img.r.pixels[i], img.g.pixels[i], img.b.pixels[i]) >= 0.985 { clip += 1 }
                if y.pixels[i] <= 0.05 { crush += 1 }
                if y.pixels[i] >= 0.12 && y.pixels[i] <= 0.88 { good += 1 }
            }
            let n = Float(img.r.count)
            return String(format: "clipped %4.1f%%  crushed %4.1f%%  well-exposed %4.1f%%", 100 * Float(clip) / n, 100 * Float(crush) / n, 100 * Float(good) / n)
        }
        for (i, f) in s.frames.enumerated() { print("   frame \(i): \(stats(f))") }
        print("   RESULT : \(stats(r))")
        let ideal = idealImage(s)
        print("   ideal  : \(stats(ideal))   | PSNR(result, ideal after global gain fit) = \(String(format: "%.1f", fitPSNR(r, ideal))) dB; best single frame \(String(format: "%.1f", s.frames.map { fitPSNR($0, ideal) }.max() ?? 0)) dB")
        try PNG.write(ImageMetrics.montage(s.frames + [r, ideal], columns: min(s.frames.count + 2, 4)), to: out.appendingPathComponent("tripod_\(name).png"))
        if CommandLine.arguments.contains("debug") {
            let f = an.proxyFactor
            let j = (0..<s.frames.count).max { an.contribution[$0] < an.contribution[$1] && $0 != an.baseIndex ? true : false } ?? 0
            _ = j
            let donor = 3
            // sample the proxy grid where frame `donor` has weight > 0.5
            var rows: [String] = []
            let lin = s.frames.map { ColorMath.toLinear($0) }
            for py in stride(from: 0, to: an.weights[donor].height, by: 3) { for px in stride(from: 0, to: an.weights[donor].width, by: 3) {
                let i = py * an.weights[donor].width + px
                let wd = an.weights[donor].pixels[i]
                if wd > 0.5 && px * f < 128 && py * f < 96 {
                    let fx = min(px * f, 511), fy = min(py * f, 383), k = fy * 512 + fx
                    let b = lin[an.baseIndex], d = lin[donor]
                    rows.append(String(format: "proxy(%d,%d) w=%.2f gain=%.3f rep=%.3f  baseLin=(%.3f %.3f %.3f)  donorLin=(%.3f %.3f %.3f)  donor*gain=(%.3f %.3f %.3f)  qBase=%.2f qDonor=%.2f",
                        px, py, wd, an.gains[donor].pixels[i], an.repaired.pixels[i], b.r.pixels[k], b.g.pixels[k], b.b.pixels[k], d.r.pixels[k], d.g.pixels[k], d.b.pixels[k],
                        d.r.pixels[k] * an.gains[donor].pixels[i], d.g.pixels[k] * an.gains[donor].pixels[i], d.b.pixels[k] * an.gains[donor].pixels[i],
                        an.quality[an.baseIndex].pixels[i], an.quality[donor].pixels[i]))
                }
            } }
            print("   debug donor \(donor): \(rows.count) samples"); for r in rows.prefix(14) { print("   " + r) }
        }
        if CommandLine.arguments.contains("err") {
            func fitted(_ a: RGBImage) -> RGBImage {
                let la = ColorMath.toLinear(a), lb = ColorMath.toLinear(ideal)
                var num = 0.0, den = 0.0
                for i in 0..<la.r.count { for (x, y) in [(la.r.pixels[i], lb.r.pixels[i]), (la.g.pixels[i], lb.g.pixels[i]), (la.b.pixels[i], lb.b.pixels[i])] { num += Double(x * y); den += Double(x * x) } }
                let g = Float(num / max(den, 1e-9)); var o = la
                for i in 0..<o.r.count { o.r.pixels[i] *= g; o.g.pixels[i] *= g; o.b.pixels[i] *= g }
                return ColorMath.toEncoded(o)
            }
            func err(_ a: RGBImage) -> RGBImage {
                let f = fitted(a); var o = RGBImage(width: a.width, height: a.height)
                for i in 0..<o.r.count {
                    let d = min(1, 4 * max(abs(f.r.pixels[i] - ideal.r.pixels[i]), abs(f.g.pixels[i] - ideal.g.pixels[i]), abs(f.b.pixels[i] - ideal.b.pixels[i])))
                    o.r.pixels[i] = d; o.g.pixels[i] = d; o.b.pixels[i] = d
                }
                return o
            }
            try PNG.write(ImageMetrics.montage([err(s.frames[an.baseIndex]), err(r)], columns: 2), to: out.appendingPathComponent("tripod_\(name)_err.png"))
            // worst 48×48 blocks where the result is worse than the base
            let eb = err(s.frames[an.baseIndex]), er = err(r)
            var blocks: [(Float, Int, Int, Float, Float)] = []
            for by in stride(from: 0, to: 384 - 47, by: 24) { for bx in stride(from: 0, to: 512 - 47, by: 24) {
                var sb: Float = 0, sr: Float = 0
                for y in by..<by + 48 { for x in bx..<bx + 48 { sb += eb.r[x, y]; sr += er.r[x, y] } }
                blocks.append(((sr - sb) / 2304, bx, by, sb / 2304, sr / 2304))
            } }
            for b in blocks.sorted(by: { $0.0 > $1.0 }).prefix(6) { print(String(format: "   worse-than-base block (%d,%d): base err %.3f result err %.3f", b.1, b.2, b.3, b.4)) }
            for b in blocks.sorted(by: { $0.0 < $1.0 }).prefix(3) { print(String(format: "   better-than-base block (%d,%d): base err %.3f result err %.3f", b.1, b.2, b.3, b.4)) }
        }
        if CommandLine.arguments.contains("clipmap") {
            func mark(_ a: RGBImage) -> RGBImage {
                var o = a
                for i in 0..<o.r.count {
                    let mx = max(a.r.pixels[i], a.g.pixels[i], a.b.pixels[i])
                    if mx >= 0.985 { o.r.pixels[i] = 1; o.g.pixels[i] = 0; o.b.pixels[i] = 0 }
                    else if a.luma(.displayP3).pixels[i] <= 0.05 { o.r.pixels[i] = 0; o.g.pixels[i] = 0; o.b.pixels[i] = 1 }
                }
                return o
            }
            try PNG.write(ImageMetrics.montage(s.frames.map { mark($0) } + [mark(r)], columns: s.frames.count + 1), to: out.appendingPathComponent("tripod_\(name)_clip.png"))
        }
        print("   scores: " + an.frameScores.map { String(format: "%.3f", $0) }.joined(separator: " "))
        print("   tone: knee \(an.tone.knee) beta \(an.tone.beta) shadowKnee \(an.tone.shadowKnee) gamma \(an.tone.gamma)")
        if CommandLine.arguments.contains("probe") {
            let f = an.proxyFactor
            for (px, py) in [(490, 60), (480, 20), (300, 120), (330, 160)] {
                let i = (py / f) * an.weights[0].width + px / f
                let lin = s.frames.map { ColorMath.toLinear($0) }
                var line = "   probe(\(px),\(py)) w=" + an.weights.map { String(format: "%.2f", $0.pixels[i]) }.joined(separator: ",")
                line += " gain=" + an.gains.map { String(format: "%.2f", $0.pixels[i]) }.joined(separator: ",")
                line += " Q=" + an.quality.map { String(format: "%.2f", $0.pixels[i]) }.joined(separator: ",")
                line += String(format: " rep=%.2f restore=%.2f", an.repaired.pixels[i], an.restore.pixels[i])
                print(line)
                print("      lin(rgb) per frame: " + lin.map { String(format: "(%.3f %.3f %.3f)", $0.r[px, py], $0.g[px, py], $0.b[px, py]) }.joined(separator: " "))
                print(String(format: "      result enc (%.0f %.0f %.0f)  ideal enc (%.0f %.0f %.0f)", r.r[px, py] * 255, r.g[px, py] * 255, r.b[px, py] * 255, ideal.r[px, py] * 255, ideal.g[px, py] * 255, ideal.b[px, py] * 255))
            }
        }
        if CommandLine.arguments.contains("line") {
            func px(_ im: RGBImage, _ x: Int, _ y: Int) -> String { String(format: "%3.0f,%3.0f,%3.0f", im.r[x, y] * 255, im.g[x, y] * 255, im.b[x, y] * 255) }
            let base = s.frames[an.baseIndex], d3 = s.frames[3]
            for x in stride(from: 8, to: 80, by: 6) { print(String(format: "   x=%3d  base %@   donor3 %@   result %@   ideal %@", x, px(base, x, 40), px(d3, x, 40), px(r, x, 40), px(ideal, x, 40))) }
        }
        if let z = zoomRegions[name] {
            let all = s.frames + [r, ideal]
            var tiles: [RGBImage] = []
            for rect in z { tiles += all.map { zoomed($0.crop(rect), 3) } }
            try PNG.write(ImageMetrics.montage(tiles, columns: all.count), to: out.appendingPathComponent("tripod_\(name)_zoom.png"))
        }
        try PNG.write(ImageMetrics.montage(an.weights.map { RGBImage(r: $0, g: $0, b: $0) } + an.quality.map { RGBImage(r: $0, g: $0, b: $0) }, columns: s.frames.count), to: out.appendingPathComponent("tripod_\(name)_maps.png"))
    }
}

/// What a photographer would call the evenly, well-lit version of the same specimen.
func idealImage(_ s: LightingSeries) -> RGBImage {
    let lin = ColorMath.toLinear(s.diffuse)
    var o = lin
    for i in 0..<o.r.count { o.r.pixels[i] *= 0.9; o.g.pixels[i] *= 0.9; o.b.pixels[i] *= 0.9 }
    return ColorMath.toEncoded(o)
}

/// PSNR after fitting one global linear-light gain (the fused picture may be globally brighter or darker than the ideal).
func fitPSNR(_ a: RGBImage, _ b: RGBImage) -> Double {
    let la = ColorMath.toLinear(a), lb = ColorMath.toLinear(b)
    var num = 0.0, den = 0.0
    for i in 0..<la.r.count { for (x, y) in [(la.r.pixels[i], lb.r.pixels[i]), (la.g.pixels[i], lb.g.pixels[i]), (la.b.pixels[i], lb.b.pixels[i])] { num += Double(x * y); den += Double(x * x) } }
    let g = Float(num / max(den, 1e-9))
    var scaled = la
    for i in 0..<scaled.r.count { scaled.r.pixels[i] *= g; scaled.g.pixels[i] *= g; scaled.b.pixels[i] *= g }
    return ImageMetrics.psnr(ColorMath.toEncoded(scaled), b, in: PixelRect(x: 0, y: 0, width: a.width, height: a.height))
}

func tripodScenario(_ name: String) -> LightingSeries {
    switch name {
    case "bracket":
        // identical lighting, four exposures spanning ~4.5 stops: the darkest keeps the highlights, the brightest lifts the shadows
        let specs = [0.10, 0.30, 0.9, 2.6].map { LightingFrameSpec(shadeAngle: 0.6, shadeAmount: 0.15, gain: Float($0)) }
        return SyntheticLighting.make(width: 512, height: 384, specs: specs, seed: 11, noise: 0.004)
    case "bracket2":
        // three exposures with a hot base: the best frame still clips a few percent, the darkest keeps those highlights
        let specs = [0.25, 1.4, 4.0].map { LightingFrameSpec(shadeAngle: 0.6, shadeAmount: 0.15, gain: Float($0)) }
        return SyntheticLighting.make(width: 512, height: 384, specs: specs, seed: 21, noise: 0.004)
    case "lamps":
        // one lamp moved to four sides: each frame is blown near the lamp and dark on the far side; two also carry a specular glare
        let specs = [
            LightingFrameSpec(shadeAngle: 0.0, shadeAmount: 1.15, gain: 0.95, glares: [GlareBlob(cx: 0.18, cy: 0.35, sigma: 0.05, amplitude: 3.0)]),
            LightingFrameSpec(shadeAngle: Float.pi, shadeAmount: 1.15, gain: 0.95),
            LightingFrameSpec(shadeAngle: Float.pi / 2, shadeAmount: 1.15, gain: 0.95, glares: [GlareBlob(cx: 0.62, cy: 0.80, sigma: 0.05, amplitude: 3.0)]),
            LightingFrameSpec(shadeAngle: -Float.pi / 2, shadeAmount: 1.15, gain: 0.95),
        ]
        return SyntheticLighting.make(width: 512, height: 384, specs: specs, seed: 12, noise: 0.004)
    default:
        // lamps plus a dim, even frame (a typical "fill" shot)
        var specs = [
            LightingFrameSpec(shadeAngle: 0.3, shadeAmount: 1.0, gain: 1.3),
            LightingFrameSpec(shadeAngle: 3.4, shadeAmount: 1.0, gain: 1.3, glares: [GlareBlob(cx: 0.70, cy: 0.30, sigma: 0.05, amplitude: 3.0)]),
            LightingFrameSpec(shadeAngle: 1.6, shadeAmount: 0.15, gain: 0.30),
        ]
        specs.append(LightingFrameSpec(shadeAngle: 4.7, shadeAmount: 1.0, gain: 1.1))
        specs.append(LightingFrameSpec(shadeAngle: 0.0, shadeAmount: 0.4, gain: 0.7))
        return SyntheticLighting.make(width: 512, height: 384, specs: specs, seed: 13, noise: 0.004)
    }
}


/// Regions to inspect closely (full-resolution coordinates), set from the command line: `zoom=x,y,w,h;x,y,w,h`.
var zoomRegions: [String: [PixelRect]] = {
    var out: [String: [PixelRect]] = [:]
    for a in CommandLine.arguments where a.hasPrefix("zoom=") {
        let parts = a.dropFirst(5).split(separator: ":")
        guard parts.count == 2 else { continue }
        let rects: [PixelRect] = parts[1].split(separator: ";").compactMap {
            let v = $0.split(separator: ",").compactMap { Int($0) }
            return v.count == 4 ? PixelRect(x: v[0], y: v[1], width: v[2], height: v[3]) : nil
        }
        out[String(parts[0])] = rects
    }
    return out
}()

func zoomed(_ img: RGBImage, _ k: Int) -> RGBImage {
    var o = RGBImage(width: img.width * k, height: img.height * k)
    for y in 0..<o.height { for x in 0..<o.width {
        let i = y * o.width + x, j = (y / k) * img.width + x / k
        o.r.pixels[i] = img.r.pixels[j]; o.g.pixels[i] = img.g.pixels[j]; o.b.pixels[i] = img.b.pixels[j]
    } }
    return o
}


/// The "muddy shadowed frame" unit-test scenario, for debugging selection.
func runMuddyLab(out: URL) throws {
    let hole = RegionEffect(x0: 0.2, y0: 0.2, x1: 0.5, y1: 0.55, gain: 0.07, feather: 10)
    let glare = GlareBlob(cx: 0.35, cy: 0.37, sigma: 0.06, amplitude: 3.5)
    let specs = [LightingFrameSpec(shadeAngle: 0, glares: [glare]),
                 LightingFrameSpec(shadeAngle: 3.0, regions: [hole]),
                 LightingFrameSpec(shadeAngle: 1.5), LightingFrameSpec(shadeAngle: 4.5)]
    let s = SyntheticLighting.make(specs: specs)
    var o = LightingStackOptions(); o.preferredBase = 0
    let sink = MemorySink(width: 512, height: 384)
    let an = try LightingStackEngine.run(frames: s.frames.map { MemoryFrame($0) }, sink: sink, options: o)
    print("contribution", an.contribution.map { String(format: "%.3f", $0) })
    do {   // weight mass inside the dark hole of frame 1 (x 0.2–0.5, y 0.2–0.55 of the image, minus the feathered rim)
        let x0 = Int(0.2 * 512) + 12, x1 = Int(0.5 * 512) - 12, y0 = Int(0.2 * 384) + 12, y1 = Int(0.55 * 384) - 12
        var m = [Float](repeating: 0, count: an.weights.count); var cnt: Float = 0
        for y in y0..<y1 { for x in x0..<x1 { cnt += 1; for j in 0..<m.count { m[j] += an.weights[j][x / an.proxyFactor, y / an.proxyFactor] } } }
        print("weight inside the hole", m.map { String(format: "%.3f", $0 / cnt) })
    }
    try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
    try PNG.write(ImageMetrics.montage(an.quality.map { RGBImage(r: $0, g: $0, b: $0) } + an.weights.map { RGBImage(r: $0, g: $0, b: $0) }, columns: 4), to: out.appendingPathComponent("muddy_maps.png"))
    try PNG.write(ImageMetrics.montage(s.frames + [sink.result], columns: 5), to: out.appendingPathComponent("muddy_frames.png"))
    let f = an.proxyFactor
    for (px, py) in [(180, 140), (120, 100), (240, 150), (170, 200)] {
        let i = (py / f) * an.weights[0].width + px / f
        print("probe(\(px),\(py)) w=" + an.weights.map { String(format: "%.2f", $0.pixels[i]) }.joined(separator: ",") + " Q=" + an.quality.map { String(format: "%.2f", $0.pixels[i]) }.joined(separator: ","))
    }
}


/// The "brightness alone does not disqualify a region" unit-test scenario.
func runSheenLab(out: URL) throws {
    let specs = [LightingFrameSpec(shadeAngle: 0, glares: [GlareBlob(cx: 0.5, cy: 0.5, sigma: 0.09, amplitude: 0.35)]),
                 LightingFrameSpec(shadeAngle: 1.5), LightingFrameSpec(shadeAngle: 3.0)]
    let s = SyntheticLighting.make(specs: specs)
    var o = LightingStackOptions(); o.preferredBase = 0
    let sink = MemorySink(width: 512, height: 384)
    let an = try LightingStackEngine.run(frames: s.frames.map { MemoryFrame($0) }, sink: sink, options: o)
    print("contribution", an.contribution.map { String(format: "%.3f", $0) }, "tone beta", an.tone.beta)
    try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
    try PNG.write(ImageMetrics.montage(an.quality.map { RGBImage(r: $0, g: $0, b: $0) } + an.weights.map { RGBImage(r: $0, g: $0, b: $0) }, columns: 3), to: out.appendingPathComponent("sheen_maps.png"))
    try PNG.write(ImageMetrics.montage(s.frames + [sink.result], columns: 4), to: out.appendingPathComponent("sheen_frames.png"))
    let spot = PixelRect(x: 236, y: 172, width: 40, height: 40)
    print("spot luma: base \(ImageMetrics.meanLuma(s.frames[0], in: spot)) result \(ImageMetrics.meanLuma(sink.result, in: spot))")
}
