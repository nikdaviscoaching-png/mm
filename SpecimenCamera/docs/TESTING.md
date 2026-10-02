# Testing

## 1. What was and was not verified

| | Verified here | How |
|---|---|---|
| `SpecimenCore` algorithms and logic | **Yes** | 131 XCTest tests (below), compiled with `-enable-experimental-feature StrictConcurrency`, Swift 6.0.3 on Linux x86-64. Outputs inspected as images (`docs/validation/`). |
| iOS app source (38 files) | **Syntax only** | `swiftc -parse` on every file; Apple API signatures checked against Apple's documentation JSON; line-by-line review. **Not type-checked, not compiled, not run** — no iOS SDK was available. |
| Xcode project | Generated, structure inspected | XcodeGen 2.44.1 built from source; all 38 source files, the local package dependency, asset catalog and Info.plist keys confirmed in `project.pbxproj`. Never opened in Xcode. |

Everything under "Manual on-device steps" (§4) is therefore **required**, not optional, before trusting the camera layer.

## 2. Automated results

Run: `cd Packages/SpecimenCore && swift test -c release -Xswiftc -enable-testing`

```
CameraLogicTests            16 tests  passed
FocusStackTests              9 tests  passed
ImagingTests                12 tests  passed
ImportMeasureExportTests    10 tests  passed
LightingStackTests          12 tests  passed
OverlayTests                10 tests  passed
PlanningTests                9 tests  passed
ProcessorTests              11 tests  passed
RegistrationTests            8 tests  passed
StorageTests                 8 tests  passed
Executed 110 tests, with 0 failures (0 unexpected) in ~85 s
```

Headline numbers (synthetic datasets with ground truth, generated in code — `SpecimenTestKit`):

| Pipeline | Metric | Result |
|---|---|---|
| Focus fusion, 8 planes, noise σ=0.003 | PSNR vs all-in-focus truth | **30.24 dB** (best single frame 20.41; depth-oracle hard selection 30.85) |
| Focus fusion with jitter + focus breathing → align → fuse | PSNR | 26.5 dB aligned vs 17.3 dB unaligned |
| Registration | corner error | ≤ 0.1–0.3 px for shifts to ±14 px, rotation 0.003 rad, scale 0.4 %; survives illumination gradient + glare + coloured reflection; rejects unrelated images |
| Lighting, standard scenario (blown glare, thin polished highlight, magenta reflection, shadow) | glare core luminance | 0.343 vs true 0.372 (base frame 0.999) |
| | PSNR vs defect-free rendering | 14.5 → 31.7 dB (base forced to the glared frame); 23.1 → 35.0 dB (automatic base) |
| | thin polished highlight | ≥ 85 % of its excess brightness kept, crispness ≥ 90 % |
| Combined (4 focus × 3 light) | PSNR vs truth | > 23 dB and > 5 dB better than the best source frame |
| Peaking | sharp vs blurred marks | ≥ 10× ; flat-noise coverage < 0.2 % (σ=3/255), < 1 % (σ=9/255) |

## 3. Performance and memory (desktop, **not an iPhone**)

`specimen-lab bench` — file-backed `.scw` frames, tile-streamed, 2 workers, 4-core x86 VM:

| Pipeline | Size | Frames | Time | Peak RSS |
|---|---|---|---|---|
| Focus (HIGH) | 3 MP | 6 | 10.9 s | 345 MB |
| Focus (HIGH) | 12 MP (4032×3024) | 8 | 57 s | 441 MB |
| **Focus (HIGH)** | **48 MP (8064×6048)** | **12** | **338 s** | **634 MB** |
| Lighting (HIGH) | 12 MP | 5 | 13.6 s | 308 MB |

Memory is bounded by tile size, not frame count or resolution (≈0.6 s per megapixel·frame for focus fusion on this machine).
Disk is what scales: each developed frame is 6 bytes/pixel (≈290 MB at 48 MP); `StackPreflight` estimates this and refuses to start when
free space is clearly insufficient. A 24-frame 48 MP combined stack was not run (disk/time) — the 12-frame run is the largest measured.

