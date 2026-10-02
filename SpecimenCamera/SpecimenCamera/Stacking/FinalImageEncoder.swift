import Foundation
import CoreImage
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import SpecimenCore

/// Encodes the final `.scw` into the master file (JPEG / HEIF / 16-bit TIFF) in Display P3 at full resolution, adds stack-level
/// metadata *without recompressing*, and can verify the written file by decoding it.
struct FinalImageEncoder: FinalEncoder {

    private static let context = CIContext(options: [.cacheIntermediates: false])

    func encode(working: URL, to destination: URL, format: FinalFormat, metadata: CompositeMetadata) throws {
        let frame = try ScwFrame(url: working)
        guard let p3 = CGColorSpace(name: CGColorSpace.displayP3) else { throw SpecimenError.unsupported("Display P3 colour space unavailable") }

        // 16-bit RGBA bitmap on disk, memory-mapped (never held in RAM), so 48 MP outputs are safe.
        let rgbaURL = working.deletingLastPathComponent().appendingPathComponent("final_rgba16.raw")
        defer { try? FileManager.default.removeItem(at: rgbaURL) }
        try Self.writeRGBA16(frame: frame, to: rgbaURL)
        let data = try Data(contentsOf: rgbaURL, options: .alwaysMapped)
        let ci = CIImage(bitmapData: data, bytesPerRow: frame.width * 8, size: CGSize(width: frame.width, height: frame.height), format: .RGBA16, colorSpace: p3)

        try? FileManager.default.removeItem(at: destination)
        let qualityKey = CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String)
        switch format {
        case .jpeg:
            try Self.context.writeJPEGRepresentation(of: ci, to: destination, colorSpace: p3, options: [qualityKey: 0.98])
        case .heif:
            do { try Self.context.writeHEIFRepresentation(of: ci, to: destination, format: .RGB10, colorSpace: p3, options: [qualityKey: 0.97]) }
            catch {
                Log.processing.notice("10-bit HEIF failed (\(error.localizedDescription, privacy: .public)); writing 8-bit")
                try Self.context.writeHEIFRepresentation(of: ci, to: destination, format: .RGBA8, colorSpace: p3, options: [qualityKey: 0.97])
            }
        case .tiff:
            try Self.context.writeTIFFRepresentation(of: ci, to: destination, format: .RGBA16, colorSpace: p3, options: [:])
        case .dng:
            throw SpecimenError.unsupported("stacks cannot be written as DNG")
        }
        Self.addMetadata(metadata, to: destination)
    }

    private static func writeRGBA16(frame: ScwFrame, to url: URL) throws {
        FileManager.default.createFile(atPath: url.path, contents: nil)
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        let strip = 256
        var y = 0
        while y < frame.height {
            let rows = min(strip, frame.height - y)
            try autoreleasepoolThrowing {
                let img = try frame.read(region: PixelRect(x: 0, y: y, width: frame.width, height: rows))
                var out = [UInt16](repeating: 0, count: frame.width * rows * 4)
                for i in 0..<(frame.width * rows) {
                    out[i * 4] = UInt16(min(max(img.r.pixels[i], 0), 1) * 65535 + 0.5)
                    out[i * 4 + 1] = UInt16(min(max(img.g.pixels[i], 0), 1) * 65535 + 0.5)
                    out[i * 4 + 2] = UInt16(min(max(img.b.pixels[i], 0), 1) * 65535 + 0.5)
                    out[i * 4 + 3] = 65535
                }
                // CGContext/CoreImage expect little-endian 16-bit components on iOS; arm64 is little-endian so memory order is correct.
                try handle.write(contentsOf: out.withUnsafeBytes { Data($0) })
            }
            y += rows
        }
    }

    /// Adds app/stack metadata with `CGImageDestinationCopyImageSource`, which rewrites metadata without recompressing the image.
    /// Best-effort: on any failure the (valid) file is left exactly as it was.
    private static func addMetadata(_ m: CompositeMetadata, to url: URL) {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil), let type = CGImageSourceGetType(src) else { return }
        let tmp = url.deletingLastPathComponent().appendingPathComponent("meta_\(UUID().uuidString.prefix(6))_\(url.lastPathComponent)")
        guard let dst = CGImageDestinationCreateWithURL(tmp as CFURL, type, 1, nil) else { return }
        let md = CGImageMetadataCreateMutable()
        func set(_ dict: CFString, _ key: CFString, _ value: CFTypeRef) { _ = CGImageMetadataSetValueMatchingImageProperty(md, dict, key, value) }
        set(kCGImagePropertyTIFFDictionary, kCGImagePropertyTIFFSoftware, m.appName as CFString)
        var description = m.summary
        if let s = m.scale { description += "; scale \(String(format: "%.3f", s.pixelsPerMillimeter)) px/mm (\(s.accuracyNote))" }
        if !m.notes.isEmpty { description += "; \(m.notes)" }
        set(kCGImagePropertyTIFFDictionary, kCGImagePropertyTIFFImageDescription, description as CFString)
        set(kCGImagePropertyExifDictionary, kCGImagePropertyExifUserComment, description as CFString)
        let df = DateFormatter(); df.locale = Locale(identifier: "en_US_POSIX"); df.dateFormat = "yyyy:MM:dd HH:mm:ss"
        set(kCGImagePropertyExifDictionary, kCGImagePropertyExifDateTimeOriginal, df.string(from: m.originalCaptureDate) as CFString)
        set(kCGImagePropertyExifDictionary, kCGImagePropertyExifDateTimeDigitized, df.string(from: m.processingDate) as CFString)
        if let t = m.shutterSeconds { set(kCGImagePropertyExifDictionary, kCGImagePropertyExifExposureTime, NSNumber(value: t)) }
        if let iso = m.iso { set(kCGImagePropertyExifDictionary, kCGImagePropertyExifISOSpeedRatings, [NSNumber(value: Int(iso))] as CFArray) }
        if let f = m.equivalentFocalLength { set(kCGImagePropertyExifDictionary, kCGImagePropertyExifFocalLenIn35mmFilm, NSNumber(value: Int(f.rounded()))) }
        let options: [CFString: Any] = [kCGImageDestinationMetadata: md, kCGImageDestinationMergeMetadata: true]
        var err: Unmanaged<CFError>?
        if CGImageDestinationCopyImageSource(dst, src, options as CFDictionary, &err) {
            _ = try? FileManager.default.replaceItemAt(url, withItemAt: tmp)
            try? FileManager.default.removeItem(at: tmp)
        } else {
            Log.processing.notice("metadata not written: \(err?.takeRetainedValue().localizedDescription ?? "unknown", privacy: .public)")
            try? FileManager.default.removeItem(at: tmp)
        }
    }

    /// The master must exist, decode, and have exactly the expected pixel dimensions.
    func verify(final url: URL, expectedWidth: Int, expectedHeight: Int) -> Bool {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil), CGImageSourceGetStatus(src) == .statusComplete, CGImageSourceGetCount(src) >= 1,
              let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
              let w = props[kCGImagePropertyPixelWidth] as? Int, let h = props[kCGImagePropertyPixelHeight] as? Int else { return false }
        guard w == expectedWidth, h == expectedHeight else { return false }
        let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 96]
        return CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) != nil      // really decodes pixel data
    }
}
