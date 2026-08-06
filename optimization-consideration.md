# Optimization proposal — getting Battle Juice under 1 GB

Status: proposal, nothing implemented. Written after profiling the current
cold load on 2026-08-05.

The goal is one code path that works on a phone and on a desktop, with a
resident footprint around 300 MB and a hard ceiling of 1 GB. Today the desktop
tab sits at 5.6 GB and a phone dies before it draws a frame.

---

## 1. Where we are

All figures below are **measured**, not estimated — headless runs of
`scripts/profile-world.ts` plus a memory probe, on an Apple-silicon laptop
against the staged Portland extract.

| Stage | Time | Memory after |
| --- | --- | --- |
| `map.json.gz` download | — | 32 MB on the wire |
| gunzip → JSON text | 0.27 s | 147 MB of text |
| `JSON.parse` | 0.94 s | **880 MB JS heap** |
| heightfield decode | 0.01 s | 880 MB |
| `buildWorld` | **21.6 s** | **peak >3.5 GB**, settles at 1.9 GB RSS |

`buildWorld` overruns Node's default 4 GB heap cap outright. In Chrome the tab
reports 5.6 GB once WebGL buffers and three.js overhead are added.

What the map actually contains:

| | count | JSON size |
| --- | --- | --- |
| buildings | 538,519 | 92.9 MB |
| props | 405,582 | 20.2 MB |
| street edges | 84,087 | 12.6 MB |
| sidewalks | 52,692 | 7.0 MB |
| lane lines | 65,068 | 5.7 MB |
| everything else | — | 8.1 MB |

Building footprint shape, which turns out to matter a lot:

| footprint | share |
| --- | --- |
| 4 vertices, near-rectangular | **39.9%** |
| 4–8 vertices | 77.7% |
| more than 12 vertices | 6.7% |
| has a courtyard hole | **0.26%** |

Total ring vertices: 3,763,377. Median building height 6.9 m, p99 13.2 m — this
is overwhelmingly a city of small houses, with a handful of towers.

Occupancy at 1 km tiles: 1,341 occupied tiles, median 232 buildings per tile,
p95 1,277, max 2,208.

## 2. Why it costs what it costs

Two independent problems, each individually fatal on mobile.

**Problem A — the parsed map: 147 MB of JSON becomes 880 MB of heap.**
The multiplier is ~6×, and it is all object-graph overhead. Every coordinate
pair is a 2-element JS `Array` — a heap object with a header and a butterfly
pointer, ~80 bytes to hold 16 bytes of numbers. There are roughly 4.5M of them
across buildings, streets, sidewalks and markings, plus 538k `Building` objects
and 405k prop objects.

**Problem B — the geometry build: ~3.3 GB peak.**
`buildWorld` renders *every building in the city* into merged tile meshes up
front. Each footprint edge emits 6 wall vertices (non-indexed) and the roof is
earcut on top: ~30.6M vertices total. Each vertex is staged in a JS `number[]`
as 9 values — position, normal, colour — at 8 bytes each, then copied into
`Float32Array`s at 36 bytes, with both live simultaneously. That is ~108 bytes
per vertex:

```
30.6M vertices × 108 B ≈ 3.3 GB
```

which matches the measured peak. Note the shape of this: it is not a GPU
problem and not a rendering problem. **The tab dies in JavaScript, before the
first frame.** Lockdown Mode makes it slower (no JIT) but is not the cause.

## 3. The organising principle

> **State is global and compact. Geometry is local and disposable.**

This is the sentence that lets us chunk the map without breaking city-wide
dynamics. Today there is one representation doing both jobs: the parsed
`GameMap` is simultaneously the sim's model and the renderer's source, and
`buildWorld` bakes all of it into GPU meshes at once.

Split them:

- **The city model** — a compact typed-array structure covering the *whole*
  city, always resident, never evicted. Fire spread, dispatch, pathfinding and
  unit movement run over this. It has no idea what is on screen.
- **The render cache** — GPU geometry for the tiles near the camera, built on
  demand and thrown away when they go out of range. It is a *view onto* the
  city model, holding no authoritative state of its own.

Nothing in the sim consults the render cache, so a fire twelve kilometres away
burns and spreads exactly the same whether or not its tile is loaded. This is
the requirement about "across-the-map dynamics", and it is satisfied
structurally rather than by careful bookkeeping.

## 4. Proposal

Four stages. Each is independently shippable and each one helps desktop and
mobile identically — there is no mobile branch anywhere in this plan.

