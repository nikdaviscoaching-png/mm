import SwiftUI
import SpecimenCore

/// Shown after processing: FINAL IMAGE with SAVE · EXPORT · COMPARE · REPROCESS · DISCARD.
struct ReviewView: View {
    let state: ReviewState
    @EnvironmentObject var processing: ProcessingService
    @EnvironmentObject var settings: AppSettings
    @State private var finalImage: UIImage?
    @State private var sources: [(label: String, url: URL)] = []
    @State private var sourceImage: UIImage?
    @State private var compare = false
    @State private var sourceIndex = 0
    @State private var showReprocess = false
    @State private var confirmDiscard = false
    @State private var share: ShareItem?
    @State private var saving = false

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 0) {
                    Text(compare ? "SOURCE FRAME \(sourceIndex + 1)/\(max(sources.count, 1))" : "FINAL IMAGE").font(.system(size: 13, weight: .heavy)).foregroundColor(Theme.accent)
                    Text("\(state.processed.width) × \(state.processed.height)  ·  \(state.project.type.title) STACK  ·  \(state.project.quality.title)").font(.system(size: 10, design: .monospaced)).foregroundColor(.gray)
                }
                Spacer()
            }.padding(10)

            ZStack {
                ZoomableImageView(image: compare ? sourceImage : finalImage)
                if finalImage == nil { ProgressView().tint(.white) }
            }

            if compare {
                VStack(spacing: 6) {
                    if !sources.isEmpty {
                        Text(sources[min(sourceIndex, sources.count - 1)].label).font(.system(size: 11, design: .monospaced)).foregroundColor(.gray)
                        Slider(value: Binding(get: { Double(sourceIndex) }, set: { sourceIndex = Int($0.rounded()); loadSource() }), in: 0...Double(max(sources.count - 1, 1)), step: 1).tint(Theme.accent)
                    } else {
                        Text("Source frames are no longer available.").font(.footnote).foregroundColor(.gray)
                    }
                }.padding(.horizontal, 14).padding(.vertical, 6)
            }

            if !processing.warnings.isEmpty {
                ForEach(processing.warnings, id: \.self) { Text("⚠︎ \($0)").font(.system(size: 11)).foregroundColor(.yellow).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12) }
            }
            if let b = state.processed.lightingBaseIndex {
                Text("Lighting base: position \(b + 1)  ·  contribution \(state.processed.lightingContribution.map { String(format: "%.0f%%", $0 * 100) }.joined(separator: " / "))")
                    .font(.system(size: 10, design: .monospaced)).foregroundColor(.gray).padding(.horizontal, 12).frame(maxWidth: .infinity, alignment: .leading)
            }

            HStack(spacing: 8) {
                Button { Task { saving = true; _ = await processing.save(state); saving = false } } label: { Text(saving ? "SAVING…" : "SAVE").frame(maxWidth: .infinity) }.buttonStyle(ActionStyle()).disabled(saving)
                Button("EXPORT") { share = ShareItem(urls: [state.processed.finalURL]) }.buttonStyle(ActionStyle(prominent: false))
                Button(compare ? "FINAL" : "COMPARE") { compare.toggle(); if compare { loadSource() } }.buttonStyle(ActionStyle(prominent: false))
            }.padding(.horizontal, 10).padding(.top, 8)
            HStack(spacing: 8) {
                Button("REPROCESS") { showReprocess = true }.buttonStyle(ActionStyle(prominent: false)).frame(maxWidth: .infinity)
                Button("DISCARD") { confirmDiscard = true }.buttonStyle(ActionStyle(color: Theme.danger, prominent: false)).frame(maxWidth: .infinity)
            }.padding(.horizontal, 10).padding(.vertical, 8)
            Text(settings.keepSourceFrames ? "Source frames will be kept after SAVE." : "After SAVE the source frames and intermediates are deleted, leaving this one image.")
                .font(.system(size: 10)).foregroundColor(.gray).padding(.bottom, 6)
        }
        .background(Color.black.ignoresSafeArea()).foregroundColor(.white)
        .task { await loadAll() }
        .sheet(item: $share) { ShareSheet(urls: $0.urls) }
        .sheet(isPresented: $showReprocess) { ReprocessSheet(state: state) }
        .confirmationDialog("Discard this result?", isPresented: $confirmDiscard, titleVisibility: .visible) {
            Button("Delete everything (frames too)", role: .destructive) { processing.discard(state, deleteEverything: true) }
            Button("Keep source frames for later") { processing.discard(state, deleteEverything: false) }
            Button("Cancel", role: .cancel) {}
        } message: { Text("Keeping the frames lets you resume processing from the recovery list.") }
    }

    private func loadAll() async {
        let url = state.processed.finalURL
        finalImage = await Task.detached(priority: .userInitiated) { ThumbnailService.image(for: url, maxPixel: 3000) }.value
        let store = processing.store
        let p = state.project
        sources = p.groups.enumerated().flatMap { gi, g in
            g.frames.enumerated().map { fi, f -> (label: String, url: URL) in
                var label = f.fileName
                if let lp = g.lightingPosition { label = "light position \(lp + 1)" + (g.frames.count > 1 ? ", focus frame \(fi + 1)" : "") }
                else if let pos = f.focusPosition { label = "focus frame \(fi + 1)  (lens position \(String(format: "%.3f", pos)))" }
                return (label: label, url: store.frameURL(project: p, frame: f))
            }
        }.filter { FileManager.default.fileExists(atPath: $0.url.path) }
    }

    private func loadSource() {
        guard sourceIndex < sources.count else { sourceImage = nil; return }
        let url = sources[sourceIndex].url
        Task { sourceImage = await Task.detached(priority: .userInitiated) { ThumbnailService.image(for: url, maxPixel: 3000) }.value }
    }
}

struct ReprocessSheet: View {
    let state: ReviewState
    @EnvironmentObject var processing: ProcessingService
    @Environment(\.dismiss) private var dismiss
    @State private var quality: StackQuality = .maximum
    @State private var base = -1

    var body: some View {
        NavigationStack {
            Form {
                Section("Quality preset") {
                    Picker("Preset", selection: $quality) { ForEach(StackQuality.allCases, id: \.self) { Text($0.title).tag($0) } }.pickerStyle(.inline)
                }
                if state.project.type != .focus {
                    Section {
                        Picker("Lighting base", selection: $base) {
                            Text("Automatic (cleanest)").tag(-1)
                            ForEach(0..<state.project.groups.count, id: \.self) { Text("Light position \($0 + 1)").tag($0) }
                        }
                    } header: { Text("Lighting") } footer: {
                        Text("The base position defines the overall lighting direction. Other positions only replace glare, reflections and badly exposed areas.")
                    }
                }
                Section { Text("Reprocessing starts again from the untouched source frames.").font(.footnote).foregroundColor(.secondary) }
            }
            .navigationTitle("Reprocess").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Reprocess") { dismiss(); Task { await processing.reprocess(state, quality: quality, lightingBase: base < 0 ? nil : base) } } }
            }
            .onAppear { quality = state.project.quality; base = state.project.preferredLightingBase ?? -1 }
        }
        .presentationDetents([.medium, .large])
    }
}
