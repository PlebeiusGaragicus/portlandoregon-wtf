# Map derivations — everything we change about the source GIS data

The published map is not the city's data. It is the city's data put through a
series of deliberate alterations, and this file is the record of them, so that
a future re-extraction from scratch can reproduce the same map rather than
rediscovering these decisions by trial and error.

**Scope:** `tools/map-extract/` only — how raw GIS becomes
`data/processed/{date}/{profile}-core.json`. Rendering choices (colours, LOD,
draw order) are not derivations; they live in `docs/design.md` and
`docs/polish.md`.

**Rule:** every alteration below is a decision that was made *for a reason*.
When you add one, record the reason, not just the constant. A constant without
a rationale cannot be re-derived, only copied.

Machine-readable counterparts of most of these land in the extract manifest
under `transform` (see the end of `tools/map-extract/transform.ts`) — that is
the per-run record; this file is the standing explanation.

---

## 0. Pipeline shape

Six stages, `discover -> extract -> fetch-dem -> transform -> validate -> build`.
The ordering constraint worth knowing: **extract from a box slightly larger
than the play area, build the graph, then clip.** Clipping first severs edges
and fragments the graph — a catalogued failure mode. `BUFFER_DEG = 0.002`
(≈160–220 m) in `config.ts`.

## 1. Play area and projection

| Decision | Value | Why |
| --- | --- | --- |
| Profile `portland` | lon −122.86…−122.30, lat 45.33…45.65 | Portland plus the east/south metro. Deliberately excludes Hillsboro/Beaverton and Sandy. |
| Profile `central` | lon −122.72…−122.65, lat 45.49…45.54 | ~5.5 km core. **Use this to iterate** — a full profile bake is slow and produces a 32 MB artifact. |
| Envelope assertion | `PORTLAND_ENVELOPE` | Every extracted coordinate must land inside Portland's real envelope. Catches projection mistakes instantly. |
| Local frame | metres, x east, y north, origin at the play-area SW corner | Sim and renderer both work in metres. |
| Coordinate precision | `round1` — one decimal | 10 cm. Below the resolution of anything we draw, and it roughly halves the JSON. |

## 2. Street graph

The most heavily altered layer, because a game needs a *connected* graph and
the source is a surveyor's record rather than a network.

- **Trust PDX node IDs; never re-snap.** Endpoints come from `PDX_F_NODE` /
  `PDX_T_NODE`. Re-snapping by position was tried and creates false junctions
  wherever a street passes over another.
- **Weld across jurisdictions** (`WELD_DIST = 2 m`). The street layer carries
  several disjoint node-ID namespaces — Portland proper vs. neighbouring
  jurisdictions — so physically continuous streets do not share an ID at the
  city limits and the graph splits into two huge components. Nodes at the same
  ground position in *originally separate* networks are welded. Never within
  one network: same-position nodes there are intentional (divided
  carriageways). **Matching `ZLEV` only**, so overpasses are never fused.
- **Keep only the dominant connected component** (`DOMINANT_COMPONENT_MIN =
  0.8`). Fatal error if the largest component holds under 80% of edges —
  that means welding failed, and a fragmented graph breaks pathfinding
  silently.
- **Clip to the play area, synthesising boundary nodes** where an edge
  crosses. Edges with both ends outside are dropped.
- **Entry nodes**: boundary nodes on the north/south edges. Whole-city case
  has no border crossings (the network ends at city limits inside the box), so
  it falls back to the network's own extreme nodes, one per x-decile band.
- **Simplification**: Douglas–Peucker, `STREET_EPSILON = 1 m`.
- **Road width is invented.** The source has no width. Derived from road class:
  arterial 14 m, collector 10 m, local 8 m, alley 4 m, path 2 m. Road class
  itself comes from `CFCC` (`A1`/`A2` arterial, `A3` collector, `A4` local,
  `A6` alley, `A7` path), falling back to Portland's numeric `TYPE` when
  `CFCC` is missing.
- **Grade separation** from `STRUC_TYPE`: 21 viaduct / 23 bridge → `bridge`,
  32 → `tunnel`. Tunnels are not rendered.
