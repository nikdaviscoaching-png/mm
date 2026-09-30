# Mineral Maps Kentucky Agate - 10-pass production code audit

## Audit prompt used

Treat the current deployment ZIP as a production field-navigation web app that may be used on an iPhone with weak or no service. The geology, ranked targets, coordinates, reaches, scoring, research conclusions, pipeline outputs, and source datasets are immutable. Do not reinterpret or regenerate them. Run ten independent passes. At the start of each pass, assume the previous nine reviewers missed at least one defect or avoidable weakness. Re-read the relevant code from scratch for that pass, identify concrete failure modes or usability problems, make only justified revisions, and then test the result. Prioritize field reliability, offline behavior, mobile usability, data preservation, graceful failure, deployment correctness, and prevention of misleading states. Do not make cosmetic changes merely to create a finding. Record what each pass checked, what it found, what changed, and what was verified. After pass ten, run regression tests, verify the immutable research/data files are byte-for-byte unchanged, remove packaging junk, and create a deployment-ready ZIP.

## Pass notes

1. **Deployment and service-worker integrity**
   - Found that several lazy GeoJSON layers were not in the install shell, and the service worker could return the app HTML for a missing JSON/JS request.
   - Added all core map data, including the experimental Menifee layer, to the offline shell. Bumped the app-data cache to v3. Restricted app-shell fallback to navigation requests only.

2. **UI collision and popup behavior**
   - Found a CSS class collision: the field-log placeholder dot and GPS location dot both used `.ff-dot`, so the later GPS rule could distort field-log rows.
   - Split the GPS dot to `.ff-you-dot`. Also fixed the Menifee popup so it receives the same Route here, land-status, logging, ownership, and directions controls as other map popups.

3. **Field-log preservation**
   - Found that GeoJSON/CSV exports intentionally omit photo bytes even though the app warns that device storage can be cleared.
   - Added a lossless `Backup all + photos` JSON export and `Restore backup` flow, plus validation on restore. Added image decode failure handling and safer storage-meter reporting.

4. **Search race conditions and keyboard behavior**
   - Found that opening Search immediately after page load could permanently build the index before ranked targets finished loading. A searched target could also fail to open if its tier layer was off.
   - Search now waits briefly for target data, uses the normal `openTarget()` path, supports Enter/Escape and keyboard activation, and the mobile panel grip is keyboard operable.

5. **Land/access safety language**
   - Found wording that could imply everything outside Forest Service ownership was private and that Forest Service ownership itself implied permission.
   - Changed the UI to distinguish Forest Service ownership from collecting permission, mark other ownership as unverified, and remind the user that routing can include private or restricted roads.

6. **Offline failure recovery**
   - Added the Menifee file to the verified offline data set.
   - `getJSON()` now clears a failed cached promise so a transient miss can be retried. Lazy layer failures now uncheck the failed toggle instead of leaving a misleading enabled state. Offline status parsing now survives damaged localStorage.

7. **Offline road-router reliability**
   - Added per-page network timeouts and a guard that refuses to save a silently truncated road download.
   - Offline A* routing now uses road speed limits when available instead of choosing only the geometrically shortest path. Road distance and ETA are calculated separately. Fragmented downloaded networks are visibly warned instead of always showing a green ready state.

8. **Performance and storage pressure**
   - Removed a full `JSON.stringify()` duplication of the field log merely to estimate its size, which was unnecessarily expensive when photos are present.
   - Kept the existing lazy loading of large optional layers and on-demand preparation of the road graph.

9. **Mobile ergonomics and accessibility**
   - Fixed long toast messages overflowing narrow phones. Improved two-line layout for injected layer descriptions, enlarged popup/route touch controls, and preserved visible-map behavior while the settings sheet is open.

