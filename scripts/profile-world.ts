// Headless harness for the slowest thing in the client: buildWorld.
//
// A cold load spends ~95% of its time here, and profiling it in a browser is
// painful because the main thread is pinned throughout. THREE builds
// BufferGeometry perfectly well in Node — no renderer is constructed — so the
// hot loops can be measured directly:
//
//   npx tsx scripts/profile-world.ts                  # just the timings
//   node --cpu-prof --cpu-prof-dir=/tmp/prof \
//     --import tsx scripts/profile-world.ts           # + a .cpuprofile
//
// Reads the artefacts baked by scripts/stage-map.sh, and reports memory at
// each step: this is the closest thing to a browser boot that runs headlessly,
// and it is how Stage 1's claim gets checked end to end.
//
// Typed arrays live in external ArrayBuffer memory, not the JS heap, so both
// are counted — heapUsed alone would make the binary store look free.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  decodeBuildings,
  decodeHeightfield,
  decodeProps,
  findTile,
  storeBytes,
  tileKeyAt,
  type BuildingStore,
  type GameMap,
  type Heightfield,
} from "@battle-juice/shared";
import { buildCityModel } from "../client/src/city.js";
import { buildWorld } from "../client/src/render/world.js";

const MAP_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "../client/src/public/map");

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

const mb = (n: number): string => `${(n / 1e6).toFixed(0)} MB`;
const gc = (globalThis as { gc?: () => void }).gc;
function mem(): number {
  gc?.();
  const m = process.memoryUsage();
  return m.heapUsed + m.arrayBuffers;
}

let last = 0;
function step(label: string, startedAt: number): void {
  const now = mem();
  console.log(
    `  ${label.padEnd(24)} ${secs(performance.now() - startedAt).padStart(7)}` +
      `   ${mb(now).padStart(8)} live  (${now >= last ? "+" : ""}${mb(now - last)})`,
  );
  last = now;
}

/** gunzipSync returns a Buffer view; decodeHeightfield wants a clean ArrayBuffer. */
function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

last = mem();
console.log("step                         time     memory");
console.log("-".repeat(60));

let t = performance.now();
const map = JSON.parse(gunzipSync(readFileSync(join(MAP_DIR, "map-lite.json.gz"))).toString("utf8")) as GameMap;
map.buildings = [];
step("parse map-lite.json.gz", t);

t = performance.now();
const buildings: BuildingStore = decodeBuildings(gunzipSync(readFileSync(join(MAP_DIR, "buildings.bin.gz"))));
step("decode buildings.bin.gz", t);

t = performance.now();
const props = decodeProps(gunzipSync(readFileSync(join(MAP_DIR, "props.bin.gz"))));
step("decode props.bin.gz", t);

let hf: Heightfield | null = null;
t = performance.now();
try {
  hf = decodeHeightfield(toArrayBuffer(gunzipSync(readFileSync(join(MAP_DIR, "heightmap.bin.gz")))));
} catch {
  hf = null;
}
step("decode heightmap", t);

t = performance.now();
const city = buildCityModel(buildings, hf);
step("city model", t);

// What the client now does at boot: everything EXCEPT building geometry,
// which the renderer streams around the camera.
t = performance.now();
const world = buildWorld(map, buildings, hf, city, false);
step("buildWorld (streamed)", t);

// One 5x5 window, the state the first frame actually renders.
t = performance.now();
const centre = { x: map.meta.width / 2, y: map.meta.height / 2 };
const want: number[] = [];
for (let dy = -2; dy <= 2; dy++) {
  for (let dx = -2; dx <= 2; dx++) {
    const tt = findTile(buildings, tileKeyAt(centre.x + dx * buildings.tileSize, centre.y + dy * buildings.tileSize, buildings.tileSize));
    if (tt >= 0) want.push(tt);
  }
}
world.buildings.sync(want);
step("5x5 building tiles", t);
t = performance.now();
world.detailTiles.sync(want.map((tt) => buildings.tileKey[tt]!));
step("5x5 dressing tiles", t);
console.log(
  `  ${" ".repeat(24)}         buildings ${world.buildings.stats().tiles} tiles / ` +
    `${(world.buildings.stats().verts / 1e6).toFixed(2)}M verts, dressing ` +
    `${world.detailTiles.stats().tiles} tiles / ${(world.detailTiles.stats().verts / 1e6).toFixed(2)}M verts`,
);

// For comparison, the old behaviour.
t = performance.now();
world.buildings.buildAll();
step("...if built whole (old)", t);

console.log(
  `\n  ${buildings.count} buildings, ${map.edges?.length ?? 0} street edges, ` +
    `heightfield ${hf ? `${hf.cols}x${hf.rows}` : "none"}`,
);
console.log(`  building store: ${mb(storeBytes(buildings))} resident, ${props.count} props`);
console.log(`  peak RSS:       ${mb(process.memoryUsage().rss)}`);
