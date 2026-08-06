// Checks the ground-decal ordering invariant in client/src/render/world.ts.
//
//   npx tsx scripts/test-decals.ts
//
// The paved layers used to be stacked in centimetre steps and ordered by that
// hover. Measured on real tiles, rail sat 1 cm above street and lost to it
// across 11% of the ground they shared, because draped triangles stray
// further from the terrain than the gaps between layers.
//
// So the invariant is now: every flat decal sits at exactly ONE height, none
// of them write depth, and renderOrder alone decides who paints last. Any
// future change that re-introduces a per-layer hover, or lets a decal write
// depth, silently brings the bug back — hence this test.
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

// Sloped ground, so a flat-shaded decal has something to stray from.
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
  buildings: [], props: [], nodes: [], landmarks: [],
  edges: [{ id: 1, a: 0, b: 1, polyline: lineOf(100), width: 11, name: "TEST ST", class: "local" }],
  rails: [{ id: 1, polyline: lineOf(105), kind: "max" }],
  railStops: [{ id: 1, x: 120, y: 105, kind: "max", name: "Stop" }],
  trails: [{ id: 1, polyline: lineOf(140) }],
  markingLines: [{ id: 1, polyline: lineOf(98), style: "white" }],
  markingAreas: [{ id: 1, rings: [ring(60, 95, 8)], style: "white" }],
  sidewalks: [{ id: 1, rings: [ring(20, 115, 60)] }],
} as unknown as GameMap;

const world = buildWorld(map, storeFromBuildings(map.buildings), layersFromMap(map), hf);

interface Layer {
  order: number;
  depthWrite: boolean;
  /** Height above the terrain, per vertex, in millimetres. */
  lo: number;
  hi: number;
  tris: number;
}
/**
 * Positions on the flat layers are Int16 with the scale in the mesh transform,
 * so every reading here goes through matrixWorld — the raw attribute is in
 * normalized units and means nothing on its own. That also puts a floor under
 * the coplanarity test: a packed vertex can sit up to a few millimetres off
 * where it was computed, so "coplanar" is a band, not an equality.
 */
const PACK_MM = 5;
const layers = new Map<number, Layer>();
const v3 = new THREE.Vector3();
world.group.updateMatrixWorld(true);
world.group.traverse((o) => {
  if (!(o instanceof THREE.Mesh)) return;
  const mat = o.material as THREE.Material & { polygonOffset?: boolean; depthWrite: boolean };
  if (!mat.polygonOffset) return; // terrain / buildings
  const pos = o.geometry.getAttribute("position") as THREE.BufferAttribute;
  const nrm = o.geometry.getAttribute("normal") as THREE.BufferAttribute | undefined;
  let l = layers.get(o.renderOrder);
  if (!l) layers.set(o.renderOrder, (l = { order: o.renderOrder, depthWrite: mat.depthWrite, lo: Infinity, hi: -Infinity, tris: 0 }));
  l.tris += pos.count / 3;
  for (let v = 0; v < pos.count; v++) {
    if (nrm && nrm.getY(v) <= 0.5) continue; // skirt walls are meant to be vertical
    v3.set(pos.getX(v), pos.getY(v), pos.getZ(v)).applyMatrix4(o.matrixWorld);
    const mm = (v3.y - heightAt(hf, v3.x, -v3.z)) * 1000;
    l.lo = Math.min(l.lo, mm);
    l.hi = Math.max(l.hi, mm);
  }
});

check("every layer got a render order", layers.size > 1, `${layers.size} distinct orders`);

// Sidewalks are the one solid member: a raised slab that must occlude.
const solid = [...layers.values()].filter((l) => l.depthWrite);
const flat = [...layers.values()].filter((l) => !l.depthWrite);
check("exactly one depth-writing decal layer (the sidewalk slab)", solid.length === 1, `${solid.length} found`);
check("the rest are flat paint", flat.length >= 4, `${flat.length} flat layers`);

// The invariant that broke: one height for all of them.
//
// Rail stop platforms are the documented exception — a station platform is a
// LEVEL disc, so it deliberately cuts across sloped ground and has no single
// offset. (That is also why it showed the worst drape error of any layer in
// diagnose-clipping.) Everything that claims to be draped must be coplanar.
const draped = flat.filter((l) => l.hi - l.lo <= PACK_MM);
const level = flat.filter((l) => l.hi - l.lo > PACK_MM);
check("at most one non-draped decal layer (level platforms)", level.length <= 1, `${level.length} found`);
const lo = Math.min(...draped.map((l) => l.lo));
const hi = Math.max(...draped.map((l) => l.hi));
check(
  "all draped decals are coplanar",
  hi - lo <= PACK_MM && draped.length >= 4,
  `${draped.length} draped layers spanning ${lo.toFixed(2)}..${hi.toFixed(2)} mm above ground`,
);

// A coplanar layer that wrote depth would depth-fight its neighbours instead
// of deferring to paint order.
check("no flat decal writes depth", flat.every((l) => !l.depthWrite));

// Paint order has to be strict, or two layers land in the same slot and the
// winner goes back to being arbitrary.
const orders = flat.map((l) => l.order);
check("flat decals have distinct render orders", new Set(orders).size === orders.length, orders.join(", "));
check("the solid slab draws before the paint", solid[0]!.order < Math.min(...orders), `slab at ${solid[0]!.order}`);

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
