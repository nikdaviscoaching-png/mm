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
| 6 | **The "standard resolution" overlay buffer setting was never applied at launch** (the initial settings value matched the stored default, so the guard returned early) — the overlay would have run on native, possibly 12 MP, buffers. | Video-output settings are applied when the session is configured and when the lens changes. |
| 7 | **Overlay buffer scaling under a rotated connection is undocumented** and a wrong interpretation would stretch the peaking overlay relative to the preview. | A runtime self-check compares delivered buffer aspect with the expected one; if wrong it tries the other interpretation, then falls back to native size (logged). **Device-unverified.** |
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
