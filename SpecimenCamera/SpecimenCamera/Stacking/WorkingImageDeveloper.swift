import Foundation
import CoreImage
import CoreGraphics
import ImageIO
import SpecimenCore

/// Develops captured/imported files (HEIF, JPEG, TIFF, DNG, Apple ProRAW) into the 16-bit Display-P3 `.scw` working image
/// that the stacking engines read tile by tile. Rendering is done in 128-row strips, so a 48 MP frame never exists in memory
/// at full size, and every frame of a stack is developed with identical settings.
struct WorkingImageDeveloper: FrameDeveloper {

    private static let context = CIContext(options: [.cacheIntermediates: false])

    func develop(source: URL, kind: FrameFileKind, to destination: URL) throws -> (width: Int, height: Int) {
        guard let image = Self.load(source, kind: kind) else {
            throw SpecimenError.invalidImage("\(source.lastPathComponent) could not be decoded")
        }
        let extent = image.extent.integral
        let w = Int(extent.width), h = Int(extent.height)
        guard w > 0, h > 0, w < 30_000, h < 30_000 else { throw SpecimenError.invalidImage("unexpected image size \(w)×\(h)") }
        guard let p3 = CGColorSpace(name: CGColorSpace.displayP3) else { throw SpecimenError.unsupported("Display P3 colour space unavailable") }
        let writer = try ScwWriter(url: destination, width: w, height: h, colorSpace: .displayP3)
        let strip = 256
        var y = 0
        while y < h {
            let rows = min(strip, h - y)
            try autoreleasepoolThrowing {
                // Core Image's origin is bottom-left; strip `y` counts from the top of the image.
                let rect = CGRect(x: extent.minX, y: extent.maxY - CGFloat(y + rows), width: CGFloat(w), height: CGFloat(rows))
                guard let cg = Self.context.createCGImage(image, from: rect, format: .RGBA16, colorSpace: p3) else {
                    throw SpecimenError.ioFailure("rendering strip at row \(y) failed")
                }
                var pixels = [UInt16](repeating: 0, count: w * rows * 4)
                let ok: Bool = pixels.withUnsafeMutableBytes { raw in
                    guard let ctx = CGContext(data: raw.baseAddress, width: w, height: rows, bitsPerComponent: 16, bytesPerRow: w * 8, space: p3,
                                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder16Little.rawValue) else { return false }
                    ctx.interpolationQuality = .none
                    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: rows))
                    return true
                }
                guard ok else { throw SpecimenError.ioFailure("16-bit bitmap context unavailable") }
                var rgb = RGBImage(width: w, height: rows)
                let k: Float = 1.0 / 65535.0
                for i in 0..<(w * rows) {
                    rgb.r.pixels[i] = Float(pixels[i * 4]) * k
                    rgb.g.pixels[i] = Float(pixels[i * 4 + 1]) * k
                    rgb.b.pixels[i] = Float(pixels[i * 4 + 2]) * k
                }
                try writer.write(region: PixelRect(x: 0, y: y, width: w, height: rows), image: rgb)
            }
            y += rows
        }
        try writer.finish()
        Log.processing.info("developed \(source.lastPathComponent, privacy: .public) → \(w)×\(h)")
        return (w, h)
    }

    private static func load(_ url: URL, kind: FrameFileKind) -> CIImage? {
        if kind == .dng, let raw = CIRAWFilter(imageURL: url) {
            // Same upright orientation as the processed (HEIF/JPEG) path, stated explicitly rather than left to a default.
            raw.orientation = fileOrientation(url)
            // Identical, content-independent development for every frame: no local tone mapping (it adapts to image content and
            // would differ between differently-focused frames, and gives an HDR look), modest fixed sharpening.
            if raw.isLocalToneMapSupported { raw.localToneMapAmount = 0 }
            if raw.isSharpnessSupported { raw.sharpnessAmount = 0.2 }
            if let out = raw.outputImage { return out }
        }
        return CIImage(contentsOf: url, options: [.applyOrientationProperty: true])
    }
}

/// The EXIF orientation recorded in the file (1 = upright if it has none).
private func fileOrientation(_ url: URL) -> CGImagePropertyOrientation {
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
          let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
          let raw = props[kCGImagePropertyOrientation] as? UInt32,
          let o = CGImagePropertyOrientation(rawValue: raw) else { return .up }
    return o
}

/// `autoreleasepool` for throwing bodies.
func autoreleasepoolThrowing(_ body: () throws -> Void) throws {
    var error: Error?
    autoreleasepool { do { try body() } catch let e { error = e } }
    if let error { throw error }
}
