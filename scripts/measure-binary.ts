// Measures what a binary map would actually cost to download.
//
//   npx tsx --max-old-space-size=8192 scripts/measure-binary.ts
//
// The optimization proposal's softest claim is that a typed-array map format
// compresses to "similar to or below" today's 32 MB of gzipped JSON. That is
// the one number that could come out WORSE than what we ship now — JSON
// decimal text is verbose but extremely gzip-friendly, and float bit patterns
// are close to incompressible noise. So measure it before designing around it.
//
// Every layer in the map is encoded, including street names and landmark text,
// so the totals are comparable to map.json.gz rather than flattering.
//
// Three coordinate encodings are compared, since that is where nearly all the
// bytes are (~4.5M coordinate pairs):
//
//   f32     absolute Float32, planar (all x, then all y)
//   u16     tile-local Uint16 — features sorted into 1 km tiles, offsets from
//           the tile corner at 1000/65535 = 1.5 cm resolution
//   varint  per-ring delta, zigzag LEB128, quantised to a fixed grid
//
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gunzipSync, gzipSync } from "node:zlib";
import type { GameMap } from "@portlandoregon/shared";

const MAP_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "../client/src/public/map");

// ---------------------------------------------------------------- byte sink

class Writer {
  private buf = new Uint8Array(1 << 22);
  len = 0;

