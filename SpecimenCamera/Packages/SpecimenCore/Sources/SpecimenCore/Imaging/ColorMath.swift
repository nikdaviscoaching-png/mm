import Foundation

/// Colour space of stored working images. Both use the sRGB transfer function (Display P3 shares it).
public enum WorkingColorSpace: UInt32, Sendable, Codable {
    case sRGB = 0
    case displayP3 = 1

    public var luma: LumaCoefficients {
        switch self {
        case .sRGB: return .rec709
        case .displayP3: return .displayP3
        }
    }
}

public struct LumaCoefficients: Sendable, Equatable {
    public let r: Float, g: Float, b: Float
    public static let rec709 = LumaCoefficients(r: 0.2126, g: 0.7152, b: 0.0722)
    /// Y row of the Display P3 (D65) RGB→XYZ matrix.
    public static let displayP3 = LumaCoefficients(r: 0.2290, g: 0.6917, b: 0.0793)
}

public enum ColorMath {
    @inline(__always)
    public static func decode(_ v: Float) -> Float {
        v <= 0.04045 ? v / 12.92 : powf((v + 0.055) / 1.055, 2.4)
    }

    @inline(__always)
    public static func encode(_ v: Float) -> Float {
        let c = min(max(v, 0), 1)
        return c <= 0.0031308 ? c * 12.92 : 1.055 * powf(c, 1 / 2.4) - 0.055
    }

    /// Exact decode for every 16-bit code value.
    public static let decodeLUT16: [Float] = (0..<65536).map { decode(Float($0) / 65535) }

    public static func toLinear(_ p: Plane) -> Plane {
        var out = p
        out.pixels.withUnsafeMutableBufferPointer { d in
            for i in 0..<d.count { d[i] = decode(d[i]) }
        }
        return out
    }

    public static func toEncoded(_ p: Plane) -> Plane {
        var out = p
        out.pixels.withUnsafeMutableBufferPointer { d in
            for i in 0..<d.count { d[i] = encode(d[i]) }
        }
        return out
    }

    public static func toLinear(_ i: RGBImage) -> RGBImage {
        RGBImage(r: toLinear(i.r), g: toLinear(i.g), b: toLinear(i.b))
    }

    public static func toEncoded(_ i: RGBImage) -> RGBImage {
        RGBImage(r: toEncoded(i.r), g: toEncoded(i.g), b: toEncoded(i.b))
    }
}
