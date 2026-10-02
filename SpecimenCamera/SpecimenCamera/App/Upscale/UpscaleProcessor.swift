import Foundation
import UIKit
import ImageIO
import UniformTypeIdentifiers
import CoreGraphics
import Darwin
import os
import SpecimenCore

struct UpscaleResult: Sendable {
    let photoURL: URL           // encoded 2× photo (HEIC, or JPEG if HEIC could not be written), in a scratch location
    let rawURL: URL             // raw RGBA copy for the zoom cache
    let width: Int
    let height: Int
    let usedFrames: Int
    let rejectedFrames: Int
}

enum UpscaleError: LocalizedError {
    case decodeFailed(String), outputFileFailed, encodeFailed, tooLittleMemory, cancelled, sizeMismatch, notEnoughFrames
    var errorDescription: String? {
        switch self {
        case .decodeFailed(let n): return "Couldn't read \(n) from the burst."
        case .outputFileFailed: return "Couldn't create space for the 2x photo. Free up storage and try again."
        case .encodeFailed: return "Couldn't save the 2x photo."
        case .tooLittleMemory: return "Not enough free memory for a 2x photo right now. Close other apps and try again."
        case .cancelled: return "Cancelled."
        case .sizeMismatch: return "Burst photos came out different sizes. Try again without zooming."
        case .notEnoughFrames: return "The burst didn't capture enough photos. Try again."
        }
    }
}

/// Handheld 2× pipeline: decode the burst at full resolution → multi-frame super-resolution (tile by tile into a memory-mapped raw
/// file) → encode. Peak memory is the decoded burst plus a few tiles; the 4× larger result is never held in resident memory.
enum UpscaleProcessor {
    static let outputComment = "Specimen Camera 2x multi-frame upscale"

    static func run(frameURLs: [URL], settings: UpscaleSettings, progress: @escaping @Sendable (Double) -> Void) async throws -> UpscaleResult {
        try await Task.detached(priority: .userInitiated) {
            try process(frameURLs: frameURLs, settings: settings, progress: progress)
        }.value
    }