  private room(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  u8(v: number): void {
    this.room(1);
    this.buf[this.len++] = v & 0xff;
  }

  /** Unsigned LEB128. */
  varint(v: number): void {
    this.room(5);
    let x = v >>> 0;
    while (x >= 0x80) {
      this.buf[this.len++] = (x & 0x7f) | 0x80;
      x = Math.floor(x / 128);
    }
    this.buf[this.len++] = x;
  }

  /** Signed, zigzagged so small negatives stay one byte. */
  zig(v: number): void {
    this.varint(v < 0 ? -2 * v - 1 : 2 * v);
  }

  bytes(b: Uint8Array): void {
    this.room(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }

  take(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const gz = (b: Uint8Array): number => gzipSync(b, { level: 9 }).length;
const br = (b: Uint8Array): number =>
  brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: b.length } })
    .length;
const mb = (n: number): string => `${(n / 1e6).toFixed(1)} MB`;

// ------------------------------------------------------- coordinate packing

type Ring = [number, number][];
/** A feature is one or more rings/polylines; a point feature is a 1-vertex ring. */
type Feature = Ring[];

const TILE = 1000;

/** Absolute Float32, planar (all x then all y — same-magnitude values adjacent
 * gives the compressor its best shot at a float layout). */
function packF32(features: Feature[]): Uint8Array {
  let n = 0;
  for (const f of features) for (const r of f) n += r.length;
  const xs = new Float32Array(n);
  const ys = new Float32Array(n);
  let i = 0;
  for (const f of features) {
    for (const r of f) {
      for (const [x, y] of r) {
        xs[i] = x;
        ys[i] = y;
        i++;
      }
    }
  }
  return concat([new Uint8Array(xs.buffer), new Uint8Array(ys.buffer)]);
}

/** Tile-local Uint16: features sorted by 1 km tile, each vertex an offset from
 * its tile's corner. 1.5 cm resolution. Vertices outside the feature's own
 * tile (a footprint straddling a tile line) clamp — measured below. */
function packU16(features: Feature[]): { bytes: Uint8Array; clamped: number } {
  const keyed = features.map((f) => {
    const [x0, y0] = f[0]?.[0] ?? [0, 0];
    const tx = Math.floor(x0 / TILE);
    const ty = Math.floor(y0 / TILE);
    return { f, tx, ty, key: ty * 4096 + tx };
  });
  keyed.sort((a, b) => a.key - b.key);
  let n = 0;
  for (const k of keyed) for (const r of k.f) n += r.length;
  const xs = new Uint16Array(n);
  const ys = new Uint16Array(n);
  let i = 0;
  let clamped = 0;
  for (const k of keyed) {
    for (const r of k.f) {
      for (const [x, y] of r) {
        const lx = Math.round(((x - k.tx * TILE) / TILE) * 65535);
        const ly = Math.round(((y - k.ty * TILE) / TILE) * 65535);
        if (lx < 0 || lx > 65535 || ly < 0 || ly > 65535) clamped++;
        xs[i] = Math.max(0, Math.min(65535, lx));
        ys[i] = Math.max(0, Math.min(65535, ly));
        i++;
      }
    }
  }
  return { bytes: concat([new Uint8Array(xs.buffer), new Uint8Array(ys.buffer)]), clamped };
}

/** Per-ring delta + zigzag varint on a fixed grid. Features are tile-sorted
 * first so consecutive features are neighbours and their first vertices delta
 * cheaply too. */
function packVarint(features: Feature[], grid: number): Uint8Array {
  const keyed = features.map((f) => {
    const [x0, y0] = f[0]?.[0] ?? [0, 0];
    return { f, key: Math.floor(y0 / TILE) * 4096 + Math.floor(x0 / TILE) };
  });
  keyed.sort((a, b) => a.key - b.key);
  const w = new Writer();
  const q = (v: number): number => Math.round(v / grid);
  let px = 0;
  let py = 0;
  for (const k of keyed) {
    for (const r of k.f) {
      for (const [x, y] of r) {
        const qx = q(x);
        const qy = q(y);
        w.zig(qx - px);
        w.zig(qy - py);
        px = qx;
        py = qy;
      }
    }
  }
  return w.take();
}

// ------------------------------------------------------------ map traversal

const t0 = performance.now();
const map = JSON.parse(gunzipSync(readFileSync(join(MAP_DIR, "map.json.gz"))).toString("utf8")) as GameMap;
console.log(`parsed map in ${((performance.now() - t0) / 1000).toFixed(1)}s\n`);

const jsonGz = readFileSync(join(MAP_DIR, "map.json.gz")).length;

/** Every coordinate in the map, as features, plus the non-coordinate payload
 * each layer needs (heights, classes, ids, names...). */
const features: Feature[] = [];
const attrs = new Writer();
let vertexCount = 0;

function addFeature(rings: Feature): void {
  features.push(rings);
  for (const r of rings) vertexCount += r.length;
}

// Buildings: ring counts, height in decimetres, use enum.
const USES = ["sfr", "mfr", "com", "off", "ind", "inst", "other"];
for (const b of map.buildings) {
  const rings: Feature = [b.footprint, ...(b.holes ?? [])];
  addFeature(rings);
  attrs.varint(rings.length);
  for (const r of rings) attrs.varint(r.length);
  attrs.varint(Math.min(65535, Math.round(b.height * 10)));
  attrs.u8(Math.max(0, USES.indexOf(b.use ?? "other")));
}

// Street graph. Node ids are dense after a re-index, so edges reference them
// as varints; names go through a dictionary (84k edges, far fewer streets).
for (const n of map.nodes) addFeature([[[n.x, n.y]]]);
const CLASSES = ["arterial", "collector", "local", "alley", "path"];
const nameIds = new Map<string, number>();
for (const e of map.edges) {
  addFeature([e.polyline]);
  attrs.varint(e.polyline.length);
  attrs.varint(e.a);
  attrs.varint(e.b);
  attrs.u8(Math.round(e.width * 4));
  attrs.u8(Math.max(0, CLASSES.indexOf(e.class)) | (e.struct === "bridge" ? 0x40 : e.struct === "tunnel" ? 0x80 : 0));
  let id = nameIds.get(e.name);
  if (id === undefined) nameIds.set(e.name, (id = nameIds.size));
  attrs.varint(id);
}
const nameBlob = new TextEncoder().encode([...nameIds.keys()].join("\n"));

// Props: kind enum + the one extra field some kinds carry.
for (const p of map.props) {
  addFeature([[[p.x, p.y]]]);
  attrs.u8(["tree", "sign", "signal", "light", "meter", "furniture", "bikerack", "bump", "hydrant"].indexOf(p.kind));
  if (p.kind === "tree") attrs.u8(p.size);
  if (p.kind === "sign") attrs.u8(Math.round((p.rot / (Math.PI * 2)) * 255) & 0xff);
}

// Polygon layers: water, parks, rail yards, sidewalks, painted areas.
for (const layer of [map.water, map.parks, map.railYards, map.sidewalks]) {
  for (const p of layer ?? []) {
    addFeature(p.rings);
    attrs.varint(p.rings.length);
    for (const r of p.rings) attrs.varint(r.length);
  }
}
for (const a of map.markingAreas ?? []) {
  addFeature(a.rings);
  attrs.varint(a.rings.length);
  for (const r of a.rings) attrs.varint(r.length);
  attrs.u8(a.style === "yellow" ? 1 : 0);
}

// Polyline layers: trails, rails, lane markings.
for (const t of map.trails ?? []) {
  addFeature([t.polyline]);
  attrs.varint(t.polyline.length);
}
for (const r of map.rails ?? []) {
  addFeature([r.polyline]);
  attrs.varint(r.polyline.length);
  attrs.u8(["rail", "max", "streetcar", "wes"].indexOf(r.kind));
}
for (const l of map.markingLines ?? []) {
  addFeature([l.polyline]);
  attrs.varint(l.polyline.length);
  attrs.u8(l.style === "yellow" ? 1 : 0);
}

// Text-carrying layers stay as a UTF-8 blob — there is no packing trick for
// names, and pretending otherwise would flatter the total.
const textParts: string[] = [];
for (const s of map.railStops ?? []) {
  addFeature([[[s.x, s.y]]]);
  attrs.u8(["max", "streetcar", "wes"].indexOf(s.kind));
  textParts.push(s.name);
}
for (const m of map.landmarks ?? []) {
  addFeature([[[m.x, m.y]]]);
  attrs.u8(["fire-station", "police", "hospital", "city-hall", "school"].indexOf(m.kind));
  attrs.varint((m.buildingIds ?? []).length);
  for (const id of m.buildingIds ?? []) attrs.varint(id);
  textParts.push(m.label, m.name, m.address);
}
const textBlob = new TextEncoder().encode(textParts.join("\n"));

const attrBytes = attrs.take();
console.log(`features: ${features.length}, vertices: ${(vertexCount / 1e6).toFixed(2)}M`);
console.log(`attributes: ${mb(attrBytes.length)} raw, ${mb(gz(attrBytes))} gzipped`);
console.log(`street names: ${nameIds.size} unique, ${mb(nameBlob.length)} raw, ${mb(gz(nameBlob))} gzipped`);
console.log(`other text: ${mb(textBlob.length)} raw, ${mb(gz(textBlob))} gzipped\n`);

// ---------------------------------------------------------------- the table

const fixed = concat([attrBytes, nameBlob, textBlob]);
const u16 = packU16(features);
const candidates: { name: string; coords: Uint8Array; note?: string }[] = [
  { name: "f32 absolute", coords: packF32(features) },
  { name: "u16 tile-local", coords: u16.bytes, note: `${u16.clamped} vertices clamped outside their tile` },
  { name: "varint delta 1 cm", coords: packVarint(features, 0.01) },
  { name: "varint delta 5 cm", coords: packVarint(features, 0.05) },
  { name: "varint delta 25 cm", coords: packVarint(features, 0.25) },
];

console.log(`today: map.json.gz = ${mb(jsonGz)} on the wire\n`);
console.log("encoding             raw      gzip -9   brotli 11   vs JSON gz");
console.log("-".repeat(68));
for (const c of candidates) {
  const whole = concat([c.coords, fixed]);
  const g = gz(whole);
  const b = br(whole);
  const delta = ((g / jsonGz - 1) * 100).toFixed(0);
  console.log(
    `${c.name.padEnd(20)} ${mb(whole.length).padStart(8)} ${mb(g).padStart(9)} ${mb(b).padStart(11)}` +
      `   ${(g <= jsonGz ? "" : "+") + delta}%`,
  );
  if (c.note) console.log(`  ${" ".repeat(18)} note: ${c.note}`);
}
console.log("\n(brotli is a fair comparison only if the web server serves .br — most do by\n default for precompressed files, and every browser we care about accepts it.)");

// --------------------------------------------------------- the other side
//
// The wire format and the resident format are separable: a varint stream
// decodes INTO the same Float32Array a f32 file would have been. So the only
// thing varint costs is a decode pass, and that has to be weighed against
// JSON.parse's 0.94 s — which is what it replaces, not what it adds to.

function decodeVarint(bytes: Uint8Array, n: number, grid: number): Float32Array {
  const out = new Float32Array(n * 2);
  let at = 0;
  let px = 0;
  let py = 0;
  for (let i = 0; i < n * 2; i += 2) {
    let shift = 1;
    let v = 0;
    let byte = 0;
    do {
      byte = bytes[at++]!;
      v += (byte & 0x7f) * shift;
      shift *= 128;
    } while (byte & 0x80);
    px += v & 1 ? -(v + 1) / 2 : v / 2;
    shift = 1;
    v = 0;
    do {
      byte = bytes[at++]!;
      v += (byte & 0x7f) * shift;
      shift *= 128;
    } while (byte & 0x80);
    py += v & 1 ? -(v + 1) / 2 : v / 2;
    out[i] = px * grid;
    out[i + 1] = py * grid;
  }
  return out;
}

const stream = packVarint(features, 0.01);
const t2 = performance.now();
const decoded = decodeVarint(stream, vertexCount, 0.01);
const decodeMs = performance.now() - t2;
console.log(`\nvarint 1 cm decode: ${decodeMs.toFixed(0)} ms into a ${mb(decoded.byteLength)} Float32Array`);
console.log("(replaces JSON.parse, measured at 940 ms — not additional to it)");

// Round-trip accuracy, against the same tile-sorted order the encoder used.
const order = features
  .map((f, i) => ({ f, i, key: Math.floor((f[0]?.[0]?.[1] ?? 0) / TILE) * 4096 + Math.floor((f[0]?.[0]?.[0] ?? 0) / TILE) }))
  .sort((a, b) => a.key - b.key);
let worst = 0;
let at = 0;
for (const { f } of order) {
  for (const r of f) {
    for (const [x, y] of r) {
      worst = Math.max(worst, Math.abs(decoded[at]! - x), Math.abs(decoded[at + 1]! - y));
      at += 2;
    }
  }
}
console.log(`worst round-trip error: ${(worst * 1000).toFixed(1)} mm`);
