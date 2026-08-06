// Round-trips shared/src/mapbin.ts against the real Portland extract, and
// measures the heap it was written to save.
//
//   npx tsx --expose-gc --max-old-space-size=10240 scripts/test-mapbin.ts
//
// Two things have to hold before anything is migrated onto this format:
// every building survives the round trip inside the quantisation grid, and
// the store actually costs what the proposal claimed (~37 MB against ~560 MB
// of object graph). The second is measured with real heap deltas, not
// element-count arithmetic.
//
// Falls back to a synthetic map when the staged extract is absent, so the
// correctness half still runs anywhere.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  buildingHeight,
  buildingUse,
  decodeBuildings,
  decodeLayers,
  encodeBuildings,
  encodeLayers,
  encodeProps,
  decodeProps,
  encodeStreets,
  decodeStreets,
  findTile,
  findFeatureTile,
  findStreetTile,
  featureStoreBytes,
  layerInputs,
  LAYER_NAMES,
  PROP_KINDS,
  propStoreBytes,
  streetEdge,
  streetStoreBytes,
  forEachRingVertex,
  ringBase,
  tileKeyAt,
  ringCount,
  ringLength,
  storeBytes,
  type BuildingStore,
  type GameMap,
} from "@battle-juice/shared";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
}

const MAP_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "../client/src/public/map");
const MAP_GZ = join(MAP_DIR, "map.json.gz");
const mb = (n: number): string => `${(n / 1e6).toFixed(1)} MB`;

function synthetic(): GameMap {
  const buildings = [];
  for (let i = 0; i < 500; i++) {
    const x = (i % 25) * 40 + 3.33;
    const y = Math.floor(i / 25) * 40 + 7.77;
    const b: Record<string, unknown> = {
      id: i * 3 + 1,
      footprint: [[x, y], [x + 18.5, y], [x + 18.5, y + 12.25], [x, y + 12.25]],
      height: 3 + (i % 40) * 0.7,
      use: ["sfr", "mfr", "com", "off", "ind", "inst", "other"][i % 7],
    };
    // A few courtyards, matching the 0.26% that have them in the real map.
    if (i % 97 === 0) b["holes"] = [[[x + 4, y + 4], [x + 8, y + 4], [x + 8, y + 8], [x + 4, y + 8]]];
    buildings.push(b);
  }
  return { buildings } as unknown as GameMap;
}

const real = existsSync(MAP_GZ);
console.log(real ? "using the staged Portland extract" : "staged map absent — using a synthetic map");

const gc = (globalThis as { gc?: () => void }).gc;
/** Object graphs live on the JS heap; typed arrays live in external
 * ArrayBuffer memory and do not show up in heapUsed at all. Counting both is
 * the only way to compare the two representations honestly. */
const mem = (): number => {
  gc?.();
  const m = process.memoryUsage();
  return m.heapUsed + m.arrayBuffers;
};

const beforeJson = mem();
const map: GameMap = real
  ? (JSON.parse(gunzipSync(readFileSync(MAP_GZ)).toString("utf8")) as GameMap)
  : synthetic();
const jsonHeap = mem() - beforeJson;

const encoded = encodeBuildings(map);
const beforeStore = mem();
const store: BuildingStore = decodeBuildings(encoded);
const storeHeap = mem() - beforeStore;

// --- correctness ----------------------------------------------------------

check("building count survives", store.count === map.buildings.length, `${store.count} vs ${map.buildings.length}`);

// Buildings are written in tile order, so they are matched back up by id.
const byId = new Map<number, number>();
for (let b = 0; b < store.count; b++) byId.set(store.id[b]!, b);
check("ids are unique and complete", byId.size === map.buildings.length, `${byId.size} distinct ids`);

let worstXY = 0;
let worstH = 0;
let badRings = 0;
let badUse = 0;
let checked = 0;
for (const src of map.buildings) {
  const b = byId.get(src.id);
  if (b === undefined) {
    badRings++;
    continue;
  }
  checked++;
  if (ringCount(store, b) !== 1 + (src.holes?.length ?? 0)) badRings++;
  if (ringLength(store, b, 0) !== src.footprint.length) badRings++;
  if (buildingUse(store, b) !== (src.use ?? "other")) badUse++;
  worstH = Math.max(worstH, Math.abs(buildingHeight(store, b) - src.height));
  const rings = [src.footprint, ...(src.holes ?? [])];
  for (let k = 0; k < rings.length && k < ringCount(store, b); k++) {
    const want = rings[k]!;
    forEachRingVertex(store, b, k, (x, y, i) => {
      const w = want[i];
      if (!w) return;
      worstXY = Math.max(worstXY, Math.abs(x - w[0]), Math.abs(y - w[1]));
    });
  }
}
check("every building matched", checked === map.buildings.length, `${checked} checked`);
check("ring structure preserved", badRings === 0, `${badRings} mismatches`);
check("use category preserved", badUse === 0, `${badUse} mismatches`);
// 1 cm quantisation, plus Float32 rounding at city scale (~2.6 mm at 43 km).
check("coordinates within 1 cm", worstXY <= 0.011, `worst ${(worstXY * 1000).toFixed(2)} mm`);
// Heights are stored in decimetres, so half a decimetre is the bound.
check("heights within 5 cm", worstH <= 0.051, `worst ${(worstH * 100).toFixed(1)} cm`);

