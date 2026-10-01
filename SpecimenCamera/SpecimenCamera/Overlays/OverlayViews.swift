import SwiftUI
import MetalKit
import SpecimenCore

/// Transparent Metal view that draws peaking/zebras (and the magnified video) over the preview.
struct OverlayMetalView: UIViewRepresentable {
    let renderer: OverlayRenderer
    func makeUIView(context: Context) -> MTKView {
        let v = MTKView()
        renderer.attach(v)
        v.isUserInteractionEnabled = false
        return v
    }
    func updateUIView(_ uiView: MTKView, context: Context) {}
}

/// CPU-rendered overlay used only when Metal is unavailable.
struct CPUOverlayView: View {
    let image: CGImage?
    var body: some View {
        if let image { Image(decorative: image, scale: 1).resizable().interpolation(.none).allowsHitTesting(false) }
    }
}

struct GridOverlay: View {
    let style: GridStyle
    var body: some View {
        GeometryReader { g in
            Path { p in
                let n = style.divisions
                guard n > 0 else { return }
                for i in 1..<n {
                    let x = g.size.width * CGFloat(i) / CGFloat(n), y = g.size.height * CGFloat(i) / CGFloat(n)
                    p.move(to: CGPoint(x: x, y: 0)); p.addLine(to: CGPoint(x: x, y: g.size.height))
                    p.move(to: CGPoint(x: 0, y: y)); p.addLine(to: CGPoint(x: g.size.width, y: y))
                }
            }.stroke(Color.white.opacity(style == .fine ? 0.28 : 0.45), lineWidth: 0.5)
        }.allowsHitTesting(false)
    }
}

struct CrosshairOverlay: View {
    var body: some View {
        GeometryReader { g in
            Path { p in
                let c = CGPoint(x: g.size.width / 2, y: g.size.height / 2)
                p.move(to: CGPoint(x: c.x - 14, y: c.y)); p.addLine(to: CGPoint(x: c.x + 14, y: c.y))
                p.move(to: CGPoint(x: c.x, y: c.y - 14)); p.addLine(to: CGPoint(x: c.x, y: c.y + 14))
            }.stroke(Color.white.opacity(0.8), lineWidth: 1)
        }.allowsHitTesting(false)
    }
}

/// Horizon line (upright) or two-axis bubble (phone lying flat on a stand), clear enough for tripod work.
struct LevelOverlay: View {
    let state: LevelState
    var body: some View {
        GeometryReader { g in
            let c = CGPoint(x: g.size.width / 2, y: g.size.height / 2)
            let tint: Color = state.isLevel ? .green : .yellow
            ZStack {
                switch state.mode {
                case .horizon:
                    Rectangle().fill(tint).frame(width: min(g.size.width * 0.35, 150), height: 2)
                        .rotationEffect(.degrees(-state.rollDegrees)).position(c)
                    Rectangle().fill(Color.white.opacity(0.5)).frame(width: 40, height: 1).position(c)
                case .flat:
                    Circle().stroke(Color.white.opacity(0.6), lineWidth: 1).frame(width: 70, height: 70).position(c)
                    Circle().fill(tint).frame(width: 14, height: 14)
                        .position(x: c.x - CGFloat(max(-10, min(10, state.rollDegrees))) * 3, y: c.y + CGFloat(max(-10, min(10, state.pitchDegrees))) * 3)
                }
                Text(state.mode == .flat ? String(format: "%+.1f° %+.1f°", state.rollDegrees, state.pitchDegrees) : String(format: "%+.1f°", state.rollDegrees))
                    .font(.system(size: 11, weight: .semibold, design: .monospaced)).foregroundColor(tint)
                    .position(x: c.x, y: c.y + 52)
            }
        }.allowsHitTesting(false)
    }
}

/// Compact histogram (Luma or RGB) with clipping markers.
struct HistogramView: View {
    let data: HistogramData
    let mode: HistogramMode
    var body: some View {
        ZStack(alignment: .bottomLeading) {
            RoundedRectangle(cornerRadius: 6).fill(Color.black.opacity(0.55))
            if mode == .luma { bars(data.luma, .white.opacity(0.85)) }
            if mode == .rgb {
                bars(data.red, .red.opacity(0.7)).blendMode(.screen)
                bars(data.green, .green.opacity(0.7)).blendMode(.screen)
                bars(data.blue, .blue.opacity(0.8)).blendMode(.screen)
            }
            HStack {
                Circle().fill(data.crushedShadowFraction > 0.02 ? Color.blue : Color.clear).frame(width: 6, height: 6)
                Spacer()
                Circle().fill(data.clippedHighlightFraction > 0.005 ? Color.red : Color.clear).frame(width: 6, height: 6)
            }.padding(4).frame(maxHeight: .infinity, alignment: .top)
        }
        .frame(width: 112, height: 56)
        .allowsHitTesting(false)
    }

    private func bars(_ bins: [Int], _ color: Color) -> some View {
        let n = data.normalized(bins, logScale: true)
        return GeometryReader { g in
            Path { p in
                for i in 0..<n.count {
                    let x = g.size.width * CGFloat(i) / CGFloat(n.count)
                    let h = g.size.height * CGFloat(n[i])
                    p.addRect(CGRect(x: x, y: g.size.height - h, width: max(g.size.width / CGFloat(n.count), 0.6), height: h))
                }
            }.fill(color)
        }
    }
}
