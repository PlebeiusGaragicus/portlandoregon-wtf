# Battle Juice — Portland Map Plan

How we turn **real City of Portland GIS data** into the game's level: a street
graph the sim runs on, plus extruded buildings rendered in a rotatable 2.5D
view where troops can hide behind cover.

This plan is the game-specific adaptation of two research documents (local,
not in this repo):

- `~/Downloads/FireDrive/study.md` — *what* Portland publishes (every endpoint
  verified live on 2026-08-04)
- `~/Downloads/FireDrive/portland-maps-extract.md` — *how* to extract it
  safely and reproducibly

The important parts of both are copied in below so this file stands alone.
This plan feeds the **Streets** phase in `PLAN.md`.

---

## 1. What we need (and what we deliberately skip)

Battle Juice needs far less than the fire-training project those docs were
written for. Two layers carry the whole game:

| Layer | Endpoint | Records (citywide) | Why we need it |
|---|---|---|---|
| **Streets** | `https://www.portlandmaps.com/od/rest/services/COP_OpenData_Transportation/MapServer/68` | 112,385 segments | The street graph — the terrain the entire game plays on |
| **Buildings** | `https://www.portlandmaps.com/od/rest/services/COP_OpenData_Property/MapServer/184` | 249,102 footprints | 2.5D extruded blocks: visual cover, line-of-sight blockers |

Optional, later:

| Layer | Endpoint | Use |
|---|---|---|
| Aerial tiles | `Public/Aerial_Photos_Summer_2025/MapServer` (tiled cache, EPSG:3857, LOD 0–23, down to ~1.9 cm/px) | Ground texture / art reference for hand-polishing the map |
| Elevation (raw DEM) | DOGAMI / USGS 3DEP (city services are hillshade *visualizations*, not values) | Terrain slope — probably never; flat is fine for an RTS |

**Skipped entirely:** the Fire MDT service (hydrants, gates, blocked streets).
The study flags it as an undocumented internal operational tool with real
takedown risk — and we don't need it. Everything Battle Juice uses comes from
the **published open-data portal**, which is the low-risk tier. Also skipped:
traffic signals, signs, speed limits (no traffic rules in an RTS), and street
view (the study's conclusion applies doubly here — we synthesize our world
from footprints + heights; photos are the wrong requirement).

### Why the Streets layer is a gift

The layer ships **`PDX_F_NODE` / `PDX_T_NODE`** — from/to node IDs. That is a
**pre-built topological graph**: segments sharing a node ID are connected. No
endpoint-snapping heuristics, no distance tolerances, none of the usual
connectivity bugs. This maps *exactly* onto our design (`docs/design.md`):
intersections = nodes, street segments = edges.

Also on the layer: `F_ZLEV`/`T_ZLEV` (z-levels — keeps overpasses from
becoming fake intersections; trust the node IDs, never re-snap geometry),
`FULL_NAME` (e.g. `"NE RUSSELL ST"` — free flavor for the UI: fight for a
*named* street), `TYPE`/`CFCC` (road class — render arterials wider than
alleys), and `STRUC_TYPE` (bridges/tunnels).

### Why the Buildings layer is a gift

Beyond footprint polygons, each record carries `NUM_STORY`, `MAX_HEIGHT` /
`AVG_HEIGHT`, `SURF_ELEV`/`ROOF_ELEV`, `BLDG_USE`, `YEAR_BUILT`. Footprint +
height = **direct extrusion into 2.5D prisms** with zero modeling work.
Height fallback where `MAX_HEIGHT` is null: `NUM_STORY × 3.5 m`. (Per the
extraction doc: run a field-population stats query *before* relying on either
field — see §4, gotchas.)

`BLDG_USE` is a bonus for later phases: warehouses vs. apartments vs. offices
could get different art or gameplay tags without any authoring.

---

## 2. Scope: one district, not a city

The extraction doc's strongest recommendation, and it fits an RTS map
perfectly: **extract a small, bounded slice and prove the whole pipeline on
it.** An RTS level wants roughly 1–2 km² anyway.

- **First map: a chunk of the downtown/inner-eastside grid.** Portland's
  downtown is a dense, regular street grid with mid-rise buildings — ideal
  RTS terrain: many flanking routes (good for encirclement), short blocks,
  legible geometry. Candidate envelope (WGS84): roughly
  `-122.685..-122.665`, `45.515..45.527` (~1.5 × 1.3 km, Pearl District /
  downtown core). Final box chosen by eyeballing the aerial tiles.
- **Extract with a buffer, clip after.** Pull streets from a box slightly
  larger than the play area, build the graph, *then* clip. Clipping first
  severs edges at the boundary and fragments the graph (a catalogued failure
  mode). The play-area boundary becomes the map edge; boundary nodes on each
  side become the **entry edges** from `PLAN.md` (Streets phase).
- Spatial filter syntax (from the extraction doc):

  ```
  &geometry={"xmin":…,"ymin":…,"xmax":…,"ymax":…,"spatialReference":{"wkid":4326}}
  &geometryType=esriGeometryEnvelopeI&inSR=4326&spatialRel=esriSpatialRelIntersects
  ```

