import XCTest
@testable import SpecimenCore

final class StorageTests: XCTestCase {
    var dir: URL!
    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("st-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: dir) }

    func makeProject(_ store: TemporaryStackStore, frames n: Int = 3) throws -> StackProject {
        var p = StackProject(type: .focus)
        var g = FocusStackGroup()
        for i in 0..<n {
            let name = store.newFrameFileName(project: p, ext: "heic")
            var f = StackFrame(fileName: name, kind: .heif); f.focusPosition = Float(i) * 0.1
            g.frames.append(f)
            p.groups = [g]
        }
        try store.createProject(p)
        for f in g.frames { try Data(repeating: 9, count: 100).write(to: store.frameURL(project: p, frame: f)) }
        return p
    }

    func testManifestRoundTripAndAtomicSave() throws {
        let store = try TemporaryStackStore(root: dir.appendingPathComponent("p"))
        var p = try makeProject(store)
        p.notes = "Kentucky agate"; p.completedSteps = ["developed:x"]
        try store.save(p)
        let back = try store.load(p.id)
        XCTAssertEqual(back.id, p.id); XCTAssertEqual(back.notes, "Kentucky agate"); XCTAssertEqual(back.completedSteps, ["developed:x"])
        XCTAssertEqual(back.groups[0].frames.map { $0.fileName }, p.groups[0].frames.map { $0.fileName })
        XCTAssertEqual(back.groups[0].frames.map { $0.focusPosition }, p.groups[0].frames.map { $0.focusPosition })
        XCTAssertEqual(back.createdDate.timeIntervalSince1970, p.createdDate.timeIntervalSince1970, accuracy: 0.001)
    }

    func testRecoveryListsIncompleteProjectsAndReconcilesProcessing() throws {
        let store = try TemporaryStackStore(root: dir.appendingPathComponent("p"))
        var a = try makeProject(store); a.status = .processing; try store.save(a)
        var b = try makeProject(store); b.status = .completed; try store.save(b)
        let empty = StackProject(type: .focus); try store.createProject(empty)     // nothing captured: nothing to recover
        store.reconcileAfterLaunch()
        let rec = store.recoverableProjects()
        XCTAssertEqual(rec.map { $0.id }, [a.id])
        XCTAssertEqual(rec.first?.status, .interrupted)
    }

    func testCorruptManifestIsSkippedNotDeleted() throws {
        let store = try TemporaryStackStore(root: dir.appendingPathComponent("p"))
        let p = try makeProject(store)
        try Data("not json".utf8).write(to: store.projectDirectory(p.id).appendingPathComponent("project.json"))
        XCTAssertTrue(store.allProjects().isEmpty)
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.framesDirectory(p.id).path), "frames must survive a corrupt manifest")
    }

    func testImportCopiesAndNeverTouchesTheOriginal() throws {
        let store = try TemporaryStackStore(root: dir.appendingPathComponent("p"))
        var p = StackProject(type: .focus); try store.createProject(p)
        let original = dir.appendingPathComponent("IMG_0001.DNG")
        let bytes = Data((0..<4096).map { UInt8($0 & 255) })
        try bytes.write(to: original)
        let attrsBefore = try FileManager.default.attributesOfItem(atPath: original.path)
        let f = try store.importCopy(of: original, into: p)
        XCTAssertEqual(f.kind, .dng)
        p.groups = [FocusStackGroup()]; p.groups[0].frames = [f]; try store.save(p)
        XCTAssertEqual(try Data(contentsOf: original), bytes)
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: original.path)[.modificationDate] as? Date, attrsBefore[.modificationDate] as? Date)
        // deleting the whole project (success or discard) leaves the original in place
        _ = try store.finalizeSuccess(project: p, finalURL: try makeFinal(), verify: { _ in true })
        XCTAssertTrue(FileManager.default.fileExists(atPath: original.path))
        XCTAssertEqual(try Data(contentsOf: original), bytes)
    }

    func makeFinal() throws -> URL {
        let u = dir.appendingPathComponent("final-\(UUID().uuidString).jpg"); try Data(repeating: 1, count: 500).write(to: u); return u
    }

    func testSourcesDeletedOnlyAfterVerifiedSuccess() throws {
        let store = try TemporaryStackStore(root: dir.appendingPathComponent("p"))
        let p = try makeProject(store)
        try Data(repeating: 2, count: 10).write(to: store.workDirectory(p.id).appendingPathComponent("dev.scw"))
        let final = try makeFinal()
        // verification fails → everything stays
        var (r, _) = try store.finalizeSuccess(project: p, finalURL: final, verify: { _ in false })
        XCTAssertEqual(r, .refusedUnverified("final image failed verification"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.framesDirectory(p.id).path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.workDirectory(p.id).path))
        // missing final → refused
        (r, _) = try store.finalizeSuccess(project: p, finalURL: dir.appendingPathComponent("nope.jpg"), verify: { _ in true })
        XCTAssertEqual(r, .refusedUnverified("final image missing or empty"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.framesDirectory(p.id).path))
        // final inside the project folder → refused (it would be deleted with it)
        let inside = store.projectDirectory(p.id).appendingPathComponent("final.jpg"); try Data(repeating: 1, count: 10).write(to: inside)
        (r, _) = try store.finalizeSuccess(project: p, finalURL: inside, verify: { _ in true })
        XCTAssertEqual(r, .refusedUnverified("final image is still inside the project folder"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.framesDirectory(p.id).path))
        // verified → all gone, final stays
        (r, _) = try store.finalizeSuccess(project: p, finalURL: final, verify: { _ in true })
        XCTAssertEqual(r, .sourcesDeleted)
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.projectDirectory(p.id).path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: final.path))
    }

    func testKeepSourcesMovesFramesToOrganisedFolderAndDropsIntermediates() throws {
        let store = try TemporaryStackStore(root: dir.appendingPathComponent("p"))
        var p = try makeProject(store); p.keepSourceFrames = true; try store.save(p)
        try Data(repeating: 2, count: 10).write(to: store.workDirectory(p.id).appendingPathComponent("dev.scw"))
        let dest = dir.appendingPathComponent("Kept/proj1")
        let (r, kept) = try store.finalizeSuccess(project: p, finalURL: try makeFinal(), keptSourcesDestination: dest, verify: { _ in true })
        XCTAssertEqual(r, .sourcesKept)
        XCTAssertEqual(kept, dest)
        let names = try FileManager.default.contentsOfDirectory(atPath: dest.path)
        XCTAssertEqual(names.count, 3)
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.projectDirectory(p.id).path))
    }

    // MARK: collections / library

    func testCollectionsActiveAndItemsAndPersistence() throws {
        let root = dir.appendingPathComponent("lib")
        var store: CollectionStore? = try CollectionStore(root: root)
        XCTAssertEqual(store!.collections.count, 1)
        let ebay = try store!.createCollection(named: "eBay Queue")
        let ky = try store!.createCollection(named: "Kentucky Agate")
        XCTAssertEqual(try store!.createCollection(named: "ebay queue").id, ebay.id, "duplicate names reuse the collection")
        try store!.setActive(ebay.id)
        var item = LibraryItem(collectionID: store!.activeCollection.id, kind: .single, captureDate: Date(), fileName: "a.jpg", width: 4000, height: 3000, finalFormat: .jpeg)
        item.notes = "geode"
        try store!.add(item)
        XCTAssertEqual(store!.items(in: ebay.id).count, 1)
        XCTAssertEqual(store!.items(in: ky.id).count, 0)
        try store!.move(item.id, to: ky.id)
        XCTAssertEqual(store!.items(in: ky.id).count, 1)
        store = nil
        let again = try CollectionStore(root: root)                       // persisted
        XCTAssertEqual(again.collections.count, 3)
        XCTAssertEqual(again.activeCollection.id, ebay.id)
        XCTAssertEqual(again.items(in: ky.id).first?.notes, "geode")
        // deleting a collection never deletes images
        try again.deleteCollection(ky.id, moveItemsTo: ebay.id)
        XCTAssertEqual(again.items(in: ebay.id).count, 1)
        // deleting an item removes its master
        try Data(repeating: 1, count: 10).write(to: again.mastersDirectory.appendingPathComponent("a.jpg"))
        try again.delete(item.id)
        XCTAssertFalse(FileManager.default.fileExists(atPath: again.mastersDirectory.appendingPathComponent("a.jpg").path))
    }

    func testCannotDeleteLastCollection() throws {
        let store = try CollectionStore(root: dir.appendingPathComponent("lib"))
        let only = store.collections[0]
        try store.deleteCollection(only.id, moveItemsTo: only.id)
        XCTAssertEqual(store.collections.count, 1)
    }
}
