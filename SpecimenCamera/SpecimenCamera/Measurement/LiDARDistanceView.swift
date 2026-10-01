import SwiftUI
import ARKit
import SceneKit

/// Reads the LiDAR scene depth at the centre of the view. ARKit takes over the camera while this is on screen.
struct LiDARDistanceView: UIViewRepresentable {
    @Binding var distanceMM: Double?

    func makeUIView(context: Context) -> ARSCNView {
        let v = ARSCNView()
        v.session.delegate = context.coordinator
        let cfg = ARWorldTrackingConfiguration()
        if ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) { cfg.frameSemantics = .sceneDepth }
        v.session.run(cfg)
        return v
    }

    func updateUIView(_ uiView: ARSCNView, context: Context) {}

    static func dismantleUIView(_ uiView: ARSCNView, coordinator: Coordinator) { uiView.session.pause() }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, ARSessionDelegate {
        let parent: LiDARDistanceView
        private var last = Date.distantPast
        init(_ p: LiDARDistanceView) { parent = p }

        func session(_ session: ARSession, didUpdate frame: ARFrame) {
            guard Date().timeIntervalSince(last) > 0.2, let depth = frame.sceneDepth?.depthMap else { return }
            last = Date()
            CVPixelBufferLockBaseAddress(depth, .readOnly)
            defer { CVPixelBufferUnlockBaseAddress(depth, .readOnly) }
            guard let base = CVPixelBufferGetBaseAddress(depth) else { return }
            let w = CVPixelBufferGetWidth(depth), h = CVPixelBufferGetHeight(depth)
            let rowFloats = CVPixelBufferGetBytesPerRow(depth) / MemoryLayout<Float32>.size
            let p = base.assumingMemoryBound(to: Float32.self)
            var samples: [Float] = []
            for dy in -3...3 { for dx in -3...3 {
                let v = p[(h / 2 + dy) * rowFloats + (w / 2 + dx)]
                if v.isFinite, v > 0 { samples.append(v) }
            }}
            guard !samples.isEmpty else { return }
            samples.sort()
            let meters = Double(samples[samples.count / 2])
            DispatchQueue.main.async { self.parent.distanceMM = meters * 1000 }
        }
    }
}
