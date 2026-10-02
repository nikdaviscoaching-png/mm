# Limitations

Genuine iOS hardware/API limits, and what the app does about each. Anything marked **(device-unverified)** concerns code that
talks to Apple frameworks; that code could not be compiled or run in the environment this project was built in (see
`TESTING.md` § "What was and was not verified").

## Optics and camera hardware

| Limit | Handling |
|---|---|
| **Fixed aperture.** iPhone lenses have no iris; there is no f-stop control. | No aperture control exists in the UI. Depth of field is extended with FOCUS stacking. The (fixed) f-number is read from `AVCaptureDevice.lensAperture` and used only for planning. |
| **Lens position ≠ distance.** `lensPosition` (0…1) is documented as a *relative* value; Apple publishes no curve to distance. | `FocusDistanceModel` assumes lens travel is linear in diopters (thin-lens optics) anchored by the reported `minimumFocusDistance`. It is used **only for planning** (AUTO frame count) and labelled "≈ … (approx.)" in the UI. The user can always override the frame count; 5/10/15/20/30 presets or any number 2–120. |
| **AUTO frame count is an estimate.** Apple does not expose sensor size, circle of confusion or the true focal length. | `DoF_D ≈ 2·N·c / f²` with `f` derived from the 35 mm-equivalent focal length and a typical per-lens crop factor, `c = 4.5 µm`. If the f-number or minimum focus distance is missing, a conservative empirical step is used instead (`FocusPlan.note` says which). Step = 35 % (Conservative) / 50 % (Normal) / 70 % (Economical) of the estimated DoF, set in Settings. |
| **No shutter-priority or ISO-priority API.** AVFoundation offers only auto exposure or custom ISO+shutter together. | Implemented as a real control loop on the camera's own `exposureTargetOffset` (5 Hz, damped, self-correcting sign). Tapping AUTO on one of ISO/shutter keeps the other manual. **(device-unverified)** — if it behaves badly on a particular scene, set both ISO and shutter manually. |
| **Exposure compensation** is only meaningful in automatic exposure. | The EV control is dimmed with an explanation when exposure is manual. |
| **Optical image stabilisation cannot be switched off for photos** through public API. | Video-preview stabilisation is turned off. During stacks every frame uses the same capture path; if you see a slight shift between frames, alignment corrects it. A tripod is still recommended. |
| **Zero Shutter Lag / responsive capture** (iOS 17) return frames from before the shutter press. | Switched off at configuration so a focus-stack frame is never one captured while the lens was still moving. Single shots are slightly slower as a result. |
| **RAW / ProRAW availability depends on the lens.** | Probed per physical lens at launch (scratch session); the format menu shows only what that lens can deliver. ProRAW 48 MP appears only where the device supports it. |
| **Macro and lens switching.** Virtual multi-camera devices switch lenses automatically (including "macro" on the ultra-wide). | The app uses the **physical** modules directly, never the virtual device, so iOS cannot switch lens or enter macro behind your back; this is the lock. Consequence: no automatic lens hand-over. Each lens' own `minimumFocusDistance` applies; the ultra-wide is the macro-capable one on devices that have it. |
| **Digital zoom.** | Not offered for capture (it would change framing and discard resolution). Pinch is an *inspection* magnifier only (1–8×); it never changes the recorded image. |
| **Magnifier resolution.** The magnifier shows camera *video buffers*, not the sensor 1:1. | Standard: the preview-sized buffers AVFoundation delivers (`deliversPreviewSizedOutputBuffers`). Settings › "High-resolution focus assist" requests the full format size (best for 4×/8×) at higher thermal/CPU cost. |
| **UI orientation.** | Portrait UI only. Photos, preview and overlays follow the phone's orientation through `AVCaptureDevice.RotationCoordinator`, so landscape tripod use produces upright images; the controls stay portrait. While a stack runs the orientation is frozen at its start so every frame has identical dimensions (a phone lying nearly flat can otherwise flip between angles). |

## LiDAR / measurement

LiDAR depth error is of order ±1 cm and it is not trustworthy very close to the sensor. The app **refuses** to present a LiDAR scale
closer than ~25 cm, calls 25–40 cm "rough (±3–8 %)", and always labels the method and uncertainty in the stored scale metadata.
The recommended method is a **manual reference** (card/ruler/scale bar) which is accurate to the precision of your point placement.
The LiDAR→pixels conversion assumes the picture was taken at the same framing and uses an *estimated* sensor geometry
**(device-unverified)**.

## Image processing

* **Colour pipeline.** Working images are 16-bit, display-encoded (sRGB transfer function), Display P3. Blending is done in linear
  light. Values above 1.0 (HDR headroom in ProRAW highlights) and colours outside P3 are clipped when frames are developed.
* **RAW development** uses Core Image's `CIRAWFilter` (Apple's decoder), so colour matches Apple's rendering, not Adobe's. For stacks
  local tone mapping is switched off and sharpening fixed at a modest value so every frame is developed identically.
* **Registration** is a robust *similarity* model (translation, rotation, uniform scale). It handles tripod drift and focus breathing; it
  does not correct perspective changes. Frames it cannot align (very low texture) are flagged and used unaligned, with a warning.
* **Focus fusion** cannot be perfect at hard depth discontinuities (a foreground edge in front of a distant background): a faint
  fringe can remain. On the synthetic benchmark the fused result is within ~0.6 dB of a depth-oracle (see `DECISIONS.md`).
* **Lighting stack** assumes the *camera* is fixed and only the external light moves. Reflections that are fixed relative to the
  camera (the phone's own reflection in a mirror-polished face) appear in every frame and cannot be removed. Two frames work;
  three or more give much better cross-frame references. The automatic base frame is the cleanest by mean quality; if you prefer
  another lighting direction pick it in REPROCESS.
* **Speed.** All stacking maths runs on the CPU, tile-parallel (Metal is used only for the live overlays). Measured on a 4-core x86
  VM: ≈0.6 s per megapixel·frame for focus fusion, ≈0.2–0.6 for lighting; peak memory ≈450 MB at 12 MP regardless of frame count
  (see `TESTING.md`). iPhone timings are expected to differ (faster cores, thermal throttling); **not measured on device**.
  Never sacrificing quality for speed is deliberate: the presets change pyramid depth and proxy size, never output resolution.
* **Background time.** iOS only grants a short grace period when the app is backgrounded. Processing may suspend; if the app is
  killed the project is found at the next launch and processing resumes (`RESUME PROCESSING`), skipping finished steps. A *capture* interrupted by a kill cannot continue capturing; RESUME PROCESSING works with the frames that were saved. (An interruption while the app stays alive — call, app switch — can be continued with CONTINUE.)

## Storage and permissions

* **Importing from Photos** exports the *original* resource with network access disabled (the app is offline). Originals that exist
  only in iCloud must be downloaded in Photos first; the app says so. If you decline full Photos read access, it falls back to the data
  the system picker provides (which for some RAW assets may be a rendition rather than the DNG).
* **Save to Photos** needs "Add Photos Only" access; denial is reported and the file stays in the app library.
* Working data lives in Application Support (excluded from backups); the library does not use iCloud.

## Not implemented / not offered (by design)

* Aperture control, digital-zoom capture, generative fill or any content invention (forbidden by the image-integrity rule).
* Accounts, cloud, analytics, ads, subscriptions.
* Landscape-rotating UI, iPad layout.
