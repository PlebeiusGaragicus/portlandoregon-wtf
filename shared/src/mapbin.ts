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
import type { Building, GameMap } from "./map.js";

const MAGIC = 0x424a4231; // "BJB1"
/** Coordinate quantisation. 1 cm costs ~2 MB of download over 5 cm and buys
 * precision headroom we may want for FPV; the round-trip error it introduces
 * (~2 mm, dominated by Float32 rounding at city scale) is far below anything
 * visible. */
const GRID = 0.01;

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
  const order = map.buildings
    .map((b, i) => {
      const [x, y] = b.footprint[0] ?? [0, 0];
      return { i, key: Math.floor(y / tile) * 4096 + Math.floor(x / tile) };
    })
    .sort((a, b) => a.key - b.key || a.i - b.i);

  const w = new Writer();
  w.u32(MAGIC);
  w.u32(1); // format version
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
  if (version !== 1) throw new Error(`unsupported building store version ${version}`);
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
  return { count, ringStart, ringOffset, coords, heightDm, use, id };
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
    s.id.byteLength
  );
}
