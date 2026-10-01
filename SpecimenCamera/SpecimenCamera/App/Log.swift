import Foundation
import os

/// Local, on-device logging only (os.Logger). Nothing is sent anywhere.
enum Log {
    private static let subsystem = "app.specimencamera"
    static let camera = Logger(subsystem: subsystem, category: "camera")
    static let overlay = Logger(subsystem: subsystem, category: "overlay")
    static let stack = Logger(subsystem: subsystem, category: "stack")
    static let processing = Logger(subsystem: subsystem, category: "processing")
    static let storage = Logger(subsystem: subsystem, category: "storage")
    static let export = Logger(subsystem: subsystem, category: "export")
}
