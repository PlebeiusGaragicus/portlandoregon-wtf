// Where do resident vertex bytes actually go, attribute by attribute?
//
//   npx tsx --max-old-space-size=10240 scripts/measure-attrs.ts
//
// Positions are still Float32 — 12 bytes where 6 would do. Before packing
// them, find out which meshes hold them and, crucially, which of those have
// constant-up normals: an axis-aligned non-uniform scale leaves an up normal
// exactly up, but mangles every other one. That property is what decides how
// much of this is safely reachable.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import * as THREE from "three";
import {
  decodeBuildings,
  decodeHeightfield,
  decodeLayers,
  findTile,
  tileKeyAt,
  type GameMap,
  type Heightfield,
} from "@portlandoregon/shared";
import { buildCityModel } from "../client/src/city.js";
import { beginWorld } from "../client/src/render/world.js";

const MAP_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "../client/src/public/map");
const toBuf = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const mb = (n: number): string => `${(n / 1e6).toFixed(1)} MB`;

const map = JSON.parse(gunzipSync(readFileSync(join(MAP_DIR, "map-lite.json.gz"))).toString("utf8")) as GameMap;
map.buildings = [];
const buildings = decodeBuildings(gunzipSync(readFileSync(join(MAP_DIR, "buildings.bin.gz"))));
const layers = decodeLayers(gunzipSync(readFileSync(join(MAP_DIR, "layers.bin.gz"))));
let hf: Heightfield | null = null;
try {
  hf = decodeHeightfield(toBuf(gunzipSync(readFileSync(join(MAP_DIR, "heightmap.bin.gz")))));
} catch {
  hf = null;
}

const city = buildCityModel(buildings, hf);
const { world, steps } = beginWorld(map, buildings, layers, hf, city);
for (const _ of steps) void _;

// One downtown window of streamed dressing and prisms, so the numbers cover
// what is actually resident in play and not just the boot layers.
const centre = { x: 11_000, y: 21_000 };
const want: number[] = [];
for (let dy = -2; dy <= 2; dy++) {
  for (let dx = -2; dx <= 2; dx++) {
    const t = findTile(buildings, tileKeyAt(centre.x + dx * buildings.tileSize, centre.y + dy * buildings.tileSize, buildings.tileSize));
    if (t >= 0) want.push(t);
  }
}
world.buildings.sync(want);
world.detailTiles.sync(want.map((t) => buildings.tileKey[t]!));

/** Constant-up normals survive a non-uniform axis-aligned scale exactly; any
 * other normal does not. This is the test for whether a mesh can be packed. */
function normalsAllUp(geo: THREE.BufferGeometry): boolean {
  const n = geo.getAttribute("normal") as THREE.BufferAttribute | undefined;
  if (!n) return true;
  for (let i = 0; i < n.count; i++) {
    if (n.getX(i) !== 0 || n.getZ(i) !== 0 || n.getY(i) <= 0) return false;
  }
  return true;
}

interface Row {
  meshes: number;
  verts: number;
  pos: number;
  other: number;
  index: number;
}
const rows = new Map<string, Row>();
function add(key: string, geo: THREE.BufferGeometry): void {
  const r = rows.get(key) ?? { meshes: 0, verts: 0, pos: 0, other: 0, index: 0 };
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  r.meshes++;
  r.verts += pos.count;
  for (const [name, a] of Object.entries(geo.attributes)) {
    const bytes = (a as THREE.BufferAttribute).array.byteLength;
    if (name === "position") r.pos += bytes;
    else r.other += bytes;
  }
  r.index += geo.index?.array.byteLength ?? 0;
  rows.set(key, r);
}

const LAYER: Record<number, string> = {
  0: "terrain / ground",
  0.5: "sidewalk slabs",
  1: "water",
  2: "parks",
  3: "rail yards",
  4: "trails",
  5: "streets",
  6: "rails",
  7: "rail stops",
  8: "markings",
  9: "lane lines",
};

world.group.traverse((o) => {
  if (!(o instanceof THREE.Mesh) || o instanceof THREE.InstancedMesh) return;
  const pos = o.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
  if (!pos) return;
  // Building prisms are the one thing that must stay float — the fire sim
  // writes into their position and colour buffers.
  const name = LAYER[o.renderOrder] ?? "building prisms";
  add(`${name}${normalsAllUp(o.geometry) ? "" : " *"}`, o.geometry);
});

console.log("  layer                    meshes      verts   position      other      index    B/vert");
console.log("  " + "-".repeat(84));
let total = 0;
let allVerts = 0;
for (const [name, r] of [...rows].sort((a, b) => b[1].pos - a[1].pos)) {
  console.log(
    `  ${name.padEnd(22)} ${String(r.meshes).padStart(7)} ${(r.verts / 1e6).toFixed(2).padStart(9)}M` +
      ` ${mb(r.pos).padStart(10)} ${mb(r.other).padStart(10)} ${mb(r.index).padStart(10)}` +
      ` ${(r.pos / r.verts).toFixed(1).padStart(9)}`,
  );
  total += r.pos;
  allVerts += r.verts;
}
console.log(
  `\n  * = normals are not all up, so a non-uniform scale would distort them —` +
    `\n      those layers keep Float32 positions at 12 bytes a vertex.` +
    `\n  positions ${mb(total)} over ${(allVerts / 1e6).toFixed(2)}M vertices ` +
    `(${(total / allVerts).toFixed(1)} B/vertex; 12 is unpacked, 6 fully packed).`,
);
