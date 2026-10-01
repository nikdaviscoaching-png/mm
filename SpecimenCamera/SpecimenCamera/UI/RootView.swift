import SwiftUI
import PhotosUI
import SpecimenCore

/// The camera screen: preview as large as possible, controls below, mode selector and shutter at the bottom.
struct RootView: View {
    @EnvironmentObject var app: AppModel
    @EnvironmentObject var camera: CameraController
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var overlay: OverlayAnalyzer
    @EnvironmentObject var library: LibraryService
    @EnvironmentObject var processing: ProcessingService
    @EnvironmentObject var stack: StackSessionModel
    @EnvironmentObject var motion: MotionService

    @State private var showSettings = false
    @State private var showCollections = false
    @State private var showLibrary = false
    @State private var showImport = false
    @State private var showControls = true
    @State private var focusTap: CGPoint?

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            switch camera.authorization {
            case .denied: PermissionDeniedView()
            case .notDetermined: ProgressView("Requesting camera access…").tint(.white).foregroundColor(.white)
            case .authorized: cameraScreen
            }
            if processing.isProcessing || processing.progress != nil { ProcessingOverlay() }
        }
        .sheet(isPresented: $showSettings) { SettingsView() }
        .sheet(isPresented: $showCollections) { CollectionPickerView() }
        .sheet(isPresented: $showLibrary) { LibraryView() }
        .sheet(isPresented: $showImport) { ImportView() }
        .sheet(isPresented: $app.showRecovery) { RecoveryView() }
        .fullScreenCover(item: $processing.review) { r in ReviewView(state: r) }
        .alert("SPECIMEN CAMERA", isPresented: Binding(get: { camera.errorMessage != nil || stack.errorMessage != nil || processing.errorMessage != nil },
                                                      set: { if !$0 { camera.errorMessage = nil; stack.errorMessage = nil; processing.errorMessage = nil } })) {
            Button("OK", role: .cancel) {}
        } message: { Text(camera.errorMessage ?? stack.errorMessage ?? processing.errorMessage ?? "") }
    }

    private var cameraScreen: some View {
        VStack(spacing: 0) {
            TopBar(showSettings: $showSettings, showCollections: $showCollections)
            previewArea
            if showControls && !stack.isActive { ControlStrip() }       // settings are pinned during a stack
            if stack.mode != .single { StackPanel() }
            ModeSelector()
            BottomBar(showLibrary: $showLibrary, showImport: $showImport, showControls: $showControls)
        }
    }

    // MARK: Preview

    private var previewArea: some View {
        GeometryReader { g in
            let aspect = overlay.bufferAspect
            let fitted: CGSize = {
                let a = g.size.width / max(g.size.height, 1)
                return a > aspect ? CGSize(width: g.size.height * aspect, height: g.size.height) : CGSize(width: g.size.width, height: g.size.width / aspect)
            }()
            ZStack {
                CameraPreview(engine: camera.engine, magnified: overlay.config.zoom > 1.001,
                              onTapDevicePoint: { dev, loc in
                                  guard !camera.userControlsLocked else { return }
                                  camera.tapToFocus(devicePoint: dev); focusTap = loc; DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { focusTap = nil }
                              },
                              onTapNormalized: { p in if overlay.config.zoom > 1.001 { recenter(on: p) } },
                              onDoubleTap: { var c = overlay.config; c.zoom = 1; c.center = CGPoint(x: 0.5, y: 0.5); overlay.config = c },
                              onPinch: { s in var c = overlay.config; let z = min(max(c.zoom * Double(s), 1), 8); c.zoom = z < 1.1 ? 1 : z; overlay.config = c },
                              onPan: { d in pan(d) })
                if let r = overlay.renderer, overlay.usingGPU { OverlayMetalView(renderer: r).allowsHitTesting(false) }
                else { CPUOverlayView(image: overlay.cpuOverlay) }
                if overlay.config.zoom <= 1.001 {
                    if settings.grid != .off { GridOverlay(style: settings.grid) }
                    if settings.showCrosshair { CrosshairOverlay() }
                }
                if settings.showLevel { LevelOverlay(state: motion.level) }
                if let t = focusTap {
                    Rectangle().stroke(Theme.accent, lineWidth: 1.5).frame(width: 64, height: 64).position(t)
                }
                VStack {
                    HStack(alignment: .top) {
                        if settings.histogram != .off { HistogramView(data: overlay.histogram, mode: settings.histogram) }
                        Spacer()
                        if overlay.config.zoom > 1.001 { Text(String(format: "%.0f×", overlay.config.zoom)).font(.system(size: 14, weight: .heavy)).padding(6).background(Color.black.opacity(0.6)).foregroundColor(Theme.accent).clipShape(RoundedRectangle(cornerRadius: 6)) }
                    }.padding(6)
                    Spacer()
                    if settings.showLiveInfo { LiveInfoBar() }
                }
                if let msg = camera.interruption {
                    Text(msg).font(.headline).padding().background(Color.black.opacity(0.8)).foregroundColor(.yellow).clipShape(RoundedRectangle(cornerRadius: 10))
                }
            }
            .frame(width: fitted.width, height: fitted.height)
            .clipped()
            .frame(width: g.size.width, height: g.size.height)
        }
        .frame(minHeight: 200)
    }

    private func recenter(on p: CGPoint) {
        var c = overlay.config
        let z = c.zoom
        let ox = min(max(c.center.x - 0.5 / z, 0), 1 - 1 / z), oy = min(max(c.center.y - 0.5 / z, 0), 1 - 1 / z)
        c.center = CGPoint(x: ox + p.x / z, y: oy + p.y / z)
        overlay.config = c
    }

    private func pan(_ d: CGSize) {
        var c = overlay.config
        guard c.zoom > 1.001 else { return }
        c.center = CGPoint(x: min(max(c.center.x - d.width / c.zoom, 0), 1), y: min(max(c.center.y - d.height / c.zoom, 0), 1))
        overlay.config = c
    }
}

