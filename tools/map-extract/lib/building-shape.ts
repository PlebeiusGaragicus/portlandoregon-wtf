// Rejecting footprints that cannot be buildings, and heights that cannot
// stand on them.
//
// A source building is often a MultiPolygon, and we emit one prism per ring.
// Most rings are real, but a tower's geometry frequently carries a handful of
// digitizing slivers a metre or two across — and every ring inherits the
// feature's height. Wells Fargo Center arrives as 45 rings: one genuine
// 1514 m2 tower and 44 slivers of 2-17 m2, all extruded to 163 m. The result
// is a thicket of needles beside Portland's tallest building.
//
// Across the metro that was ~200 spikes over 30 m tall, including three with a
// literally zero-area footprint.
//
// Two rules, because they catch different things: an area floor removes rings
// that are not structures at all, and a slenderness cap fixes rings that are
// plausible in plan but absurd in elevation.

import { ringArea, type Pt } from "./geo.js";

/**
 * Smallest ring we will treat as a building. Chosen from the distribution: it
 * removes 907 rings (0.17%) across the metro, which is the degenerate tail —
 * a 2 x 2 m structure is below what we draw meaningfully anyway. Raising it
 * much further starts eating real sheds and detached garages (a 20 m2 floor
 * would drop 26,251).
 */
export const MIN_FOOTPRINT_M2 = 4;

/**
 * Height ceiling as a multiple of sqrt(footprint area) — how many "footprint
 * widths" tall a prism may be. 6 leaves every genuine tower alone (the
 * tallest building in the extract, 192.5 m on 1124 m2, sits under a 201 m
 * ceiling) while clamping 330 rings that are needles rather than buildings.
 * Lower values start trimming legitimately slender towers.
 */
export const MAX_SLENDERNESS = 6;

/** Plan area of a footprint ring in square metres, winding-independent. */
export function footprintArea(ring: Pt[]): number {
  return Math.abs(ringArea(ring));
}

/** True when a ring is large enough to be worth extruding at all. */
export function isBuildableFootprint(ring: Pt[]): boolean {
  return footprintArea(ring) >= MIN_FOOTPRINT_M2;
}

/**
 * The height a ring may actually carry. Real heights pass through untouched;
 * a sliver inheriting a tower's height comes back at something it could
 * plausibly stand at instead of a needle.
 */
export function plausibleHeight(ring: Pt[], height: number): number {
  const ceiling = MAX_SLENDERNESS * Math.sqrt(footprintArea(ring));
  return Math.min(height, ceiling);
}