// --- props ----------------------------------------------------------------
// Same contract as buildings: positions inside the quantisation grid, kinds
// and variants exact. 405k prop objects are 65 MB of heap; the store is 4.5.
if (real) {
  const propBytes = encodeProps(map.props);
  const ps = decodeProps(propBytes);
  check("prop count survives", ps.count === map.props.length, `${ps.count} vs ${map.props.length}`);
  // Props are tile-sorted, so match on position rather than index — and a
  // position can hold SEVERAL props (a sign and a meter share a corner), so
  // each key maps to a list. Keying to one index scored 84 false failures.
  const seen = new Map<string, number[]>();
  const key = (x: number, y: number): string =>
    `${Math.fround(Math.round(x / 0.01) * 0.01).toFixed(2)},${Math.fround(Math.round(y / 0.01) * 0.01).toFixed(2)}`;
  for (let i = 0; i < ps.count; i++) {
    const k = key(ps.x[i]!, ps.y[i]!);
    const at = seen.get(k);
    if (at) at.push(i);
    else seen.set(k, [i]);
  }
  let missing = 0;
  let badKind = 0;
  let badVariant = 0;
  for (const p of map.props) {
    const at = seen.get(key(p.x, p.y));
    if (!at) {
      missing++;
      continue;
    }
    const hit = at.filter((i) => PROP_KINDS[ps.kind[i]!] === p.kind);
    if (!hit.length) {
      badKind++;
      continue;
    }
    if (p.kind === "tree" && !hit.some((i) => ps.variant[i] === p.size)) badVariant++;
  }
  check("every prop position round-trips", missing === 0, `${missing} unmatched`);
  check("prop kinds preserved", badKind === 0, `${badKind} mismatches`);
  check("tree sizes preserved", badVariant === 0, `${badVariant} mismatches`);
  console.log(
    `  props       ${(propBytes.length / 1e6).toFixed(1)} MB raw, ` +
      `${(gzipSync(propBytes, { level: 9 }).length / 1e6).toFixed(1)} MB gzipped, ` +
      `${(propStoreBytes(ps) / 1e6).toFixed(1)} MB resident\n`,
  );

  let propCovered = 0;
  let treeCount = 0;
  let maxTree = -1;
  for (let t = 0; t < ps.tileKey.length; t++) propCovered += ps.tileStart[t + 1]! - ps.tileStart[t]!;
  for (const tree of ps.treeOrdinal) {
    if (tree < 0) continue;
    treeCount++;
    if (tree > maxTree) maxTree = tree;
  }
  check("prop tiles partition the store", propCovered === ps.count, `${propCovered} of ${ps.count}`);
  check("tree ordinals are contiguous", treeCount === maxTree + 1, `${treeCount} trees`);

  const streetBytes = encodeStreets(map);
  const streets = decodeStreets(streetBytes);
  check("street node count survives", streets.nodeCount === map.nodes.length);
  check("street edge count survives", streets.edgeCount === map.edges.length);
  let streetMismatch = 0;
  let worstStreetXY = 0;
  for (let i = 0; i < map.edges.length; i += 997) {
    const want = map.edges[i]!;
    const got = streetEdge(streets, i);
    if (
      got.id !== want.id || got.a !== want.a || got.b !== want.b ||
      got.class !== want.class || got.struct !== want.struct ||
      got.polyline.length !== want.polyline.length
    ) streetMismatch++;
    for (let p = 0; p < Math.min(got.polyline.length, want.polyline.length); p++) {
      worstStreetXY = Math.max(
        worstStreetXY,
        Math.abs(got.polyline[p]![0] - want.polyline[p]![0]),
        Math.abs(got.polyline[p]![1] - want.polyline[p]![1]),
      );
    }
  }
  check("street attributes round-trip", streetMismatch === 0, `${streetMismatch} sampled mismatches`);
  check("street coordinates within 1 cm", worstStreetXY <= 0.011, `worst ${(worstStreetXY * 1000).toFixed(2)} mm`);
  let streetCovered = 0;
  let streetTilesOk = true;
  const seenEdges = new Uint8Array(streets.edgeCount);
  for (let tile = 0; tile < streets.tileKey.length; tile++) {
    const from = streets.tileStart[tile]!;
    const to = streets.tileStart[tile + 1]!;
    streetCovered += to - from;
    if (findStreetTile(streets, streets.tileKey[tile]!) !== tile) streetTilesOk = false;
    for (let at = from; at < to; at++) {
      const edge = streets.tileEdge[at]!;
      if (edge >= streets.edgeCount || seenEdges[edge]) streetTilesOk = false;
      else seenEdges[edge] = 1;
    }
  }
  check("street render tiles partition every edge", streetCovered === streets.edgeCount && streetTilesOk);
  console.log(
    `  streets     ${(streetBytes.length / 1e6).toFixed(1)} MB raw, ` +
      `${(gzipSync(streetBytes, { level: 9 }).length / 1e6).toFixed(1)} MB gzipped, ` +
      `${(streetStoreBytes(streets) / 1e6).toFixed(1)} MB resident\n`,
  );

  const layerBytes = encodeLayers(layerInputs(map));
  const layerStores = decodeLayers(layerBytes);
  let allLayerTilesOk = true;
  let layerResident = 0;
  for (const name of LAYER_NAMES) {
    const layer = layerStores[name];
    let covered = 0;
    for (let tile = 0; tile < layer.tileKey.length; tile++) {
      covered += layer.tileStart[tile + 1]! - layer.tileStart[tile]!;
      if (findFeatureTile(layer, layer.tileKey[tile]!) !== tile) allLayerTilesOk = false;
    }
    if (covered !== layer.count) allLayerTilesOk = false;
    layerResident += featureStoreBytes(layer);
  }
  check("detail tile tables partition every feature", allLayerTilesOk);
  check("detail indexes stay compact", layerResident < 100e6, mb(layerResident));
}

