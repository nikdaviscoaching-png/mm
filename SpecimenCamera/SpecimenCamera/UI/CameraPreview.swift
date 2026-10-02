import SwiftUI
import AVFoundation
import UIKit

/// Live preview (AVCaptureVideoPreviewLayer — lowest latency, most reliable) with the gestures the camera screen needs.
/// Tap = autofocus target · double-tap = back to 1× · pinch = magnified inspection · one-finger drag (when magnified) = pan.
struct CameraPreview: UIViewRepresentable {
    let engine: CameraEngine
    var magnified: Bool
    var onTapDevicePoint: (CGPoint, CGPoint) -> Void          // (device point, tap location in view)
    var onTapNormalized: (CGPoint) -> Void                    // tap location normalised to the view (for the magnifier centre)
    var onDoubleTap: () -> Void
    var onPinch: (CGFloat) -> Void                            // incremental scale factor
    var onPan: (CGSize) -> Void                               // normalised translation delta

    func makeUIView(context: Context) -> PreviewView {
        let v = PreviewView()
        v.previewLayer.session = engine.session
        v.previewLayer.videoGravity = .resizeAspect
        engine.attachPreviewLayer(v.previewLayer)
        v.install(coordinator: context.coordinator)
        return v
    }

    func updateUIView(_ v: PreviewView, context: Context) {
        context.coordinator.parent = self
        v.previewLayer.isHidden = magnified          // the Metal view shows the magnified video instead
    }

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    final class Coordinator: NSObject {
        var parent: CameraPreview
        init(parent: CameraPreview) { self.parent = parent }

        @objc func tap(_ g: UITapGestureRecognizer) {
            guard let v = g.view as? PreviewView else { return }
            let p = g.location(in: v)
            parent.onTapNormalized(CGPoint(x: p.x / max(v.bounds.width, 1), y: p.y / max(v.bounds.height, 1)))
            if !parent.magnified {
                let dev = v.previewLayer.captureDevicePointConverted(fromLayerPoint: p)
                parent.onTapDevicePoint(dev, p)
            }
        }
        @objc func doubleTap(_ g: UITapGestureRecognizer) { parent.onDoubleTap() }
        @objc func pinch(_ g: UIPinchGestureRecognizer) {
            if g.state == .changed { parent.onPinch(g.scale); g.scale = 1 }
        }
        @objc func pan(_ g: UIPanGestureRecognizer) {
            guard let v = g.view else { return }
            let t = g.translation(in: v)
            if g.state == .changed {
                parent.onPan(CGSize(width: t.x / max(v.bounds.width, 1), height: t.y / max(v.bounds.height, 1)))
                g.setTranslation(.zero, in: v)
            }
        }
    }

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }

        func install(coordinator c: Coordinator) {
            backgroundColor = .black
            let single = UITapGestureRecognizer(target: c, action: #selector(Coordinator.tap(_:)))
            let double = UITapGestureRecognizer(target: c, action: #selector(Coordinator.doubleTap(_:)))
            double.numberOfTapsRequired = 2
            single.require(toFail: double)
            let pinch = UIPinchGestureRecognizer(target: c, action: #selector(Coordinator.pinch(_:)))
            let pan = UIPanGestureRecognizer(target: c, action: #selector(Coordinator.pan(_:)))
            pan.maximumNumberOfTouches = 1
            [single, double, pinch, pan].forEach { addGestureRecognizer($0) }
        }
    }
}
