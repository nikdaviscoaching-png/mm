# Audits

Each audit asks a different question: the geology audit asks whether the horizon is right, the GIS audit whether the geometry is right, and the prospecting audit whether the ranking is useful.

## GEOLOGY AUDIT — is every used line really the top of the Nada under the Renfro?

| Check | Result |
|---|---|
| Legend verification per quadrangle | 19 quadrangles used. Each GQ legend was OCR'd; the Clay City and Leighton explanation boxes were also cropped at 300 dpi. Target symbol, unit below/above and edge meaning are in QUADRANGLE_TABLE. |
| Symbol matching | Rules are keyed on exact (quadrangle, line symbol, polygon pair). No substring or look-alike matching. Clay City's generic `Mb` line was accepted only after its legend showed Mbr/Mbna/Mbc mapped separately. Ezel's `Mbna`-coded line was **rejected** (AMBIGUOUS) because its explanation shows Borden undivided. |
| Separate vs combined mapping | 855 crossings on separately mapped Nada/Renfro contacts (Alcorn, Berea, Bighill, Panola, Johnetta, Clay City, Levee). 3,976 on combined Mbrn tops (target one Renfro thickness lower, 0.95 weight). 590 probable Wildie crossings (0.85). |
| Excluded horizons | Halls Gap-top (Mbh), Shopville Mbl, Ezel: AMBIGUOUS. Bobtown Muldraugh (Mbm): NOT TARGET. 2,020 crossings excluded but kept in `crossings_complete.csv`. |
| Elevation coherence | Each valid crossing's elevation was compared with the median of crossings within 2 km. Median deviation 4.0 m, 95th percentile 14 m, only 11 of 5,413 crossings deviate by more than 40 m. That fits a single gently dipping horizon, with no mixing of different contacts. Top-120: median 4.7 m, none over 40 m. Rank 9 (Hardwick Creek, −30 m; mapped fault 384 m away) and rank 23 (Clay City, −26 m) sit lower than their neighbours, which is consistent with local fault offset. They are flagged, not removed. |
| Contrast test | Dever sections 74/75, where geodes are in the non-target Muldraugh/Salem-Warsaw interval, have **zero** valid crossings within 1.5 km. |
| Residual risk | On combined-unit quads the exact Nada/Renfro level is interpolated. Renfro thickness was taken from legends only for Stanton, Slade and Pomeroyton. Quadrangle-edge mismatches (Mbrn on one side, Mbna on the other) were not re-drawn. |

## GIS AUDIT — are the points, lines and numbers internally consistent?

| Check | Result |
|---|---|
| Crossing on contact | Every ranked crossing is within 11.8 m of a target contact line of the same class (median 2.4 m; 100% class match). |
| Reach geometry | All 120 primary reaches start at the crossing point and run downhill. None ends higher than it starts (checked against the DEM). Primary reaches are 570–1,230 m (shorter where drainage exceeds 60 km²); 108 have an extended reach. |
| Completeness | All 5,421 valid crossings have every scored metric (0 nulls) and unique coordinates. Non-valid crossings are retained with their class. |
| De-duplication | 120 ranked targets, minimum spacing 281 m (median 1.4 km). Crossings sharing a reach name the ranked target they feed. |
| CRS and precision | Analysis in UTM 16N (EPSG:32616). Delivered in WGS84 at 4–5 decimals. The ±15–40 m positional limit is documented. |
| Offline | Tested in headless Chrome with mobile emulation. Top+Strong download of 1,926 topo tiles plus 14 data files; the verification pass re-read 1,926/1,926 tiles and 14/14 files. With the web server stopped, the app reloaded and drew targets and all 5,301 unranked valid crossings from device storage. |
| App | Mobile layout (390×844). GPS, tap coordinates (4 dp) and long-press copy kept from the shell. Popups, sortable list and all layer toggles load. |

## PROSPECTING AUDIT — does the ranking pick better places, and is it robust?

| Check | Result |
|---|---|
| Separation from the rest | Median upstream contact is 31 km (Top), 25 km (Strong) and 16 km (Moderate), against 17 km for unranked valid crossings. Median incision is 28–33 m against 21 m. |
| Calibration (not used in scoring) | The best crossing near each technical locality is in the top 0.3–8% of all valid crossings: KSPG 6B 0.3% (rank 4 is 1.5 km away), Drip Rock 1.6%, Bighill 2.7%, Rock Lick 4.0%, Owsley Fork 7.9%. |
| Collector reports (not used) | Middle Fork Station Camp Creek, a collector-reported stream, has a TOP target (rank 7) on geology alone. Station Camp Creek, South Fork and Rock Lick Creek have Strong/Moderate reaches. The Drowning Creek report is a roadcut, and no stream crossing was ranked there. |
| Weight sensitivity | 1,000 runs with each weight randomly scaled ×0.5–1.5: the median run keeps 8 of the top 10 and 32 of the top 40. Every current top-10 target stays in the top 40 in at least 94% of runs. |
| Collecting-history bias | Removing R keeps 91/120 and 7/10. Menifee County (Frenchburg quad) is the main beneficiary, so it is flagged as an untested frontier rather than hidden. |
| Famous-name bias | No name, county or report entered the score. Irvine/Estill is well represented (55 of 120) because of terrain and supply, not reputation. The best two targets are in the Big Hill area. |
| Field practicality | Most top sources are ephemeral hollow heads (dry and walkable, but brushy), so the "start walking" point is on the larger channel downstream. Land access is not evaluated. |
| Known weaknesses | Depositional traps are not resolvable at 20 m. Clast dilution is estimated from the geology map, not counted. The combined-unit quads carry a small vertical offset. |
