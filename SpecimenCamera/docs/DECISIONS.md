# Decisions

Non-obvious engineering decisions and the evidence behind them. Numbers come from the headless test-suite / `specimen-lab`.

## 1. Everything algorithmic is in a portable package (`SpecimenCore`)
The build machine had Linux only (Swift 6.0.3 toolchain extracted from the official `swift:6.0-noble` image; XcodeGen 2.44.1 built
from source) — no Xcode, no iOS SDK. So all image processing, planning, storage, recovery, capture sequencing and overlay maths
is Foundation-only Swift that builds and tests headlessly, compiled with `StrictConcurrency`. The iOS target contains only
framework glue (AVFoundation, Core Image, Metal, SwiftUI, PhotoKit, ARKit, Core Motion). Hardware is reached through two protocols
(`CameraDriving`, `FrameDeveloper`/`FinalEncoder`) so the *real* capture state machine and processing pipeline are unit-tested with mocks.

## 2. Working-image format `.scw`
16-bit interleaved RGB, display-encoded Display P3, fixed row pitch, 4 KiB header. Tiles are read with `pread`, so no frame is ever
loaded whole (peak ≈450 MB at 12 MP for any frame count). 16-bit gamma-encoded storage loses nothing visible (sub-1/65535 steps) while
making dark agate tones safe to blend after decoding to linear light. Intermediates stay on disk and are deleted frame group by group.

## 3. Registration is custom (not Vision)
Focus frames differ in *which* details are sharp and lighting frames differ in highlights/shading — both defeat descriptor matching on
glossy banded stones. A coarse-to-fine Gauss-Newton similarity aligner on locally-contrast-normalised proxies with Cauchy re-weighting
recovers 0.1 px shifts, rotation, scale, survives illumination gradients + clipped glare + a coloured reflection, and rejects unrelated
frames. It runs identically in tests. Transforms are estimated on ≤1.8 MP proxies and applied at full resolution through
`WarpedFrame` (bicubic, on demand per tile; near-identity transforms pass through unresampled so tripod stacks are not softened).

## 4. Focus fusion
Soft Laplacian-pyramid fusion in linear light, per band, per pixel, tile-streamed with halo `4<<levels`.
Weights combine (a) the band's coefficient energy, (b) a multi-signal focus map (step-1 modified Laplacian, colour Sobel gradient,
two DoG band energies, local contrast) and (c) a wide-window map of fine-scale signals only. Findings that shaped it
(8-plane synthetic series with ground truth; hard-selection oracle with true depth = 30.85 dB):

* Selection power 2 → 8: 26.4 → 29.5 dB; 16 gained a further ~0.4 dB. Returns diminish, so 8 was kept as a compromise against seam risk (seam behaviour at higher powers was not separately measured).
* **Defocus bleed** (a heavily blurred bright neighbour leaking into a flat dark cell) looked like "detail" and won locally →
  visible dark smudge. Fixed by a wide-window term built from *fine-scale only* signals so flat regions inherit the decision of the
  sharp detail around them. Green-channel error in the affected cell 0.020 → <0.001; PSNR 29.45 → 30.24 dB.
* An earlier hypothesis (noise-driven choices) was tested with a calibrated noise dead zone; it changed nothing — measured with a probe, the
  cause was real bleed energy, not noise. The dead zone is kept (cheap, principled) but is not what fixed it.
* With the final weighting, 4, 5 and 6 pyramid levels are equivalent on this data (30.18–30.19 dB); 5 is the default for HIGH and 6 for MAXIMUM (a wider halo for larger transitions on real images).
* Tiled == untiled (mean difference < 0.0015, max < 0.06); file-backed == in-memory.

## 5. Lighting stack (not HDR, not min/median/average)
Core idea: *real detail stays put while reflections move with the light*. A single **base** frame defines the lighting character; other
frames replace it only **where they are decisively better**, so legitimate polished highlights survive and the stone never goes matte.

