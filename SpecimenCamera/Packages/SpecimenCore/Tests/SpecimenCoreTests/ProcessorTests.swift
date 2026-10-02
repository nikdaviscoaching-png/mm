import XCTest
@testable import SpecimenCore
import SpecimenTestKit

/// Sources are `.scw` files; "developing" copies them into the working folder and counts calls.
final class StubDeveloper: FrameDeveloper, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var calls = 0
    var failAfter: Int? = nil
    func develop(source: URL, kind: FrameFileKind, to destination: URL) throws -> (width: Int, height: Int) {
        lock.lock(); calls += 1; let c = calls; lock.unlock()
        if let f = failAfter, c > f { throw SpecimenError.ioFailure("simulated decoder crash") }
        let f = try ScwFrame(url: source)
        let w = try ScwWriter(url: destination, width: f.width, height: f.height, colorSpace: f.colorSpace)
        try w.write(region: f.bounds, image: try f.read(region: f.bounds)); try w.finish()
        return (f.width, f.height)
    }
}

/// Encodes to PNG (via the test kit) so the "master" is a real, decodable file; verifies by parsing the IHDR.
final class StubEncoder: FinalEncoder, @unchecked Sendable {
    var corrupt = false
    private(set) var lastMetadata: CompositeMetadata?
    func encode(working: URL, to destination: URL, format: FinalFormat, metadata: CompositeMetadata) throws {
        let f = try ScwFrame(url: working)
        var data = PNG.encode(try f.read(region: f.bounds))
        if corrupt { data = data.prefix(20) }
        try data.write(to: destination)
        lastMetadata = metadata
    }
    func verify(final: URL, expectedWidth: Int, expectedHeight: Int) -> Bool {
        guard let d = try? Data(contentsOf: final), d.count > 33, Array(d[0..<8]) == [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] else { return false }
        func be(_ o: Int) -> Int { Int(d[o]) << 24 | Int(d[o + 1]) << 16 | Int(d[o + 2]) << 8 | Int(d[o + 3]) }
        return be(16) == expectedWidth && be(20) == expectedHeight && d.count > 100
    }
}

