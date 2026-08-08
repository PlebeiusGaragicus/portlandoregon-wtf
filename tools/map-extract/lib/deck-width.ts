// Real bridge deck widths, measured from the city's deck outlines.
//
// The renderer draws a bridge at RENDER_WIDTH[class] — every arterial bridge
// is 17 m, so the Hawthorne, the Marquam and a two-lane overpass are all the
// same object at different lengths. The city publishes actual deck polygons
// (`bridges` layer, 541 of them), which carry the width the street graph
// cannot.
//
// Rather than rebuild bridge geometry around polygons, this measures each
// span's true width and hands it back as a number. Everything downstream —
// slab, barriers, piers, and the FPV collision surface — already derives from
// one deck line and one width, so a measured width improves all of them at
// once and nothing else has to change.

import type { Pt } from "./geo.js";

export interface DeckPolygon {
  rings: [number, number][][];
  kind: "river" | "road";
}

function pointInRing(x: number, y: number, ring: readonly [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Inside the outer ring and outside every hole. */
export function pointInPolygon(x: number, y: number, rings: readonly (readonly [number, number][])[]): boolean {
  const outer = rings[0];
  if (!outer || !pointInRing(x, y, outer)) return false;
  for (let i = 1; i < rings.length; i++) if (pointInRing(x, y, rings[i]!)) return false;
  return true;
}

/**
 * Distance from `p` along `dir` to the first polygon boundary crossing, or
 * null when the ray never leaves (degenerate ring) or leaves immediately.
 */
function rayExit(
  px: number,
  py: number,
  dx: number,
  dy: number,
  rings: readonly (readonly [number, number][])[],
  limit: number,
): number | null {
  let best = Infinity;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, ay] = ring[j]!;
      const [bx, by] = ring[i]!;
      const ex = bx - ax;
      const ey = by - ay;
      const denominator = dx * ey - dy * ex;
      if (Math.abs(denominator) < 1e-12) continue; // parallel
      const t = ((ax - px) * ey - (ay - py) * ex) / denominator;
      const u = ((ax - px) * dy - (ay - py) * dx) / denominator;
      if (t > 1e-6 && t < best && u >= 0 && u <= 1) best = t;
    }
  }
  return best > limit || best === Infinity ? null : best;
}

/** Index of deck polygons by bounding box — small enough that a linear scan
 * over candidates is fine once the boxes filter. */
export class DeckIndex {
  private boxes: { minX: number; minY: number; maxX: number; maxY: number; poly: DeckPolygon }[] = [];

  constructor(polygons: readonly DeckPolygon[]) {
    for (const poly of polygons) {
      const outer = poly.rings[0];
      if (!outer || outer.length < 3) continue;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of outer) {
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
      this.boxes.push({ minX, minY, maxX, maxY, poly });
    }
  }

  /** The deck polygon covering a point, or null. */
  at(x: number, y: number): DeckPolygon | null {
    for (const b of this.boxes) {
      if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY) continue;
      if (pointInPolygon(x, y, b.poly.rings)) return b.poly;
    }
    return null;
  }
}

/**
 * Ceiling on a measured width, as a multiple of the road's own width.
 *
 * At an interchange several carriageways share ONE deck polygon, so a ramp
 * inside it measures the whole structure: service alleys came back at 58 m,
 * 11x their own width. Capping is the better failure than rejecting — an
 * over-wide alley is a bad deck, but falling back to the class default would
 * draw the I-5 crossing at the width of an ordinary arterial.
 */
export const WIDTH_CAP_RATIO = 2.4;

/** Samples that must land inside a deck before we trust the measurement. */
const MIN_HITS = 3;
/** Plausible deck widths. Outside this the match is wrong, not the bridge. */
export const MIN_DECK_WIDTH = 4;
export const MAX_DECK_WIDTH = 60;

/**
 * Measured width of the deck carrying `polyline`, or null when the span does
 * not sit on a published deck outline (most short overpasses do not).
 *
 * The width is the MEDIAN of perpendicular crossings sampled along the span,
 * not the mean: a bridge flares at its abutments and where ramps merge, and a
 * mean drags the whole deck toward those local bulges. The median describes
 * the deck you actually drive on.
 */
export function measureDeckWidth(
  polyline: readonly Pt[],
  index: DeckIndex,
  roadWidth: number,
): number | null {
  if (polyline.length < 2) return null;
  const widths: number[] = [];

  for (let i = 0; i + 1 < polyline.length; i++) {
    const [ax, ay] = polyline[i]!;
    const [bx, by] = polyline[i + 1]!;
    const segLen = Math.hypot(bx - ax, by - ay);
    if (segLen < 1e-6) continue;
    const dx = (bx - ax) / segLen;
    const dy = (by - ay) / segLen;
    // Perpendicular, in both directions.
    const nx = -dy;
    const ny = dx;
    const steps = Math.max(1, Math.min(8, Math.floor(segLen / 5)));
    for (let k = 0; k < steps; k++) {
      const t = (k + 0.5) / steps;
      const px = ax + (bx - ax) * t;
      const py = ay + (by - ay) * t;
      const poly = index.at(px, py);
      if (!poly) continue;
      const right = rayExit(px, py, nx, ny, poly.rings, MAX_DECK_WIDTH);
      const left = rayExit(px, py, -nx, -ny, poly.rings, MAX_DECK_WIDTH);
      if (right === null || left === null) continue;
      const w = right + left;
      if (w >= MIN_DECK_WIDTH && w <= MAX_DECK_WIDTH) widths.push(w);
    }
  }

  if (widths.length < MIN_HITS) return null;
  widths.sort((a, b) => a - b);
  const median = widths[Math.floor(widths.length / 2)]!;
  return Math.min(median, roadWidth * WIDTH_CAP_RATIO);
}
