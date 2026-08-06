// Buildings, dressing and props must share ONE tile key space.
//
//   npx tsx --max-old-space-size=10240 scripts/test-tilekeys.ts
//
// The renderer streams three layers from three different providers, and it
// asks all of them with the same key: tileKeyAt(x, y, 1000). Nothing checked
// that they agreed. props.ts keyed its own tiles as row*4096+col without the
// bias tileKeyAt carries, so no key the renderer produced ever matched a key
// props.ts held — sync() built nothing, every frame, silently, and the city
// lost every tree, sign and hydrant.
//
// A mismatch is invisible in isolation: each side is internally consistent and
// each has passing tests. Only asking one side a question in the other's
// language finds it, which is what this does.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import * as THREE from "three";

// buildProps bakes a glow texture through a 2D canvas.
(globalThis as Record<string, unknown>)["document"] = {
  createElement: () => ({
    width: 0,
    height: 0,
    getContext: () => new Proxy({}, { get: () => () => ({ addColorStop(): void {} }) }),
  }),
};

import {
  decodeBuildings,
  decodeHeightfield,
  decodeLayers,
  decodeProps,
  findTile,
  tileKeyAt,
  type GameMap,
  type Heightfield,
} from "@battle-juice/shared";
import { buildCityModel } from "../client/src/city.js";
import { buildProps } from "../client/src/render/props.js";
import { beginWorld } from "../client/src/render/world.js";

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
const propStore = decodeProps(gunzipSync(readFileSync(join(MAP_DIR, "props.bin.gz"))));
let hf: Heightfield | null = null;
try {
  hf = decodeHeightfield(toBuf(gunzipSync(readFileSync(join(MAP_DIR, "heightmap.bin.gz")))));
} catch {
  hf = null;
}

const TS = buildings.tileSize;
check("the building store tiles at 1 km", TS === 1000, `${TS} m`);

// The key every provider is asked with, derived exactly as the renderer does.
function want(cx: number, cy: number, r: number): number[] {
  const keys: number[] = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) keys.push(tileKeyAt(cx + dx * TS, cy + dy * TS, TS));
  }
  return keys;
}

const city = buildCityModel(buildings, hf);
const { world, steps } = beginWorld(map, buildings, layers, hf, city);
for (const _ of steps) void _;
const props = buildProps(map, propStore, hf);

// Downtown, where all three layers are dense.
const KEYS = want(11_000, 21_000, 2);

// Props: does a key the renderer would send actually build anything?
const changed = props.sync(KEYS);
let instances = 0;
for (const root of [props.group, props.glow]) {
  root.traverse((o) => {
    if (o instanceof THREE.InstancedMesh) instances += o.count;
  });
}
check("props answer the renderer's keys", changed && instances > 0, `${instances} instances built`);

// Dressing: same question.
world.detailTiles.sync(KEYS);
check("dressing answers the renderer's keys", world.detailTiles.stats().tiles > 0, `${world.detailTiles.stats().tiles} tiles`);

// Buildings: the store is looked up by index rather than by key, but the key
// has to resolve.
const found = KEYS.filter((k) => findTile(buildings, k) >= 0);
check("buildings answer the renderer's keys", found.length > 0, `${found.length} of ${KEYS.length} tiles exist`);

// Every prop must live in a tile the renderer can ask for. A prop keyed into
// a tile no window ever names is a prop that never draws.
const reachable = new Set(KEYS);
let inWindow = 0;
for (let i = 0; i < propStore.count; i++) {
  if (reachable.has(tileKeyAt(propStore.x[i]!, propStore.y[i]!, TS))) inWindow++;
}
check("props fall inside the window keys that built them", inWindow > 0, `${inWindow} props in the 5x5`);

// The bias exists because the extract has coordinates just outside the map.
// Distinct tiles must stay distinct there, or two rows collide into one key.
const seen = new Map<number, string>();
let collisions = 0;
for (let ty = -1; ty <= 44; ty++) {
  for (let tx = -1; tx <= 44; tx++) {
    const k = tileKeyAt(tx * TS + 1, ty * TS + 1, TS);
    const at = `${tx},${ty}`;
    if (seen.has(k)) collisions++;
    else seen.set(k, at);
  }
}
check("keys stay unique across the negative edge", collisions === 0, `${collisions} collisions`);

console.log(failures ? `\n${failures} failed` : "\nall checks passed");
process.exitCode = failures ? 1 : 0;
