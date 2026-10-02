import Foundation
#if canImport(Glibc)
import Glibc
#elseif canImport(Darwin)
import Darwin
#endif

/// A full-resolution frame that can be read region by region. Values are display-encoded (sRGB transfer
/// function) 0…1 floats in the frame's working colour space; reads outside the frame replicate the edge.
/// Engines read tiles, never whole frames, which is what keeps large stacks inside a fixed memory budget.
public protocol FrameSource: Sendable {
    var width: Int { get }
    var height: Int { get }
    var colorSpace: WorkingColorSpace { get }
    func read(region: PixelRect) throws -> RGBImage
}

public protocol FrameSink: Sendable {
    func write(region: PixelRect, image: RGBImage) throws
}

public extension FrameSource {
    var bounds: PixelRect { PixelRect(x: 0, y: 0, width: width, height: height) }

    /// Area-averaged downscale of the entire frame by an integer factor, streamed in bands so peak memory
    /// stays at one band plus the (small) result. Averaging is done on the stored encoding, which is what the
    /// proxy-based analysis (registration, quality maps) expects.
    func readDownscaled(factor: Int, bandRows: Int = 256) throws -> RGBImage {
        let f = max(1, factor)
        let ow = (width + f - 1) / f, oh = (height + f - 1) / f
        var out = RGBImage(width: ow, height: oh)
        let bandOut = max(1, bandRows / f)
        var oy = 0
        while oy < oh {
            let rows = min(bandOut, oh - oy)
            let region = PixelRect(x: 0, y: oy * f, width: width, height: min(rows * f, height - oy * f))
            let band = try read(region: region)
            out.paste(RGBImage(r: Filters.boxDownscale(band.r, factor: f),
                               g: Filters.boxDownscale(band.g, factor: f),
                               b: Filters.boxDownscale(band.b, factor: f)), atX: 0, y: oy)
            oy += rows
        }
        return out
    }
}

/// In-memory frame (tests, proxies, small intermediates).
public struct MemoryFrame: FrameSource {
    public let image: RGBImage
    public let colorSpace: WorkingColorSpace
    public var width: Int { image.width }
    public var height: Int { image.height }

    public init(_ image: RGBImage, colorSpace: WorkingColorSpace = .displayP3) {
        self.image = image; self.colorSpace = colorSpace
    }

    public func read(region: PixelRect) throws -> RGBImage { image.crop(region) }
}

/// Presents a frame through a registration transform, rendered on demand tile by tile — no warped copy is
/// ever stored. Identity transforms (and near-identity ones below `skipBelow` pixels) pass straight through
/// so un-needed resampling never softens a frame.
public struct WarpedFrame: FrameSource {
    public let base: any FrameSource
    public let transform: Affine2D
    public let passThrough: Bool
    public var width: Int { base.width }
    public var height: Int { base.height }
    public var colorSpace: WorkingColorSpace { base.colorSpace }

    public init(base: any FrameSource, transform: Affine2D, skipBelow: Double = 0.02) {
        self.base = base
        self.transform = transform
        let shift = transform.maxDisplacement(width: base.width, height: base.height)
        self.passThrough = shift < skipBelow
    }

    public func read(region: PixelRect) throws -> RGBImage {
        if passThrough { return try base.read(region: region) }
        let need = Resample.sourceBounds(for: region, transform: transform)
        let src = try base.read(region: need)
        return Resample.warp(src, sourceOrigin: (need.x, need.y), transform: transform, outputRect: region)
    }
}

/// In-memory sink for tests and small outputs.
public final class MemorySink: FrameSink, @unchecked Sendable {
    private let lock = NSLock()
    private var image: RGBImage
    public init(width: Int, height: Int) { image = RGBImage(width: width, height: height) }
    public func write(region: PixelRect, image tile: RGBImage) throws {
        lock.lock(); defer { lock.unlock() }
        image.paste(tile, atX: region.x, y: region.y)
    }
    public var result: RGBImage { lock.lock(); defer { lock.unlock() }; return image }
}

