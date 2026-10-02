import Foundation
import MetalKit
import CoreVideo
import SpecimenCore

/// Live overlay parameters (set from the main thread, read on the video queue).
struct OverlayConfig: Equatable, Sendable {
    var peaking: PeakingSensitivity = .medium
    var peakingColor: PeakingColor = .red
    var zebra: ZebraLevel = .off
    var histogram: HistogramMode = .off
    /// Magnification (1 = off). Inspection only: it changes what is *displayed*, never what is captured.
    var zoom: Double = 1
    /// Centre of the magnified region in normalised image coordinates (0…1).
    var center: CGPoint = CGPoint(x: 0.5, y: 0.5)
}

/// GPU focus peaking (hairline edge traces), zebras and the magnified inspection view.
/// Falls back (returns `nil` from `init`) if Metal or the shader is unavailable; callers then use the CPU overlay.
/// The algorithm and drawing rules are documented in `OverlayShaders.swift` and implemented (and unit-tested) in
/// `SpecimenCore.FocusPeaking` / `PeakingRenderer`.
final class OverlayRenderer: NSObject, MTKViewDelegate, @unchecked Sendable {

    /// From this magnification on, only the visible part of the frame is analysed (at 8× that is 1/64 of the pixels).
    static let visibleRegionOnlyZoom = 2.0

    private let device: MTLDevice
    private let queue: MTLCommandQueue
    private var textureCache: CVMetalTextureCache?
    private let candidatePipeline: MTLComputePipelineState
    private let finishPipeline: MTLComputePipelineState
    private var presentPipeline: MTLRenderPipelineState?
    private let lock = NSLock()

    private var candTexture: MTLTexture?          // ridge candidates (flag, direction), rg8
    private var ridgeTexture: MTLTexture?         // ridges after the neighbour test, rg8
    private var overlayTexture: MTLTexture?       // zebra stripes, rgba8
    private var latestVideo: MTLTexture?
    private var latestTextureWidth: Float = 1
    private var retainedCV: CVMetalTexture?
    private var params = PeakingGPUParams()
    private var frameIndex: Float = 0
    private var smoothedThreshold: Float?         // video queue only
    private var smoothedSteepness: Float = 1
    private var lastSensitivity: PeakingSensitivity = .off
    private weak var view: MTKView?

    init?(useMetal: Bool) {
        guard let device = MTLCreateSystemDefaultDevice(), let queue = device.makeCommandQueue() else { return nil }
        self.device = device; self.queue = queue
        do {
            let lib = try device.makeLibrary(source: OverlayShaders.source, options: nil)
            guard let cand = lib.makeFunction(name: "peakCandidates"), let fin = lib.makeFunction(name: "peakFinish") else { return nil }
            candidatePipeline = try device.makeComputePipelineState(function: cand)
            finishPipeline = try device.makeComputePipelineState(function: fin)
            let desc = MTLRenderPipelineDescriptor()
            desc.vertexFunction = lib.makeFunction(name: "vsMain")
            desc.fragmentFunction = lib.makeFunction(name: "fsMain")
            desc.colorAttachments[0].pixelFormat = .bgra8Unorm
            presentPipeline = try device.makeRenderPipelineState(descriptor: desc)
        } catch {
            Log.overlay.error("Metal overlay unavailable, using CPU fallback: \(error.localizedDescription, privacy: .public)")
            return nil
        }
        super.init()
        CVMetalTextureCacheCreate(nil, nil, device, nil, &textureCache)
        Log.overlay.info("Metal overlay renderer ready")
    }

    func attach(_ view: MTKView) {
        self.view = view
        view.device = device
        view.delegate = self
        view.colorPixelFormat = .bgra8Unorm
        view.framebufferOnly = true
        view.isOpaque = false
        view.backgroundColor = .clear
        view.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
        view.preferredFramesPerSecond = 30
        view.isPaused = false
        view.enableSetNeedsDisplay = false
    }

