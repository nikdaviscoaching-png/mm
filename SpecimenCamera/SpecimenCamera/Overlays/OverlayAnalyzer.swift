import Foundation
import AVFoundation
import CoreVideo
import SwiftUI
import SpecimenCore

/// Receives live camera frames and produces everything drawn over the preview: GPU peaking/zebras/magnifier, the histogram,
/// and — only if Metal is unavailable — a small CPU-rendered peaking image using the same (unit-tested) algorithm.
@MainActor
final class OverlayAnalyzer: ObservableObject {
    @Published private(set) var histogram = HistogramData()
    @Published private(set) var bufferAspect: CGFloat = 3.0 / 4.0       // width / height of the (upright) video buffer
    @Published private(set) var cpuOverlay: CGImage?
    @Published private(set) var usingGPU = true
    @Published var config = OverlayConfig() { didSet { box.set(config) } }

    private let box = ConfigBox()
    let renderer: OverlayRenderer?

    init() {
        let r = OverlayRenderer(useMetal: true)
        renderer = r
        box.renderer = r                 // set once, before any frame arrives; never replaced
        usingGPU = r != nil
    }

    /// Called on the camera's video queue.
    nonisolated func process(_ pb: CVPixelBuffer) {
        let cfg = box.get()
        let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb)
        if box.dimensionsChanged(w, h) {
            let a = CGFloat(w) / CGFloat(max(h, 1))
            Task { @MainActor in self.bufferAspect = a }
        }
        if let r = rendererForVideoQueue { r.ingest(pixelBuffer: pb, config: cfg) }
        let n = box.nextFrame()
        if cfg.histogram != .off, n % 4 == 0 {
            CVPixelBufferLockBaseAddress(pb, .readOnly)
            if let base = CVPixelBufferGetBaseAddress(pb) {
                let bpr = CVPixelBufferGetBytesPerRow(pb)
                let buf = UnsafeBufferPointer(start: base.assumingMemoryBound(to: UInt8.self), count: bpr * h)
                let hist = HistogramRenderer.compute(bgra: buf, width: w, height: h, bytesPerRow: bpr)
                CVPixelBufferUnlockBaseAddress(pb, .readOnly)
                Task { @MainActor in self.histogram = hist }
            } else { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
        }
        if rendererForVideoQueue == nil, cfg.peaking != .off, n % 3 == 0 { cpuFallback(pb, cfg) }
    }

    // The renderer is created once on init and never replaced, so reading it from the video queue is safe.
    private nonisolated var rendererForVideoQueue: OverlayRenderer? { box.renderer }

    private nonisolated func cpuFallback(_ pb: CVPixelBuffer, _ cfg: OverlayConfig) {
        guard box.beginCPU() else { return }
        let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb)
        let step = max(1, w / 640)
        let sw = w / step, sh = h / step
        CVPixelBufferLockBaseAddress(pb, .readOnly)
        guard let base = CVPixelBufferGetBaseAddress(pb) else { CVPixelBufferUnlockBaseAddress(pb, .readOnly); box.endCPU(); return }
        let bpr = CVPixelBufferGetBytesPerRow(pb)
        let p = base.assumingMemoryBound(to: UInt8.self)
        var luma = [UInt8](repeating: 0, count: sw * sh)
        for y in 0..<sh { for x in 0..<sw {
            let i = (y * step) * bpr + (x * step) * 4
            luma[y * sw + x] = UInt8((Int(p[i + 2]) * 54 + Int(p[i + 1]) * 183 + Int(p[i]) * 19) >> 8)
        }}
        CVPixelBufferUnlockBaseAddress(pb, .readOnly)
        let mask = FocusPeaking.mask(luma: luma, width: sw, height: sh, sensitivity: cfg.peaking)
        var bgra = FocusPeaking.overlayBGRA(mask: mask, width: sw, height: sh, color: cfg.peakingColor)
        let img: CGImage? = bgra.withUnsafeMutableBytes { raw in
            guard let ctx = CGContext(data: raw.baseAddress, width: sw, height: sh, bitsPerComponent: 8, bytesPerRow: sw * 4, space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { return nil }
            return ctx.makeImage()
        }
        box.endCPU()
        Task { @MainActor in self.cpuOverlay = img }
    }
}

/// Thread-safe holder shared between the main actor and the video queue.
private final class ConfigBox: @unchecked Sendable {
    private let lock = NSLock()
    private var config = OverlayConfig()
    private var frames = 0
    private var cpuBusy = false
    private var lastDims = (0, 0)
    func dimensionsChanged(_ w: Int, _ h: Int) -> Bool {
        lock.lock(); defer { lock.unlock() }
        if lastDims.0 == w && lastDims.1 == h { return false }
        lastDims = (w, h); return true
    }
    var renderer: OverlayRenderer? {
        get { lock.lock(); defer { lock.unlock() }; return _renderer }
        set { lock.lock(); _renderer = newValue; lock.unlock() }
    }
    private var _renderer: OverlayRenderer?
    func set(_ c: OverlayConfig) { lock.lock(); config = c; lock.unlock() }
    func get() -> OverlayConfig { lock.lock(); defer { lock.unlock() }; return config }
    func nextFrame() -> Int { lock.lock(); defer { lock.unlock() }; frames += 1; return frames }
    func beginCPU() -> Bool { lock.lock(); defer { lock.unlock() }; if cpuBusy { return false }; cpuBusy = true; return true }
    func endCPU() { lock.lock(); cpuBusy = false; lock.unlock() }
}
