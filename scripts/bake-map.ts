// Bake the staged map into what the client actually downloads.
//
//   npx tsx --max-old-space-size=10240 scripts/bake-map.ts
//
// Splits map.json.gz in two:
//
//   buildings.bin.gz   538k footprints as a binary building store
//   map-lite.json.gz   everything else, still JSON for now
//
// Buildings are 63% of the map's bytes and the overwhelming majority of the
// heap it inflates to, so they move first. The remaining layers follow the
// same path later; keeping them as JSON in the meantime means the client can
// migrate one consumer at a time instead of in a single unreviewable jump.
//
// Run by stage-map.sh after staging. Safe to re-run.
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { decodeBuildings, encodeBuildings, storeBytes, type GameMap } from "@battle-juice/shared";

const MAP_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "../client/src/public/map");
const SRC = join(MAP_DIR, "map.json.gz");
const mb = (n: number): string => `${(n / 1e6).toFixed(1)} MB`;

const t0 = performance.now();
const map = JSON.parse(gunzipSync(readFileSync(SRC)).toString("utf8")) as GameMap;
console.log(`read ${SRC} (${mb(statSync(SRC).size)} gzipped) in ${((performance.now() - t0) / 1000).toFixed(1)}s`);

const bin = encodeBuildings(map);
const binGz = gzipSync(bin, { level: 9 });
writeFileSync(join(MAP_DIR, "buildings.bin.gz"), binGz);

// Everything except buildings, which the client now gets from the store.
// `undefined` drops the key entirely in JSON.stringify.
const lite = { ...map, buildings: undefined };
const liteJson = JSON.stringify(lite);
const liteGz = gzipSync(Buffer.from(liteJson, "utf8"), { level: 9 });
writeFileSync(join(MAP_DIR, "map-lite.json.gz"), liteGz);

// Prove the artefact decodes before anyone ships it — a corrupt store would
// otherwise surface as a blank city in the browser.
const check = decodeBuildings(gunzipSync(binGz));
if (check.count !== map.buildings.length) {
  throw new Error(`baked store has ${check.count} buildings, expected ${map.buildings.length}`);
}

const before = statSync(SRC).size;
const after = binGz.length + liteGz.length;
console.log(`
  buildings.bin.gz   ${mb(binGz.length).padStart(8)}   ${check.count} buildings, ${mb(storeBytes(check))} resident
  map-lite.json.gz   ${mb(liteGz.length).padStart(8)}   ${mb(liteJson.length)} of text
  ----
  download           ${mb(after).padStart(8)}   was ${mb(before)} (${(((after - before) / before) * 100).toFixed(0)}%)`);