- **Deck level from `F_ZLEV`/`T_ZLEV`**, kept exactly as claimed, per edge
  end. This is the only thing that says an overpass is above the road it
  crosses — the 30 m DEM does not resolve the cut beneath it, so terrain alone
  leaves every land bridge lying flat on the ground (measured: only 0.9% of
  bridge legs got any clearance before this). `LEVEL_HEIGHT` is 6.5 m in the
  renderer (≈4.9 m standard highway clearance plus the slab). Only edges with
  `struct: "bridge"` are lifted at render time, so a road that merely claims a
  level cannot float.

  **A rejected rule worth recording, because it looked right and was wrong.**
  Levels were briefly resolved per node, taking the lowest any incident edge
  claimed, on the theory that disagreement between two edges meeting at a node
  meant a vertical step in a road. Measured, it does not: of the 1,002 nodes
  where levels disagree, **966 are two different roads crossing** — which is
  exactly what grade separation is, and should stay stepped — and only 36 are
  one named road at two levels, all ramp junctions already carrying both.
  Lowest-wins therefore dragged viaducts down to grade wherever a street
  happened to touch one, putting a dip in the middle of the deck: the bridge
  dived under the road it was meant to cross. It also elevated only 32% of
  bridge legs against 89% for the faithful rule.

  **Accepted cost:** 471 segments ramp between levels, 33 of them steeper than
  40% — the worst climbs 6.5 m over a 5 m stub at a freeway ramp junction.
  These are short kinks at already-dense interchange geometry. Smoothing a
  transition across neighbouring segments would fix them and is not done.

## 3. Buildings

- **Two sources, merged.** Portland's own layer is primary (it carries a rich
  `BLDG_USE`); RLIS regional footprints fill the expansion ring beyond the
  city. Deduplicated by centroid cell, `DEDUP_CELL = 20 m` — an RLIS building
  is dropped when a COP centroid sits within the surrounding cell ring.
- **Height units are detected, not assumed.** `MAX_HEIGHT` is feet in some
  sources and metres in others. We take the median `MAX_HEIGHT / NUM_STORY`
  ratio across the layer; above 6 means feet, and everything is multiplied by
  0.3048. The decision is logged and recorded in the manifest per source —
  **check it after any re-extract**, because a silent unit flip triples the
  skyline.
- **Height fallback chain**: `MAX_HEIGHT` → `NUM_STORY × HEIGHT_PER_STORY_M`
  → two storeys. Note the consequence: **28% of the metro (153,046 buildings)
  lands at exactly 7.0 m**, the two-storey default, and 31% of all heights are
  an exact multiple of 3.5 m rather than a measurement. Residential areas are
  uniform because the source is silent, not because the pipeline flattened
  them. A better height source would be the single biggest fidelity win
  available.
- **Simplification** `FOOTPRINT_EPSILON = 0.5 m`; rings are stored open
  (closing point dropped), outer ring CCW, holes CW.

### 3a. Footprint and height plausibility (added 2026-08-07)

A source building is often a MultiPolygon and we emit **one prism per ring**,
with every ring inheriting the feature's height. Most rings are real, but
towers routinely carry digitizing slivers a metre or two across. Wells Fargo
Center arrives as 45 rings: one genuine 1,514 m² tower and 44 slivers of
2–17 m², all extruded to 163.1 m — a thicket of needles beside Portland's
tallest building. Across the metro this was ~200 spikes over 30 m tall,
including three with a literally zero-area footprint.

Two rules in `tools/map-extract/lib/building-shape.ts`, because they catch
different failures — an area floor removes rings that are not structures at
all, and a slenderness cap fixes rings that are plausible in plan but absurd
in elevation:

