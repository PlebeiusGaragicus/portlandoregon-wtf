// Where does the non-building geometry actually go?
//
//   npx tsx --expose-gc --max-old-space-size=10240 scripts/profile-layers.ts
//
// With buildings streamed, everything else in buildWorld is the dominant cost
// — more than every building in the city put together. Before restructuring
// any of it, find out which layer is paying.
//
// Each layer is built alone, so the numbers are additive and comparable.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import * as THREE from "three";
import {
  decodeBuildings,
  decodeHeightfield,
  storeFromBuildings,
  layersFromMap,
  type GameMap,
  type Heightfield,
} from "@portlandoregon/shared";
import { buildWorld } from "../client/src/render/world.js";

const MAP_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "../client/src/public/map");
const toBuf = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const mb = (n: number): string => `${(n / 1e6).toFixed(0)} MB`;
const gc = (globalThis as { gc?: () => void }).gc;
function mem(): number {
  gc?.();
  const m = process.memoryUsage();
  return m.heapUsed + m.arrayBuffers;
}

const map = JSON.parse(gunzipSync(readFileSync(join(MAP_DIR, "map-lite.json.gz"))).toString("utf8")) as GameMap;
map.buildings = [];
const store = decodeBuildings(gunzipSync(readFileSync(join(MAP_DIR, "buildings.bin.gz"))));
let hf: Heightfield | null = null;
try {
  hf = decodeHeightfield(toBuf(gunzipSync(readFileSync(join(MAP_DIR, "heightmap.bin.gz")))));
} catch {
  hf = null;
}

const empty = storeFromBuildings([]);
/** Everything stripped except the named keys. */
function only(keys: (keyof GameMap)[]): GameMap {
  const out: Record<string, unknown> = { meta: map.meta, buildings: [], nodes: [], edges: [], props: [] };
  for (const k of keys) out[k] = map[k];
  return out as unknown as GameMap;
}

/** Terrain mesh cost, subtracted from every feature row. Feature layers MUST
 * be built against the real heightfield — measuring them on flat ground makes
 * every draped layer look free, which is exactly the mistake that hid the
 * sidewalk problem for two rounds. */
let terrainVerts = 0;
let terrainMeshes = 0;
let terrainMem = 0;

function measure(label: string, sub: GameMap, isTerrainBaseline = false): void {
  const before = mem();
  const t0 = performance.now();
  const world = buildWorld(sub, empty, layersFromMap(sub), hf, undefined, true);
  const ms = performance.now() - t0;
  let verts = 0;
  let meshes = 0;
  world.group.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const pos = o.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!pos) return;
    meshes++;
    verts += pos.count;
  });
  const used = mem() - before;
  if (isTerrainBaseline) {
    terrainVerts = verts;
    terrainMeshes = meshes;
    terrainMem = used;
  }
  console.log(
    `  ${label.padEnd(22)} ${String(meshes - (isTerrainBaseline ? 0 : terrainMeshes)).padStart(6)}` +
      ` ${((verts - (isTerrainBaseline ? 0 : terrainVerts)) / 1e6).toFixed(2).padStart(8)}M` +
      ` ${mb(used - (isTerrainBaseline ? 0 : terrainMem)).padStart(9)} ${`${ms.toFixed(0)} ms`.padStart(9)}`,
  );
}

console.log("  layer                 meshes    verts    memory      time");
console.log("  " + "-".repeat(58));

// Terrain alone: no map features at all, just the heightfield mesh.
measure("terrain (baseline)", only([]), true);
// Every row below is built against the same heightfield and reported net of
// that baseline.
measure("streets", only(["edges"]));
measure("sidewalks", only(["sidewalks"]));
measure("lane markings", only(["markingLines", "markingAreas"]));
measure("trails", only(["trails"]));
measure("rails + stops", only(["rails", "railStops", "railYards"]));
measure("water + parks", only(["water", "parks"]));

console.log("");
measure("everything (no bldgs)", map);
console.log(
  `\n  Counts: ${map.edges.length} edges, ${(map.sidewalks ?? []).length} sidewalks, ` +
    `${(map.markingLines ?? []).length} lane lines, ${(map.markingAreas ?? []).length} painted areas`,
);
