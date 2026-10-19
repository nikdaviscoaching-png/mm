import XCTest
@testable import SpecimenCore

final class MockCamera: CameraDriving, @unchecked Sendable {
    private let lock = NSLock()
    private var _log: [String] = [], _lensPositions: [Float] = [], _lockPlans: [LockPlan] = []
    private var _unlockCount = 0, captures = 0
    var failCaptureAt: Int? = nil            // 1-based capture number that throws
    var reportedISO: Float? = 64
    var reportedShutter: Double? = 1.0 / 60
    var log: [String] { lock.lock(); defer { lock.unlock() }; return _log }
    var lensPositions: [Float] { lock.lock(); defer { lock.unlock() }; return _lensPositions }
    var lockPlans: [LockPlan] { lock.lock(); defer { lock.unlock() }; return _lockPlans }
    var unlockCount: Int { lock.lock(); defer { lock.unlock() }; return _unlockCount }

    // Synchronous helpers keep NSLock out of async function bodies.
    private func recordLock(_ p: LockPlan) { lock.lock(); _lockPlans.append(p); _log.append("lock"); lock.unlock() }
    private func recordUnlock() { lock.lock(); _unlockCount += 1; _log.append("unlock"); lock.unlock() }
    private func recordFocus(_ p: Float) { lock.lock(); _lensPositions.append(p); _log.append("focus:\(p)"); lock.unlock() }
    private func recordCapture() -> (n: Int, fail: Int?) { lock.lock(); captures += 1; _log.append("capture"); defer { lock.unlock() }; return (captures, failCaptureAt) }

    func lockForStack(_ plan: LockPlan) async throws { recordLock(plan) }
    func unlockAfterStack() async { recordUnlock() }
    func setLensPosition(_ position: Float) async throws { recordFocus(position) }
    func capturePhoto(format: CaptureFormat, into directory: URL, fileName: String) async throws -> CapturedFrameInfo {
        let (n, fail) = recordCapture()
        if fail == n { throw CaptureFailure.interrupted("phone call") }
        try Data(repeating: UInt8(n & 255), count: 64).write(to: directory.appendingPathComponent(fileName))
        return CapturedFrameInfo(fileName: fileName, kind: format == .raw || format == .proRAW ? .dng : .heif, byteSize: 64, iso: reportedISO, shutterSeconds: reportedShutter)
    }
}

final class EventBox: @unchecked Sendable {
    private let lock = NSLock(); private var e: [CaptureEvent] = []
    func add(_ x: CaptureEvent) { lock.lock(); e.append(x); lock.unlock() }
    var all: [CaptureEvent] { lock.lock(); defer { lock.unlock() }; return e }
}