| Constant | Value | Why |
| --- | --- | --- |
| `MIN_FOOTPRINT_M2` | 4 | Chosen from the distribution: drops 907 rings (0.17%), the degenerate tail. A 2×2 m structure is below what we draw meaningfully. Raising it eats real sheds and detached garages — a 20 m² floor would drop 26,251. |
| `MAX_SLENDERNESS` | 6 | Height ceiling of `6 × √area`. Leaves every genuine tower alone (the extract's tallest, 192.5 m on 1,124 m², sits under a 201 m ceiling) while clamping 330 rings that are needles. Lower values start trimming legitimately slender towers. |

Counts go to the manifest under `transform.buildingShape`. Covered by
`npm run test:building-shape`.

**Known bad source value, not corrected:** the tallest building in the extract
is 192.5 m on a legitimate 1,124 m² multifamily footprint. Portland's tallest
building is 166 m and its tallest residential about 122 m, so that
`MAX_HEIGHT` is wrong at the source. One building; left alone rather than
special-cased.

## 4. Painted markings

- **Areas** (`markareas`): `AreaStyle == "YF"` → yellow, everything else
  white. Simplified at 0.3 m — they are small, so the tolerance is tighter
  than anywhere else.
- **Lines** (`marklines`): the source `LineStyle` domain is exclusively yellow
  variants, so all lane lines are yellow. Simplified at 0.5 m. Segments
  leaving the play area are flushed and restarted rather than clipped, so a
  line crossing the border becomes two lines.

### 4a. Junction trim (added 2026-08-07)

**The one alteration here that is not a faithful reproduction of the source.**

Real striping is surveyed straight through an intersection: the centreline of
one street and the centreline of the cross street both run to the far side. We
render that literally, so every crossing gets a painted yellow `+` on the
asphalt, which no real street has. Portland's grid puts an intersection roughly
every 60 m, so this was the most-repeated wrong thing in the city.

Three of the four complaints under "Intersections" in `docs/polish.md` turned
out to be one defect, all of it inside a small disk around the junction node:

1. striping running through the crossing;
2. a sideways kink where two streets meet at an angle — each street's
   centreline is simplified independently, so the two endpoints land a metre
   or so apart and the ribbon generator bridges the mismatch;
3. several line-ends piling into a thick smear where 3–4 streets meet.

Deleting the geometry inside the disk removes all three.

Implementation in `tools/map-extract/lib/junction-trim.ts`, applied in
`transform.ts` after both the graph and the markings exist. Constants:

| Constant | Value | Why |
| --- | --- | --- |
| `MIN_JUNCTION_DEGREE` | 3 | Degree-2 nodes are mid-block places where the source split a polyline; degree-1 are dead ends. Trimming at those punches gaps down the middle of straight streets. |
| `TRIM_MARGIN` | 1.15 | Radius is `max(incident edge width) / 2 × margin`. A junction's paved extent is bounded by its **widest** street, so a fixed radius cannot work: one tuned for a residential corner leaves stubs inside an arterial crossing, one tuned for the arterial gouges the residential grid. The margin carries the cut just past the far curb. |
| `MIN_RUN_M` | 3 | Shorter survivors read as dirt on the road, not striping. |

Split runs become independent lines and IDs are reassigned, so `markingLines`
IDs are **not** stable across this change. Per-run counts (junctions cleared,
lines in/out, touched/split/dropped) go to the manifest under
`transform.junctionTrim`.

Covered by `npm run test:junction-trim`.

## 4b. Bridge decks (added 2026-08-07)

Two source layers merged into one `bridges` layer, both polygons — real deck
outlines, which carry width and shape the street graph cannot:

- `COP_OpenData_Transportation/79` "Bridges", 520 in bounds, unnamed at source.
- `COP_OpenData_Transportation/80` "River Bridges", 13 features — **the only
  bridge layer the city publishes with a `NAME`**, and the reason this layer
  exists. River bridges are read first so a Willamette crossing keeps the
  lower id.

Clipped to the play area and simplified at 1 m. Yields 541 decks, 14 named
across 13 distinct names: Glen Jackson is a genuine twin span and arrives as a
MultiPolygon, so anything labelling bridges must dedupe by name.

**Deck widths are measured from these outlines** (added 2026-08-07,
`tools/map-extract/lib/deck-width.ts`). The renderer drew every arterial
bridge at one width, so the Hawthorne, the Marquam and a two-lane overpass
were the same object at different lengths. For each span we sample
perpendicular crossings of the deck polygon along its centre line and take the
**median** — not the mean, because a bridge flares at its abutments and where
ramps merge, and a mean drags the whole deck toward those bulges.

912 of 1,465 spans land on a published outline and get a width; the rest fall
back to the road class. Measured against reality the result is good: the
Burnside roadway comes out at 24.0 m against a real ~24 m, Hawthorne at
21.2 m, Tilikum at 19.2 m.

| Constant | Value | Why |
| --- | --- | --- |
| `WIDTH_CAP_RATIO` | 2.4× the road's own width | At an interchange several carriageways share **one** deck polygon, so a ramp inside it measures the whole structure — service alleys came back at 58 m, 11× their own width. Capping beats rejecting: an over-wide alley is a bad deck, but falling back to the class default would draw the I-5 crossing as an ordinary arterial. |
| `MIN_HITS` | 3 | Samples that must land inside a deck before the measurement is trusted. |

Because the whole bridge — slab, barriers, piers and the FPV collision surface
— derives from one deck line and one width, a measured width improves all of
them at once. Note the consequence that looks like a bug and is not: a bridge
carries its roadway *plus* bridgehead ramps and footpaths as separate edges,
and those are deliberately narrower than the crossing they sit on. The width
that describes a bridge is its main carriageway's.

**Known limitation:** the cap is keyed to road class, so a wide deck carrying
a low-class road is clipped — Tilikum Crossing measures 19.2 m against a real
23.7 m because its edges are class `local`.

**Structural form is hand-authored, and is the one thing here that is not
GIS-derived.** The city publishes no structural type for its river crossings —
River Bridges carries `NAME` and `PAVED`, and the municipal layer types
records by *use* (VEHICLE / PEDESTRIAN / RAILROAD / SIGN / CULVERT), with only
8 of 520 carrying any structural hint. `shared/src/bridges.ts` therefore
carries a curated table of the 13 named crossings: form, main span, rise.
Main spans are close to published figures; rises are eyeballed to read at game
scale rather than surveyed. Treat it as art direction with a factual basis and
keep it out of anything needing real numbers. The transform tags the *longest*
edge inside each named deck so a bridge grows one set of towers, not one per
leg. See `docs/bridges.md`.

**Not yet resolved: decks have no elevation.** The source polygons are flat at
ground level, so draped on terrain they sit *in* the river. Placing them needs
the `STRUC_TYPE` 21/23 street spans that cross each polygon, interpolated —
which is the "bridges are paper" job in `docs/polish.md` item 3, not part of
this extraction.

## 5. Everything else

| Layer | Simplification | Notes |
| --- | --- | --- |
| Water, parks, rail yards, sidewalks | 1 m | Clipped to the play-area rect. |
| Trails, rails | 2 m | Rails merge freight (`rails`) with MAX/streetcar/WES; `TYPE` maps to the rail kind. |
| Rail stops | — | Points, in-rect only. |

**Props** are all point layers, kept only when inside the play area: trees,
signs, signals, lights, meters, furniture, bike parking, traffic calming,
hydrants.

- **Tree size** is bucketed into 3 sizes by DBH terciles computed across the
  layer, because the raw DBH field varies by source. Missing DBH → size 2.
- **Sign rotation** is compass degrees clockwise from north (the direction the
  face points); converted to the renderer's yaw convention as
  `π − deg × π/180`.
- **Signs are filtered** through `SIGN_KEEP`; unlisted codes become `other`.

## 6. Terrain

3DEP 30 m DEM, resampled to the play area. Known limitation: 30 m goes blocky
on near-vertical slopes such as the N Willamette Blvd bluff. Finer city
LiDAR/contours exist if it becomes worth the size (`docs/polish.md` item 6).

---

## Re-extracting from scratch

1. `MAP_PROFILE=central` first. Everything below is faster to check on 5.5 km.
2. Run the pipeline; **read the log**. The lines that matter are the height-unit
   decision, the weld count, the dominant-component fraction, and the junction
   trim counts.
3. Diff the new manifest's `transform` block against the previous one. Large
   swings in counts mean a source layer changed shape, not that the code broke.
4. `npm run test:junction-trim` and `npm run verify:staged-map`.
5. Only then run the full `portland` profile and cut a `map-latest` release.

## Adding a derivation

Append it here with its reason, add the constants to the manifest block in
`transform.ts` so each run records what it used, and add a test if the
alteration has an invariant worth holding (the junction trim does; a
simplification tolerance does not).