10. **Fresh regression pass**
   - Found additional resilience issues: a corrupted offline-status record could stop startup, failed layer requests could become permanently unretryable, and a missing target/marker match could throw during popup opening.
   - Added guards/retry behavior, clarified the existing target link as `Directions to walk start`, checked compass-invalid readings, and prevented duplicate compass listeners.

## Final verification

- JavaScript syntax checks pass for `app.js`, `field.js`, `road_router.js`, and `sw.js`.
- All 17 JSON/GeoJSON files parsed successfully.
- All 29 service-worker shell files exist at their referenced paths.
- Local HTML resource references resolve.
- Synthetic offline-road graph unit test passed.
- Target/data counts remain 120 ranked targets, 5,301 unranked valid-crossing map features, and 1,253 Menifee experimental features.
- SHA-256 comparison confirms all 38 protected research/data/pipeline files are byte-for-byte unchanged from the input recovered ZIP.

## Production pass (Sept 25, 2026)

Only `states/kentucky/map/app.js`, `field.js` and `field.css` changed. Geology, targets, scores, reaches, GeoJSON, datasets, docs, pipeline and `sw.js` are byte-for-byte unchanged.

- **Settings panel freeze (open item) - found and fixed.** The panel watcher removed a class from the panel even when the class was absent. That still rewrites the class attribute, so the watcher triggered itself forever and the page stopped responding when the panel closed. It happened on every close, whatever had been used before. The watchers now act only when the open state really changes.
- **Empty blue route bar:** the bar's `display:flex` overrode the `hidden` attribute. A global `[hidden]{display:none!important}` fixes it. The bar now shows only when a route exists.
- **Popup buttons wiped:** `popup.update()` rebuilt the content and removed the injected Route here / Log a spot here / Who owns this? / Directions block. Buttons are now added on every `popupopen` and `contentupdate`, and the popup is re-measured without being rebuilt. Target, reach, crossing, Menifee, contact and field-log popups all get the block.
- **Locate follow vs popups:** opening any popup, target, search result or log entry stops follow mode, so the popup stays on screen.
- **Popup tops covered:** the search box, GPS readout, route bar, offline pill and hint hide while a popup is open. Every popup auto-pans below the measured top bar.
- **First-run hint:** positioned in JS above both the right-hand button stack and the zoom/scale controls. It is recalculated on resize and hidden while a sheet is open.
- **Endless re-planning:** the off-route check now counts the walking leg to the road and the walking leg from the road to the destination. It needs two off-route fixes in a row beyond max(150 m, 2x GPS accuracy). It re-plans at most once every 30 s, with no toast or zoom. If the re-plan fails, it keeps the last good road line instead of switching to a straight line.
- **Location denied:** the dead watch is cleared and step-by-step iPhone/Android instructions are shown, with a Try again button. Locate asks again.
- **Menifee search:** the result turns the layer on without the county zoom, then goes to the selected crossing and opens its popup.
- **Offline download:** the 14 app code/brand files are also saved and re-checked (non-empty, parseable, not an HTML fallback). The download also confirms the offline worker is installed and active, and lists what is missing (tiles, data files, app files, worker). Older "verified" records that did not check app code are flagged.

Verified with headless Chromium (phone 390x844 and desktop 1280x800): 27/27 scripted checks passed on each, with no page errors.

## Follow-up (Sept 25, 2026)

Changed code only: `field.js`, `field.css`, and one read-only accessor added to `road_router.js` (`FFRoads.graph`). No data files changed.

