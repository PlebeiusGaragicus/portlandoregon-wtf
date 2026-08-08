// Structural form of the Willamette and Columbia crossings.
//
// EVERYTHING IN THIS FILE IS HAND-AUTHORED. It is the only part of the map
// that is not derived from GIS, and it exists because the city's data simply
// does not carry structural form: the River Bridges layer publishes NAME and
// PAVED and nothing else, and the 520-bridge municipal layer types its
// records by USE (VEHICLE / PEDESTRIAN / RAILROAD / SIGN / CULVERT), not by
// how they stand up. Only 8 of those 520 carry any structural hint at all.
//
// Without this table every crossing is a flat slab on regular piers, and the
// St. Johns, the Fremont and the Steel are indistinguishable. With it they
// are recognisable at a glance, which is the whole point.
//
// Dimensions are approximate — main spans are close to published figures,
// rises are eyeballed to read correctly at game scale rather than surveyed.
// Treat them as art direction with a factual basis, not as measurements, and
// do not let them leak into anything that needs real numbers.

/** How a crossing carries itself. Drives both superstructure and piers. */
export type BridgeForm =
  | "suspension"
  | "through-arch"
  | "deck-arch"
  | "through-truss"
  | "deck-truss"
  | "cable-stayed"
  | "lift"
  | "bascule"
  | "girder";

export interface CrossingSpec {
  /** Matches the NAME field of the River Bridges layer exactly. */
  name: string;
  form: BridgeForm;
  /** Clear span between the main supports, metres. Piers stand at its ends
   * and NOWHERE between — that is what makes pier placement believable. */
  mainSpan: number;
  /** Structure height above the deck. 0 where nothing rises above it. */
  rise: number;
  /** Structure depth below the deck (deck trusses, deck arches). */
  drop?: number;
}

/**
 * The thirteen named crossings, in the order the extractor meets them.
 * Anything not listed falls back to a plain girder on regular piers, which is
 * what most of the 520 municipal bridges actually are.
 */
export const CROSSINGS: readonly CrossingSpec[] = [
  // Suspension, and the only one in Portland. The Gothic towers are the
  // silhouette people recognise from anywhere in the north of the city.
  { name: "St. Johns", form: "suspension", mainSpan: 368, rise: 61 },
  // Tied through-arch: the longest of its kind in the world when built.
  { name: "Fremont", form: "through-arch", mainSpan: 383, rise: 43 },
  // Double-deck cantilever truss carrying I-5. The trusswork sits between and
  // below the decks rather than above.
  { name: "Marquam", form: "deck-truss", mainSpan: 134, rise: 0, drop: 14 },
  { name: "Ross Island", form: "deck-truss", mainSpan: 163, rise: 0, drop: 12 },
  // Vertical lift. Two towers with a crossbeam, the lift span between them.
  { name: "Hawthorne", form: "lift", mainSpan: 74, rise: 50 },
  // Double-deck vertical lift — the only one of its kind.
  { name: "Steel", form: "lift", mainSpan: 64, rise: 37 },
  // Bascules: the leaf machinery reads as short towers flanking the channel.
  { name: "Burnside", form: "bascule", mainSpan: 77, rise: 15 },
  { name: "Broadway", form: "bascule", mainSpan: 85, rise: 18 },
  { name: "Morrison", form: "bascule", mainSpan: 86, rise: 15 },
  // Concrete deck arch — the arch springs below the roadway.
  { name: "Sellwood", form: "deck-arch", mainSpan: 82, rise: 0, drop: 18 },
  // Cable-stayed, and the newest. Two towers, fanned stays, no cars.
  { name: "Tilikum Crossing", form: "cable-stayed", mainSpan: 238, rise: 55 },
  // Interstate Bridge over the Columbia: steel through-truss with a lift.
  { name: "I-5", form: "through-truss", mainSpan: 161, rise: 25 },
  // Segmental box girder — long, plain, and correctly unremarkable.
  { name: "Glen Jackson", form: "girder", mainSpan: 180, rise: 0 },
];

/** Table index + 1, so 0 can mean "no special form" on the wire. */
export function crossingKey(name: string): number {
  const at = CROSSINGS.findIndex((c) => c.name === name);
  return at < 0 ? 0 : at + 1;
}

export function crossingByKey(key: number): CrossingSpec | null {
  return key > 0 && key <= CROSSINGS.length ? CROSSINGS[key - 1]! : null;
}
