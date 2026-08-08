// Clearing painted centrelines out of intersections.
//
// Portland's `marklines` layer is the real striping, and real striping is
// surveyed straight through a junction: the yellow line for one street and
// the yellow line for the cross street both run to the far side, so every
// crossing renders a painted "+" on the asphalt. Actual streets do not look
// like that — paint stops short of the crossing and the box is bare.
//
// Three of the four complaints in docs/polish.md are the same defect seen
// from different angles, and all of them live inside a small disk around the
// junction node:
//
//   - striping running through the crossing (the "+")
//   - a sideways kink where two streets meet at an angle, because each
//     street's centreline is Douglas-Peucker simplified independently and
//     the two endpoints land a metre or so apart
//   - several line ends piling into a thick smear where 3-4 streets meet
//
// Deleting the geometry inside the disk removes all three at once.

import { round1, type Pt } from "./geo.js";

/** A junction and the radius of paint to clear around it. */
export interface Junction {
  x: number;
  y: number;
  r: number;
}

/**
 * A junction's paved extent is bounded by its widest street, so the trim
 * radius follows the incident edges rather than a single tuned distance: a
 * fixed radius that suits a residential corner leaves stripe stubs inside an
 * arterial crossing, and one that suits the arterial gouges holes out of the
 * residential grid. The margin carries the cut just past the far curb so the
 * line ends outside the crossing street rather than exactly on its edge.
 */
export const TRIM_MARGIN = 1.15;

/** Runs shorter than this read as dirt on the road rather than as striping. */
export const MIN_RUN_M = 3;

/**
 * Only true junctions get cleared. Degree-2 nodes are mid-block places where
 * the source data happened to split a polyline and degree-1 nodes are dead
 * ends; trimming at those would punch gaps down the middle of every straight
 * street.
 */
export const MIN_JUNCTION_DEGREE = 3;

interface Edgeish {
  a: number;
  b: number;
  width: number;
}
interface Nodeish {
  id: number;
  x: number;
  y: number;
}

/** Junction disks for a street graph: degree >= 3, radius from the widest
 * incident street. */
export function junctionsOf(nodes: readonly Nodeish[], edges: readonly Edgeish[]): Junction[] {
  const degree = new Map<number, number>();
  const halfWidth = new Map<number, number>();
  for (const e of edges) {
    for (const id of [e.a, e.b]) {
      degree.set(id, (degree.get(id) ?? 0) + 1);
      halfWidth.set(id, Math.max(halfWidth.get(id) ?? 0, e.width / 2));
    }
  }
  const out: Junction[] = [];
  for (const n of nodes) {
    if ((degree.get(n.id) ?? 0) < MIN_JUNCTION_DEGREE) continue;
    const r = (halfWidth.get(n.id) ?? 0) * TRIM_MARGIN;
    if (r > 0) out.push({ x: n.x, y: n.y, r });
  }
  return out;
}

/**
 * The sub-interval of segment p->q that lies inside a disk, in the segment's
 * own 0..1 parameter, or null when it misses. Tangents (a single grazing
 * point) count as a miss — they would split a line without removing
 * anything visible.
 */
function coverage(p: Pt, q: Pt, j: Junction): [number, number] | null {
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const a = dx * dx + dy * dy;
  if (a < 1e-12) return null;
  const fx = p[0] - j.x;
  const fy = p[1] - j.y;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - j.r * j.r;
  const discriminant = b * b - 4 * a * c;
  if (discriminant <= 0) return null;
  const root = Math.sqrt(discriminant);
  const t0 = (-b - root) / (2 * a);
  const t1 = (-b + root) / (2 * a);
  if (t1 <= 0 || t0 >= 1) return null;
  return [Math.max(0, t0), Math.min(1, t1)];
}

/** Uniform grid over the junctions so each segment only tests nearby ones. */
class JunctionIndex {
  private cell: number;
  private grid = new Map<string, Junction[]>();

