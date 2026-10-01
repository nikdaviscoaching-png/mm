import Foundation

public enum StackType: String, Codable, Sendable, CaseIterable {
    case focus, lighting, combined
    public var title: String {
        switch self { case .focus: return "FOCUS"; case .lighting: return "LIGHTING"; case .combined: return "COMBINED" }
    }
}

public enum CaptureFormat: String, Codable, Sendable, CaseIterable {
    case standard          // high-quality HEIF/JPEG
    case maximumQuality    // maximum-resolution processed capture
    case raw               // DNG
    case proRAW            // Apple ProRAW DNG
    public var title: String {
        switch self { case .standard: return "HEIF"; case .maximumQuality: return "MAX"; case .raw: return "RAW"; case .proRAW: return "ProRAW" }
    }
}

public enum FinalFormat: String, Codable, Sendable, CaseIterable {
    case jpeg, heif, tiff
    /// Single RAW/ProRAW captures are kept as the camera's own DNG (never re-encoded). Not offered for stack output.
    case dng
    public var fileExtension: String { switch self { case .jpeg: return "jpg"; case .heif: return "heic"; case .tiff: return "tif"; case .dng: return "dng" } }
    public var title: String { rawValue.uppercased() }
    /// Formats a stack can be written as.
    public static var stackFormats: [FinalFormat] { [.jpeg, .heif, .tiff] }
}

public enum SaveDestination: String, Codable, Sendable, CaseIterable {
    case appLibrary, photos, both
    public var title: String { switch self { case .appLibrary: return "App Library"; case .photos: return "Photos"; case .both: return "Both" } }
}

public enum ProjectStatus: String, Codable, Sendable {
    case capturing          // frames are being collected
    case readyToProcess     // capture finished, nothing processed yet
    case processing         // a run is in flight (if found at launch: it was interrupted)
    case interrupted        // a run stopped (cancel / crash / error); sources intact, resumable
    case completed          // final verified and saved
}

/// Everything about a capture that must stay constant through a stack.
public struct CaptureConfiguration: Codable, Sendable, Equatable {
    public var lensID: String = ""
    public var lensName: String = ""
    public var equivalentFocalLength: Double? = nil
    public var format: CaptureFormat = .standard
    public var width: Int = 0
    public var height: Int = 0
    public var iso: Float? = nil
    public var shutterSeconds: Double? = nil
    public var exposureBias: Float? = nil
    public var whiteBalanceKelvin: Float? = nil
    public var whiteBalanceTint: Float? = nil
    public var lensPosition: Float? = nil
    public init() {}
}

public enum FrameFileKind: String, Codable, Sendable {
    case jpeg, heif, dng, tiff, png, scw, other
    public static func from(url: URL) -> FrameFileKind {
        switch url.pathExtension.lowercased() {
        case "jpg", "jpeg": return .jpeg
        case "heic", "heif": return .heif
        case "dng": return .dng
        case "tif", "tiff": return .tiff
        case "png": return .png
        case "scw": return .scw
        default: return .other
        }
    }
    public var isRAW: Bool { self == .dng }
}

public struct StackFrame: Codable, Sendable, Identifiable, Equatable {
    public var id: UUID = UUID()
    /// File name inside the project's `frames/` folder.
    public var fileName: String
    public var kind: FrameFileKind
    public var focusPosition: Float? = nil
    public var lightingPosition: Int? = nil
    public var timestamp: Date = Date()
    public var iso: Float? = nil
    public var shutterSeconds: Double? = nil
    public var byteSize: Int64 = 0
    public init(fileName: String, kind: FrameFileKind) { self.fileName = fileName; self.kind = kind }
}

/// Frames that belong together. Focus: one group. Lighting: each frame its own group. Combined: one group per light position.
public struct FocusStackGroup: Codable, Sendable, Identifiable, Equatable {
    public var id: UUID = UUID()
    public var lightingPosition: Int? = nil
    public var nearFocus: Float? = nil
    public var farFocus: Float? = nil
    public var frames: [StackFrame] = []
    /// Intermediate focus composite (name inside `work/`), once built.
    public var compositeFileName: String? = nil
    public init(lightingPosition: Int? = nil) { self.lightingPosition = lightingPosition }
}

