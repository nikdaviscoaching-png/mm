import Foundation
import SwiftUI
import Combine
import UIKit
import SpecimenCore

/// Owns every long-lived service and wires them together. Everything stays on this device.
@MainActor
final class AppModel: ObservableObject {
    let settings = AppSettings()
    let status = DeviceStatus()
    let camera = CameraController()
    let motion = MotionService()
    let overlay = OverlayAnalyzer()
    let library: LibraryService
    let processing: ProcessingService
    let stack: StackSessionModel
    let importer: ImportService

    private var bag = Set<AnyCancellable>()

    init() throws {
        let lib = try LibraryService()
        library = lib
        let proc = try ProcessingService(library: lib)
        processing = proc
        stack = StackSessionModel(camera: camera, motion: motion, processing: proc, settings: settings, status: status)
        importer = ImportService(processing: proc)
        AppPaths.cleanScratch()

        // Camera frames feed the overlay analyzer.
        let analyzer = overlay
        camera.engine.onVideoFrame = { pb in analyzer.process(pb) }

        // Overlay configuration follows settings.
        Publishers.CombineLatest4(settings.$peaking, settings.$peakingColor, settings.$zebra, settings.$histogram)
            .sink { [weak self] p, c, z, h in
                guard let self else { return }
                var cfg = self.overlay.config
                cfg.peaking = p; cfg.peakingColor = c; cfg.zebra = z; cfg.histogram = h
                self.overlay.config = cfg
            }.store(in: &bag)
        // Full-size video buffers when the user asks for them or whenever the view is magnified 3x or more (4x/8x focusing needs
        // real detail, and the overlay then analyses only the visible part, so it stays cheap).
        Publishers.CombineLatest(settings.$highResFocusAssist, overlay.$config.map { $0.zoom >= 3 }.removeDuplicates())
            .map { pair in pair.0 || pair.1 }.removeDuplicates()
            .sink { [weak self] hi in self?.camera.engine.setAnalysisHighResolution(hi) }.store(in: &bag)
        settings.$previewAssist.removeDuplicates().sink { [weak self] m in self?.camera.engine.setPreviewAssist(m) }.store(in: &bag)
        settings.$captureFormat.removeDuplicates().sink { [weak self] f in self?.camera.captureFormat = f }.store(in: &bag)
        camera.$captureFormat.dropFirst().removeDuplicates().sink { [weak self] f in self?.settings.captureFormat = f }.store(in: &bag)
        // Forward nested ObservableObject changes where views observe `app` directly.
        status.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }.store(in: &bag)
    }

    func launch() async {
        motion.start()
        ScreenAwake.hold("camera")
        await camera.start()
        if !processing.recoverable.isEmpty { showRecovery = true }
    }

    @Published var showRecovery = false
    @Published var toast: String?
    @Published var flashTick = 0
}

/// Holds the model, or the reason it could not be created (e.g. no storage), so the app shows a message instead of crashing.
@MainActor
final class AppHolder: ObservableObject {
    @Published private(set) var app: AppModel?
    @Published private(set) var error: String?
    init() {
        do { app = try AppModel() } catch { self.error = error.localizedDescription }
    }
}

// MARK: - Single photo

extension AppModel {
    /// SINGLE mode: capture one photo and file it in the active collection (and/or Photos, per settings).
    func captureSingle() async {
        guard let (url, info) = await camera.captureSingle() else {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            return                                          // the reason is shown by the camera's error alert
        }
        flashTick += 1
        let settingsSnapshot = camera.currentSettings()
        do {
            let dest = settings.saveDestination
            var photosURL = url
            if dest != .photos {
                let item = try library.addSingle(file: url, info: info, lens: camera.activeLens, settings: settingsSnapshot, format: camera.captureFormat)
                photosURL = library.masterURL(item)
            }
            if dest != .appLibrary { try await PhotosSaver.save(fileURL: photosURL) }
            if dest == .photos { try? FileManager.default.removeItem(at: url) }
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            showToast(dest == .photos ? "Saved to Photos" : "Saved to \(library.activeCollection.name)")
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            camera.errorMessage = error.localizedDescription
        }
    }

    func showToast(_ text: String) {
        toast = text
        Task { try? await Task.sleep(nanoseconds: 2_200_000_000); if toast == text { toast = nil } }
    }
}
