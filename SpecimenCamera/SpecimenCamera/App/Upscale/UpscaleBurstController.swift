import Foundation
import SwiftUI
import UIKit
import SpecimenCore

/// What the burst needs from the camera. The existing `CameraController`/`CameraEngine` provide it — there is no second camera stack.
@MainActor
protocol UpscaleBurstCamera: AnyObject {
    /// Locks focus, exposure and white balance at their current values (and suspends the preview exposure assist).
    func prepareForBurst() async throws
    /// One full-quality photo, prioritising speed so the five frames follow each other quickly.
    func captureFullResolutionFrame(into directory: URL, fileName: String) async throws -> URL
    func finishBurst() async
    var burstLens: LensInfo? { get }
    func burstSettings() -> CameraSettings
}

extension CameraController: UpscaleBurstCamera {
    func prepareForBurst() async throws {
        guard let lens = activeLens else { throw UpscaleError.notEnoughFrames }
        // .focus type: pins exposure and white balance, locks focus where it is, and suspends the preview assist
        let plan = StackLockPolicy.plan(current: currentSettings(), type: .focus, lens: lens)
        try await engine.lockForStack(plan, prioritization: .fast)
    }

    func captureFullResolutionFrame(into directory: URL, fileName: String) async throws -> URL {
        let info = try await engine.capturePhoto(format: .maximumQuality, into: directory, fileName: fileName, prioritizationOverride: .speed)
        return directory.appendingPathComponent(info.fileName)
    }

    func finishBurst() async { await engine.releaseStackLock() }
    var burstLens: LensInfo? { activeLens }
    func burstSettings() -> CameraSettings { currentSettings() }
}

/// Handheld 2×: one shutter press → five quick full-quality frames → multi-frame super-resolution → one 2× photo in the active folder.
@MainActor
final class UpscaleBurstController: ObservableObject {
    enum Phase: Equatable {
        case idle
        case capturing(frame: Int, of: Int)
        case processing(progress: Double)
        case finished(URL)
        case failed(String)
    }

    @Published private(set) var phase: Phase = .idle
    var frameCount = 5
    var interval: TimeInterval = 0.15
    var settings = UpscaleSettings()

    private let camera: UpscaleBurstCamera
    private let library: LibraryService
    private let appSettings: AppSettings
    private var task: Task<Void, Never>?

    init(camera: UpscaleBurstCamera, library: LibraryService, appSettings: AppSettings) {
        self.camera = camera; self.library = library; self.appSettings = appSettings
    }

    var isBusy: Bool {
        switch phase { case .capturing, .processing: return true; default: return false }
    }

    func start() {
        guard !isBusy else { return }
        task = Task { await run() }
    }

    func cancel() { task?.cancel() }

    private func run() async {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("upscale-burst-\(UUID().uuidString)", isDirectory: true)
        var bg = UIBackgroundTaskIdentifier.invalid
        defer {
            try? FileManager.default.removeItem(at: dir)            // success, cancel or failure: the burst never lingers
            if bg != .invalid { UIApplication.shared.endBackgroundTask(bg) }
        }
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let usedSettings = camera.burstSettings()
            let lens = camera.burstLens
            phase = .capturing(frame: 1, of: frameCount)
            try await camera.prepareForBurst()
            var urls: [URL] = []
            do {
                for i in 0..<frameCount {
                    try Task.checkCancellation()
                    phase = .capturing(frame: i + 1, of: frameCount)
                    let started = Date()
                    urls.append(try await camera.captureFullResolutionFrame(into: dir, fileName: "frame\(i).heic"))
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    let wait = interval - Date().timeIntervalSince(started)
                    if i < frameCount - 1, wait > 0 { try await Task.sleep(nanoseconds: UInt64(wait * 1e9)) }
                }
            } catch { await camera.finishBurst(); throw error }
            await camera.finishBurst()

            phase = .processing(progress: 0)
            bg = UIApplication.shared.beginBackgroundTask(withName: "Upscale") { [weak self] in Task { @MainActor in self?.cancel() } }
            let result = try await UpscaleProcessor.run(frameURLs: urls, settings: settings, progress: { [weak self] p in
                Task { @MainActor in if case .processing = self?.phase { self?.phase = .processing(progress: p) } }
            })
            try? FileManager.default.removeItem(at: dir)             // sources are no longer needed
            let finalURL = try await save(result, lens: lens, settings: usedSettings)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            phase = .finished(finalURL)
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            if case .finished = phase { phase = .idle }
        } catch is CancellationError {
            phase = .idle
        } catch UpscaleError.cancelled {
            phase = .idle
        } catch {
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            phase = .failed(error.localizedDescription)
        }
    }

    /// Files the result like any other capture (active folder / Photos, per the save-destination setting).
    private func save(_ result: UpscaleResult, lens: LensInfo?, settings: CameraSettings) async throws -> URL {
        let dest = appSettings.saveDestination
        var photosURL = result.photoURL
        var shown = result.photoURL
        if dest != .photos {
            let thumb = ZoomRaw.thumbnail(rawURL: result.rawURL, width: result.width, height: result.height)
            let item = try library.addUpscaled(file: result.photoURL, width: result.width, height: result.height, lens: lens, settings: settings, usedFrames: result.usedFrames, thumbnail: thumb)
            photosURL = library.masterURL(item)
            shown = photosURL
            ZoomCache.adopt(rawFile: result.rawURL, for: photosURL, width: result.width, height: result.height)
        } else {
            try? FileManager.default.removeItem(at: result.rawURL)
        }
        if dest != .appLibrary { try await PhotosSaver.save(fileURL: photosURL) }
        if dest == .photos { try? FileManager.default.removeItem(at: result.photoURL) }
        return shown
    }

    func dismissFailure() { if case .failed = phase { phase = .idle } }
}

/// Compact status card for the camera screen.
struct UpscaleStatusView: View {
    @ObservedObject var controller: UpscaleBurstController

    var body: some View {
        switch controller.phase {
        case .idle: EmptyView()
        case .capturing(let n, let total):
            card { Label("Hold steady. Natural hand shake is fine. \(n) of \(total)", systemImage: "hand.raised.fill") }
        case .processing(let p):
            card {
                VStack(spacing: 6) {
                    Text("Building 2x photo… \(Int(p * 100))%").font(.system(size: 13, weight: .bold))
                    ProgressView(value: p)
                    Button("Cancel") { controller.cancel() }.font(.system(size: 12, weight: .semibold))
                }
            }
        case .finished:
            card { Label("Saved 2x photo", systemImage: "checkmark.circle.fill") }
        case .failed(let message):
            card {
                VStack(spacing: 6) {
                    Text(message).font(.system(size: 12)).multilineTextAlignment(.center)
                    Button("OK") { controller.dismissFailure() }.font(.system(size: 12, weight: .semibold))
                }
            }
        }
    }

    private func card<C: View>(@ViewBuilder _ content: () -> C) -> some View {
        content().font(.system(size: 13, weight: .bold)).foregroundColor(.white).padding(12)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
            .padding(.horizontal, 24).padding(.top, 8)
    }
}
