import Foundation

/// Lightweight local library: collections + items, stored as JSON next to the masters. No cloud, no accounts.
public final class CollectionStore: @unchecked Sendable {
    public struct State: Codable, Sendable {
        var collections: [SpecimenCollection] = []
        var items: [LibraryItem] = []
        var activeCollectionID: UUID? = nil
    }

    public let root: URL
    public var mastersDirectory: URL { root.appendingPathComponent("Masters", isDirectory: true) }
    public var thumbnailsDirectory: URL { root.appendingPathComponent("Thumbnails", isDirectory: true) }
    public var keptSourcesDirectory: URL { root.appendingPathComponent("KeptSources", isDirectory: true) }
    private var state = State()
    private let lock = NSLock()
    private var stateURL: URL { root.appendingPathComponent("library.json") }

    public init(root: URL) throws {
        self.root = root
        let fm = FileManager.default
        for d in [root, mastersDirectory, thumbnailsDirectory, keptSourcesDirectory] { try fm.createDirectory(at: d, withIntermediateDirectories: true) }
        if let data = try? Data(contentsOf: stateURL) {
            let dec = JSONDecoder(); dec.dateDecodingStrategy = .secondsSince1970
            if let s = try? dec.decode(State.self, from: data) { state = s }
        }
        if state.collections.isEmpty {
            let c = SpecimenCollection(name: "Unsorted")
            state.collections = [c]; state.activeCollectionID = c.id
            try persist()
        } else if state.activeCollectionID == nil || !state.collections.contains(where: { $0.id == state.activeCollectionID }) {
            state.activeCollectionID = state.collections.first?.id
            try persist()
        }
    }

    private func persist() throws {
        let enc = JSONEncoder(); enc.outputFormatting = [.prettyPrinted, .sortedKeys]; enc.dateEncodingStrategy = .secondsSince1970
        try enc.encode(state).write(to: stateURL, options: .atomic)
    }

    // MARK: Collections

    public var collections: [SpecimenCollection] { lock.lock(); defer { lock.unlock() }; return state.collections }

    public var activeCollection: SpecimenCollection {
        lock.lock(); defer { lock.unlock() }
        return state.collections.first { $0.id == state.activeCollectionID } ?? state.collections[0]
    }

    @discardableResult
    public func createCollection(named name: String) throws -> SpecimenCollection {
        lock.lock(); defer { lock.unlock() }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if let existing = state.collections.first(where: { $0.name.caseInsensitiveCompare(trimmed) == .orderedSame }) { return existing }
        let c = SpecimenCollection(name: trimmed.isEmpty ? "Untitled" : trimmed)
        state.collections.append(c)
        try persist()
        return c
    }

    public func setActive(_ id: UUID) throws {
        lock.lock(); defer { lock.unlock() }
        guard state.collections.contains(where: { $0.id == id }) else { return }
        state.activeCollectionID = id
        try persist()
    }

    public func rename(_ id: UUID, to name: String) throws {
        lock.lock(); defer { lock.unlock() }
        guard let i = state.collections.firstIndex(where: { $0.id == id }) else { return }
        state.collections[i].name = name
        try persist()
    }

    /// Deleting a collection moves its items to `moveTo` (never deletes images).
    public func deleteCollection(_ id: UUID, moveItemsTo: UUID) throws {
        lock.lock(); defer { lock.unlock() }
        guard state.collections.count > 1, id != moveItemsTo, state.collections.contains(where: { $0.id == moveItemsTo }) else { return }
        for i in state.items.indices where state.items[i].collectionID == id { state.items[i].collectionID = moveItemsTo }
        state.collections.removeAll { $0.id == id }
        if state.activeCollectionID == id { state.activeCollectionID = moveItemsTo }
        try persist()
    }

    // MARK: Items

    public func items(in collection: UUID? = nil) -> [LibraryItem] {
        lock.lock(); defer { lock.unlock() }
        return state.items.filter { collection == nil || $0.collectionID == collection }.sorted { $0.captureDate > $1.captureDate }
    }

    public func item(_ id: UUID) -> LibraryItem? { lock.lock(); defer { lock.unlock() }; return state.items.first { $0.id == id } }

    public func masterURL(for item: LibraryItem) -> URL { mastersDirectory.appendingPathComponent(item.fileName) }
    public func thumbnailURL(for item: LibraryItem) -> URL? { item.thumbnailFileName.map { thumbnailsDirectory.appendingPathComponent($0) } }

    /// New captures go to the active collection unless the item already names one.
    public func add(_ item: LibraryItem) throws {
        lock.lock(); defer { lock.unlock() }
        state.items.append(item)
        try persist()
    }

    public func update(_ item: LibraryItem) throws {
        lock.lock(); defer { lock.unlock() }
        guard let i = state.items.firstIndex(where: { $0.id == item.id }) else { return }
        state.items[i] = item
        try persist()
    }

    public func move(_ itemID: UUID, to collection: UUID) throws {
        lock.lock(); defer { lock.unlock() }
        guard let i = state.items.firstIndex(where: { $0.id == itemID }), state.collections.contains(where: { $0.id == collection }) else { return }
        state.items[i].collectionID = collection
        try persist()
    }

    public func delete(_ itemID: UUID) throws {
        lock.lock(); defer { lock.unlock() }
        guard let i = state.items.firstIndex(where: { $0.id == itemID }) else { return }
        let it = state.items[i]
        try? FileManager.default.removeItem(at: mastersDirectory.appendingPathComponent(it.fileName))
        if let t = it.thumbnailFileName { try? FileManager.default.removeItem(at: thumbnailsDirectory.appendingPathComponent(t)) }
        if let k = it.keptSourcesFolder { try? FileManager.default.removeItem(at: keptSourcesDirectory.appendingPathComponent(k)) }
        state.items.remove(at: i)
        try persist()
    }
}
