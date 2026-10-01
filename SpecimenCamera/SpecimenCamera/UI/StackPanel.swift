import SwiftUI
import SpecimenCore

/// FOCUS / LIGHTING / COMBINED workflow panel. Shows only the steps that apply to the current mode and state.
struct StackPanel: View {
    @EnvironmentObject var stack: StackSessionModel
    @EnvironmentObject var camera: CameraController
    @EnvironmentObject var settings: AppSettings

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

    // MARK: Setup

    @ViewBuilder private var setupPanel: some View {
        switch stack.mode {
        case .single: EmptyView()
        case .lighting:
            VStack(alignment: .leading, spacing: 4) {
                Text("LIGHTING STACK").font(.system(size: 11, weight: .heavy)).foregroundColor(Theme.accent)
                Text("Mount the phone, compose, set and lock focus, exposure and white balance. Press the shutter for frame 1, move the light, repeat (typically 3–8 positions), then FINISH. Keep the phone fixed.")
                    .font(.system(size: 11)).foregroundColor(.gray)
            }.frame(maxWidth: .infinity, alignment: .leading)
        case .focus, .combined:
            VStack(spacing: 8) {
                Text(stack.mode == .focus ? "Mount the phone, lock exposure and white balance. Focus the nearest part that must be sharp → SET NEAR; the farthest → SET FAR."
                                           : "Set NEAR and FAR once; they apply to every light position. Keep the phone fixed.")
                    .font(.system(size: 11)).foregroundColor(.gray).frame(maxWidth: .infinity, alignment: .leading)
                HStack(spacing: 8) {
                    rangeButton("NEAR FOCUS", value: stack.nearFocus) { stack.setNear() }
                    rangeButton("FAR FOCUS", value: stack.farFocus) { stack.setFar() }
                }
                HStack(spacing: 8) {
                    countMenu
                    Spacer()
                    Button(stack.mode == .combined ? "START · LIGHT 1" : "START STACK") { Task { await stack.start(); if stack.isActive { await stack.waitShutterDelay(); await stack.captureFocusSeries() } } }
                        .buttonStyle(ActionStyle()).disabled(!stack.canStartFocusLike || stack.isBusy || stack.countdown > 0)
                        .opacity(stack.canStartFocusLike ? 1 : 0.4)
                }
                if let p = stack.plan {
                    Text("\(p.count) frames · \(p.note)").font(.system(size: 10)).foregroundColor(.gray).frame(maxWidth: .infinity, alignment: .leading)
                }
                if !stack.canSetFocusRange { Text("This camera cannot be focused manually; focus stacks are unavailable.").font(.system(size: 11)).foregroundColor(Theme.danger) }
            }
        }
    }

    private func rangeButton(_ title: String, value: Float?, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 1) {
                Text(title).font(.system(size: 9, weight: .bold)).foregroundColor(.gray)
                Text(value.map { "SET · " + String(format: "%.3f", $0) } ?? "SET").font(.system(size: 13, weight: .heavy, design: .monospaced)).foregroundColor(value == nil ? .white : Theme.ok)
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
                Text("FRAME COUNT:").font(.system(size: 10, weight: .bold)).foregroundColor(.gray)
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
            HStack(spacing: 8) {
                switch stack.mode {
                case .lighting:
                    Button("RETAKE LAST") { Task { await stack.retakeLast() } }.buttonStyle(ActionStyle(prominent: false)).disabled(stack.lightPositions == 0 || stack.isBusy)
                    Button("DELETE LAST") { Task { await stack.deleteLast() } }.buttonStyle(ActionStyle(color: Theme.danger, prominent: false)).disabled(stack.lightPositions == 0 || stack.isBusy)
                    Spacer()
                    Button("FINISH STACK") { Task { await stack.finish() } }.buttonStyle(ActionStyle()).disabled(stack.lightPositions < 2 || stack.isBusy)
                case .combined:
                    Button("DELETE LAST POSITION") { Task { await stack.deleteLast() } }.buttonStyle(ActionStyle(color: Theme.danger, prominent: false)).disabled(stack.lightPositions == 0 || stack.isBusy)
                    Spacer()
                    Button("NEXT LIGHT POSITION") { Task { await stack.captureFocusSeries() } }.buttonStyle(ActionStyle(prominent: false)).disabled(stack.isBusy)
                    Button("FINISH & PROCESS") { Task { await stack.finish() } }.buttonStyle(ActionStyle()).disabled(stack.lightPositions < 2 || stack.isBusy)
                case .focus:
                    // After an interruption (call, app switch, error) the series continues where it stopped; or finish with what exists.
                    Button("CONTINUE") { Task { await stack.captureFocusSeries() } }.buttonStyle(ActionStyle(prominent: false))
                        .disabled(stack.isBusy || (stack.plan.map { stack.capturedFrames >= $0.count } ?? true))
                    Spacer()
                    Button("FINISH NOW") { Task { await stack.finish() } }.buttonStyle(ActionStyle(prominent: false))
                        .disabled(stack.capturedFrames < 2 || stack.isBusy)
                case .single:
                    Spacer()
                }
                Button("CANCEL") { Task { await stack.cancelStack() } }.buttonStyle(ActionStyle(color: Theme.danger, prominent: false))
            }
            if stack.mode == .combined { Text("\(stack.lightPositions) light position(s) · \(stack.capturedFrames) frames").font(.system(size: 10)).foregroundColor(.gray).frame(maxWidth: .infinity, alignment: .leading) }
            if stack.mode == .lighting { Text("\(stack.lightPositions) frame(s) — move the light, then press the shutter").font(.system(size: 10)).foregroundColor(.gray).frame(maxWidth: .infinity, alignment: .leading) }
        }
    }
}
