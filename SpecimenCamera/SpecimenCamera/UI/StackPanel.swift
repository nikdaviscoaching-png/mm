import SwiftUI
import SpecimenCore

/// FOCUS / LIGHTING / COMBINED workflow panel. Every mode shows what to do next in plain steps, one obvious primary button,
/// and a way to import existing photos instead of shooting.
struct StackPanel: View {
    @EnvironmentObject var stack: StackSessionModel
    @EnvironmentObject var camera: CameraController
    @EnvironmentObject var settings: AppSettings
    @AppStorage("stackHelpOpen") private var helpOpen = true

    var body: some View {
        VStack(spacing: 8) {
            if stack.isActive { activePanel } else { setupPanel }
            if !stack.issues.isEmpty {
                ForEach(Array(stack.issues.enumerated()), id: \.offset) { _, i in
                    Text(i.message).font(.system(size: 11)).foregroundColor(i.isBlocking ? Theme.danger : .yellow).frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            if let w = stack.motionWarning {
                HStack {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundColor(.yellow)
                    Text(w).font(.system(size: 11)).foregroundColor(.yellow)
                    Spacer()
                    Button("OK") { stack.acknowledgeMotion() }.buttonStyle(ChipStyle())
                }.padding(6).background(Color.yellow.opacity(0.15)).clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(Theme.panel)
    }

    // MARK: Pieces

    private func header(_ title: String, _ subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(title).font(.system(size: 12, weight: .heavy)).foregroundColor(Theme.accent)
                Spacer()
                Button(helpOpen ? "HIDE STEPS ▴" : "HOW IT WORKS ▾") { withAnimation { helpOpen.toggle() } }.font(.system(size: 10, weight: .bold)).foregroundColor(.gray)
            }
            Text(subtitle).font(.system(size: 11)).foregroundColor(.gray)
        }
    }

    private func step(_ n: Int, _ text: String, done: Bool = false) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(done ? "✓" : "\(n)").font(.system(size: 11, weight: .heavy)).foregroundColor(done ? .black : .white)
                .frame(width: 18, height: 18).background(done ? Theme.ok : Theme.chip).clipShape(Circle())
            Text(text).font(.system(size: 11)).foregroundColor(done ? .gray : .white).frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func importButton() -> some View {
        Button { stack.importRequest = stack.mode.stackType } label: {
            Label("IMPORT PHOTOS INSTEAD", systemImage: "square.and.arrow.down").font(.system(size: 11, weight: .bold)).frame(maxWidth: .infinity, minHeight: 36)
        }.buttonStyle(ActionStyle(prominent: false))
    }

    // MARK: Setup

    @ViewBuilder private var setupPanel: some View {
        switch stack.mode {
        case .single: EmptyView()
        case .upscale2x:
            VStack(alignment: .leading, spacing: 6) {
                header("HANDHELD 2X", "Hold the phone as steady as you can and press the shutter once. It takes 5 quick full-quality photos with focus, exposure and white balance locked, then combines their tiny natural shifts into one photo with twice the width and height. Saved to the folder shown at the top.")
            }
        case .lighting:
            VStack(alignment: .leading, spacing: 6) {
                header("LIGHTING STACK", "Same view, different light. Glare and reflections are replaced with clean areas from your other frames.")
                if helpOpen {
                    step(1, "Frame the specimen and set focus, ISO, shutter and white balance. They are locked when you start.")
                    step(2, "Press START: this takes frame 1 with the light where it is now.")
                    step(3, "Move the light, then press CAPTURE FRAME. Repeat for 3–8 light positions.")
                    step(4, "Press FINISH STACK to blend them into one image.")
                }
                HStack(spacing: 8) {
                    Button("START LIGHTING STACK") { Task { await startLighting() } }
                        .buttonStyle(ActionStyle()).disabled(stack.isBusy || stack.countdown > 0)
                    importButton()
                }
            }
        case .focus, .combined:
            VStack(spacing: 8) {
                header(stack.mode == .focus ? "FOCUS STACK" : "COMBINED STACK",
                       stack.mode == .focus ? "Everything sharp from front to back: the app steps the focus through the depth you choose and blends the sharp parts."
                                            : "A full focus stack at each light position, then the lighting blend. NEAR and FAR are set once.")
                if helpOpen {
                    VStack(alignment: .leading, spacing: 5) {
                        step(1, "Open the FOCUS tab and focus on the NEAREST part that must be sharp (use peaking + 4×/8×), then tap SET NEAR.", done: stack.nearFocus != nil)
                        step(2, "Focus on the FARTHEST part that must be sharp, then tap SET FAR.", done: stack.farFocus != nil)
                        step(3, stack.mode == .focus ? "Press START STACK. The phone captures every frame by itself — keep it still."
                                                     : "Press START: it captures the focus series for light position 1. Then move the light and press CAPTURE LIGHT POSITION; repeat 3–6 times, then FINISH.", done: false)
                    }
                }
                HStack(spacing: 8) {
                    rangeButton("NEAR FOCUS", value: stack.nearFocus) { stack.setNear() }
                    rangeButton("FAR FOCUS", value: stack.farFocus) { stack.setFar() }
                }
                HStack(spacing: 8) {
                    countMenu
                    Spacer()
                    Button(stack.mode == .combined ? "START · LIGHT 1" : "START STACK") { Task { await startFocusLike() } }
                        .buttonStyle(ActionStyle()).disabled(!stack.canStartFocusLike || stack.isBusy || stack.countdown > 0)
                        .opacity(stack.canStartFocusLike ? 1 : 0.4)
                }
                if let p = stack.plan {
                    Text("\(p.count) frames · \(p.note)").font(.system(size: 10)).foregroundColor(.gray).frame(maxWidth: .infinity, alignment: .leading)
                } else if stack.canSetFocusRange {
                    Text("Set NEAR and FAR to see how many frames are needed.").font(.system(size: 10)).foregroundColor(.gray).frame(maxWidth: .infinity, alignment: .leading)
                }
                if !stack.canSetFocusRange { Text("This camera cannot be focused manually; focus stacks are unavailable.").font(.system(size: 11)).foregroundColor(Theme.danger) }
                importButton()
            }
        }
    }

    private func startLighting() async {
        await stack.start()
        if stack.isActive, await stack.waitShutterDelay() { await stack.captureLightingFrame() }
    }

    private func startFocusLike() async {
        await stack.start()
        if stack.isActive, await stack.waitShutterDelay() { await stack.captureFocusSeries() }
    }

    private func rangeButton(_ title: String, value: Float?, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 1) {
                Text(title).font(.system(size: 9, weight: .bold)).foregroundColor(.gray)
                Text(value.map { "SET · " + String(format: "%.3f", $0) } ?? "TAP TO SET").font(.system(size: 13, weight: .heavy, design: .monospaced)).foregroundColor(value == nil ? .white : Theme.ok)
            }.frame(maxWidth: .infinity, minHeight: 46).background(Theme.chip).clipShape(RoundedRectangle(cornerRadius: 8))
        }.buttonStyle(.plain).disabled(!stack.canSetFocusRange)
    }

