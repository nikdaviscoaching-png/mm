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

/// GPU focus peaking, zebras and the magnified inspection view.
/// Falls back (returns `nil` from `init`) if Metal or the shader is unavailable; callers then use `CPUOverlay`.
final class OverlayRenderer: NSObject, MTKViewDelegate, @unchecked Sendable {

    private struct Params {
        var threshold: Float = .infinity
        var supportFraction: Float = FocusPeaking.supportFraction
        var zebraThreshold: Float = 2
        var peakingOn: Float = 0
        var zebraOn: Float = 0
        var stripePhase: Float = 0
        var showVideo: Float = 0
        var pad0: Float = 0
        var peakColor = SIMD4<Float>(1, 0.05, 0.05, 0.9)
        var roiOrigin = SIMD2<Float>(0, 0)
        var roiSize = SIMD2<Float>(1, 1)
    }

    private let device: MTLDevice
    private let queue: MTLCommandQueue
    private var textureCache: CVMetalTextureCache?
    private let peakPipeline: MTLComputePipelineState
    private let composePipeline: MTLComputePipelineState
    private var presentPipeline: MTLRenderPipelineState?
    private let lock = NSLock()

    private var maskTexture: MTLTexture?
    private var overlayTexture: MTLTexture?
    private var latestVideo: MTLTexture?
    private var retainedCV: CVMetalTexture?
    private var params = Params()
    private var frameIndex: Float = 0
    private weak var view: MTKView?

    init?(useMetal: Bool) {
        guard let device = MTLCreateSystemDefaultDevice(), let queue = device.makeCommandQueue() else { return nil }
        self.device = device; self.queue = queue
        do {
            let lib = try device.makeLibrary(source: OverlayShaders.source, options: nil)
            guard let peak = lib.makeFunction(name: "peakMask"), let comp = lib.makeFunction(name: "composeOverlay") else { return nil }
            peakPipeline = try device.makeComputePipelineState(function: peak)
            composePipeline = try device.makeComputePipelineState(function: comp)
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
        guard let mask = maskTexture, let overlay = overlayTexture else { return }

        var p = Params()
        p.peakingOn = config.peaking == .off ? 0 : 1
        if p.peakingOn > 0 { p.threshold = Self.sampledThreshold(pb, sensitivity: config.peaking) }
        let c = config.peakingColor.rgb
        p.peakColor = SIMD4<Float>(c.0, c.1, c.2, 0.92)
        if let z = config.zebra.threshold { p.zebraOn = 1; p.zebraThreshold = Float(z) / 255 }
        frameIndex += 1
        p.stripePhase = Float(Int(frameIndex) % 10)        // slowly crawling stripes
        let zoom = max(config.zoom, 1)
        p.showVideo = zoom > 1 ? 1 : 0
        let size = Float(1 / zoom)
        let ox = Float(min(max(config.center.x - 0.5 / zoom, 0), 1 - 1 / zoom))
        let oy = Float(min(max(config.center.y - 0.5 / zoom, 0), 1 - 1 / zoom))
        p.roiSize = SIMD2<Float>(size, size); p.roiOrigin = SIMD2<Float>(ox, oy)

        guard let cb = queue.makeCommandBuffer() else { return }
        let tg = MTLSize(width: 16, height: 16, depth: 1)
        let groups = MTLSize(width: (w + 15) / 16, height: (h + 15) / 16, depth: 1)
        if let e = cb.makeComputeCommandEncoder() {
            e.setComputePipelineState(peakPipeline)
            e.setTexture(src, index: 0); e.setTexture(mask, index: 1)
            e.setBytes(&p, length: MemoryLayout<Params>.stride, index: 0)
            e.dispatchThreadgroups(groups, threadsPerThreadgroup: tg)
            e.setComputePipelineState(composePipeline)
            e.setTexture(src, index: 0); e.setTexture(mask, index: 1); e.setTexture(overlay, index: 2)
            e.dispatchThreadgroups(groups, threadsPerThreadgroup: tg)
            e.endEncoding()
        }
        cb.addCompletedHandler { _ in _ = cv }              // keep the CVMetalTexture alive until the GPU is done
        cb.commit()
        lock.lock(); latestVideo = src; retainedCV = cv; params = p; lock.unlock()
    }

    private func ensureTextures(width w: Int, height h: Int) {
        if let t = maskTexture, t.width == w, t.height == h { return }
        let md = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .r8Unorm, width: w, height: h, mipmapped: false)
        md.usage = [.shaderRead, .shaderWrite]; md.storageMode = .private
        let od = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba8Unorm, width: w, height: h, mipmapped: false)
        od.usage = [.shaderRead, .shaderWrite]; od.storageMode = .private
        lock.lock(); maskTexture = device.makeTexture(descriptor: md); overlayTexture = device.makeTexture(descriptor: od); lock.unlock()
    }

    // MARK: Noise-adaptive threshold from a sparse sample of the camera buffer

    static func sampledThreshold(_ pb: CVPixelBuffer, sensitivity: PeakingSensitivity) -> Float {
        CVPixelBufferLockBaseAddress(pb, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(pb) else { return sensitivity == .off ? .infinity : 40 }
        let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb), bpr = CVPixelBufferGetBytesPerRow(pb)
        let ptr = base.assumingMemoryBound(to: UInt8.self)
        @inline(__always) func luma(_ x: Int, _ y: Int) -> Float {
            let i = y * bpr + x * 4
            return Float((Int(ptr[i + 2]) * 54 + Int(ptr[i + 1]) * 183 + Int(ptr[i]) * 19) >> 8)
        }
        var responses: [Float] = []
        responses.reserveCapacity((w / 7) * (h / 7))
        var y = 3
        while y < h - 3 {
            var x = 3
            while x < w - 3 {
                let c = luma(x, y) * 2
                responses.append(abs(c - luma(x - 1, y) - luma(x + 1, y)) + abs(c - luma(x, y - 1) - luma(x, y + 1)))
                x += 7
            }
            y += 7
        }
        return FocusPeaking.threshold(fromSampledResponses: responses, sensitivity: sensitivity)
    }

    // MARK: MTKViewDelegate

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

    func draw(in view: MTKView) {
        lock.lock()
        let overlay = overlayTexture, video = latestVideo, pipe = presentPipeline
        var p = params
        lock.unlock()
        guard let overlay, let video, let pipe, let pass = view.currentRenderPassDescriptor, let drawable = view.currentDrawable,
              let cb = queue.makeCommandBuffer(), let enc = cb.makeRenderCommandEncoder(descriptor: pass) else { return }
        enc.setRenderPipelineState(pipe)
        enc.setFragmentTexture(overlay, index: 0)
        enc.setFragmentTexture(video, index: 1)
        enc.setFragmentBytes(&p, length: MemoryLayout<Params>.stride, index: 0)
        enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        enc.endEncoding()
        cb.present(drawable)
        cb.commit()
    }
}
