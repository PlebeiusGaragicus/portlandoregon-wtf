// The night city must stay lit when you zoom out.
//
//   npx tsx --max-old-space-size=10240 scripts/test-glow.ts
//
// Lamplight pools used to be built per tile alongside the poles, so they were
// evicted with them: zooming out dropped the prop tiles and the city went
// dark, which is the one view the glow exists for. Keeping the `glow` group
// outside `group` protected it from the zoom visibility gate but not from
// eviction — a distinction nothing tested.
//
// So: evict everything and check the light is still there.
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
  decodeProps,
  PROP_KINDS,
  tileKeyAt,
  type GameMap,
  type Heightfield,
} from "@battle-juice/shared";
import { buildProps } from "../client/src/render/props.js";

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
const store = decodeProps(gunzipSync(readFileSync(join(MAP_DIR, "props.bin.gz"))));
let hf: Heightfield | null = null;
try {
  hf = decodeHeightfield(toBuf(gunzipSync(readFileSync(join(MAP_DIR, "heightmap.bin.gz")))));
} catch {
  hf = null;
}

let lights = 0;
for (let i = 0; i < store.count; i++) if (PROP_KINDS[store.kind[i]!] === "light") lights++;

const props = buildProps(map, store, hf);
props.setNight(1);

/** Instances that would actually be rasterized under `root`. */
function drawn(root: THREE.Object3D): { meshes: number; instances: number; bytes: number } {
  let meshes = 0;
  let instances = 0;
  let bytes = 0;
  root.traverse((o) => {
    if (!(o instanceof THREE.InstancedMesh) || !o.visible) return;
    meshes++;
    instances += o.count;
    bytes += o.instanceMatrix.array.byteLength;
  });
  return { meshes, instances, bytes };
}

// Zoomed in: a window of prop tiles is resident.
const TS = buildings.tileSize;
const want: number[] = [];
for (let dy = -2; dy <= 2; dy++) {
  for (let dx = -2; dx <= 2; dx++) want.push(tileKeyAt(11_000 + dx * TS, 21_000 + dy * TS, TS));
}
props.sync(want);
const near = drawn(props.glow);
const nearProps = drawn(props.group);
check("zoomed in: lamp posts are built", nearProps.instances > 0, `${nearProps.instances} prop instances`);
check("zoomed in: every lamp in the city is lit", near.instances === lights, `${near.instances} of ${lights}`);

// Zoomed out: the renderer sends an empty window, so every prop tile is
// evicted. This is the exact state that used to go dark.
props.sync([]);
const far = drawn(props.glow);
const farProps = drawn(props.group);
check("zoomed out: lamp posts are gone", farProps.instances === 0, `${farProps.instances} prop instances left`);
check("zoomed out: the city is STILL lit", far.instances === lights, `${far.instances} of ${lights}`);
check("the glow is one draw call", far.meshes === 1, `${far.meshes} meshes`);

// Daylight still turns it off.
props.setNight(0);
check("daylight puts the lamps out", drawn(props.glow).instances === 0);
props.setNight(1);
check("night turns them back on", drawn(props.glow).instances === lights);

// And it must survive a full build/evict cycle rather than merely the first.
for (let i = 0; i < 3; i++) {
  props.sync(want);
  props.sync([]);
}
check("glow survives repeated streaming", drawn(props.glow).instances === lights, `${drawn(props.glow).instances}`);

console.log(`\n  ${lights} lamps, ${(far.bytes / 1e6).toFixed(1)} MB of matrices, always resident`);
console.log(failures ? `\n${failures} failed` : "\nall checks passed");
process.exitCode = failures ? 1 : 0;
