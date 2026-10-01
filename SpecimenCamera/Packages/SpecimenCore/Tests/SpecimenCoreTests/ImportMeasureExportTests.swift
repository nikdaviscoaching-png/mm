import XCTest
@testable import SpecimenCore

final class ImportMeasureExportTests: XCTestCase {
    func c(_ name: String, _ t: Double?, dist: Double? = nil) -> ImportCandidate {
        ImportCandidate(url: URL(fileURLWithPath: "/tmp/\(name)"), captureDate: t.map { Date(timeIntervalSince1970: 1_700_000_000 + $0) }, subjectDistanceMM: dist)
    }

    func testFocusImportIsOrderedByDistanceWhenAvailableElseTime() {
        let a = [c("b.heic", 2, dist: 300), c("a.heic", 1, dist: 100), c("c.heic", 3, dist: 200)]
        let g = ImportGrouper.group(a, type: .focus)
        XCTAssertEqual(g.groups.count, 1)
        XCTAssertEqual(g.groups[0].map { $0.url.lastPathComponent }, ["a.heic", "c.heic", "b.heic"])
        let noDist = ImportGrouper.group([c("z", 5), c("y", 1), c("x", 3)], type: .focus)
        XCTAssertEqual(noDist.groups[0].map { $0.url.lastPathComponent }, ["y", "x", "z"])
    }

    func testLightingImportOneImagePerPositionInCaptureOrder() {
        let g = ImportGrouper.group([c("3", 30), c("1", 10), c("2", 20), c("4", 40)], type: .lighting)
        XCTAssertEqual(g.groups.map { $0[0].url.lastPathComponent }, ["1", "2", "3", "4"])
        XCTAssertFalse(g.needsManualReview)
    }

    func testCombinedImportGroupsByPausesBetweenSeries() {
        // 3 series of 4 frames, 2 s apart inside a series, 40 s apart between series
        var items: [ImportCandidate] = []
        for s in 0..<3 { for f in 0..<4 { items.append(c("s\(s)f\(f)", Double(s) * 46 + Double(f) * 2)) } }
        let g = ImportGrouper.group(items.shuffled(), type: .combined)
        XCTAssertEqual(g.groups.count, 3)
        XCTAssertEqual(g.groups.map { $0.count }, [4, 4, 4])
        XCTAssertFalse(g.needsManualReview)
        XCTAssertEqual(g.groups[1].map { $0.url.lastPathComponent }, ["s1f0", "s1f1", "s1f2", "s1f3"])
    }

    func testCombinedImportWithKnownGroupSizeAndAmbiguousCases() {
        let even = (0..<12).map { c("f\($0)", Double($0)) }          // no pauses at all
        XCTAssertTrue(ImportGrouper.group(even, type: .combined).needsManualReview)
        let sized = ImportGrouper.group(even, type: .combined, framesPerGroup: 4)
        XCTAssertEqual(sized.groups.map { $0.count }, [4, 4, 4]); XCTAssertFalse(sized.needsManualReview)
        XCTAssertTrue(ImportGrouper.group((0..<8).map { c("n\($0)", nil) }, type: .combined).needsManualReview, "no capture times → manual grouping UI")
        XCTAssertTrue(ImportGrouper.group([c("a", 0), c("b", 1)], type: .combined).needsManualReview)
        var uneven = (0..<4).map { c("u\($0)", Double($0)) }; uneven += (0..<3).map { c("v\($0)", 100 + Double($0)) }
        XCTAssertTrue(ImportGrouper.group(uneven, type: .combined).needsManualReview, "differing group sizes are flagged")
    }

    func testReferenceCalibration() {
        let r = ScaleEstimator.fromReference(pixelDistance: 856, knownLengthMM: 85.6)!      // credit-card width
        XCTAssertEqual(r.scale.pixelsPerMillimeter, 10, accuracy: 1e-9)
        XCTAssertEqual(r.scale.method, .manualReference)
        XCTAssertLessThan(r.uncertaintyFraction, 0.01)
        XCTAssertTrue(r.scale.accuracyNote.contains("manual reference"))
        XCTAssertGreaterThan(ScaleEstimator.fromReference(pixelDistance: 40, knownLengthMM: 5)!.uncertaintyFraction, 0.05, "short baselines are less accurate")
        XCTAssertNil(ScaleEstimator.fromReference(pixelDistance: 0, knownLengthMM: 5))
        XCTAssertNil(ScaleEstimator.fromReference(pixelDistance: 100, knownLengthMM: 0))
        XCTAssertEqual(ScaleEstimator.millimeters(pixels: 250, scale: r.scale), 25, accuracy: 1e-9)
    }

