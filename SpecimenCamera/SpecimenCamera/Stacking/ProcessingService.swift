import Foundation
import UIKit
import SpecimenCore

struct ReviewState: Identifiable {
    var id: UUID { project.id }
    var project: StackProject
    var processed: ProcessedStack
}

final class AtomicFlag: @unchecked Sendable {
    private let lock = NSLock(); private var v = false
    func set(_ x: Bool) { lock.lock(); v = x; lock.unlock() }
    var value: Bool { lock.lock(); defer { lock.unlock() }; return v }
}

/// Runs stack processing off the main thread, keeps the screen awake, throttles by thermal state (never quality), and owns the
/// SAVE / REPROCESS / DISCARD / RECOVER operations. Sources are deleted only inside `save`, after the final is verified and saved.
@MainActor
final class ProcessingService: ObservableObject {
    let store: TemporaryStackStore
    let library: LibraryService
    @Published private(set) var progress: ProcessingProgress?
    @Published private(set) var isProcessing = false
    @Published private(set) var startedAt = Date()
    @Published var review: ReviewState?
    @Published var errorMessage: String?
    @Published private(set) var warnings: [String] = []
    @Published private(set) var recoverable: [StackProject] = []

    private let cancelFlag = AtomicFlag()
    private let encoder = FinalImageEncoder()

    init(library: LibraryService) throws {
        self.library = library
        store = try TemporaryStackStore(root: AppPaths.projects)
        store.reconcileAfterLaunch()
        refreshRecoverable()
    }

    func refreshRecoverable() { recoverable = store.recoverableProjects() }

    // MARK: Processing

    func process(projectID: UUID) async {
        guard !isProcessing else { return }
        isProcessing = true; errorMessage = nil; warnings = []; startedAt = Date()
        cancelFlag.set(false)
        progress = ProcessingProgress(phase: .preparing)
        ScreenAwake.hold("processing")
        var bg: UIBackgroundTaskIdentifier = .invalid
        // iOS gives only a short grace period in the background. When it ends, stop cleanly at the next checkpoint (the project
        // stays recoverable) and hand the task back — an unreturned background task gets the app terminated.
        let stopFlag = cancelFlag
        bg = UIApplication.shared.beginBackgroundTask(withName: "stack-processing") {
            stopFlag.set(true)
            if bg != .invalid { UIApplication.shared.endBackgroundTask(bg); bg = .invalid }
        }
        defer {
            if bg != .invalid { UIApplication.shared.endBackgroundTask(bg) }
            ScreenAwake.release("processing")
            isProcessing = false
            refreshRecoverable()
        }
        let store = self.store, flag = cancelFlag, staging = AppPaths.staging
        let services = ProcessingServices(developer: WorkingImageDeveloper(), encoder: encoder, concurrency: { DeviceStatus.currentConcurrency() })
        let handler: ProgressHandler = { [weak self] p in Task { @MainActor in self?.progress = p } }
        Log.processing.info("stack processing started")
        do {
            let result = try await Task.detached(priority: .utility) {
                try StackProcessor(store: store).process(projectID: projectID, outputDirectory: staging, services: services, progress: handler, isCancelled: { flag.value })
            }.value
            let project = try store.load(projectID)
            warnings = result.warnings
            review = ReviewState(project: project, processed: result)
            Log.processing.info("composite completed \(result.width)x\(result.height)")
        } catch let e as SpecimenError where e == .cancelled {
            errorMessage = "Processing was cancelled. Your frames are kept — you can resume from the recovery list."
        } catch {
            errorMessage = error.localizedDescription
            Log.processing.error("processing failed: \(error.localizedDescription, privacy: .public)")
        }
        progress = nil
    }

    func cancel() { cancelFlag.set(true) }

    /// Recovery: a project whose result is already built goes straight to review; otherwise processing resumes where it stopped.
    func resume(_ project: StackProject) async {
        if project.completedSteps.contains("final"), let name = project.finalFileName {
            let url = AppPaths.staging.appendingPathComponent(name)
            if let size = ThumbnailService.pixelSize(of: url), FileManager.default.fileExists(atPath: url.path) {
                let processed = ProcessedStack(projectID: project.id, finalURL: url, workingFinalURL: store.workDirectory(project.id).appendingPathComponent("final.scw"),
                                               width: size.0, height: size.1, warnings: [], lightingBaseIndex: nil, lightingContribution: [])
                review = ReviewState(project: project, processed: processed)
                return
            }
        }
        await process(projectID: project.id)
    }

