# Audit log

A second, whole-project pass made after the first delivery: every file of the iOS layer re-read against what the app is
for (a tripod-mounted camera for polished stones), the riskiest Apple-API assumptions checked against Apple's documentation, and the
processing pipeline traced for each way a real session can go wrong. **Nothing here was run on a device** — the iOS layer is still
only parse-checked (see `TESTING.md`). Core changes are covered by tests (105 pass).

## Defects found and fixed

| # | Problem (how it would have shown up) | Fix |
|---|---|---|
| 1 | **Controls were live during a stack.** A tap on the preview (tap-to-focus), the lens menu or the format menu while a stack ran would change focus / lens / format mid-series and ruin the result. | `CameraController.userControlsLocked` is set while a stack is active; every user-facing camera command is refused, the control strip is hidden, the lens/format menus are disabled and tap-to-focus is ignored. |
| 2 | **Orientation could change mid-stack.** The capture rotation angle was read fresh for every photo. A phone lying nearly flat on a stand (common for slabs) can flip between angles, producing frames of different pixel dimensions. | `CameraEngine` freezes the capture and preview angles when a stack locks and releases them afterwards. |
| 3 | **No size check in the processor.** Frames of different size/orientation (a flipped frame, or mixed imports) reached registration and fusion unchecked. | `StackProcessor` verifies all developed frames have identical dimensions and stops with a message naming both sizes; the project stays recoverable. Two new tests. |
| 4 | **A focus stack could not be continued.** After a phone call / app switch / capture error the coordinator was ready again, but the FOCUS UI offered only CANCEL, and the shutter did nothing while a stack was active. | FOCUS now has CONTINUE (resumes the series where it stopped) and FINISH NOW (process what exists, ≥2 frames); the shutter also continues. |
| 5 | **Camera permission never recovered.** Deny → enable in Settings → return left the app on "Camera access is off" until relaunch (the cached status was not re-read). | `CameraController.start()` re-reads the authorization every time. |
| 6 | **Overlay buffer size was set with width/height keys** — AVFoundation forbids that while `deliversPreviewSizedOutputBuffers` is on (the `.photo` preset's state) and raised an exception at launch (found on the device). | The size is now chosen with `deliversPreviewSizedOutputBuffers` only (on = preview-sized, off = full size); no width/height keys. The earlier runtime geometry self-check was removed as unnecessary. |
| 8 | **Screen auto-lock** ends the camera session after ~30 s without touch — fatal for a 10-minute lighting stack on a tripod. | `ScreenAwake` keeps the screen on while the camera screen, a stack or processing is active. |
| 9 | **Tapping the screen shakes the phone** (and the first frame of every stack/each lighting frame). | Settings › Shutter delay (default 2 s; Off / 2 / 5) with an on-button countdown, for single photos, the first frame of a stack and each lighting frame. |
| 10 | **RAW development orientation was left to a default** while processed frames were explicitly upright. | `CIRAWFilter.orientation` is set from the file's EXIF orientation (property exists, iOS 15+ — checked in Apple's docs). |
| 11 | **Megapixel/size readouts and the storage estimate used hard-coded 4032×3024.** | The engine reports the photo sizes the session really supports; the UI, the preflight estimate and the stack manifest use them. |
| 12 | **Background task never returned.** The expiration handler was empty; iOS terminates apps that keep a background task past its grace period. | The handler now cancels processing at the next checkpoint (resumable) and ends the task. |
| 13 | NEAR and FAR at the same position gave the misleading "Set NEAR and FAR focus first". | Specific message. |
| 14 | A ProRAW enable flag left on from one lens could carry over to a lens without ProRAW. | The flag follows the active module's support on every lens change. |

