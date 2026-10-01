// swift-tools-version:5.9
import PackageDescription

// SpecimenCore: all image-processing, planning, storage and state logic for SPECIMEN CAMERA.
// Foundation-only on purpose: it has no camera dependency and builds/tests headlessly (macOS, iOS, Linux).
let strict: [SwiftSetting] = [.enableExperimentalFeature("StrictConcurrency")]

let package = Package(
    name: "SpecimenCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "SpecimenCore", targets: ["SpecimenCore"]),
        .library(name: "SpecimenTestKit", targets: ["SpecimenTestKit"]),
        .executable(name: "specimen-lab", targets: ["specimen-lab"]),
    ],
    targets: [
        .target(name: "SpecimenCore", swiftSettings: strict),
        // Synthetic scene generators + PNG writer. Used by tests, by the specimen-lab CLI and by the app's debug screen.
        .target(name: "SpecimenTestKit", dependencies: ["SpecimenCore"], swiftSettings: strict),
        .executableTarget(name: "specimen-lab", dependencies: ["SpecimenCore", "SpecimenTestKit"], swiftSettings: strict),
        .testTarget(name: "SpecimenCoreTests", dependencies: ["SpecimenCore", "SpecimenTestKit"], swiftSettings: strict),
    ]
)
