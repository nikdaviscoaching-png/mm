import SwiftUI
import SpecimenCore

struct LibraryView: View {
    @EnvironmentObject var library: LibraryService
    @Environment(\.dismiss) private var dismiss
    @State private var filter: UUID?
    private let columns = [GridItem(.adaptive(minimum: 100), spacing: 4)]

    var body: some View {
        NavigationStack {
            ScrollView {
                let shown = library.items.filter { filter == nil || $0.collectionID == filter }
                if shown.isEmpty {
                    Text("No images yet. Captures go to the current collection automatically.").foregroundColor(.secondary).padding(40).multilineTextAlignment(.center)
                }
                LazyVGrid(columns: columns, spacing: 4) {
                    ForEach(shown) { item in
                        NavigationLink { ItemDetailView(itemID: item.id) } label: {
                            ZStack(alignment: .bottomLeading) {
                                Group {
                                    if let t = library.thumbnail(item) { Image(uiImage: t).resizable().scaledToFill() } else { Color.gray.opacity(0.3) }
                                }.frame(minHeight: 100).aspectRatio(1, contentMode: .fill).clipped()
                                if item.kind != .single {
                                    Text(item.kind.rawValue.uppercased()).font(.system(size: 9, weight: .heavy)).padding(3).background(Theme.accent).foregroundColor(.black).padding(3)
                                }
                            }
                        }
                    }
                }.padding(4)
            }
            .navigationTitle("Library").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button("All collections") { filter = nil }
                        ForEach(library.collections) { c in Button(c.name) { filter = c.id } }
                    } label: { Label(filter.flatMap { id in library.collections.first { $0.id == id }?.name } ?? "All", systemImage: "line.3.horizontal.decrease.circle") }
                }
            }
        }
    }
}

struct ItemDetailView: View {
    let itemID: UUID
    @EnvironmentObject var library: LibraryService
    @Environment(\.dismiss) private var dismiss
    @State private var notes = ""
    @State private var share: ShareItem?
    @State private var message: String?
    @State private var confirmDelete = false
    @State private var showMeasure = false
    @State private var busy = false

    var item: LibraryItem? { library.items.first { $0.id == itemID } }

    var body: some View {
        if let item {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if let img = ThumbnailService.image(for: library.masterURL(item), maxPixel: 1800) {
                        Image(uiImage: img).resizable().scaledToFit().frame(maxWidth: .infinity)
                    }
                    metadata(item)
                    TextField("Specimen notes", text: $notes, axis: .vertical).textFieldStyle(.roundedBorder).lineLimit(2...6)
                        .onSubmit { save(item) }
                    HStack {
                        Button("FULL QUALITY") { export(item, web: false) }.buttonStyle(ActionStyle())
                        Button("WEB / EBAY COPY") { export(item, web: true) }.buttonStyle(ActionStyle(prominent: false))
                    }.disabled(busy)
                    HStack {
                        Button("SAVE TO PHOTOS") { Task { await toPhotos(item) } }.buttonStyle(ActionStyle(prominent: false))
                        Button("MEASURE / SCALE") { showMeasure = true }.buttonStyle(ActionStyle(prominent: false))
                    }
                    Menu {
                        ForEach(library.collections) { c in Button(c.name) { library.move(item, to: c.id) } }
                    } label: { Label("Move to collection", systemImage: "folder") }
                    Button("Delete image", role: .destructive) { confirmDelete = true }
                    if let m = message { Text(m).font(.footnote).foregroundColor(.secondary) }
                }.padding()
            }
            .navigationTitle(item.kind == .single ? "Photo" : item.kind.rawValue.capitalized + " Stack")
            .navigationBarTitleDisplayMode(.inline)
            .onAppear { notes = item.notes }
            .onDisappear { save(item) }
            .sheet(item: $share) { ShareSheet(urls: $0.urls) }
            .sheet(isPresented: $showMeasure) { MeasurementView(itemID: item.id) }
            .confirmationDialog("Delete this image from the app?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete", role: .destructive) { library.delete(item); dismiss() }
            }
        }
    }

    private func metadata(_ i: LibraryItem) -> some View {
        let df = DateFormatter(); df.dateStyle = .medium; df.timeStyle = .short
        var rows: [(String, String)] = [
            ("Captured", df.string(from: i.captureDate)), ("Size", "\(i.width) × \(i.height)  (\(String(format: "%.1f", Double(i.width * i.height) / 1e6)) MP)"),
            ("Format", i.finalFormat.title), ("Lens", i.lensName + (i.equivalentFocalLength.map { " (\(Int($0)) mm eq.)" } ?? "")),
        ]
        if let iso = i.iso, let s = i.shutterSeconds { rows.append(("Exposure", "ISO \(Int(iso)) · \(ExposureScales.shutterLabel(s))")) }
        if let k = i.whiteBalanceKelvin { rows.append(("White balance", "\(Int(k)) K")) }
        rows.append(("Capture type", i.captureFormat.title + (i.sourceWasProRAW ? " (ProRAW source)" : i.sourceWasRAW ? " (RAW source)" : "")))
        if i.focusFrameCount > 0 { rows.append(("Focus frames", "\(i.focusFrameCount)")) }
        if i.lightingFrameCount > 0 { rows.append(("Light positions", "\(i.lightingFrameCount)")) }
        if let s = i.scale { rows.append(("Scale", String(format: "%.2f px/mm — %@", s.pixelsPerMillimeter, s.accuracyNote))) }
        return VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, r in
                HStack(alignment: .top) { Text(r.0).foregroundColor(.secondary).frame(width: 110, alignment: .leading); Text(r.1) }.font(.footnote)
            }
        }
    }

    private func save(_ i: LibraryItem) { guard notes != i.notes else { return }; var c = i; c.notes = notes; library.update(c) }

    private func export(_ i: LibraryItem, web: Bool) {
        busy = true; message = nil
        let master = library.masterURL(i)
        Task {
            do {
                let url = try await Task.detached { web ? try ExportService.webCopy(of: i, master: master) : try ExportService.fullQualityCopy(of: i, master: master) }.value
                share = ShareItem(urls: [url])
            } catch { message = error.localizedDescription }
            busy = false
        }
    }

    private func toPhotos(_ i: LibraryItem) async {
        do { try await PhotosSaver.save(fileURL: library.masterURL(i), creationDate: i.captureDate); message = "Saved to Photos." }
        catch { message = error.localizedDescription }
    }
}
