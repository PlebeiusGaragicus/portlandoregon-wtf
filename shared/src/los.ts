// Pure line-of-sight checks against building footprints. Buildings block
// fire (docs/design.md terrain pillar); streets do not.
import type { GameMap } from "./map.js";

interface BuildingIndexEntry {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
  /** Footprint edges as [x1, y1, x2, y2]. */
  segs: number[];
}

export interface LosIndex {
  buildings: BuildingIndexEntry[];
}

export function buildLosIndex(map: GameMap): LosIndex {
  const buildings: BuildingIndexEntry[] = [];
  for (const b of map.buildings) {
    let xmin = Infinity;
    let ymin = Infinity;
    let xmax = -Infinity;
    let ymax = -Infinity;
    const segs: number[] = [];
    const ring = b.footprint;
    for (let i = 0; i < ring.length; i++) {
      const [x1, y1] = ring[i]!;
      const [x2, y2] = ring[(i + 1) % ring.length]!;
      segs.push(x1, y1, x2, y2);
      xmin = Math.min(xmin, x1);
      ymin = Math.min(ymin, y1);
      xmax = Math.max(xmax, x1);
      ymax = Math.max(ymax, y1);
    }
    buildings.push({ xmin, ymin, xmax, ymax, segs });
  }
  return { buildings };
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
  for (const bld of index.buildings) {
    if (bld.xmax < xmin || bld.xmin > xmax || bld.ymax < ymin || bld.ymin > ymax) continue;
    const s = bld.segs;
    for (let i = 0; i < s.length; i += 4) {
      if (segsIntersect(a.x, a.y, b.x, b.y, s[i]!, s[i + 1]!, s[i + 2]!, s[i + 3]!)) return false;
    }
  }
  return true;
}
