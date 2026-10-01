import Foundation
import Photos
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers
import ImageIO
import SpecimenCore

struct ImportedFile: Identifiable, Equatable {
    var id = UUID()
    var stagedURL: URL                  // private copy inside the app sandbox; the original is never touched
    var displayName: String
    var candidate: ImportCandidate
    var kind: FrameFileKind
}

/// IMPORT STACK: brings existing images (JPEG, HEIF/HEIC, TIFF, DNG, ProRAW) into a stack project.
/// Originals are only ever *read*: Photos assets are exported to a private copy with `PHAssetResourceManager` (network access
/// disabled — the app works fully offline), and files are copied from the Files provider. Nothing is modified or deleted.
@MainActor
final class ImportService: ObservableObject {
    @Published private(set) var files: [ImportedFile] = []
    @Published private(set) var isLoading = false
    @Published var errorMessage: String?

    private let processing: ProcessingService
    init(processing: ProcessingService) { self.processing = processing }

    static let allowedTypes: [UTType] = [.image, .rawImage, .tiff, .heic, .jpeg]

    func clear() {
        for f in files { try? FileManager.default.removeItem(at: f.stagedURL) }
        files = []
    }

    // MARK: Photos

    func load(from items: [PhotosPickerItem]) async {
        isLoading = true; defer { isLoading = false }
        // Read access lets us fetch the true original resource (e.g. the DNG of a ProRAW). If the user declines (or grants limited
        // access) we fall back to the data the picker itself provides.
        _ = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        for item in items {
            do {
                if let id = item.itemIdentifier, let staged = try await exportOriginal(localIdentifier: id) {
                    append(staged: staged.url, name: staged.name)
                } else if let data = try await item.loadTransferable(type: Data.self) {
                    let ext = item.supportedContentTypes.first?.preferredFilenameExtension ?? "jpg"
                    let url = AppPaths.staging.appendingPathComponent("import_\(UUID().uuidString.prefix(8)).\(ext)")
                    try data.write(to: url, options: .atomic)
                    append(staged: url, name: url.lastPathComponent)
                }
            } catch { errorMessage = error.localizedDescription }
        }
    }

    private func exportOriginal(localIdentifier id: String) async throws -> (url: URL, name: String)? {
        guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject else { return nil }
        let resources = PHAssetResource.assetResources(for: asset)
        // Prefer the RAW resource of a RAW+JPEG pair, otherwise the original photo resource (DNG for ProRAW).
        let raw = resources.first { r in r.type == .alternatePhoto && (UTType(r.uniformTypeIdentifier)?.conforms(to: .rawImage) ?? false) }
        guard let pick = raw ?? resources.first(where: { $0.type == .photo }) ?? resources.first else { return nil }
        let ext = UTType(pick.uniformTypeIdentifier)?.preferredFilenameExtension ?? (pick.originalFilename as NSString).pathExtension
        let url = AppPaths.staging.appendingPathComponent("import_\(UUID().uuidString.prefix(8)).\(ext)")
        let opts = PHAssetResourceRequestOptions()
        opts.isNetworkAccessAllowed = false                       // offline: originals stored only in iCloud cannot be fetched
        return try await withCheckedThrowingContinuation { cont in
            PHAssetResourceManager.default().writeData(for: pick, toFile: url, options: opts) { error in
                if let error {
                    cont.resume(throwing: ImportError.notLocal(pick.originalFilename, error.localizedDescription))
                } else { cont.resume(returning: (url, pick.originalFilename)) }
            }
        }
    }

    // MARK: Files

    func load(fileURLs: [URL]) async {
        isLoading = true; defer { isLoading = false }
        for src in fileURLs {
            let scoped = src.startAccessingSecurityScopedResource()
            defer { if scoped { src.stopAccessingSecurityScopedResource() } }
            let ext = src.pathExtension.isEmpty ? "dat" : src.pathExtension
            let dest = AppPaths.staging.appendingPathComponent("import_\(UUID().uuidString.prefix(8)).\(ext)")
            do {
                try FileManager.default.copyItem(at: src, to: dest)       // copy, never move
                append(staged: dest, name: src.lastPathComponent)
            } catch { errorMessage = "Could not read \(src.lastPathComponent): \(error.localizedDescription)" }
        }
    }

