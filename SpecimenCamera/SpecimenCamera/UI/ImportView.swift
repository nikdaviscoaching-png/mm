import SwiftUI
import PhotosUI
import SpecimenCore

/// IMPORT STACK: pick images from Photos or Files, choose the stack type, check/adjust the grouping, then process.
/// Originals are never modified or deleted; working copies live in the app sandbox and are cleaned up per the Keep Sources setting.
struct ImportView: View {
    @EnvironmentObject var importer: ImportService
    @EnvironmentObject var processing: ProcessingService
    @EnvironmentObject var settings: AppSettings
    @Environment(\.dismiss) private var dismiss
    @State private var type: StackType = .focus
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var showFiles = false
    @State private var framesPerGroup = 0
    @State private var startsGroup: [UUID: Bool] = [:]
    @State private var explanation = ""
    @State private var needsReview = false

    var body: some View {
        NavigationStack {
            List {
                Section("Stack type") {
                    Picker("Type", selection: $type) { ForEach(StackType.allCases, id: \.self) { Text($0.title.capitalized).tag($0) } }.pickerStyle(.segmented)
                    Text(typeHelp).font(.footnote).foregroundColor(.secondary)
                }
                Section("Images") {
                    PhotosPicker(selection: $pickerItems, matching: .images, photoLibrary: .shared()) { Label("Choose from Photos", systemImage: "photo.on.rectangle") }
                    Button { showFiles = true } label: { Label("Choose from Files", systemImage: "folder") }
                    Text("JPEG, HEIF/HEIC, TIFF, DNG and ProRAW are accepted. Originals are never modified or deleted.").font(.footnote).foregroundColor(.secondary)
                    if importer.isLoading { ProgressView("Reading…") }
                }
                if !importer.files.isEmpty {
                    if type == .combined {
                        Section {
                            Stepper(framesPerGroup == 0 ? "Frames per light position: auto-detect" : "Frames per light position: \(framesPerGroup)", value: $framesPerGroup, in: 0...60)
                                .onChange(of: framesPerGroup) { _, _ in regroup() }
                            if !explanation.isEmpty { Text(explanation).font(.footnote).foregroundColor(needsReview ? .yellow : .secondary) }
                        } header: { Text("Grouping") } footer: { Text("Toggle “new light position” on the first frame of each position if the detected grouping is wrong.") }
                    }
                    Section("\(importer.files.count) image(s)") {
                        ForEach(importer.files) { f in
                            HStack(spacing: 10) {
                                if let t = ThumbnailService.image(for: f.stagedURL, maxPixel: 100) { Image(uiImage: t).resizable().scaledToFill().frame(width: 48, height: 48).clipShape(RoundedRectangle(cornerRadius: 6)) }
                                VStack(alignment: .leading) {
                                    Text(f.displayName).font(.footnote).lineLimit(1)
                                    Text([f.candidate.captureDate.map { $0.formatted(date: .omitted, time: .standard) }, f.candidate.iso.map { "ISO \(Int($0))" }, f.candidate.exposureSeconds.map { ExposureScales.shutterLabel($0) }].compactMap { $0 }.joined(separator: " · "))
                                        .font(.caption2).foregroundColor(.secondary)
                                }
                                Spacer()
                                if type == .combined { Toggle("new light position", isOn: binding(for: f)).labelsHidden().toggleStyle(.switch).scaleEffect(0.8) }
                            }
                        }.onDelete { idx in
                            for i in idx { try? FileManager.default.removeItem(at: importer.files[i].stagedURL) }
                            importer.removeFiles(at: idx); regroup()
                        }
                    }
                }
                Section {
                    Button("IMPORT & PROCESS") { Task { await go() } }.buttonStyle(ActionStyle()).disabled(!canImport)
                }
            }
            .navigationTitle("Import Stack").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { importer.clear(); dismiss() } } }
            .onChange(of: pickerItems) { _, items in
                Task { await importer.load(from: items); pickerItems = []; regroup() }
            }
            .fileImporter(isPresented: $showFiles, allowedContentTypes: ImportService.allowedTypes, allowsMultipleSelection: true) { result in
                if case .success(let urls) = result { Task { await importer.load(fileURLs: urls); regroup() } }
            }
            .onChange(of: type) { _, _ in regroup() }
            .alert("Import", isPresented: Binding(get: { importer.errorMessage != nil }, set: { if !$0 { importer.errorMessage = nil } })) {
                Button("OK", role: .cancel) {}
            } message: { Text(importer.errorMessage ?? "") }
        }
    }

    private var typeHelp: String {
        switch type {
        case .focus: return "All images form one focus series (ordered by focus distance if the metadata has it, otherwise by capture time)."
        case .lighting: return "Each image is one light position, in capture order."
        case .combined: return "Images are grouped into light positions (by pauses between series, or a fixed number of frames), each a focus series."
        }
    }

    private var canImport: Bool {
        switch type {
        case .focus, .lighting: return importer.files.count >= 2
        case .combined: return buildGroups().count >= 2 && !importer.isLoading
        }
    }

    private func binding(for f: ImportedFile) -> Binding<Bool> {
        Binding(get: { startsGroup[f.id] ?? false }, set: { startsGroup[f.id] = $0 })
    }

    private func regroup() {
        guard type == .combined, !importer.files.isEmpty else { startsGroup = [:]; explanation = ""; return }
        let g = ImportGrouper.group(importer.files.map { $0.candidate }, type: .combined, framesPerGroup: framesPerGroup == 0 ? nil : framesPerGroup)
        explanation = g.explanation; needsReview = g.needsManualReview
        var map: [UUID: Bool] = [:]
        let byURL = Dictionary(uniqueKeysWithValues: importer.files.map { ($0.stagedURL, $0.id) })
        for grp in g.groups { if let first = grp.first, let id = byURL[first.url] { map[id] = true } }
        startsGroup = map
        importer.sortByCandidateOrder()
    }

    private func buildGroups() -> [[ImportedFile]] {
        switch type {
        case .focus: return [ImportGrouper.ordered(importer.files.map { $0.candidate }, type: .focus).compactMap { c in importer.files.first { $0.stagedURL == c.url } }]
        case .lighting: return ImportGrouper.ordered(importer.files.map { $0.candidate }, type: .lighting).compactMap { c in importer.files.first { $0.stagedURL == c.url } }.map { [$0] }
        case .combined:
            var groups: [[ImportedFile]] = []
            for (i, f) in importer.files.enumerated() {
                if i == 0 || (startsGroup[f.id] ?? false) { groups.append([f]) } else { groups[groups.count - 1].append(f) }
            }
            return groups
        }
    }

    private func go() async {
        do {
            let p = try importer.makeProject(type: type, groups: buildGroups())
            var q = p; q.keepSourceFrames = settings.keepSourceFrames; q.finalFormat = settings.defaultFinalFormat
            q.quality = settings.stackQuality; q.saveDestination = settings.saveDestination
            try processing.store.save(q)
            dismiss()
            await processing.process(projectID: p.id)
        } catch { importer.errorMessage = error.localizedDescription }
    }
}
