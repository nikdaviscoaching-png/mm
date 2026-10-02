import SwiftUI
import SpecimenCore

// MARK: - Folders

/// All folders (collections): obvious "New folder" button, which folder receives new photos, rename/delete, open.
struct FoldersView: View {
    @EnvironmentObject var library: LibraryService
    @State private var showingNewFolder = false
    @State private var newFolderName = ""
    @State private var renaming: SpecimenCollection?
    @State private var renameText = ""
    @State private var deleting: SpecimenCollection?
    @State private var errorMessage: String?

    var body: some View {
        List {
            Section {
                ForEach(library.collections) { c in
                    NavigationLink { FolderDetailView(collectionID: c.id) } label: { FolderRow(collection: c, active: c.id == library.activeCollection.id) }
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button(role: .destructive) { deleting = c } label: { Label("Delete", systemImage: "trash") }.disabled(library.collections.count < 2)
                            Button { renameText = c.name; renaming = c } label: { Label("Rename", systemImage: "pencil") }.tint(.blue)
                        }
                        .swipeActions(edge: .leading) {
                            Button { library.setActive(c.id) } label: { Label("Save here", systemImage: "checkmark.circle") }.tint(.green)
                        }
                        .contextMenu {
                            Button { library.setActive(c.id) } label: { Label("Save new photos here", systemImage: "checkmark.circle") }
                            Button { renameText = c.name; renaming = c } label: { Label("Rename", systemImage: "pencil") }
                            if library.collections.count > 1 { Button(role: .destructive) { deleting = c } label: { Label("Delete", systemImage: "trash") } }
                        }
                }
            } footer: {
                Text("New photos are saved in the folder with the green check. Swipe a folder right to make it the save folder, left to rename or delete it.")
            }
            Section {
                Button { newFolderName = ""; showingNewFolder = true } label: { Label("New folder", systemImage: "folder.badge.plus").font(.system(size: 16, weight: .semibold)) }
            }
        }
        .navigationTitle("Folders")
        .toolbar { ToolbarItem(placement: .primaryAction) { Button { newFolderName = ""; showingNewFolder = true } label: { Label("New folder", systemImage: "folder.badge.plus") } } }
        .refreshable { library.reload() }
        .alert("New folder", isPresented: $showingNewFolder) {
            TextField("Name", text: $newFolderName)
            Button("Create") { create() }
            Button("Cancel", role: .cancel) {}
        } message: { Text("It becomes the folder new photos are saved in.") }
        .alert("Rename folder", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Name", text: $renameText)
            Button("Rename") { if let r = renaming { rename(r) }; renaming = nil }
            Button("Cancel", role: .cancel) { renaming = nil }
        }
        .confirmationDialog(deleting.map { "Delete “\($0.name)”?" } ?? "", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            Button("Delete folder", role: .destructive) { if let d = deleting { library.deleteCollection(d.id) }; deleting = nil }
        } message: {
            Text("Its photos are not deleted: they move to another folder.")
        }
        .alert("Couldn't do that", isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })) { Button("OK", role: .cancel) {} } message: { Text(errorMessage ?? "") }
    }

    private func create() {
        let name = newFolderName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { errorMessage = "Give the folder a name."; return }
        if library.collections.contains(where: { $0.name.caseInsensitiveCompare(name) == .orderedSame }) { errorMessage = "A folder called “\(name)” already exists."; return }
        library.createCollection(name)
    }

    private func rename(_ c: SpecimenCollection) {
        let name = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { errorMessage = "Give the folder a name."; return }
        library.rename(c.id, to: name)
    }
}

struct FolderRow: View {
    @EnvironmentObject var library: LibraryService
    let collection: SpecimenCollection
    let active: Bool

    var body: some View {
        let items = library.items(in: collection.id)
        HStack(spacing: 12) {
            ThumbView(url: items.first.flatMap { library.store.thumbnailURL(for: $0) ?? library.masterURL($0) }, maxPixel: 160)
                .frame(width: 56, height: 56).clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay { if items.isEmpty { Image(systemName: "folder").foregroundColor(.secondary) } }
            VStack(alignment: .leading, spacing: 2) {
                Text(collection.name).font(.system(size: 16, weight: .semibold))
                Text(items.count == 1 ? "1 photo" : "\(items.count) photos").font(.footnote).foregroundColor(.secondary)
                if active { Text("New photos save here").font(.caption.weight(.semibold)).foregroundColor(.green) }
            }
            Spacer()
            if active { Image(systemName: "checkmark.circle.fill").foregroundColor(.green).imageScale(.large).accessibilityLabel("New photos save here") }
        }.padding(.vertical, 2)
    }
}

// MARK: - Folder contents

struct FolderDetailView: View {
    let collectionID: UUID
    @EnvironmentObject var library: LibraryService
    @State private var selecting = false
    @State private var selection = Set<UUID>()
    @State private var viewer: ViewerStart?
    @State private var showMove = false
    @State private var confirmDelete = false
    @State private var share: ShareItem?
    private let columns = [GridItem(.adaptive(minimum: 100), spacing: 2)]

    struct ViewerStart: Identifiable { let id = UUID(); let index: Int }

