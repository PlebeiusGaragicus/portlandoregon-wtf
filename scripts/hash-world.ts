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
 * Split-invariant fingerprint: accumulate a per-VERTEX hash commutatively, so
 * how the vertices are distributed across meshes cannot change the result.
 * That matters because bounding a soup's size (so no single mesh conversion
 * blows a frame budget) legitimately splits one mesh into several, and that
 * must not read as a geometry change.
 */
function h32(x: number): number {
  let v = Math.round(x * 1000) | 0;
  v = Math.imul(v ^ (v >>> 16), 0x45d9f3b);
  v = Math.imul(v ^ (v >>> 16), 0x45d9f3b);
  return (v ^ (v >>> 16)) | 0;
}

let verts = 0;
let meshes = 0;
let ph = 0;
let ch = 0;
world.group.traverse((o) => {
  if (!(o instanceof THREE.Mesh)) return;
  const pos = o.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
  if (!pos) return;
  meshes++;
  verts += pos.count;
  const col = o.geometry.getAttribute("color") as THREE.BufferAttribute | undefined;
  const layer = h32(o.renderOrder);
  for (let i = 0; i < pos.count; i++) {
    // Layer folded in so a vertex moving between paint orders still shows.
    ph = (ph + (h32(pos.getX(i)) ^ h32(pos.getY(i) * 7) ^ h32(pos.getZ(i) * 13) ^ layer)) | 0;
  }
  if (col) {
    for (let i = 0; i < col.count; i++) {
      ch = (ch + (h32(col.getX(i)) ^ h32(col.getY(i) * 7) ^ h32(col.getZ(i) * 13) ^ layer)) | 0;
    }
  }
});

console.log(`meshes ${meshes}  verts ${verts}  position ${ph}  colour ${ch}`);