### Stage 1 — Binary city model (biggest single win, zero visual change)

Replace `map.json.gz` with a typed-array format: parallel arrays plus offset
tables, no per-feature objects.

Buildings become:

```
ringOffsets : Uint32Array(nBuildings + 1)   // index into coords
coords      : Float32Array(2 × 3.76M)       // x, y interleaved
height      : Uint16Array(nBuildings)       // decimetres, 0–6553 m
use         : Uint8Array(nBuildings)
id          : Uint32Array(nBuildings)
holeRing    : sparse side table             // only 0.26% need it
```

Projected resident size (derived from the counts in §1):

| | now (heap) | binary |
| --- | --- | --- |
| buildings | ~560 MB | 37 MB |
| streets + nodes | ~90 MB | 5 MB |
| props | ~60 MB | 4 MB |
| sidewalks / markings / trails / rails | ~120 MB | 5 MB |
| heightfield | 3.4 MB | 3.4 MB |
| **total** | **~880 MB** | **~55 MB** |

A 16× reduction with no change to what is drawn. The `.gz` download should
land similar to or below today's 32 MB — coordinate deltas quantised to
tile-local `Uint16` compress considerably better than JSON decimal text, though
this needs measuring rather than assuming.

This stage alone probably makes the desktop tab usable. It does not make the
phone work, because Problem B is untouched.

### Stage 2 — Packed vertex attributes (3× on all geometry)

The current 36 bytes of `Float32` per vertex is roughly 3× what is needed:

| attribute | now | packed |
| --- | --- | --- |
| position | 3 × Float32 = 12 B | 3 × Uint16 tile-local = 6 B (1.5 cm precision over a 1 km tile) |
| normal | 3 × Float32 = 12 B | octahedral 2 × Int8 = 2 B |
| colour | 3 × Float32 = 12 B | 4 × Uint8 normalised = 4 B |
| **per vertex** | **36 B** | **12 B** |

Also switch buildings to *indexed* geometry: a wall quad is 4 vertices and 6
indices instead of 6 vertices. Combined, a median 7-vertex building goes from
~57 vertices × 36 B ≈ 2.1 KB to ~35 vertices × 12 B + 57 × 2 B ≈ 0.5 KB.

Crucially this also kills the `number[]` staging buffer — the packing loop
writes straight into a pre-sized `ArrayBuffer`, so the 8-bytes-per-number
intermediate disappears and peak stops being ~3× resident.

### Stage 3 — Tile streaming with baked LOD

Split the world into 1 km tiles (1,341 occupied, median 232 buildings) and
build only what the camera can see, at a detail level chosen by zoom:

| level | content | shown when | source |
| --- | --- | --- | --- |
| LOD0 | full prisms + sidewalks + markings + props | view height < ~800 m | built at runtime from the city model |
| LOD1 | roof polygons only, no walls | view height < ~4000 m | built at runtime |
| LOD2 | urban-mass texture on the terrain — building coverage + mean height per 20 m cell | always | **baked offline**, ~2 MB compressed |

LOD2 is the trick that makes zoom-out free. At 12,000 m view height individual
buildings are subpixel anyway; a coverage/height texture painted onto terrain
we already render reads correctly and costs one texture for the entire city.
The existing zoom gates (`PROPS_VIEW`, `NEAR_PROPS_VIEW`) are the same idea
already applied to props — this generalises it.

Resident geometry then depends on cache size, not city size:

```
5×5 LOD0 tiles ≈ 12,500 buildings × 0.5 KB ≈ 6 MB
LOD1 ring out to ~8 km  ≈ 50,000 buildings × 0.1 KB ≈ 5 MB
```

Budget the cache at 128 MB and it is never the binding constraint. **This is
the part that decouples footprint from map size** — Portland at 43 × 36 km
costs the same as a map ten times larger.

Projected totals:

| | now | proposed |
| --- | --- | --- |
| city model | 880 MB | 55 MB |
| resident geometry | ~3.3 GB peak / 1.9 GB settled | ~130 MB (capped) |
| three.js, textures, fire particles | ~100 MB | ~50 MB |
| browser + WebGL baseline | ~1 GB | ~150 MB |
| **total** | **5.6 GB** | **~380 MB** |
| time to first frame | ~25 s | ~2 s (manifest + heightfield + LOD2 + nearby tiles) |

### Stage 4 — Worker builds and a frame budget