final class ProcessorTests: XCTestCase {
    var dir: URL!
    var store: TemporaryStackStore!
    var out: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("pr-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        store = try TemporaryStackStore(root: dir.appendingPathComponent("Projects"))
        out = dir.appendingPathComponent("Masters")
    }
    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: dir) }

    func services(dev: StubDeveloper = StubDeveloper(), enc: StubEncoder = StubEncoder()) -> ProcessingServices {
        ProcessingServices(developer: dev, encoder: enc, concurrency: { 2 })
    }

    /// Writes frames into a new project: `groups[i]` = images for group i.
    func makeProject(type: StackType, groups: [[RGBImage]], keep: Bool = false, quality: StackQuality = .fast) throws -> StackProject {
        var p = StackProject(type: type); p.quality = quality; p.keepSourceFrames = keep
        try store.createProject(p)
        for (gi, imgs) in groups.enumerated() {
            var g = FocusStackGroup(lightingPosition: type == .focus ? nil : gi)
            for (fi, img) in imgs.enumerated() {
                let name = store.newFrameFileName(project: p, ext: "scw")
                try ScwWriter.save(img, to: store.framesDirectory(p.id).appendingPathComponent(name))
                var f = StackFrame(fileName: name, kind: .scw); f.focusPosition = Float(fi) * 0.1; f.lightingPosition = type == .focus ? nil : gi
                g.frames.append(f)
                p.groups = Array(p.groups.prefix(gi)) + [g]
            }
            if p.groups.count <= gi { p.groups.append(g) }
        }
        p.status = .readyToProcess
        try store.save(p)
        return p
    }

    // MARK: focus

    func testFocusStackEndToEndThenVerifiedCleanup() throws {
        let s = SyntheticFocus.make(width: 256, height: 192, frames: 5, seed: 3, noise: 0.003, breathing: 0)
        let p = try makeProject(type: .focus, groups: [s.frames])
        let enc = StubEncoder()
        let rec = PhaseRecorder()
        let result = try StackProcessor(store: store).process(projectID: p.id, outputDirectory: out, services: services(enc: enc),
                                                              progress: { rec.add($0.phase) })
        let phases = rec.set
        XCTAssertEqual(result.width, 256); XCTAssertEqual(result.height, 192)
        XCTAssertTrue(enc.verify(final: result.finalURL, expectedWidth: 256, expectedHeight: 192))
        XCTAssertTrue(phases.isSuperset(of: [.developing, .aligning, .blending, .finalizing]), "\(phases)")
        XCTAssertEqual(enc.lastMetadata?.compositeType, "Focus Stack")
        XCTAssertEqual(enc.lastMetadata?.focusFrameCount, 5)
        // full resolution, sharper than any single frame
        let working = try ScwFrame(url: result.workingFinalURL).read(region: PixelRect(x: 0, y: 0, width: 256, height: 192))
        XCTAssertGreaterThan(ImageMetrics.psnr(working, s.groundTruth), 26)
        // Sources are still there until cleanup is explicitly requested.
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.framesDirectory(p.id).path))
        let reloaded = try store.load(p.id)
        let (r, _) = try store.finalizeSuccess(project: reloaded, finalURL: result.finalURL, verify: { enc.verify(final: $0, expectedWidth: 256, expectedHeight: 192) })
        XCTAssertEqual(r, .sourcesDeleted)
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.projectDirectory(p.id).path), "ONE final image remains, nothing else")
        XCTAssertTrue(FileManager.default.fileExists(atPath: result.finalURL.path))
        XCTAssertTrue(store.recoverableProjects().isEmpty)
    }

    func testCorruptFinalIsRejectedAndProjectStaysRecoverable() throws {
        let s = SyntheticFocus.make(width: 128, height: 96, frames: 3, seed: 3, noise: 0.003, breathing: 0)
        let p = try makeProject(type: .focus, groups: [s.frames])
        let enc = StubEncoder(); enc.corrupt = true
        XCTAssertThrowsError(try StackProcessor(store: store).process(projectID: p.id, outputDirectory: out, services: services(enc: enc)))
        let after = try store.load(p.id)
        XCTAssertEqual(after.status, .interrupted)
        XCTAssertEqual(after.allFrames.count, 3)
        for f in after.allFrames { XCTAssertTrue(FileManager.default.fileExists(atPath: store.frameURL(project: after, frame: f).path)) }
        XCTAssertEqual(store.recoverableProjects().map { $0.id }, [p.id])
        let leftovers = (try? FileManager.default.contentsOfDirectory(atPath: out.path)) ?? []
        XCTAssertTrue(leftovers.isEmpty, "no half-written master left behind: \(leftovers)")
    }

    func testDecoderCrashLeavesRecoverableProjectAndResumeSkipsDevelopedFrames() throws {
        let s = SyntheticFocus.make(width: 128, height: 96, frames: 4, seed: 4, noise: 0.003, breathing: 0)
        let p = try makeProject(type: .focus, groups: [s.frames])
        let dev1 = StubDeveloper(); dev1.failAfter = 2
        XCTAssertThrowsError(try StackProcessor(store: store).process(projectID: p.id, outputDirectory: out, services: services(dev: dev1)))
        var mid = try store.load(p.id)
        XCTAssertEqual(mid.status, .interrupted)
        XCTAssertEqual(mid.completedSteps.filter { $0.hasPrefix("developed:") }.count, 2)
        XCTAssertEqual(mid.failureMessage?.contains("decoder crash"), true)
        // "app relaunch": status reconciliation then resume
        store.reconcileAfterLaunch()
        XCTAssertEqual(store.recoverableProjects().count, 1)
        let dev2 = StubDeveloper()
        let enc = StubEncoder()
        let result = try StackProcessor(store: store).process(projectID: p.id, outputDirectory: out, services: services(dev: dev2, enc: enc))
        XCTAssertEqual(dev2.calls, 2, "only the two frames that were not developed before the crash")
        XCTAssertTrue(enc.verify(final: result.finalURL, expectedWidth: 128, expectedHeight: 96))
        mid = try store.load(p.id)
        XCTAssertTrue(mid.completedSteps.contains("final"))
    }

    func testCancellationKeepsEverythingAndIsResumable() throws {
        let s = SyntheticFocus.make(width: 128, height: 96, frames: 4, seed: 5, noise: 0.003, breathing: 0)
        let p = try makeProject(type: .focus, groups: [s.frames])
        let flag = CancelFlag()
        let dev = StubDeveloper()
        let svc = services(dev: dev)
        XCTAssertThrowsError(try StackProcessor(store: store).process(projectID: p.id, outputDirectory: out, services: svc,
                                                                    progress: { if $0.phase == .developing && $0.current == 2 { flag.set() } },
                                                                    isCancelled: { flag.value })) { XCTAssertEqual($0 as? SpecimenError, .cancelled) }
        let after = try store.load(p.id)
        XCTAssertEqual(after.status, .interrupted)
        XCTAssertEqual(after.failureMessage, "Processing was cancelled.")
        XCTAssertEqual(after.allFrames.count, 4)
        let r = try StackProcessor(store: store).process(projectID: p.id, outputDirectory: out, services: services())
        XCTAssertEqual(r.width, 128)
    }

    func testMissingSourceFrameIsReportedNotSilentlySkipped() throws {
        let s = SyntheticFocus.make(width: 96, height: 64, frames: 3, seed: 6, noise: 0.003, breathing: 0)
        let p = try makeProject(type: .focus, groups: [s.frames])
        try FileManager.default.removeItem(at: store.frameURL(project: p, frame: p.groups[0].frames[1]))
        XCTAssertThrowsError(try StackProcessor(store: store).process(projectID: p.id, outputDirectory: out, services: services()))
        XCTAssertEqual(try store.load(p.id).status, .interrupted)
    }

    func testFramesOfDifferentSizeAreRejectedWithAClearMessageAndStayRecoverable() throws {
        let a = SyntheticFocus.make(width: 96, height: 64, frames: 2, seed: 6, noise: 0.003, breathing: 0)
        let b = SyntheticFocus.make(width: 80, height: 64, frames: 1, seed: 7, noise: 0.003, breathing: 0)
        let p = try makeProject(type: .focus, groups: [a.frames + b.frames])
        XCTAssertThrowsError(try StackProcessor(store: store).process(projectID: p.id, outputDirectory: out, services: services())) { error in
            let text = error.localizedDescription
            XCTAssertTrue(text.contains("80×64") && text.contains("96×64"), "message should name both sizes: \(text)")
        }
        let after = try store.load(p.id)
        XCTAssertEqual(after.status, .interrupted)
        XCTAssertEqual(after.allFrames.count, 3)            // nothing was deleted
    }

    func testTransposedOrientationFramesAreRejectedInALightingStack() throws {
        // Same pixel count, different orientation: what a phone lying nearly flat can produce if orientation is not pinned.
        let landscape = SyntheticLighting.standardScenario(width: 96, height: 64, seed: 3)
        let portrait = SyntheticLighting.standardScenario(width: 64, height: 96, seed: 3)
        let p = try makeProject(type: .lighting, groups: [[landscape.frames[0]], [portrait.frames[1]]])
        XCTAssertThrowsError(try StackProcessor(store: store).process(projectID: p.id, outputDirectory: out, services: services()))
        XCTAssertEqual(try store.load(p.id).status, .interrupted)
    }

    func testKeepSourceFramesSettingMovesSourcesToLibraryFolder() throws {
        let s = SyntheticFocus.make(width: 96, height: 64, frames: 3, seed: 6, noise: 0.003, breathing: 0)
        let p = try makeProject(type: .focus, groups: [s.frames], keep: true)
        let enc = StubEncoder()
        let r = try StackProcessor(store: store).process(projectID: p.id, outputDirectory: out, services: services(enc: enc))
        let dest = dir.appendingPathComponent("KeptSources/\(p.id.uuidString)")
        let (res, kept) = try store.finalizeSuccess(project: try store.load(p.id), finalURL: r.finalURL, keptSourcesDestination: dest, verify: { enc.verify(final: $0, expectedWidth: 96, expectedHeight: 64) })
        XCTAssertEqual(res, .sourcesKept)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: kept!.path).count, 3)
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.projectDirectory(p.id).path))
    }

    // MARK: lighting

    func testLightingStackEndToEnd() throws {
        let s = SyntheticLighting.standardScenario(width: 256, height: 192)
        let p = try makeProject(type: .lighting, groups: s.frames.map { [$0] })
        let enc = StubEncoder()
        let r = try StackProcessor(store: store).process(projectID: p.id, outputDirectory: out, services: services(enc: enc))
        XCTAssertNotNil(r.lightingBaseIndex)
        XCTAssertEqual(r.lightingContribution.count, 4)
        let working = try ScwFrame(url: r.workingFinalURL).read(region: PixelRect(x: 0, y: 0, width: 256, height: 192))
        let core = PixelRect(x: 65, y: 45, width: 25, height: 30)           // frame 0's glare area at half size
        XCTAssertLessThan(ImageMetrics.meanLuma(working, in: core), 0.7)
        XCTAssertEqual(enc.lastMetadata?.lightingPositionCount, 4)
        XCTAssertEqual(enc.lastMetadata?.compositeType, "Lighting Stack")
    }

    func testPreferredLightingBaseIsHonoured() throws {
        let s = SyntheticLighting.standardScenario(width: 192, height: 144)
        var p = try makeProject(type: .lighting, groups: s.frames.map { [$0] })
        p.preferredLightingBase = 3; try store.save(p)
        let r = try StackProcessor(store: store).process(projectID: p.id, outputDirectory: out, services: services())
        XCTAssertEqual(r.lightingBaseIndex, 3)
    }

    // MARK: combined — 4 focus planes × 3 light positions

    func testCombinedStackIsHierarchicalAndProducesOneFinal() throws {
        let W = 256, H = 192
        let focus = SyntheticFocus.make(width: W, height: H, frames: 4, seed: 9, noise: 0.002, breathing: 0)
        let blobs = [GlareBlob(cx: 0.25, cy: 0.30, sigma: 0.07, amplitude: 3.5), GlareBlob(cx: 0.70, cy: 0.35, sigma: 0.07, amplitude: 3.5), GlareBlob(cx: 0.45, cy: 0.80, sigma: 0.07, amplitude: 3.5)]
        // each light position: every focus frame gets that position's glare
        let groups: [[RGBImage]] = blobs.map { blob in
            focus.frames.map { fr in
                var lin = ColorMath.toLinear(fr)
                for y in 0..<H { for x in 0..<W {
                    let dx = Float(x) - blob.cx * Float(W), dy = Float(y) - blob.cy * Float(H), s = blob.sigma * Float(W)
                    let a = blob.amplitude * expf(-(dx * dx + dy * dy) / (2 * s * s))
                    lin.r[x, y] += a; lin.g[x, y] += a; lin.b[x, y] += a
                }}
                return ColorMath.toEncoded(lin).mapped { min(max($0, 0), 1) }
            }
        }
        let p = try makeProject(type: .combined, groups: groups)
        let enc = StubEncoder()
        let r = try StackProcessor(store: store).process(projectID: p.id, outputDirectory: out, services: services(enc: enc))
        // fully focused AND glare-free: close to the all-in-focus ground truth, far better than any source frame
        let working = try ScwFrame(url: r.workingFinalURL).read(region: PixelRect(x: 0, y: 0, width: W, height: H))
        let psnr = ImageMetrics.psnr(working, focus.groundTruth)
        let bestSource = groups.flatMap { $0 }.map { ImageMetrics.psnr($0, focus.groundTruth) }.max()!
        XCTAssertGreaterThan(psnr, 23, "combined PSNR \(psnr)")   // 4 planes, fast preset, 3 light positions
        XCTAssertGreaterThan(psnr, bestSource + 5)
        XCTAssertEqual(enc.lastMetadata?.sourceFrameCount, 12)
        XCTAssertEqual(enc.lastMetadata?.focusFrameCount, 4)
        XCTAssertEqual(enc.lastMetadata?.lightingPositionCount, 3)
        // hierarchy: all focus work (aligning/blending per group) happens before the lighting analysis
        let reloaded = try store.load(p.id)
        XCTAssertEqual(reloaded.completedSteps.filter { $0.hasPrefix("composite:") }.count, 3)
        // cleanup removes 12 sources and 3 intermediates
        let (res, _) = try store.finalizeSuccess(project: reloaded, finalURL: r.finalURL, verify: { enc.verify(final: $0, expectedWidth: W, expectedHeight: H) })
        XCTAssertEqual(res, .sourcesDeleted)
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.projectDirectory(p.id).path))
    }

    func testTileRunnerHonoursLiveConcurrencyLimitAndPause() throws {
        let tiles = TileGrid(imageWidth: 640, imageHeight: 64, tileSize: 64, halo: 0).tiles     // 10 tiles
        let active = ManagedCounter(), allowed = ManagedCounter(start: 1)
        let started = Date()
        // 1 worker allowed; pause (0) for the first 0.4 s, then one worker: must still finish all tiles, never 2 at once.
        try TileRunner.run(tiles: tiles, concurrency: 4, concurrencyProvider: { Date().timeIntervalSince(started) < 0.4 ? 0 : allowed.value }) { _ in
            active.add(1); active.noteMax(); Thread.sleep(forTimeInterval: 0.01); active.add(-1)
        }
        XCTAssertEqual(active.maxSeen, 1)
        XCTAssertGreaterThan(Date().timeIntervalSince(started), 0.35)      // it really waited while paused
    }
}

final class CancelFlag: @unchecked Sendable {
    private let lock = NSLock(); private var v = false
    func set() { lock.lock(); v = true; lock.unlock() }
    var value: Bool { lock.lock(); defer { lock.unlock() }; return v }
}

final class PhaseRecorder: @unchecked Sendable {
    private let lock = NSLock(); private var s = Set<ProcessingPhase>()
    func add(_ p: ProcessingPhase) { lock.lock(); s.insert(p); lock.unlock() }
    var set: Set<ProcessingPhase> { lock.lock(); defer { lock.unlock() }; return s }
}

final class ManagedCounter: @unchecked Sendable {
    private let lock = NSLock(); private var v: Int; private(set) var maxSeen = 0
    init(start: Int = 0) { v = start }
    var value: Int { lock.lock(); defer { lock.unlock() }; return v }
    func add(_ d: Int) { lock.lock(); v += d; lock.unlock() }
    func noteMax() { lock.lock(); maxSeen = max(maxSeen, v); lock.unlock() }
}