    /// Video queue. Builds the overlay for this frame on the GPU.
    func ingest(pixelBuffer pb: CVPixelBuffer, config: OverlayConfig) {
        guard let cache = textureCache else { return }
        let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb)
        var cvTex: CVMetalTexture?
        guard CVMetalTextureCacheCreateTextureFromImage(nil, cache, pb, nil, .bgra8Unorm, w, h, 0, &cvTex) == kCVReturnSuccess,
              let cv = cvTex, let src = CVMetalTextureGetTexture(cv) else { return }
        ensureTextures(width: w, height: h)
        guard let cand = candTexture, let ridge = ridgeTexture, let overlay = overlayTexture else { return }

        var p = PeakingGPUParams()
        p.peakingOn = config.peaking == .off ? 0 : 1
        let zoom = max(config.zoom, 1)
        let size = Float(1 / zoom)
        let ox = Float(min(max(config.center.x - 0.5 / zoom, 0), 1 - 1 / zoom))
        let oy = Float(min(max(config.center.y - 0.5 / zoom, 0), 1 - 1 / zoom))
        p.roiSize = SIMD2<Float>(size, size); p.roiOrigin = SIMD2<Float>(ox, oy)
        p.showVideo = zoom > 1 ? 1 : 0
        // Magnified: analyse only what is on screen (plus a margin). At 8x that is 1/64 of the frame, which keeps the phone cool.
        var x0 = 0, y0 = 0, x1 = w, y1 = h
        if zoom >= Self.visibleRegionOnlyZoom {
            x0 = max(0, Int((ox * Float(w)).rounded(.down)) - 3); y0 = max(0, Int((oy * Float(h)).rounded(.down)) - 3)
            x1 = min(w, Int(((ox + size) * Float(w)).rounded(.up)) + 3); y1 = min(h, Int(((oy + size) * Float(h)).rounded(.up)) + 3)
        }
        p.cOrigin = SIMD2<UInt32>(UInt32(x0), UInt32(y0)); p.cSize = SIMD2<UInt32>(UInt32(max(x1 - x0, 1)), UInt32(max(y1 - y0, 1)))
        if p.peakingOn > 0 {
            let prm = FocusPeaking.parameters(fromSampledResponses: Self.sampledStrengths(pb, x0: x0, y0: y0, x1: x1, y1: y1), sensitivity: config.peaking)
            // smooth over a few frames so the marks do not flicker as the noise estimate wobbles
            if config.peaking != lastSensitivity { smoothedThreshold = nil; smoothedSteepness = prm.minSteepness; lastSensitivity = config.peaking }
            let t = smoothedThreshold.map { $0 + (prm.threshold - $0) * 0.35 } ?? prm.threshold
            smoothedThreshold = t
            smoothedSteepness += (prm.minSteepness - smoothedSteepness) * 0.35
            p.threshold = t; p.minSteepness = smoothedSteepness
        }
        let c = config.peakingColor.rgb
        p.peakColor = SIMD4<Float>(c.0, c.1, c.2, 0.92)
        if let z = config.zebra.threshold { p.zebraOn = 1; p.zebraThreshold = Float(z) / 255 }
        frameIndex += 1
        p.stripePhase = Float(Int(frameIndex) % 10)        // slowly crawling stripes

