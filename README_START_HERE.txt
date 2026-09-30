MINERAL MAPS — KENTUCKY AGATE PROSPECTING MAP (populated shell)

Open: index.html (redirects to states/kentucky/map/index.html). All paths are relative, so it works at a
domain root (Vercel config kept) or in a sub-folder. Serve over HTTPS (or localhost) for GPS, service worker
and offline storage.

Target horizon: top of the Nada Member (Borden Fm) directly beneath the Renfro Member, verified per 1:24,000
quadrangle from the GQ legends.

Contents
- states/kentucky/map/          the app (index.html, app.js, style.css, field.js, field.css, road_router.js) - shell UI preserved and extended
- states/kentucky/map/data/     all map layers (GeoJSON, WGS84): targets, reaches, target contact, other contacts,
                                all valid crossings, documented and collector evidence, KGS agate area, geology,
                                faults, quadrangles, counties, streams, experimental Menifee geology-only layer
- datasets/                     machine-readable outputs:
    crossings_complete.csv        every channel/contact crossing, incl. non-valid, with class + used_for_ranking
    valid_crossings_scored.csv    all 5,421 valid crossings with every metric and score input
    ranked_targets.csv/.geojson   the 120 ranked targets (Top 10 / Strong 30 / Moderate 80)
    ranked_target_reaches.geojson source zones, primary and extended search reaches
- docs/                         FIELD_PLAN, WHY_THIS_BELT, METHODOLOGY, QUADRANGLE_TABLE (.md/.csv), RANKING,
                                RANKED_TARGETS, AUDITS (geology / GIS / prospecting), SOURCES, LIMITATIONS
                                (Markdown + HTML; docs/index.html links them all)
- sw.js                         service worker: app + core data cached on install; USGS Topo tiles served from
                                the user-triggered offline tile cache

Scores are relative ranks, not probabilities. Land access was not evaluated.

FIELD-USE RECOVERY ADDITIONS (Sept 25, 2026)
- Continuous GPS with phone-heading cone.
- Permanent field log with notes/photos, GeoJSON/CSV export, and full photo-preserving backup/restore.
- Forest Service-owned parcel overlay plus owner lookup. Ownership is not collecting permission.
- Route Here blue line. Online routes are saved; optional Kentucky 911 road download enables new routes to be calculated entirely offline inside the map study area. Routes may include private or restricted roads, so verify access.
These additions do not alter the geology, targets, scores, reaches, coordinates or research datasets.

PRODUCTION PASS (Sept 25, 2026) - see CODE_AUDIT_10_PASS.md, "Production pass"
Fixed: settings-panel freeze, empty route bar, popup buttons being wiped, follow mode pushing popups off screen,
bars covering popups, hint covering buttons, endless re-planning off-road, location-denied recovery,
Menifee search zoom, and an offline check that now includes the app code and the offline worker.
Deploy: import this folder to Vercel as a static site (no build step, output = project root).