// MARK: - Top bar

struct TopBar: View {
    @EnvironmentObject var camera: CameraController
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var library: LibraryService
    @Binding var showSettings: Bool
    @Binding var showCollections: Bool

    var body: some View {
        HStack(spacing: 6) {
            Button { showCollections = true } label: {
                VStack(alignment: .leading, spacing: 0) {
                    Text("CURRENT COLLECTION").font(.system(size: 8, weight: .bold)).foregroundColor(.gray)
                    Text(library.activeCollection.name).font(.system(size: 13, weight: .heavy)).foregroundColor(Theme.accent).lineLimit(1)
                }.frame(maxWidth: .infinity, alignment: .leading).frame(minHeight: 40)
            }.buttonStyle(.plain)
            Menu {
                ForEach(camera.availableFormats, id: \.self) { f in Button(f.title + (f == camera.captureFormat ? "  ✓" : "")) { camera.captureFormat = f } }
            } label: { Text(camera.captureFormat.title).frame(minWidth: 44) }.buttonStyle(ChipStyle()).disabled(camera.userControlsLocked)
            Menu {
                ForEach(camera.capabilities.lenses) { l in Button(l.name + (l.id == camera.activeLensID ? "  ✓" : "")) { Task { await camera.selectLens(l.id) } } }
            } label: { Text(shortLens).frame(minWidth: 52) }.buttonStyle(ChipStyle()).disabled(camera.userControlsLocked)
            Button { settings.histogram = next(settings.histogram) } label: { Image(systemName: "chart.bar.fill") }.buttonStyle(ChipStyle(selected: settings.histogram != .off))
            Button { showSettings = true } label: { Image(systemName: "gearshape.fill") }.buttonStyle(ChipStyle())
        }.padding(.horizontal, 8).padding(.vertical, 4).background(Theme.panel)
    }

    private var shortLens: String {
        guard let l = camera.activeLens else { return "—" }
        switch l.kind {
        case .ultraWide: return "UW \(Int(l.equivalentFocalLengthMM ?? 0))"
        case .wide: return "Main \(Int(l.equivalentFocalLengthMM ?? 0))"
        case .telephoto: return "Tele \(Int(l.equivalentFocalLengthMM ?? 0))"
        case .other: return "Cam"
        }
    }

    private func next(_ h: HistogramMode) -> HistogramMode { switch h { case .off: return .luma; case .luma: return .rgb; case .rgb: return .off } }
}

// MARK: - Live info

struct LiveInfoBar: View {
    @EnvironmentObject var camera: CameraController
    @EnvironmentObject var stack: StackSessionModel
    @EnvironmentObject var status: DeviceStatus

    var body: some View {
        let lens = camera.activeLens
        let dims = camera.photoSize(for: camera.captureFormat)
        VStack(alignment: .leading, spacing: 1) {
            Text("\(lens?.name ?? "—") · \(camera.captureFormat.title) · \(Int((Double(dims.width * dims.height) / 1e6).rounded())) MP · f/\(String(format: "%.1f", lens?.fNumber ?? 0))")
            Text("ISO \(Int(camera.displayedISO.rounded())) · \(ExposureScales.shutterLabel(max(camera.displayedShutter, 1e-6))) · \(Int(camera.displayedKelvin)) K · EV \(ExposureScales.biasLabel(camera.exposureBias)) · \(camera.live.focusModeDescription) \(String(format: "%.2f", camera.displayedLensPosition))")
            Text("\(stack.mode == .single ? "SINGLE" : stack.mode.rawValue + (stack.isActive ? " · \(stack.capturedFrames) frames" : "")) · \(String(format: "%.1f GB free", Double(status.freeBytes) / 1e9))" + (status.thermal >= .fair ? " · HOT" : ""))
        }
        .font(.system(size: 9.5, weight: .medium, design: .monospaced)).foregroundColor(.white)
        .padding(5).frame(maxWidth: .infinity, alignment: .leading).background(Color.black.opacity(0.55))
    }
}

// MARK: - Mode selector & bottom bar

