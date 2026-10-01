import SwiftUI
import SpecimenCore

/// Shown at launch when an earlier stack was interrupted: RESUME PROCESSING or DISCARD.
struct RecoveryView: View {
    @EnvironmentObject var processing: ProcessingService
    @Environment(\.dismiss) private var dismiss
    @State private var discarding: StackProject?

    var body: some View {
        NavigationStack {
            List {
                if processing.recoverable.isEmpty { Text("Nothing to recover.").foregroundColor(.secondary) }
                ForEach(processing.recoverable) { p in
                    VStack(alignment: .leading, spacing: 6) {
                        let finished = p.completedSteps.contains("final")
                        Text("\(p.type.title) STACK — \(p.frameCount) frames").font(.headline)
                        Text(p.createdDate.formatted(date: .abbreviated, time: .shortened)).font(.footnote).foregroundColor(.secondary)
                        Text(finished ? "Finished — waiting for you to review and save." : (p.failureMessage ?? "Capture or processing was interrupted. All captured frames are kept.")).font(.footnote)
                        HStack {
                            Button(finished ? "REVIEW RESULT" : "RESUME PROCESSING") { dismiss(); Task { await processing.resume(p) } }.buttonStyle(ActionStyle())
                            Button("DISCARD") { discarding = p }.buttonStyle(ActionStyle(color: Theme.danger, prominent: false))
                        }
                    }.padding(.vertical, 4)
                }
            }
            .navigationTitle("Recover").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Later") { dismiss() } } }
            .confirmationDialog("Delete this stack and all its frames?", isPresented: Binding(get: { discarding != nil }, set: { if !$0 { discarding = nil } }), titleVisibility: .visible) {
                Button("Delete frames", role: .destructive) { if let d = discarding { processing.discardProject(d.id) }; discarding = nil }
            } message: { Text("This cannot be undone.") }
        }
    }
}