public struct StackProject: Codable, Sendable, Identifiable, Equatable {
    public var id: UUID = UUID()
    public var createdDate: Date = Date()
    public var type: StackType
    public var configuration = CaptureConfiguration()
    public var collectionID: UUID? = nil
    public var groups: [FocusStackGroup] = []
    public var status: ProjectStatus = .capturing
    public var quality: StackQuality = .maximum
    public var keepSourceFrames: Bool = false
    public var finalFormat: FinalFormat = .jpeg
    public var saveDestination: SaveDestination = .appLibrary
    public var plannedFocusFrames: Int? = nil
    public var notes: String = ""
    public var failureMessage: String? = nil
    /// Steps already finished (checkpoints for resume), e.g. "developed:<frameID>", "composite:<groupID>", "final".
    public var completedSteps: [String] = []
    public var finalFileName: String? = nil
    /// Frame index (in capture order) the user wants as lighting base; nil = automatic.
    public var preferredLightingBase: Int? = nil
    public init(type: StackType) { self.type = type }

    public var allFrames: [StackFrame] { groups.flatMap { $0.frames } }
    public var frameCount: Int { groups.reduce(0) { $0 + $1.frames.count } }
    public var lightingPositionCount: Int { type == .focus ? 0 : groups.count }
}

// MARK: Library

public struct SpecimenCollection: Codable, Sendable, Identifiable, Equatable, Hashable {
    public var id: UUID = UUID()
    public var name: String
    public var createdDate: Date = Date()
    public init(name: String) { self.name = name }
}

public enum LibraryItemKind: String, Codable, Sendable {
    case single, focus, lighting, combined
    public init(_ t: StackType) {
        switch t { case .focus: self = .focus; case .lighting: self = .lighting; case .combined: self = .combined }
    }
}

public struct ScaleMetadata: Codable, Sendable, Equatable {
    public enum Method: String, Codable, Sendable { case manualReference, lidar, depthData }
    public var pixelsPerMillimeter: Double
    public var method: Method
    /// Honest, human-readable accuracy statement (e.g. "±3 % (reference card)").
    public var accuracyNote: String
    public init(pixelsPerMillimeter: Double, method: Method, accuracyNote: String) {
        self.pixelsPerMillimeter = pixelsPerMillimeter; self.method = method; self.accuracyNote = accuracyNote
    }
}

public struct LibraryItem: Codable, Sendable, Identifiable, Equatable {
    public var id: UUID = UUID()
    public var collectionID: UUID
    public var kind: LibraryItemKind
    public var captureDate: Date
    public var processingDate: Date = Date()
    public var fileName: String                 // master inside Library/Masters
    public var thumbnailFileName: String? = nil
    public var width: Int
    public var height: Int
    public var finalFormat: FinalFormat
    public var lensName: String = ""
    public var equivalentFocalLength: Double? = nil
    public var iso: Float? = nil
    public var shutterSeconds: Double? = nil
    public var whiteBalanceKelvin: Float? = nil
    public var captureFormat: CaptureFormat = .standard
    public var focusFrameCount: Int = 0
    public var lightingFrameCount: Int = 0
    public var sourceWasRAW: Bool = false
    public var sourceWasProRAW: Bool = false
    public var notes: String = ""
    public var scale: ScaleMetadata? = nil
    public var keptSourcesFolder: String? = nil
    public var photosLocalIdentifier: String? = nil
    public init(collectionID: UUID, kind: LibraryItemKind, captureDate: Date, fileName: String, width: Int, height: Int, finalFormat: FinalFormat) {
        self.collectionID = collectionID; self.kind = kind; self.captureDate = captureDate
        self.fileName = fileName; self.width = width; self.height = height; self.finalFormat = finalFormat
    }
}
