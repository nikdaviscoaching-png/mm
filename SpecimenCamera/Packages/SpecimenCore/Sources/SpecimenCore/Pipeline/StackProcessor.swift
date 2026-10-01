import Foundation

/// Platform hook: decodes/develops a captured or imported file (HEIF, JPEG, TIFF, DNG, ProRAW …) into a 16-bit
/// Display-P3 `.scw` working image. The iOS app implements it with Core Image (CIRAWFilter for RAW); tests use a stub.
public protocol FrameDeveloper: Sendable {
    func develop(source: URL, kind: FrameFileKind, to destination: URL) throws -> (width: Int, height: Int)
}

/// Platform hook: encodes the final working image into the master file and can verify it afterwards.
public protocol FinalEncoder: Sendable {
    func encode(working: URL, to destination: URL, format: FinalFormat, metadata: CompositeMetadata) throws
    /// True only if `final` exists, decodes, and has the expected pixel dimensions.
    func verify(final: URL, expectedWidth: Int, expectedHeight: Int) -> Bool
}

public struct ProcessingServices: Sendable {
    public var developer: any FrameDeveloper
    public var encoder: any FinalEncoder
    /// Evaluated before each heavy stage so thermal changes take effect (fewer workers, same quality).
    public var concurrency: @Sendable () -> Int
    public init(developer: any FrameDeveloper, encoder: any FinalEncoder, concurrency: @escaping @Sendable () -> Int = { 2 }) {
        self.developer = developer; self.encoder = encoder; self.concurrency = concurrency
    }
}

public struct ProcessedStack: Sendable {
    public var projectID: UUID
    public var finalURL: URL
    public var workingFinalURL: URL
    public var width: Int
    public var height: Int
    public var warnings: [String]
    public var lightingBaseIndex: Int?
    public var lightingContribution: [Float]
}

/// Runs a stack project end to end. It writes checkpoints into the project manifest after every expensive step, never
/// deletes sources (that is `TemporaryStackStore.finalizeSuccess`, called by the app once the final is saved), and leaves
/// the project in `.interrupted` with every captured frame intact if anything goes wrong.
public final class StackProcessor: @unchecked Sendable {
    public let store: TemporaryStackStore
    public init(store: TemporaryStackStore) { self.store = store }

    public func process(projectID: UUID, outputDirectory: URL, services: ProcessingServices,
                        progress: ProgressHandler? = nil, isCancelled: @escaping CancelCheck = { false }) throws -> ProcessedStack {
        var project = try store.load(projectID)
        guard project.frameCount > 0 else { throw SpecimenError.insufficientFrames(needed: 1, got: 0) }
        project.status = .processing; project.failureMessage = nil
        try store.save(project)
        do {
            let out = try run(&project, outputDirectory: outputDirectory, services: services, progress: progress, isCancelled: isCancelled)
            return out
        } catch {
            // Reload: `run` may have saved newer checkpoints than our local copy.
            var p = (try? store.load(projectID)) ?? project
            p.status = .interrupted
            p.failureMessage = (error as? SpecimenError) == .cancelled ? "Processing was cancelled." : error.localizedDescription
            try? store.save(p)
            throw error
        }
    }

    // MARK: Steps

