// What does streamed building geometry actually cost?
//
//   npx tsx --expose-gc --max-old-space-size=10240 scripts/profile-tiles.ts
//
// The whole-city build peaks near 2.6 GB and takes ~12 s, which is what kills
// a phone — it dies in JavaScript before the first frame. Tiling is supposed
// to make resident geometry a function of the view radius rather than the
// size of the city. This measures whether it does, and checks that a streamed
// city is the SAME city: every tile built separately must add up to exactly
// what buildAll produces.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import * as THREE from "three";
import {
  decodeBuildings,
  decodeHeightfield,
  findTile,
  latLonToWorld,
  tileKeyAt,
  type GameMap,
  type Heightfield,
} from "@portlandoregon/shared";
import { buildCityModel } from "../client/src/city.js";
import { createBuildingTiles } from "../client/src/render/world.js";

const MAP_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "../client/src/public/map");
const toBuf = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const mb = (n: number): string => `${(n / 1e6).toFixed(0)} MB`;
const gc = (globalThis as { gc?: () => void }).gc;
function mem(): number {
  gc?.();
  const m = process.memoryUsage();
  return m.heapUsed + m.arrayBuffers;
}

const map = JSON.parse(gunzipSync(readFileSync(join(MAP_DIR, "map-lite.json.gz"))).toString("utf8")) as GameMap;
const store = decodeBuildings(gunzipSync(readFileSync(join(MAP_DIR, "buildings.bin.gz"))));
let hf: Heightfield | null = null;
try {
  hf = decodeHeightfield(toBuf(gunzipSync(readFileSync(join(MAP_DIR, "heightmap.bin.gz")))));
} catch {
  hf = null;
}
const city = buildCityModel(store, hf);
const landmarks = new Map<number, "fire-station" | "police" | "hospital" | "city-hall" | "school">();
for (const m of map.landmarks ?? []) for (const id of m.buildingIds ?? []) landmarks.set(id, m.kind);

/** Tile indices within `radius` tiles of a world position. */
function window(x: number, y: number, radius: number): number[] {
  const out: number[] = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const t = findTile(store, tileKeyAt(x + dx * store.tileSize, y + dy * store.tileSize, store.tileSize));
      if (t >= 0) out.push(t);
    }
  }
  return out;
}

const downtown = latLonToWorld(map.meta, { lat: 45.5203, lon: -122.6765 });
const east = latLonToWorld(map.meta, { lat: 45.5155, lon: -122.6125 });

console.log(`store: ${store.count} buildings in ${store.tileKey.length} tiles of ${store.tileSize} m\n`);
console.log("radius   tiles   buildings      verts    geometry     build");
console.log("-".repeat(64));

// The far tier on its own: every building in the city, always resident.
const beforeFar = mem();
const farOnly = createBuildingTiles(store, landmarks, city);
const farMs = performance.now();
console.log(
  `   far  ${String(store.tileKey.length).padStart(6)} ${String(store.count).padStart(11)}` +
    ` ${"boxes".padStart(10)} ${mb(mem() - beforeFar).padStart(11)}` +
    `   whole city, 1 draw call`,
);
void farMs;
farOnly.sync([]);

// Prism cost is measured against a tile set that already has its far tier, so
// the column is the cost of UPGRADING that window to full geometry.
for (const radius of [1, 2, 3, 5]) {
  const tiles = createBuildingTiles(store, landmarks, city);
  const withFar = mem();
  const keys = window(downtown.x, downtown.y, radius);
  const t0 = performance.now();
  const { built } = tiles.sync(keys);
  const ms = performance.now() - t0;
  const n = built.reduce((a, [f, t]) => a + (t - f), 0);
  const { tiles: live, verts } = tiles.stats();
  console.log(
    `${`${radius * 2 + 1}x${radius * 2 + 1}`.padStart(6)} ${String(live).padStart(7)} ${String(n).padStart(11)}` +
      ` ${(verts / 1e6).toFixed(2).padStart(9)}M ${mb(mem() - withFar).padStart(11)} ${`${ms.toFixed(0)} ms`.padStart(9)}` +
      `   prisms on top of the boxes`,
  );
  tiles.sync([]);
}

// The two tiers must never both draw a building, or they z-fight.
{
  const tiles = createBuildingTiles(store, landmarks, city);
  const keys = window(downtown.x, downtown.y, 2);
  tiles.sync(keys);
  const m = new THREE.Matrix4();
  let visible = 0;
  for (let bi = 0; bi < store.count; bi++) {
    tiles.far.getMatrixAt(bi, m);
    if (m.elements[0] !== 0 || m.elements[5] !== 0 || m.elements[10] !== 0) visible++;
  }
  const upgraded = keys.reduce((a, t) => a + (store.tileStart[t + 1]! - store.tileStart[t]!), 0);
  let degenerate = 0;
  for (let bi = 0; bi < store.count; bi++) if (!city.valid[bi]) degenerate++;
  console.log(
    `\n  boxes drawn ${visible}, prisms drawn ${upgraded}, degenerate ${degenerate}` +
      ` — ${visible + upgraded + degenerate === store.count ? "every building drawn exactly once" : "OVERLAP"}`,
  );
  tiles.sync([]);
}

// --- panning --------------------------------------------------------------
// The cost that matters in motion is the DELTA, not the window.
const tiles = createBuildingTiles(store, landmarks, city);
tiles.sync(window(downtown.x, downtown.y, 2));
let worst = 0;
let totalBuilt = 0;
for (let step = 1; step <= 12; step++) {
  const x = downtown.x + step * store.tileSize;
  const t0 = performance.now();
  const { built, evicted } = tiles.sync(window(x, downtown.y, 2));
  const ms = performance.now() - t0;
  worst = Math.max(worst, ms);
  totalBuilt += built.length;
  if (step <= 3) console.log(`\n  pan ${step} km east: +${built.length} tiles, -${evicted}, ${ms.toFixed(0)} ms`);
}
console.log(`  ...12 km of panning: ${totalBuilt} tiles built, worst step ${worst.toFixed(0)} ms`);

// --- the city has to still be the whole city ------------------------------
// Every tile built on its own must sum to exactly the monolithic build.
const streamed = createBuildingTiles(store, landmarks, city);
let sum = 0;
for (let t = 0; t < store.tileKey.length; t++) {
  streamed.sync([t]);
  sum += streamed.stats().verts;
}
streamed.sync([]);
const whole = createBuildingTiles(store, landmarks, city);
whole.buildAll();
const all = whole.stats().verts;
console.log(
  `\n  tile-by-tile total ${(sum / 1e6).toFixed(3)}M verts vs buildAll ${(all / 1e6).toFixed(3)}M — ` +
    (sum === all ? "identical" : `MISMATCH of ${all - sum}`),
);

// Eviction has to actually give the memory back, or streaming just delays the
// crash instead of preventing it. Measured on its own tile set so nothing
// else in this script is holding geometry at the same time.
const solo = createBuildingTiles(store, landmarks, city);
const before = mem();
solo.buildAll();
const full = mem();
solo.sync([]);
gc?.();
gc?.();
const after = mem();
console.log(
  `\n  whole city resident: ${mb(full - before)} of geometry` +
    `\n  after evicting it:   ${mb(after - before)} still held` +
    `\n  scene children left: ${(solo as unknown as { group: THREE.Group }).group.children.length}` +
    " (the far tier, which is meant to stay)",
);
