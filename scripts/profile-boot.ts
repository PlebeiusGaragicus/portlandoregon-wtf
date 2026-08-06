// Per-step boot timings — which steps stand between a cold start and a frame?
//
//   npx tsx --expose-gc --max-old-space-size=10240 scripts/profile-boot.ts
//
// profile-world.ts reports buildWorld as one number. Progressive boot needs
// the breakdown: everything before the first frame must be small, and every
// step after it must be small ENOUGH to drain inside a frame budget without
// stuttering. This pumps the generator and times each yielded step.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  decodeBuildings,
  decodeHeightfield,
  decodeLayers,
  decodeProps,
  type GameMap,
  type Heightfield,
} from "@battle-juice/shared";
import { buildCityModel } from "../client/src/city.js";
import { beginWorld } from "../client/src/render/world.js";
import { buildProps } from "../client/src/render/props.js";
import { buildLandmarks } from "../client/src/render/landmarks.js";
import { FireSim } from "../client/src/render/fire.js";

// buildProps bakes a radial-glow texture through a 2D canvas. Headless has no
// document; the texture's contents never affect the timings we want.
(globalThis as Record<string, unknown>)["document"] = {
  createElement: () => ({
    width: 0,
    height: 0,
    getContext: () => ({
      createRadialGradient: () => ({ addColorStop(): void {} }),
      measureText: () => ({ width: 10 }),
      fillRect(): void {},
      fillText(): void {},
      beginPath(): void {},
      moveTo(): void {},
      lineTo(): void {},
      arcTo(): void {},
      arc(): void {},
      save(): void {},
      restore(): void {},
      translate(): void {},
      rotate(): void {},
      scale(): void {},
      clearRect(): void {},
      quadraticCurveTo(): void {},
      bezierCurveTo(): void {},
      ellipse(): void {},
      createLinearGradient: () => ({ addColorStop(): void {} }),
      set globalAlpha(_v: unknown) {},
      set globalCompositeOperation(_v: unknown) {},
      set shadowBlur(_v: unknown) {},
      set shadowColor(_v: unknown) {},
      set filter(_v: unknown) {},
      closePath(): void {},
      fill(): void {},
      stroke(): void {},
      set fillStyle(_v: unknown) {},
      set strokeStyle(_v: unknown) {},
      set font(_v: unknown) {},
      set lineWidth(_v: unknown) {},
      set textAlign(_v: unknown) {},
      set textBaseline(_v: unknown) {},
    }),
  }),
};

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
map.buildings = [];
const buildings = decodeBuildings(gunzipSync(readFileSync(join(MAP_DIR, "buildings.bin.gz"))));
const layers = decodeLayers(gunzipSync(readFileSync(join(MAP_DIR, "layers.bin.gz"))));
let hf: Heightfield | null = null;
try {
  hf = decodeHeightfield(toBuf(gunzipSync(readFileSync(join(MAP_DIR, "heightmap.bin.gz")))));
} catch {
  hf = null;
}

let before = mem();
let t = performance.now();
const city = buildCityModel(buildings, hf);
console.log("  step                                        time     delta");
console.log("  " + "-".repeat(62));
const row = (label: string, ms: number, d: number): void =>
  console.log(`  ${label.padEnd(40)} ${`${ms.toFixed(0)} ms`.padStart(8)}  ${mb(d).padStart(8)}`);
row("city model", performance.now() - t, mem() - before);

const t1 = performance.now();
const { world, steps } = beginWorld(map, buildings, layers, hf, city);
row("beginWorld (skeleton)", performance.now() - t1, mem() - before);

// Slice timings are the whole point: the renderer draws a frame between each
// one, so the WORST slice is the longest the camera can stall.
const phases = new Map<string, { n: number; ms: number; max: number }>();
let worst = 0;
let worstPhase = "";
total = 0;
for (;;) {
  const t2 = performance.now();
  const r = steps.next();
  const ms = performance.now() - t2;
  if (r.done) break;
  total += ms;
  const p = phases.get(r.value) ?? { n: 0, ms: 0, max: 0 };
  p.n++;
  p.ms += ms;
  if (ms > p.max) p.max = ms;
  phases.set(r.value, p);
  if (ms > worst) {
    worst = ms;
    worstPhase = r.value;
  }
}
console.log("");
for (const [name, p] of phases) {
  console.log(
    `  ${name.padEnd(20)} ${String(p.n).padStart(5)} slices  ${`${p.ms.toFixed(0)} ms`.padStart(8)} total  ` +
      `${`${(p.ms / p.n).toFixed(1)} ms`.padStart(8)} avg  ${`${p.max.toFixed(0)} ms`.padStart(7)} worst`,
  );
}
console.log(`\n  fill total ${(total / 1000).toFixed(2)}s, worst slice ${worst.toFixed(0)} ms (${worstPhase})`);

// Everything else main.ts does before the first frame can be drawn.
before = mem();
t = performance.now();
const propStore = decodeProps(gunzipSync(readFileSync(join(MAP_DIR, "props.bin.gz"))));
const props = buildProps(map, propStore, hf);
row("buildProps", performance.now() - t, mem() - before);
before = mem();
t = performance.now();
buildLandmarks(map, buildings, hf);
row("buildLandmarks", performance.now() - t, mem() - before);
before = mem();
t = performance.now();
const fire = new FireSim(map, buildings, propStore, hf, city, world.shells);
row("new FireSim", performance.now() - t, mem() - before);
void fire;
