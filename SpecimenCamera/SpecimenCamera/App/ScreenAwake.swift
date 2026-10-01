import UIKit

/// Keeps the screen on while the camera is in use. Left alone, iOS locks the phone after about 30 seconds without a touch;
/// on a tripod that ends the camera session in the middle of a stack. Several parts of the app can ask for it independently.
@MainActor
enum ScreenAwake {
    private static var holds = Set<String>()
    static func hold(_ reason: String) { holds.insert(reason); apply() }
    static func release(_ reason: String) { holds.remove(reason); apply() }
    private static func apply() { UIApplication.shared.isIdleTimerDisabled = !holds.isEmpty }
}
