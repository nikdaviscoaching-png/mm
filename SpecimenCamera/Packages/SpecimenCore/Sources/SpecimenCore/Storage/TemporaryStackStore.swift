import Foundation

/// Working storage for stack projects: one folder per project, `project.json` manifest, `frames/` (captured or
/// imported sources) and `work/` (developed frames, composites, final master before it is moved out).
///
/// Safety rules enforced here:
///  * Manifest writes are atomic (write temp + rename), so a crash never leaves a half-written project.
///  * Sources are only ever deleted through `finalizeSuccess`, which first verifies the final image through a
///    caller-supplied check; any failure leaves the whole project recoverable.
///  * Import copies originals into `frames/`; originals outside the sandbox are never touched.
public final class TemporaryStackStore: @unchecked Sendable {
    public let root: URL
    private let fm = FileManager.default
    private let lock = NSLock()

    public init(root: URL) throws {
        self.root = root
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
    }

    // MARK: Paths

    public func projectDirectory(_ id: UUID) -> URL { root.appendingPathComponent(id.uuidString, isDirectory: true) }
    public func framesDirectory(_ id: UUID) -> URL { projectDirectory(id).appendingPathComponent("frames", isDirectory: true) }
    public func workDirectory(_ id: UUID) -> URL { projectDirectory(id).appendingPathComponent("work", isDirectory: true) }
    func manifestURL(_ id: UUID) -> URL { projectDirectory(id).appendingPathComponent("project.json") }

    public func frameURL(project: StackProject, frame: StackFrame) -> URL {
        framesDirectory(project.id).appendingPathComponent(frame.fileName)
    }

    // MARK: Lifecycle

    @discardableResult
    public func createProject(_ project: StackProject) throws -> StackProject {
        try fm.createDirectory(at: framesDirectory(project.id), withIntermediateDirectories: true)
        try fm.createDirectory(at: workDirectory(project.id), withIntermediateDirectories: true)
        try save(project)
        return project
    }

    public func save(_ project: StackProject) throws {
        lock.lock(); defer { lock.unlock() }
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        enc.dateEncodingStrategy = .secondsSince1970
        let data = try enc.encode(project)
        try fm.createDirectory(at: projectDirectory(project.id), withIntermediateDirectories: true)
        // `.atomic` writes to a temporary file and renames it over the manifest, so a crash can never leave a torn file.
        try data.write(to: manifestURL(project.id), options: .atomic)
    }

    public func load(_ id: UUID) throws -> StackProject {
        let data = try Data(contentsOf: manifestURL(id))
        let dec = JSONDecoder(); dec.dateDecodingStrategy = .secondsSince1970
        return try dec.decode(StackProject.self, from: data)
    }

    /// All projects found on disk (corrupt manifests are skipped, never deleted).
    public func allProjects() -> [StackProject] {
        guard let items = try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) else { return [] }
        return items.compactMap { url -> StackProject? in
            guard let id = UUID(uuidString: url.lastPathComponent) else { return nil }
            return try? load(id)
        }.sorted { $0.createdDate < $1.createdDate }
    }

    /// Projects left behind by a crash, force-quit, interruption or failure: anything not completed.
    public func recoverableProjects() -> [StackProject] {
        allProjects().filter { $0.status != .completed && $0.frameCount > 0 }
    }

    /// Marks projects that were mid-processing when the app died as interrupted (call once at launch).
    public func reconcileAfterLaunch() {
        for var p in allProjects() where p.status == .processing {
            p.status = .interrupted
            p.failureMessage = p.failureMessage ?? "Processing was interrupted."
            try? save(p)
        }
    }

    // MARK: Frames

    /// Reserves a unique file name in `frames/` (the caller writes the file there, e.g. from AVCapturePhoto data).
    public func newFrameFileName(project: StackProject, ext: String, label: String = "frame") -> String {
        let n = project.frameCount + 1
        let tag = String(UUID().uuidString.prefix(6))
        return "\(label)_\(String(format: "%03d", n))_\(tag).\(ext)"
    }

    /// Copies (never moves) a file into the project as a frame. The original is untouched.
    public func importCopy(of source: URL, into project: StackProject, label: String = "import") throws -> StackFrame {
        let name = newFrameFileName(project: project, ext: source.pathExtension.isEmpty ? "dat" : source.pathExtension, label: label)
        let dest = framesDirectory(project.id).appendingPathComponent(name)
        try fm.copyItem(at: source, to: dest)
        var f = StackFrame(fileName: name, kind: FrameFileKind.from(url: source))
        f.byteSize = (try? fm.attributesOfItem(atPath: dest.path)[.size] as? Int64) ?? 0
        return f
    }

    public func removeFrameFile(project: StackProject, frame: StackFrame) {
        try? fm.removeItem(at: frameURL(project: project, frame: frame))
    }

    // MARK: Disk accounting

    public func bytesUsed(by id: UUID) -> Int64 {
        guard let e = fm.enumerator(at: projectDirectory(id), includingPropertiesForKeys: [.fileSizeKey]) else { return 0 }
        var t: Int64 = 0
        for case let u as URL in e { t += Int64((try? u.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) }
        return t
    }

    // MARK: Cleanup

    public enum CleanupResult: Equatable { case sourcesDeleted, sourcesKept, refusedUnverified(String) }

    /// Called only after the final image has been written. `verify` must confirm the final is complete and readable
    /// (exists, non-zero, decodes to the expected size). Only then are sources, developed frames, composites and masks
    /// deleted. With `keepSourceFrames` the sources stay in an organised folder and only intermediates are removed.
    /// Returns the folder holding kept sources, if any.
    @discardableResult
    public func finalizeSuccess(project: StackProject, finalURL: URL, keptSourcesDestination: URL? = nil, verify: (URL) -> Bool) throws -> (CleanupResult, URL?) {
        guard fm.fileExists(atPath: finalURL.path), (try? finalURL.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) ?? 0 > 0 else {
            return (.refusedUnverified("final image missing or empty"), nil)
        }
        guard verify(finalURL) else { return (.refusedUnverified("final image failed verification"), nil) }
        // Never allow the final to live inside the folder we are about to delete.
        guard !finalURL.standardizedFileURL.path.hasPrefix(projectDirectory(project.id).standardizedFileURL.path) else {
            return (.refusedUnverified("final image is still inside the project folder"), nil)
        }
        try? fm.removeItem(at: workDirectory(project.id))
        if project.keepSourceFrames, let dest = keptSourcesDestination {
            try fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
            if fm.fileExists(atPath: dest.path) { try fm.removeItem(at: dest) }
            try fm.moveItem(at: framesDirectory(project.id), to: dest)   // sources are MOVED, not deleted
            try fm.removeItem(at: projectDirectory(project.id))
            return (.sourcesKept, dest)
        }
        if project.keepSourceFrames {
            var p = project; p.status = .completed; p.finalFileName = finalURL.lastPathComponent
            try save(p)
            return (.sourcesKept, framesDirectory(project.id))
        }
        try fm.removeItem(at: projectDirectory(project.id))
        return (.sourcesDeleted, nil)
    }

    /// Explicit user discard (RESUME / DISCARD prompt). Removes everything for the project.
    public func discard(_ id: UUID) {
        try? fm.removeItem(at: projectDirectory(id))
    }
}
