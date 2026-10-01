import SwiftUI
import SpecimenCore

enum ControlTab: String, CaseIterable, Identifiable {
    case focus = "FOCUS", iso = "ISO", shutter = "SHUTTER", wb = "WB", ev = "EV"
    var id: String { rawValue }
}

/// Manual camera controls. Only what the active lens can really do is offered; every parameter has a one-tap AUTO.
struct ControlStrip: View {
    @EnvironmentObject var camera: CameraController
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var overlay: OverlayAnalyzer
    @State private var tab: ControlTab = .focus

    var body: some View {
        VStack(spacing: 6) {
            HStack(spacing: 6) {
                tabButton(.focus, value: focusValue, auto: !camera.focusManual && !camera.focusLocked)
                tabButton(.iso, value: ExposureScales.isoLabel(camera.displayedISO), auto: !camera.isoManual)
                tabButton(.shutter, value: ExposureScales.shutterLabel(max(camera.displayedShutter, 1e-6)), auto: !camera.shutterManual)
                tabButton(.wb, value: "\(Int(camera.displayedKelvin)) K", auto: !camera.wbManual && !camera.wbLocked)
                tabButton(.ev, value: camera.exposureIsAuto ? ExposureScales.biasLabel(camera.exposureBias) : "—", auto: camera.exposureBias == 0)
            }
            Group {
                switch tab {
                case .focus: FocusControl()
                case .iso: ISOControl()
                case .shutter: ShutterControl()
                case .wb: WhiteBalanceControl()
                case .ev: EVControl()
                }
            }.frame(minHeight: 86)
        }
        .padding(.horizontal, 8).padding(.vertical, 6)
        .background(Theme.panel)
    }

    private var focusValue: String {
        if camera.focusManual || camera.focusLocked { return String(format: "%.3f", camera.displayedLensPosition) }
        return "AF"
    }

    private func tabButton(_ t: ControlTab, value: String, auto: Bool) -> some View {
        Button { tab = t } label: {
            VStack(spacing: 1) {
                Text(t.rawValue).font(.system(size: 9, weight: .bold)).foregroundColor(tab == t ? .black : .gray)
                Text(value).font(.system(size: 12, weight: .bold, design: .monospaced)).foregroundColor(tab == t ? .black : (auto ? .white : Theme.accent)).lineLimit(1).minimumScaleFactor(0.6)
            }.frame(maxWidth: .infinity, minHeight: 44)
            .background(tab == t ? Theme.accent : Theme.chip).clipShape(RoundedRectangle(cornerRadius: 8))
        }.buttonStyle(.plain)
    }
}

// MARK: Focus

struct FocusControl: View {
    @EnvironmentObject var camera: CameraController
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var overlay: OverlayAnalyzer

    var body: some View {
        VStack(spacing: 6) {
            HStack(spacing: 6) {
                Button("AF") { camera.setFocusAuto() }.buttonStyle(ChipStyle(selected: !camera.focusManual && !camera.focusLocked))
                Button("AF LOCK") { camera.lockFocusHere() }.buttonStyle(ChipStyle(selected: camera.focusLocked))
                if camera.activeLens?.supportsManualFocus == true {
                    Button("MF") { camera.setLensPosition(camera.live.lensPosition) }.buttonStyle(ChipStyle(selected: camera.focusManual))
                }
                Spacer(minLength: 4)
                Button(peakLabel) { settings.peaking = nextPeaking(settings.peaking) }.buttonStyle(ChipStyle(selected: settings.peaking != .off, tint: Theme.chip))
                ForEach(overlay.usingGPU ? [1.0, 2.0, 4.0, 8.0] : [], id: \.self) { z in
                    Button(z == 1 ? "1×" : "\(Int(z))×") { setZoom(z) }.buttonStyle(ChipStyle(selected: abs(overlay.config.zoom - z) < 0.01))
                }
            }
            if camera.activeLens?.supportsManualFocus == true {
                HStack(spacing: 6) {
                    Button { camera.setLensPosition(ManualFocusMapping.nudge(camera.displayedLensPosition, steps: -1)) } label: { Image(systemName: "minus") }.buttonStyle(ChipStyle())
                    FocusDial()
                    Button { camera.setLensPosition(ManualFocusMapping.nudge(camera.displayedLensPosition, steps: 1)) } label: { Image(systemName: "plus") }.buttonStyle(ChipStyle())
                }
                Text(ManualFocusMapping.label(lensPosition: camera.displayedLensPosition, model: camera.activeLens?.focusModel ?? FocusDistanceModel(minimumFocusDistanceMM: nil)) + (camera.activeLens?.minimumFocusDistanceMM != nil ? "  (approx.)" : ""))
                    .font(.system(size: 11, design: .monospaced)).foregroundColor(.gray)
            } else {
                Text("This camera focuses automatically only.").font(.footnote).foregroundColor(.gray)
            }
        }
    }