At district scale the record counts are tiny (hundreds of segments, low
thousands of footprints) — a handful of paginated requests. If we ever scale
to more maps, the same pipeline runs with a different box; for citywide pulls
prefer the **bulk shapefile downloads** from the DCAT catalog
(`https://gis-pdx.opendata.arcgis.com/api/feed/dcat-us/1.1.json`, 354
datasets with direct download URLs) over 563 paginated pages.

---

## 3. Etiquette (non-negotiable)

Copied from the extraction doc's principles — these are public government
ArcGIS REST APIs used as designed, but they're municipal infrastructure:

- Rate limit: sequential requests with a delay (2–5 req/s max). No deadline.
- **Extract once, cache locally, build from the cache.** The game server
  never calls Portland at runtime — the map ships as a baked asset.
- Honest User-Agent with contact info.
- Never aggressively parallelize against one service.
- The City's data carries a "no warranty, as-is" disclaimer and no explicit
  license. For a small personal game using the two most-published layers
  (streets, buildings) this is the clearly-intended use; we still keep raw
  extracts out of the public repo and ship only our derived game map.

---

## 4. Pipeline

Stage layout (adapted from the extraction doc; each stage re-runs
independently from the previous stage's on-disk output — when a transform is
wrong, re-run the transform, don't re-download the city):

```
tools/map-extract/            # extraction + build scripts live in this repo
data/
  raw/{date}/                 # untouched GeoJSON responses — never edited, gitignored
  processed/{date}/           # reprojected, clipped, joined — gitignored
  MANIFEST.json               # endpoints, counts, bbox, null rates, checksums, origin
shared/src/maps/pearl.json    # final baked game map — committed, versioned
```

1. **DISCOVER** — never hardcode layer IDs from docs (they drift; the study
   caught several stale ones). Hit `{SERVICE}/MapServer/layers?f=json` and
   `…/query?returnCountOnly=true` first; write the resolved endpoints to a
   config file.
2. **VERIFY** — the single most important check: **confirm geometry is
   real.** A layer can report healthy counts and still return
   `"geometry": null` on every feature (Portland's Water Bureau hydrant layer
   does exactly this — a redacted service that "works" until nothing
   renders). Pull 3 features, assert 100% have geometry, fatal on failure.
   Also run `groupByFieldsForStatistics` on `MAX_HEIGHT` and `NUM_STORY` to
   confirm they're actually populated before the renderer depends on them.
3. **EXTRACT** — paginated queries (`resultOffset`/`resultRecordCount`,
   `outSR=4326`, `f=geojson`), envelope-filtered to the buffered district
   box. Request only needed fields (Buildings has 55; we need ~8).
   Termination: stop on empty batch **and** absent `exceededTransferLimit` —
   either signal alone is unreliable.
4. **VALIDATE** — fail loudly: extracted count == server's
   `returnCountOnly`; 100% non-null geometry; **bbox sanity check** — every
   coordinate inside Portland's real envelope (`-122.86..-122.47`,
   `45.43..45.65`) — this catches projection mistakes instantly, whether
   wildly wrong (0,0) or subtly shifted. Write `MANIFEST.json`.
5. **TRANSFORM** —
   - Reproject once to a **local metric frame**: pick the district centroid
     as origin, convert to meters (UTM 10N as intermediate). The sim wants
     meters; degrees distort distance and break float precision. Origin
     recorded in the manifest.
   - Build the street graph from `PDX_F_NODE`/`PDX_T_NODE`. Validate: one
     dominant connected component (many islands = the clip severed edges).
   - Clip to the play area; mark boundary nodes as candidate entry edges.
   - Simplify segment polylines (Douglas-Peucker) — GIS vertex density is
     overkill for gameplay.
6. **BUILD** — emit the baked game map JSON consumed by `shared/`:

   ```
   {
     meta:      { name, source date, origin lat/lon, size in meters }
     nodes:     [ { id, x, y } ]                      // intersections
     edges:     [ { id, a, b, polyline, width, name, class } ]
     buildings: [ { id, footprint, height, use } ]    // 2.5D prisms
     entries:   { north: [nodeIds], south: [nodeIds] } // deploy zones
   }
   ```

   The **sim** consumes `nodes`/`edges`/`entries` only (movement, supply
   pathing, encirclement — all pure graph work, buildings are irrelevant to
   it). The **renderer** consumes everything. This keeps the sim's
   pure-module rule intact and the per-tick snapshot small — the map is
   static and sent once at join (or bundled with the client).

Scripts are plain Node/TypeScript in `tools/map-extract/` (no Python
dependency; the repo is already a TS monorepo). Run manually, not in CI —
extraction is a rare, deliberate act that produces a committed artifact.

### Catalogued failure modes to carry over

