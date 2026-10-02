// swift-tools-version:5.9
import PackageDescription

// SpecimenCore: all image-processing, planning, storage and state logic for SPECIMEN CAMERA.
// Foundation-only on purpose: it has no camera dependency and builds/tests headlessly (macOS, iOS, Linux).
let strict: [SwiftSetting] = [.enableExperimentalFeature("StrictConcurrency")]
// The pixel loops are 10-50x slower unoptimised, and Xcode's default Run configuration is Debug. Optimise this package even
// there (a local package may use unsafeFlags); it only changes speed, never behaviour.
let fast: [SwiftSetting] = strict + [.unsafeFlags(["-O"], .when(configuration: .debug))]

let package = Package(
    name: "SpecimenCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "SpecimenCore", targets: ["SpecimenCore"]),
        .library(name: "SpecimenTestKit", targets: ["SpecimenTestKit"]),
        .executable(name: "specimen-lab", targets: ["specimen-lab"]),
    ],
    targets: [
        .target(name: "SpecimenCore", swiftSettings: fast),
        // Synthetic scene generators + PNG writer. Used by tests, by the specimen-lab CLI and by the app's debug screen.
        .target(name: "SpecimenTestKit", dependencies: ["SpecimenCore"], swiftSettings: strict),
        .executableTarget(name: "specimen-lab", dependencies: ["SpecimenCore", "SpecimenTestKit"], swiftSettings: strict),
        .testTarget(name: "SpecimenCoreTests", dependencies: ["SpecimenCore", "SpecimenTestKit"], swiftSettings: strict),
    ]
)
