// CellGrid must answer exactly what the Map-of-arrays grid answered.
//
//   npx tsx --max-old-space-size=10240 scripts/test-grid.ts
//
// The fire sim's neighbour lookup was `Map<number, number[]>` keyed on
// `row * 8192 + col`, with no bounds at all. Replacing it with a dense CSR
// grid changes two things that could bite: members outside the map now clamp
// into an edge cell, and queries clamp too. Both are meant to be invisible
// because every caller filters on the true distance — so check that against
// the real city, at the edges and in the middle.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { decodeBuildings, decodeHeightfield, type GameMap, type Heightfield } from "@portlandoregon/shared";
import { buildCityModel } from "../client/src/city.js";
import { CellGrid } from "../client/src/grid.js";

const MAP_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "../client/src/public/map");
const toBuf = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

const map = JSON.parse(gunzipSync(readFileSync(join(MAP_DIR, "map-lite.json.gz"))).toString("utf8")) as GameMap;
const store = decodeBuildings(gunzipSync(readFileSync(join(MAP_DIR, "buildings.bin.gz"))));
let hf: Heightfield | null = null;
try {
  hf = decodeHeightfield(toBuf(gunzipSync(readFileSync(join(MAP_DIR, "heightmap.bin.gz")))));
} catch {
  hf = null;
}
const city = buildCityModel(store, hf);

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const CELL = 45;
const W = map.meta.width;
const H = map.meta.height;
const n = store.count;

// The old structure, verbatim.
const t0 = performance.now();
const legacy = new Map<number, number[]>();
for (let i = 0; i < n; i++) {
  if (!city.valid[i]) continue;
  const key = Math.floor(city.cy[i]! / CELL) * 8192 + Math.floor(city.cx[i]! / CELL);
  const cell = legacy.get(key);
  if (cell) cell.push(i);
  else legacy.set(key, [i]);
}
const legacyMs = performance.now() - t0;

const t1 = performance.now();
const grid = new CellGrid(CELL, W, H, n, (i) => city.cx[i]!, (i) => city.cy[i]!, (i) => city.valid[i] === 1);
const gridMs = performance.now() - t1;

/** The old nearBuildings, verbatim. */
function legacyNear(x: number, y: number, r: number): number[] {
  const out: number[] = [];
  for (let ry = Math.floor((y - r) / CELL); ry <= Math.floor((y + r) / CELL); ry++) {
    for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++) {
      for (const bi of legacy.get(ry * 8192 + cx) ?? []) {
        if (Math.hypot(city.cx[bi]! - x, city.cy[bi]! - y) <= r) out.push(bi);
      }
    }
  }
  return out.sort((a, b) => a - b);
}

function gridNear(x: number, y: number, r: number): number[] {
  const out: number[] = [];
  grid.forEachNear(x, y, r, (bi) => {
    if (Math.hypot(city.cx[bi]! - x, city.cy[bi]! - y) <= r) out.push(bi);
  });
  return out.sort((a, b) => a - b);
}

// Deterministic sample: a lattice over the whole map plus every edge and
// corner, at the radii the sim actually uses.
const probes: [number, number][] = [];
for (let gy = 0; gy <= 20; gy++) {
  for (let gx = 0; gx <= 20; gx++) probes.push([(gx / 20) * W, (gy / 20) * H]);
}
for (const d of [-500, -60, -1, 0, 1]) {
  probes.push([d, H / 2], [W - d, H / 2], [W / 2, d], [W / 2, H - d], [d, d], [W - d, H - d]);
}

let mismatches = 0;
let found = 0;
let worst: string | null = null;
for (const [x, y] of probes) {
  for (const r of [9, 45, 90, 200]) {
    const a = legacyNear(x, y, r);
    const b = gridNear(x, y, r);
    found += b.length;
    if (a.length !== b.length || a.some((v, i) => v !== b[i])) {
      mismatches++;
      worst ??= `(${x.toFixed(0)},${y.toFixed(0)}) r=${r}: legacy ${a.length}, grid ${b.length}`;
    }
  }
}
check(
  `${probes.length * 4} queries return identical sets`,
  mismatches === 0,
  mismatches ? worst! : `${found} hits total`,
);

// Every valid building must be reachable — the clamping case is the one that
// could silently lose the footprints sitting outside the declared bounds.
const reachable = new Uint8Array(n);
for (let ry = 0; ry < grid.rows; ry++) {
  for (let cx = 0; cx < grid.cols; cx++) {
    grid.forEachNear(cx * CELL + CELL / 2, ry * CELL + CELL / 2, CELL, (bi) => (reachable[bi] = 1));
  }
}
let lost = 0;
let outside = 0;
for (let i = 0; i < n; i++) {
  if (!city.valid[i]) continue;
  if (city.cx[i]! < 0 || city.cy[i]! < 0 || city.cx[i]! > W || city.cy[i]! > H) outside++;
  if (!reachable[i]) lost++;
}
check("no valid building is unreachable", lost === 0, `${lost} lost, ${outside} sit outside the map bounds`);

const legacyBytes = [...legacy.values()].reduce((a, c) => a + 56 + c.length * 8, 0) + legacy.size * 48;
console.log(
  `\n  build     legacy ${legacyMs.toFixed(0)} ms   CSR ${gridMs.toFixed(0)} ms` +
    `\n  memory    legacy ~${(legacyBytes / 1e6).toFixed(0)} MB (${legacy.size} cells)` +
    `   CSR ${(grid.bytes / 1e6).toFixed(1)} MB (${grid.cols}x${grid.rows} cells)`,
);

console.log(failures ? `\n${failures} failed` : "\nall checks passed");
process.exitCode = failures ? 1 : 0;