final class CameraLogicTests: XCTestCase {
    var dir: URL!
    var store: TemporaryStackStore!
    let lens = LensInfo(id: "wide", kind: .wide, name: "Main 24 mm", equivalentFocalLengthMM: 24, fNumber: 1.78, minimumFocusDistanceMM: 120, supportsRAW: true, supportsProRAW: true)

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("cl-\(UUID().uuidString)")
        store = try TemporaryStackStore(root: dir)
    }
    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: dir) }

    func setup(_ type: StackType, count: Int = 5, auto: Bool = false) -> StackSetup {
        var s = CameraSettings(lensID: lens.id)
        s.exposureMode = auto ? .auto : .manual; s.iso = 64; s.shutterSeconds = 1.0 / 60
        s.whiteBalanceMode = auto ? .auto : .manualKelvin; s.kelvin = 5200
        s.focusMode = auto ? .autofocus : .manual; s.lensPosition = 0.22; s.format = .maximumQuality
        var st = StackSetup(type: type, configuration: CaptureConfiguration(), settings: s, lens: lens)
        if type != .lighting {
            st.nearFocus = 0.10; st.farFocus = 0.50
            st.focusPlan = FocusStepPlanner.plan(near: 0.10, far: 0.50, model: lens.focusModel, optics: lens.optics, manualCount: count)
        }
        return st
    }

    func coordinator(_ cam: MockCamera) -> (StackCaptureCoordinator, EventBox, Task<Void, Never>) {
        let c = StackCaptureCoordinator(store: store, camera: cam, settleSeconds: 0.35, sleep: { _ in })
        let box = EventBox()
        let t = Task { for await e in c.events { box.add(e) } }
        return (c, box, t)
    }

    // acceptance #8
    func testFiveFrameFocusStackCapturesAutomaticallyWithOnlyFocusChanging() async throws {
        let cam = MockCamera()
        let (c, box, t) = coordinator(cam)
        let p = try await c.begin(setup(.focus))
        XCTAssertEqual(cam.lockPlans.count, 1)
        XCTAssertEqual(cam.lockPlans[0].iso, 64); XCTAssertEqual(cam.lockPlans[0].whiteBalanceKelvin, 5200)
        XCTAssertNil(cam.lockPlans[0].pinnedLensPosition, "focus stacks leave focus free")
        try await c.captureFocusSeries()
        let snap = await c.snapshot()!
        XCTAssertEqual(snap.groups[0].frames.count, 5)
        XCTAssertEqual(cam.lensPositions, snap.groups[0].frames.map { $0.focusPosition! })
        XCTAssertEqual(cam.lensPositions.first, 0.10); XCTAssertEqual(cam.lensPositions.last, 0.50)
        // the only camera calls are lock, then (focus, capture) × 5
        XCTAssertEqual(cam.log.filter { $0.hasPrefix("focus") }.count, 5)
        XCTAssertEqual(cam.log.first, "lock")
        for f in snap.groups[0].frames { XCTAssertTrue(FileManager.default.fileExists(atPath: store.frameURL(project: snap, frame: f).path)) }
        XCTAssertEqual(try store.load(p.id).frameCount, 5, "manifest persisted")
        let done = try await c.finish()
        XCTAssertEqual(done.status, .readyToProcess)
        XCTAssertEqual(cam.unlockCount, 1)
        try await Task.sleep(nanoseconds: 50_000_000)
        t.cancel()
        let ev = box.all
        XCTAssertTrue(ev.contains(.focusFrameCaptured(index: 3, of: 5, lightPosition: nil)))
        XCTAssertEqual(ev.last, .finished(frameCount: 5))
    }

    func testAutoSettingsAreFrozenAndReported() async throws {
        let cam = MockCamera()
        let (c, _, t) = coordinator(cam)
        var s = setup(.focus, auto: true); s.settings.iso = 125; s.settings.shutterSeconds = 1.0 / 30; s.settings.kelvin = 4800
        _ = try await c.begin(s)
        let plan = cam.lockPlans[0]
        XCTAssertEqual(plan.iso, 125); XCTAssertEqual(plan.shutterSeconds, 1.0 / 30, accuracy: 1e-9); XCTAssertEqual(plan.whiteBalanceKelvin, 4800)
        XCTAssertEqual(plan.frozenAutoSettings.count, 2)
        XCTAssertTrue(plan.disableAutoLensSwitching); XCTAssertTrue(plan.disableContinuousAutofocus)
        t.cancel()
    }

    // acceptance #11
    func testLightingStackCapturesFourPositionsWithEverythingLocked() async throws {
        let cam = MockCamera()
        let (c, box, t) = coordinator(cam)
        _ = try await c.begin(setup(.lighting))
        XCTAssertEqual(cam.lockPlans[0].pinnedLensPosition, 0.22)
        for _ in 0..<4 { try await c.captureLightingFrame() }
        let snap = await c.snapshot()!
        XCTAssertEqual(snap.groups.count, 4)
        XCTAssertEqual(snap.groups.map { $0.lightingPosition }, [0, 1, 2, 3])
        XCTAssertTrue(snap.groups.allSatisfy { $0.frames.count == 1 })
        XCTAssertTrue(cam.lensPositions.isEmpty, "lighting stacks never touch focus")
        XCTAssertEqual(snap.configuration.iso, 64); XCTAssertEqual(snap.configuration.whiteBalanceKelvin, 5200)
        XCTAssertTrue(snap.allFrames.allSatisfy { $0.iso == 64 && $0.shutterSeconds == 1.0 / 60 })
        _ = try await c.finish()
        try await Task.sleep(nanoseconds: 50_000_000); t.cancel()
        XCTAssertTrue(box.all.contains(.lightingFrameCaptured(position: 4)))
    }

    // acceptance #14
    func testCombinedStackTracksFramesPerLightPosition() async throws {
        let cam = MockCamera()
        let (c, box, t) = coordinator(cam)
        _ = try await c.begin(setup(.combined, count: 4))
        for _ in 0..<3 { try await c.captureFocusSeries() }
        let snap = await c.snapshot()!
        XCTAssertEqual(snap.groups.count, 3)
        XCTAssertEqual(snap.groups.map { $0.frames.count }, [4, 4, 4])
        XCTAssertEqual(snap.groups.map { $0.lightingPosition }, [0, 1, 2])
        for g in snap.groups { XCTAssertEqual(g.frames.map { $0.focusPosition }, snap.groups[0].frames.map { $0.focusPosition }) }
        XCTAssertEqual(snap.groups.flatMap { $0.frames }.map { $0.lightingPosition }, [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2])
        let done = try await c.finish()
        XCTAssertEqual(done.frameCount, 12)
        try await Task.sleep(nanoseconds: 50_000_000); t.cancel()
        XCTAssertEqual(box.all.filter { if case .lightPositionComplete = $0 { return true } else { return false } }.count, 3)
    }

    // acceptance #16 (capture side) — interruptions keep everything captured so far
    func testInterruptionMidSeriesKeepsFramesAndResumesWhereItStopped() async throws {
        let cam = MockCamera(); cam.failCaptureAt = 3
        let (c, _, t) = coordinator(cam)
        let p = try await c.begin(setup(.focus))
        do { try await c.captureFocusSeries(); XCTFail("should have been interrupted") } catch {}
        var st = await c.state
        XCTAssertEqual(st, .interrupted("phone call"))
        XCTAssertEqual(try store.load(p.id).frameCount, 2)
        cam.failCaptureAt = nil
        await c.resume()
        try await c.captureFocusSeries()
        let snap = await c.snapshot()!
        XCTAssertEqual(snap.groups[0].frames.count, 5)
        XCTAssertEqual(snap.groups[0].frames.map { $0.focusPosition! }, snap.groups[0].frames.map { $0.focusPosition! }.sorted())
        XCTAssertEqual(Set(snap.groups[0].frames.map { $0.fileName }).count, 5, "no duplicate frames")
        st = await c.state; XCTAssertEqual(st, .ready)
        t.cancel()
    }

    func testBackgroundingStyleInterruptViaCoordinatorKeepsData() async throws {
        let cam = MockCamera()
        let (c, _, t) = coordinator(cam)
        _ = try await c.begin(setup(.lighting))
        try await c.captureLightingFrame(); try await c.captureLightingFrame()
        await c.interrupt(reason: "app moved to background")
        let st = await c.state
        XCTAssertEqual(st, .interrupted("app moved to background"))
        let g2 = await c.snapshot(); XCTAssertEqual(g2?.groups.count, 2)
        await c.resume()
        try await c.captureLightingFrame()
        let g3 = await c.snapshot(); XCTAssertEqual(g3?.groups.count, 3)
        t.cancel()
    }

    func testDeleteAndRetakeLast() async throws {
        let cam = MockCamera()
        let (c, _, t) = coordinator(cam)
        _ = try await c.begin(setup(.lighting))
        for _ in 0..<3 { try await c.captureLightingFrame() }
        let before = await c.snapshot()!
        let lastFile = store.frameURL(project: before, frame: before.groups[2].frames[0])
        try await c.deleteLast()
        XCTAssertFalse(FileManager.default.fileExists(atPath: lastFile.path))
        let g2 = await c.snapshot(); XCTAssertEqual(g2?.groups.count, 2)
        try await c.retakeLast()
        let after = await c.snapshot()!
        XCTAssertEqual(after.groups.count, 2, "retake replaces the last light position")
        XCTAssertEqual(after.groups.last?.lightingPosition, 1)
        // focus stack: retake the last frame at the same focus position
        let (c2, _, t2) = coordinator(MockCamera())
        _ = try await c2.begin(setup(.focus))
        try await c2.captureFocusSeries()
        try await c2.retakeLast()
        let s2 = await c2.snapshot(); XCTAssertEqual(s2?.groups[0].frames.count, 5)
        t.cancel(); t2.cancel()
    }

    func testFinishValidationAndDiscard() async throws {
        let cam = MockCamera()
        let (c, _, t) = coordinator(cam)
        let p = try await c.begin(setup(.lighting))
        try await c.captureLightingFrame()
        do { _ = try await c.finish(); XCTFail("one light position is not a stack") } catch let e as CaptureFailure { XCTAssertTrue(e.localizedDescription.contains("at least 2")) }
        await c.discard()
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.projectDirectory(p.id).path))
        XCTAssertEqual(cam.unlockCount, 1)
        // combined: an incomplete last light position cannot be finished
        let (c3, _, t3) = coordinator(MockCamera(failCaptureAt: 8))
        _ = try await c3.begin(setup(.combined, count: 4))
        try await c3.captureFocusSeries()
        do { try await c3.captureFocusSeries() } catch {}
        await c3.resume()
        do { _ = try await c3.finish(); XCTFail("incomplete") } catch let e as CaptureFailure { XCTAssertTrue(e.localizedDescription.contains("incomplete")) }
        t.cancel(); t3.cancel()
    }

    func testBeginRequiresFocusRangeAndRejectsSecondStack() async throws {
        let (c, _, t) = coordinator(MockCamera())
        var s = setup(.focus); s.focusPlan = nil
        do { _ = try await c.begin(s); XCTFail() } catch let e as CaptureFailure { XCTAssertTrue(e.localizedDescription.contains("NEAR")) }
        _ = try await c.begin(setup(.focus))
        do { _ = try await c.begin(setup(.focus)); XCTFail() } catch {}
        t.cancel()
    }

    func testExposureDriftIsReportedNotSilent() async throws {
        let cam = MockCamera(); cam.reportedISO = 200      // auto-exposure crept up during capture
        let (c, box, t) = coordinator(cam)
        _ = try await c.begin(setup(.lighting))
        try await c.captureLightingFrame()
        try await Task.sleep(nanoseconds: 50_000_000); t.cancel()
        XCTAssertTrue(box.all.contains { if case .settingsDrifted = $0 { return true } else { return false } })
        XCTAssertTrue(StackLockPolicy.exposureHolds(plan: LockPlan(lensID: "x", iso: 100, shutterSeconds: 1.0 / 60, whiteBalanceKelvin: 5000, tint: 0, pinnedLensPosition: nil, format: .standard, frozenAutoSettings: []), iso: 105, shutter: 1.0 / 60))
    }

    func testSettleTimeGrowsWithLensMove() {
        XCTAssertEqual(StackCaptureCoordinator.settleTime(base: 0.35, move: 0), 0.35, accuracy: 1e-9)
        XCTAssertGreaterThan(StackCaptureCoordinator.settleTime(base: 0.35, move: 0.2), 0.5)
        XCTAssertLessThanOrEqual(StackCaptureCoordinator.settleTime(base: 0.35, move: 1), 0.95)
    }

    func testMotionWarningIsEmittedNeverAborts() async throws {
        let (c, box, t) = coordinator(MockCamera())
        _ = try await c.begin(setup(.focus))
        await c.motionDetected(driftDegrees: 0.8)
        try await c.captureFocusSeries()          // still works
        try await Task.sleep(nanoseconds: 50_000_000); t.cancel()
        XCTAssertTrue(box.all.contains { if case .motionWarning = $0 { return true } else { return false } })
    }

    // MARK: models & scales

    func testHardwareDrivenFormats() {
        XCTAssertEqual(lens.availableFormats, [.standard, .maximumQuality, .raw, .proRAW])
        let plain = LensInfo(id: "uw", kind: .ultraWide, name: "UW", supportsRAW: false, supportsProRAW: false, supportsMaximumQualityPhoto: false)
        XCTAssertEqual(plain.availableFormats, [.standard], "unsupported formats are not offered")
        let caps = CameraCapabilities(lenses: [plain, lens])
        XCTAssertTrue(caps.anyProRAW); XCTAssertEqual(caps.defaultLens?.id, "wide")
        XCTAssertFalse(CameraCapabilities(lenses: [plain]).anyRAW)
    }

    func testLensNamesAreRealNotGenericZoom() {
        XCTAssertEqual(LensNaming.name(kind: .ultraWide, equivalentFocalLengthMM: 13), "Ultra Wide 13 mm")
        XCTAssertEqual(LensNaming.name(kind: .wide, equivalentFocalLengthMM: 24), "Main 24 mm")
        XCTAssertEqual(LensNaming.name(kind: .telephoto, equivalentFocalLengthMM: 77), "Telephoto 3× 77 mm")
        XCTAssertEqual(LensNaming.name(kind: .telephoto, equivalentFocalLengthMM: 120), "Telephoto 5× 120 mm")
        XCTAssertEqual(LensNaming.kind(forEquivalentFocalLength: 13), .ultraWide)
        XCTAssertEqual(LensNaming.kind(forEquivalentFocalLength: 24), .wide)
        XCTAssertEqual(LensNaming.kind(forEquivalentFocalLength: 77), .telephoto)
    }

    func testExposureScalesShowRealNumbersWithinHardwareRange() {
        let iso = ExposureScales.isoValues(min: 32, max: 3200)
        XCTAssertEqual(iso.first, 32); XCTAssertEqual(iso.last, 3200); XCTAssertTrue(iso.contains(64)); XCTAssertTrue(iso.contains(100))
        XCTAssertFalse(iso.contains(25)); XCTAssertFalse(iso.contains(6400))
        XCTAssertEqual(ExposureScales.isoValues(min: 22, max: 200).first, 22, "the exact hardware minimum is offered when it is not a standard stop")
        XCTAssertEqual(ExposureScales.isoValues(min: 24, max: 200).first, 25)
        let sh = ExposureScales.shutterValues(min: 1.0 / 8000, max: 1.0 / 3)
        XCTAssertTrue(sh.contains(1.0 / 125)); XCTAssertFalse(sh.contains(1)); XCTAssertEqual(sh, sh.sorted())
        XCTAssertEqual(ExposureScales.shutterLabel(1.0 / 125), "1/125"); XCTAssertEqual(ExposureScales.shutterLabel(1.0 / 8), "1/8")
        XCTAssertEqual(ExposureScales.shutterLabel(0.5), "0.5 s"); XCTAssertEqual(ExposureScales.shutterLabel(2), "2 s")
        XCTAssertEqual(ExposureScales.shutterLabel(1.0 / 59.7), "1/60")
        XCTAssertEqual(ExposureScales.isoLabel(64), "ISO 64")
        let bias = ExposureScales.biasValues(min: -8, max: 8)
        XCTAssertEqual(bias.first!, -3, accuracy: 1e-5); XCTAssertEqual(bias.last!, 3, accuracy: 1e-5); XCTAssertTrue(bias.contains { abs($0) < 1e-6 })
        XCTAssertEqual(ExposureScales.biasLabel(0), "±0"); XCTAssertEqual(ExposureScales.biasLabel(0.7), "+0.7")
        XCTAssertEqual(ExposureScales.nearest(Float(70), in: iso), 64)
    }

    func testManualFocusMappingGivesNearEndMoreTravelAndFineModeIsSlower() {
        XCTAssertEqual(ManualFocusMapping.lensPosition(control: 0), 0); XCTAssertEqual(ManualFocusMapping.lensPosition(control: 1), 1)
        for x in stride(from: 0.0, through: 1.0, by: 0.1) { XCTAssertEqual(ManualFocusMapping.control(lensPosition: ManualFocusMapping.lensPosition(control: x)), x, accuracy: 1e-5) }
        XCTAssertLessThan(ManualFocusMapping.lensPosition(control: 0.5), 0.5, "more control travel for the near end")
        let coarse = ManualFocusMapping.apply(drag: 0.1, to: 0.3, fine: false) - 0.3
        let fine = ManualFocusMapping.apply(drag: 0.1, to: 0.3, fine: true) - 0.3
        XCTAssertGreaterThan(coarse, 15 * fine)
        XCTAssertGreaterThan(fine, 0)
        XCTAssertEqual(ManualFocusMapping.apply(drag: 5, to: 0.9, fine: false), 1)
        XCTAssertEqual(ManualFocusMapping.apply(drag: -5, to: 0.1, fine: false), 0)
        XCTAssertEqual(ManualFocusMapping.nudge(0.5, steps: 3), 0.506, accuracy: 1e-6)
        XCTAssertEqual(ManualFocusMapping.label(lensPosition: 0.0, model: FocusDistanceModel(minimumFocusDistanceMM: 120)), "0.000  ≈120 mm")
        XCTAssertEqual(ManualFocusMapping.label(lensPosition: 0.25, model: FocusDistanceModel(minimumFocusDistanceMM: nil)), "0.250")
    }
}

extension MockCamera {
    convenience init(failCaptureAt n: Int) { self.init(); failCaptureAt = n }
}
