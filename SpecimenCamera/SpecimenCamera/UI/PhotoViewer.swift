import SwiftUI
import UIKit
import ImageIO
import SpecimenCore

// MARK: - Thumbnails

/// Shared thumbnail cache: ImageIO thumbnails generated off the main thread; originals are never decoded for browsing.
enum ThumbnailCache {
    private static let cache: NSCache<NSString, UIImage> = { let c = NSCache<NSString, UIImage>(); c.countLimit = 600; return c }()

    static func cached(_ url: URL, maxPixel: Int) -> UIImage? { cache.object(forKey: "\(url.path)#\(maxPixel)" as NSString) }

    static func load(_ url: URL, maxPixel: Int) async -> UIImage? {
        let key = "\(url.path)#\(maxPixel)" as NSString
        if let hit = cache.object(forKey: key) { return hit }
        let img = await Task.detached(priority: .utility) { ThumbnailService.image(for: url, maxPixel: maxPixel) }.value
        if let img { cache.setObject(img, forKey: key) }
        return img
    }
}

/// A square-cropped thumbnail that loads asynchronously (160 px for folder covers, ~360 px for grids).
struct ThumbView: View {
    let url: URL?
    var maxPixel = 360
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            Color.gray.opacity(0.25)
            if let image { Image(uiImage: image).resizable().scaledToFill() }
        }
        .clipped()
        .task(id: url) {
            guard let url else { image = nil; return }
            if let hit = ThumbnailCache.cached(url, maxPixel: maxPixel) { image = hit; return }
            image = await ThumbnailCache.load(url, maxPixel: maxPixel)
        }
    }
}

// MARK: - Zoom source

/// Everything the viewer needs to show one photo: a quick reduced preview now, and real full-resolution detail for whatever part
/// is on screen once the user zooms.
final class ZoomImageSource: @unchecked Sendable {
    static let directDecodeLimit = 64_000_000        // pixels

    enum Kind { case raw(MappedRGBAFile), encoded, reducedOnly }

    let url: URL
    let pixelSize: CGSize                             // upright size of the real image
    let preview: UIImage
    let kind: Kind
    var isReduced: Bool { max(preview.size.width * preview.scale, preview.size.height * preview.scale) + 1 < max(pixelSize.width, pixelSize.height) }

    private let lock = NSLock()
    private var cgImage: CGImage?

    private init(url: URL, pixelSize: CGSize, preview: UIImage, kind: Kind) { self.url = url; self.pixelSize = pixelSize; self.preview = preview; self.kind = kind }

    /// Reads the size/orientation from metadata and makes a preview with ImageIO (never a full decode).
    static func load(_ url: URL, screenLongEdge: CGFloat) async -> ZoomImageSource? {
        await Task.detached(priority: .userInitiated) { () -> ZoomImageSource? in
            guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
                  let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
                  let w = props[kCGImagePropertyPixelWidth] as? Int, let h = props[kCGImagePropertyPixelHeight] as? Int else { return nil }
            let o = props[kCGImagePropertyOrientation] as? Int ?? 1
            let upright = (5...8).contains(o) ? CGSize(width: h, height: w) : CGSize(width: w, height: h)
            // oriented (rotated) files cannot be region-rendered cheaply, so their preview is made larger instead
            let target = o == 1 ? Int(max(screenLongEdge * 2, 2048)) : min(max(w, h), 6144)
            let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                                         kCGImageSourceThumbnailMaxPixelSize: target, kCGImageSourceShouldCacheImmediately: true]
            guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
            let preview = UIImage(cgImage: cg)
            // raw copy from the zoom cache (Handheld 2x results): real detail without decoding the compressed file again
            if let e = ZoomCache.entry(for: url), let f = try? MappedRGBAFile(open: e.url, width: e.width, height: e.height) {
                return ZoomImageSource(url: url, pixelSize: CGSize(width: e.width, height: e.height), preview: preview, kind: .raw(f))
            }
            let kind: Kind = o == 1 ? .encoded : .reducedOnly
            return ZoomImageSource(url: url, pixelSize: upright, preview: preview, kind: kind)
        }.value
    }

    /// Renders `region` (pixels of the real image) at no more than `maxEdge` pixels on its long side. nil when only the preview exists.
    func render(region: CGRect, maxEdge: Int) -> UIImage? {
        switch kind {
        case .raw(let f): return ZoomRaw.render(f, region: region, maxEdge: maxEdge)
        case .reducedOnly: return nil
        case .encoded:
            lock.lock()
            if cgImage == nil, let src = CGImageSourceCreateWithURL(url as CFURL, nil) { cgImage = CGImageSourceCreateImageAtIndex(src, 0, [kCGImageSourceShouldCache: false] as CFDictionary) }
            let full = cgImage
            lock.unlock()
            guard let full else { return nil }
            let r = region.integral.intersection(CGRect(x: 0, y: 0, width: full.width, height: full.height))
            guard r.width >= 1, r.height >= 1, let crop = full.cropping(to: r) else { return nil }
            let s = min(1, CGFloat(maxEdge) / max(r.width, r.height))
            let w = max(1, Int(r.width * s)), h = max(1, Int(r.height * s))
            guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
            ctx.interpolationQuality = .high
            ctx.draw(crop, in: CGRect(x: 0, y: 0, width: w, height: h))
            return ctx.makeImage().map { UIImage(cgImage: $0) }
        }
    }
}

