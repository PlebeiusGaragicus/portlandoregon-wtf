// Pure street-graph pathfinding. No I/O — safe for the sim.
//
// Units live anywhere on street polylines, not just at nodes, so a path query
// is: project start/goal onto their nearest edges, A* between edge endpoints,
// then stitch waypoints from the partial start/goal edges plus full edges
// in between.
import type { GameMap, StreetEdge } from "./map.js";

export interface AdjEntry {
  edge: StreetEdge;
  from: number;
  to: number;
  cost: number;
}

export interface PathGraph {
  map: GameMap;
  adj: Map<number, AdjEntry[]>;
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
  for (const edge of map.edges) {
    const cost = polylineLength(edge.polyline);
    push(edge.a, { edge, from: edge.a, to: edge.b, cost });
    push(edge.b, { edge, from: edge.b, to: edge.a, cost });
  }
  return { map, adj };
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

export function nearestOnStreets(graph: PathGraph, p: { x: number; y: number }): StreetPoint | null {
  let best: StreetPoint | null = null;
  let bestDist = Infinity;
  for (const edge of graph.map.edges) {
    const line = edge.polyline;
    let along = 0;
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i]!;
      const b = line[i + 1]!;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const lenSq = dx * dx + dy * dy;
      let t = lenSq === 0 ? 0 : ((p.x - a[0]) * dx + (p.y - a[1]) * dy) / lenSq;
      t = Math.max(0, Math.min(1, t));
      const x = a[0] + t * dx;
      const y = a[1] + t * dy;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bestDist) {
        bestDist = d;
        const distToA = along + t * Math.sqrt(lenSq);
        best = { edge, seg: i, t, x, y, distToA, distToB: polylineLength(line) - distToA };
      }
      along += Math.sqrt(lenSq);
    }
  }
  return best;
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
  const open = new Map<number, number>(); // node -> f = dist + h
  const settled = new Set<number>();

  dist.set(s.edge.a, s.distToA);
  dist.set(s.edge.b, s.distToB);
  open.set(s.edge.a, s.distToA + h(s.edge.a));
  open.set(s.edge.b, s.distToB + h(s.edge.b));

  while (open.size > 0) {
    let cur = -1;
    let curF = Infinity;
    for (const [n, f] of open) {
      if (f < curF) {
        cur = n;
        curF = f;
      }
    }
    open.delete(cur);
    settled.add(cur);
    if (settled.has(g.edge.a) && settled.has(g.edge.b)) break;

    const d = dist.get(cur)!;
    for (const entry of graph.adj.get(cur) ?? []) {
      if (settled.has(entry.to)) continue;
      const nd = d + entry.cost;
      if (nd < (dist.get(entry.to) ?? Infinity)) {
        dist.set(entry.to, nd);
        prev.set(entry.to, entry);
        open.set(entry.to, nd + h(entry.to));
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
