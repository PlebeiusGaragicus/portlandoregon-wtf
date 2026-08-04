// Stage 5 — TRANSFORM. Reproject to local meters, build the street graph from
// PDX node IDs (trust them — never re-snap), check connectivity, clip to the
// play area, mark entry nodes, simplify geometry, shape props.
// Reads data/raw/{date}/, writes data/processed/{date}/pearl-core.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Building, GameMap, Prop, RoadClass, StreetEdge, StreetNode } from "@battle-juice/shared";
import { extractDate, HEIGHT_PER_STORY_M, MANIFEST_FILE, processedDir, rawDir, SIGN_KEEP } from "./config.js";
import type { GeoJsonCollection, GeoJsonFeature } from "./lib/arcgis.js";
import { clipPolylineAtExit, ensureWinding, inRect, round1, simplify, type Pt, type Rect } from "./lib/geo.js";
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
}

function buildGraph(streets: GeoJsonCollection): { edges: RawEdge[]; nodePos: Map<number, Pt> } {
  const edges: RawEdge[] = [];
  const nodePos = new Map<number, Pt>();
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
    edges.push({
      f,
      t,
      line,
      name: String(p["FULL_NAME"] ?? ""),
      cls: roadClass(p["CFCC"], p["TYPE"]),
    });
  }
  if (skipped) console.log(`  streets: skipped ${skipped} segments without node ids/geometry`);
  return { edges, nodePos };
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
  if (fraction < DOMINANT_COMPONENT_MIN) {
    console.error("FATAL: street graph is fragmented — was the extract clipped too tight?");
    process.exit(1);
  }
  const keep = new Set<number>();
  for (const key of parent.keys()) if (find(key) === bestRoot) keep.add(key);
  return keep;
}

function transformStreets(streets: GeoJsonCollection, rect: Rect) {
  const { edges: rawEdges } = buildGraph(streets);
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
    });
  }

  // Entry candidates: boundary nodes on the north/south map edges.
  const margin = 2; // m
  const north: number[] = [];
  const south: number[] = [];
  for (const id of boundaryNodes) {
    const n = nodes[id]!;
    if (n.y >= rect.ymax - margin) north.push(id);
    else if (n.y <= rect.ymin + margin) south.push(id);
  }
  console.log(`  clipped: ${nodes.length} nodes, ${edges.length} edges, entries N=${north.length} S=${south.length}`);
  return { nodes, edges, entries: { north, south } };
}

function transformBuildings(buildings: GeoJsonCollection, rect: Rect): { list: Building[]; heightUnit: string } {
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
  console.log(`  buildings: MAX_HEIGHT median ${medianRatio.toFixed(1)} per story -> treating as ${heightUnit}`);

  const list: Building[] = [];
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
    const use = f.properties["BLDG_USE"] ? String(f.properties["BLDG_USE"]) : undefined;

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
        ...(use ? { use } : {}),
      });
    }
  }
  console.log(`  buildings: ${list.length} prisms in play area`);
  return { list, heightUnit };
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
  const built = transformBuildings(buildings, rect);
  const props = transformProps(rect);

  const map: GameMap = {
    meta: {
      name: "pearl",
      sourceDate: extractDate(),
      origin: origin(),
      width: Math.round(area.width),
      height: Math.round(area.height),
    },
    nodes: graph.nodes,
    edges: graph.edges,
    buildings: built.list,
    entries: graph.entries,
    props,
  };

  mkdirSync(processedDir(), { recursive: true });
  const outFile = join(processedDir(), "pearl-core.json");
  writeFileSync(outFile, JSON.stringify(map));
  console.log(`wrote ${outFile}`);

  // Record transform decisions in the manifest.
  const manifest = JSON.parse(readFileSync(MANIFEST_FILE, "utf8")) as Record<string, unknown>;
  manifest["transform"] = {
    origin: origin(),
    playAreaMeters: { width: map.meta.width, height: map.meta.height },
    heightUnit: built.heightUnit,
    streetEpsilonM: STREET_EPSILON,
    footprintEpsilonM: FOOTPRINT_EPSILON,
    counts: {
      nodes: map.nodes.length,
      edges: map.edges.length,
      buildings: map.buildings.length,
      props: map.props.length,
    },
  };
  writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2) + "\n");
}

await main();