* Quality per frame/region = clipping × extent (grey-opening by the narrow-highlight width removes *thin* highlights from the glare
  class; broad clipped/near-white areas stay) × detail relative to other frames × colour deviation (also grey-opened: a thin highlight
  also desaturates, a tint/wash is broad) × exposure (muddy shadows lose).
* **Reference choice matters.** Median references failed when several frames carried glare tails. Final rule: the darkest frame, except
  frames below half the second-darkest are treated as shadows and skipped (≥3 frames; two frames use the darkest). Glare/tints only ever
  *add* light. A brightness-gated penalty means a shadowed reference cannot condemn clean frames.
* "Broad un-clipped wash" (glare tails) is detected as a broad region much brighter than the reference, with a +0.06 linear floor so dark
  regions don't trigger on tiny absolute differences (two-frame failure found in testing).
* Replacement weights: `a_j = smoothstep(0.12, 0.45, Q_j − Q_base)`; base keeps `1 − max a_j`; donors share the rest by `Q^3`.
  Specks are removed, then guided-filtered by the base's own structure; weights always partition unity (tested).
* **Blend** is Burt–Adelson multiband at full resolution. At coarse bands the Gaussian-blurred mask let low-frequency contamination
  (a magenta tint, a glare wash) leak into the middle of a defect only a few transition-widths wide → coarse-level masks are dilated
  and each donor's contribution is gated by its own quality at that scale (otherwise a donor's *own* glare leaked in).
* Local lighting match: smooth gain from pixels where both frames are trustworthy, extrapolated into the defect, so replacements don't
  show a brightness step.
* Rejected: automatic base choice by "gloss" (narrow frame-unique highlights). It was fooled whenever several frames were corrupted at
  once (it picked the shadowed frame). Replaced by cleanliness + explicit `preferredBase` in REPROCESS.
* Result on the standard 4-frame scenario (blown glare + thin polished highlight + magenta phone reflection + shadow): glare core back
  to 0.343 (true 0.372, base frame 0.999); magenta rectangle replaced (blue channel 0.165 vs true 0.161; the base frame had 0.568); thin 3.5 px highlight kept at ≥85 % of its excess
  brightness and crisp; PSNR vs the defect-free rendering 14.5 → 31.7 dB (forced base) / 23.1 → 35.0 dB (automatic base).

## 6. Combined = hierarchical
Per light position: align → focus-fuse → intermediate composite on disk; then lighting analysis/blend over the composites; one final.
Checkpoints per group make resume cheap. Joint optimisation was not attempted: hierarchy matched the spec's default and tests show
the combined output beating every source frame by > 5 dB.

## 7. Peaking, zebras, histogram
Peaking = step-1 modified Laplacian of luma with a noise-adaptive threshold (7 × the 30th percentile of sampled responses, capped) and a
2-of-8 neighbour-support rule. It separates sharp from blurred edges (≥10×), stays below 0.2–1 % coverage on flat sensor noise, and its
marker count peaks at the frame where each region is in focus. The same rule is implemented as a Metal kernel (runtime-compiled source,
so a shader failure falls back to the tested CPU path rather than losing peaking).

## 8. Camera layer choices
Physical modules only; session preset `.photo`; one `AVCaptureSession` on a serial queue; Zero Shutter Lag and responsive capture off;
photo settings validated before use (invalid settings throw an uncatchable Objective-C exception); lens-move completion has a 2 s
safety timeout; capture orientation via `RotationCoordinator`; stack quality maps to `.speed/.balanced/.quality` prioritisation.

## 9. Storage and safety
Atomic manifests (`Data.write(.atomic)`); per-step checkpoints; `finalizeSuccess` is the *only* path that deletes sources and it
verifies the final (exists, non-empty, decodes, exact size) and refuses if the final still lives inside the project folder. Keep-sources
**moves** frames to `KeptSources/` instead of copying. Import copies; the original is never opened for writing. `save` is idempotent so a
retry after a partial failure neither duplicates nor loses anything.

## 10. Dependencies
None beyond Apple frameworks. No third-party code, no network.
