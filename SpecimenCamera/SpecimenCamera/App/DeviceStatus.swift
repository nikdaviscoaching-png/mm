import Foundation
import UIKit
import SpecimenCore

/// Battery, storage, thermal and low-power state, for preflight checks and for throttling processing (never quality).
@MainActor
final class DeviceStatus: ObservableObject {
    @Published private(set) var thermal: ThermalLevel = .nominal
    @Published private(set) var batteryLevel: Float? = nil
    @Published private(set) var isCharging = false
    @Published private(set) var lowPowerMode = false
    @Published private(set) var freeBytes: Int64 = 0

    private var observers: [NSObjectProtocol] = []

    init() {
        UIDevice.current.isBatteryMonitoringEnabled = true
        refresh()
        let nc = NotificationCenter.default
        for name in [ProcessInfo.thermalStateDidChangeNotification, UIDevice.batteryLevelDidChangeNotification, UIDevice.batteryStateDidChangeNotification, .NSProcessInfoPowerStateDidChange] {
            observers.append(nc.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.refresh() }
            })
        }
    }

    deinit { observers.forEach { NotificationCenter.default.removeObserver($0) } }

    func refresh() {
        thermal = Self.level(ProcessInfo.processInfo.thermalState)
        let b = UIDevice.current.batteryLevel
        batteryLevel = b < 0 ? nil : b
        isCharging = UIDevice.current.batteryState == .charging || UIDevice.current.batteryState == .full
        lowPowerMode = ProcessInfo.processInfo.isLowPowerModeEnabled
        freeBytes = AppPaths.availableStorageBytes()
    }

    nonisolated static func level(_ s: ProcessInfo.ThermalState) -> ThermalLevel {
        switch s {
        case .nominal: return .nominal
        case .fair: return .fair
        case .serious: return .serious
        case .critical: return .critical
        @unknown default: return .serious
        }
    }

    /// Worker count for the next heavy stage; evaluated from any thread.
    nonisolated static func currentConcurrency() -> Int {
        ThermalPolicy.concurrency(thermal: level(ProcessInfo.processInfo.thermalState),
                                  cores: ProcessInfo.processInfo.activeProcessorCount,
                                  lowPowerMode: ProcessInfo.processInfo.isLowPowerModeEnabled)
    }

    func preflight(estimate: StorageEstimate) -> [PreflightIssue] {
        refresh()
        return StackPreflight.check(estimate: estimate, availableBytes: freeBytes, batteryLevel: batteryLevel, isCharging: isCharging, thermal: thermal)
    }
}