    private func append(staged: URL, name: String) {
        var cand = Self.readMetadata(staged)
        cand.url = staged
        files.append(ImportedFile(stagedURL: staged, displayName: name, candidate: cand, kind: FrameFileKind.from(url: staged)))
    }

    enum ImportError: LocalizedError {
        case notLocal(String, String)
        var errorDescription: String? {
            switch self { case .notLocal(let n, let why): return "\(n) is not stored on this phone (\(why)). Open it in Photos to download it first, then import again." }
        }
    }

    // MARK: Metadata

    static func readMetadata(_ url: URL) -> ImportCandidate {
        var c = ImportCandidate(url: url)
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        c.captureDate = attrs?[.creationDate] as? Date
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil), let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
              let exif = props[kCGImagePropertyExifDictionary] as? [CFString: Any] else { return c }
        if let s = exif[kCGImagePropertyExifDateTimeOriginal] as? String {
            let df = DateFormatter(); df.locale = Locale(identifier: "en_US_POSIX"); df.dateFormat = "yyyy:MM:dd HH:mm:ss"
            if var d = df.date(from: s) {
                if let sub = exif[kCGImagePropertyExifSubsecTimeOriginal] as? String, let frac = Double("0." + sub) { d = d.addingTimeInterval(frac) }
                c.captureDate = d
            }
        }
        if let t = exif[kCGImagePropertyExifExposureTime] as? Double { c.exposureSeconds = t }
        if let iso = (exif[kCGImagePropertyExifISOSpeedRatings] as? [NSNumber])?.first { c.iso = iso.floatValue }
        if let d = exif[kCGImagePropertyExifSubjectDistance] as? Double, d > 0, d < 1000 { c.subjectDistanceMM = d * 1000 }
        return c
    }

    func removeFiles(at offsets: IndexSet) { files.remove(atOffsets: offsets) }

    /// Keeps the list in capture-time order (the grouping logic and the UI both rely on it).
    func sortByCandidateOrder() {
        let order = ImportGrouper.ordered(files.map { $0.candidate }, type: .combined).map { $0.url }
        files.sort { (order.firstIndex(of: $0.stagedURL) ?? 0) < (order.firstIndex(of: $1.stagedURL) ?? 0) }
    }

    // MARK: Project creation

    /// Moves the staged private copies into a new project (one group per light position for LIGHTING/COMBINED).
    func makeProject(type: StackType, groups: [[ImportedFile]]) throws -> StackProject {
        let store = processing.store
        var p = StackProject(type: type)
        p.quality = .maximum
        p.collectionID = processing.library.activeCollection.id
        try store.createProject(p)
        for (gi, g) in groups.enumerated() {
            var grp = FocusStackGroup(lightingPosition: type == .focus ? nil : gi)
            for (fi, f) in g.enumerated() {
                let name = store.newFrameFileName(project: p, ext: f.stagedURL.pathExtension.isEmpty ? "dat" : f.stagedURL.pathExtension, label: "import")
                try FileManager.default.moveItem(at: f.stagedURL, to: store.framesDirectory(p.id).appendingPathComponent(name))
                var frame = StackFrame(fileName: name, kind: f.kind)
                frame.timestamp = f.candidate.captureDate ?? Date()
                frame.iso = f.candidate.iso; frame.shutterSeconds = f.candidate.exposureSeconds
                frame.lightingPosition = type == .focus ? nil : gi
                frame.focusPosition = type == .lighting ? nil : Float(fi)
                grp.frames.append(frame)
                p.groups = Array(p.groups.prefix(gi)) + [grp]
                try store.save(p)
            }
            if p.groups.count <= gi { p.groups.append(grp) }
        }
        p.status = .readyToProcess
        if let first = p.allFrames.first { p.configuration.format = first.kind.isRAW ? .raw : .standard }
        p.configuration.lensName = "Imported"
        try store.save(p)
        files.removeAll { f in groups.contains { $0.contains(where: { $0.id == f.id }) } }
        processing.refreshRecoverable()
        return p
    }
}