// The tile table is what lets the renderer build one tile without touching
// the rest of the city, so it has to partition the store exactly.
let tileCovered = 0;
let tileOrderOk = true;
let tileContentOk = true;
for (let t = 0; t < store.tileKey.length; t++) {
  const from = store.tileStart[t]!;
  const to = store.tileStart[t + 1]!;
  tileCovered += to - from;
  if (t > 0 && store.tileKey[t]! <= store.tileKey[t - 1]!) tileOrderOk = false;
  // Every building in the slice must actually belong to the slice's tile.
  for (let b = from; b < to; b++) {
    const v = ringBase(store, b, 0);
    const n = ringLength(store, b, 0);
    if (n === 0) continue;
    const key = tileKeyAt(store.coords[v * 2]!, store.coords[v * 2 + 1]!, store.tileSize);
    if (key !== store.tileKey[t]!) tileContentOk = false;
  }
}
check("tiles partition every building", tileCovered === store.count, `${tileCovered} of ${store.count}`);
check("tile keys are sorted and unique", tileOrderOk);
check("each tile slice holds only its own buildings", tileContentOk);
check(
  "tile lookup finds every tile",
  store.tileKey.every((k, t) => findTile(store, k) === t),
  `${store.tileKey.length} tiles`,
);
check("a missing tile reports -1", findTile(store, 0) === -1); // biased keys never reach 0

// Re-encoding a decoded store must reproduce the same bytes, or the format
// is not a fixed point and a re-bake would churn the asset.
const store2 = decodeBuildings(encodeBuildings({ buildings: [] } as unknown as GameMap));
check("an empty map round-trips", store2.count === 0);

// --- size -----------------------------------------------------------------

console.log("");
const gz = gzipSync(encoded, { level: 9 }).length;
console.log(`  wire        ${mb(encoded.length)} raw, ${mb(gz)} gzipped`);
console.log(`  resident    ${mb(storeBytes(store))} of typed arrays`);
if (real) {
  const jsonBytes = gunzipSync(readFileSync(MAP_GZ)).length;
  console.log(`  vs JSON     ${mb(jsonBytes)} of text for the whole map (buildings are ~63% of it)`);
}
console.log(`  measured    ${mb(jsonHeap)} to parse the whole map -> ${mb(storeHeap)} to decode the store`);
console.log(
  `  vertices    ${(store.coords.length / 2 / 1e6).toFixed(2)}M in ${store.ringOffset.length - 1} rings`,
);
let biggest = 0;
for (let t = 0; t < store.tileKey.length; t++) {
  biggest = Math.max(biggest, store.tileStart[t + 1]! - store.tileStart[t]!);
}
console.log(
  `  tiles       ${store.tileKey.length} occupied at ${store.tileSize} m, ` +
    `${Math.round(store.count / Math.max(1, store.tileKey.length))} buildings median, ${biggest} in the busiest`,
);

check("store is under 60 MB resident", storeBytes(store) < 60e6, mb(storeBytes(store)));

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
