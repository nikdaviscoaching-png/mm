import Foundation

/// User-visible processing phases (the app shows `title`, e.g. "ALIGNING 3/12").
public enum ProcessingPhase: String, Sendable, Codable {
    case preparing, developing, aligning, analyzingFocus, buildingFocusMap, blending
    case analyzingLighting, buildingQualityMaps, selectingRegions, finalizing, verifying, cleaning

    public var title: String {
        switch self {
        case .preparing: return "PREPARING"
        case .developing: return "DEVELOPING FRAMES"
        case .aligning: return "ALIGNING"
        case .analyzingFocus: return "ANALYZING FOCUS"
        case .buildingFocusMap: return "BUILDING FOCUS MAP"
        case .blending: return "BLENDING"
        case .analyzingLighting: return "ANALYZING LIGHTING"
        case .buildingQualityMaps: return "BUILDING QUALITY MAPS"
        case .selectingRegions: return "SELECTING REGIONS"
        case .finalizing: return "FINALIZING IMAGE"
        case .verifying: return "VERIFYING OUTPUT"
        case .cleaning: return "CLEANING UP"
        }
    }
}

public struct ProcessingProgress: Sendable, Equatable {
    public var phase: ProcessingPhase
    public var current: Int
    public var total: Int
    /// Overall completion 0…1 across the whole job.
    public var fraction: Double
    public var label: String { total > 1 ? "\(phase.title) \(current)/\(total)" : phase.title }
    public init(phase: ProcessingPhase, current: Int = 0, total: Int = 0, fraction: Double = 0) {
        self.phase = phase; self.current = current; self.total = total; self.fraction = fraction
    }
}

public typealias ProgressHandler = @Sendable (ProcessingProgress) -> Void
public typealias CancelCheck = @Sendable () -> Bool

/// Maps a sub-task's 0…1 progress into a slice of the overall job.
public struct ProgressSlice: Sendable {
    public let handler: ProgressHandler?
    public let start: Double
    public let span: Double
    public init(_ handler: ProgressHandler?, start: Double, span: Double) {
        self.handler = handler; self.start = start; self.span = span
    }
    public func report(_ phase: ProcessingPhase, _ current: Int, _ total: Int, sub: Double) {
        handler?(ProcessingProgress(phase: phase, current: current, total: total, fraction: start + span * min(max(sub, 0), 1)))
    }
}