## 4. Manual on-device steps (acceptance tests 1–20)

Mount the phone on a tripod, a specimen with banding in front of it, one movable lamp. Build and install per `README.md` first.
Check the Xcode console / *Console.app* (subsystem `app.specimencamera`) for the log events named in the spec.

| # | Acceptance test | Steps | Pass when |
|---|---|---|---|
| 1 | Live preview appears reliably | Launch; allow Camera. Background/foreground the app 5×. | Preview shows each time; no black screen. |
| 2 | Physical lenses match hardware | Open the lens menu. | Exactly the rear modules your phone has, named with focal length (e.g. "Ultra Wide 13 mm", "Main 24 mm", "Telephoto 5× 120 mm"). No lens your phone lacks. |
| 3 | ISO changes the exposure config | ISO tab → pick 64, then 800. Watch the live-info bar. | `ISO` value follows; with shutter AUTO the shutter changes to compensate; with shutter manual the picture brightens/darkens. |
| 4 | Shutter changes exposure duration | SHUTTER tab → 1/250 then 1/15. | Info bar shows the value; image brightness changes accordingly. |
| 5 | Manual focus moves the lens | FOCUS tab → MF; drag the dial. | The lens-position number changes and the image goes in/out of focus; press-and-hold then drag moves in 25× finer steps (FINE badge). |
| 6 | Red peaking tracks focus | Peaking Medium; drag focus through a banded face. | Red marks appear only on in-focus edges, move across the stone as you focus, almost none on blur or flat areas. Try Low/High. |
| 7 | 4× assist without changing framing | Tap 4×, pan with one finger, then shoot a single. | Magnified, pannable inspection; the saved photo has the normal full framing. Double-tap returns to 1×. |
| 8 | 5-frame focus stack captures automatically | FOCUS mode → SET NEAR / SET FAR → frame count 5 → START STACK. | Five frames captured without touching the phone; status shows "CAPTURING FOCUS FRAME i/5". |
| 9 | Output has sharp detail from several depths | Open the result in the review screen; zoom into near and far banding. | Both sharp; no visible seams/halos. COMPARE shows each source softer in places. |
| 10 | No source frames scattered in Photos | After a focus stack, open Photos. | Only (if "Save Final To" includes Photos) the single final appears. |
| 11 | Lighting stack, ≥4 positions, locked settings | LIGHTING → press shutter, move lamp, repeat 4×. | Banner "LOCKED: ISO … · shutter … · … K"; exposure/WB/focus do not wander; thumbnails show 4 frames. |
| 12 | Glare from the clean source | Aim the lamp so one frame has a blown glare patch, others clean there; FINISH. | Result shows the true stone colour where the glare was, no white patch. |
| 13 | Narrow polished highlight kept | Keep a thin highlight on a curved edge in the frame that becomes the base. | Highlight present and crisp; the stone does not look matte. (If another frame was chosen as base, use REPROCESS › Lighting base.) |
| 14 | Combined stack | COMBINED → set NEAR/FAR once → capture series at 3–4 light positions (button: NEXT LIGHT POSITION) → FINISH & PROCESS. | One final image, fully focused and evenly lit. |
| 15 | Imported originals untouched | IMPORT STACK: a JPEG, HEIC, TIFF, DNG and a ProRAW from Photos/Files. Compare checksums/dates of the originals before and after. | Originals identical and still present; a working copy is made inside the app. |
| 16 | Interrupted processing recoverable | Start processing, force-quit the app mid-way. Relaunch. | Recovery sheet appears; RESUME PROCESSING completes without redoing finished frames. Also try a phone call/backgrounding during capture: frames so far are kept. |
| 17 | Temporary data deleted on success | With Keep Stack Source Frames OFF, SAVE a stack. | Library shows one image; (Xcode › Devices › container) `Projects/` has no folder for it. |
| 18 | Full practical resolution | Check the saved item size in the library detail. | Matches the capture resolution (e.g. 4032×3024, or 8064×6048 in MAX/ProRAW). |
| 19 | Collection routing | Set CURRENT COLLECTION to "eBay Queue", shoot a single and a stack. | Both appear in that collection automatically. |
| 20 | Unsupported features hidden | Use a phone without ProRAW/telephoto/LiDAR (or the ultra-wide lens). | No ProRAW/RAW entry, no telephoto in the lens menu, no LiDAR section when the hardware lacks it; AF-only lenses show no manual-focus dial. |