    private static func process(frameURLs: [URL], settings: UpscaleSettings, progress: @escaping @Sendable (Double) -> Void) throws -> UpscaleResult {
        guard frameURLs.count >= 2 else { throw UpscaleError.notEnoughFrames }
        guard let firstSize = ThumbnailService.pixelSize(of: frameURLs[0]) else { throw UpscaleError.decodeFailed(frameURLs[0].lastPathComponent) }
        let (w, h) = firstSize
        // memory/storage guards: never crash because a huge image cannot be processed
        let needRAM = UInt64(frameURLs.count) * UInt64(w * h * 4) + 500_000_000
        let avail = UInt64(os_proc_available_memory())
        if avail > 0 && avail < needRAM { throw UpscaleError.tooLittleMemory }
        let rawBytes = Int64(w * 2) * Int64(h * 2) * 4
        let free = (try? URL(fileURLWithPath: NSTemporaryDirectory()).resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]).volumeAvailableCapacityForImportantUsage) ?? Int64.max
        if free < rawBytes + 400_000_000 { throw UpscaleError.outputFileFailed }

        // 1. decode (upright pixels), one frame at a time into manually allocated RGBA storage
        var frames: [RGBA8Image] = []
        var colorSpace: CGColorSpace = CGColorSpace(name: CGColorSpace.displayP3) ?? CGColorSpaceCreateDeviceRGB()
        for (i, u) in frameURLs.enumerated() {
            if Task.isCancelled { throw UpscaleError.cancelled }
            guard let (img, cs) = decode(u) else { throw UpscaleError.decodeFailed("photo \(i + 1)") }
            if i == 0 { colorSpace = cs }
            if let f = frames.first, f.width != img.width || f.height != img.height { throw UpscaleError.sizeMismatch }
            frames.append(img)
            progress(0.02 * Double(i + 1) / Double(frameURLs.count))
        }
        let sourceProps = properties(of: frameURLs[0])

        // 2. super-resolution into the mapped output
        let rawURL = ZoomCache.newPendingFile()
        let outW = frames[0].width * 2, outH = frames[0].height * 2
        let output: MappedRGBAFile
        do { output = try MappedRGBAFile(create: rawURL, width: outW, height: outH) } catch { throw UpscaleError.outputFileFailed }
        var failed = true
        defer { if failed { try? FileManager.default.removeItem(at: rawURL) } }
        let report: SRReport
        do {
            report = try SuperResolution.upscale(frames: frames, settings: settings, aiProvider: nil,
                                                 isCancelled: { Task.isCancelled }, progress: { progress(0.02 + 0.93 * $0) },
                                                 writeTile: { rect, bytes in output.write(rect: rect, bytes: bytes) })
        } catch SRError.cancelled { throw UpscaleError.cancelled } catch SRError.sizeMismatch { throw UpscaleError.sizeMismatch }
        catch { throw UpscaleError.encodeFailed }
        frames.removeAll()                      // release the decoded burst before the big encode
        output.flush()

        // 3. encode without copying the mapped data
        guard let cg = output.cgImage(colorSpace: colorSpace) else { throw UpscaleError.encodeFailed }
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("upscale-\(UUID().uuidString)")
        var photoURL = base.appendingPathExtension("heic")
        if !encode(cg, to: photoURL, type: UTType.heic.identifier, quality: 0.9, props: sourceProps) {
            try? FileManager.default.removeItem(at: photoURL)
            photoURL = base.appendingPathExtension("jpg")
            if !encode(cg, to: photoURL, type: UTType.jpeg.identifier, quality: 0.92, props: sourceProps) {
                try? FileManager.default.removeItem(at: photoURL)
                throw UpscaleError.encodeFailed
            }
        }
        failed = false
        progress(1)
        return UpscaleResult(photoURL: photoURL, rawURL: rawURL, width: outW, height: outH, usedFrames: report.usedFrames.count, rejectedFrames: report.rejectedFrames.count)
    }

    // MARK: Decode

    private static func properties(of url: URL) -> [CFString: Any] {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil), let p = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any] else { return [:] }
        return p
    }

    /// Decodes at full size with the EXIF orientation applied. Returns the pixels and the colour space they are in.
    private static func decode(_ url: URL) -> (RGBA8Image, CGColorSpace)? {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
              let cg = CGImageSourceCreateImageAtIndex(src, 0, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any]
        let orientation = (props?[kCGImagePropertyOrientation] as? Int) ?? 1
        let sw = cg.width, sh = cg.height
        let swap = (5...8).contains(orientation)
        let w = swap ? sh : sw, h = swap ? sw : sh
        let space: CGColorSpace = {
            if let cs = cg.colorSpace, cs.model == .rgb { return cs }
            return CGColorSpace(name: CGColorSpace.displayP3) ?? CGColorSpaceCreateDeviceRGB()
        }()
        let img = RGBA8Image(width: w, height: h)
        guard let ctx = CGContext(data: img.bytes, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: space,
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        ctx.interpolationQuality = .none
        // UIKit applies the EXIF orientation when drawing; the flip makes UIKit's top-left origin match the bitmap rows.
        let ui: UIImage.Orientation = [1: .up, 2: .upMirrored, 3: .down, 4: .downMirrored, 5: .leftMirrored, 6: .right, 7: .rightMirrored, 8: .left][orientation] ?? .up
        ctx.translateBy(x: 0, y: CGFloat(h)); ctx.scaleBy(x: 1, y: -1)
        UIGraphicsPushContext(ctx)
        UIImage(cgImage: cg, scale: 1, orientation: ui).draw(in: CGRect(x: 0, y: 0, width: w, height: h))
        UIGraphicsPopContext()
        return (img, space)
    }

    // MARK: Encode

    private static func encode(_ image: CGImage, to url: URL, type: String, quality: Double, props: [CFString: Any]) -> Bool {
        guard let dest = CGImageDestinationCreateWithURL(url as CFURL, type as CFString, 1, nil) else { return false }
        var out: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: quality, kCGImagePropertyOrientation: 1]
        var exif = (props[kCGImagePropertyExifDictionary] as? [CFString: Any]) ?? [:]
        exif[kCGImagePropertyExifUserComment] = outputComment
        exif[kCGImagePropertyExifPixelXDimension] = image.width; exif[kCGImagePropertyExifPixelYDimension] = image.height
        out[kCGImagePropertyExifDictionary] = exif
        if var tiff = props[kCGImagePropertyTIFFDictionary] as? [CFString: Any] { tiff[kCGImagePropertyTIFFOrientation] = 1; out[kCGImagePropertyTIFFDictionary] = tiff }
        if let gps = props[kCGImagePropertyGPSDictionary] { out[kCGImagePropertyGPSDictionary] = gps }
        CGImageDestinationAddImage(dest, image, out as CFDictionary)
        return CGImageDestinationFinalize(dest)
    }
}
