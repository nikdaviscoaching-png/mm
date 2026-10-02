import SwiftUI

@main
struct SpecimenCameraApp: App {
    @StateObject private var holder = AppHolder()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            Group {
                if let app = holder.app {
                    RootView()
                        .environmentObject(app)
                        .environmentObject(app.settings)
                        .environmentObject(app.camera)
                        .environmentObject(app.overlay)
                        .environmentObject(app.motion)
                        .environmentObject(app.library)
                        .environmentObject(app.processing)
                        .environmentObject(app.stack)
                        .environmentObject(app.status)
                        .environmentObject(app.importer)
                        .environmentObject(app.upscale)
                        .task { await app.launch() }
                        .onChange(of: scenePhase) { _, phase in
                            switch phase {
                            case .active: ScreenAwake.hold("camera"); Task { await app.camera.start(); app.status.refresh() }
                            case .background: ScreenAwake.release("camera"); app.camera.stop()
                            default: break
                            }
                        }
                } else {
                    VStack(spacing: 12) {
                        Image(systemName: "exclamationmark.triangle").font(.largeTitle).foregroundColor(.yellow)
                        Text("SPECIMEN CAMERA could not start").font(.headline)
                        Text(holder.error ?? "Unknown error").font(.footnote).multilineTextAlignment(.center).foregroundColor(.secondary)
                    }.padding().frame(maxWidth: .infinity, maxHeight: .infinity).background(Color.black).foregroundColor(.white)
                }
            }
            .preferredColorScheme(.dark)
            .statusBarHidden(true)
        }
    }
}
