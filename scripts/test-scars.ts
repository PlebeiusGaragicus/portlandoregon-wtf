// Checks client/src/scars.ts — the record that has to survive a mesh.
//
//   npx tsx scripts/test-scars.ts
//
// The property that matters for tile streaming: a building painted once from
// its final scar record must be pixel-identical to one painted incrementally
// as the damage happened. If that holds, a rebuilt tile comes back exactly as
// scarred as the one it replaced, and geometry is safe to throw away.
//
// Builds two identical worlds headlessly (THREE builds BufferGeometry fine in
// Node — no renderer is constructed), damages one the slow way and the other
// in a single paint, and diffs every vertex colour in the scene.
import * as THREE from "three";
import { storeFromBuildings, type GameMap } from "@battle-juice/shared";
import { ScarField } from "../client/src/scars.js";
import { buildWorld, type WorldLayers } from "../client/src/render/world.js";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
}

const square = (x: number, y: number, s: number): [number, number][] => [
  [x, y], [x + s, y], [x + s, y + s], [x, y + s],
];

const map = {
  meta: { name: "test", sourceDate: "test", origin: { lat: 0, lon: 0 }, width: 600, height: 600 },
  buildings: [
    { id: 1, footprint: square(100, 100, 40), height: 10, use: "sfr" },
    { id: 2, footprint: square(200, 200, 60), height: 24, use: "com" },
  ],
  edges: [],
  props: [],
} as unknown as GameMap;

/** Every vertex colour in the scene, in traversal order. Two worlds built
 * from one map produce identical buffers, so any difference is damage. */
function colors(w: WorldLayers): Float32Array {
  const parts: Float32Array[] = [];
  w.group.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const c = o.geometry.getAttribute("color") as THREE.BufferAttribute | undefined;
    if (c) parts.push(c.array as Float32Array);
  });
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function diff(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return Infinity;
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}

// Cell layout the way a fire samples it: points around the perimeter. Exact
// positions don't matter here, only that both runs use the same ones.
const cells = [
  { x: 100, y: 100 }, { x: 120, y: 100 }, { x: 140, y: 100 },
  { x: 140, y: 120 }, { x: 140, y: 140 }, { x: 100, y: 140 },
];
const CELL_R = 14;

/** recordBurn reads the live burn's cells in place; the test only cares
 * about the damage on them. */
const chars = (v: number[]): { char: number }[] => v.map((char) => ({ char }));

const slow = buildWorld(map, storeFromBuildings(map.buildings));
const fast = buildWorld(map, storeFromBuildings(map.buildings));
check("two builds of one map are identical", diff(colors(slow), colors(fast)) === 0);

const pristine = colors(slow).slice();

// --- the slow world: damage arrives over time, repainted at every step -----
const a = new ScarField();
a.beginBurn(0, cells, CELL_R);
a.recordBurn(0, chars([0.3, 0.2, 0.1, 0, 0, 0]));
slow.shells.charLocal(0, a.sources(0));
a.recordBurn(0, chars([0.9, 0.8, 0.55, 0.3, 0.1, 0]));
slow.shells.charLocal(0, a.sources(0));
a.addBlast(0, 138, 138, 0.6, 9);
slow.shells.charLocal(0, a.sources(0));

// --- the fast world: one paint from the final record ----------------------
const b = new ScarField();
b.beginBurn(0, cells, CELL_R);
b.recordBurn(0, chars([0.9, 0.8, 0.55, 0.3, 0.1, 0]));
b.addBlast(0, 138, 138, 0.6, 9);
fast.shells.charLocal(0, b.sources(0));

check("something actually got charred", diff(colors(slow), pristine) > 0);
const d = diff(colors(slow), colors(fast));
check("rebuild-from-record matches incremental paint", d === 0, `${d} vertices differ`);

// Repainting the same record must not drift — a tile can be rebuilt any
// number of times.
fast.shells.charLocal(0, b.sources(0));
check("repaint is idempotent", diff(colors(slow), colors(fast)) === 0);

// --- accumulation: the bug this record fixes ------------------------------
// charLocal rebuilds pristine colours every call, so painting a later event's
// sources ALONE erases earlier damage. Going through the record composes.
const onlyBlast = buildWorld(map, storeFromBuildings(map.buildings));
onlyBlast.shells.charLocal(0, [{ x: 138, y: 138, f: 0.6, r: 9 }]);
check(
  "a blast alone would erase fire scars",
  diff(colors(onlyBlast), colors(fast)) > 0,
  "expected the record to preserve more damage than the blast alone",
);

// --- monotonic damage -----------------------------------------------------
const m = new ScarField();
m.beginBurn(1, cells, CELL_R);
m.recordBurn(1, chars([0.8, 0, 0, 0, 0, 0]));
m.recordBurn(1, chars([0.2, 0, 0, 0, 0, 0]));
check("char never goes down", Math.abs(m.sources(1)[0]!.f - 0.8) < 0.01);

// A second fire on the same building reuses its cells and keeps the damage.
m.beginBurn(1, cells, CELL_R);
check("re-ignition keeps existing scars", Math.abs(m.sources(1)[0]!.f - 0.8) < 0.01);

// --- blast bookkeeping ----------------------------------------------------
const bl = new ScarField();
for (let i = 0; i < 20; i++) bl.addBlast(2, 500 + i * 10, 500, 0.5, 8);
check("blast list is bounded", bl.sources(2).length <= 8, `${bl.sources(2).length} sources`);
bl.addBlast(3, 100, 100, 0.3, 5);
bl.addBlast(3, 101, 100, 0.7, 9); // within the merge distance
check("nearby hits merge into one crater", bl.sources(3).length === 1);
check("merged crater takes the worst of both", bl.sources(3)[0]!.f === 0.7 && bl.sources(3)[0]!.r === 9);

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
