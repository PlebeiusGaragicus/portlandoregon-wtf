# Polish backlog

Visual/feel items spotted during the 2026-08-05 layer-conformance session,
roughly ordered by visible payoff. Deployment/gameplay backlogs live in
`docs/additional-landmarks.md`; this file is streetscape/render polish.

## Street-level (biggest visible wins)

1. **Intersections.** Yellow centerlines run straight through junctions and
   zigzag where edges meet at angles; overlapping ribbon ends from 3–4
   streets stack visibly. Cheap fix: trim lane lines back ~10 m from graph
   nodes (stop bars already exist in the marking-areas layer). Fuller fix:
   pave each junction as one filled polygon patch at the node.
2. **Planting strip.** With roads now filling the right-of-way, the band
   between curb and sidewalk reads as dark void. Tint it grass green — the
   parkway where the street trees stand. Options: paint terrain vertex
   colors along street corridors, or a verge ribbon between road edge and
   sidewalk line.
3. ~~**Bridges are paper.**~~ **Done (2026-08-07)**: every spanning leg now
   carries a 1.7 m slab (fascia + soffit), 1.15 m edge barriers, and square
   piers every 45 m wherever there is real air beneath — 1,465 legs, 98 km.
   The structure hangs off the same deck-height rule as the road ribbon, so
   it cannot drift from the surface it holds up. Deck *outlines* are now
   extracted too (`bridges` layer, 541 decks — see `docs/map-derivations.md`
   §4b) but are not used yet: they would give true deck shapes instead of
   `RENDER_WIDTH[class]`, once there is a way to lift them to deck height.

## FPV feel

4. **Curbs aren't solid.** FPV collision knows terrain and roofs only; the
   14 cm sidewalk slab passes through your feet. Add sidewalk tops to
   `support()` if it ever reads wrong.
5. **Vehicles drive through the player.** Small player push-out (or a honk)
   when traffic passes through you.

## Known debts

6. **Bluff faces.** The 30 m 3DEP grid goes blocky on near-vertical slopes
   (N Willamette Blvd bluff). Finer city LiDAR/contours are available if it
   bothers us.
7. **Building LOD for FPV.** Buildings dominate frame time; baked per-tile
   LOD is the biggest remaining performance lever.
8. **Seawall slabs over the river.** Waterfront Park esplanade polygons
   extend over the water (real data — docks). Clip to shoreline if they
   look wrong.

## Delivered since (2026-08-05)

- **Conflagration** (`client/src/render/fire.ts`): buildings ignite, char in
  place, spread with the wind, collapse to rubble; trees torch; smoke
  headers; tanks bombard; FPV punch (Hulk mode); dispatch integration both
  ways. Future: bullet holes/scars as decals, debris piles, water arcs from
  engines, fire audio (crackle).
- **Wide-zoom city restored** (2026-08-06): the box far tier stays visible at
  every zoom, and past ~11 km a runtime-baked overhead photograph of those
  boxes takes over (rebaked as the light and the damage change). Water,
  parks, rail yards and the full street grid past the dressing window come
  from a baked ground map (`client/src/render/groundmap.ts`): the real
  vector layers stroked into one full-map texture at 2x and downscaled
  (4096 wide desktop / 2048 handheld), draped on the heightfield, lit by
  the day/night lights. `texSize` is the knob if wide zoom should resolve
  finer street detail. This runtime-baked tier is now the fallback beneath
  the dedicated strategic overview described next.
- **Coherent full-city overview** (2026-08-06): continuous coverage now
  transitions into an aspect-aware, fit-city orthographic camera backed by
  a deterministic offline composite city atlas. Fire, collapse, unit, and
  objective symbols can retain live gameplay context while static civic
  labels stay tactical-only; one ownership decision retires tactical detail
  without a blank frame.
  Architecture, generation, tests, and measured budgets are documented in
  `docs/full-city-overview.md`.
- **Fire realism v2** (2026-08-05): fire is a localized actor — per-building
  fire CELLS creep from the ignition point, flames render on the walls/roof
  where it's burning; per-vertex localized char (extinguished buildings keep
  their scars); game-time burn clocks (house ~3-4 game h, big commercial ~a
  game day); tall black buoyant plumes; embers loft downwind and start spot
  fires; Shift+click (desktop) or long-press (touch) drops a fireball that
  catches or gutters; crews extinguish (knockdown + steam) instead of
  fast-forwarding; rubble is a jagged walk-through ash heap smoldering 1-2
  game days. Future: fire whirl
  under high wind, roof burn-through holes, hose streams.
- **Station-based fire apparatus** (2026-08-06): every mapped fire station
  permanently owns one engine and one truck. Available rigs stay hidden in
  their bays; each fire reserves the four nearest individually available
  apparatus, which pull onto the road, remain assigned through suppression,
  then drive back into their original station and become available again.