    func testLiDARIsNotPresentedAsPreciseAtMacroDistance() {
        if case .notRecommended = ScaleEstimator.assessLiDAR(distanceMM: 150) {} else { XCTFail("macro distance must be refused") }
        if case .reliable(let u) = ScaleEstimator.assessLiDAR(distanceMM: 600) { XCTAssertLessThan(u, 0.03) } else { XCTFail() }
        if case .rough = ScaleEstimator.assessLiDAR(distanceMM: 300) {} else { XCTFail("30 cm is only a rough estimate (±3.3 %)") }
        XCTAssertEqual(ScaleEstimator.fromDistance(distanceMM: 400, focalLengthPixels: 4000), 10)
        XCTAssertNil(ScaleEstimator.fromDistance(distanceMM: 0, focalLengthPixels: 4000))
    }

    func testFocalLengthInPixelsFromEquivalent() {
        // 24 mm-eq on a 4:3 12 MP image: diag = 5040 px → 24 × 5040 / 43.27 ≈ 2795 px
        XCTAssertEqual(ScaleEstimator.focalLengthPixels(equivalentFocalLengthMM: 24, imageWidth: 4032, imageHeight: 3024)!, 2795.4, accuracy: 1)
        // portrait gives the same value
        XCTAssertEqual(ScaleEstimator.focalLengthPixels(equivalentFocalLengthMM: 24, imageWidth: 3024, imageHeight: 4032)!, 2795.4, accuracy: 1)
        XCTAssertNil(ScaleEstimator.focalLengthPixels(equivalentFocalLengthMM: 0, imageWidth: 4032, imageHeight: 3024))
        // at 400 mm the 12 MP main camera sees ≈ 7 px/mm
        let f = ScaleEstimator.focalLengthPixels(equivalentFocalLengthMM: 24, imageWidth: 4032, imageHeight: 3024)!
        XCTAssertEqual(ScaleEstimator.fromDistance(distanceMM: 400, focalLengthPixels: f)!, 6.99, accuracy: 0.02)
    }

    func testScaleBarPicksNiceLengths() {
        let b = ScaleBar.choose(pixelsPerMillimeter: 10, imageWidthPixels: 4000)    // 20 % of 400 mm = 80 mm → 100 or 50
        XCTAssertTrue([50.0, 100.0].contains(b.lengthMM)); XCTAssertEqual(b.pixels, b.lengthMM * 10, accuracy: 1e-9)
        XCTAssertEqual(ScaleBar.choose(pixelsPerMillimeter: 200, imageWidthPixels: 4000).label, "5 mm")   // image is only 20 mm wide
    }

    func testWebCopyNeverUpscalesAndKeepsAspect() {
        let p = WebCopyPreset.eBay
        let big = ExportPlanner.webCopySize(width: 8064, height: 6048, preset: p)
        XCTAssertEqual(max(big.width, big.height), 2560); XCTAssertEqual(Double(big.width) / Double(big.height), 8064.0 / 6048.0, accuracy: 0.002)
        let small = ExportPlanner.webCopySize(width: 1200, height: 900, preset: p)
        XCTAssertEqual(small.width, 1200); XCTAssertEqual(small.height, 900)
        var item = LibraryItem(collectionID: UUID(), kind: .focus, captureDate: Date(timeIntervalSince1970: 1_700_000_000), fileName: "x", width: 1, height: 1, finalFormat: .heif)
        XCTAssertEqual(ExportPlanner.fileName(for: item, web: false), "specimen-focus-20231114-221320.heic")
        item.kind = .single
        XCTAssertEqual(ExportPlanner.fileName(for: item, web: true), "specimen-photo-20231114-221320-web.jpg")
    }

    func testCompositeMetadataDescribesTheStackNotOneFrame() {
        var p = StackProject(type: .combined)
        p.configuration.lensName = "Main 24 mm"; p.configuration.iso = 64
        var g1 = FocusStackGroup(lightingPosition: 0), g2 = FocusStackGroup(lightingPosition: 1)
        for i in 0..<6 { var f = StackFrame(fileName: "a\(i).dng", kind: .dng); f.timestamp = Date(timeIntervalSince1970: 100 + Double(i)); g1.frames.append(f); g2.frames.append(StackFrame(fileName: "b\(i).dng", kind: .dng)) }
        g1.nearFocus = 0.1; g1.farFocus = 0.4
        p.groups = [g1, g2]
        let m = CompositeMetadata(project: p)
        XCTAssertEqual(m.compositeType, "Combined Stack"); XCTAssertEqual(m.sourceFrameCount, 12); XCTAssertEqual(m.focusFrameCount, 6); XCTAssertEqual(m.lightingPositionCount, 2)
        XCTAssertTrue(m.sourceWasRAW); XCTAssertEqual(m.focusRangeLensPosition, [0.1, 0.4])
        XCTAssertEqual(m.originalCaptureDate, Date(timeIntervalSince1970: 100) , "earliest frame time")
        XCTAssertTrue(m.summary.contains("6 focus planes") && m.summary.contains("2 light positions") && m.summary.contains("SPECIMEN CAMERA"))
    }
}
