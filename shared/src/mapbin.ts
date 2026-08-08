/**
 * Binary building store — the first payload of the compact city model.
 *
 * `map.json.gz` inflates to 147 MB of text and then to an 880 MB JS heap,
 * because every coordinate pair is a 2-element `Array`: a heap object with a
 * header and a butterfly pointer, ~80 bytes to hold 16 bytes of numbers.
 * There are ~3.8M of them in the footprints alone, plus 538k `Building`
 * objects. Buildings are 63% of the map's bytes and about the same share of
 * that heap, so they come first.
 *
 * The store holds the same information in flat typed arrays: no per-building
 * object, no per-vertex array, nothing for the GC to walk. Rings are
 * addressed through two levels of offset table, which is what lets one
 * `Float32Array` hold every footprint in the city.
 *
 *   buildings   ringStart[b] .. ringStart[b+1]     rings of building b
 *   rings       ringOffset[r] .. ringOffset[r+1]   vertex range of ring r
 *   coords      x = coords[i*2], y = coords[i*2+1]
 *
 * Ring 0 of a building is its outer footprint; any rings after it are
 * courtyard holes (only 0.26% of buildings have one).
 *
 * The wire format is deliberately NOT the resident format. Coordinates travel
 * as zigzag varint deltas on a 1 cm grid — measured at 47% smaller than
 * today's gzipped JSON, versus 28% for raw Float32 — and decode into the
 * Float32Array above at ~230 ms for the whole city, replacing `JSON.parse`'s
 * 940 ms rather than adding to it. See scripts/measure-binary.ts.
 */
import type { Building, GameMap, Prop, RoadClass, StreetEdge } from "./map.js";

/** F_ZLEV runs -2..5; bias it into an unsigned byte. */
export const ZLEV_BIAS = 8;

const MAGIC = 0x424a4231; // "BJB1"
/** Coordinate quantisation. 1 cm costs ~2 MB of download over 5 cm and buys
 * precision headroom we may want for FPV; the round-trip error it introduces
 * (~2 mm, dominated by Float32 rounding at city scale) is far below anything
 * visible. */
const GRID = 0.01;
/** Bumped on ANY layout change. A stale artefact must fail loudly here rather
 * than decode as garbage — reading a v1 file with a v2 reader misaligned the
 * stream and tried to allocate 9 GB before anything noticed. */
const FORMAT_VERSION = 5; // 5: street edges carry F_ZLEV/T_ZLEV deck levels

/** Normalised building categories, indexed by the store's `use` array. */
export const BUILDING_USES = ["sfr", "mfr", "com", "off", "ind", "inst", "other"] as const;

export interface BuildingStore {
  count: number;
  /** Index into `ringOffset`, per building. Length count + 1. */
  ringStart: Uint32Array;
  /** Index into `coords` (in PAIRS, not floats). Length totalRings + 1. */
  ringOffset: Uint32Array;
  /** Interleaved x, y in world metres. */
  coords: Float32Array;
  /** Extrusion height in decimetres — 0.1 m resolution up to 6553 m. */
  heightDm: Uint16Array;
  /** Index into {@link BUILDING_USES}. */
  use: Uint8Array;
  /** Source id, which landmarks reference. Not the array index. */
  id: Uint32Array;
  /** Tile edge in metres, matching the order buildings were written in. */
  tileSize: number;
  /** Occupied tile keys, ascending. Key is `ty * 4096 + tx`. */
  tileKey: Uint32Array;
  /**
   * Building index range per tile: tile `t` holds buildings
   * `tileStart[t] .. tileStart[t+1]`. Because the store is written in tile
   * order a tile is a CONTIGUOUS SLICE, which is what lets the renderer build
   * one tile without touching the rest of the city.
   */
  tileStart: Uint32Array;
}

/**
 * Tile key from world metres.
 *
 * Biased, because the extract contains coordinates slightly outside
 * [0, width] x [0, height] — a footprint at y = -22.7 lands in tile row -1,
 * and an unbiased key would go negative and wrap in the Uint32Array that
 * stores it. 12 biased bits per axis covers tile indices -2048..2047, which
 * is 2048 km either side of the origin at 1 km tiles.
 */
const TILE_BIAS = 2048;
export function tileKeyAt(x: number, y: number, tileSize: number): number {
  const tx = Math.floor(x / tileSize) + TILE_BIAS;
  const ty = Math.floor(y / tileSize) + TILE_BIAS;
  return ty * 4096 + tx;
}

