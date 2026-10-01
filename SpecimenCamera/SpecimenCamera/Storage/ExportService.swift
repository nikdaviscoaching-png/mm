import Foundation
import CoreImage
import CoreImage.CIFilterBuiltins
import UIKit
import SwiftUI
import SpecimenCore

/// Export: FULL QUALITY hands out a copy of the untouched master; WEB/EBAY COPY is generated *from* the master (downscaled,
/// sRGB, JPEG). The master itself is never altered or recompressed.
enum ExportService {
    enum ExportError: LocalizedError {
        case decodeFailed, writeFailed(String)
        var errorDescription: String? {
            switch self { case .decodeFailed: return "The image could not be read."; case .writeFailed(let s): return "Export failed: \(s)" }
        }
    }

    private static let context = CIContext(options: [.cacheIntermediates: false])

    /// Byte-for-byte copy under a descriptive file name (so listings and the Files app show something meaningful).
    static func fullQualityCopy(of item: SpecimenCore.LibraryItem, master: URL) throws -> URL {
        let dest = AppPaths.exports.appendingPathComponent(ExportPlanner.fileName(for: item, web: false))
        try? FileManager.default.removeItem(at: dest)
        try FileManager.default.copyItem(at: master, to: dest)
        return dest
    }

    static func webCopy(of item: SpecimenCore.LibraryItem, master: URL, preset: WebCopyPreset = .eBay) throws -> URL {
        var image: CIImage?
        if item.finalFormat == .dng, let raw = CIRAWFilter(imageURL: master) { image = raw.outputImage }
        else { image = CIImage(contentsOf: master, options: [.applyOrientationProperty: true]) }
        guard var ci = image else { throw ExportError.decodeFailed }
        let extent = ci.extent
        let target = ExportPlanner.webCopySize(width: Int(extent.width), height: Int(extent.height), preset: preset)
        if target.width < Int(extent.width) {
            let f = CIFilter.lanczosScaleTransform()
            f.inputImage = ci; f.scale = Float(Double(target.width) / Double(extent.width)); f.aspectRatio = 1
            if let out = f.outputImage { ci = out }
        }
        guard let space = CGColorSpace(name: preset.convertToSRGB ? CGColorSpace.sRGB : CGColorSpace.displayP3) else { throw ExportError.decodeFailed }
        let dest = AppPaths.exports.appendingPathComponent(ExportPlanner.fileName(for: item, web: true))
        try? FileManager.default.removeItem(at: dest)
        do {
            let q = CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String)
            try context.writeJPEGRepresentation(of: ci, to: dest, colorSpace: space, options: [q: preset.jpegQuality])
        } catch { throw ExportError.writeFailed(error.localizedDescription) }
        return dest
    }
}

struct ShareSheet: UIViewControllerRepresentable {
    let urls: [URL]
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: urls, applicationActivities: nil) }
    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}

struct ShareItem: Identifiable { let id = UUID(); let urls: [URL] }