    @ViewBuilder private var countMenu: some View {
        Menu {
            Button("AUTO") { stack.frameCountChoice = .auto }
            ForEach(StackSessionModel.presets, id: \.self) { n in Button("\(n) frames") { stack.frameCountChoice = .manual(n) } }
            Button("Custom…") { stack.frameCountChoice = .manual(stack.plan?.count ?? 10) }
        } label: {
            HStack {
                Text("FRAMES:").font(.system(size: 10, weight: .bold)).foregroundColor(.gray)
                Text(countLabel).font(.system(size: 13, weight: .heavy, design: .monospaced)).foregroundColor(.white)
                Image(systemName: "chevron.down").font(.caption2).foregroundColor(.gray)
            }.padding(.horizontal, 10).frame(minHeight: 44).background(Theme.chip).clipShape(RoundedRectangle(cornerRadius: 8))
        }
        if case .manual(let n) = stack.frameCountChoice {
            Stepper("", value: Binding(get: { n }, set: { stack.frameCountChoice = .manual($0) }), in: 2...FocusStepPlanner.maximumFrames).labelsHidden()
        }
    }

    private var countLabel: String {
        switch stack.frameCountChoice {
        case .auto: return "AUTO" + (stack.plan.map { " (\($0.count))" } ?? "")
        case .manual(let n): return "\(n)"
        }
    }

