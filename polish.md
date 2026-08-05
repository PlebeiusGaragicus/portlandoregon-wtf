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
3. **Bridges are paper.** Decks are single flat ribbons: no thickness,
   railings, or piers. Deck slab + a few concrete piers to the water would
   sell the 13 Willamette crossings. Pairs with the bridge-identity layer
   (`COP_OpenData_Transportation/79`+`/80`) from the extraction backlog.

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
