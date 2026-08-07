// Prop streaming owns per-tile InstancedMesh buffers but shares primitive
// geometry across every tile. Eviction must dispose the former and preserve
// the latter until the whole PropLayers object is destroyed.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import * as THREE from "three";
import { decodeHeightfield, decodeProps, tileKeyAt, type Heightfield } from "@portlandoregon/shared";
import { buildProps } from "../client/src/render/props.js";

(globalThis as Record<string, unknown>)["document"] = {
  createElement: () => ({
    width: 0,
    height: 0,
    getContext: () => new Proxy({}, { get: () => () => ({ addColorStop(): void {} }) }),
  }),
};

const mapDir = join(fileURLToPath(new URL(".", import.meta.url)), "../client/src/public/map");
const propsStore = decodeProps(gunzipSync(readFileSync(join(mapDir, "props.bin.gz"))));
const toBuffer = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
let heightfield: Heightfield | null = null;
try {
  heightfield = decodeHeightfield(toBuffer(gunzipSync(readFileSync(join(mapDir, "heightmap.bin.gz")))));
} catch {
  heightfield = null;
}

let instanceDisposals = 0;
let geometryDisposals = 0;
const originalInstanceDispose = THREE.InstancedMesh.prototype.dispose;
const originalGeometryDispose = THREE.BufferGeometry.prototype.dispose;
THREE.InstancedMesh.prototype.dispose = function (): void {
  instanceDisposals++;
  originalInstanceDispose.call(this);
};
THREE.BufferGeometry.prototype.dispose = function (): void {
  geometryDisposals++;
  originalGeometryDispose.call(this);
};

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

try {
  const props = buildProps({} as never, propsStore, heightfield);
  const want: number[] = [];
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) want.push(tileKeyAt(11_000 + dx * 1000, 21_000 + dy * 1000, 1000));
  }

  props.sync(want);
  const first = props.stats();
  check("a prop window was built", first.tiles > 0 && first.instances > 65_868, `${first.tiles} tiles`);

  const geometryBeforeEvict = geometryDisposals;
  props.sync([]);
  check("tile instance buffers are disposed", instanceDisposals > 0, `${instanceDisposals} meshes`);
  check("shared geometry survives tile eviction", geometryDisposals === geometryBeforeEvict, `${geometryDisposals} disposals`);
  check("only city glow remains after eviction", props.stats().tiles === 0);

  props.sync(want);
  check("evicted tiles rebuild", props.stats().tiles === first.tiles, `${props.stats().tiles} tiles`);
  props.dispose();
  check("shared geometry disposes with the layer", geometryDisposals > geometryBeforeEvict);
  check("complete disposal clears live tiles", props.stats().tiles === 0);
} finally {
  THREE.InstancedMesh.prototype.dispose = originalInstanceDispose;
  THREE.BufferGeometry.prototype.dispose = originalGeometryDispose;
}

console.log(failures ? `\n${failures} failed` : "\nall checks passed");
process.exitCode = failures ? 1 : 0;