    private func run(_ project: inout StackProject, outputDirectory: URL, services: ProcessingServices,
                     progress: ProgressHandler?, isCancelled: @escaping CancelCheck) throws -> ProcessedStack {
        let work = store.workDirectory(project.id)
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        var warnings: [String] = []
        func check() throws { if isCancelled() { throw SpecimenError.cancelled } }
        func report(_ phase: ProcessingPhase, _ cur: Int, _ tot: Int, _ frac: Double) {
            progress?(ProcessingProgress(phase: phase, current: cur, total: tot, fraction: frac))
        }
        func checkpoint(_ step: String) throws {
            if !project.completedSteps.contains(step) { project.completedSteps.append(step) }
            try store.save(project)
        }
        report(.preparing, 0, 0, 0)

        // 1. Develop every source frame into a working image (skip valid ones from an earlier run).
        let all = project.allFrames
        var size: (Int, Int) = (0, 0)
        var expectedSize: (Int, Int)?
        // Every frame must have the same pixel size (and therefore orientation); anything else cannot be aligned or fused.
        func requireSameSize(_ s: (Int, Int), _ name: String) throws {
            guard let e = expectedSize else { expectedSize = s; return }
            if e != s {
                throw SpecimenError.invalidImage("\(name) is \(s.0)×\(s.1) but the other frames are \(e.0)×\(e.1). All frames of a stack must have the same size and orientation.")
            }
        }
        var devURL: [UUID: URL] = [:]
        let needDevelop = project.groups.filter { g in !(g.compositeFileName != nil && project.completedSteps.contains("composite:\(g.id)")) }.flatMap { $0.frames }
        for (i, f) in needDevelop.enumerated() {
            try check()
            let dest = work.appendingPathComponent("dev_\(f.id.uuidString).scw")
            if project.completedSteps.contains("developed:\(f.id)"), let existing = try? ScwFrame(url: dest) {
                size = (existing.width, existing.height)
                try requireSameSize(size, f.fileName)
            } else {
                let src = store.frameURL(project: project, frame: f)
                guard FileManager.default.fileExists(atPath: src.path) else { throw SpecimenError.ioFailure("source frame \(f.fileName) is missing") }
                size = try services.developer.develop(source: src, kind: f.kind, to: dest)
                try requireSameSize(size, f.fileName)
                try checkpoint("developed:\(f.id)")
            }
            devURL[f.id] = dest
            report(.developing, i + 1, needDevelop.count, 0.10 * Double(i + 1) / Double(max(needDevelop.count, 1)))
        }
        _ = all

        // 2. Focus composites (focus + combined). Lighting projects treat each single frame as its own "composite".
        var compositeURL: [UUID: URL] = [:]
        var progressBase = 0.10
        let focusGroups = project.type == .lighting ? 0 : project.groups.count
        let focusShare = project.type == .focus ? 0.70 : (project.type == .combined ? 0.55 : 0)
        for gi in 0..<project.groups.count {
            let g = project.groups[gi]
            let compURL = work.appendingPathComponent("group_\(g.id.uuidString).scw")
            if project.type == .lighting {
                guard let f = g.frames.first, let u = devURL[f.id] else { throw SpecimenError.insufficientFrames(needed: 1, got: 0) }
                compositeURL[g.id] = u
                continue
            }
            if project.completedSteps.contains("composite:\(g.id)"), let existing = try? ScwFrame(url: compURL) {
                size = (existing.width, existing.height)
                try requireSameSize(size, "A finished light-position composite")
                compositeURL[g.id] = compURL
                progressBase += focusShare / Double(max(focusGroups, 1))
                continue
            }
            try check()
            let frames: [any FrameSource] = try g.frames.map { f in
                guard let u = devURL[f.id] else { throw SpecimenError.ioFailure("developed frame missing") }
                return try ScwFrame(url: u)
            }
            let sliceSpan = focusShare / Double(max(focusGroups, 1))
            if frames.count == 1 {
                try copyWorking(from: frames[0], to: compURL, size: size)
            } else {
                var alignments: [FrameAlignment] = []
                var ro = RegistrationOptions(); ro.estimateRotationScale = true
                let alignBase = progressBase
                alignments = try ImageRegistrationEngine.align(frames: frames, options: ro, progress: { cur, tot in
                    progress?(ProcessingProgress(phase: .aligning, current: cur, total: tot, fraction: alignBase + sliceSpan * 0.15 * Double(cur) / Double(max(tot, 1))))
                }, isCancelled: isCancelled)
                let failed = alignments.enumerated().filter { $0.element.failed }.map { $0.offset + 1 }
                if !failed.isEmpty { warnings.append("Alignment was uncertain for frame(s) \(failed.map(String.init).joined(separator: ", ")) in group \(gi + 1); they were used unaligned.") }
                let aligned = ImageRegistrationEngine.aligned(frames, alignments)
                let writer = try ScwWriter(url: compURL, width: frames[0].width, height: frames[0].height, colorSpace: frames[0].colorSpace)
                var fo = FocusStackOptions.preset(project.quality)
                fo.concurrency = services.concurrency()
                _ = try FocusStackEngine.fuse(frames: aligned, sink: writer, options: fo,
                                              progress: ProgressSlice(progress, start: progressBase + sliceSpan * 0.15, span: sliceSpan * 0.85),
                                              isCancelled: isCancelled)
                try writer.finish()
            }
            project.groups[gi].compositeFileName = compURL.lastPathComponent
            try checkpoint("composite:\(g.id)")
            // Developed frames of this group are intermediates (sources stay in frames/): free the disk now.
            for f in g.frames { try? FileManager.default.removeItem(at: work.appendingPathComponent("dev_\(f.id.uuidString).scw")) }
            compositeURL[g.id] = compURL
            progressBase += sliceSpan
        }

        // 3. Lighting fusion, or the single focus composite.
        let finalWorking = work.appendingPathComponent("final.scw")
        var baseIdx: Int? = nil
        var contribution: [Float] = []
        if project.type == .focus {
            guard let g = project.groups.first, let c = compositeURL[g.id] else { throw SpecimenError.insufficientFrames(needed: 1, got: 0) }
            if c != finalWorking {
                try? FileManager.default.removeItem(at: finalWorking)
                try FileManager.default.moveItem(at: c, to: finalWorking)
            }
        } else {
            try check()
            let sources: [any FrameSource] = try project.groups.map { g in
                guard let u = compositeURL[g.id] else { throw SpecimenError.ioFailure("composite for a light position is missing") }
                return try ScwFrame(url: u)
            }
            if sources.count == 1 {
                try copyWorking(from: sources[0], to: finalWorking, size: (sources[0].width, sources[0].height))
            } else {
                var ro = RegistrationOptions(); ro.estimateRotationScale = false      // light moves; camera does not
                let alignBase = progressBase
                let alignments = try ImageRegistrationEngine.align(frames: sources, options: ro, progress: { cur, tot in
                    progress?(ProcessingProgress(phase: .aligning, current: cur, total: tot, fraction: alignBase + 0.05 * Double(cur) / Double(max(tot, 1))))
                }, isCancelled: isCancelled)
                let failed = alignments.enumerated().filter { $0.element.failed }.map { $0.offset + 1 }
                if !failed.isEmpty { warnings.append("Alignment between light positions \(failed.map(String.init).joined(separator: ", ")) was uncertain; they were used unaligned.") }
                let aligned = ImageRegistrationEngine.aligned(sources, alignments)
                let writer = try ScwWriter(url: finalWorking, width: sources[0].width, height: sources[0].height, colorSpace: sources[0].colorSpace)
                var lo = LightingStackOptions.preset(project.quality)
                lo.concurrency = services.concurrency()
                lo.preferredBase = project.preferredLightingBase
                let a = try LightingStackEngine.run(frames: aligned, sink: writer, options: lo,
                                                    progress: ProgressSlice(progress, start: progressBase + 0.05, span: 0.85 - progressBase - 0.05), isCancelled: isCancelled)
                try writer.finish()
                baseIdx = a.baseIndex
                contribution = a.contribution
            }
        }
        try checkpoint("working-final")

        // 4. Encode the master and verify it before anything is considered done.
        try check()
        report(.finalizing, 0, 0, 0.90)
        let wf = try ScwFrame(url: finalWorking)
        try FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)
        let finalURL = outputDirectory.appendingPathComponent("\(project.id.uuidString).\(project.finalFormat.fileExtension)")
        var meta = CompositeMetadata(project: project)
        meta.notes = project.notes
        try services.encoder.encode(working: finalWorking, to: finalURL, format: project.finalFormat, metadata: meta)
        report(.verifying, 0, 0, 0.97)
        guard services.encoder.verify(final: finalURL, expectedWidth: wf.width, expectedHeight: wf.height) else {
            try? FileManager.default.removeItem(at: finalURL)
            throw SpecimenError.storageFailure("the final image could not be verified after writing")
        }
        project.finalFileName = finalURL.lastPathComponent
        // The result now waits for the user (review → SAVE). If the app dies here the project is found at the next launch
        // as "finished, awaiting review" (completedSteps contains "final"), with every source frame intact.
        project.status = .readyToProcess
        try checkpoint("final")
        report(.finalizing, 0, 0, 1)
        return ProcessedStack(projectID: project.id, finalURL: finalURL, workingFinalURL: finalWorking, width: wf.width, height: wf.height,
                              warnings: warnings, lightingBaseIndex: baseIdx, lightingContribution: contribution)
    }

    private func copyWorking(from src: any FrameSource, to dest: URL, size: (Int, Int)) throws {
        let w = try ScwWriter(url: dest, width: src.width, height: src.height, colorSpace: src.colorSpace)
        for t in TileGrid(imageWidth: src.width, imageHeight: src.height, tileSize: 512, halo: 0).tiles {
            try w.write(region: t.core, image: try src.read(region: t.core))
        }
        try w.finish()
    }
}