// MARK: - Zoom view (UIScrollView)

final class ZoomScrollView: UIScrollView {
    var onLayout: ((CGSize) -> Void)?
    override func layoutSubviews() { super.layoutSubviews(); onLayout?(bounds.size) }
}

/// Pinch-to-zoom/pan/double-tap viewer. While zoomed it replaces the visible part with a full-resolution render of exactly that
/// region; renders are generation-stamped so a slow old one can never overwrite a newer request.
struct HighResZoomView: UIViewRepresentable {
    let source: ZoomImageSource
    var onZoomed: (Bool) -> Void
    var onTap: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> UIScrollView {
        let sv = ZoomScrollView()
        sv.onLayout = { [weak c = context.coordinator] size in c?.layoutIfNeeded(size: size) }
        sv.delegate = context.coordinator
        sv.minimumZoomScale = 1; sv.maximumZoomScale = 1
        sv.showsHorizontalScrollIndicator = false; sv.showsVerticalScrollIndicator = false
        sv.backgroundColor = .clear; sv.bouncesZoom = true
        sv.contentInsetAdjustmentBehavior = .never
        let iv = UIImageView(image: source.preview)
        iv.isUserInteractionEnabled = true
        sv.addSubview(iv)
        let hi = UIImageView(); hi.isHidden = true; hi.contentMode = .scaleToFill
        iv.addSubview(hi)
        context.coordinator.scroll = sv; context.coordinator.imageView = iv; context.coordinator.hiRes = hi
        let dt = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.doubleTap(_:))); dt.numberOfTapsRequired = 2
        let st = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.singleTap)); st.require(toFail: dt)
        sv.addGestureRecognizer(dt); sv.addGestureRecognizer(st)
        return sv
    }

    func updateUIView(_ sv: UIScrollView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.layoutIfNeeded(size: sv.bounds.size)
    }

    final class Coordinator: NSObject, UIScrollViewDelegate {
        var parent: HighResZoomView
        weak var scroll: UIScrollView?
        weak var imageView: UIImageView?
        weak var hiRes: UIImageView?
        private var laidOut = CGSize.zero
        private var fitted = CGSize.zero
        private var generation = 0
        private var pending: DispatchWorkItem?
        private var zoomed = false

        init(_ p: HighResZoomView) { parent = p }

        func layoutIfNeeded(size: CGSize) {
            guard let sv = scroll, let iv = imageView, size.width > 1, size.height > 1, size != laidOut else { return }
            laidOut = size
            let img = parent.source.pixelSize
            let scale = min(size.width / img.width, size.height / img.height)
            fitted = CGSize(width: img.width * scale, height: img.height * scale)
            sv.zoomScale = 1
            iv.frame = CGRect(origin: .zero, size: fitted)
            sv.contentSize = fitted
            // up to 1:1 pixels (at least 4× the fitted size, so even moderate photos can be examined closely)
            let screenScale = sv.window?.screen.scale ?? UIScreen.main.scale
            let oneToOne = img.width / fitted.width / screenScale
            sv.maximumZoomScale = max(4, min(40, oneToOne * 2))
            center()
        }

        func center() {
            guard let sv = scroll, let iv = imageView else { return }
            let b = sv.bounds.size, c = iv.frame.size
            iv.frame.origin = CGPoint(x: max(0, (b.width - c.width) / 2), y: max(0, (b.height - c.height) / 2))
        }

        func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }

        func scrollViewDidZoom(_ scrollView: UIScrollView) {
            center()
            let z = scrollView.zoomScale > 1.02
            if z != zoomed { zoomed = z; parent.onZoomed(z) }
            if !z { generation += 1; hiRes?.isHidden = true; hiRes?.image = nil }
        }

        func scrollViewDidEndZooming(_ scrollView: UIScrollView, with view: UIView?, atScale scale: CGFloat) { scheduleRender() }
        func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) { if !decelerate { scheduleRender() } }
        func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { scheduleRender() }

        @objc func singleTap() { parent.onTap() }

        @objc func doubleTap(_ g: UITapGestureRecognizer) {
            guard let sv = scroll, let iv = imageView else { return }
            if sv.zoomScale > 1.02 { sv.setZoomScale(1, animated: true) }
            else {
                let p = g.location(in: iv), z = min(sv.maximumZoomScale, 4)
                let w = sv.bounds.width / z, h = sv.bounds.height / z
                sv.zoom(to: CGRect(x: p.x - w / 2, y: p.y - h / 2, width: w, height: h), animated: true)
            }
        }

        /// Visible part of the image (in the fitted-image coordinate space), mapped to pixels of the real image.
        private func scheduleRender() {
            pending?.cancel()
            guard let sv = scroll, sv.zoomScale > 1.2, parent.source.kind.isRenderable else { return }
            let work = DispatchWorkItem { [weak self] in self?.renderVisible() }
            pending = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.12, execute: work)
        }

        private func renderVisible() {
            guard let sv = scroll, let iv = imageView, fitted.width > 0 else { return }
            let z = sv.zoomScale
            // visible rect in the image view's own (unzoomed) coordinates
            let visible = CGRect(x: max(0, (sv.contentOffset.x - iv.frame.origin.x) / z), y: max(0, (sv.contentOffset.y - iv.frame.origin.y) / z),
                                 width: sv.bounds.width / z, height: sv.bounds.height / z)
                .intersection(CGRect(origin: .zero, size: fitted))
            guard visible.width > 1, visible.height > 1 else { return }
            let pxPerPoint = parent.source.pixelSize.width / fitted.width
            let region = CGRect(x: visible.minX * pxPerPoint, y: visible.minY * pxPerPoint, width: visible.width * pxPerPoint, height: visible.height * pxPerPoint)
            let screenScale = sv.window?.screen.scale ?? UIScreen.main.scale
            let wanted = Int(max(sv.bounds.width, sv.bounds.height) * screenScale * 1.5)
            generation += 1
            let token = generation
            let source = parent.source
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                let img = source.render(region: region, maxEdge: min(wanted, 4096))
                DispatchQueue.main.async {
                    // a newer pan/zoom has been requested since: drop this result
                    guard let self, token == self.generation, let img, let hi = self.hiRes else { return }
                    hi.frame = visible
                    hi.image = img
                    hi.isHidden = false
                }
            }
        }
    }
}

