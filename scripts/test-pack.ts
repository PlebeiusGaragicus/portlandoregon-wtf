// Int16 positions must reconstruct to where the float ones were.
//
//   npx tsx --max-old-space-size=10240 scripts/test-pack.ts
//
// Packing moves a mesh's vertices into the mesh transform, so nothing can be
// compared by reading the attribute directly any more — everything here goes
// through the world matrix, which is what the GPU does too. Two things to
// prove: reconstruction is accurate to the bit width, and the error that
// remains is small in the direction that matters (vertical, because a decal
// that quantizes downward disappears into the terrain).
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
import { beginWorld, packError } from "../client/src/render/world.js";

const MAP_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "../client/src/public/map");
const toBuf = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

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
world.group.updateMatrixWorld(true);

// Meshes whose normals are not all up must NOT have been packed: an
// axis-aligned scale would tilt them.
let packedMeshes = 0;
let floatMeshes = 0;
let packedWithTiltedNormals = 0;
let verts = 0;
let packedVerts = 0;
let posBytes = 0;
world.group.traverse((o) => {
  if (!(o instanceof THREE.Mesh) || o instanceof THREE.InstancedMesh) return;
  const pos = o.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
  if (!pos) return;
  verts += pos.count;
  posBytes += pos.array.byteLength;
  const isPacked = pos.array instanceof Int16Array;
  if (isPacked) {
    packedMeshes++;
    packedVerts += pos.count;
  } else {
    floatMeshes++;
  }
  const n = o.geometry.getAttribute("normal") as THREE.BufferAttribute | undefined;
  if (isPacked && n) {
    for (let i = 0; i < n.count; i++) {
      if (n.getX(i) !== 0 || n.getZ(i) !== 0 || n.getY(i) <= 0) {
        packedWithTiltedNormals++;
        break;
      }
    }
  }
});

check("something got packed", packedMeshes > 0, `${packedMeshes} packed, ${floatMeshes} float`);
check(
  "no packed mesh has a non-up normal",
  packedWithTiltedNormals === 0,
  `${packedWithTiltedNormals} would be distorted`,
);

// The bit-width guarantee, measured while both forms existed. The bars are
// set against the drape error these layers already carry — p95 11 cm for a
// street ribbon — not against zero: anything well inside that is invisible.
check("vertical error under 1 cm", packError.v < 0.01, `worst ${(packError.v * 1000).toFixed(2)} mm`);
check("horizontal error under 5 cm", packError.h < 0.05, `worst ${(packError.h * 100).toFixed(2)} cm`);

// Every packed mesh must still land where the map says it does. Reconstruct
// through the world matrix and check the geometry is inside its own tile plus
// a ribbon's half-width of slack.
const v = new THREE.Vector3();
let outside = 0;
let worstY = 0;
world.group.traverse((o) => {
  if (!(o instanceof THREE.Mesh) || o instanceof THREE.InstancedMesh) return;
  const pos = o.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
  if (!pos || !(pos.array instanceof Int16Array)) return;
  for (let i = 0; i < pos.count; i += 97) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(o.matrixWorld);
    if (v.x < -200 || v.x > map.meta.width + 200 || -v.z < -200 || -v.z > map.meta.height + 200) outside++;
    // Decals live within a few hundred meters of sea level everywhere in
    // Portland; a broken transform shows up here as kilometres.
    if (Math.abs(v.y) > worstY) worstY = Math.abs(v.y);
  }
});
check("packed vertices reconstruct inside the map", outside === 0, `${outside} outside`);
check("packed heights stay plausible", worstY < 1500, `worst |y| ${worstY.toFixed(0)} m`);

// Bounding spheres are computed AFTER packing, so they must account for the
// attribute being normalized — a sphere in raw Int16 units would be 32767x
// too big and defeat frustum culling entirely.
let badSphere = 0;
world.group.traverse((o) => {
  if (!(o instanceof THREE.Mesh) || o instanceof THREE.InstancedMesh) return;
  const pos = o.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
  if (!pos || !(pos.array instanceof Int16Array)) return;
  const s = o.geometry.boundingSphere;
  if (!s || s.radius > 2) badSphere++;
});
check("bounding spheres are in normalized units", badSphere === 0, `${badSphere} meshes with a huge sphere`);

console.log(
  `\n  ${packedMeshes} of ${packedMeshes + floatMeshes} meshes packed, ` +
    `${(packedVerts / 1e6).toFixed(2)}M of ${(verts / 1e6).toFixed(2)}M vertices` +
    `\n  positions ${(posBytes / 1e6).toFixed(1)} MB, ` +
    `${(posBytes / verts).toFixed(1)} bytes/vertex (12 unpacked)`,
);

console.log(failures ? `\n${failures} failed` : "\nall checks passed");
process.exitCode = failures ? 1 : 0;
