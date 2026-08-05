// Stage 5 — TRANSFORM. Reproject to local meters, build the street graph from
// PDX node IDs (trust them — never re-snap), check connectivity, clip to the
// play area, mark entry nodes, simplify geometry, shape props.
// Reads data/raw/{date}/, writes data/processed/{date}/pearl-core.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Building,
  GameMap,
  MarkingArea,
  MarkingLine,
  Prop,
  RailLine,
  RailStop,
  RoadClass,
  StreetEdge,
  StreetNode,
  Trail,
  WaterBody,
} from "@battle-juice/shared";
import { extractDate, HEIGHT_PER_STORY_M, MANIFEST_FILE, MAP_NAME, processedDir, rawDir, SIGN_KEEP } from "./config.js";
import type { GeoJsonCollection, GeoJsonFeature } from "./lib/arcgis.js";
import { clipPolylineAtExit, clipRingToRect, ensureWinding, inRect, round1, simplify, type Pt, type Rect } from "./lib/geo.js";
import { origin, playArea, toLocal } from "./lib/proj.js";

const STREET_EPSILON = 1; // m, Douglas-Peucker
const FOOTPRINT_EPSILON = 0.5;
const DOMINANT_COMPONENT_MIN = 0.8;
const ROAD_WIDTH: Record<RoadClass, number> = { arterial: 14, collector: 10, local: 8, alley: 4, path: 2 };

