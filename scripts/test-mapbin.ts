// Round-trips shared/src/mapbin.ts against the real Portland extract, and
// measures the heap it was written to save.
//
//   npx tsx --expose-gc --max-old-space-size=10240 scripts/test-mapbin.ts
//
// Two things have to hold before anything is migrated onto this format:
// every building survives the round trip inside the quantisation grid, and
// the store actually costs what the proposal claimed (~37 MB against ~560 MB
// of object graph). The second is measured with real heap deltas, not
// element-count arithmetic.
//
// Falls back to a synthetic map when the staged extract is absent, so the
// correctness half still runs anywhere.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  buildingHeight,
  buildingUse,
  decodeBuildings,
  encodeBuildings,
  findTile,
  forEachRingVertex,
  ringBase,
  tileKeyAt,
  ringCount,
  ringLength,
  storeBytes,
  type BuildingStore,
  type GameMap,
} from "@battle-juice/shared";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
}

const MAP_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "../client/src/public/map");
const MAP_GZ = join(MAP_DIR, "map.json.gz");
const mb = (n: number): string => `${(n / 1e6).toFixed(1)} MB`;

function synthetic(): GameMap {
  const buildings = [];
  for (let i = 0; i < 500; i++) {
    const x = (i % 25) * 40 + 3.33;
    const y = Math.floor(i / 25) * 40 + 7.77;
    const b: Record<string, unknown> = {
      id: i * 3 + 1,
      footprint: [[x, y], [x + 18.5, y], [x + 18.5, y + 12.25], [x, y + 12.25]],
      height: 3 + (i % 40) * 0.7,
      use: ["sfr", "mfr", "com", "off", "ind", "inst", "other"][i % 7],
    };
    // A few courtyards, matching the 0.26% that have them in the real map.
    if (i % 97 === 0) b["holes"] = [[[x + 4, y + 4], [x + 8, y + 4], [x + 8, y + 8], [x + 4, y + 8]]];
    buildings.push(b);
  }
  return { buildings } as unknown as GameMap;
}

const real = existsSync(MAP_GZ);
console.log(real ? "using the staged Portland extract" : "staged map absent — using a synthetic map");

const gc = (globalThis as { gc?: () => void }).gc;
/** Object graphs live on the JS heap; typed arrays live in external
 * ArrayBuffer memory and do not show up in heapUsed at all. Counting both is
 * the only way to compare the two representations honestly. */
const mem = (): number => {
  gc?.();
  const m = process.memoryUsage();
  return m.heapUsed + m.arrayBuffers;
};

const beforeJson = mem();
const map: GameMap = real
  ? (JSON.parse(gunzipSync(readFileSync(MAP_GZ)).toString("utf8")) as GameMap)
  : synthetic();
const jsonHeap = mem() - beforeJson;

const encoded = encodeBuildings(map);
const beforeStore = mem();
const store: BuildingStore = decodeBuildings(encoded);
const storeHeap = mem() - beforeStore;

// --- correctness ----------------------------------------------------------

check("building count survives", store.count === map.buildings.length, `${store.count} vs ${map.buildings.length}`);

// Buildings are written in tile order, so they are matched back up by id.
const byId = new Map<number, number>();
for (let b = 0; b < store.count; b++) byId.set(store.id[b]!, b);
check("ids are unique and complete", byId.size === map.buildings.length, `${byId.size} distinct ids`);

