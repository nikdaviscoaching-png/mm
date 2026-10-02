# Prompt for the next session (paste this)

You are continuing **SPECIMEN CAMERA**, a native iPhone camera app for photographing polished rocks, agates, geodes and minerals
(SwiftUI + AVFoundation + Metal + Core Image; focus, lighting and combined stacking). Repo: `nikdaviscoaching-png/mm`, project in
`SpecimenCamera/`, open `SpecimenCamera/SpecimenCamera.xcodeproj` (Xcode 16+, iOS 17+). Read `README.md`, `docs/AUDIT.md`,
`docs/LIMITATIONS.md` and `docs/DECISIONS.md` first. The owner builds on a Mac and runs it on an iPhone with a free Personal Team.

## The bar
The owner expects an app that feels like a 4.5-star native iPhone app and **works on the first build and first launch**. Every
previous round cost them a build/run cycle because of avoidable mistakes. You cannot compile iOS code in this environment, so
**treat every line you write as if it must compile and run correctly the first time**, and prove what can be proved.

## How to work (non-negotiable)
1. **Ship nothing you have not checked.** Parse-check every changed Swift file (`swiftc -parse`). Put all logic that can be
   headless in `Packages/SpecimenCore` and test it (`swift test -c release -Xswiftc -enable-testing`). Say plainly what is verified,
   what is only parse-checked, and what needs the phone.
2. **Check Apple APIs against Apple's documentation before using them** (`https://developer.apple.com/tutorials/data/documentation/<framework>/<type>/<member>.json`).
   Many AVFoundation calls raise Objective-C exceptions that Swift cannot catch and that crash the app at launch: invalid photo
   settings, `maxPhotoDimensions` not in the active format's list, `videoSettings` width/height while
   `deliversPreviewSizedOutputBuffers` is on, invalid white-balance gains, ZSL/responsive-capture ordering, ProRAW enabled after the
   session started. Guard every such call; never assume a default.
3. **Do not add or delete source files unless you must.** The owner sets their signing Team inside the generated `project.pbxproj`;
   regenerating it overwrites that and causes merge pain. If you must add a file, run XcodeGen, say so, and never touch signing
   settings, the bundle id or `DEVELOPMENT_TEAM`.
4. Push only to the branch you were given. No new branches, no PRs unless asked.

## Mistakes already made — do not repeat them
* `NSObject` subclasses: a failable `init?()` collides with `NSObject.init()` (use a labelled init).
* Core types used by the app need **public** initialisers/members; a type name can be ambiguous with an Apple type (qualify
  `SpecimenCore.X`).
* One property wrapper per declaration (`@State var a = 1, b = 2` does not compile).
* `[weak self]` belongs on the outer closure, not inside a nested `Task { @MainActor in … }`.
* Closures that run on background queues must not inherit `@MainActor` (mark `@Sendable`); read `@MainActor` state before building a
  `@Sendable` closure.
* `@Published` publishes on every set, even to an equal value — two-way syncs need `removeDuplicates()` or they recurse.
* Appending tests with a script: make sure they land inside the `XCTestCase` class (check the executed-test count rises).
* **Debug builds run image processing 10–50× slower and hotter**; the scheme runs Release and the core package is optimised in Debug.
* Anything that can be slow must show honest progress (what step, elapsed time) and be cancellable; anything that heats the phone
  must respect thermal state; no button may be left permanently disabled by a state that can get stuck.
* Preview vs capture: the live view may be brightened for usability, but a photo must use exactly the user's settings.

## What good looks like here
Direct manipulation (drag a slider, don't tap +/-), speed-sensitive precision for focus, thin accurate peaking at 4×/8×, a bright
live view in manual mode, self-explanatory stack workflows (what to do next, one obvious button, import as an alternative), honest
progress, haptics and confirmation toasts, and image integrity (no generative content, nothing uploaded, sources deleted only after
the final is verified).

## Before you finish
Re-read your own diff adversarially for compile errors and launch/first-use crashes; run the core tests; update the docs; commit;
push; and give the owner a short list of what changed and exactly what to test on the phone.
