// What would baking the city model into the format actually cost?
//
//   npx tsx --max-old-space-size=10240 scripts/measure-citybake.ts
//
// The plan was to freeze baseZ/valid/centroids into buildings.bin so the
// client stops deriving them. That trades download bytes for phone CPU, and
// which way the trade goes is a measurement, not an opinion: the whole point
// of the format work was getting the download DOWN.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { decodeBuildings, decodeHeightfield, type Heightfield } from "@battle-juice/shared";
import { buildCityModel } from "../client/src/city.js";

const MAP_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "../client/src/public/map");
const toBuf = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const kb = (n: number): string => `${(n / 1e3).toFixed(0)} kB`;

const store = decodeBuildings(gunzipSync(readFileSync(join(MAP_DIR, "buildings.bin.gz"))));
let hf: Heightfield | null = null;
try {
  hf = decodeHeightfield(toBuf(gunzipSync(readFileSync(join(MAP_DIR, "heightmap.bin.gz")))));
} catch {
  hf = null;
}

const t0 = performance.now();
const city = buildCityModel(store, hf);
const ms = performance.now() - t0;
const n = store.count;

const gz = (a: ArrayBufferView): number =>
  gzipSync(Buffer.from(a.buffer as ArrayBuffer, a.byteOffset, a.byteLength), { level: 9 }).length;

// Raw, and quantized the way a real format would store them: centroids as
// tile-local decimetres, base elevation as decimetres above sea level.
const cxQ = new Uint16Array(n);
const cyQ = new Uint16Array(n);
const bzQ = new Uint16Array(n);
for (let bi = 0; bi < n; bi++) {
  cxQ[bi] = Math.min(65535, Math.max(0, Math.round((city.cx[bi]! % store.tileSize) * 10)));
  cyQ[bi] = Math.min(65535, Math.max(0, Math.round((city.cy[bi]! % store.tileSize) * 10)));
  bzQ[bi] = Math.min(65535, Math.max(0, Math.round((city.baseZ[bi]! + 100) * 10)));
}

console.log(`  ${n} buildings, buildCityModel ${ms.toFixed(0)} ms\n`);
console.log(`  field        raw          gzipped`);
console.log(`  ${"-".repeat(40)}`);
const rows: [string, ArrayBufferView][] = [
  ["valid", city.valid],
  ["baseZ f32", city.baseZ],
  ["baseZ u16", bzQ],
  ["cx f32", city.cx],
  ["cx u16", cxQ],
  ["cy f32", city.cy],
  ["cy u16", cyQ],
];
for (const [name, a] of rows) {
  console.log(`  ${name.padEnd(12)} ${kb(a.byteLength).padStart(8)} ${kb(gz(a)).padStart(12)}`);
}
const quantized = gz(city.valid) + gz(bzQ) + gz(cxQ) + gz(cyQ);
const current = readFileSync(join(MAP_DIR, "buildings.bin.gz")).length;
const download =
  current +
  readFileSync(join(MAP_DIR, "props.bin.gz")).length +
  readFileSync(join(MAP_DIR, "layers.bin.gz")).length +
  readFileSync(join(MAP_DIR, "map-lite.json.gz")).length;
console.log(
  `\n  quantized total ${kb(quantized)} gzipped` +
    `\n  buildings.bin.gz is ${kb(current)}; whole download is ${(download / 1e6).toFixed(1)} MB` +
    `\n  => +${((quantized / download) * 100).toFixed(1)}% download to save ${ms.toFixed(0)} ms of laptop CPU`,
);
