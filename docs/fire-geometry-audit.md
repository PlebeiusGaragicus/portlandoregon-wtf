# Audit — does the sim derive state from geometry?

Step 3 of the optimization proposal (`optimization-consideration.md` §8),
pulled forward to run *first*, because what it finds decides what the binary
city model has to carry. Freezing the format and then discovering a missing
field means rebuilding the encoder, the loader and the staged map.

Scope: `render/fire.ts` (1,613 lines), `BuildingShells` in `render/world.ts`,
and every caller of either. Buildings are touched by 5 client files plus
`shared/src/los.ts` — the surface is smaller than the line count suggests.

**Verdict: the split is viable. Three couplings, two of which are accidents of
caching and cost a few lines each. One is real and needs a design decision.**

---

## The coupling surface

`FireSim` holds exactly one reference into the renderer: `shells`
(`fire.ts:419`). Everything else it owns — `status`, `hp`, `burns`, `cx`/`cy`,
the spatial grid, trees, smolders — is already sim-side, city-wide, and has no
idea what is on screen. Twelve call sites, in three groups.

### Coupling 1 — `shells.base(bi)` — not a coupling at all

Seven sites: `fire.ts:548, 646, 698, 796, 812, 865` plus `makeCells`.

`baseZ` is a pure function of the footprint and the heightfield: the minimum
ground elevation over the ring vertices, minus one (`world.ts:986-994`). It is
cached in `BuildingShells` only because `buildWorld` happened to be the place
that computed it.

The giveaway: `fpv.ts:56-70` **already recomputes exactly the same thing**
independently, for collision. Two derivations of one value, in two subsystems,
neither aware of the other.

*Fix:* bake `baseZ: Float32Array(nBuildings)` into the city model — 2.2 MB for
538k buildings, or free if it's computed at load from the heightfield we
already have. Delete the copy in `SolidIndex`. Risk: none. This is a cleanup
that happens to be a prerequisite.

### Coupling 2 — `shells.has(bi)` — the dangerous one, and it's a one-liner

Two sites, both gates: `fire.ts:625` (`igniteBuilding`) and `fire.ts:730`
(`damageBuilding`).

Today `has()` means "this building produced geometry", which is false only for
degenerate footprints (`meshIdx === -1`, set for rings under 3 vertices). Under
tiling it would come to mean **"this tile is currently loaded"** — silently
making every building outside the render cache fireproof and indestructible.
No error, no crash; fires just stop spreading past the edge of what you can
see, which is precisely the city-wide-dynamics guarantee the whole design rests
on.

This is the failure §5 of the proposal was worried about, and it is real. It is
also trivial to defuse *now*, while the two meanings still coincide: replace
both calls with a model-side existence test (`footprint.length >= 3`, or a
`valid` bitset baked into the format at 67 KB for the city). Identical
behaviour today, and the trap is gone before tiling can spring it.

Do this before Stage 1 ships, not during Stage 3.

### Coupling 3 — char scars live in the color buffer, and are not recoverable

This is the one that needs a decision.

`charLocal` (`world.ts:211`) rebuilds a building's original vertex colours from
`(footprint, rgb, baseZ)` and lerps toward char black by proximity to a list of
burn sources. It stores nothing — its own docstring says callers must pass
*monotonic* strengths, and that "scars persist in the color buffer". Under
tiling the colour buffer is disposable, so we need the sources to survive
eviction. They don't:

- **Fire scars.** Sources come from `burn.cells[].char` (`applyChar`,
  `fire.ts:918`), which lives in the `Burn` object. When the fire ends, the
  `Burn` is deleted (`fire.ts:883`, `905`) after one final paint. The per-cell
  char values are then unreachable. Rebuild the tile and the building comes
  back clean.
- **Blast scars.** `damageBuilding:743` paints from `hp`, which *is* retained
  in `this.hp` — but the impact point `(px, py)` that localized the scar is
  not.

So today's behaviour is: a burnt-out building keeps its exact soot pattern for
as long as its mesh lives, which is forever. Under tiling, "forever" becomes
"until you fly away", and the city would quietly heal behind you.

Two ways out.

**(a) Store the sources.** A burn samples ~22 perimeter cells plus up to 12
roof cells. Retaining `(x, y, char)` per cell for every building that has ever
burned, quantised to building-local `Uint8`, costs ~100 bytes each — a few MB
even if 5% of the city burns. Exact fidelity, dumb and certain.

