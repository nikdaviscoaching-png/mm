import Foundation
import UIKit
import ImageIO

enum ThumbnailService {
    /// Fast, memory-light thumbnail for any format ImageIO can read (HEIC, JPEG, TIFF, DNG, ProRAW).
    static func image(for url: URL, maxPixel: Int = 400) -> UIImage? {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                                     kCGImageSourceThumbnailMaxPixelSize: maxPixel, kCGImageSourceShouldCacheImmediately: true]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        return UIImage(cgImage: cg)
    }

    static func writeJPEGThumbnail(for url: URL, to dest: URL, maxPixel: Int = 480) -> Bool {
        guard let img = image(for: url, maxPixel: maxPixel), let data = img.jpegData(compressionQuality: 0.8) else { return false }
        return (try? data.write(to: dest, options: .atomic)) != nil
    }

    static func pixelSize(of url: URL) -> (Int, Int)? {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
              let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
              let w = props[kCGImagePropertyPixelWidth] as? Int, let h = props[kCGImagePropertyPixelHeight] as? Int else { return nil }
        let o = props[kCGImagePropertyOrientation] as? Int ?? 1
        return (5...8).contains(o) ? (h, w) : (w, h)
    }
}
