import Foundation
import SpecimenCore
import SpecimenTestKit

// Developer-only headless runner: generates synthetic datasets, runs the stacking pipelines, writes PNGs.
let args = CommandLine.arguments
let out = URL(fileURLWithPath: args.count > 2 ? args[2] : "lab-out")
switch args.count > 1 ? args[1] : "help" {
case "msl-dump":
    try runMslDump(out: out)
case "tripod":
    try runTripodLab(out: out, only: args.count > 3 && !args[3].contains("=") ? args[3] : nil)
case "stdstats":
    let s = SyntheticLighting.standardScenario()
    let rr = PixelRect(x: 372, y: 8, width: 130, height: 100)
    for (i, f) in s.frames.enumerated() {
        var clip = 0, hi = 0, tot = 0; var mx: Float = 0
        for y in rr.y..<rr.maxY { for x in rr.x..<rr.maxX { tot += 1; let m = max(f.r[x, y], f.g[x, y], f.b[x, y]); mx = max(mx, m); if m >= 0.985 { clip += 1 }; if f.luma(.displayP3)[x, y] >= 0.88 { hi += 1 } } }
        print("frame \(i): hairline patch clipped \(100 * Double(clip) / Double(tot))%  Y>=0.88: \(100 * Double(hi) / Double(tot))%  mean luma \(ImageMetrics.meanLuma(f, in: rr))")
    }
case "sheen":
    try runSheenLab(out: out)
case "muddy":
    try runMuddyLab(out: out)
case "peaking":
    try runPeakingLab(out: out)
case "gen-focus":
    let s = SyntheticFocus.make(width: 512, height: 384, frames: 8)
    try PNG.write(s.groundTruth, to: out.appendingPathComponent("focus_truth.png"))
    try PNG.write(ImageMetrics.montage(s.frames, columns: 4), to: out.appendingPathComponent("focus_frames.png"))
    try PNG.write(s.depth, to: out.appendingPathComponent("focus_depth.png"))
    print("wrote", out.path)
case "light":
    var s = SyntheticLighting.standardScenario()
    if let nArg = args.first(where: { $0.hasPrefix("n=") }), let n = Int(nArg.dropFirst(2)) { s.frames = Array(s.frames.prefix(n)); s.clean = Array(s.clean.prefix(n)) }
    var opts = LightingStackOptions()
    for a in args.dropFirst(3) {
        let kv = a.split(separator: "="); guard kv.count == 2, let v = Float(kv[1]) else { continue }
        switch kv[0] {
        case "power": opts.qualityPower = v
        case "gain": opts.matchLocalLighting = v > 0
        case "base": opts.preferredBase = Int(v)
        case "levels": opts.levels = Int(v)
        default: break
        }
    }
    let sink = MemorySink(width: 512, height: 384)
    let t0 = Date()
    let an = try LightingStackEngine.run(frames: s.frames.map { MemoryFrame($0) }, sink: sink, options: opts)
    let r = sink.result
    print("time", Date().timeIntervalSince(t0), "proxy factor", an.proxyFactor, "base", an.baseIndex, "scores", an.frameScores.map { String(format: "%.2f", $0) }, "contrib", an.contribution.map { String(format: "%.2f", $0) })
    try PNG.write(ImageMetrics.montage([r, s.frames[an.baseIndex]], columns: 2), to: out.appendingPathComponent("light_result.png"))
    try PNG.write(ImageMetrics.montage(an.quality.map { RGBImage(r: $0, g: $0, b: $0) } + an.weights.map { RGBImage(r: $0, g: $0, b: $0) }, columns: 4), to: out.appendingPathComponent("light_maps.png"))
    // metrics vs the defect-free base rendering
    let cleanBase = s.clean[an.baseIndex]
    let glareCore = PixelRect(x: 130, y: 90, width: 50, height: 60)
    print("glare core mean luma: result", ImageMetrics.meanLuma(r, in: glareCore), "base frame", ImageMetrics.meanLuma(s.frames[an.baseIndex], in: glareCore), "clean frames", s.clean.map { ImageMetrics.meanLuma($0, in: glareCore) })
    do {
        let rc = PixelRect(x: 335, y: 255, width: 50, height: 40)
        func f(_ t: (Double, Double, Double)) -> String { String(format: "%.3f %.3f %.3f", t.0, t.1, t.2) }
        print("rect lower: result", f(ImageMetrics.meanColor(r, in: rc)), "| clean base", f(ImageMetrics.meanColor(cleanBase, in: rc)), "| frames", (0..<s.frames.count).map { f(ImageMetrics.meanColor(s.frames[$0], in: rc)) })
        print("weights at rect:", an.weights.map { String(format: "%.2f", $0[335 / an.proxyFactor + 25, 255 / an.proxyFactor + 20]) }, "gains", an.gains.map { String(format: "%.2f", $0[360, 275]) })
    }
    do {
        func mass(_ r: PixelRect) -> [String] { an.weights.map { w in var t: Float = 0; for y in r.y..<r.maxY { for x in r.x..<r.maxX { t += w[x / an.proxyFactor, y / an.proxyFactor] } }; return String(format: "%.3f", t / Float(r.pixelCount)) } }
        for rr in [PixelRect(x: 8, y: 330, width: 100, height: 45), PixelRect(x: 8, y: 240, width: 150, height: 130)] { print("PSNR vs base frame in", rr, ImageMetrics.psnr(r, s.frames[an.baseIndex], in: rr)) }
        print("calm region weights", mass(PixelRect(x: 8, y: 240, width: 150, height: 130)), "hairline region", mass(PixelRect(x: 372, y: 8, width: 130, height: 100)))
        if let ys = ProcessInfo.processInfo.environment["LAB_Q"] { _ = ys }
    }
    print("PSNR result vs clean base", ImageMetrics.psnr(r, cleanBase), " base frame vs clean base", ImageMetrics.psnr(s.frames[an.baseIndex], cleanBase))
    let hp = PixelRect(x: 372, y: 8, width: 130, height: 100)
    print("hairline patch: PSNR result vs clean", ImageMetrics.psnr(r, cleanBase, in: hp), " base frame vs clean", ImageMetrics.psnr(s.frames[an.baseIndex], cleanBase, in: hp), " result vs base frame", ImageMetrics.psnr(r, s.frames[an.baseIndex], in: hp), " sharpness result/base/clean", ImageMetrics.sharpness(r, in: hp), ImageMetrics.sharpness(s.frames[an.baseIndex], in: hp), ImageMetrics.sharpness(cleanBase, in: hp))
    try PNG.write(ImageMetrics.montage([s.frames[an.baseIndex].crop(hp), r.crop(hp), cleanBase.crop(hp)], columns: 3), to: out.appendingPathComponent("light_hairline.png"))
case "bench":
    // bench <outdir> <width> <height> <frames> <focus|lighting> [concurrency]: file-backed pipeline timing + peak memory.
    let W = Int(args[3])!, H = Int(args[4])!, N = Int(args[5])!, kind = args[6]
    let conc = args.count > 7 ? Int(args[7])! : 2
    func peakRSSMB() -> Int { (try? String(contentsOfFile: "/proc/self/status", encoding: .utf8))?.split(separator: "\n").first { $0.hasPrefix("VmHWM") }.flatMap { Int($0.split(separator: " ").dropFirst().first ?? "0") }.map { $0 / 1024 } ?? 0 }
    try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
    let base = kind == "focus" ? SyntheticFocus.make(width: 512, height: 384, frames: N, seed: 3, noise: 0.003, breathing: 0).frames
                               : SyntheticLighting.standardScenario(width: 512, height: 384).frames
    var urls: [URL] = []
    for i in 0..<N {
        let src = base[i % base.count]
        let u = out.appendingPathComponent("bench_\(i).scw")
        let w = try ScwWriter(url: u, width: W, height: H, colorSpace: .displayP3)
        for t in TileGrid(imageWidth: W, imageHeight: H, tileSize: 512, halo: 0).tiles {
            var tile = RGBImage(width: t.core.width, height: t.core.height)
            for y in 0..<t.core.height { for x in 0..<t.core.width {
                let sx = min(Int(Float(t.core.x + x) * 512 / Float(W)), 511), sy = min(Int(Float(t.core.y + y) * 384 / Float(H)), 383)
                tile.r[x, y] = src.r[sx, sy]; tile.g[x, y] = src.g[sx, sy]; tile.b[x, y] = src.b[sx, sy]
            }}
            try w.write(region: t.core, image: tile)
        }
        try w.finish(); urls.append(u)
    }
    print("prepared \(N) frames \(W)x\(H); RSS after prep \(peakRSSMB()) MB")
    let frames = try urls.map { try ScwFrame(url: $0) as any FrameSource }
    let outURL = out.appendingPathComponent("bench_out.scw")
    let writer = try ScwWriter(url: outURL, width: W, height: H, colorSpace: .displayP3)
    let t0 = Date()
    if kind == "focus" {
        var o = FocusStackOptions.preset(.high); o.concurrency = conc
        _ = try FocusStackEngine.fuse(frames: frames, sink: writer, options: o)
    } else {
        var o = LightingStackOptions.preset(.high); o.concurrency = conc
        _ = try LightingStackEngine.run(frames: frames, sink: writer, options: o)
    }
    try writer.finish()
    let dt = Date().timeIntervalSince(t0)
    print(String(format: "%@ %dx%d x%d frames, concurrency %d: %.1f s  (%.1f s per frame, %.2f s per MP·frame), peak RSS %d MB", kind, W, H, N, conc, dt, dt / Double(N), dt / Double(N) / (Double(W * H) / 1e6), peakRSSMB()))
    for u in urls { try? FileManager.default.removeItem(at: u) }
    try? FileManager.default.removeItem(at: outURL)
case "icon":
    // 1024² app icon: concentric agate bands from the synthetic specimen texture, dark rim.
    var img = SyntheticSpecimen.texture(width: 1024, height: 1024, seed: 12)
    for y in 0..<1024 { for x in 0..<1024 {
        let d = hypotf(Float(x) - 512, Float(y) - 512) / 512
        let vig = 1 - 0.85 * smoothstep(0.62, 1.0, d)
        img.r[x, y] *= vig; img.g[x, y] *= vig; img.b[x, y] *= vig
    }}
    try PNG.write(img, to: out.appendingPathComponent("AppIcon.png"))
case "gen-light":
    let s = SyntheticLighting.standardScenario()
    try PNG.write(ImageMetrics.montage(s.frames, columns: 2), to: out.appendingPathComponent("light_frames.png"))
case "inspect":
    let s = SyntheticFocus.make(width: 512, height: 384, frames: 8, seed: 3, noise: 0.003, breathing: 0)
    print("depth at probe", s.depth[95, 290], "focus depths", s.focusDepths)
    for fi in [0, 2, 4, 7] {
        print("frame", fi, (88...102).map { String(format: "%.3f", s.frames[fi].g[$0, 290]) }.joined(separator: " "))
    }
    print("truth  ", (88...102).map { String(format: "%.3f", s.groundTruth.g[$0, 290]) }.joined(separator: " "))
case "focus":
    let s = SyntheticFocus.make(width: 512, height: 384, frames: 8, seed: 3, noise: 0.003, breathing: 0)
    var opts = FocusStackOptions()
    for a in args.dropFirst(3) {
        let kv = a.split(separator: "="); guard kv.count == 2, let v = Float(kv[1]) else { continue }
        switch kv[0] {
        case "sel": opts.selectionPower = v
        case "fmap": opts.focusMapPower = v
        case "sal": opts.saliencySigma = v
        case "agg": opts.focusAggregationSigma = v
        case "wide": opts.widePower = v
        case "wsig": opts.wideSigma = v
        case "dead": opts.noiseDeadZone = v
        case "soft": opts.noiseSoftness = v
        case "levels": opts.levels = Int(v)
        default: break
        }
    }
    let sink = MemorySink(width: 512, height: 384)
    let t0 = Date()
    let rep = try FocusStackEngine.fuse(frames: s.frames.map { MemoryFrame($0) }, sink: sink, options: opts)
    let r = sink.result
    print("time", Date().timeIntervalSince(t0), "noise", rep.noiseSigma, "dominant", rep.dominantPixels)
    print("PSNR fused", ImageMetrics.psnr(r, s.groundTruth), "best single", s.frames.map { ImageMetrics.psnr($0, s.groundTruth) }.max()!)
    print("sharp truth", ImageMetrics.sharpness(s.groundTruth), "fused", ImageMetrics.sharpness(r))
    var oracle = RGBImage(width: 512, height: 384)
    for y in 0..<384 { for x in 0..<512 {
        var bi = 0; var bd: Float = 9
        for i in 0..<s.frames.count { let d = abs(s.focusDepths[i] - s.depth[x, y]); if d < bd { bd = d; bi = i } }
        oracle.r[x, y] = s.frames[bi].r[x, y]; oracle.g[x, y] = s.frames[bi].g[x, y]; oracle.b[x, y] = s.frames[bi].b[x, y]
    }}
    do {  // local metric: the flat red cell near (95,290)
        let cell = PixelRect(x: 88, y: 283, width: 14, height: 14)
        let cf = ImageMetrics.meanColor(r, in: cell), ct = ImageMetrics.meanColor(s.groundTruth, in: cell), co = ImageMetrics.meanColor(oracle, in: cell)
        print(String(format: "cell mean fused %.3f %.3f %.3f | truth %.3f %.3f %.3f | oracle %.3f %.3f %.3f", cf.0, cf.1, cf.2, ct.0, ct.1, ct.2, co.0, co.1, co.2))
    }
    print("PSNR oracle hard-select", ImageMetrics.psnr(oracle, s.groundTruth))
    func zoom(_ im: RGBImage, _ rc: PixelRect, _ f: Int) -> RGBImage {
        let c = im.crop(rc); var o = RGBImage(width: rc.width * f, height: rc.height * f)
        for y in 0..<o.height { for x in 0..<o.width { o.r[x, y] = c.r[x / f, y / f]; o.g[x, y] = c.g[x / f, y / f]; o.b[x, y] = c.b[x / f, y / f] } }
        return o
    }
    let rc = PixelRect(x: 250, y: 90, width: 120, height: 90)
    let rc2 = PixelRect(x: 20, y: 230, width: 120, height: 90)
    try PNG.write(ImageMetrics.montage([zoom(s.groundTruth, rc, 3), zoom(r, rc, 3), zoom(oracle, rc, 3), zoom(s.groundTruth, rc2, 3), zoom(r, rc2, 3), zoom(oracle, rc2, 3)], columns: 3), to: out.appendingPathComponent("focus_zoom.png"))
    try PNG.write(r, to: out.appendingPathComponent("focus_fused.png"))
    var diff = RGBImage(width: 512, height: 384)
    for i in 0..<diff.r.count { let d = abs(r.r.pixels[i] - s.groundTruth.r.pixels[i]) * 6; diff.r.pixels[i] = d; diff.g.pixels[i] = d; diff.b.pixels[i] = d }
    try PNG.write(diff, to: out.appendingPathComponent("focus_diff.png"))
default:
    print("usage: specimen-lab gen-focus <outdir>")
}
