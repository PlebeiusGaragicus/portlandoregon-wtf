// Checks which world meshes hand their vertex data to the GPU and drop the
// JS-side copy (see `seal` in client/src/render/world.ts).
//
//   npx tsx scripts/test-seal.ts
//
// three.js keeps every attribute's typed array after uploading it, so a
// resident mesh costs its vertices twice — once in WebGL, once in the heap.
// Sealing drops the second copy for geometry nobody reads back, which is most
// of the gap between a headless profile and the browser tab.
//
// Two ways this goes wrong, and neither shows up headlessly because the
// callback only fires under a real renderer:
//   - sealing a BUILDING mesh would pull the array out from under the fire
//     sim, whose char and collapse surgery writes into it every tick;
//   - a sealed geometry whose bounding sphere was never computed would need
//     the vertices it just discarded, and FPV culling asks for exactly that
//     on mode entry.
import * as THREE from "three";
import {
  heightAt,
  layersFromMap,
  storeFromBuildings,
  type GameMap,
  type Heightfield,
} from "@battle-juice/shared";
import { buildWorld } from "../client/src/render/world.js";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
}

const hf: Heightfield = {
  cols: 8, rows: 8, cellSize: 50, scale: 1,
  data: new Uint16Array(64).map((_, i) => (i % 8) * 6),
};
const ring = (x: number, y: number, s: number): [number, number][] => [
  [x, y], [x + s, y], [x + s, y + s], [x, y + s],
];
const lineOf = (y: number): [number, number][] => [[20, y], [120, y], [220, y]];

const map = {
  meta: { name: "test", sourceDate: "test", origin: { lat: 0, lon: 0 }, width: 350, height: 350 },
  nodes: [], props: [], landmarks: [],
  buildings: [{ id: 1, footprint: ring(40, 40, 30), height: 12, use: "sfr" }],
  edges: [{ id: 1, a: 0, b: 1, polyline: lineOf(100), width: 11, name: "TEST ST", class: "local" }],
  trails: [{ id: 1, polyline: lineOf(140) }],
  markingLines: [{ id: 1, polyline: lineOf(98), style: "white" }],
  sidewalks: [{ id: 1, rings: [ring(20, 115, 60)] }],
} as unknown as GameMap;

const store = storeFromBuildings(map.buildings);
const world = buildWorld(map, store, layersFromMap(map), hf);

/** An attribute is sealed when it carries a drop-on-upload callback. */
const sealed = (g: THREE.BufferGeometry): boolean =>
  Object.values(g.attributes).every(
    (a) => (a as THREE.BufferAttribute).onUploadCallback !== THREE.BufferAttribute.prototype.onUploadCallback,
  );

const buildingGeos = new Set<THREE.BufferGeometry>();
world.buildings.group.traverse((o) => {
  if (o instanceof THREE.Mesh && !(o instanceof THREE.InstancedMesh)) buildingGeos.add(o.geometry);
});

let staticSealed = 0;
let staticLoose = 0;
let missingBounds = 0;
world.group.traverse((o) => {
  if (!(o instanceof THREE.Mesh) || o instanceof THREE.InstancedMesh) return;
  if (buildingGeos.has(o.geometry)) return;
  if (sealed(o.geometry)) {
    staticSealed++;
    if (!o.geometry.boundingSphere) missingBounds++;
  } else {
    staticLoose++;
  }
});

check("static world meshes are sealed", staticSealed > 0 && staticLoose === 0, `${staticSealed} sealed, ${staticLoose} loose`);
check("every sealed geometry has its bounds already", missingBounds === 0, `${missingBounds} without a bounding sphere`);

// The fire sim writes into building geometry every time damage changes.
let buildingsSealed = 0;
for (const g of buildingGeos) if (sealed(g)) buildingsSealed++;
check("building meshes are NOT sealed", buildingsSealed === 0, `${buildingsSealed} of ${buildingGeos.size} sealed`);
check("there were building meshes to check", buildingGeos.size > 0, `${buildingGeos.size} found`);

// Proof the surgery still has something to write to: char it and diff.
const col = [...buildingGeos][0]!.getAttribute("color") as THREE.BufferAttribute;
const before = (col.array as Float32Array).slice();
world.shells.char(0, 1);
let changed = 0;
for (let i = 0; i < before.length; i++) if (before[i] !== (col.array as Float32Array)[i]) changed++;
check("charring a building still reaches its vertices", changed > 0, `${changed} components changed`);

// --- attribute packing ----------------------------------------------------
// Normals and colours on static geometry are normalized bytes, not floats:
// 24 bytes off every vertex, on the GPU as well as in the heap. Buildings are
// the exception, because charLocal writes raw floats into their colours.
let packedStatic = 0;
let floatStatic = 0;
let bytes = 0;
let verts = 0;
world.group.traverse((o) => {
  if (!(o instanceof THREE.Mesh) || o instanceof THREE.InstancedMesh) return;
  if (buildingGeos.has(o.geometry)) return;
  const n = o.geometry.getAttribute("normal") as THREE.BufferAttribute | undefined;
  const c = o.geometry.getAttribute("color") as THREE.BufferAttribute | undefined;
  const packedHere = (!n || n.array.BYTES_PER_ELEMENT === 1) && (!c || c.array.BYTES_PER_ELEMENT === 1);
  if (packedHere) packedStatic++;
  else floatStatic++;
  const count = (o.geometry.getAttribute("position") as THREE.BufferAttribute).count;
  verts += count;
  for (const a of Object.values(o.geometry.attributes)) {
    bytes += (a as THREE.BufferAttribute).itemSize * (a as THREE.BufferAttribute).array.BYTES_PER_ELEMENT * count;
  }
});
check("static normals and colours are byte-packed", floatStatic === 0, `${floatStatic} of ${packedStatic + floatStatic} still float`);
check("that lands under 20 bytes per vertex", bytes / verts < 20, `${(bytes / verts).toFixed(1)} B/vertex`);

for (const g of buildingGeos) {
  const c = g.getAttribute("color") as THREE.BufferAttribute;
  check("building colours stay float", c.array.BYTES_PER_ELEMENT === 4, `${c.array.BYTES_PER_ELEMENT} bytes`);
  break;
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
