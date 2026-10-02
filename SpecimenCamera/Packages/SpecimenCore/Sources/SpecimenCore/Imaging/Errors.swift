import Foundation

public enum SpecimenError: Error, LocalizedError, Sendable, Equatable {
    case invalidImage(String)
    case ioFailure(String)
    case cancelled
    case insufficientFrames(needed: Int, got: Int)
    case registrationFailed(String)
    case dimensionMismatch(String)
    case storageFailure(String)
    case unsupported(String)

    public var errorDescription: String? {
        switch self {
        case .invalidImage(let s): return "Invalid image: \(s)"
        case .ioFailure(let s): return "I/O failure: \(s)"
        case .cancelled: return "Cancelled"
        case .insufficientFrames(let n, let g): return "Need at least \(n) frames, got \(g)"
        case .registrationFailed(let s): return "Alignment failed: \(s)"
        case .dimensionMismatch(let s): return "Frame size mismatch: \(s)"
        case .storageFailure(let s): return "Storage problem: \(s)"
        case .unsupported(let s): return "Unsupported: \(s)"
        }
    }
}
