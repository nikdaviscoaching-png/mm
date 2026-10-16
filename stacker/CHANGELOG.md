# Changelog

## 1.2.0
**Quality**
* New lighting engine, ported from the Specimen Camera's reflection-aware stack: per-region quality scoring (clipping, detail, colour, exposure), a base frame chosen automatically (or by ★), replace-only-where-better weights, speck removal, smooth gain matching and a multiband log-light blend. 27.9 → 34.7 dB on the lighting benchmark.
* New focus engine: multi-signal focus map (modified Laplacian, colour gradient, two DoG bands, local contrast) with a noise floor calibrated per series and per-pixel softmax selection. 29.5 → 30.5 dB on the focus benchmark.
* *Both* mode: sharpness selection gated by a lighting-trust map on frames matched with smooth gain fields. 23.5 → 25.4 dB (oracle 28.1).
* Frames with hard clipping, shadows or glare no longer pull the stack in the wrong direction; default methods are chosen by what the series actually contains.

**Resolution**
* Save at full source resolution (previously capped at 12 MP): tile-by-tile render into a streaming baseline JPEG encoder (q95, 4:4:4, EXIF preserved). Memory is bounded by one tile row, so 24 MP series work on phones.
* 12 MP and 4 MP options; the export is prepared in the background while you review.

**App**
* All RAW formats go through LibRaw with embedded-preview fallbacks; HEIC, DNG, JPEG, PNG, WebP supported.
* Wake lock during processing, drag-and-drop, in-place sliders, ★ base-frame control, better Save and About sheets, keyboard/focus handling, reduced-motion support, two-column desktop layout.
* Offline-safe service worker: atomic precache, update toast, self-healing when a cache is incomplete, automatic cross-origin-isolation on hosts that cannot send headers. `vercel.json` and `_headers` included.
* Removed the unused `jsquash` encoder (≈1 MB smaller).

**Engineering**
* Ground-truth test harness (synthetic scenes, PSNR / edge-band PSNR / oracles), unit tests, and a Playwright end-to-end suite against production headers including 12 MP and 24 MP runs.

## 1.1.1
Initial uploaded version.
