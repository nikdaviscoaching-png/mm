import Foundation

/// Metadata read from an imported file (EXIF/TIFF via ImageIO in the app). Missing values are simply nil.
public struct ImportCandidate: Sendable, Equatable {
    public var url: URL
    public var captureDate: Date?
    public var subjectDistanceMM: Double?       // EXIF SubjectDistance when present
    public var exposureSeconds: Double?
    public var iso: Float?
    public init(url: URL, captureDate: Date? = nil, subjectDistanceMM: Double? = nil, exposureSeconds: Double? = nil, iso: Float? = nil) {
        self.url = url; self.captureDate = captureDate; self.subjectDistanceMM = subjectDistanceMM; self.exposureSeconds = exposureSeconds; self.iso = iso
    }
}

public struct ImportGrouping: Sendable, Equatable {
    public var groups: [[ImportCandidate]]
    /// True when metadata could not determine the grouping confidently; the UI then shows the manual grouping editor.
    public var needsManualReview: Bool
    public var explanation: String
}

/// Orders imported frames and, for COMBINED stacks, splits them into light positions using capture times.
/// Originals are never touched — this only reads metadata and returns an arrangement.
public enum ImportGrouper {

    public static func ordered(_ c: [ImportCandidate], type: StackType) -> [ImportCandidate] {
        c.sorted { a, b in
            if let da = a.captureDate, let db = b.captureDate, da != db { return da < db }
            return a.url.lastPathComponent.localizedStandardCompare(b.url.lastPathComponent) == .orderedAscending
        }
    }

    public static func group(_ candidates: [ImportCandidate], type: StackType, framesPerGroup: Int? = nil) -> ImportGrouping {
        let sorted = ordered(candidates, type: type)
        switch type {
        case .focus:
            return ImportGrouping(groups: [orderByFocus(sorted)], needsManualReview: sorted.count < 2, explanation: "All frames form one focus series.")
        case .lighting:
            return ImportGrouping(groups: sorted.map { [$0] }, needsManualReview: sorted.count < 2, explanation: "Each image is one light position, in capture order.")
        case .combined:
            return combined(sorted, framesPerGroup: framesPerGroup)
        }
    }

    /// Within a focus series, prefer EXIF subject distance (near → far) if every frame has one; otherwise capture order.
    static func orderByFocus(_ g: [ImportCandidate]) -> [ImportCandidate] {
        if g.count > 1, g.allSatisfy({ $0.subjectDistanceMM != nil }), Set(g.compactMap { $0.subjectDistanceMM }).count > 1 {
            return g.sorted { ($0.subjectDistanceMM ?? 0) < ($1.subjectDistanceMM ?? 0) }
        }
        return g
    }

    static func combined(_ s: [ImportCandidate], framesPerGroup: Int?) -> ImportGrouping {
        guard s.count >= 4 else { return ImportGrouping(groups: [s], needsManualReview: true, explanation: "Too few images to split into light positions.") }
        if let n = framesPerGroup, n >= 2, s.count % n == 0 {
            let groups = stride(from: 0, to: s.count, by: n).map { orderByFocus(Array(s[$0..<($0 + n)])) }
            return ImportGrouping(groups: groups, needsManualReview: groups.count < 2, explanation: "Split into \(groups.count) light positions of \(n) frames each.")
        }
        let dates = s.compactMap { $0.captureDate }
        guard dates.count == s.count else {
            return ImportGrouping(groups: [s], needsManualReview: true, explanation: "Capture times are missing, so the light positions cannot be detected.")
        }
        let gaps = zip(dates.dropFirst(), dates).map { $0.timeIntervalSince($1) }
        let med = gaps.sorted()[gaps.count / 2]
        // a pause between series (moving the light) is much longer than the interval inside a series
        let threshold = max(med * 2.5, med + 1.0)
        var cuts: [Int] = []
        for (i, g) in gaps.enumerated() where g > threshold { cuts.append(i + 1) }
        guard !cuts.isEmpty else {
            return ImportGrouping(groups: [s], needsManualReview: true, explanation: "No pause between series was found — please group the frames manually.")
        }
        var groups: [[ImportCandidate]] = []
        var start = 0
        for c in cuts + [s.count] { groups.append(orderByFocus(Array(s[start..<c]))); start = c }
        let sizes = Set(groups.map { $0.count })
        let uniform = sizes.count == 1
        return ImportGrouping(groups: groups, needsManualReview: !uniform || groups.count < 2,
                              explanation: uniform ? "Detected \(groups.count) light positions of \(groups[0].count) frames from capture times."
                                                   : "Detected \(groups.count) groups of differing sizes \(groups.map { $0.count }) — please check.")
    }
}
