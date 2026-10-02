import Foundation
import CoreGraphics
import Darwin
import SpecimenCore

/// A raw RGBA8 image backed by a memory-mapped file. A ~190 MP result (≈ 760 MB) is written tile by tile straight into the mapping, so
/// the OS pages it in and out instead of the app holding it as resident memory; it can also be handed to CoreGraphics/ImageIO
/// without a copy (`cgImage`) and read back by region for high-resolution zooming.
final class MappedRGBAFile: @unchecked Sendable {
    enum Failure: Error { case open, resize, map }

    let url: URL
    let width: Int
    let height: Int
    private let base: UnsafeMutableRawPointer
    private let size: Int
    private let fd: Int32

    /// Creates (or truncates) the file and maps it read/write.
    init(create url: URL, width: Int, height: Int) throws {
        self.url = url; self.width = width; self.height = height
        size = width * height * 4
        fd = open(url.path, O_RDWR | O_CREAT | O_TRUNC, 0o644)
        guard fd >= 0 else { throw Failure.open }
        guard ftruncate(fd, off_t(size)) == 0 else { close(fd); throw Failure.resize }
        guard let p = mmap(nil, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0), p != MAP_FAILED else { close(fd); throw Failure.map }
        base = p
    }

    /// Maps an existing file read-only.
    init(open url: URL, width: Int, height: Int) throws {
        self.url = url; self.width = width; self.height = height
        size = width * height * 4
        fd = Darwin.open(url.path, O_RDONLY)
        guard fd >= 0 else { throw Failure.open }
        var st = stat()
        guard fstat(fd, &st) == 0, Int(st.st_size) >= size else { close(fd); throw Failure.resize }
        guard let p = mmap(nil, size, PROT_READ, MAP_SHARED, fd, 0), p != MAP_FAILED else { close(fd); throw Failure.map }
        base = p
    }

    deinit { munmap(base, size); close(fd) }

    /// Copies a tightly packed RGBA tile into place.
    func write(rect: SRRect, bytes: UnsafePointer<UInt8>) {
        let dst = base.assumingMemoryBound(to: UInt8.self)
        for r in 0..<rect.height {
            memcpy(dst + ((rect.y + r) * width + rect.x) * 4, bytes + r * rect.width * 4, rect.width * 4)
        }
    }

    func flush() { msync(base, size, MS_ASYNC) }

    /// The whole image as a CGImage that reads the mapping directly (no copy). The image keeps this file alive.
    func cgImage(colorSpace: CGColorSpace) -> CGImage? {
        let info = Unmanaged.passRetained(self).toOpaque()
        guard let provider = CGDataProvider(dataInfo: info, data: UnsafeRawPointer(base), size: size, releaseData: { info, _, _ in
            if let info { Unmanaged<MappedRGBAFile>.fromOpaque(info).release() }
        }) else { Unmanaged<MappedRGBAFile>.fromOpaque(info).release(); return nil }
        return CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4, space: colorSpace,
                       bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue), provider: provider, decode: nil,
                       shouldInterpolate: false, intent: .defaultIntent)
    }
}
