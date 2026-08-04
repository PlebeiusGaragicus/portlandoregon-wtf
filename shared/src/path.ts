// Pure street-graph pathfinding. No I/O — safe for the sim.
//
// Units live anywhere on street polylines, not just at nodes, so a path query
// is: project start/goal onto their nearest edges, A* between edge endpoints,
// then stitch waypoints from the partial start/goal edges plus full edges
// in between. Built to city scale: segment lookups go through a uniform grid
// and the A* open set is a binary heap.
import type { GameMap, StreetEdge } from "./map.js";

export interface AdjEntry {
  edge: StreetEdge;
  from: number;
  to: number;
  cost: number;
}

interface SegRef {
  edge: StreetEdge;
  seg: number;
}

const GRID_CELL = 150; // meters

export interface PathGraph {
  map: GameMap;
  adj: Map<number, AdjEntry[]>;
  /** Uniform grid over street segments for nearest-point queries. */
  grid: Map<number, SegRef[]>;
  cols: number;
  rows: number;
}

function segLen(a: [number, number], b: [number, number]): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

export function polylineLength(line: [number, number][]): number {
  let len = 0;
  for (let i = 0; i < line.length - 1; i++) len += segLen(line[i]!, line[i + 1]!);
  return len;
}

export function buildPathGraph(map: GameMap): PathGraph {
  const adj = new Map<number, AdjEntry[]>();
  const push = (n: number, e: AdjEntry): void => {
    const list = adj.get(n);
    if (list) list.push(e);
    else adj.set(n, [e]);
  };

  const cols = Math.max(1, Math.ceil(map.meta.width / GRID_CELL));
  const rows = Math.max(1, Math.ceil(map.meta.height / GRID_CELL));
  const grid = new Map<number, SegRef[]>();
  const clampCol = (c: number): number => Math.max(0, Math.min(cols - 1, c));
  const clampRow = (r: number): number => Math.max(0, Math.min(rows - 1, r));

  for (const edge of map.edges) {
    const cost = polylineLength(edge.polyline);
    push(edge.a, { edge, from: edge.a, to: edge.b, cost });
    push(edge.b, { edge, from: edge.b, to: edge.a, cost });

    for (let i = 0; i < edge.polyline.length - 1; i++) {
      const [ax, ay] = edge.polyline[i]!;
      const [bx, by] = edge.polyline[i + 1]!;
      const c0 = clampCol(Math.floor(Math.min(ax, bx) / GRID_CELL));
      const c1 = clampCol(Math.floor(Math.max(ax, bx) / GRID_CELL));
      const r0 = clampRow(Math.floor(Math.min(ay, by) / GRID_CELL));
      const r1 = clampRow(Math.floor(Math.max(ay, by) / GRID_CELL));
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const key = r * cols + c;
          const list = grid.get(key);
          const ref = { edge, seg: i };
          if (list) list.push(ref);
          else grid.set(key, [ref]);
        }
      }
    }
  }
  return { map, adj, grid, cols, rows };
}

/** A position projected onto a street polyline. */
export interface StreetPoint {
  edge: StreetEdge;
  seg: number; // polyline segment index
  t: number; // 0..1 within that segment
  x: number;
  y: number;
  distToA: number; // along the polyline to edge.a (polyline start)
  distToB: number;
}

function projectOnSeg(
  p: { x: number; y: number },
  a: [number, number],
  b: [number, number],
): { t: number; x: number; y: number; d: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((p.x - a[0]) * dx + (p.y - a[1]) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const x = a[0] + t * dx;
  const y = a[1] + t * dy;
  return { t, x, y, d: Math.hypot(p.x - x, p.y - y) };
}

function toStreetPoint(ref: SegRef, proj: { t: number; x: number; y: number }): StreetPoint {
  const line = ref.edge.polyline;
  let along = 0;
  for (let i = 0; i < ref.seg; i++) along += segLen(line[i]!, line[i + 1]!);
  const distToA = along + proj.t * segLen(line[ref.seg]!, line[ref.seg + 1]!);
  return {
    edge: ref.edge,
    seg: ref.seg,
    t: proj.t,
    x: proj.x,
    y: proj.y,
    distToA,
    distToB: polylineLength(line) - distToA,
  };
}

/** Nearest street point via expanding grid rings (exact per-candidate math). */
export function nearestOnStreets(graph: PathGraph, p: { x: number; y: number }): StreetPoint | null {
  const pc = Math.max(0, Math.min(graph.cols - 1, Math.floor(p.x / GRID_CELL)));
  const pr = Math.max(0, Math.min(graph.rows - 1, Math.floor(p.y / GRID_CELL)));
  const maxRing = Math.max(graph.cols, graph.rows);

  let best: { ref: SegRef; proj: { t: number; x: number; y: number; d: number } } | null = null;
  for (let ring = 0; ring <= maxRing; ring++) {
    // Conservative stop: every cell in this ring is at least (ring-1)*CELL away.
    if (best && best.proj.d < (ring - 1) * GRID_CELL) break;
    for (let r = pr - ring; r <= pr + ring; r++) {
      if (r < 0 || r >= graph.rows) continue;
      for (let c = pc - ring; c <= pc + ring; c++) {
        if (c < 0 || c >= graph.cols) continue;
        if (Math.max(Math.abs(r - pr), Math.abs(c - pc)) !== ring) continue; // ring shell only
        const refs = graph.grid.get(r * graph.cols + c);
        if (!refs) continue;
        for (const ref of refs) {
          const line = ref.edge.polyline;
          const proj = projectOnSeg(p, line[ref.seg]!, line[ref.seg + 1]!);
          if (!best || proj.d < best.proj.d) best = { ref, proj };
        }
      }
    }
  }
  return best ? toStreetPoint(best.ref, best.proj) : null;
}

/** Binary min-heap keyed on f; lazy deletion (stale entries skipped). */
class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: number, val: number): void {
    const k = this.keys;
    const v = this.vals;
    k.push(key);
    v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (k[parent]! <= k[i]!) break;
      [k[parent], k[i]] = [k[i]!, k[parent]!];
      [v[parent], v[i]] = [v[i]!, v[parent]!];
      i = parent;
    }
  }

  pop(): number {
    const k = this.keys;
    const v = this.vals;
    const top = v[0]!;
    const lastK = k.pop()!;
    const lastV = v.pop()!;
    if (k.length > 0) {
      k[0] = lastK;
      v[0] = lastV;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        if (l < k.length && k[l]! < k[smallest]!) smallest = l;
        if (r < k.length && k[r]! < k[smallest]!) smallest = r;
        if (smallest === i) break;
        [k[smallest], k[i]] = [k[i]!, k[smallest]!];
        [v[smallest], v[i]] = [v[i]!, v[smallest]!];
        i = smallest;
      }
    }
    return top;
  }
}

