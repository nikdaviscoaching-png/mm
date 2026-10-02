import Foundation

/// Stack-level metadata written into composite images. Where values differ across frames (focus, light) the metadata
/// describes the stack, not a misleading single frame.
public struct CompositeMetadata: Codable, Sendable, Equatable {
    public var appName = "SPECIMEN CAMERA"
    public var compositeType: String            // "Focus Stack", "Lighting Stack", "Combined Stack", "Single"
    public var sourceFrameCount: Int
    public var focusFrameCount: Int
    public var lightingPositionCount: Int
    public var lensName: String
    public var equivalentFocalLength: Double?
    public var iso: Float?
    public var shutterSeconds: Double?
    public var whiteBalanceKelvin: Float?
    public var exposureBias: Float?
    public var captureFormat: CaptureFormat
    public var sourceWasRAW: Bool
    public var originalCaptureDate: Date
    public var processingDate: Date
    public var qualityPreset: String
    public var focusRangeLensPosition: [Float]?     // [near, far]
    public var scale: ScaleMetadata?
    public var notes: String

    public init(project: StackProject, processingDate: Date = Date()) {
        compositeType = project.type == .focus ? "Focus Stack" : project.type == .lighting ? "Lighting Stack" : "Combined Stack"
        sourceFrameCount = project.frameCount
        let groups = project.groups
        focusFrameCount = project.type == .lighting ? 0 : (groups.map { $0.frames.count }.max() ?? 0)
        lightingPositionCount = project.type == .focus ? 0 : groups.count
        lensName = project.configuration.lensName
        equivalentFocalLength = project.configuration.equivalentFocalLength
        iso = project.configuration.iso; shutterSeconds = project.configuration.shutterSeconds
        whiteBalanceKelvin = project.configuration.whiteBalanceKelvin; exposureBias = project.configuration.exposureBias
        captureFormat = project.configuration.format
        sourceWasRAW = project.allFrames.contains { $0.kind.isRAW }
        originalCaptureDate = project.allFrames.map { $0.timestamp }.min() ?? project.createdDate
        self.processingDate = processingDate
        qualityPreset = project.quality.title
        if let g = groups.first(where: { $0.nearFocus != nil && $0.farFocus != nil }), let n = g.nearFocus, let f = g.farFocus { focusRangeLensPosition = [n, f] } else { focusRangeLensPosition = nil }
        scale = nil
        notes = project.notes
    }

    /// Human-readable summary placed in EXIF UserComment / TIFF ImageDescription.
    public var summary: String {
        var parts = ["\(appName) — \(compositeType)", "\(sourceFrameCount) source frames"]
        if focusFrameCount > 0 { parts.append("\(focusFrameCount) focus planes") }
        if lightingPositionCount > 0 { parts.append("\(lightingPositionCount) light positions") }
        if !lensName.isEmpty { parts.append(lensName) }
        parts.append("preset: \(qualityPreset)")
        return parts.joined(separator: "; ")
    }
}
