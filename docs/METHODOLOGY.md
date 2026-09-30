# Methodology

## 1. Target horizon

Target: the **top of the Nada Member** of the Borden Formation where it lies directly beneath the **Renfro Member** (the dolostone at the base of the Slade/Newman carbonate sequence). South of the Berea quadrangle the upper-Nada lithosome is called the **Wildie Member**. In the Big Hill area the silica (chalcedony and quartz) geodes replace dolostone in the uppermost Nada/Wildie and lower Renfro (KSPG 2013, Stop 6B).

## 2. Geology source and per-quadrangle verification

- Digital geology: KGS 1:24,000 digital geologic quadrangles (formations and contacts services, `KY24KGeologicFormations_WGS84`, `KY24KContacts_WGS84`, and faults), harmonized statewide. In that harmonization the Renfro was merged into the Slade Formation polygon (Msla) on many older maps. The Borden/Msla polygon boundary therefore represents the base of the Renfro.
- For each quadrangle, the original USGS GQ map (scanned PDF from KGS) was downloaded and its legend/explanation OCR'd. For Clay City and Leighton the explanation box was cropped at 300 dpi. The target symbol, the unit above and below, and what the line's upper or lower edge means were read from the legend itself. **No unit was identified from a symbol that merely looks similar.** For example, the Clay City line is coded generically `Mb`, and its legend was confirmed to map Mbr, Mbna and Mbc separately.
- A crossing is used only if its contact line matches a quadrangle-specific rule (`work/rules.csv`, reproduced in QUADRANGLE_TABLE.csv). Classes:
  - **VERIFIED TARGET CONTACT**: the Nada (or Nada+Cowbell) is mapped separately under the Renfro, so the line is the target contact.
  - **VERIFIED TARGET CONTACT (combined-unit top)**: Renfro and Nada are mapped together as `Mbrn`. The line is the top of that unit and the target lies one Renfro thickness below it, a few feet to about 10 m. Weighted 0.95.
  - **PROBABLE STRATIGRAPHIC EQUIVALENT**: the Wildie Member (Mbw) under the Renfro. Weighted 0.85 and shown dashed or less opaque.
  - **AMBIGUOUS / NOT TARGET GEOLOGY**: not used. Kept visible in "Other Borden-top contacts".

## 3. Terrain and drainage

- DEM: USGS 3DEP 1/3 arc-second, exported at 10 m in UTM 16N and resampled to 20 m (110 × 100 km window).
- NHDPlus HR flowlines (23,643) burned 5 m into the DEM, then pits filled and D8 flow directions computed (pysheds).
- Channels are defined as ≥ 1 ha (25 cells) accumulated area. This deliberately includes the unnamed hollows, ravines and headwater channels that NHD omits. In many quadrangles NHD streams begin below the Renfro, so NHD alone would miss the most important source hollows.

## 4. Complete crossing population

Every D8 channel cell step that passes from a cell above the target contact (Renfro/Slade side) to a cell below it (Borden side) is a **crossing**. The step's position is snapped to the nearest mapped contact segment, and its quadrangle, line symbol and polygon pair are recorded. Alluvium (Qal) is treated as neutral, so a channel that crosses the contact under a thin alluvial strip is still found.

- 7,441 downstream crossings (Renfro → Borden) plus 251 reverse-order steps (D8 artifacts, discarded).
- 5,421 valid crossings (VERIFIED 855, VERIFIED combined-top 3,976, PROBABLE 590). All are in `datasets/crossings_complete.csv` with their class and `used_for_ranking` flag. Every valid crossing is scored and visible in the app ("All valid crossings").

## 5. Search reaches

From each crossing the D8 path is followed downstream:

- **Source zone**: the first 15 m of vertical drop or 600 m, whichever comes first.
- **Primary search reach**: 1.2 km, or until drainage area exceeds 60 km².
- **Optional extended reach**: continues to 4 km total.

The geometry is the DEM channel, prefixed with the crossing point. Positions are good to about one 20 m cell, plus the contact uncertainty.

## 6. Metrics (all measured; see RANKING.md for the formula)

| Metric | Definition |
|---|---|
| Upstream target contact | Length of target contact (km) whose cells drain to the primary-reach end |
| Drainage area | D8 accumulated area at the crossing and at the primary-reach end |
| Concentration / dilution | Contact km per km² of drainage; share of drainage underlain by Pennsylvanian clastics |
| Erosion / replenishment | Mean hillslope angle on the upstream contact cells |
| Relief | Max − min elevation in a 1 km window |
| Incision | Mean elevation within ±200 m minus channel elevation at the crossing |
| Gradient | Channel drop over the first 300 m and over the primary reach |
| Hillslope | Mean slope within ±200 m |
| Transport distance | Primary- and extended-reach lengths |
| Documented relation | Distance to the nearest technical locality; whether one lies within 500 m of the reach |
| Fault distance | Nearest mapped fault (reported only) |

Not measured, and stated as such in the app: depositional traps (bar/pool positions cannot be resolved from a 20 m DEM), clast content, land access.

## 7. Diversity (de-duplication)

Many hollows feed the same trunk reach. A crossing is **not** given its own rank if at least 40% of its primary reach overlaps an already-ranked target's reaches, or if it shares reach cells with a ranked target whose crossing is within 2 km. It stays a valid crossing and its popup names the ranked target whose reach it shares.

## 8. Evidence layers

- **Documented (technical)**: Dever (1999) measured sections 83, 87, 89 and 95 (plus 74 and 75 as contrast, non-target geodes), located from Carter coordinates with the KGS section grid; KSPG 2013 Stop 6B. Used only for calibration and popups, not for scoring.
- **Collector / secondary**: Mindat list and a collector blog. Named streams are shown whole because no point locations are given. Not scored.
- **KGS general agate area** (T.N. Sparks, KGS): used as the regional input R.
