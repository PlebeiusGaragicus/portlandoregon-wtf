// Pure line-of-sight checks against building footprints. Buildings block
// fire (docs/design.md terrain pillar); streets do not. Built to city scale:
// buildings are bucketed into a uniform grid so a range-limited LOS query
// touches only nearby footprints.
import type { MapMeta } from "./map.js";
import { forEachRingVertex, ringLength, type BuildingStore } from "./mapbin.js";

interface BuildingIndexEntry {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
  /** Footprint edges as [x1, y1, x2, y2]. */
  segs: number[];
}

const GRID_CELL = 200; // meters — larger than FIRE_RANGE keeps queries to <=4 cells

export interface LosIndex {
  buildings: BuildingIndexEntry[];
  grid: Map<number, number[]>; // cell -> building indices
  cols: number;
  rows: number;
}

export function buildLosIndex(store: BuildingStore, meta: MapMeta): LosIndex {
  const buildings: BuildingIndexEntry[] = [];
  const cols = Math.max(1, Math.ceil(meta.width / GRID_CELL));
  const rows = Math.max(1, Math.ceil(meta.height / GRID_CELL));
  const grid = new Map<number, number[]>();
  const clampCol = (c: number): number => Math.max(0, Math.min(cols - 1, c));
  const clampRow = (r: number): number => Math.max(0, Math.min(rows - 1, r));

  for (let bi = 0; bi < store.count; bi++) {
    let xmin = Infinity;
    let ymin = Infinity;
    let xmax = -Infinity;
    let ymax = -Infinity;
    const segs: number[] = [];
    const n = ringLength(store, bi, 0);
    const rx = new Float64Array(n);
    const ry = new Float64Array(n);
    forEachRingVertex(store, bi, 0, (x, y, i) => {
      rx[i] = x;
      ry[i] = y;
    });
    for (let i = 0; i < n; i++) {
      const x1 = rx[i]!;
      const y1 = ry[i]!;
      const x2 = rx[(i + 1) % n]!;
      const y2 = ry[(i + 1) % n]!;
      segs.push(x1, y1, x2, y2);
      xmin = Math.min(xmin, x1);
      ymin = Math.min(ymin, y1);
      xmax = Math.max(xmax, x1);
      ymax = Math.max(ymax, y1);
    }
    const idx = buildings.length;
    buildings.push({ xmin, ymin, xmax, ymax, segs });

    const c0 = clampCol(Math.floor(xmin / GRID_CELL));
    const c1 = clampCol(Math.floor(xmax / GRID_CELL));
    const r0 = clampRow(Math.floor(ymin / GRID_CELL));
    const r1 = clampRow(Math.floor(ymax / GRID_CELL));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const key = r * cols + c;
        const list = grid.get(key);
        if (list) list.push(idx);
        else grid.set(key, [idx]);
      }
    }
  }
  return { buildings, grid, cols, rows };
}

function segsIntersect(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): boolean {
  const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  if (d1 > 0 === d2 > 0) return false;
  const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  return d3 > 0 !== d4 > 0;
}

/** True when the straight segment a->b crosses no building footprint edge. */
export function hasLineOfSight(
  index: LosIndex,
  a: { x: number; y: number },
  b: { x: number; y: number },
): boolean {
  const xmin = Math.min(a.x, b.x);
  const ymin = Math.min(a.y, b.y);
  const xmax = Math.max(a.x, b.x);
  const ymax = Math.max(a.y, b.y);

  const c0 = Math.max(0, Math.floor(xmin / GRID_CELL));
  const c1 = Math.min(index.cols - 1, Math.floor(xmax / GRID_CELL));
  const r0 = Math.max(0, Math.floor(ymin / GRID_CELL));
  const r1 = Math.min(index.rows - 1, Math.floor(ymax / GRID_CELL));

  const seen = new Set<number>();
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const cell = index.grid.get(r * index.cols + c);
      if (!cell) continue;
      for (const idx of cell) {
        if (seen.has(idx)) continue;
        seen.add(idx);
        const bld = index.buildings[idx]!;
        if (bld.xmax < xmin || bld.xmin > xmax || bld.ymax < ymin || bld.ymin > ymax) continue;
        const s = bld.segs;
        for (let i = 0; i < s.length; i += 4) {
          if (segsIntersect(a.x, a.y, b.x, b.y, s[i]!, s[i + 1]!, s[i + 2]!, s[i + 3]!)) return false;
        }
      }
    }
  }
  return true;
}