    private var peakLabel: String { settings.peaking == .off ? "PEAK OFF" : "PEAK \(settings.peaking.title.prefix(1).uppercased())" }
    private func nextPeaking(_ p: PeakingSensitivity) -> PeakingSensitivity {
        switch p { case .off: return .low; case .low: return .medium; case .medium: return .high; case .high: return .off }
    }
    private func setZoom(_ z: Double) {
        var c = overlay.config; c.zoom = z; if z == 1 { c.center = CGPoint(x: 0.5, y: 0.5) }; overlay.config = c
    }
}

/// Broad drag across the whole range; press-and-hold then drag for fine macro-level steps (25× slower).
struct FocusDial: View {
    @EnvironmentObject var camera: CameraController
    @State private var last: CGFloat = 0
    @State private var fine = false
    @State private var lastFine: CGFloat = 0

    var body: some View {
        GeometryReader { g in
            let x = CGFloat(ManualFocusMapping.control(lensPosition: camera.displayedLensPosition)) * g.size.width
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 8).fill(fine ? Theme.accent.opacity(0.25) : Theme.chip)
                Path { p in
                    for i in 0...20 {
                        let tx = g.size.width * CGFloat(i) / 20
                        p.move(to: CGPoint(x: tx, y: g.size.height - (i % 5 == 0 ? 14 : 8))); p.addLine(to: CGPoint(x: tx, y: g.size.height - 2))
                    }
                }.stroke(Color.gray.opacity(0.6), lineWidth: 1)
                Rectangle().fill(Theme.accent).frame(width: 3).offset(x: min(max(x - 1.5, 0), g.size.width - 3))
                if fine { Text("FINE").font(.system(size: 10, weight: .heavy)).foregroundColor(Theme.accent).padding(.leading, 6).frame(maxHeight: .infinity, alignment: .top).padding(.top, 3) }
            }
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 4).onChanged { v in
                guard !fine else { return }
                let dx = v.translation.width - last; last = v.translation.width
                camera.setLensPosition(ManualFocusMapping.apply(drag: Double(dx / g.size.width), to: camera.displayedLensPosition, fine: false))
            }.onEnded { _ in last = 0 })
            .simultaneousGesture(LongPressGesture(minimumDuration: 0.35).sequenced(before: DragGesture(minimumDistance: 0)).onChanged { v in
                switch v {
                case .first(true): if !fine { fine = true; UIImpactFeedbackGenerator(style: .medium).impactOccurred() }
                case .second(true, let drag?):
                    fine = true
                    let dx = drag.translation.width - lastFine; lastFine = drag.translation.width
                    camera.setLensPosition(ManualFocusMapping.apply(drag: Double(dx / g.size.width), to: camera.displayedLensPosition, fine: true))
                default: break
                }
            }.onEnded { _ in fine = false; lastFine = 0 })
        }.frame(height: 48)
    }
}

// MARK: ISO / shutter / EV

struct ValueStrip<T: Equatable>: View {
    let options: [T]
    let selected: T?
    let label: (T) -> String
    let isAuto: Bool
    let onAuto: () -> Void
    let onSelect: (T) -> Void

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    Button("AUTO", action: onAuto).buttonStyle(ChipStyle(selected: isAuto)).id("auto")
                    ForEach(Array(options.enumerated()), id: \.offset) { i, o in
                        Button(label(o)) { onSelect(o) }.buttonStyle(ChipStyle(selected: !isAuto && selected == o)).id(i)
                    }
                }.padding(.horizontal, 2)
            }
            .onAppear { if let s = selected, let i = options.firstIndex(of: s) { proxy.scrollTo(i, anchor: .center) } }
        }
    }
}

/// Swipe left/right on the value to step through the real hardware values one at a time.
struct Scrubber: View {
    let title: String
    let text: String
    let step: (Int) -> Void
    @State private var acc: CGFloat = 0
    var body: some View {
        HStack {
            Text(title).font(.system(size: 11, weight: .bold)).foregroundColor(.gray)
            Text(text).font(.system(size: 18, weight: .heavy, design: .monospaced)).foregroundColor(Theme.accent)
            Spacer()
            Image(systemName: "arrow.left.and.right").foregroundColor(.gray).font(.footnote)
        }
        .padding(.horizontal, 8).frame(height: 36).background(Theme.chip).clipShape(RoundedRectangle(cornerRadius: 8))
        .gesture(DragGesture(minimumDistance: 6).onChanged { v in
            let d = v.translation.width - acc
            if abs(d) >= 22 { step(d > 0 ? 1 : -1); acc = v.translation.width }
        }.onEnded { _ in acc = 0 })
    }
}