| Symptom | Cause | Fix |
|---|---|---|
| All geometries null | Redacted service | VERIFY stage is fatal on it |
| Pagination never ends | Trusting one termination signal | Check both signals |
| Fragmented graph | Clip severed edges | Buffer-extract, clip after graph build |
| Fake intersections at overpasses | Ignored `F_ZLEV`/`T_ZLEV` | Trust node IDs; never re-snap |
| Mechanic on an empty field | Didn't check population | Stats query first (`MAX_HEIGHT`!) |
| Layer ID 404 | IDs drift | DISCOVER stage on every run |
| Scrambled aerial mosaic | ArcGIS tiles are `{z}/{y}/{x}`, not `{z}/{x}/{y}` | Swap when/if we fetch tiles |

---

## 5. Rendering: 2.5D, rotatable, cover you can hide behind

The extracted data gives us 2D footprints + heights. The game view is a
**slanted (axonometric-style) projection** so buildings have visible walls
and troops can disappear behind them.

### Projection model

Keep the **sim strictly 2D** — units live at world `(x, y)` on the street
graph; nothing changes there. The 2.5D is purely a render-time transform:

- **Camera** = world-space center `(cx, cy)`, rotation angle `θ`, zoom, and a
  fixed tilt. Screen position of a world point at height `h`:
  rotate `(x−cx, y−cy)` by `θ` → scale → **compress the screen-vertical axis**
  (classic ~2:1 axonometric squash) → subtract `h × liftFactor` from screen y.
- **Buildings** are prisms: project the footprint twice (at ground and at
  `height`), fill the roof polygon, and fill wall quads for the
  screen-facing footprint edges. Flat-shade walls by edge orientation
  relative to a fixed light so rotation reads clearly.
- **Rotation** is just `θ` — free-spin or four/eight snap angles
  (Q/E to rotate). Snap angles are the safer first version: fewer
  depth-sorting edge cases, and players keep their bearings.

### Depth sorting and hiding

- **Painter's algorithm** over all drawables (building prisms, units,
  markers), sorted by camera-space depth (the rotated y). Districts have
  low-thousands of drawables — trivially fine at 60 fps.
- A unit on a street *behind* a building sorts behind the prism and is
  genuinely occluded — "hiding behind buildings" falls straight out of the
  draw order, no special mechanic needed.
- Usability pass: draw an **outline/ghost silhouette** for *your own*
  occluded units (classic RTS x-ray) so hiding reads as cool rather than as
  losing your army. Enemy units get no silhouette — being unseen behind a
  building is the point, and this becomes real concealment gameplay long
  before any fog-of-war netcode exists (Fog phase in `PLAN.md`).

### Renderer feasibility

Canvas 2D handles all of this (it's polygon fills after a CPU transform —
the current interpolating renderer keeps working, `toWorld()` becomes the
inverse camera transform for click handling). If district-scale profiling
shows Canvas 2D struggling with per-frame rotation of a few thousand
polygons, the fallback is WebGL/regl or pixi.js — but don't reach for it
until measured. Art direction: flat-color prisms + street ribbons in a
restrained palette will look deliberate and clean; realism is explicitly not
the goal.

---

## 6. Execution order

1. **Freeze the district box** — browse the aerial tiles, pick the exact
   envelope, record it in the extract config.
2. **Extractor: streets** — DISCOVER → VERIFY → EXTRACT → VALIDATE for the
   Streets layer; manifest written.
3. **Transform + bake** — local-meters projection, graph build + component
   check, clip, entry edges, `shared/src/maps/pearl.json` v1 (no buildings
   yet).
4. **Sim on the graph** — this is `PLAN.md` → Streets: A* movement on the
   baked graph replaces free 2D movement. Verify with the existing
   top-down renderer drawing raw streets (no 2.5D yet).
5. **Extractor: buildings** — same pipeline, `MAX_HEIGHT`/`NUM_STORY`
   population check, prisms added to the map JSON.
6. **2.5D renderer** — camera transform, prism extrusion, depth sort,
   rotation keys, own-unit silhouettes.
7. **Polish pass** — street widths by road class, palette, maybe aerial-tile
   reference for hand-tuned details. (Feeds the War Paint phase.)

Steps 4 and 5–6 are independent once step 3 lands — gameplay-on-graph and the
2.5D look can proceed in parallel.

### Exit criteria

Two players deploy squads onto real, named Portland streets, dispatch them
through the actual downtown grid, rotate the map with Q/E, and lose sight of
units as they pass behind extruded buildings — with the whole map reproducible
from `MANIFEST.json` by re-running the pipeline.

---

## 7. Open questions

- **Exact district box** — Pearl/downtown grid recommended; user picks final
  envelope off the aerials.
- **Street width source** — derive from road class (`TYPE`/`CFCC`) lookup
  table, or eyeball from aerial imagery? (Recommend class lookup first.)
- **Free rotation vs. snap angles** — recommend 8 snap angles first.
- **Do bridges/waterfront make the first map?** The Willamette + bridges are
  iconic and `STRUC_TYPE` marks them, but bridges are chokepoints that
  distort early balance testing. Recommend: first map stays on one side of
  the river.
- **Committing baked maps** — map JSON in `shared/src/maps/` is committed;
  raw/processed GIS data stays local and gitignored. Revisit if baked maps
  get large (then: git-LFS or a build-time fetch).