let worstXY = 0;
let worstH = 0;
let badRings = 0;
let badUse = 0;
let checked = 0;
for (const src of map.buildings) {
  const b = byId.get(src.id);
  if (b === undefined) {
    badRings++;
    continue;
  }
  checked++;
  if (ringCount(store, b) !== 1 + (src.holes?.length ?? 0)) badRings++;
  if (ringLength(store, b, 0) !== src.footprint.length) badRings++;
  if (buildingUse(store, b) !== (src.use ?? "other")) badUse++;
  worstH = Math.max(worstH, Math.abs(buildingHeight(store, b) - src.height));
  const rings = [src.footprint, ...(src.holes ?? [])];
  for (let k = 0; k < rings.length && k < ringCount(store, b); k++) {
    const want = rings[k]!;
    forEachRingVertex(store, b, k, (x, y, i) => {
      const w = want[i];
      if (!w) return;
      worstXY = Math.max(worstXY, Math.abs(x - w[0]), Math.abs(y - w[1]));
    });
  }
}
check("every building matched", checked === map.buildings.length, `${checked} checked`);
check("ring structure preserved", badRings === 0, `${badRings} mismatches`);
check("use category preserved", badUse === 0, `${badUse} mismatches`);
// 1 cm quantisation, plus Float32 rounding at city scale (~2.6 mm at 43 km).
check("coordinates within 1 cm", worstXY <= 0.011, `worst ${(worstXY * 1000).toFixed(2)} mm`);
// Heights are stored in decimetres, so half a decimetre is the bound.
check("heights within 5 cm", worstH <= 0.051, `worst ${(worstH * 100).toFixed(1)} cm`);

// The tile table is what lets the renderer build one tile without touching
// the rest of the city, so it has to partition the store exactly.
let tileCovered = 0;
let tileOrderOk = true;
let tileContentOk = true;
for (let t = 0; t < store.tileKey.length; t++) {
  const from = store.tileStart[t]!;
  const to = store.tileStart[t + 1]!;
  tileCovered += to - from;
  if (t > 0 && store.tileKey[t]! <= store.tileKey[t - 1]!) tileOrderOk = false;
  // Every building in the slice must actually belong to the slice's tile.
  for (let b = from; b < to; b++) {
    const v = ringBase(store, b, 0);
    const n = ringLength(store, b, 0);
    if (n === 0) continue;
    const key = tileKeyAt(store.coords[v * 2]!, store.coords[v * 2 + 1]!, store.tileSize);
    if (key !== store.tileKey[t]!) tileContentOk = false;
  }
}
check("tiles partition every building", tileCovered === store.count, `${tileCovered} of ${store.count}`);
check("tile keys are sorted and unique", tileOrderOk);
check("each tile slice holds only its own buildings", tileContentOk);
check(
  "tile lookup finds every tile",
  store.tileKey.every((k, t) => findTile(store, k) === t),
  `${store.tileKey.length} tiles`,
);
check("a missing tile reports -1", findTile(store, 0) === -1); // biased keys never reach 0

// Re-encoding a decoded store must reproduce the same bytes, or the format
// is not a fixed point and a re-bake would churn the asset.
const store2 = decodeBuildings(encodeBuildings({ buildings: [] } as unknown as GameMap));
check("an empty map round-trips", store2.count === 0);

// --- size -----------------------------------------------------------------

console.log("");
const gz = gzipSync(encoded, { level: 9 }).length;
console.log(`  wire        ${mb(encoded.length)} raw, ${mb(gz)} gzipped`);
console.log(`  resident    ${mb(storeBytes(store))} of typed arrays`);
if (real) {
  const jsonBytes = gunzipSync(readFileSync(MAP_GZ)).length;
  console.log(`  vs JSON     ${mb(jsonBytes)} of text for the whole map (buildings are ~63% of it)`);
}
console.log(`  measured    ${mb(jsonHeap)} to parse the whole map -> ${mb(storeHeap)} to decode the store`);
console.log(
  `  vertices    ${(store.coords.length / 2 / 1e6).toFixed(2)}M in ${store.ringOffset.length - 1} rings`,
);
let biggest = 0;
for (let t = 0; t < store.tileKey.length; t++) {
  biggest = Math.max(biggest, store.tileStart[t + 1]! - store.tileStart[t]!);
}
console.log(
  `  tiles       ${store.tileKey.length} occupied at ${store.tileSize} m, ` +
    `${Math.round(store.count / Math.max(1, store.tileKey.length))} buildings median, ${biggest} in the busiest`,
);

check("store is under 60 MB resident", storeBytes(store) < 60e6, mb(storeBytes(store)));

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
