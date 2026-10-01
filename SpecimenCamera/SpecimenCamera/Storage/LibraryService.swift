import Foundation
import UIKit
import SpecimenCore

/// Local library of finished images, grouped into collections (all offline, no accounts, no cloud).
@MainActor
final class LibraryService: ObservableObject {
    let store: CollectionStore
    @Published private(set) var collections: [SpecimenCollection] = []
    @Published private(set) var activeCollection: SpecimenCollection
    @Published private(set) var items: [SpecimenCore.LibraryItem] = []
    @Published private(set) var lastImage: UIImage?

    init() throws {
        store = try CollectionStore(root: AppPaths.library)
        activeCollection = store.activeCollection
        reload()
        if let newest = items.first, let url = store.thumbnailURL(for: newest) { lastImage = UIImage(contentsOfFile: url.path) }
    }

    func reload() {
        collections = store.collections
        activeCollection = store.activeCollection
        items = store.items()
    }

    func items(in collection: UUID) -> [SpecimenCore.LibraryItem] { items.filter { $0.collectionID == collection } }

    func setActive(_ id: UUID) { try? store.setActive(id); reload() }
    func createCollection(_ name: String) { if let c = try? store.createCollection(named: name) { try? store.setActive(c.id) }; reload() }
    func rename(_ id: UUID, to name: String) { try? store.rename(id, to: name); reload() }
    func deleteCollection(_ id: UUID) {
        guard let fallback = collections.first(where: { $0.id != id }) else { return }
        try? store.deleteCollection(id, moveItemsTo: fallback.id); reload()
    }
    func move(_ item: SpecimenCore.LibraryItem, to collection: UUID) { try? store.move(item.id, to: collection); reload() }
    func delete(_ item: SpecimenCore.LibraryItem) { try? store.delete(item.id); reload() }
    func update(_ item: SpecimenCore.LibraryItem) { try? store.update(item); reload() }

    func masterURL(_ item: SpecimenCore.LibraryItem) -> URL { store.masterURL(for: item) }
    func thumbnail(_ item: SpecimenCore.LibraryItem) -> UIImage? { store.thumbnailURL(for: item).flatMap { UIImage(contentsOfFile: $0.path) } }

    /// Adds a captured single photo. The camera's own file becomes the master (it is moved into the library, never re-encoded).
    @discardableResult
    func addSingle(file: URL, info: CapturedFrameInfo, lens: LensInfo?, settings: CameraSettings, format: CaptureFormat) throws -> SpecimenCore.LibraryItem {
        let id = UUID()
        let isRAW = info.kind == .dng
        let ext = file.pathExtension.isEmpty ? (isRAW ? "dng" : "heic") : file.pathExtension.lowercased()
        let name = "\(id.uuidString).\(ext)"
        let dest = store.mastersDirectory.appendingPathComponent(name)
        try FileManager.default.moveItem(at: file, to: dest)
        let size = ThumbnailService.pixelSize(of: dest) ?? (0, 0)
        var item = SpecimenCore.LibraryItem(collectionID: activeCollection.id, kind: .single, captureDate: Date(), fileName: name, width: size.0, height: size.1,
                               finalFormat: isRAW ? .dng : (ext == "jpg" || ext == "jpeg" ? .jpeg : .heif))
        item.id = id
        item.lensName = lens?.name ?? ""; item.equivalentFocalLength = lens?.equivalentFocalLengthMM
        item.iso = info.iso ?? settings.iso; item.shutterSeconds = info.shutterSeconds ?? settings.shutterSeconds
        item.whiteBalanceKelvin = settings.kelvin; item.captureFormat = format
        item.sourceWasRAW = isRAW && format == .raw; item.sourceWasProRAW = isRAW && format == .proRAW
        let thumbName = "\(id.uuidString).jpg"
        if ThumbnailService.writeJPEGThumbnail(for: dest, to: store.thumbnailsDirectory.appendingPathComponent(thumbName)) { item.thumbnailFileName = thumbName }
        try store.add(item)
        reload()
        lastImage = thumbnail(item)
        Log.storage.info("single saved to collection \(self.activeCollection.name, privacy: .public)")
        return item
    }

    /// Registers a finished stack master (already in `Masters/`).
    @discardableResult
    func addStack(master: URL, project: StackProject, metadata: CompositeMetadata, width: Int, height: Int, keptSourcesFolder: String?, scale: ScaleMetadata?) throws -> SpecimenCore.LibraryItem {
        let collection = project.collectionID.flatMap { id in collections.first { $0.id == id } } ?? activeCollection
        var item = SpecimenCore.LibraryItem(collectionID: collection.id, kind: LibraryItemKind(project.type), captureDate: metadata.originalCaptureDate, fileName: master.lastPathComponent,
                               width: width, height: height, finalFormat: project.finalFormat)
        item.id = project.id
        item.processingDate = metadata.processingDate
        item.lensName = metadata.lensName; item.equivalentFocalLength = metadata.equivalentFocalLength
        item.iso = metadata.iso; item.shutterSeconds = metadata.shutterSeconds; item.whiteBalanceKelvin = metadata.whiteBalanceKelvin
        item.captureFormat = metadata.captureFormat
        item.focusFrameCount = metadata.focusFrameCount; item.lightingFrameCount = metadata.lightingPositionCount
        item.sourceWasRAW = metadata.sourceWasRAW && metadata.captureFormat == .raw
        item.sourceWasProRAW = metadata.sourceWasRAW && metadata.captureFormat == .proRAW
        item.notes = project.notes; item.scale = scale; item.keptSourcesFolder = keptSourcesFolder
        let thumbName = "\(project.id.uuidString).jpg"
        if ThumbnailService.writeJPEGThumbnail(for: master, to: store.thumbnailsDirectory.appendingPathComponent(thumbName)) { item.thumbnailFileName = thumbName }
        try store.add(item)
        reload()
        lastImage = thumbnail(item)
        return item
    }
}