function readRaw(key: string): GeoJsonCollection | null {
  const file = join(rawDir(), `${key}.geojson`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as GeoJsonCollection;
}

function localLine(geometry: { type: string; coordinates: unknown }): Pt[] {
  // Streets are LineStrings; tolerate MultiLineString by concatenating parts.
  const coords =
    geometry.type === "LineString"
      ? (geometry.coordinates as [number, number][])
      : (geometry.coordinates as [number, number][][]).flat();
  return coords.map(([lon, lat]) => toLocal(lon, lat));
}

function roadClass(cfcc: unknown, type: unknown): RoadClass {
  const code = String(cfcc ?? "");
  if (/^A[12]/.test(code)) return "arterial";
  if (/^A3/.test(code)) return "collector";
  if (/^A4/.test(code)) return "local";
  if (/^A6/.test(code)) return "alley";
  if (/^A7/.test(code)) return "path";
  // Fallback on Portland's numeric TYPE when CFCC is missing.
  const t = Number(type ?? NaN);
  if (t >= 1100 && t < 1300) return "arterial";
  if (t >= 1300 && t < 1500) return "collector";
  return "local";
}

interface RawEdge {
  f: number;
  t: number;
  line: Pt[];
  name: string;
  cls: RoadClass;
  /** From STRUC_TYPE: 21 viaduct / 23 bridge -> "bridge"; 32 -> "tunnel". */
  struct?: "bridge" | "tunnel";
}

interface RawGraph {
  edges: RawEdge[];
  nodePos: Map<number, Pt>;
  nodeZ: Map<number, Set<number>>;
}

function buildGraph(streets: GeoJsonCollection): RawGraph {
  const edges: RawEdge[] = [];
  const nodePos = new Map<number, Pt>();
  const nodeZ = new Map<number, Set<number>>();
  const addZ = (id: number, z: unknown): void => {
    let s = nodeZ.get(id);
    if (!s) nodeZ.set(id, (s = new Set()));
    const n = Number(z ?? NaN);
    s.add(Number.isFinite(n) ? n : 1); // missing ZLEV = ground
  };
  let skipped = 0;
  for (const feat of streets.features) {
    const p = feat.properties;
    const f = Number(p["PDX_F_NODE"] ?? NaN);
    const t = Number(p["PDX_T_NODE"] ?? NaN);
    if (!feat.geometry || !Number.isFinite(f) || !Number.isFinite(t)) {
      skipped++;
      continue;
    }
    const line = localLine(feat.geometry);
    if (line.length < 2) {
      skipped++;
      continue;
    }
    nodePos.set(f, line[0]!);
    nodePos.set(t, line[line.length - 1]!);
    addZ(f, p["F_ZLEV"]);
    addZ(t, p["T_ZLEV"]);
    const st = Number(p["STRUC_TYPE"] ?? 10);
    edges.push({
      f,
      t,
      line,
      name: String(p["FULL_NAME"] ?? ""),
      cls: roadClass(p["CFCC"], p["TYPE"]),
      ...(st === 21 || st === 23 ? { struct: "bridge" as const } : st === 32 ? { struct: "tunnel" as const } : {}),
    });
  }
  if (skipped) console.log(`  streets: skipped ${skipped} segments without node ids/geometry`);
  return { edges, nodePos, nodeZ };
}

const WELD_DIST = 2; // m — coincident-junction tolerance across id namespaces

/**
 * The street layer carries several disjoint node-id namespaces (Portland
 * proper vs. neighboring jurisdictions), so physically continuous streets
 * never share an id at the city limits and the graph splits into two huge
 * "components". Weld nodes that sit at the same ground position but belong
 * to different components — matching ZLEV only, so grade-separated
 * crossings (overpasses) are never fused.
 */
function weldJurisdictions(g: RawGraph): void {
  const parent = new Map<number, number>();
  const find = (a: number): number => {
    let root = a;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (parent.get(a) !== root) {
      const next = parent.get(a)!;
      parent.set(a, root);
      a = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    parent.set(find(a), find(b));
  };
  for (const e of g.edges) union(e.f, e.t);

  // Alias union-find: welded ids collapse to one canonical id.
  const alias = new Map<number, number>();
  const afind = (a: number): number => {
    while (alias.has(a) && alias.get(a) !== a) a = alias.get(a)!;
    return a;
  };

  const cellKey = (cx: number, cy: number): string => `${cx}:${cy}`;
  const grid = new Map<string, number[]>();
  for (const [id, p] of g.nodePos) {
    const key = cellKey(Math.floor(p[0] / WELD_DIST), Math.floor(p[1] / WELD_DIST));
    const bucket = grid.get(key);
    if (bucket) bucket.push(id);
    else grid.set(key, [id]);
  }

  let welds = 0;
  for (const [id, p] of g.nodePos) {
    const kc = Math.floor(p[0] / WELD_DIST);
    const kr = Math.floor(p[1] / WELD_DIST);
    for (let r = kr - 1; r <= kr + 1; r++) {
      for (let c = kc - 1; c <= kc + 1; c++) {
        for (const other of grid.get(cellKey(c, r)) ?? []) {
          if (other <= id) continue; // each pair once
          // Pre-weld components: weld every junction between two originally
          // separate networks, never within one network (same-position nodes
          // there are intentional, e.g. divided carriageways).
          if (find(other) === find(id)) continue;
          const q = g.nodePos.get(other)!;
          if (Math.hypot(p[0] - q[0], p[1] - q[1]) > WELD_DIST) continue;
          const za = g.nodeZ.get(id);
          const zb = g.nodeZ.get(other);
          if (za && zb && ![...za].some((z) => zb.has(z))) continue; // grade-separated
          const a = afind(id);
          const b = afind(other);
          if (a !== b) alias.set(b, a);
          welds++;
        }
      }
    }
  }
  for (const e of g.edges) {
    e.f = afind(e.f);
    e.t = afind(e.t);
  }
  if (welds) console.log(`  streets: welded ${welds} cross-jurisdiction junctions`);
}

/** Union-find dominant connected component check (fatal if fragmented). */
function dominantComponent(edges: RawEdge[]): Set<number> {
  const parent = new Map<number, number>();
  const find = (a: number): number => {
    let root = a;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (parent.get(a) !== root) {
      const next = parent.get(a)!;
      parent.set(a, root);
      a = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    parent.set(find(a), find(b));
  };
  for (const e of edges) union(e.f, e.t);

  const sizes = new Map<number, number>();
  for (const key of parent.keys()) {
    const root = find(key);
    sizes.set(root, (sizes.get(root) ?? 0) + 1);
  }
  let bestRoot = -1;
  let bestSize = 0;
  for (const [root, size] of sizes) {
    if (size > bestSize) {
      bestRoot = root;
      bestSize = size;
    }
  }
  const fraction = bestSize / parent.size;
  console.log(`  graph: ${parent.size} nodes, ${sizes.size} components, dominant ${(fraction * 100).toFixed(1)}%`);
  if (fraction < 0.5) {
    console.error("FATAL: street graph is fragmented — was the extract clipped too tight?");
    process.exit(1);
  }
  if (fraction < DOMINANT_COMPONENT_MIN) {
    // Citywide: the rectangular envelope includes severed slivers of
    // neighboring jurisdictions (Washington County, Happy Valley). The
    // dominant component is Portland's own network; the rest is dropped.
    console.warn(
      `  WARN: keeping dominant component only — dropping ${sizes.size - 1} fragments (${(100 - fraction * 100).toFixed(1)}% of nodes, mostly neighboring jurisdictions cut by the envelope)`,
    );
  }
  const keep = new Set<number>();
  for (const key of parent.keys()) if (find(key) === bestRoot) keep.add(key);
  return keep;
}

function transformStreets(streets: GeoJsonCollection, rect: Rect) {
  const graph = buildGraph(streets);
  weldJurisdictions(graph);
  const rawEdges = graph.edges;
  const keepNodes = dominantComponent(rawEdges);
  const connected = rawEdges.filter((e) => keepNodes.has(e.f) && keepNodes.has(e.t));

  // Clip to the play area. Boundary crossings synthesize new boundary nodes.
  const nodes: StreetNode[] = [];
  const idMap = new Map<number, number>(); // PDX node id -> compact id
  const nodeAt = (pdxId: number, p: Pt): number => {
    const existing = idMap.get(pdxId);
    if (existing !== undefined) return existing;
    const id = nodes.length;
    idMap.set(pdxId, id);
    nodes.push({ id, x: round1(p[0]), y: round1(p[1]) });
    return id;
  };
  let syntheticId = -1;
  const boundaryNode = (p: Pt): number => {
    const id = nodes.length;
    idMap.set(syntheticId--, id);
    nodes.push({ id, x: round1(p[0]), y: round1(p[1]) });
    return id;
  };

  const edges: StreetEdge[] = [];
  const boundaryNodes: number[] = [];
  for (const e of connected) {
    const startIn = inRect(e.line[0]!, rect);
    const endIn = inRect(e.line[e.line.length - 1]!, rect);
    if (!startIn && !endIn) continue;

    let line = e.line;
    let a: number;
    let b: number;
    if (startIn && endIn) {
      a = nodeAt(e.f, line[0]!);
      b = nodeAt(e.t, line[line.length - 1]!);
    } else {
      // One end outside: keep the inside portion, end on the boundary.
      const oriented = startIn ? line : line.slice().reverse();
      const clipped = clipPolylineAtExit(oriented, rect);
      if (clipped.length < 2) continue;
      a = nodeAt(startIn ? e.f : e.t, clipped[0]!);
      b = boundaryNode(clipped[clipped.length - 1]!);
      boundaryNodes.push(b);
      line = clipped;
    }

    const simplified = simplify(line, STREET_EPSILON).map(([x, y]): [number, number] => [round1(x), round1(y)]);
    edges.push({
      id: edges.length,
      a,
      b,
      polyline: simplified,
      width: ROAD_WIDTH[e.cls],
      name: e.name,
      class: e.cls,
      ...(e.struct ? { struct: e.struct } : {}),
    });
  }

  // Entry candidates: boundary nodes on the north/south map edges.
  const margin = 2; // m
  let north: number[] = [];
  let south: number[] = [];
  for (const id of boundaryNodes) {
    const n = nodes[id]!;
    if (n.y >= rect.ymax - margin) north.push(id);
    else if (n.y <= rect.ymin + margin) south.push(id);
  }
  // Whole-city case: the network ends at city limits inside the box, so no
  // edges cross the border. Fall back to the network's own extreme nodes,
  // spread across the map width (one per x-decile band).
  const extremeEntries = (side: "north" | "south"): number[] => {
    const bins = new Map<number, number>();
    for (const n of nodes) {
      const bin = Math.min(9, Math.floor((n.x / (rect.xmax - rect.xmin)) * 10));
      const cur = bins.get(bin);
      const better =
        cur === undefined || (side === "north" ? n.y > nodes[cur]!.y : n.y < nodes[cur]!.y);
      if (better) bins.set(bin, n.id);
    }
    return [...bins.values()];
  };
  if (north.length === 0) {
    north = extremeEntries("north");
    console.log(`  entries: no north boundary nodes — using ${north.length} network-extreme nodes`);
  }
  if (south.length === 0) {
    south = extremeEntries("south");
    console.log(`  entries: no south boundary nodes — using ${south.length} network-extreme nodes`);
  }
  console.log(`  clipped: ${nodes.length} nodes, ${edges.length} edges, entries N=${north.length} S=${south.length}`);
  return { nodes, edges, entries: { north, south } };
}

/** Normalize BLDG_TYPE/BLDG_USE strings into a small palette category. */
function useCategory(type: unknown, use: unknown): string {
  const s = `${String(type ?? "")} ${String(use ?? "")}`.toLowerCase();
  if (/single family|house|garage|manufactured|townhouse|mobile home/.test(s)) return "sfr";
  if (/multi family|apartment|duplex|rowhouse|condo|dorm/.test(s)) return "mfr";
  if (/industrial|warehouse/.test(s)) return "ind";
  if (/office/.test(s)) return "off";
  if (/commercial|retail|restaurant|hotel|mercantile|parking/.test(s)) return "com";
  if (/institutional|religious|school|church|hospital|public|government/.test(s)) return "inst";
  return "other";
}

const DEDUP_CELL = 20; // m — RLIS building dropped if a COP centroid is within a cell ring

function dedupKey(x: number, y: number): number {
  return Math.floor(y / DEDUP_CELL) * 100000 + Math.floor(x / DEDUP_CELL);
}

interface BuildingsOut {
  list: Building[];
  heightUnit: string;
  /** Occupied centroid cells (for cross-source dedup). */
  cells: Set<number>;
}

function transformBuildings(
  label: string,
  buildings: GeoJsonCollection,
  rect: Rect,
  opts: { typeField?: string; skipCells?: Set<number> },
): BuildingsOut {
  // Feet-vs-meters heuristic: median MAX_HEIGHT per story. ~3-4 => meters.
  const ratios: number[] = [];
  for (const f of buildings.features) {
    const h = Number(f.properties["MAX_HEIGHT"] ?? NaN);
    const s = Number(f.properties["NUM_STORY"] ?? NaN);
    if (h > 0 && s > 0) ratios.push(h / s);
  }
  ratios.sort((x, y) => x - y);
  const medianRatio = ratios[Math.floor(ratios.length / 2)] ?? 0;
  const feet = medianRatio > 6;
  const toMeters = feet ? 0.3048 : 1;
  const heightUnit = feet ? "feet (converted x0.3048)" : "meters";
  console.log(`  ${label}: MAX_HEIGHT median ${medianRatio.toFixed(1)} per story -> treating as ${heightUnit}`);

  const list: Building[] = [];
  const cells = new Set<number>();
  let deduped = 0;
  for (const f of buildings.features) {
    if (!f.geometry) continue;
    const polys: [number, number][][][] =
      f.geometry.type === "Polygon"
        ? [f.geometry.coordinates as [number, number][][]]
        : (f.geometry.coordinates as [number, number][][][]);

    const rawH = Number(f.properties["MAX_HEIGHT"] ?? NaN);
    const stories = Number(f.properties["NUM_STORY"] ?? NaN);
    const height =
      rawH > 0 ? rawH * toMeters : stories > 0 ? stories * HEIGHT_PER_STORY_M : 2 * HEIGHT_PER_STORY_M;
    const use = useCategory(opts.typeField ? f.properties[opts.typeField] : "", f.properties["BLDG_USE"]);

    for (const rings of polys) {
      const outerRaw = rings[0];
      if (!outerRaw || outerRaw.length < 4) continue;
      const toLoc = (ring: [number, number][]): Pt[] => {
        const pts = ring.map(([lon, lat]) => toLocal(lon, lat));
        // Drop the closing point (schema rings are open).
        const first = pts[0]!;
        const last = pts[pts.length - 1]!;
        if (Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-6) pts.pop();
        return pts;
      };
      const outer = simplify(toLoc(outerRaw), FOOTPRINT_EPSILON);
      if (outer.length < 3) continue;
      if (!outer.some((p) => inRect(p, rect))) continue; // fully outside the play area

      let cx = 0;
      let cy = 0;
      for (const [x, y] of outer) {
        cx += x;
        cy += y;
      }
      cx /= outer.length;
      cy /= outer.length;
      if (opts.skipCells) {
        // Skip when a primary-source building centroid sits nearby.
        let hit = false;
        const kc = Math.floor(cx / DEDUP_CELL);
        const kr = Math.floor(cy / DEDUP_CELL);
        for (let r = kr - 1; r <= kr + 1 && !hit; r++) {
          for (let c = kc - 1; c <= kc + 1 && !hit; c++) {
            if (opts.skipCells.has(r * 100000 + c)) hit = true;
          }
        }
        if (hit) {
          deduped++;
          continue;
        }
      }
      cells.add(dedupKey(cx, cy));

      const holes = rings
        .slice(1)
        .map((r) => simplify(toLoc(r), FOOTPRINT_EPSILON))
        .filter((r) => r.length >= 3)
        .map((r) => ensureWinding(r, false).map(([x, y]): [number, number] => [round1(x), round1(y)]));

      list.push({
        id: list.length,
        footprint: ensureWinding(outer, true).map(([x, y]): [number, number] => [round1(x), round1(y)]),
        ...(holes.length ? { holes } : {}),
        height: round1(height),
        use,
      });
    }
  }
  console.log(`  ${label}: ${list.length} prisms in play area${deduped ? ` (${deduped} deduped vs primary)` : ""}`);
  return { list, heightUnit, cells };
}

function transformPolys(key: "water" | "parks" | "railyards" | "sidewalks", rect: Rect): WaterBody[] {
  const water = readRaw(key);
  if (!water) return [];
  const bodies: WaterBody[] = [];
  for (const f of water.features) {
    if (!f.geometry) continue;
    const polys: [number, number][][][] =
      f.geometry.type === "Polygon"
        ? [f.geometry.coordinates as [number, number][][]]
        : (f.geometry.coordinates as [number, number][][][]);
    for (const rings of polys) {
      const clipped = rings
        .map((ring) => {
          const local = ring.map(([lon, lat]) => toLocal(lon, lat));
          return simplify(clipRingToRect(local, rect), 1).map(
            ([x, y]): [number, number] => [round1(x), round1(y)],
          );
        })
        .filter((ring) => ring.length >= 3);
      if (clipped.length === 0 || clipped[0]!.length < 3) continue;
      const outer = ensureWinding(clipped[0]!, true);
      const holes = clipped.slice(1).map((r) => ensureWinding(r, false));
      bodies.push({ id: bodies.length, rings: [outer, ...holes] });
    }
  }
  console.log(`  ${key}: ${bodies.length} bodies in play area`);
  return bodies;
}

function transformTrails(rect: Rect): Trail[] {
  const raw = readRaw("trails");
  if (!raw) return [];
  const trails: Trail[] = [];
  for (const f of raw.features) {
    if (!f.geometry) continue;
    if (/conceptual|proposed|planned/i.test(String(f.properties["STATUS"] ?? ""))) continue;
    const lines: [number, number][][] =
      f.geometry.type === "LineString"
        ? [f.geometry.coordinates as [number, number][]]
        : (f.geometry.coordinates as [number, number][][]);
    for (const line of lines) {
      // Keep in-rect runs; render-only, so boundary precision is unimportant.
      let run: Pt[] = [];
      const flush = (): void => {
        if (run.length >= 2) {
          const simple = simplify(run, 2).map(([x, y]): [number, number] => [round1(x), round1(y)]);
          if (simple.length >= 2) trails.push({ id: trails.length, polyline: simple });
        }
        run = [];
      };
      for (const [lon, lat] of line) {
        const p = toLocal(lon, lat);
        if (inRect(p, rect)) run.push(p);
        else flush();
      }
      flush();
    }
  }
  console.log(`  trails: ${trails.length} segments in play area`);
  return trails;
}

/** Metro TYPE attribute -> game rail kind ("rail" is heavy/freight). */
function railKind(type: unknown): RailLine["kind"] {
  const t = String(type ?? "").toLowerCase();
  if (t.includes("max")) return "max";
  if (t.includes("street")) return "streetcar";
  if (t.includes("wes")) return "wes";
  return "rail";
}

/** Rail centerlines: freight (rails.geojson) + MAX/streetcar/WES
 * (maxlines.geojson), clipped to in-rect runs like trails. */
function transformRails(rect: Rect): RailLine[] {
  const out: RailLine[] = [];
  const ingest = (key: "rails" | "maxlines", kindOf: (f: GeoJsonFeature) => RailLine["kind"]): void => {
    const raw = readRaw(key);
    if (!raw) return;
    let count = 0;
    for (const f of raw.features) {
      if (!f.geometry) continue;
      const lines: [number, number][][] =
        f.geometry.type === "LineString"
          ? [f.geometry.coordinates as [number, number][]]
          : (f.geometry.coordinates as [number, number][][]);
      const kind = kindOf(f);
      for (const line of lines) {
        let run: Pt[] = [];
        const flush = (): void => {
          if (run.length >= 2) {
            const simple = simplify(run, 2).map(([x, y]): [number, number] => [round1(x), round1(y)]);
            if (simple.length >= 2) {
              out.push({ id: out.length, polyline: simple, kind });
              count++;
            }
          }
          run = [];
        };
        for (const [lon, lat] of line) {
          const p = toLocal(lon, lat);
          if (inRect(p, rect)) run.push(p);
          else flush();
        }
        flush();
      }
    }
    console.log(`  ${key}: ${count} segments in play area`);
  };
  ingest("rails", () => "rail");
  ingest("maxlines", (f) => railKind(f.properties["TYPE"]));
  return out;
}

function transformRailStops(rect: Rect): RailStop[] {
  const raw = readRaw("maxstops");
  if (!raw) return [];
  const stops: RailStop[] = [];
  for (const f of raw.features) {
    if (!f.geometry || f.geometry.type !== "Point") continue;
    const [lon, lat] = f.geometry.coordinates as [number, number];
    const p = toLocal(lon, lat);
    if (!inRect(p, rect)) continue;
    const kind = railKind(f.properties["TYPE"]);
    stops.push({
      id: stops.length,
      x: round1(p[0]),
      y: round1(p[1]),
      kind: kind === "rail" ? "max" : kind,
      name: String(f.properties["STATION"] ?? ""),
    });
  }
  console.log(`  maxstops: ${stops.length} in play area`);
  return stops;
}

/** Painted pavement shapes/lines, fine simplification (they're small). */
function transformMarkings(rect: Rect): { areas: MarkingArea[]; lines: MarkingLine[] } {
  const areas: MarkingArea[] = [];
  const lines: MarkingLine[] = [];
  const areaRaw = readRaw("markareas");
  if (areaRaw) {
    for (const f of areaRaw.features) {
      if (!f.geometry) continue;
      const style = String(f.properties["AreaStyle"] ?? "WF") === "YF" ? "yellow" : "white";
      const polys: [number, number][][][] =
        f.geometry.type === "Polygon"
          ? [f.geometry.coordinates as [number, number][][]]
          : (f.geometry.coordinates as [number, number][][][]);
      for (const rings of polys) {
        const clipped = rings
          .map((ring) => {
            const local = ring.map(([lon, lat]) => toLocal(lon, lat));
            return simplify(clipRingToRect(local, rect), 0.3).map(
              ([x, y]): [number, number] => [round1(x), round1(y)],
            );
          })
          .filter((ring) => ring.length >= 3);
        if (clipped.length === 0 || clipped[0]!.length < 3) continue;
        const outer = ensureWinding(clipped[0]!, true);
        const holes = clipped.slice(1).map((r) => ensureWinding(r, false));
        areas.push({ id: areas.length, rings: [outer, ...holes], style });
      }
    }
  }
  const lineRaw = readRaw("marklines");
  if (lineRaw) {
    for (const f of lineRaw.features) {
      if (!f.geometry) continue;
      // LineStyle domain is exclusively yellow variants (centerlines).
      const style = "yellow" as const;
      const polys: [number, number][][] =
        f.geometry.type === "LineString"
          ? [f.geometry.coordinates as [number, number][]]
          : (f.geometry.coordinates as [number, number][][]);
      for (const line of polys) {
        let run: Pt[] = [];
        const flush = (): void => {
          if (run.length >= 2) {
            const simple = simplify(run, 0.5).map(([x, y]): [number, number] => [round1(x), round1(y)]);
            if (simple.length >= 2) lines.push({ id: lines.length, polyline: simple, style });
          }
          run = [];
        };
        for (const [lon, lat] of line) {
          const p = toLocal(lon, lat);
          if (inRect(p, rect)) run.push(p);
          else flush();
        }
        flush();
      }
    }
  }
  console.log(`  markings: ${areas.length} areas, ${lines.length} lines in play area`);
  return { areas, lines };
}

// Candidate size fields for street trees (exact schema discovered at runtime).
const TREE_SIZE_FIELDS = ["DBH", "DIAMETER", "TREE_DBH", "TRUNKDIAM", "DIAMETER_BREAST_HEIGHT"];

function transformProps(rect: Rect): Prop[] {
  const props: Prop[] = [];

  const pointOf = (f: GeoJsonFeature): Pt | null => {
    if (!f.geometry || f.geometry.type !== "Point") return null;
    const [lon, lat] = f.geometry.coordinates as [number, number];
    const p = toLocal(lon, lat);
    return inRect(p, rect) ? p : null;
  };

  const trees = readRaw("trees");
  if (trees) {
    const sizeField = TREE_SIZE_FIELDS.find((c) =>
      trees.features.some((f) => Number(f.properties[c] ?? NaN) > 0),
    );
    const dbhs = sizeField
      ? trees.features.map((f) => Number(f.properties[sizeField] ?? NaN)).filter((v) => v > 0).sort((a, b) => a - b)
      : [];
    const t1 = dbhs[Math.floor(dbhs.length / 3)] ?? 0;
    const t2 = dbhs[Math.floor((2 * dbhs.length) / 3)] ?? 0;
    let count = 0;
    for (const f of trees.features) {
      const p = pointOf(f);
      if (!p) continue;
      const dbh = sizeField ? Number(f.properties[sizeField] ?? NaN) : NaN;
      const size: 1 | 2 | 3 = !Number.isFinite(dbh) || dbh <= 0 ? 2 : dbh <= t1 ? 1 : dbh <= t2 ? 2 : 3;
      props.push({ kind: "tree", x: round1(p[0]), y: round1(p[1]), size });
      count++;
    }
    console.log(`  trees: ${count} in play area (size field: ${sizeField ?? "none, defaulting size 2"})`);
  }

  const signs = readRaw("signs");
  if (signs) {
    let count = 0;
    for (const f of signs.features) {
      const p = pointOf(f);
      if (!p) continue;
      const kind = SIGN_KEEP[String(f.properties["SignCode"] ?? "")] ?? "other";
      // Rotation is compass degrees (CW from north, direction the face points);
      // convert to the renderer's yaw-about-up convention.
      const deg = Number(f.properties["Rotation"] ?? NaN);
      const rot = Number.isFinite(deg) ? Math.PI - (deg * Math.PI) / 180 : 0;
      props.push({ kind: "sign", x: round1(p[0]), y: round1(p[1]), rot: Math.round(rot * 1000) / 1000, sign: kind });
      count++;
    }
    console.log(`  signs: ${count} in play area`);
  }

  const signals = readRaw("signals");
  if (signals) {
    let count = 0;
    for (const f of signals.features) {
      const p = pointOf(f);
      if (!p) continue;
      props.push({ kind: "signal", x: round1(p[0]), y: round1(p[1]) });
      count++;
    }
    console.log(`  signals: ${count} in play area`);
  }

  const lights = readRaw("lights");
  if (lights) {
    let count = 0;
    for (const f of lights.features) {
      const p = pointOf(f);
      if (!p) continue;
      props.push({ kind: "light", x: round1(p[0]), y: round1(p[1]) });
      count++;
    }
    console.log(`  lights: ${count} in play area`);
  }

  // Street-level point dressing: same shape, three more kinds.
  const simplePoints: { key: string; kind: "meter" | "furniture" | "bikerack" }[] = [
    { key: "meters", kind: "meter" },
    { key: "furniture", kind: "furniture" },
    { key: "bikeparking", kind: "bikerack" },
  ];
  for (const { key, kind } of simplePoints) {
    const raw = readRaw(key);
    if (!raw) continue;
    let count = 0;
    for (const f of raw.features) {
      const p = pointOf(f);
      if (!p) continue;
      props.push({ kind, x: round1(p[0]), y: round1(p[1]) });
      count++;
    }
    console.log(`  ${key}: ${count} in play area`);
  }

  return props;
}

async function main(): Promise<void> {
  const streets = readRaw("streets");
  const buildings = readRaw("buildings");
  if (!streets || !buildings) {
    console.error("FATAL: raw streets/buildings missing — run extract first.");
    process.exit(1);
  }

  const area = playArea();
  const rect: Rect = { xmin: 0, ymin: 0, xmax: area.width, ymax: area.height };
  console.log(`play area: ${area.width.toFixed(0)} x ${area.height.toFixed(0)} m`);

  const graph = transformStreets(streets, rect);
  // Hybrid buildings: Portland's own layer (rich BLDG_USE) is primary; RLIS
  // regional footprints fill the expansion ring, deduped by centroid cell.
  const cop = transformBuildings("buildings (COP)", buildings, rect, {});
  const rlisRaw = readRaw("buildings2");
  const rlis = rlisRaw
    ? transformBuildings("buildings (RLIS)", rlisRaw, rect, { typeField: "BLDG_TYPE", skipCells: cop.cells })
    : null;
  const allBuildings = [...cop.list, ...(rlis?.list ?? [])].map((b, i) => ({ ...b, id: i }));
  const props = transformProps(rect);
  const water = transformPolys("water", rect);
  const parks = transformPolys("parks", rect);
  const trails = transformTrails(rect);
  const rails = transformRails(rect);
  const railYards = transformPolys("railyards", rect);
  const railStops = transformRailStops(rect);
  const sidewalks = transformPolys("sidewalks", rect);
  const markings = transformMarkings(rect);

  const map: GameMap = {
    meta: {
      name: MAP_NAME,
      sourceDate: extractDate(),
      origin: origin(),
      width: Math.round(area.width),
      height: Math.round(area.height),
    },
    nodes: graph.nodes,
    edges: graph.edges,
    buildings: allBuildings,
    entries: graph.entries,
    props,
    water,
    parks,
    trails,
    rails,
    railYards,
    railStops,
    sidewalks,
    markingAreas: markings.areas,
    markingLines: markings.lines,
  };

  mkdirSync(processedDir(), { recursive: true });
  const outFile = join(processedDir(), `${MAP_NAME}-core.json`);
  writeFileSync(outFile, JSON.stringify(map));
  console.log(`wrote ${outFile}`);

  // Record transform decisions in the manifest.
  const manifest = JSON.parse(readFileSync(MANIFEST_FILE, "utf8")) as Record<string, unknown>;
  manifest["transform"] = {
    origin: origin(),
    playAreaMeters: { width: map.meta.width, height: map.meta.height },
    heightUnit: cop.heightUnit,
    heightUnitRlis: rlis?.heightUnit ?? null,
    streetEpsilonM: STREET_EPSILON,
    footprintEpsilonM: FOOTPRINT_EPSILON,
    counts: {
      nodes: map.nodes.length,
      edges: map.edges.length,
      buildings: map.buildings.length,
      props: map.props.length,
      water: water.length,
      parks: parks.length,
      trails: trails.length,
      rails: rails.length,
      railYards: railYards.length,
      railStops: railStops.length,
      sidewalks: sidewalks.length,
      markingAreas: markings.areas.length,
      markingLines: markings.lines.length,
    },
  };
  writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2) + "\n");
}

await main();
