import Foundation

public struct WebCopyPreset: Sendable, Equatable, Codable {
    public var longEdge: Int = 2560
    public var jpegQuality: Double = 0.9
    /// Web copies are converted to sRGB for predictable rendering on listings; the Display P3 master is never altered.
    public var convertToSRGB = true
    public init() {}
    public static let eBay = WebCopyPreset()
}

public enum ExportPlanner {
    /// Output size for a web copy: scales the long edge down to the preset, never up.
    public static func webCopySize(width: Int, height: Int, preset: WebCopyPreset) -> (width: Int, height: Int) {
        let long = max(width, height)
        guard long > preset.longEdge else { return (width, height) }
        let s = Double(preset.longEdge) / Double(long)
        return (max(1, Int((Double(width) * s).rounded())), max(1, Int((Double(height) * s).rounded())))
    }

    public static func fileName(for item: LibraryItem, web: Bool) -> String {
        let df = DateFormatter(); df.dateFormat = "yyyyMMdd-HHmmss"; df.timeZone = TimeZone(identifier: "UTC")
        let kind = item.kind == .single ? "photo" : item.kind.rawValue
        let ext = web ? "jpg" : item.finalFormat.fileExtension
        return "specimen-\(kind)-\(df.string(from: item.captureDate))\(web ? "-web" : "").\(ext)"
    }
}
