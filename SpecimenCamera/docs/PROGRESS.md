# Progress log

## Environment facts (verified)
- Linux x86_64, no macOS, no Xcode, no iOS SDK.
- Swift 6.0.3 Linux toolchain extracted from the official `swift:6.0-noble` image into `/opt/swiftroot`
  (`export PATH=/opt/swiftroot/usr/bin:$PATH`). `swift build` / `swift test` work.
- XcodeGen 2.44.1 built from source: `/opt/XcodeGen/.build/release/xcodegen`.
- All project work lives in `/home/user/mm/SpecimenCamera` (own git repo, per instruction).

## Status (update after every phase)
- [x] Phase 0 scaffolding, toolchain, XcodeGen on Linux
- [x] Phase A imaging foundation (Plane/RGBImage, filters, pyramids, Catmull-Rom warp, `.scw` 16-bit tile format, FrameSource/Sink, TileGrid/TileRunner)
- [x] Phase B registration (`ImageRegistration`, `ImageRegistrationEngine`): robust coarse-to-fine similarity, tested vs translation/rotation/scale, illumination change + glare, defocus difference, chaining, failure rejection
- [x] Phase C focus stack (`FocusMapBuilder`, `FocusStackEngine`): multi-signal maps + noise dead zone + fine-signal wide-window term; ~30.2 dB vs ground truth (depth-oracle 30.8 dB)
- [x] Phase D lighting stack (`LightingAnalysisEngine`, `LightingFusionEngine`): see docs/DECISIONS.md for the design iterations
- [x] Phase E core: models, TemporaryStackStore (atomic manifest, recovery, verified cleanup), CollectionStore, FocusStepPlanner, Preflight/Thermal, StackProcessor (checkpoints/resume), combined = hierarchical. 103 tests pass.
- [x] Phase F overlays CPU reference (peaking/zebra/histogram/level), exposure tables, focus-control mapping, capability model, StackCaptureCoordinator state machine (mock-driven), motion logic, measurement math
- [~] Phase G iOS app target (38 files, parse-checked only, NOT compiled)
- [x] Phase H docs, zip

- [x] Audit pass (see AUDIT.md): 14 defects fixed, 2 tests added (105 total), project regenerated

## How to run things
```
export PATH=/opt/swiftroot/usr/bin:$PATH
cd Packages/SpecimenCore
swift test -c release -Xswiftc -enable-testing        # ~85 s, 105 tests
swift build -c release && .build/release/specimen-lab light|focus <outdir>   # writes PNGs for eyeballing
/opt/XcodeGen/.build/release/xcodegen                 # regenerate SpecimenCamera.xcodeproj
```
