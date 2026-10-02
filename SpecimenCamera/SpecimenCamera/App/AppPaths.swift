import Foundation

/// App-sandbox locations. Working projects are excluded from backups so no iCloud space is used for temporary stacks.
enum AppPaths {
    static let fm = FileManager.default

    static var applicationSupport: URL {
        let url = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("SpecimenCamera", isDirectory: true)
        try? fm.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    static var projects: URL { directory("Projects", excludeFromBackup: true) }
    static var library: URL { directory("Library", excludeFromBackup: false) }
    static var staging: URL { directory("Staging", excludeFromBackup: true) }
    static var exports: URL { directory("Exports", excludeFromBackup: true) }
    static var singles: URL { directory("SingleCaptures", excludeFromBackup: true) }

    private static func directory(_ name: String, excludeFromBackup: Bool) -> URL {
        var url = applicationSupport.appendingPathComponent(name, isDirectory: true)
        try? fm.createDirectory(at: url, withIntermediateDirectories: true)
        if excludeFromBackup {
            var values = URLResourceValues(); values.isExcludedFromBackup = true
            try? url.setResourceValues(values)
        }
        return url
    }

    /// Removes scratch files at launch. `Staging/` is deliberately NOT cleared wholesale: it holds finished results that are
    /// still awaiting review/SAVE after a crash. Only abandoned import copies older than a day are removed from it.
    static func cleanScratch() {
        for dir in [exports, singles] {
            if let items = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) {
                for u in items { try? fm.removeItem(at: u) }
            }
        }
        let cutoff = Date().addingTimeInterval(-24 * 3600)
        if let items = try? fm.contentsOfDirectory(at: staging, includingPropertiesForKeys: [.contentModificationDateKey]) {
            for u in items where u.lastPathComponent.hasPrefix("import_") {
                if let d = (try? u.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate, d < cutoff { try? fm.removeItem(at: u) }
            }
        }
    }

    static func availableStorageBytes() -> Int64 {
        let values = try? applicationSupport.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        return values?.volumeAvailableCapacityForImportantUsage ?? 0
    }
}
