// Plain-array geometry helpers for the transform stage.

export type Pt = [number, number];

/** Douglas-Peucker polyline simplification, epsilon in the same units. */
export function simplify(points: Pt[], epsilon: number): Pt[] {
  if (points.length <= 2) return points.slice();
  const first = points[0]!;
  const last = points[points.length - 1]!;
  let maxDist = 0;
  let maxIdx = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = pointSegDist(points[i]!, first, last);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }
  if (maxDist <= epsilon) return [first, last];
  const left = simplify(points.slice(0, maxIdx + 1), epsilon);
  const right = simplify(points.slice(maxIdx), epsilon);
  return [...left.slice(0, -1), ...right];
}

function pointSegDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Signed ring area: > 0 means counter-clockwise. */
export function ringArea(ring: Pt[]): number {
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i]!;
    const [x2, y2] = ring[(i + 1) % ring.length]!;
    area += x1 * y2 - x2 * y1;
  }
  return area / 2;
}

export function ensureWinding(ring: Pt[], ccw: boolean): Pt[] {
  return ringArea(ring) > 0 === ccw ? ring.slice() : ring.slice().reverse();
}

export interface Rect {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}

export function inRect(p: Pt, r: Rect): boolean {
  return p[0] >= r.xmin && p[0] <= r.xmax && p[1] >= r.ymin && p[1] <= r.ymax;
}

/**
 * Clip a polyline that starts inside the rect and exits it: returns the inside
 * portion, ending exactly on the rect boundary. Assumes points[0] is inside.
 */
export function clipPolylineAtExit(points: Pt[], r: Rect): Pt[] {
  const out: Pt[] = [points[0]!];
  for (let i = 1; i < points.length; i++) {
    const p = points[i]!;
    if (inRect(p, r)) {
      out.push(p);
      continue;
    }
    const prev = out[out.length - 1]!;
    out.push(intersectRect(prev, p, r));
    break;
  }
  return out;
}

/** First intersection of segment a(inside)->b(outside) with the rect border. */
function intersectRect(a: Pt, b: Pt, r: Rect): Pt {
  let tMin = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const candidates: number[] = [];
  if (dx !== 0) candidates.push((r.xmin - a[0]) / dx, (r.xmax - a[0]) / dx);
  if (dy !== 0) candidates.push((r.ymin - a[1]) / dy, (r.ymax - a[1]) / dy);
  for (const t of candidates) {
    if (t > 0 && t < tMin) {
      const p: Pt = [a[0] + dx * t, a[1] + dy * t];
      const eps = 1e-9;
      if (
        p[0] >= r.xmin - eps &&
        p[0] <= r.xmax + eps &&
        p[1] >= r.ymin - eps &&
        p[1] <= r.ymax + eps
      ) {
        tMin = t;
      }
    }
  }
  return [a[0] + dx * tMin, a[1] + dy * tMin];
}

export function bboxOf(coords: Pt[]): Rect {
  let xmin = Infinity;
  let ymin = Infinity;
  let xmax = -Infinity;
  let ymax = -Infinity;
  for (const [x, y] of coords) {
    xmin = Math.min(xmin, x);
    ymin = Math.min(ymin, y);
    xmax = Math.max(xmax, x);
    ymax = Math.max(ymax, y);
  }
  return { xmin, ymin, xmax, ymax };
}

export function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
