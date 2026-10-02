# SPECIMEN CAMERA — Plan

Environment reality (see PROGRESS.md): development happens on Linux with a real Swift 6.0.3
toolchain and a Linux build of XcodeGen 2.44.1. There is **no Xcode / iOS SDK**, so everything that
touches Apple frameworks (AVFoundation, SwiftUI, Core Image, Metal, PhotoKit, ARKit, Core Motion)
is written carefully but is **not compiled here**. Everything algorithmic lives in `SpecimenCore`,
a Foundation-only Swift package that *is* compiled, strict-concurrency checked and unit-tested here.

Legend: [ ] todo · [x] done and verified (build/test) · [~] written, not compilable here

## Phase 0 — Scaffolding
- [x] Toolchain (Swift 6.0.3 Linux) + XcodeGen on Linux
- [x] Repo layout, `project.yml`, SpecimenCore package, docs skeleton

## Phase A — SpecimenCore: imaging foundation (compiled + tested)
- [x] FloatImage, PixelRect, sRGB/P3 colour math, luma
- [x] Separable Gaussian / box / pyramids / guided filter / resampling (Catmull-Rom/Lanczos warp)
- [x] `.scw` 16-bit working-image container, tile reader/writer, FrameSource abstraction, tile grid
- [x] Test-only PNG writer + synthetic scene generators (focus series, glare/lighting series)

## Phase B — Registration
- [x] Robust coarse-to-fine ECC similarity alignment on contrast-normalised proxies
- [x] Warp-on-demand frame source (no warped copies on disk), identity short-circuit
- [x] Tests: translation/rotation/scale recovery, lighting-change robustness

## Phase C — Focus stack
- [x] Multi-signal focus analysis (modified Laplacian, gradient, DoG band energy, local contrast, noise floor)
- [x] Pyramid fusion with soft coherent weights, depth-consistency prior, tile-streaming
- [x] Tests vs. ground truth (PSNR / halo metrics), tiled == untiled, visual inspection

## Phase D — Lighting stack
- [x] Quality analysis (clip proximity/extent, thin-highlight discrimination, detail, whitening, colour contamination, exposure/SNR)
- [x] Base-frame prior, edge-aware mean-field regularisation at proxy, weight upsampling
- [x] Multiband full-resolution blend, tile-streaming
- [x] Tests: glare replaced (#12), narrow polished highlight kept (#13), magenta reflection, dark region, visual inspection

## Phase E — Combined, pipeline, recovery
- [x] CombinedStackEngine (hierarchical), progress/cancel, checkpoints
- [x] TemporaryStackStore (project folders, manifest, recovery scan, verified cleanup)
- [x] StackPreflight (storage/battery), FocusStepPlanner (AUTO frame count)
- [x] CollectionStore / LibraryStore, metadata model, export planning

## Phase F — Overlays & camera model (pure logic, tested)
- [x] Peaking / zebra / histogram CPU reference algorithms, level math
- [x] Exposure/ISO/shutter tables, focus-control mapping (coarse+fine), capability model, stack lock rules
- [x] StackCaptureCoordinator state machine driven by a `CameraDriving` protocol (mock-tested)

## Phase G — iOS app (written, not compilable here)
- [~] Camera stack (capability detection, session, exposure/WB/focus, photo capture incl. RAW/ProRAW)
- [~] Overlays (Metal peaking+zebra with CPU fallback, histogram, grids, level), focus magnifier
- [~] Stack capture UI + processing service (Core Image → `.scw` development, final encode via ImageIO/CoreImage)
- [~] Review / library / collections / export / settings / import / measurement / recovery / debug pipeline
- [~] Info.plist, assets, XcodeGen project generated and its structure validated

## Phase H — Docs & delivery
- [x] README, LIMITATIONS, TESTING, DECISIONS, PROGRESS (+ honest unimplemented/unverified list)
- [x] Zip of the project at the repo root; final audit