/** Index into `tileKey` / `tileStart`, or -1 when the tile holds nothing. */
export function findTile(s: BuildingStore, key: number): number {
  let lo = 0;
  let hi = s.tileKey.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = s.tileKey[mid]!;
    if (v === key) return mid;
    if (v < key) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

// ---------------------------------------------------------------- varint io

class Writer {
  private buf = new Uint8Array(1 << 20);
  len = 0;

  private room(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  u32(v: number): void {
    this.room(4);
    this.buf[this.len++] = v & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = (v >>> 16) & 0xff;
    this.buf[this.len++] = (v >>> 24) & 0xff;
  }

  u8(v: number): void {
    this.room(1);
    this.buf[this.len++] = v & 0xff;
  }

  raw(bytes: Uint8Array): void {
    this.room(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
  }

  /** Unsigned LEB128. Values can exceed 2^31, so the shift is arithmetic. */
  varint(v: number): void {
    this.room(6);
    let x = v;
    while (x >= 0x80) {
      this.buf[this.len++] = (x & 0x7f) | 0x80;
      x = Math.floor(x / 128);
    }
    this.buf[this.len++] = x;
  }

  /** Signed, zigzagged so small negative deltas stay one byte. */
  zig(v: number): void {
    this.varint(v < 0 ? -2 * v - 1 : 2 * v);
  }

  take(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

class Reader {
  at = 0;
  constructor(private buf: Uint8Array) {}

  u32(): number {
    const v =
      this.buf[this.at]! | (this.buf[this.at + 1]! << 8) | (this.buf[this.at + 2]! << 16) | (this.buf[this.at + 3]! << 24);
    this.at += 4;
    return v >>> 0;
  }

  u8(): number {
    return this.buf[this.at++]!;
  }

  raw(length: number): Uint8Array {
    const out = this.buf.subarray(this.at, this.at + length);
    this.at += length;
    return out;
  }

  varint(): number {
    let shift = 1;
    let v = 0;
    let byte = 0;
    do {
      byte = this.buf[this.at++]!;
      v += (byte & 0x7f) * shift;
      shift *= 128;
    } while (byte & 0x80);
    return v;
  }

  zig(): number {
    const v = this.varint();
    return v & 1 ? -(v + 1) / 2 : v / 2;
  }
}

// ------------------------------------------------------------------- encode

/**
 * Buildings are written in tile order (1 km cells, row-major). Two reasons:
 * consecutive buildings are then neighbours, so their coordinate deltas stay
 * small and the varint stream compresses; and a tile streamer can later read a
 * contiguous slice per tile instead of gathering scattered indices.
 *
 * This reorders `map.buildings`, so anything holding a building INDEX across
 * the change is wrong. Ids are preserved, and landmarks reference ids.
 */
export function encodeBuildings(map: GameMap, tile = 1000): Uint8Array {
  // Key off the value the decoder will SEE, not the raw input: a footprint
  // whose first vertex sits within a centimetre of a tile line would
  // otherwise be filed under one tile here and read back as another.
  const q = (v: number): number => Math.fround(Math.round(v / GRID) * GRID);
  const order = map.buildings
    .map((b, i) => {
      const [x, y] = b.footprint[0] ?? [0, 0];
      return { i, key: tileKeyAt(q(x), q(y), tile) };
    })
    .sort((a, b) => a.key - b.key || a.i - b.i);

  const w = new Writer();
  w.u32(MAGIC);
  w.u32(FORMAT_VERSION);
  w.u32(map.buildings.length);

  // Structure first: ring counts and vertex counts, so the decoder can size
  // every array before touching the coordinate stream.
  let totalRings = 0;
  let totalVerts = 0;
  for (const { i } of order) {
    const b = map.buildings[i]!;
    const holes = b.holes ?? [];
    w.varint(1 + holes.length);
    w.varint(b.footprint.length);
    for (const h of holes) w.varint(h.length);
    totalRings += 1 + holes.length;
    totalVerts += b.footprint.length;
    for (const h of holes) totalVerts += h.length;
  }
  w.u32(totalRings);
  w.u32(totalVerts);

  // Tile table. The sort above already grouped buildings by tile, so this is a
  // run-length pass over the sorted keys.
  const keys: number[] = [];
  const starts: number[] = [];
  for (let i = 0; i < order.length; i++) {
    const k = order[i]!.key;
    if (i === 0 || k !== order[i - 1]!.key) {
      keys.push(k);
      starts.push(i);
    }
  }
  w.u32(tile);
  w.u32(keys.length);
  let prevKey = 0;
  for (const k of keys) {
    w.varint(k - prevKey);
    prevKey = k;
  }
  for (const st of starts) w.varint(st);

  // Attributes.
  for (const { i } of order) {
    const b = map.buildings[i]!;
    w.varint(Math.max(0, Math.min(65535, Math.round(b.height * 10))));
  }
  for (const { i } of order) {
    const use = map.buildings[i]!.use ?? "other";
    const at = (BUILDING_USES as readonly string[]).indexOf(use);
    w.u8(at < 0 ? BUILDING_USES.indexOf("other") : at);
  }
  let prevId = 0;
  for (const { i } of order) {
    const id = map.buildings[i]!.id;
    w.zig(id - prevId);
    prevId = id;
  }

  // Coordinates: one continuous delta chain across the whole city.
  let px = 0;
  let py = 0;
  for (const { i } of order) {
    const b = map.buildings[i]!;
    for (const ring of [b.footprint, ...(b.holes ?? [])]) {
      for (const [x, y] of ring) {
        const qx = Math.round(x / GRID);
        const qy = Math.round(y / GRID);
        w.zig(qx - px);
        w.zig(qy - py);
        px = qx;
        py = qy;
      }
    }
  }
  return w.take();
}

// ------------------------------------------------------------------- decode

export function decodeBuildings(bytes: Uint8Array): BuildingStore {
  const r = new Reader(bytes);
  if (r.u32() !== MAGIC) throw new Error("not a building store");
  const version = r.u32();
  if (version !== FORMAT_VERSION) {
    throw new Error(`building store is version ${version}, this build reads ${FORMAT_VERSION} — re-run scripts/stage-map.sh`);
  }
  const count = r.u32();

  const ringStart = new Uint32Array(count + 1);
  // Ring vertex counts come before the totals, so they are staged here and
  // folded into the offset table once the sizes are known.
  const ringLen: number[] = [];
  for (let b = 0; b < count; b++) {
    const rings = r.varint();
    ringStart[b + 1] = ringStart[b]! + rings;
    for (let k = 0; k < rings; k++) ringLen.push(r.varint());
  }
  const totalRings = r.u32();
  const totalVerts = r.u32();
  const tileSize = r.u32();
  const nTiles = r.u32();
  if (nTiles > count + 1 || totalVerts < totalRings) throw new Error("building store: header looks corrupt");
  const tileKey = new Uint32Array(nTiles);
  let prevTileKey = 0;
  for (let t = 0; t < nTiles; t++) {
    prevTileKey += r.varint();
    tileKey[t] = prevTileKey;
  }
  const tileStart = new Uint32Array(nTiles + 1);
  for (let t = 0; t < nTiles; t++) tileStart[t] = r.varint();
  tileStart[nTiles] = count;
  if (ringLen.length !== totalRings) throw new Error("building store: ring count mismatch");

  const ringOffset = new Uint32Array(totalRings + 1);
  for (let i = 0; i < totalRings; i++) ringOffset[i + 1] = ringOffset[i]! + ringLen[i]!;
  if (ringOffset[totalRings] !== totalVerts) throw new Error("building store: vertex count mismatch");

  const heightDm = new Uint16Array(count);
  for (let b = 0; b < count; b++) heightDm[b] = r.varint();
  const use = new Uint8Array(count);
  for (let b = 0; b < count; b++) use[b] = r.u8();
  const id = new Uint32Array(count);
  let prevId = 0;
  for (let b = 0; b < count; b++) {
    prevId += r.zig();
    id[b] = prevId;
  }

  const coords = new Float32Array(totalVerts * 2);
  let px = 0;
  let py = 0;
  for (let i = 0; i < totalVerts; i++) {
    px += r.zig();
    py += r.zig();
    coords[i * 2] = px * GRID;
    coords[i * 2 + 1] = py * GRID;
  }
  return { count, ringStart, ringOffset, coords, heightDm, use, id, tileSize, tileKey, tileStart };
}

/**
 * Build a store straight from the object-graph form, without going through
 * bytes. For the server's sim (which loads small synthetic maps where the
 * object graph costs nothing) and for tests. Preserves the input order —
 * unlike {@link encodeBuildings}, which sorts into tile order.
 */
export function storeFromBuildings(buildings: Building[]): BuildingStore {
  const count = buildings.length;
  const ringStart = new Uint32Array(count + 1);
  const lens: number[] = [];
  for (let b = 0; b < count; b++) {
    const src = buildings[b]!;
    const rings = 1 + (src.holes?.length ?? 0);
    ringStart[b + 1] = ringStart[b]! + rings;
    lens.push(src.footprint.length);
    for (const h of src.holes ?? []) lens.push(h.length);
  }
  const ringOffset = new Uint32Array(lens.length + 1);
  for (let i = 0; i < lens.length; i++) ringOffset[i + 1] = ringOffset[i]! + lens[i]!;
  const coords = new Float32Array(ringOffset[lens.length]! * 2);
  const heightDm = new Uint16Array(count);
  const use = new Uint8Array(count);
  const id = new Uint32Array(count);
  let at = 0;
  for (let b = 0; b < count; b++) {
    const src = buildings[b]!;
    for (const ring of [src.footprint, ...(src.holes ?? [])]) {
      for (const [x, y] of ring) {
        coords[at * 2] = x;
        coords[at * 2 + 1] = y;
        at++;
      }
    }
    heightDm[b] = Math.max(0, Math.min(65535, Math.round(src.height * 10)));
    const k = (BUILDING_USES as readonly string[]).indexOf(src.use ?? "other");
    use[b] = k < 0 ? BUILDING_USES.indexOf("other") : k;
    id[b] = src.id;
  }
  // Input order is preserved, so there is no tile grouping to describe: one
  // tile holding everything keeps the shape valid for callers that walk it.
  return {
    count,
    ringStart,
    ringOffset,
    coords,
    heightDm,
    use,
    id,
    tileSize: Infinity,
    // Every finite coordinate divided by Infinity floors to 0, so one key
    // covers the lot.
    tileKey: Uint32Array.from(count ? [tileKeyAt(0, 0, Infinity)] : []),
    tileStart: Uint32Array.from(count ? [0, count] : [0]),
  };
}

// ------------------------------------------------------------- read helpers

/** Height in metres. */
export function buildingHeight(s: BuildingStore, b: number): number {
  return s.heightDm[b]! / 10;
}

export function buildingUse(s: BuildingStore, b: number): string {
  return BUILDING_USES[s.use[b]!] ?? "other";
}

/** Number of rings: 1 plus however many courtyard holes. */
export function ringCount(s: BuildingStore, b: number): number {
  return s.ringStart[b + 1]! - s.ringStart[b]!;
}

/** Vertex count of ring `k` of building `b` (k = 0 is the outer footprint). */
export function ringLength(s: BuildingStore, b: number, k = 0): number {
  const r = s.ringStart[b]! + k;
  return s.ringOffset[r + 1]! - s.ringOffset[r]!;
}

/** First vertex index of ring `k`, for indexing straight into `coords`. */
export function ringBase(s: BuildingStore, b: number, k = 0): number {
  return s.ringOffset[s.ringStart[b]! + k]!;
}

/**
 * Walk a ring without allocating. The callback is the whole API on purpose —
 * handing back `[x, y]` pairs would rebuild exactly the object graph this
 * format exists to delete.
 */
export function forEachRingVertex(
  s: BuildingStore,
  b: number,
  k: number,
  fn: (x: number, y: number, i: number) => void,
): void {
  const r = s.ringStart[b]! + k;
  const from = s.ringOffset[r]!;
  const to = s.ringOffset[r + 1]!;
  for (let i = from; i < to; i++) fn(s.coords[i * 2]!, s.coords[i * 2 + 1]!, i - from);
}

/** Rebuild the object-graph form of one building. For tests and for code not
 * yet migrated — calling this in a loop over the city defeats the point. */
export function buildingToObject(s: BuildingStore, b: number): Building {
  const rings: [number, number][][] = [];
  for (let k = 0; k < ringCount(s, b); k++) {
    const ring: [number, number][] = [];
    forEachRingVertex(s, b, k, (x, y) => ring.push([x, y]));
    rings.push(ring);
  }
  const out: Building = {
    id: s.id[b]!,
    footprint: rings[0] ?? [],
    height: buildingHeight(s, b),
    use: buildingUse(s, b),
  };
  if (rings.length > 1) out.holes = rings.slice(1);
  return out;
}

/** Bytes the store occupies — the number Stage 1 is judged on. */
export function storeBytes(s: BuildingStore): number {
  return (
    s.ringStart.byteLength +
    s.ringOffset.byteLength +
    s.coords.byteLength +
    s.heightDm.byteLength +
    s.use.byteLength +
    s.id.byteLength +
    s.tileKey.byteLength +
    s.tileStart.byteLength
  );
}


// ------------------------------------------------------------- prop store
//
// 405,582 props — trees, signs, signals, lamps, hydrants — are the largest
// object count in the map and about 65 MB of heap, all to hold a position, a
// kind, and at most one extra byte. Flat arrays instead.

/** Prop kinds, indexed by the store's `kind` array. Order is the wire format. */
export const PROP_KINDS = [
  "tree", "sign", "signal", "light", "meter", "furniture", "bikerack", "bump", "hydrant",
] as const;
export type PropKind = (typeof PROP_KINDS)[number];

const SIGN_KINDS = ["stop", "street-name", "other"] as const;

export interface PropStore {
  count: number;
  x: Float32Array;
  y: Float32Array;
  /** Index into {@link PROP_KINDS}. */
  kind: Uint8Array;
  /** Trees: canopy size 1-3. Signs: which sign. Zero elsewhere. */
  variant: Uint8Array;
  /** Signs: rotation quantised to 1/256 turn. Zero elsewhere. */
  rot: Uint8Array;
  tileSize: number;
  /** Occupied tile keys in ascending order. */
  tileKey: Uint32Array;
  /** Prop ranges for each tile; final entry is `count`. */
  tileStart: Uint32Array;
  /** Global tree ordinal by prop index, or -1 for non-trees. */
  treeOrdinal: Int32Array;
}

export function propRotation(s: PropStore, i: number): number {
  return (s.rot[i]! / 256) * Math.PI * 2;
}

export function encodeProps(props: Prop[], tile = 1000): Uint8Array {
  const q = (v: number): number => Math.fround(Math.round(v / GRID) * GRID);
  // Same tile ordering as buildings, for the same reasons: small deltas, and
  // a contiguous slice per tile if props ever stream.
  const order = props
    .map((p, i) => ({ i, key: tileKeyAt(q(p.x), q(p.y), tile) }))
    .sort((a, b) => a.key - b.key || a.i - b.i);

  const w = new Writer();
  w.u32(MAGIC);
  w.u32(FORMAT_VERSION);
  w.u32(props.length);
  const keys: number[] = [];
  const starts: number[] = [];
  for (let i = 0; i < order.length; i++) {
    const key = order[i]!.key;
    if (i === 0 || key !== order[i - 1]!.key) {
      keys.push(key);
      starts.push(i);
    }
  }
  w.u32(tile);
  w.u32(keys.length);
  let previousKey = 0;
  for (const key of keys) {
    w.varint(key - previousKey);
    previousKey = key;
  }
  for (const start of starts) w.varint(start);
  for (const { i } of order) {
    const p = props[i]!;
    w.u8(Math.max(0, (PROP_KINDS as readonly string[]).indexOf(p.kind)));
  }
  for (const { i } of order) {
    const p = props[i]!;
    if (p.kind === "tree") w.u8(p.size);
    else if (p.kind === "sign") w.u8(Math.max(0, (SIGN_KINDS as readonly string[]).indexOf(p.sign)));
    else w.u8(0);
  }
  for (const { i } of order) {
    const p = props[i]!;
    w.u8(p.kind === "sign" ? Math.round((p.rot / (Math.PI * 2)) * 256) & 0xff : 0);
  }
  let px = 0;
  let py = 0;
  for (const { i } of order) {
    const p = props[i]!;
    const qx = Math.round(p.x / GRID);
    const qy = Math.round(p.y / GRID);
    w.zig(qx - px);
    w.zig(qy - py);
    px = qx;
    py = qy;
  }
  return w.take();
}

export function decodeProps(bytes: Uint8Array): PropStore {
  const r = new Reader(bytes);
  if (r.u32() !== MAGIC) throw new Error("not a prop store");
  const version = r.u32();
  if (version !== FORMAT_VERSION) {
    throw new Error(`prop store is version ${version}, this build reads ${FORMAT_VERSION} — re-run scripts/stage-map.sh`);
  }
  const count = r.u32();
  const tileSize = r.u32();
  const tileCount = r.u32();
  if (tileCount > count + 1) throw new Error("prop store: tile table looks corrupt");
  const tileKey = new Uint32Array(tileCount);
  let previousKey = 0;
  for (let t = 0; t < tileCount; t++) {
    previousKey += r.varint();
    tileKey[t] = previousKey;
  }
  const tileStart = new Uint32Array(tileCount + 1);
  for (let t = 0; t < tileCount; t++) tileStart[t] = r.varint();
  tileStart[tileCount] = count;
  const kind = new Uint8Array(count);
  for (let i = 0; i < count; i++) kind[i] = r.u8();
  const treeOrdinal = new Int32Array(count).fill(-1);
  let tree = 0;
  for (let i = 0; i < count; i++) {
    if (PROP_KINDS[kind[i]!] === "tree") treeOrdinal[i] = tree++;
  }
  const variant = new Uint8Array(count);
  for (let i = 0; i < count; i++) variant[i] = r.u8();
  const rot = new Uint8Array(count);
  for (let i = 0; i < count; i++) rot[i] = r.u8();
  const x = new Float32Array(count);
  const y = new Float32Array(count);
  let px = 0;
  let py = 0;
  for (let i = 0; i < count; i++) {
    px += r.zig();
    py += r.zig();
    x[i] = px * GRID;
    y[i] = py * GRID;
  }
  return { count, x, y, kind, variant, rot, tileSize, tileKey, tileStart, treeOrdinal };
}

/** Straight from the object graph, for the server's small synthetic maps. */
export function storeFromProps(props: Prop[]): PropStore {
  return decodeProps(encodeProps(props, 1_000_000_000));
}

export function propStoreBytes(s: PropStore): number {
  return (
    s.x.byteLength +
    s.y.byteLength +
    s.kind.byteLength +
    s.variant.byteLength +
    s.rot.byteLength +
    s.tileKey.byteLength +
    s.tileStart.byteLength +
    s.treeOrdinal.byteLength
  );
}

// ----------------------------------------------------------- street store

export const ROAD_CLASSES = ["arterial", "collector", "local", "alley", "path"] as const;
const STREET_STRUCTS = ["", "bridge", "tunnel"] as const;

/** Compact street graph. Edge polylines live in one coordinate array; callers
 * retain edge indices rather than 84k objects and millions of `[x, y]` pairs. */
export interface StreetStore {
  nodeCount: number;
  nodeId: Uint32Array;
  nodeX: Float32Array;
  nodeY: Float32Array;
  edgeCount: number;
  edgeId: Uint32Array;
  a: Uint32Array;
  b: Uint32Array;
  pointStart: Uint32Array;
  coords: Float32Array;
  widthCm: Uint16Array;
  roadClass: Uint8Array;
  struct: Uint8Array;
  /** Deck level at each end, already un-biased. 1 = grade. */
  zlevA: Int8Array;
  zlevB: Int8Array;
  nameIndex: Uint32Array;
  names: string[];
  /** Render-only midpoint index. Graph edge order remains unchanged. */
  tileSize: number;
  tileKey: Uint32Array;
  tileStart: Uint32Array;
  tileEdge: Uint32Array;
}

export function encodeStreets(map: Pick<GameMap, "nodes" | "edges">): Uint8Array {
  const w = new Writer();
  w.u32(MAGIC);
  w.u32(FORMAT_VERSION);
  w.u32(map.nodes.length);
  w.u32(map.edges.length);

  let previousId = 0;
  let px = 0;
  let py = 0;
  for (const node of map.nodes) {
    w.zig(node.id - previousId);
    previousId = node.id;
    const qx = Math.round(node.x / GRID);
    const qy = Math.round(node.y / GRID);
    w.zig(qx - px);
    w.zig(qy - py);
    px = qx;
    py = qy;
  }

  let totalPoints = 0;
  for (const edge of map.edges) {
    w.varint(edge.polyline.length);
    totalPoints += edge.polyline.length;
  }
  w.u32(totalPoints);

  previousId = 0;
  let previousA = 0;
  let previousB = 0;
  for (const edge of map.edges) {
    w.zig(edge.id - previousId);
    w.zig(edge.a - previousA);
    w.zig(edge.b - previousB);
    previousId = edge.id;
    previousA = edge.a;
    previousB = edge.b;
    w.varint(Math.max(0, Math.min(65535, Math.round(edge.width * 100))));
    const roadClass = (ROAD_CLASSES as readonly string[]).indexOf(edge.class);
    w.u8(roadClass < 0 ? ROAD_CLASSES.indexOf("local") : roadClass);
    w.u8(Math.max(0, STREET_STRUCTS.indexOf(edge.struct ?? "")));
    // Deck levels, biased so the -2..5 domain fits an unsigned byte.
    w.u8(Math.max(0, Math.min(255, (edge.zlev?.[0] ?? 1) + ZLEV_BIAS)));
    w.u8(Math.max(0, Math.min(255, (edge.zlev?.[1] ?? 1) + ZLEV_BIAS)));
  }

  // Keep graph order stable for routing, and store a separate render index
  // grouped by midpoint tile. This removes the client's boxed by-tile Map.
  const tileSize = 1000;
  const renderOrder = map.edges
    .map((edge, index) => {
      const point = edge.polyline[Math.floor(edge.polyline.length / 2)] ?? [0, 0];
      return { index, key: tileKeyAt(point[0], point[1], tileSize) };
    })
    .sort((a, b) => a.key - b.key || a.index - b.index);
  const tileKeys: number[] = [];
  const tileStarts: number[] = [];
  for (let i = 0; i < renderOrder.length; i++) {
    if (i === 0 || renderOrder[i]!.key !== renderOrder[i - 1]!.key) {
      tileKeys.push(renderOrder[i]!.key);
      tileStarts.push(i);
    }
  }
  w.u32(tileSize);
  w.u32(tileKeys.length);
  let previousTile = 0;
  for (const key of tileKeys) {
    w.varint(key - previousTile);
    previousTile = key;
  }
  for (const start of tileStarts) w.varint(start);
  for (const item of renderOrder) w.varint(item.index);

  const names = [...new Set(map.edges.map((edge) => edge.name ?? ""))];
  const nameAt = new Map(names.map((name, i) => [name, i]));
  const encoder = new TextEncoder();
  w.u32(names.length);
  for (const name of names) {
    const bytes = encoder.encode(name);
    w.varint(bytes.length);
    w.raw(bytes);
  }
  for (const edge of map.edges) w.varint(nameAt.get(edge.name ?? "") ?? 0);

  px = 0;
  py = 0;
  for (const edge of map.edges) {
    for (const [x, y] of edge.polyline) {
      const qx = Math.round(x / GRID);
      const qy = Math.round(y / GRID);
      w.zig(qx - px);
      w.zig(qy - py);
      px = qx;
      py = qy;
    }
  }
  return w.take();
}

export function decodeStreets(bytes: Uint8Array): StreetStore {
  const r = new Reader(bytes);
  if (r.u32() !== MAGIC) throw new Error("not a street store");
  const version = r.u32();
  if (version !== FORMAT_VERSION) {
    throw new Error(`street store is version ${version}, this build reads ${FORMAT_VERSION} — re-run scripts/stage-map.sh`);
  }
  const nodeCount = r.u32();
  const edgeCount = r.u32();
  const nodeId = new Uint32Array(nodeCount);
  const nodeX = new Float32Array(nodeCount);
  const nodeY = new Float32Array(nodeCount);
  let previousId = 0;
  let px = 0;
  let py = 0;
  for (let i = 0; i < nodeCount; i++) {
    previousId += r.zig();
    px += r.zig();
    py += r.zig();
    nodeId[i] = previousId;
    nodeX[i] = px * GRID;
    nodeY[i] = py * GRID;
  }

  const pointStart = new Uint32Array(edgeCount + 1);
  for (let i = 0; i < edgeCount; i++) pointStart[i + 1] = pointStart[i]! + r.varint();
  const totalPoints = r.u32();
  if (pointStart[edgeCount] !== totalPoints) throw new Error("street store: point count mismatch");

  const edgeId = new Uint32Array(edgeCount);
  const a = new Uint32Array(edgeCount);
  const b = new Uint32Array(edgeCount);
  const widthCm = new Uint16Array(edgeCount);
  const roadClass = new Uint8Array(edgeCount);
  const struct = new Uint8Array(edgeCount);
  const zlevA = new Int8Array(edgeCount);
  const zlevB = new Int8Array(edgeCount);
  previousId = 0;
  let previousA = 0;
  let previousB = 0;
  for (let i = 0; i < edgeCount; i++) {
    previousId += r.zig();
    previousA += r.zig();
    previousB += r.zig();
    edgeId[i] = previousId;
    a[i] = previousA;
    b[i] = previousB;
    widthCm[i] = r.varint();
    roadClass[i] = r.u8();
    struct[i] = r.u8();
    zlevA[i] = r.u8() - ZLEV_BIAS;
    zlevB[i] = r.u8() - ZLEV_BIAS;
  }

  const tileSize = r.u32();
  const tileCount = r.u32();
  if (tileCount > edgeCount + 1) throw new Error("street store: tile table looks corrupt");
  const tileKey = new Uint32Array(tileCount);
  let previousTile = 0;
  for (let tile = 0; tile < tileCount; tile++) {
    previousTile += r.varint();
    tileKey[tile] = previousTile;
  }
  const tileStart = new Uint32Array(tileCount + 1);
  for (let tile = 0; tile < tileCount; tile++) tileStart[tile] = r.varint();
  tileStart[tileCount] = edgeCount;
  const tileEdge = new Uint32Array(edgeCount);
  for (let i = 0; i < edgeCount; i++) tileEdge[i] = r.varint();

  const decoder = new TextDecoder();
  const names = new Array<string>(r.u32());
  for (let i = 0; i < names.length; i++) names[i] = decoder.decode(r.raw(r.varint()));
  const nameIndex = new Uint32Array(edgeCount);
  for (let i = 0; i < edgeCount; i++) nameIndex[i] = r.varint();

  const coords = new Float32Array(totalPoints * 2);
  px = 0;
  py = 0;
  for (let i = 0; i < totalPoints; i++) {
    px += r.zig();
    py += r.zig();
    coords[i * 2] = px * GRID;
    coords[i * 2 + 1] = py * GRID;
  }
  return {
    nodeCount, nodeId, nodeX, nodeY, edgeCount, edgeId, a, b,
    pointStart, coords, widthCm, roadClass, struct, zlevA, zlevB, nameIndex, names,
    tileSize, tileKey, tileStart, tileEdge,
  };
}

/** Render tile table index, or -1 when no street midpoint occupies the key. */
export function findStreetTile(store: StreetStore, key: number): number {
  let lo = 0;
  let hi = store.tileKey.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const value = store.tileKey[mid]!;
    if (value === key) return mid;
    if (value < key) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

export function streetClass(store: StreetStore, edge: number): RoadClass {
  return ROAD_CLASSES[store.roadClass[edge]!] ?? "local";
}

export function streetStruct(store: StreetStore, edge: number): StreetEdge["struct"] {
  const value = STREET_STRUCTS[store.struct[edge]!] ?? "";
  return value || undefined;
}

export function streetPolyline(store: StreetStore, edge: number): [number, number][] {
  const points: [number, number][] = [];
  const from = store.pointStart[edge]!;
  const to = store.pointStart[edge + 1]!;
  for (let i = from; i < to; i++) points.push([store.coords[i * 2]!, store.coords[i * 2 + 1]!]);
  return points;
}

export function streetEdge(store: StreetStore, edge: number): StreetEdge {
  return {
    id: store.edgeId[edge]!,
    a: store.a[edge]!,
    b: store.b[edge]!,
    polyline: streetPolyline(store, edge),
    width: store.widthCm[edge]! / 100,
    name: store.names[store.nameIndex[edge]!] ?? "",
    class: streetClass(store, edge),
    struct: streetStruct(store, edge),
    zlev: [store.zlevA[edge]!, store.zlevB[edge]!],
  };
}

export function streetStoreBytes(store: StreetStore): number {
  return (
    store.nodeId.byteLength + store.nodeX.byteLength + store.nodeY.byteLength +
    store.edgeId.byteLength + store.a.byteLength + store.b.byteLength +
    store.pointStart.byteLength + store.coords.byteLength + store.widthCm.byteLength +
    store.roadClass.byteLength + store.struct.byteLength + store.zlevA.byteLength +
    store.zlevB.byteLength + store.nameIndex.byteLength +
    store.tileKey.byteLength + store.tileStart.byteLength + store.tileEdge.byteLength +
    store.names.reduce((sum, name) => sum + name.length * 2, 0)
  );
}

// ------------------------------------------------------------- city LOD2

export interface CityLod {
  cols: number;
  rows: number;
  cellSize: number;
  /** RGBA urban-mass texels, south-to-north row order. */
  data: Uint8Array;
}

/** Bake a far-zoom urban mass texture. It deliberately captures density and
 * height rather than individual footprints: at this zoom buildings are
 * subpixel, while neighborhood massing and the street gaps still read. */
export function encodeCityLod(map: Pick<GameMap, "meta" | "buildings">, cellSize = 160): Uint8Array {
  const cols = Math.max(1, Math.ceil(map.meta.width / cellSize));
  const rows = Math.max(1, Math.ceil(map.meta.height / cellSize));
  const count = new Uint16Array(cols * rows);
  const height = new Uint16Array(cols * rows);
  for (const building of map.buildings) {
    if (!building.footprint.length) continue;
    let x = 0;
    let y = 0;
    for (const point of building.footprint) {
      x += point[0];
      y += point[1];
    }
    x /= building.footprint.length;
    y /= building.footprint.length;
    const col = Math.max(0, Math.min(cols - 1, Math.floor(x / cellSize)));
    const row = Math.max(0, Math.min(rows - 1, Math.floor(y / cellSize)));
    const at = row * cols + col;
    count[at] = Math.min(65535, count[at]! + 1);
    height[at] = Math.max(height[at]!, Math.min(65535, Math.round(building.height * 10)));
  }
  const data = new Uint8Array(cols * rows * 4);
  for (let i = 0; i < count.length; i++) {
    const density = Math.min(1, Math.log2(1 + count[i]!) / 6);
    const tall = Math.min(1, height[i]! / 500);
    data[i * 4] = Math.round(54 + tall * 44);
    data[i * 4 + 1] = Math.round(61 + tall * 42);
    data[i * 4 + 2] = Math.round(72 + tall * 50);
    data[i * 4 + 3] = Math.round(density * 225);
  }
  const w = new Writer();
  w.u32(MAGIC);
  w.u32(FORMAT_VERSION);
  w.u32(cols);
  w.u32(rows);
  w.u32(cellSize);
  w.raw(data);
  return w.take();
}

export function decodeCityLod(bytes: Uint8Array): CityLod {
  const r = new Reader(bytes);
  if (r.u32() !== MAGIC) throw new Error("not a city LOD store");
  const version = r.u32();
  if (version !== FORMAT_VERSION) {
    throw new Error(`city LOD is version ${version}, this build reads ${FORMAT_VERSION} — re-run scripts/stage-map.sh`);
  }
  const cols = r.u32();
  const rows = r.u32();
  const cellSize = r.u32();
  const expected = cols * rows * 4;
  const data = new Uint8Array(expected);
  data.set(r.raw(expected));
  return { cols, rows, cellSize, data };
}


// ----------------------------------------------------------- feature store
//
// Sidewalks, lane markings, trails, parks, water: ring sets and polylines
// with at most a style byte. Same offset-table shape as buildings, which is
// the only thing they have in common with each other.

export interface FeatureStore {
  count: number;
  /** Index into `ringOffset`, per feature. Length count + 1. */
  ringStart: Uint32Array;
  /** Index into `coords` (in PAIRS). Length totalRings + 1. */
  ringOffset: Uint32Array;
  coords: Float32Array;
  /** One byte per feature — a style or kind enum. Zero when the layer has no
   * such notion. */
  attr: Uint8Array;
  tileSize: number;
  tileKey: Uint32Array;
  tileStart: Uint32Array;
}

export interface FeatureInput {
  rings: [number, number][][];
  attr?: number;
}

const EMPTY_FEATURES: FeatureStore = {
  count: 0,
  ringStart: new Uint32Array(1),
  ringOffset: new Uint32Array(1),
  coords: new Float32Array(0),
  attr: new Uint8Array(0),
  tileSize: 1000,
  tileKey: new Uint32Array(0),
  tileStart: new Uint32Array(1),
};

function writeFeatures(w: Writer, features: FeatureInput[], tile: number): void {
  const q = (v: number): number => Math.fround(Math.round(v / GRID) * GRID);
  // Tile-sorted for the same reason buildings are: neighbouring features make
  // small coordinate deltas, and the renderer reads them by locality.
  const order = features
    .map((f, i) => {
      const p = f.rings[0]?.[0] ?? [0, 0];
      return { i, key: tileKeyAt(q(p[0]), q(p[1]), tile) };
    })
    .sort((a, b) => a.key - b.key || a.i - b.i);

  w.u32(features.length);
  let totalVerts = 0;
  for (const { i } of order) {
    const f = features[i]!;
    w.varint(f.rings.length);
    for (const r of f.rings) {
      w.varint(r.length);
      totalVerts += r.length;
    }
  }
  w.u32(totalVerts);
  const keys: number[] = [];
  const starts: number[] = [];
  for (let i = 0; i < order.length; i++) {
    const key = order[i]!.key;
    if (i === 0 || key !== order[i - 1]!.key) {
      keys.push(key);
      starts.push(i);
    }
  }
  w.u32(tile);
  w.u32(keys.length);
  let previousKey = 0;
  for (const key of keys) {
    w.varint(key - previousKey);
    previousKey = key;
  }
  for (const start of starts) w.varint(start);
  for (const { i } of order) w.u8(features[i]!.attr ?? 0);
  let px = 0;
  let py = 0;
  for (const { i } of order) {
    for (const ring of features[i]!.rings) {
      for (const [x, y] of ring) {
        const qx = Math.round(x / GRID);
        const qy = Math.round(y / GRID);
        w.zig(qx - px);
        w.zig(qy - py);
        px = qx;
        py = qy;
      }
    }
  }
}

function readFeatures(r: Reader): FeatureStore {
  const count = r.u32();
  const ringStart = new Uint32Array(count + 1);
  const lens: number[] = [];
  for (let f = 0; f < count; f++) {
    const rings = r.varint();
    ringStart[f + 1] = ringStart[f]! + rings;
    for (let k = 0; k < rings; k++) lens.push(r.varint());
  }
  const totalVerts = r.u32();
  const ringOffset = new Uint32Array(lens.length + 1);
  for (let i = 0; i < lens.length; i++) ringOffset[i + 1] = ringOffset[i]! + lens[i]!;
  if (ringOffset[lens.length] !== totalVerts) throw new Error("feature store: vertex count mismatch");
  const tileSize = r.u32();
  const tileCount = r.u32();
  if (tileCount > count + 1) throw new Error("feature store: tile table looks corrupt");
  const tileKey = new Uint32Array(tileCount);
  let previousKey = 0;
  for (let tile = 0; tile < tileCount; tile++) {
    previousKey += r.varint();
    tileKey[tile] = previousKey;
  }
  const tileStart = new Uint32Array(tileCount + 1);
  for (let tile = 0; tile < tileCount; tile++) tileStart[tile] = r.varint();
  tileStart[tileCount] = count;
  const attr = new Uint8Array(count);
  for (let f = 0; f < count; f++) attr[f] = r.u8();
  const coords = new Float32Array(totalVerts * 2);
  let px = 0;
  let py = 0;
  for (let i = 0; i < totalVerts; i++) {
    px += r.zig();
    py += r.zig();
    coords[i * 2] = px * GRID;
    coords[i * 2 + 1] = py * GRID;
  }
  return { count, ringStart, ringOffset, coords, attr, tileSize, tileKey, tileStart };
}

/** Feature tile table index, or -1 when the tile is empty. */
export function findFeatureTile(store: FeatureStore, key: number): number {
  let lo = 0;
  let hi = store.tileKey.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const value = store.tileKey[mid]!;
    if (value === key) return mid;
    if (value < key) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** Rings of one feature, as the object graph the mesh builders still want.
 * Called per TILE, never over a whole layer — that would rebuild exactly what
 * the store exists to delete. */
export function featureRings(s: FeatureStore, f: number): [number, number][][] {
  const out: [number, number][][] = [];
  for (let k = s.ringStart[f]!; k < s.ringStart[f + 1]!; k++) {
    const ring: [number, number][] = [];
    for (let i = s.ringOffset[k]!; i < s.ringOffset[k + 1]!; i++) {
      ring.push([s.coords[i * 2]!, s.coords[i * 2 + 1]!]);
    }
    out.push(ring);
  }
  return out;
}

/** First vertex of a feature, for filing it into a tile without building it. */
export function featureAnchor(s: FeatureStore, f: number): [number, number] {
  const i = s.ringOffset[s.ringStart[f]!]!;
  return [s.coords[i * 2]!, s.coords[i * 2 + 1]!];
}

export function featureStoreBytes(s: FeatureStore): number {
  return (
    s.ringStart.byteLength + s.ringOffset.byteLength + s.coords.byteLength +
    s.attr.byteLength + s.tileKey.byteLength + s.tileStart.byteLength
  );
}

// --------------------------------------------------------- layer container
//
// One file rather than one per layer: nine more round trips at boot would
// cost more than the bytes do.

export type LayerName =
  | "sidewalks" | "markingAreas" | "markingLines" | "trails" | "rails"
  | "water" | "parks" | "railYards" | "bridges";

export const LAYER_NAMES: LayerName[] = [
  "sidewalks", "markingAreas", "markingLines", "trails", "rails", "water", "parks", "railYards", "bridges",
];

export type LayerStores = Record<LayerName, FeatureStore>;

export function encodeLayers(layers: Partial<Record<LayerName, FeatureInput[]>>, tile = 1000): Uint8Array {
  const w = new Writer();
  w.u32(MAGIC);
  w.u32(FORMAT_VERSION);
  w.u32(LAYER_NAMES.length);
  for (const name of LAYER_NAMES) writeFeatures(w, layers[name] ?? [], tile);
  return w.take();
}

export function decodeLayers(bytes: Uint8Array): LayerStores {
  const r = new Reader(bytes);
  if (r.u32() !== MAGIC) throw new Error("not a layer store");
  const version = r.u32();
  if (version !== FORMAT_VERSION) {
    throw new Error(`layer store is version ${version}, this build reads ${FORMAT_VERSION} — re-run scripts/stage-map.sh`);
  }
  const n = r.u32();
  // LAYER_NAMES is append-only and the container is positional, so a store
  // written before a layer existed is simply short. Read what is there and
  // leave the rest empty rather than refusing to boot: the published map is a
  // release asset that necessarily lags a build which adds a layer, and a
  // hard failure there takes the whole city down to gain nothing.
  if (n > LAYER_NAMES.length) {
    throw new Error(
      `layer store has ${n} layers, this build knows ${LAYER_NAMES.length} — the map is newer than the client`,
    );
  }
  const out = {} as LayerStores;
  for (let i = 0; i < LAYER_NAMES.length; i++) {
    out[LAYER_NAMES[i]!] = i < n ? readFeatures(r) : EMPTY_FEATURES;
  }
  return out;
}

export function emptyLayers(): LayerStores {
  const out = {} as LayerStores;
  for (const name of LAYER_NAMES) out[name] = EMPTY_FEATURES;
  return out;
}


/**
 * The GameMap -> layer-input mapping, in one place: the bake and any tool
 * that needs stores from an object-graph map must agree on what `attr` means
 * per layer, and duplicating that was already one enum away from a silent
 * style swap.
 */
export function layerInputs(map: GameMap): Partial<Record<LayerName, FeatureInput[]>> {
  const railKinds = ["rail", "max", "streetcar", "wes"];
  return {
    sidewalks: (map.sidewalks ?? []).map((f) => ({ rings: f.rings })),
    markingAreas: (map.markingAreas ?? []).map((f) => ({ rings: f.rings, attr: f.style === "yellow" ? 1 : 0 })),
    markingLines: (map.markingLines ?? []).map((f) => ({ rings: [f.polyline], attr: f.style === "yellow" ? 1 : 0 })),
    trails: (map.trails ?? []).map((f) => ({ rings: [f.polyline] })),
    rails: (map.rails ?? []).map((f) => ({ rings: [f.polyline], attr: Math.max(0, railKinds.indexOf(f.kind)) })),
    water: (map.water ?? []).map((f) => ({ rings: f.rings })),
    parks: (map.parks ?? []).map((f) => ({ rings: f.rings })),
    railYards: (map.railYards ?? []).map((f) => ({ rings: f.rings })),
    bridges: (map.bridges ?? []).map((f) => ({ rings: f.rings, attr: f.kind === "river" ? 1 : 0 })),
  };
}

/** Layer stores straight from an object-graph map, for tools and tests. */
export function layersFromMap(map: GameMap): LayerStores {
  return decodeLayers(encodeLayers(layerInputs(map)));
}