    // MARK: Active

    @ViewBuilder private var activePanel: some View {
        VStack(spacing: 8) {
            if let l = stack.lockedSummary { Text(l).font(.system(size: 10, weight: .bold, design: .monospaced)).foregroundColor(Theme.ok).frame(maxWidth: .infinity, alignment: .leading) }
            Text("KEEP THE PHONE FIXED").font(.system(size: 10, weight: .heavy)).foregroundColor(.yellow).frame(maxWidth: .infinity, alignment: .leading)
            Text(stack.statusLine).font(.system(size: 13, weight: .bold, design: .monospaced)).foregroundColor(.white).frame(maxWidth: .infinity, alignment: .leading)
            if !stack.thumbnails.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 4) { ForEach(Array(stack.thumbnails.enumerated()), id: \.offset) { _, img in
                        Image(uiImage: img).resizable().scaledToFill().frame(width: 44, height: 44).clipShape(RoundedRectangle(cornerRadius: 4))
                    }}
                }
            }
            switch stack.mode {
            case .lighting:
                Text("\(stack.lightPositions) frame(s) captured. Move the light, then capture the next frame (needs at least 2).").font(.system(size: 10)).foregroundColor(.gray).frame(maxWidth: .infinity, alignment: .leading)
                Button { Task { guard await stack.waitShutterDelay() else { return }; await stack.captureLightingFrame() } } label: {
                    Text("CAPTURE FRAME \(stack.lightPositions + 1)").frame(maxWidth: .infinity)
                }.buttonStyle(ActionStyle()).disabled(stack.isBusy || stack.countdown > 0)
                HStack(spacing: 8) {
                    Button("RETAKE LAST") { Task { await stack.retakeLast() } }.buttonStyle(ActionStyle(prominent: false)).disabled(stack.lightPositions == 0 || stack.isBusy)
                    Button("DELETE LAST") { Task { await stack.deleteLast() } }.buttonStyle(ActionStyle(color: Theme.danger, prominent: false)).disabled(stack.lightPositions == 0 || stack.isBusy)
                    Spacer()
                    Button("FINISH STACK") { Task { await stack.finish() } }.buttonStyle(ActionStyle(prominent: false)).disabled(stack.lightPositions < 2 || stack.isBusy)
                }
            case .combined:
                Text("\(stack.lightPositions) light position(s) · \(stack.capturedFrames) frames. Move the light, then capture the next position (needs at least 2).").font(.system(size: 10)).foregroundColor(.gray).frame(maxWidth: .infinity, alignment: .leading)
                Button { Task { guard await stack.waitShutterDelay() else { return }; await stack.captureFocusSeries() } } label: {
                    Text("CAPTURE LIGHT POSITION \(stack.lightPositions + 1)").frame(maxWidth: .infinity)
                }.buttonStyle(ActionStyle()).disabled(stack.isBusy || stack.countdown > 0)
                HStack(spacing: 8) {
                    Button("DELETE LAST POSITION") { Task { await stack.deleteLast() } }.buttonStyle(ActionStyle(color: Theme.danger, prominent: false)).disabled(stack.lightPositions == 0 || stack.isBusy)
                    Spacer()
                    Button("FINISH & PROCESS") { Task { await stack.finish() } }.buttonStyle(ActionStyle(prominent: false)).disabled(stack.lightPositions < 2 || stack.isBusy)
                }
            case .focus:
                // After an interruption (call, app switch, error) the series continues where it stopped; or finish with what exists.
                HStack(spacing: 8) {
                    Button("CONTINUE") { Task { await stack.captureFocusSeries() } }.buttonStyle(ActionStyle())
                        .disabled(stack.isBusy || (stack.plan.map { stack.capturedFrames >= $0.count } ?? true))
                    Spacer()
                    Button("FINISH NOW") { Task { await stack.finish() } }.buttonStyle(ActionStyle(prominent: false))
                        .disabled(stack.capturedFrames < 2 || stack.isBusy)
                }
            case .single, .upscale2x:
                EmptyView()
            }
            HStack { Spacer(); Button("CANCEL STACK") { Task { await stack.cancelStack() } }.buttonStyle(ActionStyle(color: Theme.danger, prominent: false)) }
        }
    }
}
