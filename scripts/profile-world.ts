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
// Reads the map staged by scripts/stage-map.sh.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { decodeHeightfield, type GameMap, type Heightfield } from "@battle-juice/shared";
import { buildWorld } from "../client/src/render/world.js";

const MAP_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "../client/src/public/map");

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

/** gunzipSync returns a Buffer view; decodeHeightfield wants a clean ArrayBuffer. */
function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

const t0 = performance.now();
const map = JSON.parse(gunzipSync(readFileSync(join(MAP_DIR, "map.json.gz"))).toString("utf8")) as GameMap;
let hf: Heightfield | null = null;
try {
  hf = decodeHeightfield(toArrayBuffer(gunzipSync(readFileSync(join(MAP_DIR, "heightmap.bin.gz")))));
} catch {
  hf = null;
}
console.log(`load + parse: ${secs(performance.now() - t0)}`);
console.log(
  `map: ${map.buildings?.length ?? 0} buildings, ${map.edges?.length ?? 0} street edges, ` +
    `heightfield ${hf ? `${hf.cols}×${hf.rows}` : "none"}`,
);

const t1 = performance.now();
buildWorld(map, hf);
console.log(`buildWorld: ${secs(performance.now() - t1)}`);
