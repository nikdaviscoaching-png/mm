import Foundation
import SpecimenCore
import SpecimenTestKit

/// Writes a test frame, the shader parameters and the Swift reference results for `tools/msl-shim/run.sh`, which compiles the app's
/// Metal shader text with clang++ and compares its output with these. `specimen-lab msl-dump <dir>`.
func runMslDump(out: URL) throws {
    try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
    let W = 640, H = 480
    let s = SyntheticFocus.make(width: W, height: H, frames: 4, seed: 3, noise: 0.01, breathing: 0)
    let img = s.frames[1]
    var bgra = [UInt8](repeating: 255, count: W * H * 4)
    for i in 0..<(W * H) {
        func q(_ v: Float) -> UInt8 { UInt8(min(max(v, 0), 1) * 255 + 0.5) }
        bgra[i * 4] = q(img.b.pixels[i]); bgra[i * 4 + 1] = q(img.g.pixels[i]); bgra[i * 4 + 2] = q(img.r.pixels[i])
    }
    var frame = Data()
    withUnsafeBytes(of: Int32(W)) { frame.append(contentsOf: $0) }; withUnsafeBytes(of: Int32(H)) { frame.append(contentsOf: $0) }
    frame.append(contentsOf: bgra)
    try frame.write(to: out.appendingPathComponent("frame.bin"))

    let luma: [Float] = bgra.withUnsafeBufferPointer { FocusPeaking.luma(bgra: $0, width: W, height: H, bytesPerRow: W * 4) }
    // analyse only a sub-rectangle (as the GPU does when magnified) and render a magnified view of part of it
    let roi = PixelRect(x: 100, y: 60, width: 400, height: 330)
    let sens = PeakingSensitivity.medium
    let p = FocusPeaking.parameters(luma: luma, width: W, height: H, sensitivity: sens, region: roi)
    let cand = FocusPeaking.candidates(luma: luma, width: W, height: H, threshold: p.threshold, minSteepness: p.minSteepness, region: roi)
    let ridge = FocusPeaking.applySupport(cand, region: roi)
    func pack(_ r: PeakingRidges) -> Data { var d = Data(); for i in 0..<(W * H) { d.append(r.flag[i]); d.append(r.angle[i]) }; return d }
    try pack(cand).write(to: out.appendingPathComponent("ref_cand.bin"))
    try pack(ridge).write(to: out.appendingPathComponent("ref_ridge.bin"))

    let view = (x: Float(210), y: Float(150), w: Float(120), h: Float(90)), outW = 480, outH = 360
    let viewScale = Float(outW) / view.w
    let cover = PeakingRenderer.render(ridge, region: (x: view.x, y: view.y, width: view.w, height: view.h), outWidth: outW, outHeight: outH)
    try cover.withUnsafeBufferPointer { Data(buffer: $0) }.write(to: out.appendingPathComponent("ref_view.bin"))
    let params = "\(p.threshold) \(p.minSteepness) \(roi.x) \(roi.y) \(roi.width) \(roi.height) \(view.x) \(view.y) \(view.w) \(view.h) \(outW) \(outH) \(viewScale) \(PeakingRenderer.lineHalfWidth(viewScale: viewScale)) \(PeakingRenderer.segmentHalfLength) 0.92\n"
    try params.write(to: out.appendingPathComponent("params.txt"), atomically: true, encoding: .utf8)
    print("msl-dump: threshold \(p.threshold) steepness \(p.minSteepness) ridge pixels \(ridge.markedCount)")
}
