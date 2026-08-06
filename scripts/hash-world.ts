// Fingerprint the built world, so a refactor can be proved not to change it.
//
//   npx tsx --max-old-space-size=10240 scripts/hash-world.ts
//
// Prints one hash per attribute across every mesh, plus counts. Run it, change
// the code, run it again: the numbers either match or the refactor moved
// geometry. Meshes are sorted by a content key first, because tiling order is
// an implementation detail and splitting one soup into two must not register
// as a difference — only the vertex data itself.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import * as THREE from "three";
import {
  decodeBuildings,
  decodeHeightfield,
  decodeLayers,
  type GameMap,
  type Heightfield,
} from "@battle-juice/shared";
import { buildCityModel } from "../client/src/city.js";
import { buildWorld } from "../client/src/render/world.js";

const MAP_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "../client/src/public/map");
const toBuf = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

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
const world = buildWorld(map, buildings, layers, hf, city, false);

/**
 * Per-layer aggregates rather than a hash.
 *
 * A hash was the right tool while every refactor had to leave geometry
 * bit-identical. Int16 positions end that: vertices legitimately move by up to
 * ~3 cm, and how they are split across meshes is no longer fixed either. So
 * compare things that survive both — vertex count, centroid, bounding box —
 * read through each mesh's world matrix, which is where the geometry actually
 * is once the transform carries the scale.
 */
world.group.updateMatrixWorld(true);

interface Agg {
  meshes: number;
  verts: number;
  sx: number;
  sy: number;
  sz: number;
  min: [number, number, number];
  max: [number, number, number];
}
const byOrder = new Map<number, Agg>();
const v = new THREE.Vector3();
world.group.traverse((o) => {
  if (!(o instanceof THREE.Mesh) || o instanceof THREE.InstancedMesh) return;
  const pos = o.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
  if (!pos) return;
  const a = byOrder.get(o.renderOrder) ?? {
    meshes: 0,
    verts: 0,
    sx: 0,
    sy: 0,
    sz: 0,
    min: [Infinity, Infinity, Infinity] as [number, number, number],
    max: [-Infinity, -Infinity, -Infinity] as [number, number, number],
  };
  a.meshes++;
  a.verts += pos.count;
  for (let i = 0; i < pos.count; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(o.matrixWorld);
    a.sx += v.x;
    a.sy += v.y;
    a.sz += v.z;
    a.min[0] = Math.min(a.min[0], v.x);
    a.min[1] = Math.min(a.min[1], v.y);
    a.min[2] = Math.min(a.min[2], v.z);
    a.max[0] = Math.max(a.max[0], v.x);
    a.max[1] = Math.max(a.max[1], v.y);
    a.max[2] = Math.max(a.max[2], v.z);
  }
  byOrder.set(o.renderOrder, a);
});

console.log("  order  meshes      verts        centroid (x, y, z)              bbox y");
console.log("  " + "-".repeat(72));
let verts = 0;
for (const [order, a] of [...byOrder].sort((p, q) => p[0] - q[0])) {
  verts += a.verts;
  console.log(
    `  ${String(order).padStart(5)} ${String(a.meshes).padStart(7)} ${String(a.verts).padStart(10)}` +
      `   ${(a.sx / a.verts).toFixed(3).padStart(11)} ${(a.sy / a.verts).toFixed(3).padStart(9)} ${(a.sz / a.verts).toFixed(3).padStart(11)}` +
      `   ${a.min[1].toFixed(2).padStart(8)} .. ${a.max[1].toFixed(2)}`,
  );
}
console.log(`
  ${verts} vertices in ${[...byOrder.values()].reduce((n, a) => n + a.meshes, 0)} meshes`);