/** Waypoints from a street point to one endpoint node of its edge. */
function towardNode(sp: StreetPoint, node: number): [number, number][] {
  const line = sp.edge.polyline;
  const start: [number, number] = [sp.x, sp.y];
  if (node === sp.edge.b) return [start, ...line.slice(sp.seg + 1)];
  return [start, ...line.slice(0, sp.seg + 1).reverse()];
}

/** Full edge polyline oriented to start at `fromNode`. */
function oriented(edge: StreetEdge, fromNode: number): [number, number][] {
  return fromNode === edge.a ? edge.polyline.slice() : edge.polyline.slice().reverse();
}

/** Waypoints between two points on the SAME edge. */
function alongSameEdge(s: StreetPoint, g: StreetPoint): [number, number][] {
  const line = s.edge.polyline;
  const start: [number, number] = [s.x, s.y];
  const goal: [number, number] = [g.x, g.y];
  if (s.seg === g.seg) return [start, goal];
  if (s.distToA < g.distToA) return [start, ...line.slice(s.seg + 1, g.seg + 1), goal];
  return [start, ...line.slice(g.seg + 1, s.seg + 1).reverse(), goal];
}

function dedupe(points: [number, number][]): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const [x, y] of points) {
    const last = out[out.length - 1];
    if (last && Math.hypot(last.x - x, last.y - y) < 1e-6) continue;
    out.push({ x, y });
  }
  return out;
}

/**
 * Street-constrained path from `from` to `to`, as waypoints (ending on the
 * street network's nearest point to `to`). Null when off-network or
 * unreachable.
 */
export function findPath(
  graph: PathGraph,
  from: { x: number; y: number },
  to: { x: number; y: number },
): { x: number; y: number }[] | null {
  const s = nearestOnStreets(graph, from);
  const g = nearestOnStreets(graph, to);
  if (!s || !g) return null;
  if (s.edge.id === g.edge.id) return dedupe(alongSameEdge(s, g));

  const nodes = graph.map.nodes;
  const h = (n: number): number => {
    const node = nodes[n];
    return node ? Math.hypot(node.x - g.x, node.y - g.y) : 0;
  };

  const dist = new Map<number, number>();
  const prev = new Map<number, AdjEntry>(); // how we arrived at a node
  const settled = new Set<number>();
  const heap = new MinHeap();

  dist.set(s.edge.a, s.distToA);
  dist.set(s.edge.b, s.distToB);
  heap.push(s.distToA + h(s.edge.a), s.edge.a);
  heap.push(s.distToB + h(s.edge.b), s.edge.b);

  while (heap.size > 0) {
    const cur = heap.pop();
    if (settled.has(cur)) continue; // stale heap entry
    settled.add(cur);
    if (settled.has(g.edge.a) && settled.has(g.edge.b)) break;

    const d = dist.get(cur)!;
    for (const entry of graph.adj.get(cur) ?? []) {
      if (settled.has(entry.to)) continue;
      const nd = d + entry.cost;
      if (nd < (dist.get(entry.to) ?? Infinity)) {
        dist.set(entry.to, nd);
        prev.set(entry.to, entry);
        heap.push(nd + h(entry.to), entry.to);
      }
    }
  }

  const viaA = (dist.get(g.edge.a) ?? Infinity) + g.distToA;
  const viaB = (dist.get(g.edge.b) ?? Infinity) + g.distToB;
  if (!Number.isFinite(viaA) && !Number.isFinite(viaB)) return null;
  const endNode = viaA <= viaB ? g.edge.a : g.edge.b;

  // Reconstruct the node chain back to whichever start endpoint won.
  const chain: number[] = [endNode];
  const usedEdges: AdjEntry[] = [];
  let n = endNode;
  while (prev.has(n)) {
    const entry = prev.get(n)!;
    usedEdges.unshift(entry);
    n = entry.from;
    chain.unshift(n);
  }

  const startNode = chain[0]!;
  const points: [number, number][] = [];
  points.push(...towardNode(s, startNode));
  for (const entry of usedEdges) points.push(...oriented(entry.edge, entry.from));
  // Final leg: from endNode along the goal edge to the goal projection.
  points.push(...towardNode(g, endNode).reverse());
  return dedupe(points);
}
