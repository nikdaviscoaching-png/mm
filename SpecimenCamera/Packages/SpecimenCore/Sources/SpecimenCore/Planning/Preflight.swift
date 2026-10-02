import Foundation

public struct StorageEstimate: Sendable, Equatable {
    public var sourceBytes: Int64            // captured/imported originals kept in frames/
    public var workingPeakBytes: Int64       // developed frames + composites + final at the busiest moment
    public var totalPeakBytes: Int64 { sourceBytes + workingPeakBytes }
}

public enum PreflightIssue: Sendable, Equatable {
    case insufficientStorage(needed: Int64, available: Int64)
    case lowStorage(needed: Int64, available: Int64)
    case lowBattery(Float)
    case criticalBattery(Float)
    case thermalSerious
    case thermalCritical

    public var isBlocking: Bool {
        switch self {
        case .insufficientStorage, .criticalBattery, .thermalCritical: return true
        default: return false
        }
    }

    public var message: String {
        func gb(_ b: Int64) -> String { String(format: "%.1f GB", Double(b) / 1e9) }
        switch self {
        case .insufficientStorage(let n, let a): return "Not enough free storage: this stack needs about \(gb(n)) and only \(gb(a)) is free."
        case .lowStorage(let n, let a): return "Storage is tight: about \(gb(n)) needed, \(gb(a)) free."
        case .lowBattery(let l): return "Battery is at \(Int(l * 100)) %. Long stacks and processing use a lot of power — consider plugging in."
        case .criticalBattery(let l): return "Battery is at \(Int(l * 100)) %. Plug in before starting a stack."
        case .thermalSerious: return "The phone is warm. Processing will run with reduced concurrency."
        case .thermalCritical: return "The phone is too hot. Let it cool down before starting."
        }
    }
}

public enum StackPreflight {

    /// Typical encoded size of one captured frame.
    public static func sourceFrameBytes(format: CaptureFormat, width: Int, height: Int) -> Int64 {
        let px = Int64(width) * Int64(height)
        switch format {
        case .standard: return px * 3 / 8             // HEIF ≈ 0.4 B/px at high quality
        case .maximumQuality: return px / 2
        case .raw: return px * 2                       // 12–14-bit packed DNG, lossless-compressed ≈ 1.5–2 B/px
        case .proRAW: return px * 3                    // ProRAW ≈ 2.5–3 B/px
        }
    }

    public static func workingFrameBytes(width: Int, height: Int) -> Int64 { Int64(ScwFormat.fileSize(width: width, height: height)) }

    /// - Parameters:
    ///   - groupSizes: number of source frames in each group (focus: [n]; lighting: [1,1,1,…]; combined: [n,n,…]).
    public static func estimate(type: StackType, groupSizes: [Int], format: CaptureFormat, width: Int, height: Int, keepSources: Bool) -> StorageEstimate {
        let totalFrames = groupSizes.reduce(0, +)
        let src = Int64(totalFrames) * sourceFrameBytes(format: format, width: width, height: height)
        let w = workingFrameBytes(width: width, height: height)
        let largestGroup = Int64(groupSizes.max() ?? 0)
        var peak: Int64
        switch type {
        case .focus: peak = (largestGroup + 2) * w                         // developed frames + output (+ slack)
        case .lighting: peak = (Int64(totalFrames) + 2) * w
        case .combined:
            // developed frames of one group + composites of all groups + final
            peak = (largestGroup + Int64(groupSizes.count) + 2) * w
        }
        peak += Int64(Double(w) * 0.15)                                   // encoded final
        _ = keepSources
        return StorageEstimate(sourceBytes: src, workingPeakBytes: peak)
    }

    public static func check(estimate: StorageEstimate, availableBytes: Int64, batteryLevel: Float?, isCharging: Bool, thermal: ThermalLevel) -> [PreflightIssue] {
        var out: [PreflightIssue] = []
        let needed = Int64(Double(estimate.totalPeakBytes) * 1.1)
        if availableBytes < needed { out.append(.insufficientStorage(needed: needed, available: availableBytes)) }
        else if availableBytes < Int64(Double(needed) * 1.5) { out.append(.lowStorage(needed: needed, available: availableBytes)) }
        if let b = batteryLevel, !isCharging, b >= 0 {
            if b < 0.10 { out.append(.criticalBattery(b)) } else if b < 0.25 { out.append(.lowBattery(b)) }
        }
        switch thermal {
        case .serious: out.append(.thermalSerious)
        case .critical: out.append(.thermalCritical)
        default: break
        }
        return out
    }
}

public enum ThermalLevel: Int, Sendable, Comparable, Codable {
    case nominal = 0, fair, serious, critical
    public static func < (a: ThermalLevel, b: ThermalLevel) -> Bool { a.rawValue < b.rawValue }
}

/// Thermal management reduces *concurrency*, never image quality.
public enum ThermalPolicy {
    /// Worker threads allowed right now. Two at normal temperature (sustained all-core work heats a phone quickly and the
    /// result is the same, only later); one when warm or hot; none (pause) when critical. Never changes quality.
    public static func concurrency(thermal: ThermalLevel, cores: Int, lowPowerMode: Bool) -> Int {
        let base = max(1, min(cores - 2, 2))
        var c: Int
        switch thermal {
        case .nominal: c = base
        case .fair, .serious: c = 1
        case .critical: return 0
        }
        if lowPowerMode { c = min(c, 1) }
        return max(1, c)
    }

    public static func userMessage(_ t: ThermalLevel) -> String? {
        switch t {
        case .nominal: return nil
        case .fair: return "Phone is warming up — processing slightly reduced."
        case .serious: return "Phone is hot — processing is running one tile at a time (same quality, slower)."
        case .critical: return "Phone is very hot — processing is paused until it cools down. Nothing is lost."
        }
    }
}
