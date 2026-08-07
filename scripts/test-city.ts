// Checks client/src/city.ts — the per-building facts the sim and the renderer
// both read (ground base, centroid, existence).
//
//   npx tsx scripts/test-city.ts
//
// These used to be derived three separate times: in buildWorld for the
// prisms, in FireSim for centroids, in FPV's SolidIndex for collision. Now
// there is one derivation, so the thing worth guarding is that it still
// produces exactly what those three did — most importantly the 1 m base sink
// and the roof height that FPV stands on, which differ by that same 1 m and
// would go unnoticed until someone fell through a building.
//
// Runs on a synthetic map in milliseconds; verified separately against the
// real Portland extract (538,519 buildings, zero mismatches).
import { heightAt, storeFromBuildings, type GameMap, type Heightfield } from "@portlandoregon/shared";
import { buildCityModel } from "../client/src/city.js";

let failed = 0;
function check(name: string, got: unknown, want: unknown): void {
  const ok = Object.is(got, want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${String(got)}, want ${String(want)}`}`);
}

// A 4x4 grid sloping 10 m per cell to the east, so a footprint's corners sit
// at visibly different ground heights and "lowest corner" is a real choice.
const hf: Heightfield = {
  cols: 4,
  rows: 4,
  cellSize: 100,
  scale: 1,
  data: new Uint16Array([
    0, 10, 20, 30,
    0, 10, 20, 30,
    0, 10, 20, 30,
    0, 10, 20, 30,
  ]),
};

const square = (x: number, y: number, s: number): [number, number][] => [
  [x, y], [x + s, y], [x + s, y + s], [x, y + s],
];

const map = {
  meta: { name: "test", sourceDate: "test", origin: { lat: 0, lon: 0 }, width: 300, height: 300 },
  buildings: [
    { id: 1, footprint: square(100, 100, 50), height: 12, use: "sfr" },
    { id: 2, footprint: square(0, 0, 100), height: 30, use: "com" },
    { id: 3, footprint: [] as [number, number][], height: 9, use: "sfr" }, // degenerate
    { id: 4, footprint: [[10, 10], [20, 20]] as [number, number][], height: 9, use: "sfr" }, // 2 verts
  ],
} as unknown as GameMap;

const city = buildCityModel(storeFromBuildings(map.buildings), hf);

// Existence: a ring needs three vertices to be anything at all. This is the
// test that replaced BuildingShells.has() — under tile streaming that meant
// "is drawn right now", which would have made unloaded buildings fireproof.
check("valid: real footprint", city.valid[0], 1);
check("valid: empty footprint", city.valid[2], 0);
check("valid: 2-vertex footprint", city.valid[3], 0);

// Base: lowest ground under the ring, sunk 1 m. The west edge of building 1
// sits at x=100 → exactly 10 m.
check("baseZ: lowest corner, sunk 1 m", city.baseZ[0], Math.fround(heightAt(hf, 100, 100) - 1));
check("baseZ: 10 m contour", city.baseZ[0], 9);
check("baseZ: at the origin corner", city.baseZ[1], -1);
// A degenerate footprint has no corners to sample, so the formula falls
// through to 0 - 1. Nothing reads it (they are in no spatial index), but it
// must not be NaN — that would poison any arithmetic that ever touched it.
check("baseZ: degenerate is finite", city.baseZ[2], -1);

check("centroid x", city.cx[0], 125);
check("centroid y", city.cy[0], 125);
check("centroid: degenerate stays 0", city.cx[2], 0);

// What FPV stands on. SolidIndex used to compute the roof from its own
// minimum-corner scan; it now adds the sink back to the shared base, and the
// two must agree exactly or the player floats or falls through.
const roof = city.baseZ[0]! + 1 + 12;
check("fpv roof height", roof, Math.fround(heightAt(hf, 100, 100)) + 12);

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