struct ISOControl: View {
    @EnvironmentObject var camera: CameraController
    var body: some View {
        VStack(spacing: 6) {
            Scrubber(title: "ISO", text: "\(Int(camera.displayedISO.rounded()))") { s in
                let o = camera.isoOptions
                guard !o.isEmpty else { return }
                let cur = o.enumerated().min { abs($0.element - camera.displayedISO) < abs($1.element - camera.displayedISO) }?.offset ?? 0
                camera.setISO(o[min(max(cur + s, 0), o.count - 1)])
            }
            ValueStrip(options: camera.isoOptions, selected: ExposureScales.nearest(camera.iso, in: camera.isoOptions), label: { String(Int($0)) },
                       isAuto: !camera.isoManual, onAuto: { camera.setISOAuto() }, onSelect: { camera.setISO($0) })
            if camera.isoManual && !camera.shutterManual { Text("Shutter follows the meter (ISO priority)").font(.system(size: 10)).foregroundColor(.gray) }
        }
    }
}

struct ShutterControl: View {
    @EnvironmentObject var camera: CameraController
    var body: some View {
        VStack(spacing: 6) {
            Scrubber(title: "SHUTTER", text: ExposureScales.shutterLabel(max(camera.displayedShutter, 1e-6))) { s in
                let o = camera.shutterOptions
                guard !o.isEmpty else { return }
                let cur = o.enumerated().min { abs($0.element - camera.displayedShutter) < abs($1.element - camera.displayedShutter) }?.offset ?? 0
                camera.setShutter(o[min(max(cur + s, 0), o.count - 1)])
            }
            ValueStrip(options: camera.shutterOptions, selected: ExposureScales.nearest(camera.shutter, in: camera.shutterOptions), label: { ExposureScales.shutterLabel($0) },
                       isAuto: !camera.shutterManual, onAuto: { camera.setShutterAuto() }, onSelect: { camera.setShutter($0) })
            if camera.shutterManual && !camera.isoManual { Text("ISO follows the meter (shutter priority)").font(.system(size: 10)).foregroundColor(.gray) }
        }
    }
}

struct EVControl: View {
    @EnvironmentObject var camera: CameraController
    var body: some View {
        VStack(spacing: 6) {
            Scrubber(title: "EV", text: ExposureScales.biasLabel(camera.exposureBias)) { s in
                let o = camera.biasOptions
                guard !o.isEmpty else { return }
                let cur = o.enumerated().min { abs($0.element - camera.exposureBias) < abs($1.element - camera.exposureBias) }?.offset ?? 0
                camera.setExposureBias(o[min(max(cur + s, 0), o.count - 1)])
            }.opacity(camera.exposureIsAuto ? 1 : 0.4).allowsHitTesting(camera.exposureIsAuto)
            ValueStrip(options: camera.biasOptions, selected: ExposureScales.nearest(camera.exposureBias, in: camera.biasOptions), label: { ExposureScales.biasLabel($0) },
                       isAuto: camera.exposureBias == 0, onAuto: { camera.setExposureBias(0) }, onSelect: { camera.setExposureBias($0) })
                .opacity(camera.exposureIsAuto ? 1 : 0.4).allowsHitTesting(camera.exposureIsAuto)
            if !camera.exposureIsAuto { Text("Exposure compensation applies to automatic exposure").font(.system(size: 10)).foregroundColor(.gray) }
        }
    }
}

// MARK: White balance

struct WhiteBalanceControl: View {
    @EnvironmentObject var camera: CameraController
    var body: some View {
        VStack(spacing: 6) {
            HStack(spacing: 6) {
                Button("AUTO") { camera.setWhiteBalanceAuto() }.buttonStyle(ChipStyle(selected: !camera.wbManual && !camera.wbLocked))
                Button("LOCK") { camera.lockWhiteBalance() }.buttonStyle(ChipStyle(selected: camera.wbLocked))
                Button("KELVIN") { camera.setKelvin(camera.displayedKelvin > 0 ? camera.displayedKelvin : 5000) }.buttonStyle(ChipStyle(selected: camera.wbManual))
                Spacer()
                Text("\(Int(camera.displayedKelvin)) K").font(.system(size: 15, weight: .heavy, design: .monospaced)).foregroundColor(Theme.accent)
            }
            HStack {
                Text("K").font(.caption.bold()).foregroundColor(.gray).frame(width: 34)
                Slider(value: Binding(get: { Double(camera.displayedKelvin > 0 ? camera.displayedKelvin : 5000) },
                                      set: { camera.setKelvin(Float(($0 / 50).rounded() * 50)) }), in: 2000...10000, step: 50).tint(Theme.accent)
            }
            HStack {
                Text("TINT").font(.caption.bold()).foregroundColor(.gray).frame(width: 34)
                Slider(value: Binding(get: { Double(camera.wbManual || camera.wbLocked ? camera.tint : camera.live.tint) },
                                      set: { camera.setKelvin(camera.displayedKelvin, tint: Float($0.rounded())) }), in: -100...100, step: 1).tint(Theme.accent)
                Text(String(format: "%+.0f", camera.wbManual || camera.wbLocked ? camera.tint : camera.live.tint)).font(.system(size: 11, design: .monospaced)).foregroundColor(.gray).frame(width: 34)
            }
        }
    }
}
