import Foundation

public enum SRDetailLevel: String, CaseIterable, Sendable, Codable {
    case natural, crisp, max
    public var title: String { rawValue.capitalized }
    var sharpen: Float { switch self { case .natural: return 0.6; case .crisp: return 1.0; case .max: return 1.5 } }
    var clarity: Float { switch self { case .natural: return 0.06; case .crisp: return 0.12; case .max: return 0.18 } }
}

public struct UpscaleSettings: Sendable {
    public var detail: SRDetailLevel = .crisp
    /// 0 = no AI contribution (the default; the multi-frame reconstruction is authoritative).
    public var aiStrength: Float = 0
    public var tileSize = 384
    /// nil = the sharpest frame becomes the reference (output framing follows it).
    public var referenceIndex: Int? = nil
    public init() {}
}

/// Optional on-device model: returns the LUMINANCE (0…255) of an AI-enlarged version of the tile at output resolution, or nil.
/// Only its bounded high-frequency luminance difference ever enters the picture.
public protocol UpscaleAIProvider: Sendable {
    func detailLuma(for rect: SRRect, outputScale: Int, reference: RGBA8Image) -> [Float]?
}

enum SRDetail {
    static let sharpenSigma: Float = 1.0, haloOvershoot: Float = 2.0
    static let aiHighPassSigma: Float = 1.2, aiAbsoluteLimit: Float = 10, aiRelativeLimit: Float = 2.5, aiConfidenceRelief: Float = 0.6
    static let clarityRadiusSigma: Float = 6

    /// Finishes a tile in place: optional AI high frequencies, luminance-only sharpening with halo protection, gentle clarity.
    static func finish(rgba: inout [UInt8], width w: Int, height h: Int, confidence: [Float], settings: UpscaleSettings, ai: [Float]?) {
        let n = w * h
        var y0 = FloatPlane(width: w, height: h)
        for i in 0..<n { y0.data[i] = 0.299 * Float(rgba[i * 4]) + 0.587 * Float(rgba[i * 4 + 1]) + 0.114 * Float(rgba[i * 4 + 2]) }
        var y = y0
        if let ai, ai.count == n, settings.aiStrength > 0 {
            var ya = FloatPlane(width: w, height: h); ya.data = ai
            let bm = SRMath.blur(y, sigma: aiHighPassSigma), ba = SRMath.blur(ya, sigma: aiHighPassSigma)
            for i in 0..<n {
                let hpM = y.data[i] - bm.data[i], hpA = ya.data[i] - ba.data[i]
                let limit = max(aiAbsoluteLimit, aiRelativeLimit * abs(hpM))
                let diff = min(max(hpA - hpM, -limit), limit)
                let alpha = settings.aiStrength * (1 - aiConfidenceRelief * confidence[i])
                y.data[i] += alpha * diff
            }
        }
        // classic luminance sharpening, never beyond the local 3×3 range ± haloOvershoot
        let blur = SRMath.blur(y, sigma: sharpenSigma)
        var sharp = y
        let s = settings.detail.sharpen
        for yy in 0..<h { for xx in 0..<w {
            let i = yy * w + xx
            var lo = Float.greatestFiniteMagnitude, hi = -Float.greatestFiniteMagnitude
            for oy in -1...1 { for ox in -1...1 { let v = y.at(xx + ox, yy + oy); lo = min(lo, v); hi = max(hi, v) } }
            sharp.data[i] = min(max(y.data[i] + s * (y.data[i] - blur.data[i]), lo - haloOvershoot), hi + haloOvershoot)
        } }
        // clarity: larger-radius midtone contrast
        let low = SRMath.blur(sharp, sigma: clarityRadiusSigma)
        let amount = settings.detail.clarity
        for i in 0..<n {
            let m = sharp.data[i] / 127.5 - 1
            let midtone = max(0, 1 - m * m)
            sharp.data[i] += amount * (sharp.data[i] - low.data[i]) * midtone
        }
        for i in 0..<n {
            let d = sharp.data[i] - y0.data[i]
            for c in 0..<3 { rgba[i * 4 + c] = UInt8(max(0, min(255, Float(rgba[i * 4 + c]) + d + 0.5))) }
        }
    }
}