## Checked against Apple's documentation and found correct
`CIRAWFilter.orientation` (settable) · `CIFormat.RGB10` (iOS 17) and the HEIF writer signature · `exposureTargetOffset` = metered level
minus target (so a positive value means too bright; the priority loop's initial sign matches, and it self-corrects if not) ·
`AVCapturePhotoSettings.maxPhotoDimensions` defaults to the smallest supported size and must be one of the active format's ·
RAW-only capture needs flash off and a delegate (both satisfied; the other RAW restrictions apply only to RAW+processed requests) ·
ProRAW must be enabled before the session starts (it is, at configuration).

## Known weak spots that remain (cannot be settled without a device)
* Everything in `LIMITATIONS.md` marked device-unverified, notably the exposure-priority loop and the overlay buffer scaling.
* Probing lens capabilities relies on the scratch session applying the `.photo` preset's format before `activeFormat` is read; if
  it does not, ISO/shutter ranges and the 35 mm-equivalent label could come from the default video format (a slightly different
  field of view). The photo sizes themselves are read again from the running session (fix 11), so they are not affected.
* RAW (DNG/ProRAW) development speed at 48 MP: `CIRAWFilter` is rendered strip by strip; if it re-demosaics the whole frame per
  strip it will be slow. Use HEIF for large stacks until this has been timed on the phone.
* A capture interrupted by the app being **killed** cannot continue capturing; the next launch offers RESUME PROCESSING, which
  processes the frames that were saved.
* Volume-button/remote shutter is not implemented (the shutter delay covers the common case).

---

# Round 2 — first test on a real iPhone

Everything above was found by reading code. These were found by *using* the app, so they matter more.

| # | What happened on the phone | Cause | Fix |
|---|---|---|---|
| 1 | Crash at launch | Setting width/height on the video output while the `.photo` preset had `deliversPreviewSizedOutputBuffers` on. | Removed (see Round 1, #6). |
| 2 | Shutter button dead after switching to RAW | Not reproduced here. The shutter was disabled by several conditions (capturing, stack busy, "camera not running"), and a capture that never reported back would leave it dead. | In SINGLE mode the shutter is disabled **only while a photo is actually being taken**. Captures time out after 40 s and report an error; the camera is restarted if it had stopped; pressing during a countdown cancels it; the running state is read from the session (KVO) instead of a one-shot flag. A toast/alert reports every outcome. **If it happens again, the message will say why.** |
| 3 | "Developing frames 4/4" for ages, bar barely moved | (a) The label reported when a frame *finished*, so it read 4/4 for the whole alignment + blending; (b) the app was running as a **Debug build**, which compiles image processing 10–50× slower and hotter. | Progress now reports when each step *starts*, every phase boundary, elapsed time, a time-left estimate once it is meaningful, a plain-language explanation per phase, and a Debug-build warning. Run scheme is now **Release**, and the core package is optimised even in Debug. |
| 4 | Phone burning hot during processing | Debug build (above) plus three worker threads at full priority, decided once at the start. | Two workers at normal temperature, one when warm, **paused when critical**; the limit is re-checked before every tile; processing runs at utility priority (efficiency cores). Quality is unchanged. |
| 5 | Manual focus: only + / − buttons, very slow | The slider that existed needed a long-press for fine mode, and every drag event queued an awaited lens move. | A real slider: drag with your thumb; **speed controls precision** (quick swipe = whole range, slow = down to ~4 % of finger travel, with a FINE/FULL badge). ± buttons repeat and accelerate while held. Lens moves are fire-and-forget and coalesced. Logic is unit-tested (`FocusDragTracker`). |
| 6 | Peaking lines far too thick at 4×/8× | Peaking was drawn at video-buffer resolution, so each marked pixel became a 5–8 px block when magnified. | From 2× up, peaking is drawn as thin strokes (~1.3 screen px) at screen resolution. Only the visible region is analysed (1/64 of the frame at 8×), and 3× and above automatically use full-size buffers so there is real detail to judge. |
| 7 | Slow shutter makes the live view dark and laggy | The preview ran at the photo's own slow shutter. | LIVE VIEW: OFF / MATCH / BRIGHT (ISO and shutter tabs, manual mode). MATCH keeps the same exposure with a faster shutter and higher ISO; BRIGHT adds 2 EV. The real ISO/shutter are restored for the instant of capture. |
| 8 | Stack modes were not self-explanatory ("where do I add photos?") | Steps lived only in a paragraph of small text; capture was implicit in the round shutter button. | Numbered steps (collapsible), ✓ as NEAR/FAR are set, one obvious primary button per stage (START / CAPTURE FRAME n / CAPTURE LIGHT POSITION n), and **IMPORT PHOTOS INSTEAD** in every stack mode. |
| 9 | Hand-held test stack could not be aligned | Registration only converged from small offsets. **Found by a new test** with 30–75 px shifts, 1–2.3° rotation, focus breathing and defocus: it failed. | A coarse whole-image shift search provides the starting point when (and only when) it clearly beats "no shift". The new test (six hand-held cases up to ±15 % shift) passes; tripod behaviour is unchanged. |
| 10 | Feels unfinished | No feedback on capture. | Shutter flash, haptics, a "Saved to …" toast, a processing screen with elapsed time. |

Also fixed while here: a capture-format sync loop between settings and camera (stack overflow on first change), the ProRAW flag carrying over between lenses, and several state-less buttons.
