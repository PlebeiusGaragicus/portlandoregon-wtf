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

Decorative **props layers** (extracted 2026-08-04 — cosmetic only, invisible
to the sim):

| Layer | Endpoint | Records (citywide) | Use |
|---|---|---|---|
| **Street trees** | `COP_OpenData_Environment/MapServer/1415` ("Street Tree Inventory - Active Records", found via DCAT sweep) | 252,205 | Tree props; `DIAMETER` (100% populated) → size class terciles |
| **Signs** | `COP_OpenData_Transportation/MapServer/223` | 195,252 | Whitelisted by `SignCode` (MUTCD minus the dash): `R1010` = stop, `G5500`/`G5501` = street-name blades; `Rotation` = real compass facing. Never extracted unfiltered |
| **Traffic signals** | `COP_OpenData_Transportation/MapServer/54` | 1,171 | Signal-pole props at real intersections |

Optional, later:

| Layer | Endpoint | Use |
|---|---|---|
| Aerial tiles | `Public/Aerial_Photos_Summer_2025/MapServer` (tiled cache, EPSG:3857, LOD 0–23, down to ~1.9 cm/px) | Ground texture / art reference for hand-polishing the map |
| Elevation (raw DEM) | DOGAMI / USGS 3DEP (city services are hillshade *visualizations*, not values) | Terrain slope — probably never; flat is fine for an RTS |

**Skipped entirely:** the Fire MDT service (hydrants, gates, blocked streets).
The study flags it as an undocumented internal operational tool with real
takedown risk — and we don't need it. Everything Battle Juice uses comes from
the **published open-data portal**, which is the low-risk tier. Also skipped:
speed limits (no traffic rules in an RTS) and street view (the study's
conclusion applies doubly here — we synthesize our world from footprints +
heights; photos are the wrong requirement). Signs/signals were originally
skipped as gameplay data; they returned as *cosmetic props* only.

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

## 5. Rendering: real 3D (Three.js), rotatable, cover you can hide behind

*(Decision 2026-08-04: this section originally specified a hand-rolled 2.5D
axonometric projection on Canvas 2D with painter's-algorithm depth sorting.
Superseded — real 3D with a GPU depth buffer makes rotation and occlusion
trivial and removes every depth-sort edge case. Implemented in
`client/src/render/`.)*

The extracted data gives us 2D footprints + heights; the renderer extrudes
them into a low-poly 3D city viewed through an **orthographic tilted camera**.

### Camera model

Keep the **sim strictly 2D** — units live at world `(x, y)` meters on the
street graph; nothing changes there. Rendering is `client/src/render/`:

- **CameraRig** (`camera.ts`): ground-plane target `(x, y)`, a *continuous*
  azimuth `θ`, fixed elevation tilt (~55°), zoom = orthographic frustum
  height in meters (clamped ~60–1800 m). Axis convention: world `(x, y)` →
  scene `(x, h, −y)`.
- **Controls** (`controls.ts`): drag/WASD pan (camera-relative), wheel zoom,
  **Q/E snap rotation** in 45° steps with a short eased tween. Because `θ`
  is continuous, free rotation later is just a different input mapping.
- **Buildings** (`world.ts`): footprint → `THREE.Shape` (holes supported) →
  `ExtrudeGeometry`, all merged into one vertex-tinted, flat-shaded
  geometry — a single draw call for ~2,000 prisms. Streets are mitered flat
  ribbons (width by road class), merged likewise. Light is world-fixed so
  wall shading stays put as the camera spins.
- **Props** (`props.ts`): `InstancedMesh` per prop family (tree trunks,
  canopies scaled by size class with per-instance green jitter, sign
  poles/faces tinted by kind and yawed by real `Rotation`, signal poles) —
  thousands of props in ~8 draw calls.
- **Units** (`units.ts`): cylinder markers in owner color, white ring +
  target line for own units, canvas-sprite name labels; snapshot
  interpolation carried over from the old renderer unchanged.

### Occlusion and hiding

The GPU depth buffer does it: a unit on a street behind a building is
genuinely occluded — "hiding behind buildings" falls straight out of the
z-test, no special mechanic needed. Usability pass (future): a **ghost
silhouette** for *your own* occluded units (`depthTest: false` overlay pass).
Enemy units get no silhouette — being unseen behind a building is the point,
and this becomes real concealment gameplay long before any fog-of-war netcode
exists (Fog phase in `PLAN.md`).

`toWorld()` (click handling) is a raycast against the ground plane —
`main.ts`'s click→dispatch flow is unchanged. Art direction holds: flat-color
prisms + street ribbons in a restrained palette; realism is explicitly not
the goal.

---

## 6. Execution order

Status 2026-08-04: steps 1–3 and 5–6 are **done** (pipeline in
`tools/map-extract/`, baked map at `shared/src/maps/pearl.ts`, Three.js
renderer in `client/src/render/`, props extracted and rendered). Remaining:
step 4 (sim on the graph — `PLAN.md` → Streets) and step 7 (polish).

1. ~~**Freeze the district box**~~ — default Pearl/downtown box used
   (`-122.685..-122.665`, `45.515..45.527` → 1557×1339 m play area).
2. ~~**Extractor: streets**~~ — 1,075 segments, node IDs 100% populated,
   single connected component.
3. ~~**Transform + bake**~~ — local meters, graph + component check, clip,
   37 N/S entry nodes; baked as a generated `.ts` module (`pearl.ts`), 403
   nodes / 653 edges.
4. **Sim on the graph** — `PLAN.md` → Streets: A* movement on the baked
   graph replaces free 2D movement.
5. ~~**Extractor: buildings**~~ — 2,872 footprints → 1,952 in-play prisms.
   `MAX_HEIGHT` 94.8% populated, detected as **feet** (median 13.7/story,
   converted ×0.3048); fallback `NUM_STORY × 3.5 m`.
6. ~~**Renderer**~~ — Three.js (see §5) plus props: 2,953 street trees,
   1,186 signs, 156 signals in the play area.
7. **Polish pass** — palette, aerial-tile reference for hand-tuned details,
   own-unit x-ray silhouettes. (Feeds the War Paint phase.)

### Exit criteria

Two players deploy squads onto real, named Portland streets, dispatch them
through the actual downtown grid, rotate the map with Q/E, and lose sight of
units as they pass behind extruded buildings — with the whole map reproducible
from `MANIFEST.json` by re-running the pipeline. *(All render-side criteria
met; "dispatch through the grid" awaits step 4.)*

---

## 7. Open questions (resolved 2026-08-04)

- **Exact district box** — went with the recommended Pearl/downtown envelope
  as-is; revisit against aerials if the play area needs shifting.
- **Street width source** — road-class lookup (`CFCC`, `TYPE` fallback):
  arterial 14 m / collector 10 / local 8 / alley 4 / path 2.
- **Free rotation vs. snap angles** — 8 snap angles (Q/E, tweened). The
  camera's `θ` is continuous, so free rotation is a future input remap, not
  a renderer change (moot depth-sort concern: real 3D).
- **Bridges/waterfront** — first map stays west of the river, as
  recommended.
- **Committing baked maps** — `pearl.ts` (~420 KB) is committed;
  raw/processed GIS data is gitignored. Revisit (git-LFS / build-time fetch)
  if maps multiply.
