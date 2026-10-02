import SwiftUI
import SpecimenCore

/// Reference scale and measurement. The primary method is a manual reference (a card, ruler or known length in the picture) —
/// it is the one that can be accurate. LiDAR is offered only as a rough, clearly-labelled estimate and is refused at macro
/// distances where it cannot be trusted. Results are stored as scale metadata on the image.
struct MeasurementView: View {
    let itemID: UUID
    @EnvironmentObject var library: LibraryService
    @EnvironmentObject var camera: CameraController
    @Environment(\.dismiss) private var dismiss

    @State private var image: UIImage?
    @State private var a = CGPoint(x: 0.25, y: 0.5)         // reference points (normalised)
    @State private var b = CGPoint(x: 0.75, y: 0.5)
    @State private var c = CGPoint(x: 0.3, y: 0.7)          // measurement points
    @State private var d = CGPoint(x: 0.6, y: 0.7)
    @State private var knownMM = "85.6"
    @State private var calibration: (scale: ScaleMetadata, unc: Double)?
    @State private var showLiDAR = false
    @State private var lidarDistance: Double?
    @State private var message: String?

    private var item: SpecimenCore.LibraryItem? { library.items.first { $0.id == itemID } }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 12) {
                    GeometryReader { g in
                        let rect = imageRect(in: g.size)
                        ZStack(alignment: .topLeading) {
                            if let image { Image(uiImage: image).resizable().scaledToFit().frame(width: g.size.width, height: g.size.height) }
                            Path { p in
                                p.move(to: pt(a, rect)); p.addLine(to: pt(b, rect))
                                if calibration != nil { p.move(to: pt(c, rect)); p.addLine(to: pt(d, rect)) }
                            }.stroke(Theme.accent, lineWidth: 1.5)
                            handle($a, rect, Theme.accent)
                            handle($b, rect, Theme.accent)
                            if calibration != nil { handle($c, rect, Theme.ok); handle($d, rect, Theme.ok) }
                        }
                    }.frame(height: 340).background(Color.black)

                    GroupBox("1 · Calibrate with a reference (recommended)") {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Drag the two amber points onto the ends of an object of known length in the picture (a card, ruler or scale bar), then enter its real length.").font(.footnote).foregroundColor(.secondary)
                            HStack {
                                TextField("Known length", text: $knownMM).keyboardType(.decimalPad).textFieldStyle(.roundedBorder).frame(width: 100)
                                Text("mm")
                                Menu("Presets") {
                                    Button("Credit / ID card width — 85.6 mm") { knownMM = "85.6" }
                                    Button("US quarter — 24.26 mm") { knownMM = "24.26" }
                                    Button("US cent — 19.05 mm") { knownMM = "19.05" }
                                    Button("1 € coin — 23.25 mm") { knownMM = "23.25" }
                                    Button("A4 paper width — 210 mm") { knownMM = "210" }
                                }
                                Spacer()
                                Button("CALIBRATE") { calibrate() }.buttonStyle(ActionStyle())
                            }
                        }
                    }
                    if let cal = calibration {
                        GroupBox("2 · Measure") {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(String(format: "Scale: %.3f px/mm  (±%.1f %%)", cal.scale.pixelsPerMillimeter, cal.unc * 100)).font(.system(size: 13, design: .monospaced))
                                Text("Green points: \(String(format: "%.1f mm", ScaleEstimator.millimeters(pixels: pixelDistance(c, d), scale: cal.scale)))").font(.title3.bold()).foregroundColor(Theme.ok)
                                Text(cal.scale.accuracyNote).font(.footnote).foregroundColor(.secondary)
                                if let item, let bar = scaleBarText(item: item, scale: cal.scale) { Text("Scale bar: \(bar)").font(.footnote).foregroundColor(.secondary) }
                                Button("SAVE SCALE TO IMAGE") { saveScale(cal.scale) }.buttonStyle(ActionStyle())
                            }
                        }
                    }
                    if camera.capabilities.hasLiDAR {
                        GroupBox("LiDAR distance (rough)") {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("Estimates scale from the camera-to-specimen distance. It is only usable at about 25 cm or more and is far less accurate than a reference object.").font(.footnote).foregroundColor(.secondary)
                                Button("MEASURE DISTANCE WITH LIDAR") { camera.stop(); showLiDAR = true }.buttonStyle(ActionStyle(prominent: false))
                            }
                        }
                    }
                    if let message { Text(message).font(.footnote).foregroundColor(.yellow) }
                }.padding()
            }
            .navigationTitle("Measure / Scale").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            .task { if let item { image = await Task.detached { ThumbnailService.image(for: library.masterURL(item), maxPixel: 1600) }.value; calibration = item.scale.map { (scale: $0, unc: 0.0) } } }
            .sheet(isPresented: $showLiDAR, onDismiss: { Task { await camera.start() } }) { lidarSheet }
        }
    }

    // MARK: Geometry

    private func imageRect(in size: CGSize) -> CGRect {
        guard let image else { return CGRect(origin: .zero, size: size) }
        let ia = image.size.width / image.size.height, va = size.width / size.height
        let s = ia > va ? CGSize(width: size.width, height: size.width / ia) : CGSize(width: size.height * ia, height: size.height)
        return CGRect(x: (size.width - s.width) / 2, y: (size.height - s.height) / 2, width: s.width, height: s.height)
    }
    private func pt(_ p: CGPoint, _ r: CGRect) -> CGPoint { CGPoint(x: r.minX + p.x * r.width, y: r.minY + p.y * r.height) }

    private func handle(_ binding: Binding<CGPoint>, _ rect: CGRect, _ color: Color) -> some View {
        Circle().stroke(color, lineWidth: 2).background(Circle().fill(color.opacity(0.25))).frame(width: 30, height: 30)
            .position(pt(binding.wrappedValue, rect))
            .gesture(DragGesture(minimumDistance: 0).onChanged { v in
                binding.wrappedValue = CGPoint(x: min(max((v.location.x - rect.minX) / rect.width, 0), 1), y: min(max((v.location.y - rect.minY) / rect.height, 0), 1))
            })
    }

    /// Distance between two normalised points in pixels of the *master* image.
    private func pixelDistance(_ p: CGPoint, _ q: CGPoint) -> Double {
        guard let item else { return 0 }
        return hypot(Double(p.x - q.x) * Double(item.width), Double(p.y - q.y) * Double(item.height))
    }

    private func calibrate() {
        guard let mm = Double(knownMM.replacingOccurrences(of: ",", with: ".")), let r = ScaleEstimator.fromReference(pixelDistance: pixelDistance(a, b), knownLengthMM: mm) else {
            message = "Enter the known length and place the two points on its ends."; return
        }
        calibration = (scale: r.scale, unc: r.uncertaintyFraction); message = nil
    }

    private func saveScale(_ s: ScaleMetadata) {
        guard var i = item else { return }
        i.scale = s; library.update(i); message = "Scale saved with the image."
    }

    private func scaleBarText(item: SpecimenCore.LibraryItem, scale: ScaleMetadata) -> String? {
        let b = ScaleBar.choose(pixelsPerMillimeter: scale.pixelsPerMillimeter, imageWidthPixels: item.width)
        return "\(b.label) = \(Int(b.pixels.rounded())) px"
    }

    // MARK: LiDAR

    private var lidarSheet: some View {
        VStack(spacing: 12) {
            LiDARDistanceView(distanceMM: $lidarDistance).frame(height: 360).clipShape(RoundedRectangle(cornerRadius: 12))
            if let d = lidarDistance {
                Text(String(format: "%.0f mm to the centre of the view", d)).font(.title3.bold())
                verdictView(d)
            } else { Text("Point the phone at the specimen…").foregroundColor(.secondary) }
            Button("Close") { showLiDAR = false }.buttonStyle(ActionStyle(prominent: false))
        }.padding()
    }

    @ViewBuilder private func verdictView(_ d: Double) -> some View {
        switch ScaleEstimator.assessLiDAR(distanceMM: d) {
        case .notRecommended(let reason):
            Text(reason).font(.footnote).foregroundColor(Theme.danger)
        case .reliable(let u), .rough(let u, _):
            Text(String(format: "Estimated uncertainty ±%.0f %% — rough. A reference object is more accurate.", u * 100)).font(.footnote).foregroundColor(.yellow)
            Button("USE AS SCALE (ROUGH)") { useLiDAR(d, uncertainty: u) }.buttonStyle(ActionStyle())
        }
    }

    private func useLiDAR(_ d: Double, uncertainty u: Double) {
        guard let item, let f = item.equivalentFocalLength,
              let fpx = ScaleEstimator.focalLengthPixels(equivalentFocalLengthMM: f, imageWidth: item.width, imageHeight: item.height),
              let ppm = ScaleEstimator.fromDistance(distanceMM: d, focalLengthPixels: fpx) else { message = "This image has no lens data, so LiDAR cannot be used for scale."; return }
        let meta = ScaleMetadata(pixelsPerMillimeter: ppm, method: .lidar, accuracyNote: String(format: "rough ±%.0f %% (LiDAR distance %.0f mm; assumes the same framing as the picture)", max(u, 0.05) * 100, d))
        calibration = (scale: meta, unc: max(u, 0.05)); showLiDAR = false
        message = "Rough LiDAR estimate loaded. Use a reference object for accurate sizes."
    }
}