### Added by the audit (`AUDIT.md`) — also check on the device

| # | Check | Pass when |
|---|---|---|
| A1 | During any stack, tap the preview, open the lens/format menus, drag the focus dial (hidden). | Nothing changes; the control strip is hidden; focus does not move except by the stack. |
| A2 | Mount the phone **flat** on a stand, start a 5-frame focus stack, tilt the phone slightly while it runs. | All frames keep the same orientation; processing completes (no "different size" error). |
| A3 | FOCUS stack: press the Home button/take a call after frame 2 and return. | Status "Camera is back — continue"; CONTINUE captures only the missing frames; FINISH NOW processes what exists. |
| A4 | Deny camera access, enable it in Settings, return to the app. | The preview starts without relaunching. |
| A5 | Settings › Shutter delay 2 s; shoot a single and a lighting frame. | A countdown shows on the shutter button; the exposure happens after it. |
| A6 | Leave the camera untouched for 2 minutes. | The screen does not lock. |
| A7 | Peaking on: overlay edges line up with the picture in portrait and when the phone is turned (check Console for `overlay buffer request`). | Red marks sit on the in-focus edges, not offset or stretched. |

### Added after the first phone test — please check

| # | Check | Pass when |
|---|---|---|
| B1 | SINGLE mode, choose RAW / ProRAW, press the shutter repeatedly. | The button is never dead; each press saves (toast "Saved to …") or shows an error message saying why. |
| B2 | FOCUS tab, drag the slider quickly, then slowly. | Quick = whole range; slow = tiny steps, badge FINE. ± repeats while held. |
| B3 | Peaking on, tap 4× then 8×, pan around. | Thin red lines on in-focus edges only; the picture stays sharp (full-size buffers); the phone does not warm quickly. |
| B4 | Set ISO and SHUTTER to manual with a slow shutter (e.g. 1/4 s). LIVE VIEW = MATCH. | The live view is bright and smooth; the saved photo has exactly your ISO/shutter (check the EXIF in the library details). |
| B5 | Run a 4–5 frame focus stack **hand-held** (small movements). | Processing finishes without an "alignment uncertain" warning; the processing screen shows elapsed time and moves through ALIGNING and BLENDING. |
| B6 | Process a stack and feel the phone. | Warm at most; if it gets hot the screen says it is slowing down or pausing. |
| B7 | LIGHTING / COMBINED: follow the on-screen steps; also try IMPORT PHOTOS INSTEAD. | Each stage has one obvious button; imports open with the right stack type. |

## 5. End-to-end scenarios

1. **eBay single** — collection "eBay Queue" → Main lens → ISO 32/64 → set shutter → Kelvin WB → peaking + 4× → focus → shoot: the image lands in eBay Queue (acceptance 19, 3, 4, 6, 7).
2. **Deep agate** — FOCUS: NEAR on the nearest banding, FAR on the deepest feature; AUTO should suggest roughly 8 frames (the estimate is a model; adjust if needed) → one full-resolution image.
3. **Mirror-polished slab** — LIGHTING, 4 positions → glare replaced, controlled highlights kept, smooth blend.
4. **Complex geode** — COMBINED with ~6 planes × 4 positions → 4 focus composites → lighting stack → one final; with Keep Sources OFF the 24 sources and 4 intermediates are deleted after SAVE.

If anything misbehaves, report: iPhone model, iOS version, the Console log lines, and which step failed.
