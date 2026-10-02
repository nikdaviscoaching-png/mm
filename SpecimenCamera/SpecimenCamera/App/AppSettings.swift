import Foundation
import SwiftUI
import SpecimenCore

/// User settings, persisted in UserDefaults (local only).
@MainActor
final class AppSettings: ObservableObject {
    private let d = UserDefaults.standard

    @Published var peaking: PeakingSensitivity { didSet { d.set(peaking.rawValue, forKey: "peaking") } }
    @Published var peakingColor: PeakingColor { didSet { d.set(peakingColor.rawValue, forKey: "peakingColor") } }
    @Published var zebra: ZebraLevel { didSet { d.set(zebra.rawValue, forKey: "zebra") } }
    @Published var histogram: HistogramMode { didSet { d.set(histogram.rawValue, forKey: "histogram") } }
    @Published var grid: GridStyle { didSet { d.set(grid.rawValue, forKey: "grid") } }
    @Published var showCrosshair: Bool { didSet { d.set(showCrosshair, forKey: "crosshair") } }
    @Published var showLevel: Bool { didSet { d.set(showLevel, forKey: "level") } }
    @Published var showLiveInfo: Bool { didSet { d.set(showLiveInfo, forKey: "liveInfo") } }
    @Published var keepSourceFrames: Bool { didSet { d.set(keepSourceFrames, forKey: "keepSources") } }
    @Published var defaultFinalFormat: FinalFormat { didSet { d.set(defaultFinalFormat.rawValue, forKey: "finalFormat") } }
    @Published var stackQuality: StackQuality { didSet { d.set(stackQuality.rawValue, forKey: "stackQuality") } }
    @Published var saveDestination: SaveDestination { didSet { d.set(saveDestination.rawValue, forKey: "saveDestination") } }
    @Published var stackDensity: StackDensity { didSet { d.set(stackDensity.rawValue, forKey: "stackDensity") } }
    @Published var captureFormat: CaptureFormat { didSet { d.set(captureFormat.rawValue, forKey: "captureFormat") } }
    @Published var highResFocusAssist: Bool { didSet { d.set(highResFocusAssist, forKey: "highResAssist") } }
    @Published var developerTools: Bool { didSet { d.set(developerTools, forKey: "developerTools") } }
    /// Seconds between pressing the shutter and the exposure, so the phone has stopped shaking (tripod/stand work).
    /// Brighter, faster live view while ISO/shutter are manual (the photo itself always uses the chosen values).
    @Published var previewBoost: PreviewBoost { didSet { d.set(previewBoost.rawValue, forKey: "previewBoost") } }
    @Published var shutterDelaySeconds: Int { didSet { d.set(shutterDelaySeconds, forKey: "shutterDelay") } }

    init() {
        func e<T: RawRepresentable>(_ key: String, _ def: T) -> T where T.RawValue == String {
            UserDefaults.standard.string(forKey: key).flatMap(T.init(rawValue:)) ?? def
        }
        func b(_ key: String, _ def: Bool) -> Bool { UserDefaults.standard.object(forKey: key) as? Bool ?? def }
        peaking = e("peaking", PeakingSensitivity.medium)
        peakingColor = e("peakingColor", PeakingColor.red)
        zebra = e("zebra", ZebraLevel.off)
        histogram = e("histogram", HistogramMode.off)
        grid = e("grid", GridStyle.off)
        showCrosshair = b("crosshair", false)
        showLevel = b("level", true)
        showLiveInfo = b("liveInfo", true)
        keepSourceFrames = b("keepSources", false)               // default OFF
        defaultFinalFormat = e("finalFormat", FinalFormat.jpeg)
        stackQuality = e("stackQuality", StackQuality.maximum)   // MAXIMUM QUALITY is the default for finals
        saveDestination = e("saveDestination", SaveDestination.appLibrary)
        stackDensity = e("stackDensity", StackDensity.normal)
        captureFormat = e("captureFormat", CaptureFormat.standard)
        highResFocusAssist = b("highResAssist", false)
        developerTools = b("developerTools", false)
        previewBoost = e("previewBoost", PreviewBoost.match)
        shutterDelaySeconds = UserDefaults.standard.object(forKey: "shutterDelay") as? Int ?? 2
    }
}