- **Road highlighter (basic no-signal map):** a new toggle under Offline draws every Kentucky 911 road in the study area as a yellow highlighter, from the road network saved on the phone. It sits under the creeks and the blue GPS dot and works at any zoom from 11 in, including between creeks where no topo tiles were saved. The first time it's turned on, it downloads the roads (one time, about 25 s on Wi-Fi). The main offline download now also fetches the roads if they're missing. Once saved, it's on by default and switches on automatically when the phone goes offline. Tested: online draw, offline reload, GPS dot offline, hidden when zoomed out.
- **Search contrast:** the results list inherited black text on the dark panel. The input is now light with dark text, and the results are light text on dark.
- **Map movable with layers open:** on tablet/desktop the transparent backdrop no longer blocks the map (phones already allowed this). Tested panning and toggling layers with the panel open at 390x844 and 1280x800.
- **Menifee (?) tiers:** plain-language tiers based on the stored geology-only percentile among all 5,421 valid crossings. Best bet to test (top 5%, 35, large pink numbered), Good option (5-10%, 66, purple numbered), Possible (10-25%, 189, small dots), Weaker (below 25%, 963, faint dots). There is a key in the layer panel, a tier box in each popup, and the start-walking point and confidence are shown from the existing fields. Search lists Best bets and Good options. Close-up offline topo now covers all 35 best bets (was top 25 by rank).

## Final additions (Sept 25, 2026)

- **Back to the truck:** a new 🚙 Truck button under ◎ Locate. The first tap saves your parking spot, waiting for GPS if needed. After that, the GPS readout starts with the distance and direction back to the truck, and a faint dotted trail records where you walked (fixes accurate to 50 m or better, one point per 15 m). Tapping Truck again shows you and the truck together and opens its popup, which has Route here, Park here instead and Clear truck + trail. The truck and trail are stored on the phone and don't need signal.
- **Mark targets as checked:** each target popup has "Your notes on this target" with ✓ Tried — nothing, ★ Found agate and ✕ Not for me, plus a note. Marks are saved as field-log entries tagged with the target, so they're included in exports and in "Backup all + photos". The newest mark changes the map dot: faded with ✓, gold ring with ★, or grey with ✕. It also adds a reminder line at the top of the popup and a badge in the Targets list. The list has new "Not checked yet" and "Checked / marked" filters.
- **Logo and credit:** the uploaded logo is used byte-for-byte as `mineral-maps-icon-1024.png`. The 192/180/32 px icons are straight downscales of it with no cropping or recoloring. The favicon is now linked on the map page. A small "Created by Nik Davis" credit with the logo sits at the bottom of Map settings, and the author appears in the page and app metadata.
- **Fix found while testing:** `marker.setIcon()` failed against the popup-padding property. It's now non-enumerable with a setter.

Regression: all earlier phone/desktop/offline checks still pass, plus 19 new checks for the truck, marks, filters, persistence, the field log and the credit.

## Data safety + location search (Sept 25, 2026)

Small additions to `field.js`, `field.css` only. Existing layers, points, geology, scoring, offline coverage, GPS, truck, notes and statuses are unchanged.

- **Data safety:** saves were already immediate. Every write is now confirmed (including storage-full aborts) and followed by a second on-phone safety copy in a separate database, which is put back automatically if the main field log ever opens empty. The app also requests persistent storage. "Back up field data off this phone" (and the existing Backup button) saves one file with entries, photos, marks, saved places, the truck spot and the trail. It uses the share sheet on phones (Save to Files / iCloud Drive / email) and a download elsewhere. When online with unbacked changes there is one gentle reminder per session. Silent cloud sync isn't included because the app has no account or server.
- **Status chip:** the top bar shows "✓ Data saved" (or "! Not saved") and "✓ Map ready" / "✓ Map · no roads" / "○ Map not saved". A blue dot means changes haven't been backed up off the phone. Tapping it opens the new Field data section in Map settings.
- **Location search:** the existing search box now also accepts coordinates (decimal, N/W, degrees-minutes-seconds; a positive Kentucky longitude is read as West). These work offline. With signal it also finds addresses, roads and places (OpenStreetMap Nominatim). It finds saved points by label or note, including offline. A result drops a temporary draggable red pin with Aerial view, Save + label and Remove pin. Save opens the field log prefilled with the pin position, a new "Saved place" type and the name. Once saved, it's a normal log point and stays available offline.
