// The deferred far tier must never double-draw a building.
//
//   npx tsx --max-old-space-size=10240 scripts/test-farfill.ts
//
// Progressive boot introduces a race that eager filling did not have: the
// camera starts streaming prism tiles on frame one, while the far tier's
// 538k boxes are still being placed a batch at a time. If the fill un-hides a
// tile whose prisms are already up, that tile is drawn twice — boxes inside
// buildings, z-fighting at every wall.
//
// So interleave the two the way a frame loop would, at three different rates,
// and check the invariant after each: every valid building is either a box or
// a prism, never both, never neither.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import * as THREE from "three";
import {
  decodeBuildings,
  decodeHeightfield,
  findTile,
  tileKeyAt,
  type Heightfield,
} from "@battle-juice/shared";
import { buildCityModel } from "../client/src/city.js";
import { createBuildingTiles } from "../client/src/render/world.js";

const MAP_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "../client/src/public/map");
const toBuf = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

const store = decodeBuildings(gunzipSync(readFileSync(join(MAP_DIR, "buildings.bin.gz"))));
let hf: Heightfield | null = null;
try {
  hf = decodeHeightfield(toBuf(gunzipSync(readFileSync(join(MAP_DIR, "heightmap.bin.gz")))));
} catch {
  hf = null;
}
const city = buildCityModel(store, hf);

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const m4 = new THREE.Matrix4();
/** A box is drawn when it is inside far.count AND not scaled to nothing. */
function boxesDrawn(far: THREE.InstancedMesh): Set<number> {
  const on = new Set<number>();
  for (let bi = 0; bi < far.count; bi++) {
    far.getMatrixAt(bi, m4);
    if (m4.elements[0] !== 0 || m4.elements[5] !== 0 || m4.elements[10] !== 0) on.add(bi);
  }
  return on;
}

/** Buildings covered by a resident prism tile. */
function prismsDrawn(live: Set<number>): Set<number> {
  const on = new Set<number>();
  for (const t of live) {
    for (let bi = store.tileStart[t]!; bi < store.tileStart[t + 1]!; bi++) if (city.valid[bi]) on.add(bi);
  }
  return on;
}

/** Tile index owning a building index, by binary search on tileStart. */
function tileOf(bi: number): number {
  let lo = 0;
  let hi = store.tileKey.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (store.tileStart[mid]! <= bi) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Tiles in a square window around the map centre, nearest-first-ish. */
function window(cx: number, cy: number, r: number): number[] {
  const want: number[] = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const t = findTile(store, tileKeyAt(cx + dx * store.tileSize, cy + dy * store.tileSize, store.tileSize));
      if (t >= 0) want.push(t);
    }
  }
  return want;
}

const CX = 12_000;
const CY = 12_000;

/** One boot: pour `perFrame` far batches and `tileBudget` prism tiles per
 * simulated frame, panning the camera as it goes. */
function run(label: string, perFrame: number, tileBudget: number): void {
  const tiles = createBuildingTiles(store, new Map(), city, true);
  const fill = tiles.fillFar();
  const live = new Set<number>();
  let filling = true;
  let worstOverlap = 0;

  for (let frame = 0; frame < 400 && (filling || frame < 40); frame++) {
    for (let i = 0; i < perFrame && filling; i++) filling = !fill.next().done;
    // Camera drifts east, so tiles are built and evicted throughout the fill.
    const want = window(CX + frame * 300, CY, 2);
    const wantSet = new Set(want);
    const { built } = tiles.sync(want, tileBudget);
    // Residency tracked from sync's own report, NOT from the boxes — deriving
    // it from the boxes would make the overlap check assert itself.
    for (const t of [...live]) if (!wantSet.has(t)) live.delete(t);
    for (const [from] of built) live.add(tileOf(from));

    const drawnBoxes = boxesDrawn(tiles.far);
    const drawnPrisms = prismsDrawn(live);
    let overlap = 0;
    for (const bi of drawnPrisms) if (drawnBoxes.has(bi)) overlap++;
    if (overlap > worstOverlap) worstOverlap = overlap;
  }

  check(`${label}: no building is both a box and a prism`, worstOverlap === 0, `${worstOverlap} overlapping`);

  // Once the fill has finished and the prisms are evicted, every valid
  // building must be back to exactly one box.
  while (!fill.next().done) {
    /* drain */
  }
  tiles.sync([]);
  const drawn = boxesDrawn(tiles.far);
  let missing = 0;
  let extra = 0;
  for (let bi = 0; bi < store.count; bi++) {
    if (city.valid[bi] && !drawn.has(bi)) missing++;
    if (!city.valid[bi] && drawn.has(bi)) extra++;
  }
  check(`${label}: every valid building ends as one box`, missing === 0 && extra === 0, `${missing} missing, ${extra} extra`);
}

console.log("deferred far fill vs. streaming prisms");
run("slow fill (1 batch/frame)", 1, 2);
run("fast fill (8 batches/frame)", 8, 2);
run("fill outruns streaming", 64, 1);

// And the eager path must still behave exactly as before.
{
  const tiles = createBuildingTiles(store, new Map(), city);
  const drawn = boxesDrawn(tiles.far);
  let valid = 0;
  for (let bi = 0; bi < store.count; bi++) if (city.valid[bi]) valid++;
  check("eager fill places every box up front", drawn.size === valid, `${drawn.size} of ${valid}`);
  check("eager fill draws the whole store", tiles.far.count === store.count, `count=${tiles.far.count}`);
}

console.log(failures ? `\n${failures} failed` : "\nall checks passed");
process.exitCode = failures ? 1 : 0;
