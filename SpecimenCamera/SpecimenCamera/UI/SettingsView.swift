import SwiftUI
import SpecimenCore

struct SettingsView: View {
    @EnvironmentObject var settings: AppSettings
    @EnvironmentObject var camera: CameraController
    @EnvironmentObject var overlay: OverlayAnalyzer
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("Focus assist") {
                    Picker("Focus Peaking", selection: $settings.peaking) { ForEach(PeakingSensitivity.allCases, id: \.self) { Text($0.title).tag($0) } }
                    Picker("Peaking Color", selection: $settings.peakingColor) { ForEach(PeakingColor.allCases, id: \.self) { Text($0.title).tag($0) } }
                    Toggle("High-resolution focus assist (4×/8×)", isOn: $settings.highResFocusAssist)
                    if !overlay.usingGPU { Text("Metal is unavailable: peaking runs on the CPU at reduced resolution and the magnifier is disabled.").font(.footnote).foregroundColor(.yellow) }
                }
                Section("Exposure aids") {
                    Picker("Zebras", selection: $settings.zebra) { ForEach(ZebraLevel.allCases, id: \.self) { Text($0.title).tag($0) } }
                    Picker("Histogram", selection: $settings.histogram) { ForEach(HistogramMode.allCases, id: \.self) { Text($0.title).tag($0) } }
                }
                Section {
                    Picker("Shutter delay", selection: $settings.shutterDelaySeconds) {
                        Text("Off").tag(0); Text("2 seconds").tag(2); Text("5 seconds").tag(5)
                    }
                } header: { Text("Shutter") } footer: {
                    Text("Waits after you press the shutter so the phone stops shaking before the exposure. Applies to single photos, the first frame of a stack and each lighting frame. Recommended on a tripod or stand.")
                }
                Section("Composition") {
                    Picker("Grid", selection: $settings.grid) { ForEach(GridStyle.allCases, id: \.self) { Text($0.title).tag($0) } }
                    Toggle("Center crosshair", isOn: $settings.showCrosshair)
                    Toggle("Level indicator", isOn: $settings.showLevel)
                    Toggle("Live info", isOn: $settings.showLiveInfo)
                }
                Section {
                    Toggle("Keep Stack Source Frames", isOn: $settings.keepSourceFrames)
                } header: { Text("Stacks") } footer: {
                    Text("Off (default): source frames and every intermediate are deleted once the final image is saved and verified, leaving one image. On: sources are kept in an organised folder in the app.")
                }
                Section("Stack output") {
                    Picker("Default Final Format", selection: $settings.defaultFinalFormat) { ForEach(FinalFormat.stackFormats, id: \.self) { Text($0.title).tag($0) } }
                    Picker("Default Stack Quality", selection: $settings.stackQuality) { ForEach(StackQuality.allCases, id: \.self) { Text($0.title).tag($0) } }
                    Picker("Focus step density", selection: $settings.stackDensity) { ForEach(StackDensity.allCases, id: \.self) { Text($0.title).tag($0) } }
                    Picker("Save Final To", selection: $settings.saveDestination) { ForEach(SaveDestination.allCases, id: \.self) { Text($0.title).tag($0) } }
                }
                Section("Camera") {
                    LabeledContent("Rear cameras", value: camera.capabilities.lenses.map { $0.name }.joined(separator: ", "))
                    LabeledContent("LiDAR", value: camera.capabilities.hasLiDAR ? "Available" : "Not available")
                    LabeledContent("Device", value: camera.capabilities.deviceModel)
                }
                Section("Developer") {
                    Toggle("Developer tools", isOn: $settings.developerTools)
                    if settings.developerTools { NavigationLink("Run test pipelines") { DebugPipelineView() } }
                }
                Section {
                    Text("SPECIMEN CAMERA works fully offline. No accounts, no analytics, no cloud processing. Images leave your phone only when you export or share them.").font(.footnote).foregroundColor(.secondary)
                }
            }
            .navigationTitle("Settings").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}

struct CollectionPickerView: View {
    @EnvironmentObject var library: LibraryService
    @Environment(\.dismiss) private var dismiss
    @State private var newName = ""
    @State private var renaming: SpecimenCollection?
    @State private var renameText = ""

    var body: some View {
        NavigationStack {
            List {
                Section("New captures go to") {
                    ForEach(library.collections) { c in
                        Button {
                            library.setActive(c.id); dismiss()
                        } label: {
                            HStack {
                                Text(c.name).foregroundColor(.primary)
                                Spacer()
                                Text("\(library.items(in: c.id).count)").foregroundColor(.secondary)
                                if c.id == library.activeCollection.id { Image(systemName: "checkmark").foregroundColor(Theme.accent) }
                            }
                        }
                        .swipeActions {
                            Button("Rename") { renaming = c; renameText = c.name }.tint(.blue)
                            if library.collections.count > 1 { Button("Delete", role: .destructive) { library.deleteCollection(c.id) } }
                        }
                    }
                }
                Section("New collection") {
                    HStack {
                        TextField("e.g. Kentucky Agate, eBay Queue", text: $newName)
                        Button("Add") { library.createCollection(newName); newName = ""; dismiss() }.disabled(newName.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
                Section { Text("Deleting a collection moves its images to another collection — images are never deleted this way.").font(.footnote).foregroundColor(.secondary) }
            }
            .navigationTitle("Change Collection").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            .alert("Rename collection", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
                TextField("Name", text: $renameText)
                Button("Save") { if let r = renaming { library.rename(r.id, to: renameText) }; renaming = nil }
                Button("Cancel", role: .cancel) { renaming = nil }
            }
        }
    }
}