private extension ZoomImageSource.Kind {
    var isRenderable: Bool { if case .reducedOnly = self { return false }; return true }
}

// MARK: - Full-screen viewer

struct ViewerPhoto: Identifiable, Equatable {
    let id: UUID                  // library item id
    let url: URL
}

/// Black full-screen viewer: swipe between photos, pinch/pan/double-tap, share, info, delete.
struct PhotoViewer: View {
    let photos: [ViewerPhoto]
    @State var index: Int
    @EnvironmentObject var library: LibraryService
    @Environment(\.dismiss) private var dismiss
    @State private var zoomed = false
    @State private var chrome = true
    @State private var showInfo = false
    @State private var confirmDelete = false
    @State private var position: Int?

    init(photos: [ViewerPhoto], startIndex: Int) { self.photos = photos; _index = State(initialValue: startIndex); _position = State(initialValue: startIndex) }

    private var current: ViewerPhoto? { photos.indices.contains(index) ? photos[index] : nil }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            ScrollView(.horizontal) {
                LazyHStack(spacing: 0) {
                    ForEach(Array(photos.enumerated()), id: \.element.id) { i, p in
                        ViewerPage(photo: p, near: abs(i - index) <= 1, onZoomed: { z in if i == index { zoomed = z } }, onTap: { withAnimation { chrome.toggle() } })
                            .containerRelativeFrame(.horizontal).id(i)
                    }
                }.scrollTargetLayout()
            }
            .scrollTargetBehavior(.paging).scrollIndicators(.hidden)
            .scrollPosition(id: $position)
            .scrollDisabled(zoomed)                       // a zoomed photo pans instead of paging
            .ignoresSafeArea()
            .onChange(of: position) { _, new in if let new, new != index { index = new; zoomed = false } }

