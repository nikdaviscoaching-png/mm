import SwiftUI
import UIKit

/// Pinch-to-zoom, pan, double-tap-to-zoom image viewer (true UIScrollView behaviour) for inspecting results.
struct ZoomableImageView: UIViewRepresentable {
    let image: UIImage?

    func makeUIView(context: Context) -> UIScrollView {
        let sv = UIScrollView()
        sv.delegate = context.coordinator
        sv.minimumZoomScale = 1; sv.maximumZoomScale = 12
        sv.showsHorizontalScrollIndicator = false; sv.showsVerticalScrollIndicator = false
        sv.backgroundColor = .black
        let iv = UIImageView(); iv.contentMode = .scaleAspectFit
        sv.addSubview(iv)
        context.coordinator.imageView = iv
        let dt = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.doubleTap(_:)))
        dt.numberOfTapsRequired = 2
        sv.addGestureRecognizer(dt)
        return sv
    }

    func updateUIView(_ sv: UIScrollView, context: Context) {
        guard let iv = context.coordinator.imageView else { return }
        if iv.image !== image { iv.image = image; sv.zoomScale = 1 }
        iv.frame = sv.bounds
        sv.contentSize = sv.bounds.size
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, UIScrollViewDelegate {
        var imageView: UIImageView?
        func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }
        @objc func doubleTap(_ g: UITapGestureRecognizer) {
            guard let sv = g.view as? UIScrollView else { return }
            sv.setZoomScale(sv.zoomScale > 1.01 ? 1 : 3, animated: true)
        }
    }
}
