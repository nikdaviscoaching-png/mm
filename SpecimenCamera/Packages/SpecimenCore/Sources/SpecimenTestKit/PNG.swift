import Foundation
import SpecimenCore

/// Minimal PNG writer (8-bit RGB, stored deflate blocks) so headless runs can emit images for visual
/// inspection without any imaging framework.
public enum PNG {
    private static let crcTable: [UInt32] = (0..<256).map { n -> UInt32 in
        var c = UInt32(n)
        for _ in 0..<8 { c = (c & 1) != 0 ? 0xEDB88320 ^ (c >> 1) : c >> 1 }
        return c
    }

    private static func crc32(_ bytes: [UInt8]) -> UInt32 {
        var c: UInt32 = 0xFFFFFFFF
        for b in bytes { c = crcTable[Int((c ^ UInt32(b)) & 0xFF)] ^ (c >> 8) }
        return c ^ 0xFFFFFFFF
    }

    private static func be32(_ v: UInt32) -> [UInt8] { [UInt8(v >> 24), UInt8((v >> 16) & 255), UInt8((v >> 8) & 255), UInt8(v & 255)] }

    private static func chunk(_ type: String, _ data: [UInt8]) -> [UInt8] {
        let t = Array(type.utf8)
        return be32(UInt32(data.count)) + t + data + be32(crc32(t + data))
    }

    /// `encoded` images are written as-is (0…1 → 0…255); pass linear images through `ColorMath.toEncoded` first.
    public static func encode(_ img: RGBImage) -> Data {
        let w = img.width, h = img.height
        var raw = [UInt8](); raw.reserveCapacity(h * (w * 3 + 1))
        for y in 0..<h {
            raw.append(0)
            for x in 0..<w {
                raw.append(UInt8(min(max(img.r[x, y], 0), 1) * 255 + 0.5))
                raw.append(UInt8(min(max(img.g[x, y], 0), 1) * 255 + 0.5))
                raw.append(UInt8(min(max(img.b[x, y], 0), 1) * 255 + 0.5))
            }
        }
        var z: [UInt8] = [0x78, 0x01]
        var i = 0
        var a: UInt32 = 1, b: UInt32 = 0
        for v in raw { a = (a + UInt32(v)) % 65521; b = (b + a) % 65521 }
        while i < raw.count || raw.isEmpty && i == 0 {
            let n = min(65535, raw.count - i)
            let final: UInt8 = (i + n >= raw.count) ? 1 : 0
            z.append(final)
            z += [UInt8(n & 255), UInt8(n >> 8), UInt8(~n & 255), UInt8((~n >> 8) & 255)]
            z += raw[i..<(i + n)]
            i += n
            if raw.isEmpty { break }
        }
        z += be32((b << 16) | a)
        var out: [UInt8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
        out += chunk("IHDR", be32(UInt32(w)) + be32(UInt32(h)) + [8, 2, 0, 0, 0])
        out += chunk("IDAT", z)
        out += chunk("IEND", [])
        return Data(out)
    }

    public static func write(_ img: RGBImage, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try encode(img).write(to: url)
    }

    public static func write(_ plane: Plane, to url: URL, scale: Float = 1) throws {
        let p = plane.mapped { $0 * scale }
        try write(RGBImage(r: p, g: p, b: p), to: url)
    }
}