        guard let cb = queue.makeCommandBuffer() else { return }
        let tg = MTLSize(width: 16, height: 16, depth: 1)
        let groups = MTLSize(width: (Int(p.cSize.x) + 15) / 16, height: (Int(p.cSize.y) + 15) / 16, depth: 1)
        if let e = cb.makeComputeCommandEncoder() {
            // 1. ridge candidates (the same camera texture is bound twice: integer reads and hardware-bilinear samples)
            e.setComputePipelineState(candidatePipeline)
            e.setTexture(src, index: 0); e.setTexture(cand, index: 1); e.setTexture(src, index: 2)
            e.setBytes(&p, length: MemoryLayout<PeakingGPUParams>.stride, index: 0)
            e.dispatchThreadgroups(groups, threadsPerThreadgroup: tg)
            // 2. neighbour test + zebras
            e.setComputePipelineState(finishPipeline)
            e.setTexture(src, index: 0); e.setTexture(cand, index: 1); e.setTexture(ridge, index: 2); e.setTexture(overlay, index: 3)
            e.dispatchThreadgroups(groups, threadsPerThreadgroup: tg)
            e.endEncoding()
        }
        cb.addCompletedHandler { _ in _ = cv }              // keep the CVMetalTexture alive until the GPU is done
        cb.commit()
        lock.lock(); latestVideo = src; retainedCV = cv; params = p; latestTextureWidth = Float(w); lock.unlock()
    }

    private func ensureTextures(width w: Int, height h: Int) {
        if let t = candTexture, t.width == w, t.height == h { return }
        func descriptor(_ format: MTLPixelFormat) -> MTLTextureDescriptor {
            let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: format, width: w, height: h, mipmapped: false)
            d.usage = [.shaderRead, .shaderWrite]; d.storageMode = .private
            return d
        }
        lock.lock()
        candTexture = device.makeTexture(descriptor: descriptor(.rg8Unorm))
        ridgeTexture = device.makeTexture(descriptor: descriptor(.rg8Unorm))
        overlayTexture = device.makeTexture(descriptor: descriptor(.rgba8Unorm))
        lock.unlock()
    }

    // MARK: Noise-adaptive threshold from a sparse sample of the camera buffer

    /// Edge strength (Sobel ÷ 4 of luma, the same measure the kernels use) at every few pixels inside the analysed region.
    static func sampledStrengths(_ pb: CVPixelBuffer, x0: Int, y0: Int, x1: Int, y1: Int) -> [Float] {
        CVPixelBufferLockBaseAddress(pb, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(pb) else { return [] }
        let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb), bpr = CVPixelBufferGetBytesPerRow(pb)
        let ptr = base.assumingMemoryBound(to: UInt8.self)
        @inline(__always) func luma(_ x: Int, _ y: Int) -> Float {
            let i = y * bpr + x * 4
            return 0.2110 * Float(ptr[i + 2]) + 0.7148 * Float(ptr[i + 1]) + 0.0742 * Float(ptr[i])
        }
        let xa = max(x0, 3), ya = max(y0, 3), xb = min(x1, w - 3), yb = min(y1, h - 3)
        guard xb > xa, yb > ya else { return [] }
        // sparse over the whole frame, denser inside a small magnified region (about 12 000 samples either way)
        let step = max(2, min(7, Int(Double((xb - xa) * (yb - ya) / 12_000).squareRoot())))
        var out: [Float] = []
        out.reserveCapacity(((xb - xa) / step + 1) * ((yb - ya) / step + 1))
        var y = ya
        while y < yb {
            var x = xa
            while x < xb {
                let a = luma(x - 1, y - 1), b = luma(x, y - 1), c = luma(x + 1, y - 1)
                let d = luma(x - 1, y), f = luma(x + 1, y)
                let g = luma(x - 1, y + 1), hh = luma(x, y + 1), i = luma(x + 1, y + 1)
                let gx = ((c + 2 * f + i) - (a + 2 * d + g)) * 0.25, gy = ((g + 2 * hh + i) - (a + 2 * b + c)) * 0.25
                out.append((gx * gx + gy * gy).squareRoot())
                x += step
            }
            y += step
        }
        return out
    }

    // MARK: MTKViewDelegate

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

    func draw(in view: MTKView) {
        lock.lock()
        let overlay = overlayTexture, video = latestVideo, ridge = ridgeTexture, pipe = presentPipeline
        var p = params
        let texW = latestTextureWidth
        lock.unlock()
        guard let overlay, let video, let ridge, let pipe, let pass = view.currentRenderPassDescriptor, let drawable = view.currentDrawable,
              let cb = queue.makeCommandBuffer(), let enc = cb.makeRenderCommandEncoder(descriptor: pass) else { return }
        // Screen pixels per buffer pixel: the hairlines are sized in screen pixels, whatever the magnification.
        p.viewScale = max(Float(view.drawableSize.width) / max(texW * p.roiSize.x, 1), 0.1)
        p.lineHalfWidth = PeakingRenderer.lineHalfWidth(viewScale: p.viewScale)
        p.segHalfLength = PeakingRenderer.segmentHalfLength
        enc.setRenderPipelineState(pipe)
        enc.setFragmentTexture(overlay, index: 0)
        enc.setFragmentTexture(video, index: 1)
        enc.setFragmentTexture(ridge, index: 2)
        enc.setFragmentBytes(&p, length: MemoryLayout<PeakingGPUParams>.stride, index: 0)
        enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        enc.endEncoding()
        cb.present(drawable)
        cb.commit()
    }
}