    // MARK: Review actions

    /// REPROCESS: rebuilds from the untouched source frames with different settings.
    func reprocess(_ r: ReviewState, quality: StackQuality, lightingBase: Int?) async {
        var p = (try? store.load(r.project.id)) ?? r.project
        try? FileManager.default.removeItem(at: r.processed.finalURL)
        try? FileManager.default.removeItem(at: store.workDirectory(p.id))
        try? FileManager.default.createDirectory(at: store.workDirectory(p.id), withIntermediateDirectories: true)
        p.completedSteps = []; p.finalFileName = nil
        for i in p.groups.indices { p.groups[i].compositeFileName = nil }
        p.quality = quality; p.preferredLightingBase = lightingBase
        try? store.save(p)
        review = nil
        await process(projectID: p.id)
    }

    /// DISCARD the result. Either everything goes, or the frames stay recoverable for later.
    func discard(_ r: ReviewState, deleteEverything: Bool) {
        try? FileManager.default.removeItem(at: r.processed.finalURL)
        if deleteEverything {
            store.discard(r.project.id)
        } else if var p = try? store.load(r.project.id) {
            try? FileManager.default.removeItem(at: store.workDirectory(p.id))
            p.completedSteps = []; p.finalFileName = nil; p.status = .interrupted; p.failureMessage = "Result discarded; frames kept."
            try? store.save(p)
        }
        review = nil
        refreshRecoverable()
    }

    func discardProject(_ id: UUID) { store.discard(id); refreshRecoverable() }

    /// SAVE: moves the master into the library and/or Photos, and only then — with the master verified — deletes the sources
    /// (or moves them to the kept-sources folder when KEEP STACK SOURCE FRAMES is on).
    @discardableResult
    func save(_ r: ReviewState, scale: ScaleMetadata? = nil) async -> Bool {
        let project = (try? store.load(r.project.id)) ?? r.project
        let dest = project.saveDestination
        var master = r.processed.finalURL
        let enc = encoder
        let w = r.processed.width, h = r.processed.height
        do {
            progress = ProcessingProgress(phase: .finalizing)
            var meta = CompositeMetadata(project: project)
            meta.scale = scale
            var keptName: String?
            if dest != .photos {
                // Idempotent: a retry after a later failure must neither fail on the already-moved file nor duplicate the entry.
                let target = library.store.mastersDirectory.appendingPathComponent(master.lastPathComponent)
                if FileManager.default.fileExists(atPath: master.path), master != target {
                    if FileManager.default.fileExists(atPath: target.path) { try FileManager.default.removeItem(at: target) }
                    try FileManager.default.moveItem(at: master, to: target)
                }
                master = target
                if project.keepSourceFrames { keptName = project.id.uuidString }
                if library.store.item(project.id) == nil {
                    try library.addStack(master: master, project: project, metadata: meta, width: w, height: h, keptSourcesFolder: keptName, scale: scale)
                }
            }
            if dest != .appLibrary {
                try await PhotosSaver.save(fileURL: master, creationDate: meta.originalCaptureDate)
            }
            progress = ProcessingProgress(phase: .cleaning)
            let keptDest = library.store.keptSourcesDirectory.appendingPathComponent(project.id.uuidString)
            let (result, _) = try store.finalizeSuccess(project: project, finalURL: master, keptSourcesDestination: keptName == nil ? nil : keptDest,
                                                       verify: { enc.verify(final: $0, expectedWidth: w, expectedHeight: h) })
            if case .refusedUnverified(let why) = result { throw SpecimenError.storageFailure(why) }
            if dest == .photos { try? FileManager.default.removeItem(at: master) }
            Log.storage.info("final saved; temporary project cleaned (\(String(describing: result), privacy: .public))")
            review = nil
            progress = nil
            refreshRecoverable()
            return true
        } catch {
            progress = nil
            errorMessage = "Saving failed: \(error.localizedDescription). Your frames and result are kept."
            Log.storage.error("save failed: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }
}