// MARK: - .scw working-image container

/// `.scw` — SpecimenCore working image: a 4 KiB header followed by interleaved little-endian UInt16 RGB,
/// row-major, display-encoded in the colour space named in the header. 16 bits per channel keeps intermediates
/// effectively lossless; fixed row pitch makes any tile a handful of `pread`s, so nothing is ever loaded whole.
public enum ScwFormat {
    public static let headerSize = 4096
    public static let magic: [UInt8] = Array("SCW1".utf8)
    public static func dataSize(width: Int, height: Int) -> Int { width * height * 6 }
    public static func fileSize(width: Int, height: Int) -> Int { headerSize + dataSize(width: width, height: height) }
}

private func posixError(_ what: String, _ url: URL) -> SpecimenError {
    .ioFailure("\(what) \(url.lastPathComponent): \(String(cString: strerror(errno)))")
}

public final class ScwFrame: FrameSource, @unchecked Sendable {
    public let url: URL
    public let width: Int
    public let height: Int
    public let colorSpace: WorkingColorSpace
    private let fd: Int32

    public init(url: URL) throws {
        self.url = url
        let fd = open(url.path, O_RDONLY)
        guard fd >= 0 else { throw posixError("open", url) }
        var header = [UInt8](repeating: 0, count: 32)
        let n = header.withUnsafeMutableBytes { pread(fd, $0.baseAddress, 32, 0) }
        guard n == 32, Array(header[0..<4]) == ScwFormat.magic else {
            close(fd); throw SpecimenError.invalidImage("\(url.lastPathComponent) is not a working image")
        }
        func u32(_ o: Int) -> UInt32 { UInt32(header[o]) | UInt32(header[o + 1]) << 8 | UInt32(header[o + 2]) << 16 | UInt32(header[o + 3]) << 24 }
        let w = Int(u32(8)), h = Int(u32(12))
        guard w > 0, h > 0, let cs = WorkingColorSpace(rawValue: u32(16)) else {
            close(fd); throw SpecimenError.invalidImage("corrupt header in \(url.lastPathComponent)")
        }
        var st = stat()
        if fstat(fd, &st) == 0, Int(st.st_size) < ScwFormat.fileSize(width: w, height: h) {
            close(fd); throw SpecimenError.invalidImage("\(url.lastPathComponent) is truncated")
        }
        self.fd = fd; width = w; height = h; colorSpace = cs
    }

    deinit { close(fd) }

    public func read(region r: PixelRect) throws -> RGBImage {
        var out = RGBImage(width: r.width, height: r.height)
        guard r.width > 0, r.height > 0 else { return out }
        let x0 = min(max(r.x, 0), width - 1), x1 = min(max(r.maxX - 1, 0), width - 1)
        let spanW = x1 - x0 + 1
        var rowBuf = [UInt16](repeating: 0, count: spanW * 3)
        let lut = ColorMath.decodeLUT16
        _ = lut
        var cacheY = -1
        // Source rows are fetched once each even when edge replication repeats them.
        for oy in 0..<r.height {
            let sy = min(max(r.y + oy, 0), height - 1)
            if sy != cacheY {
                let off = off_t(ScwFormat.headerSize + (sy * width + x0) * 6)
                let want = spanW * 6
                let got = rowBuf.withUnsafeMutableBytes { pread(fd, $0.baseAddress, want, off) }
                guard got == want else { throw posixError("read", url) }
                cacheY = sy
            }
            out.r.pixels.withUnsafeMutableBufferPointer { dr in
            out.g.pixels.withUnsafeMutableBufferPointer { dg in
            out.b.pixels.withUnsafeMutableBufferPointer { db in
                rowBuf.withUnsafeBufferPointer { rb in
                    let ob = oy * r.width
                    for ox in 0..<r.width {
                        let sx = min(max(r.x + ox, 0), width - 1) - x0
                        dr[ob + ox] = Float(rb[sx * 3]) * (1.0 / 65535.0)
                        dg[ob + ox] = Float(rb[sx * 3 + 1]) * (1.0 / 65535.0)
                        db[ob + ox] = Float(rb[sx * 3 + 2]) * (1.0 / 65535.0)
                    }
                }
            }}}
        }
        return out
    }
}

