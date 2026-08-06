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
import {
  decodeBuildings,
  decodeCityLod,
  decodeLayers,
  decodeProps,
  decodeStreets,
  encodeBuildings,
  encodeCityLod,
  encodeLayers,
  layerInputs,
  encodeProps,
  encodeStreets,
  featureStoreBytes,
  LAYER_NAMES,
  propStoreBytes,
  streetStoreBytes,
  storeBytes,
  type GameMap,
} from "@battle-juice/shared";

const MAP_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "../client/src/public/map");
const SRC = join(MAP_DIR, "map.json.gz");
const mb = (n: number): string => `${(n / 1e6).toFixed(1)} MB`;

const t0 = performance.now();
const map = JSON.parse(gunzipSync(readFileSync(SRC)).toString("utf8")) as GameMap;
console.log(`read ${SRC} (${mb(statSync(SRC).size)} gzipped) in ${((performance.now() - t0) / 1000).toFixed(1)}s`);

const bin = encodeBuildings(map);
const binGz = gzipSync(bin, { level: 9 });
writeFileSync(join(MAP_DIR, "buildings.bin.gz"), binGz);

const propBin = encodeProps(map.props);
const propGz = gzipSync(propBin, { level: 9 });
writeFileSync(join(MAP_DIR, "props.bin.gz"), propGz);

const streetBin = encodeStreets(map);
const streetGz = gzipSync(streetBin, { level: 9 });
writeFileSync(join(MAP_DIR, "streets.bin.gz"), streetGz);

const cityLodBin = encodeCityLod(map);
const cityLodGz = gzipSync(cityLodBin, { level: 9 });
writeFileSync(join(MAP_DIR, "city-lod.bin.gz"), cityLodGz);

// Render-only vector layers. `attr` carries the one enum each needs.
const layerBin = encodeLayers(layerInputs(map));
const layerGz = gzipSync(layerBin, { level: 9 });
writeFileSync(join(MAP_DIR, "layers.bin.gz"), layerGz);

// Everything except buildings, props and the vector layers.
// `undefined` drops the key entirely in JSON.stringify.
const lite: Record<string, unknown> = {
  ...map,
  buildings: undefined,
  props: undefined,
  nodes: undefined,
  edges: undefined,
};
for (const name of LAYER_NAMES) lite[name] = undefined;
const liteJson = JSON.stringify(lite);
const liteGz = gzipSync(Buffer.from(liteJson, "utf8"), { level: 9 });
writeFileSync(join(MAP_DIR, "map-lite.json.gz"), liteGz);

// Prove the artefact decodes before anyone ships it — a corrupt store would
// otherwise surface as a blank city in the browser.
const check = decodeBuildings(gunzipSync(binGz));
if (check.count !== map.buildings.length) {
  throw new Error(`baked store has ${check.count} buildings, expected ${map.buildings.length}`);
}
const checkLayers = decodeLayers(gunzipSync(layerGz));
if (checkLayers.sidewalks.count !== (map.sidewalks ?? []).length) {
  throw new Error(`baked layers have ${checkLayers.sidewalks.count} sidewalks, expected ${(map.sidewalks ?? []).length}`);
}
const checkProps = decodeProps(gunzipSync(propGz));
if (checkProps.count !== map.props.length) {
  throw new Error(`baked store has ${checkProps.count} props, expected ${map.props.length}`);
}
const checkStreets = decodeStreets(gunzipSync(streetGz));
if (checkStreets.edgeCount !== map.edges.length || checkStreets.nodeCount !== map.nodes.length) {
  throw new Error(`baked street store has ${checkStreets.edgeCount}/${checkStreets.nodeCount}, expected ${map.edges.length}/${map.nodes.length}`);
}
const checkCityLod = decodeCityLod(gunzipSync(cityLodGz));

const before = statSync(SRC).size;
const after = binGz.length + propGz.length + streetGz.length + cityLodGz.length + layerGz.length + liteGz.length;
console.log(`
  buildings.bin.gz   ${mb(binGz.length).padStart(8)}   ${check.count} buildings, ${mb(storeBytes(check))} resident
  props.bin.gz       ${mb(propGz.length).padStart(8)}   ${checkProps.count} props, ${mb(propStoreBytes(checkProps))} resident
  streets.bin.gz     ${mb(streetGz.length).padStart(8)}   ${checkStreets.edgeCount} edges, ${checkStreets.nodeCount} nodes, ${mb(streetStoreBytes(checkStreets))} resident
  city-lod.bin.gz    ${mb(cityLodGz.length).padStart(8)}   ${checkCityLod.cols}x${checkCityLod.rows} texels
  layers.bin.gz      ${mb(layerGz.length).padStart(8)}   ${LAYER_NAMES.map((n) => `${checkLayers[n].count} ${n}`).join(", ")}
                                  ${mb(LAYER_NAMES.reduce((a, n) => a + featureStoreBytes(checkLayers[n]), 0))} resident
  map-lite.json.gz   ${mb(liteGz.length).padStart(8)}   ${mb(liteJson.length)} of text
  ----
  download           ${mb(after).padStart(8)}   was ${mb(before)} (${(((after - before) / before) * 100).toFixed(0)}%)`);
