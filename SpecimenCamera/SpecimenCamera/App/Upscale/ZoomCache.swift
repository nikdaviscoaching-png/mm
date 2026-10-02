import Foundation
import UIKit
import CoreGraphics

/// Raw (uncompressed) copies of very large results, kept so the viewer can show real saved detail without decoding the giant
/// compressed file again. Lives in Caches (the system may purge it; the viewer then falls back to the encoded file).
enum ZoomCache {
    private struct Meta: Codable { var width: Int; var height: Int }
    private static let fm = FileManager.default

    static var directory: URL {
        let url = fm.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("ZoomRaw", isDirectory: true)
        try? fm.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /// A scratch name for a raw file that is still being written.
    static func newPendingFile() -> URL { directory.appendingPathComponent("pending-\(UUID().uuidString).rgba") }

    /// File-name based key (sanitised so it is always a legal single path component).
    static func key(for finalURL: URL) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_."))
        return String(finalURL.lastPathComponent.unicodeScalars.map { allowed.contains($0) ? Character($0) : "_" })
    }
    private static func rawURL(_ key: String) -> URL { directory.appendingPathComponent(key + ".rgba") }
    private static func metaURL(_ key: String) -> URL { directory.appendingPathComponent(key + ".json") }

    /// Takes ownership of a finished raw file for the photo now stored at `finalURL`.
    static func adopt(rawFile: URL, for finalURL: URL, width: Int, height: Int) {
        let k = key(for: finalURL)
        try? fm.removeItem(at: rawURL(k))
        do {
            try fm.moveItem(at: rawFile, to: rawURL(k))
            try JSONEncoder().encode(Meta(width: width, height: height)).write(to: metaURL(k), options: .atomic)
            trim(keeping: 3)
        } catch { try? fm.removeItem(at: rawFile) }
    }

    static func entry(for finalURL: URL) -> (url: URL, width: Int, height: Int)? {
        let k = key(for: finalURL)
        guard let d = try? Data(contentsOf: metaURL(k)), let m = try? JSONDecoder().decode(Meta.self, from: d), fm.fileExists(atPath: rawURL(k).path) else { return nil }
        return (rawURL(k), m.width, m.height)
    }

    static func remove(for finalURL: URL) { let k = key(for: finalURL); try? fm.removeItem(at: rawURL(k)); try? fm.removeItem(at: metaURL(k)) }

    static func removePending() {
        for u in (try? fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? [] where u.lastPathComponent.hasPrefix("pending-") { try? fm.removeItem(at: u) }
    }

    /// Raw files are huge: only the newest few are kept.
    static func trim(keeping n: Int) {
        let keys: [URLResourceKey] = [.contentModificationDateKey]
        let raws = ((try? fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: keys)) ?? []).filter { $0.pathExtension == "rgba" }
        let sorted = raws.sorted { (try? $0.resourceValues(forKeys: Set(keys)).contentModificationDate) ?? .distantPast > (try? $1.resourceValues(forKeys: Set(keys)).contentModificationDate) ?? .distantPast }
        for u in sorted.dropFirst(n) {
            try? fm.removeItem(at: u)
            try? fm.removeItem(at: u.deletingPathExtension().appendingPathExtension("json"))
        }
    }
}

/// Region/thumbnail rendering from a raw mapped file.
enum ZoomRaw {
    /// Draws `region` (pixel coordinates of the raw image) scaled so its long edge is at most `maxEdge` pixels.
    static func render(_ file: MappedRGBAFile, region: CGRect, maxEdge: Int) -> UIImage? {
        guard let full = file.cgImage(colorSpace: CGColorSpace(name: CGColorSpace.displayP3) ?? CGColorSpaceCreateDeviceRGB()) else { return nil }
        let r = region.integral.intersection(CGRect(x: 0, y: 0, width: file.width, height: file.height))
        guard r.width >= 1, r.height >= 1, let crop = full.cropping(to: r) else { return nil }
        let s = min(1, CGFloat(maxEdge) / max(r.width, r.height))
        let w = max(1, Int(r.width * s)), h = max(1, Int(r.height * s))
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.displayP3) ?? CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        ctx.interpolationQuality = .high
        ctx.draw(crop, in: CGRect(x: 0, y: 0, width: w, height: h))
        return ctx.makeImage().map { UIImage(cgImage: $0) }
    }

    static func thumbnail(rawURL: URL, width: Int, height: Int, maxEdge: Int = 480) -> UIImage? {
        guard let f = try? MappedRGBAFile(open: rawURL, width: width, height: height) else { return nil }
        return render(f, region: CGRect(x: 0, y: 0, width: width, height: height), maxEdge: maxEdge)
    }
}
