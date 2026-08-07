// The flat buildCityModel must equal the readable one, building for building.
//
//   npx tsx --max-old-space-size=10240 scripts/test-citymodel.ts
//
// buildCityModel was rewritten against the store's typed arrays to get it off
// the phone's critical path. It decides where every prism's base sits and
// where the fire sim thinks each building is, so "close enough" is not a
// standard it can be held to — this runs the original formulation, expressed
// through ringLength/forEachRingVertex/heightAt, over all 538k buildings and
// demands exact equality.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  decodeBuildings,
  decodeHeightfield,
  forEachRingVertex,
  heightAt,
  ringLength,
  type BuildingStore,
  type Heightfield,
} from "@portlandoregon/shared";
import { buildCityModel, type CityModel } from "../client/src/city.js";

const MAP_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "../client/src/public/map");
const toBuf = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

/** The original, unoptimized formulation — kept here as the specification. */
function reference(store: BuildingStore, hf: Heightfield | null): CityModel {
  const ground = hf ? (x: number, y: number): number => heightAt(hf, x, y) : (): number => 0;
  const n = store.count;
  const city: CityModel = {
    valid: new Uint8Array(n),
    baseZ: new Float32Array(n),
    cx: new Float32Array(n),
    cy: new Float32Array(n),
  };
  for (let bi = 0; bi < n; bi++) {
    const len = ringLength(store, bi, 0);
    let base = Infinity;
    let cx = 0;
    let cy = 0;
    forEachRingVertex(store, bi, 0, (vx, vy) => {
      base = Math.min(base, ground(vx, vy));
      cx += vx;
      cy += vy;
    });
    city.baseZ[bi] = (Number.isFinite(base) ? base : 0) - 1;
    if (len < 3) continue;
    city.valid[bi] = 1;
    city.cx[bi] = cx / len;
    city.cy[bi] = cy / len;
  }
  return city;
}

const store = decodeBuildings(gunzipSync(readFileSync(join(MAP_DIR, "buildings.bin.gz"))));
let hf: Heightfield | null = null;
try {
  hf = decodeHeightfield(toBuf(gunzipSync(readFileSync(join(MAP_DIR, "heightmap.bin.gz")))));
} catch {
  hf = null;
}

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function compare(label: string, terrain: Heightfield | null): void {
  const t0 = performance.now();
  const want = reference(store, terrain);
  const refMs = performance.now() - t0;
  const t1 = performance.now();
  const got = buildCityModel(store, terrain);
  const ms = performance.now() - t1;

  let bad = 0;
  let worst = 0;
  let worstAt = -1;
  for (let bi = 0; bi < store.count; bi++) {
    if (got.valid[bi] !== want.valid[bi]) bad++;
    for (const [a, b] of [
      [got.baseZ[bi]!, want.baseZ[bi]!],
      [got.cx[bi]!, want.cx[bi]!],
      [got.cy[bi]!, want.cy[bi]!],
    ]) {
      const d = Math.abs(a - b);
      if (d > worst) {
        worst = d;
        worstAt = bi;
      }
    }
  }
  check(`${label}: valid matches`, bad === 0, `${bad} differ`);
  check(`${label}: baseZ/cx/cy match exactly`, worst === 0, `worst ${worst} at building ${worstAt}`);
  console.log(`       reference ${refMs.toFixed(0)} ms, flat ${ms.toFixed(0)} ms (${(refMs / ms).toFixed(1)}x)`);
}

console.log(`buildCityModel over ${store.count} buildings`);
compare("with terrain", hf);
compare("flat ground", null);

console.log(failures ? `\n${failures} failed` : "\nall checks passed");
process.exitCode = failures ? 1 : 0;
