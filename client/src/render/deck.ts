// The one description of where a bridge deck actually is.
//
// Rendering and FPV collision both need it, and they must not disagree: if
// the collision plane sits even slightly off the drawn deck the player falls
// through a bridge they can see, or walks on air beside it. So the deck line
// lives here and both sides consume it.

import type { RoadClass, StreetEdge } from "@portlandoregon/shared";

export type GroundFn = (x: number, y: number) => number;

/**
 * Drawn road width per class — wider than the graph's `width`, which is the
 * carriageway. This is also the deck width, so collision and rendering agree
 * on where the edge of a bridge is.
 */
export const RENDER_WIDTH: Record<RoadClass, number> = {
  arterial: 17, collector: 13.5, local: 11, alley: 5, path: 2.5,
};

/**
 * How wide to draw one edge's deck. A span sitting on a published bridge
 * outline uses the width measured from it; everything else falls back to the
 * class default. Slab, barriers, piers and the FPV collision surface all read
 * this, so a real width improves every one of them at once.
 */
export function deckWidthOf(edge: Pick<StreetEdge, "class" | "width" | "deckWidth">): number {
  return edge.deckWidth ?? RENDER_WIDTH[edge.class] ?? edge.width;
}

/** Max span between deck cross-sections. */
export const RIBBON_STEP = 15;

/** Slab hanging below the road surface, and the barrier standing above it. */
export const DECK_THICKNESS = 1.7;
export const PARAPET_HEIGHT = 1.15;
export const PARAPET_WIDTH = 0.5;

/** The road surface sits this far above the deck line (shared decal height). */
export const DECK_SURFACE_Y = 0.09;

/**
 * Height of one grade-separation level. Standard highway vertical clearance
 * is ~4.9 m; adding the slab puts the upper road surface here above the lower
 * one, which is what ZLEV 2 means.
 */
const LEVEL_HEIGHT = 6.5;

/** Metres to raise each end of a deck, from its resolved grade level. Only
 * spans lift: a road merely marked level 2 without a bridge structure is not
 * something we can hold up. */
export function deckLift(edge: Pick<StreetEdge, "struct" | "zlev">): [number, number] {
  if (edge.struct !== "bridge") return [0, 0];
  const z = edge.zlev ?? [1, 1];
  return [Math.max(0, z[0] - 1) * LEVEL_HEIGHT, Math.max(0, z[1] - 1) * LEVEL_HEIGHT];
}


/** Push the segment parameters (0..1) where `u` crosses integer values. */
function addCrossings(ts: number[], u0: number, u1: number): void {
  if (u0 === u1) return;
  const lo = Math.min(u0, u1);
  const hi = Math.max(u0, u1);
  for (let k = Math.ceil(lo); k <= Math.floor(hi); k++) {
    const t = (k - u0) / (u1 - u0);
    if (t > 1e-4 && t < 1 - 1e-4) ts.push(t);
  }
}

/**
 * Insert points so no span exceeds RIBBON_STEP AND a vertex lands wherever
 * the segment crosses a terrain grid line (columns, rows, and the cell
 * anti-diagonals the mesh is triangulated along). Between two such vertices
 * the terrain surface is planar, so a draped ribbon sampled at them conforms
 * exactly instead of letting slopes poke through mid-span.
 */
export function resample(polyline: [number, number][], cell: number, step = RIBBON_STEP): [number, number][] {
  const out: [number, number][] = [polyline[0]!];
  for (let i = 1; i < polyline.length; i++) {
    const [ax, ay] = polyline[i - 1]!;
    const [bx, by] = polyline[i]!;
    const len = Math.hypot(bx - ax, by - ay);
    const ts: number[] = [];
    const n = Math.ceil(len / step);
    for (let k = 1; k < n; k++) ts.push(k / n);
    if (Number.isFinite(cell)) {
      addCrossings(ts, ax / cell, bx / cell);
      addCrossings(ts, ay / cell, by / cell);
      addCrossings(ts, (ax + ay) / cell, (bx + by) / cell);
    }
    ts.sort((p, q) => p - q);
    let last = 0;
    for (const t of ts) {
      if (t - last < 1e-4) continue;
      last = t;
      out.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
    }
    out.push([bx, by]);
  }
  return out;
}

/**
 * Deck geometry for one bridge leg: centre line, edge offsets and the deck
 * height at each station. Mirrors `pushRibbon`'s span branch exactly — the
 * same mitred normals and the same `max(terrain, lerp(bank, bank))` — because
 * a structure that disagrees with the road surface by even a few centimetres
 * shows as z-fighting along the whole span.
 */
export function deckStations(
  rawPolyline: [number, number][],
  width: number,
  ground: GroundFn,
  cell: number,
  liftA = 0,
  liftB = 0,
): { lx: Float64Array; ly: Float64Array; rx: Float64Array; ry: Float64Array; h: Float64Array; cx: Float64Array; cy: Float64Array } | null {
  const polyline = resample(rawPolyline, cell);
  const n = polyline.length;
  if (n < 2) return null;
  const half = width / 2;
  const lx = new Float64Array(n), ly = new Float64Array(n);
  const rx = new Float64Array(n), ry = new Float64Array(n);
  const cx = new Float64Array(n), cy = new Float64Array(n);
  const h = new Float64Array(n);
  const along = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const px = polyline[i]![0];
    const py = polyline[i]![1];
    if (i > 0) along[i] = along[i - 1]! + Math.hypot(px - polyline[i - 1]![0], py - polyline[i - 1]![1]);
    let nx = 0, ny = 0;
    for (let j = i - 1; j <= i; j++) {
      const a = polyline[j];
      const b = polyline[j + 1];
      if (!a || !b) continue;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const l = Math.hypot(dx, dy) || 1;
      nx += -dy / l;
      ny += dx / l;
    }
    const nl = Math.hypot(nx, ny) || 1;
    cx[i] = px; cy[i] = py;
    lx[i] = px + (nx / nl) * half; ly[i] = py + (ny / nl) * half;
    rx[i] = px - (nx / nl) * half; ry[i] = py - (ny / nl) * half;
  }

  const total = along[n - 1]! || 1;
  const hA = ground(polyline[0]![0], polyline[0]![1]) + liftA;
  const hB = ground(polyline[n - 1]![0], polyline[n - 1]![1]) + liftB;
  for (let i = 0; i < n; i++) {
    const g = ground(cx[i]!, cy[i]!);
    h[i] = Math.max(g, hA + (hB - hA) * (along[i]! / total));
  }
  return { lx, ly, rx, ry, h, cx, cy };
}