Tile building must not run on the main thread. A Web Worker owns the city model
buffers, builds packed tile geometry, and transfers the `ArrayBuffer` back
zero-copy; the main thread only wraps it in `BufferAttribute`s. Cap tile builds
per frame so scrolling never janks.

For battery, which is a real concern on the phone:

- clamp `devicePixelRatio` (a 3× retina phone renders 9× the pixels for no
  visible benefit at this art style)
- drop to 30 fps when the camera is idle; stop the loop entirely when the tab
  is hidden
- the existing `SHADOW_MAX_VIEW` gate already does the right thing for shadows

## 5. How city-wide dynamics survive chunking

The fire and destruction sim currently uses `BuildingShells` to do in-place
vertex surgery on merged tile meshes, addressing buildings by their index in
`map.buildings`. Under this proposal:

- **Sim state moves into the city model** as parallel arrays: `charLevel`
  (`Uint8`), `collapsed` (bitset), `fireIntensity` (`Uint8`), all indexed by
  building index, all city-wide and always resident. Cost for 538k buildings:
  under 2 MB.
- **The sim never touches geometry.** Spread, ignition, collapse and crew
  dispatch read and write those arrays for the whole city, loaded or not.
- **`BuildingShells` becomes per-tile and rebuildable.** When a tile is built,
  the builder reads `charLevel` / `collapsed` for its buildings and bakes the
  current appearance in. A tile evicted mid-fire and revisited later comes back
  correctly scarred, because the scar lives in the sim arrays, not the mesh.
- **Live edits still work** exactly as now — vertex-range surgery, just scoped
  to a loaded tile. Edits to unloaded tiles are a no-op on geometry and a plain
  array write in the sim.
- **Off-screen fires stay visible.** Smoke columns are tall; render distant
  fires as a merged impostor plume driven by the sim's per-fire aggregate, and
  only spawn the full particle system for fires in loaded tiles.

The one genuine behavioural risk is anything that currently derives sim state
*from* geometry. That needs an audit of `fire.ts` (1,613 lines) before
committing to the design.

## 6. One code path, one tunable

Mobile and desktop run identical code. The only difference is the tile cache
budget, chosen at runtime from `navigator.deviceMemory` where available and a
conservative default where not (Safari does not report it). A phone gets a
smaller resident radius and reaches for LOD1 sooner; nothing else differs. No
lite map, no separate asset pipeline, no device branch in the renderer.

Worth noting: with a 380 MB footprint, the phone is no longer the constrained
case in any interesting way. The current design fails on mobile because it is
extravagant everywhere, not because phones are weak.

## 7. Option worth considering: instanced box buildings

39.9% of buildings — 214,863 of them — are near-rectangular 4-vertex
footprints. Those could be drawn as instanced boxes: one shared geometry plus
a per-instance transform and colour, ~32 bytes each. The entire city's
rectangular buildings would cost **6.9 MB**, resident, permanently.

Attractive, but it costs fidelity in the destruction sim: instancing gives one
colour per building, so `charLocal`'s per-vertex soot gradient degrades to a
flat tint, and `collapse`'s jagged rubble mound becomes a squashed box. That
may be a fine trade for houses in the distance and a bad one up close — which
suggests it belongs as an LOD1 implementation detail rather than a replacement
for LOD0. Not recommended for the first pass.

## 8. Suggested order

1. **Stage 1** — binary city model. Largest win per unit of work, no visual
   change, no renderer changes. Desktop drops from 5.6 GB to roughly 1.5 GB.
2. **Stage 2** — packed vertices. Contained, mechanical, helps every stage
   after it.
3. **Audit `fire.ts`** for geometry-derived state before committing to tiling.
   *Done — see `fire-geometry-audit.md`. It moved to first, since its findings
   decide what the binary format has to carry.*
4. **Stage 3** — tiling and LOD. The real fix; the phone works after this.
5. **Stage 4** — worker builds and battery tuning. Polish, but the difference
   between "runs" and "pleasant".

Stages 1 and 2 are worth doing regardless of whether tiling ever happens.

## 9. What is measured and what is not

Measured: everything in §1, and the footprint statistics in §1.

Projected, with the arithmetic shown but not yet validated by a prototype: all
memory figures in §4. The binary-format sizes are straightforward
element-count arithmetic and should hold within ~20%. The 380 MB total is the
softest number here — browser and WebGL baseline overhead is an estimate, and
the tile cache figure assumes a cap we choose rather than a measurement.

The compressed download size of the binary format is genuinely unknown and
should be measured early, since it is the one number that could come out worse
than today.
