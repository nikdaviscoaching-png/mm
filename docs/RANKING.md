# Ranking methodology

Scores rank valid crossings **relative to each other**. They are not probabilities of finding agate.

\[ \text{score} = 100 \times G \times (0.25S + 0.20D + 0.10E + 0.15I + 0.10T + 0.20R) \]

| Input | Weight | Formula (clipped 0–1) | Rationale |
|---|---|---|---|
| G, geology gate | multiplier | VERIFIED 1.00; VERIFIED combined-top 0.95; PROBABLE 0.85; others excluded | Correct geology is mandatory |
| S, source supply | 0.25 | ln(1+L)/ln(41), L = km of target contact upstream of the primary-reach end | More exposed horizon means more float; log scale for diminishing returns |
| D, concentration | 0.20 | min(1, (L/A)/6) × (1 − 0.35 × Pennsylvanian share) × size penalty (A > 25 km²: down to 0.4 at 200 km²) | Dilution by non-target sediment and big-river transport |
| E, erosion | 0.10 | (mean slope on upstream contact − 12°)/20° | Steep contact slopes shed fresh nodules |
| I, incision/relief | 0.15 | 0.5 × (relief₁ₖₘ − 80)/140 + 0.5 × incision/40 | Deep hollows keep the horizon exposed |
| T, transport/gradient | 0.10 | 1.0 for 0.3–4%; tapering to 0.4 above 12%; 0.5 below 0.3% | Moderate gradients hold gravel bars |
| R, regional evidence | 0.20 | Inside KGS agate outline 1.0; ≤5 km 0.75; ≤15 km 0.5; else 0.3 | Facies belt with documented silica. Partly encodes collecting history, so it is tested in WHY_THIS_BELT.md |

**Not scored:** fault proximity (no source links agate to faults), crossing angle, collector reports, access, famous names.

**Tiers:** after de-duplication, ranks 1–10 are TOP PRIORITY (red), 11–40 STRONG TARGET (orange) and 41–120 MODERATE TARGET (yellow). All other valid crossings are VALID LOWER-PRIORITY CROSSING (grey).

Every input and every raw metric is stored with each point (`datasets/ranked_targets.csv`, `datasets/valid_crossings_scored.csv`), so any score can be recomputed by hand.

## Calibration against documented localities (not used in scoring)

For valid crossings within 1.5 km of each technical locality:

| Locality | Crossings within 1.5 km | Best percentile | Median percentile | Best rank |
|---|---|---|---|---|
| KSPG Stop 6B (silica geodes, Big Hill) | 41 | top 0.3% | 8.1% | 4 |
| Dever 95 Drip Rock (quartz bodies) | 25 | 1.6% | 6.5% | 14 |
| Dever 83 Bighill (geodiferous basal Renfro) | 28 | 2.7% | 15.7% | 18 |
| Dever 89 Rock Lick Creek (mineralized Renfro) | 30 | 4.0% | 9.4% | 33 |
| Dever 87 Owsley Fork | 17 | 7.9% | 17.8% | none ranked separately (reaches shared with nearby ranked targets) |
| Dever 74 / 75 (non-target geodes, contrast) | 0 | — | — | correctly no valid crossings |

Percentile = the share of the 5,421 valid crossings that score higher. The best crossing near each documented locality falls in the top 0.3–8% of the population, and the medians are well above the population median. The contrast localities in the non-target Muldraugh/Salem-Warsaw interval have no valid crossings, as they should. This is partly circular for localities inside the KGS outline (they receive R = 1), but without R the best crossing near each locality is still in the top 0.4–13% (KSPG 6B 0.4%, Drip Rock 1.6%, Bighill 4.6%, Rock Lick 7.0%, Owsley Fork 13.0%), with medians of 8–30%. S, D, E and I carry most of the signal.