  constructor(private junctions: readonly Junction[]) {
    let maxR = 0;
    for (const j of junctions) maxR = Math.max(maxR, j.r);
    this.cell = Math.max(8, maxR * 2);
    for (const j of junctions) {
      // A disk can overlap cells its centre does not, so register the span.
      const c0 = Math.floor((j.x - j.r) / this.cell);
      const c1 = Math.floor((j.x + j.r) / this.cell);
      const r0 = Math.floor((j.y - j.r) / this.cell);
      const r1 = Math.floor((j.y + j.r) / this.cell);
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const key = `${c}:${r}`;
          const bucket = this.grid.get(key);
          if (bucket) bucket.push(j);
          else this.grid.set(key, [j]);
        }
      }
    }
  }

  near(p: Pt, q: Pt): Junction[] {
    if (this.junctions.length === 0) return [];
    const c0 = Math.floor(Math.min(p[0], q[0]) / this.cell);
    const c1 = Math.floor(Math.max(p[0], q[0]) / this.cell);
    const r0 = Math.floor(Math.min(p[1], q[1]) / this.cell);
    const r1 = Math.floor(Math.max(p[1], q[1]) / this.cell);
    const seen = new Set<Junction>();
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        for (const j of this.grid.get(`${c}:${r}`) ?? []) seen.add(j);
      }
    }
    return [...seen];
  }
}

function lengthOf(line: Pt[]): number {
  let total = 0;
  for (let i = 1; i < line.length; i++) {
    total += Math.hypot(line[i]![0] - line[i - 1]![0], line[i]![1] - line[i - 1]![1]);
  }
  return total;
}

/**
 * Clip one polyline against the junction disks, returning the surviving runs.
 * A line crossing a junction comes back as two runs; one that only clips a
 * corner may come back whole.
 */
export function trimPolyline(line: Pt[], index: JunctionIndex): Pt[][] {
  if (line.length < 2) return [];
  const runs: Pt[][] = [];
  let run: Pt[] = [];

  const flush = (): void => {
    if (run.length >= 2) runs.push(run);
    run = [];
  };
  const push = (p: Pt): void => {
    const last = run[run.length - 1];
    // Consecutive segments share an endpoint, and a cut landing exactly on a
    // vertex produces a duplicate; neither should become a zero-length step.
    if (last && Math.abs(last[0] - p[0]) < 1e-9 && Math.abs(last[1] - p[1]) < 1e-9) return;
    run.push(p);
  };

  for (let i = 0; i + 1 < line.length; i++) {
    const p = line[i]!;
    const q = line[i + 1]!;
    const at = (t: number): Pt => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];

    const covers: [number, number][] = [];
    for (const j of index.near(p, q)) {
      const span = coverage(p, q, j);
      if (span) covers.push(span);
    }
    covers.sort((x, y) => x[0] - y[0]);

    let cursor = 0;
    for (const [t0, t1] of covers) {
      if (t1 <= cursor) continue; // already inside an earlier disk
      if (t0 > cursor) {
        push(at(cursor));
        push(at(t0));
      }
      flush(); // the covered stretch breaks the line
      cursor = t1;
    }
    if (cursor < 1) {
      push(at(cursor));
      push(at(1));
    }
  }
  flush();

  return runs.filter((r) => lengthOf(r) >= MIN_RUN_M);
}

export interface TrimResult<T> {
  lines: T[];
  /** How many source lines were split, shortened, or dropped outright. */
  touched: number;
  dropped: number;
  split: number;
}

/**
 * Clear painted lines out of every junction. Each surviving run becomes its
 * own line, carrying the source line's style; ids are reassigned because a
 * split makes the original numbering meaningless.
 */
export function trimMarkingsAtJunctions<T extends { polyline: [number, number][] }>(
  lines: readonly T[],
  junctions: readonly Junction[],
): TrimResult<T> {
  const index = new JunctionIndex(junctions);
  const out: T[] = [];
  let touched = 0;
  let dropped = 0;
  let split = 0;

  for (const line of lines) {
    const runs = trimPolyline(line.polyline as Pt[], index);
    if (runs.length === 0) {
      dropped++;
      touched++;
      continue;
    }
    const unchanged =
      runs.length === 1 &&
      runs[0]!.length === line.polyline.length &&
      runs[0]!.every((p, i) => {
        const original = line.polyline[i]!;
        return Math.abs(p[0] - original[0]) < 1e-9 && Math.abs(p[1] - original[1]) < 1e-9;
      });
    if (!unchanged) touched++;
    if (runs.length > 1) split++;
    for (const run of runs) {
      out.push({
        ...line,
        id: out.length,
        polyline: run.map(([x, y]): [number, number] => [round1(x), round1(y)]),
      });
    }
  }

  return { lines: out, touched, dropped, split };
}

export { JunctionIndex };