            if chrome {
                VStack {
                    HStack(spacing: 18) {
                        Button { dismiss() } label: { Image(systemName: "xmark") }
                        Spacer()
                        if let c = current { ShareLink(item: c.url) { Image(systemName: "square.and.arrow.up") } }
                        Button { showInfo = true } label: { Image(systemName: "info.circle") }
                        Button { confirmDelete = true } label: { Image(systemName: "trash") }
                    }
                    .font(.system(size: 20, weight: .semibold)).foregroundColor(.white).padding(.horizontal, 20).padding(.vertical, 12)
                    .background(LinearGradient(colors: [.black.opacity(0.6), .clear], startPoint: .top, endPoint: .bottom))
                    Spacer()
                    Text("\(index + 1) of \(photos.count)").font(.system(size: 12, weight: .semibold)).foregroundColor(.white.opacity(0.8)).padding(.bottom, 10)
                }
            }
        }
        .statusBarHidden(!chrome)
        .sheet(isPresented: $showInfo) { if let c = current { PhotoInfoSheet(photo: c) } }
        .confirmationDialog("Delete this photo from the app?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { deleteCurrent() }
        }
    }

    private func deleteCurrent() {
        guard let c = current, let item = library.items.first(where: { $0.id == c.id }) else { return }
        ZoomCache.remove(for: c.url)
        library.delete(item)
        dismiss()
    }
}

private struct ViewerPage: View {
    let photo: ViewerPhoto
    let near: Bool
    var onZoomed: (Bool) -> Void
    var onTap: () -> Void
    @State private var source: ZoomImageSource?

    var body: some View {
        GeometryReader { g in
            ZStack {
                if let source { HighResZoomView(source: source, onZoomed: onZoomed, onTap: onTap) }
                else { ProgressView().tint(.white) }
            }
            .frame(width: g.size.width, height: g.size.height)
            .task(id: near) {
                if near, source == nil { source = await ZoomImageSource.load(photo.url, screenLongEdge: max(g.size.width, g.size.height) * (UIScreen.main.scale)) }
            }
        }
    }
}

/// Size and file facts read with ImageIO — no pixel decoding.
struct PhotoInfoSheet: View {
    let photo: ViewerPhoto
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject var library: LibraryService
    @State private var showDetails = false

    var body: some View {
        NavigationStack {
            List {
                if let size = ThumbnailService.pixelSize(of: photo.url) {
                    let mp = Double(size.0 * size.1) / 1e6
                    row("Size", "\(size.0) × \(size.1)")
                    row("Megapixels", mp >= 10 ? String(format: "%.0f MP", mp) : String(format: "%.1f MP", mp))
                }
                if let bytes = (try? photo.url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize { row("File size", ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)) }
                if let item = library.items.first(where: { $0.id == photo.id }) {
                    row("Captured", item.captureDate.formatted(date: .abbreviated, time: .shortened))
                    if !item.notes.isEmpty { row("Notes", item.notes) }
                    Button("Details, notes, export & measure…") { showDetails = true }
                }
            }
            .navigationTitle("Photo info").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .sheet(isPresented: $showDetails) { NavigationStack { ItemDetailView(itemID: photo.id) }.environmentObject(library) }
        }
        .presentationDetents([.medium, .large])
    }

    private func row(_ k: String, _ v: String) -> some View { HStack { Text(k).foregroundColor(.secondary); Spacer(); Text(v) } }
}