struct ModeSelector: View {
    @EnvironmentObject var stack: StackSessionModel
    var body: some View {
        HStack(spacing: 4) {
            ForEach(ShootMode.allCases) { m in
                Button { if !stack.isActive { stack.mode = m } } label: {
                    Text(m.rawValue).font(.system(size: 13, weight: .heavy)).frame(maxWidth: .infinity, minHeight: 40)
                        .background(stack.mode == m ? Theme.accent : Theme.chip).foregroundColor(stack.mode == m ? .black : .white).clipShape(RoundedRectangle(cornerRadius: 8))
                }.buttonStyle(.plain).opacity(stack.isActive && stack.mode != m ? 0.35 : 1)
            }
        }.padding(.horizontal, 8).padding(.vertical, 4).background(Theme.panel)
    }
}

struct BottomBar: View {
    @EnvironmentObject var app: AppModel
    @EnvironmentObject var camera: CameraController
    @EnvironmentObject var library: LibraryService
    @EnvironmentObject var stack: StackSessionModel
    @Binding var showLibrary: Bool
    @Binding var showImport: Bool
    @Binding var showControls: Bool

    var body: some View {
        HStack {
            Button { showLibrary = true } label: {
                Group {
                    if let img = library.lastImage { Image(uiImage: img).resizable().scaledToFill() }
                    else { Image(systemName: "photo.on.rectangle").foregroundColor(.gray) }
                }.frame(width: 56, height: 56).background(Theme.chip).clipShape(RoundedRectangle(cornerRadius: 10))
            }.buttonStyle(.plain)
            Spacer()
            Button { Task { await shutter() } } label: {
                ZStack {
                    Circle().stroke(Color.white, lineWidth: 4).frame(width: 74, height: 74)
                    Circle().fill(camera.isCapturing || stack.isBusy ? Theme.accent : Color.white).frame(width: 60, height: 60)
                    if stack.countdown > 0 { Text("\(stack.countdown)").font(.system(size: 30, weight: .heavy, design: .rounded)).foregroundColor(.black) }
                    else if stack.mode != .single { Image(systemName: icon).font(.system(size: 22, weight: .bold)).foregroundColor(.black) }
                }
            }.buttonStyle(.plain).disabled(camera.isCapturing || stack.isBusy || stack.countdown > 0 || !camera.isRunning)
            Spacer()
            VStack(spacing: 6) {
                Button { showImport = true } label: { Image(systemName: "square.and.arrow.down") }.buttonStyle(ChipStyle())
                Button { showControls.toggle() } label: { Image(systemName: showControls ? "chevron.down" : "chevron.up") }.buttonStyle(ChipStyle())
            }
        }.padding(.horizontal, 16).padding(.vertical, 6).background(Theme.panel)
    }

    private var icon: String {
        switch stack.mode { case .single: return "camera"; case .focus: return "play.fill"; case .lighting, .combined: return "plus" }
    }

    private func shutter() async {
        switch stack.mode {
        case .single:
            await stack.waitShutterDelay()
            await app.captureSingle()
        case .focus, .combined:
            // First press starts the stack; while one is running, a press continues an interrupted series.
            if !stack.isActive { await stack.start(); if stack.isActive { await stack.waitShutterDelay() } }
            if stack.isActive { await stack.captureFocusSeries() }
        case .lighting:
            if !stack.isActive { await stack.start() }
            if stack.isActive { await stack.waitShutterDelay(); await stack.captureLightingFrame() }
        }
    }
}

struct PermissionDeniedView: View {
    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "camera.fill").font(.system(size: 44)).foregroundColor(.gray)
            Text("Camera access is off").font(.title3.bold())
            Text("SPECIMEN CAMERA needs the camera to work. Everything stays on this phone.").multilineTextAlignment(.center).foregroundColor(.gray)
            Button("Open Settings") { if let u = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(u) } }.buttonStyle(ActionStyle())
        }.padding(30).foregroundColor(.white)
    }
}

struct ProcessingOverlay: View {
    @EnvironmentObject var processing: ProcessingService
    @EnvironmentObject var status: DeviceStatus
    var body: some View {
        ZStack {
            Color.black.opacity(0.85).ignoresSafeArea()
            VStack(spacing: 16) {
                Text(processing.progress?.label ?? "PROCESSING").font(.system(size: 18, weight: .heavy, design: .monospaced)).foregroundColor(Theme.accent)
                ProgressView(value: processing.progress?.fraction ?? 0).tint(Theme.accent).frame(width: 260)
                Text("Processing runs on this phone. Keep the app open for the fastest result — if it is interrupted your frames are kept.")
                    .font(.footnote).multilineTextAlignment(.center).foregroundColor(.gray).frame(width: 280)
                if let t = ThermalPolicy.userMessage(status.thermal) { Text(t).font(.footnote).foregroundColor(.yellow).multilineTextAlignment(.center).frame(width: 280) }
                Button("CANCEL") { processing.cancel() }.buttonStyle(ActionStyle(color: Theme.danger, prominent: false))
            }
        }
    }
}