public final class ScwWriter: FrameSink, @unchecked Sendable {
    public let url: URL
    public let width: Int
    public let height: Int
    public let colorSpace: WorkingColorSpace
    private let fd: Int32

    /// Creates (truncating) a file of full size so tiles can be written in any order.
    public init(url: URL, width: Int, height: Int, colorSpace: WorkingColorSpace) throws {
        self.url = url; self.width = width; self.height = height; self.colorSpace = colorSpace
        let fd = open(url.path, O_RDWR | O_CREAT | O_TRUNC, 0o644)
        guard fd >= 0 else { throw posixError("create", url) }
        var header = [UInt8](repeating: 0, count: ScwFormat.headerSize)
        header.replaceSubrange(0..<4, with: ScwFormat.magic)
        func put(_ v: UInt32, _ o: Int) { for i in 0..<4 { header[o + i] = UInt8((v >> (8 * UInt32(i))) & 0xFF) } }
        put(1, 4); put(UInt32(width), 8); put(UInt32(height), 12); put(colorSpace.rawValue, 16); put(3, 20); put(16, 24)
        let n = header.withUnsafeBytes { pwrite(fd, $0.baseAddress, ScwFormat.headerSize, 0) }
        guard n == ScwFormat.headerSize else { close(fd); throw posixError("write header", url) }
        guard ftruncate(fd, off_t(ScwFormat.fileSize(width: width, height: height))) == 0 else {
            close(fd); throw posixError("allocate", url)
        }
        self.fd = fd
    }

    deinit { close(fd) }

    public func write(region r: PixelRect, image: RGBImage) throws {
        let c = r.intersection(PixelRect(x: 0, y: 0, width: width, height: height))
        guard !c.isEmpty else { return }
        var rowBuf = [UInt16](repeating: 0, count: c.width * 3)
        for y in c.y..<c.maxY {
            let iy = y - r.y
            image.r.pixels.withUnsafeBufferPointer { pr in
            image.g.pixels.withUnsafeBufferPointer { pg in
            image.b.pixels.withUnsafeBufferPointer { pb in
                rowBuf.withUnsafeMutableBufferPointer { rb in
                    for x in 0..<c.width {
                        let ix = c.x - r.x + x
                        let i = iy * image.width + ix
                        rb[x * 3] = UInt16(min(max(pr[i], 0), 1) * 65535 + 0.5)
                        rb[x * 3 + 1] = UInt16(min(max(pg[i], 0), 1) * 65535 + 0.5)
                        rb[x * 3 + 2] = UInt16(min(max(pb[i], 0), 1) * 65535 + 0.5)
                    }
                }
            }}}
            let off = off_t(ScwFormat.headerSize + (y * width + c.x) * 6)
            let want = c.width * 6
            let n = rowBuf.withUnsafeBytes { pwrite(fd, $0.baseAddress, want, off) }
            guard n == want else { throw posixError("write", url) }
        }
    }

    /// Flushes to stable storage so a verified-written final image really is on disk before sources are deleted.
    public func finish() throws {
        guard fsync(fd) == 0 else { throw posixError("sync", url) }
    }

    /// Convenience: write a whole in-memory image.
    public static func save(_ image: RGBImage, to url: URL, colorSpace: WorkingColorSpace = .displayP3) throws {
        let w = try ScwWriter(url: url, width: image.width, height: image.height, colorSpace: colorSpace)
        try w.write(region: PixelRect(x: 0, y: 0, width: image.width, height: image.height), image: image)
        try w.finish()
    }
}