    private var collection: SpecimenCollection? { library.collections.first { $0.id == collectionID } }
    private var items: [SpecimenCore.LibraryItem] { library.items(in: collectionID).sorted { $0.captureDate > $1.captureDate } }
    private var selectedItems: [SpecimenCore.LibraryItem] { items.filter { selection.contains($0.id) } }

    var body: some View {
        let shown = items
        ScrollView {
            if shown.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "photo.on.rectangle.angled").font(.system(size: 40)).foregroundColor(.secondary)
                    Text("No photos in this folder yet.").foregroundColor(.secondary)
                }.padding(60)
            }
            LazyVGrid(columns: columns, spacing: 2) {
                ForEach(Array(shown.enumerated()), id: \.element.id) { i, item in
                    Button { if selecting { toggle(item.id) } else { viewer = ViewerStart(index: i) } } label: { cell(item) }.buttonStyle(.plain)
                }
            }
        }
        .navigationTitle(collection?.name ?? "Folder").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                HStack {
                    if !selecting, collectionID != library.activeCollection.id {
                        Button { library.setActive(collectionID) } label: { Label("Save new photos here", systemImage: "checkmark.circle") }
                    }
                    Button(selecting ? "Done" : "Select") { selecting.toggle(); selection.removeAll() }.disabled(shown.isEmpty)
                }
            }
            ToolbarItemGroup(placement: .bottomBar) {
                if selecting {
                    Button { shareSelected() } label: { Label("Share", systemImage: "square.and.arrow.up") }.disabled(selection.isEmpty)
                    Spacer()
                    Text(selection.isEmpty ? "Select photos" : "\(selection.count) selected").font(.footnote)
                    Spacer()
                    Button { showMove = true } label: { Label("Move", systemImage: "folder") }.disabled(selection.isEmpty)
                    Button(role: .destructive) { confirmDelete = true } label: { Label("Delete", systemImage: "trash") }.disabled(selection.isEmpty)
                }
            }
        }
        .fullScreenCover(item: $viewer) { v in
            PhotoViewer(photos: shown.map { ViewerPhoto(id: $0.id, url: library.masterURL($0)) }, startIndex: v.index).environmentObject(library)
        }
        .sheet(isPresented: $showMove) {
            MoveToFolderSheet(items: selectedItems, from: collectionID) { selection.removeAll(); selecting = false }.environmentObject(library)
        }
        .sheet(item: $share) { ShareSheet(urls: $0.urls) }
        .confirmationDialog("Delete \(selection.count) photo\(selection.count == 1 ? "" : "s") from the app?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                for item in selectedItems { ZoomCache.remove(for: library.masterURL(item)); library.delete(item) }
                selection.removeAll(); selecting = false
            }
        }
    }

    private func cell(_ item: SpecimenCore.LibraryItem) -> some View {
        ZStack(alignment: .bottomLeading) {
            ThumbView(url: library.store.thumbnailURL(for: item) ?? library.masterURL(item), maxPixel: 360)
                .aspectRatio(1, contentMode: .fill).clipped()
            if item.kind != .single {
                Text(item.kind.rawValue.uppercased()).font(.system(size: 9, weight: .heavy)).padding(3).background(Theme.accent).foregroundColor(.black).padding(3)
            }
            if selecting {
                let on = selection.contains(item.id)
                Color.black.opacity(on ? 0.25 : 0)
                Image(systemName: on ? "checkmark.circle.fill" : "circle").foregroundColor(on ? .accentColor : .white).font(.system(size: 20)).padding(5)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
            }
        }
    }

    private func toggle(_ id: UUID) { if selection.contains(id) { selection.remove(id) } else { selection.insert(id) } }
    private func shareSelected() { share = ShareItem(urls: selectedItems.map { library.masterURL($0) }) }
}

// MARK: - Move

struct MoveToFolderSheet: View {
    let items: [SpecimenCore.LibraryItem]
    let from: UUID
    var onMoved: () -> Void
    @EnvironmentObject var library: LibraryService
    @Environment(\.dismiss) private var dismiss
    @State private var showingNew = false
    @State private var newName = ""

    var body: some View {
        NavigationStack {
            List {
                Section("Move \(items.count) photo\(items.count == 1 ? "" : "s") to") {
                    ForEach(library.collections.filter { $0.id != from }) { c in
                        Button { move(to: c.id) } label: {
                            HStack { Image(systemName: "folder"); Text(c.name); Spacer(); Text("\(library.items(in: c.id).count)").foregroundColor(.secondary) }
                        }
                    }
                    Button { newName = ""; showingNew = true } label: { Label("New folder…", systemImage: "folder.badge.plus") }
                }
            }
            .navigationTitle("Move").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .alert("New folder", isPresented: $showingNew) {
                TextField("Name", text: $newName)
                Button("Create & move") {
                    let name = newName.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !name.isEmpty, let id = library.createCollection(name, makeActive: false) { move(to: id) }
                }
                Button("Cancel", role: .cancel) {}
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func move(to id: UUID) {
        for item in items { library.move(item, to: id) }
        onMoved(); dismiss()
    }
}