**(b) Store the seed instead — recommended.** The cell layout is fully
deterministic: `makeCells(bi, dur, ix, iy)` (`fire.ts:546`) derives positions
and per-cell delays from the footprint, and `dur` from use and area
(`fire.ts:629-630`). Per-cell char is then
`min(1, (t - delay) / (dur * 0.55))` (`fire.ts:1140`). So the entire scar field
reconstructs from **three numbers**: the ignition point and the burn time at
which the fire stopped. About 10 bytes per burnt building, and it composes with
the existing `status` array.

The one thing (b) loses is per-cell hose work — `c.doused` / `c.douse`, set
where a crew knocked down individual blobs. A rebuilt tile would show a
uniformly-progressed burn rather than the exact pattern the crew left. That is
a subtle difference on a building nobody was looking at, and it is recoverable
later by adding a doused-cell bitmask (34 bits) to the record if it turns out
to matter.

Either way the scar record belongs in the city model, alongside `status`.

## What survives untouched

- **Collapse geometry is already stateless.** `collapse()` (`world.ts:253`)
  derives the rubble mound entirely from `(footprint, baseZ, height)` via
  `hash2` — no snapshots, no randomness. `status[bi] === 3` and the
  `collapsed[]` list are already sim-side (`fire.ts:395`), and `index.ts:349`
  already replays them into the FPV collision index on demand. A tile rebuilt
  after a collapse comes back correctly ruined for free.
- **Spread, ignition, damage, crews, trees, smolders, embers** touch no
  geometry. Spread (`fire.ts:1166`) runs over the sim's own 45 m spatial grid.
- **Collision is already independent** — `SolidIndex` is built from the map,
  not from render meshes, so FPV works in unloaded tiles as-is.

## Follow-on scope this exposes

Not blockers, but they belong in Stage 1's estimate rather than arriving as a
surprise:

- `area()`, `pointInRing()`, `makeCells()` and the spread loop all read
  `map.buildings[bi].footprint` as `[x, y]` arrays. These need rewriting
  against the offset-table layout. Mechanical, but it touches `fire.ts`,
  `fpv.ts`, `world.ts`, `landmarks.ts` and `shared/src/los.ts`.
- `b.use` is a string keyed into `BURN_H`; becomes a `Uint8` enum with a
  lookup table.
- `FireSim`'s constructor builds `grid: Map<number, number[]>` over all 538k
  buildings and a second one over trees — a JS object graph of the kind Stage 1
  exists to delete, worth ~10-20 MB. It should become a CSR index (counts +
  offsets + a single `Uint32Array`) baked into the model, which also removes an
  O(city) loop from boot.
- `cx`/`cy` centroids are recomputed at construction from every footprint;
  bake them (4.3 MB) and that loop goes too.

## Conclusion

Nothing in the sim derives *authoritative* state from geometry. What it does is
**cache** three things there — ground elevation, existence, and accumulated
scars — and only the third has no other home.

Recommended order, unchanged from before but now with specifics:

1. ~~Move `baseZ` and the existence test off `BuildingShells`~~ — **done**,
   `client/src/city.ts`. Verified against the full Portland extract with zero
   mismatches; `scripts/test-city.ts` guards the formula.
2. ~~Add the scar record and make `applyChar` a function of it~~ — **done**,
   `client/src/scars.ts`, exposed as `FireSim.restoreAppearance(bi)`.

   Landed differently from the sketch above. Storing the ignition point and
   final burn time would have meant re-deriving cell positions *and* replaying
   the burn clock, and it silently dropped per-cell hose work. Storing the
   cells themselves — positions fixed at ignition, one byte of monotonic char
   each — is smaller in code, exact including dousing and stoking, and reduces
   blasts to the same shape. ~170 bytes per damaged building.

   It also fixed a live bug: because `charLocal` rebuilds pristine colours on
   every call, painting a new fire's sources erased an older fire's scars, and
   a blast wiped the soot off a previously-burnt building. Damage now
   accumulates.
3. Then freeze the binary format, with `baseZ`, `valid`, `cx`/`cy`, the CSR
   grid and the scar table designed in from the start.
