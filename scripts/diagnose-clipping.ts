// Why do the draped ground layers clip into each other?
//
//   npx tsx --max-old-space-size=8192 scripts/diagnose-clipping.ts
//
// Two candidate causes, and they call for completely different fixes:
//
//   decal vs TERRAIN   a decal triangle spans a fold in the heightfield, so
//                      its flat interior sinks below the ground it is painted
//                      on. Needs conforming geometry — or flattening.
//   decal vs DECAL     two layers overlap in plan and their surfaces cross,
//                      so the intended stacking order inverts. Fixable
//                      cheaply with depthWrite/renderOrder — no pipeline.
//
// The layers sit 1-9 cm apart in Y (sidewalk 0.03, street 0.09, rail 0.10,
// marking 0.15, trail 0.18), so the question that decides it is how far a
// draped triangle strays from the terrain between its vertices. Both are
// measured here: deviation per layer, and — the decisive one — the share of
// overlapping ground where the layer order has actually flipped.
//
// Bridges are excluded throughout. A bridge deck spans between bank heights
// on purpose, so it deviates from the terrain by metres by design; counting
// those would drown the signal.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import * as THREE from "three";
import {
  decodeHeightfield,
  heightAt,
  latLonToWorld,
  layersFromMap,
  storeFromBuildings,
  type GameMap,
  type Heightfield,
} from "@portlandoregon/shared";
import { buildWorld } from "../client/src/render/world.js";

const MAP_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "../client/src/public/map");
const toBuf = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

const map = JSON.parse(gunzipSync(readFileSync(join(MAP_DIR, "map.json.gz"))).toString("utf8")) as GameMap;
const hf: Heightfield = decodeHeightfield(toBuf(gunzipSync(readFileSync(join(MAP_DIR, "heightmap.bin.gz")))));
const ground = (x: number, y: number): number => heightAt(hf, x, y);

const TILE = 1000;
const CELL = 0.5; // m — rasterisation grid for the overlap test
const N = TILE / CELL;

const SITES = [
  { name: "downtown", lat: 45.5203, lon: -122.6765 },
  { name: "west hills (steep)", lat: 45.5145, lon: -122.7135 },
  { name: "east residential", lat: 45.5155, lon: -122.6125 },
];

function pointInRing(x: number, y: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function tileOf(site: { lat: number; lon: number }): { map: GameMap; x0: number; y0: number } {
  const c = latLonToWorld(map.meta, { lat: site.lat, lon: site.lon });
  const x0 = Math.floor(c.x / TILE) * TILE;
  const y0 = Math.floor(c.y / TILE) * TILE;
  const inside = (x: number, y: number): boolean => x >= x0 && x < x0 + TILE && y >= y0 && y < y0 + TILE;
  const line = <T extends { polyline: [number, number][] }>(f: T[]): T[] =>
    f.filter((e) => e.polyline.some(([x, y]) => inside(x, y)));
  const poly = <T extends { rings: [number, number][][] }>(f: T[]): T[] =>
    f.filter((p) => p.rings.some((r) => r.some(([x, y]) => inside(x, y))));
  return {
    x0,
    y0,
    map: {
      ...map,
      buildings: [],
      props: [],
      landmarks: [],
      edges: line(map.edges),
      trails: line(map.trails ?? []),
      rails: line(map.rails ?? []),
      markingLines: line(map.markingLines ?? []),
      sidewalks: poly(map.sidewalks ?? []),
      markingAreas: poly(map.markingAreas ?? []),
      water: poly(map.water ?? []),
      parks: poly(map.parks ?? []),
      railYards: poly(map.railYards ?? []),
    } as GameMap,
  };
}

// Labelled by the measured offset, not a fixed table — sidewalks sit at
// SIDEWALK_Y + CURB_H (0.17), not SIDEWALK_Y, and silently vanished from an
// earlier version of this table that assumed otherwise.
const LAYER_NAMES: [number, string][] = [
  [0.09, "street"], [0.1, "rail"], [0.12, "railstop"], [0.14, "yard"], [0.15, "marking"], [0.17, "sidewalk"],
  [0.18, "trail"],
];
const label = (offset: number): string =>
  `${LAYER_NAMES.find(([v]) => Math.abs(v - offset) < 0.005)?.[1] ?? "?"} ${offset.toFixed(2)}`;

function pct(sorted: number[], p: number): number {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]! : 0;
}

for (const site of SITES) {
  const { map: sub, x0, y0 } = tileOf(site);
  const waterRings = (sub.water ?? []).flatMap((w) => w.rings.slice(0, 1));
  // Rasterised once — a per-sample point-in-ring test over the river's rings
  // is far too slow to call per grid cell.
  const WM = 5; // m — coarse is fine, this only has to find the river
  const WN = TILE / WM;
  const waterMask = new Uint8Array(WN * WN);
  for (let gy = 0; gy < WN; gy++) {
    const py = y0 + (gy + 0.5) * WM;
    for (let gx = 0; gx < WN; gx++) {
      const px = x0 + (gx + 0.5) * WM;
      if (waterRings.some((r) => pointInRing(px, py, r))) waterMask[gy * WN + gx] = 1;
    }
  }
  const overWater = (x: number, y: number): boolean => {
    const gx = Math.floor((x - x0) / WM);
    const gy = Math.floor((y - y0) / WM);
    return gx >= 0 && gy >= 0 && gx < WN && gy < WN ? waterMask[gy * WN + gx] === 1 : false;
  };
  const world = buildWorld(sub, storeFromBuildings(sub.buildings), layersFromMap(sub), hf);

  let lo = Infinity;
  let hi = -Infinity;
  for (let y = y0; y <= y0 + TILE; y += 25) {
    for (let x = x0; x <= x0 + TILE; x += 25) {
      lo = Math.min(lo, ground(x, y));
      hi = Math.max(hi, ground(x, y));
    }
  }
  console.log(`\n=== ${site.name} — tile (${x0}, ${y0}), relief ${(hi - lo).toFixed(0)} m ===`);

  const meshes: THREE.Mesh[] = [];
  world.group.traverse((o) => {
    if (o instanceof THREE.Mesh) meshes.push(o);
  });

  const devs = new Map<string, number[]>();
  /** Per layer: surface height per 0.5 m cell (NaN = layer absent here). */
  const grids = new Map<string, Float32Array>();
  const offsets = new Map<string, number>();

  for (const mesh of meshes) {
    const pos = mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    const nrm = mesh.geometry.getAttribute("normal") as THREE.BufferAttribute | undefined;
    const idx = mesh.geometry.getIndex();
    const triCount = idx ? idx.count / 3 : pos.count / 3;
    if (!triCount) continue;
    const at = (i: number): number => (idx ? idx.getX(i) : i);
    const v0 = at(0);
    const offset = pos.getY(v0) - ground(pos.getX(v0), -pos.getZ(v0));
    if (offset < 0.01) continue; // the terrain mesh itself
    const name = label(offset);

    offsets.set(name, offset);
    let d = devs.get(name);
    if (!d) devs.set(name, (d = []));
    let g = grids.get(name);
    if (!g) grids.set(name, (g = new Float32Array(N * N).fill(NaN)));

    for (let t = 0; t < triCount; t++) {
      const a = at(t * 3);
      const b = at(t * 3 + 1);
      const c = at(t * 3 + 2);
      const ax = pos.getX(a), ay = -pos.getZ(a), az = pos.getY(a);
      const bx = pos.getX(b), by = -pos.getZ(b), bz = pos.getY(b);
      const cx = pos.getX(c), cy = -pos.getZ(c), cz = pos.getY(c);
      const mx = (ax + bx + cx) / 3;
      const my = (ay + by + cy) / 3;
      if (mx < x0 || mx > x0 + TILE || my < y0 || my > y0 + TILE) continue;
      // Sidewalks are raised slabs whose skirt walls run from 40 cm BELOW
      // grade to the curb top — vertical by design, and they read as a tight
      // 36 cm "error" cluster if counted. Only up-facing triangles are
      // surfaces that can clip.
      const up = nrm ? nrm.getY(a) > 0.5 : true;
      if (!overWater(mx, my) && up) d.push((az + bz + cz) / 3 - offset - ground(mx, my));

      // Rasterise the triangle into the layer's height grid — surfaces only.
      if (nrm && nrm.getY(a) <= 0.5) continue;
      const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(den) < 1e-9) continue;
      const gx0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - x0) / CELL));
      const gx1 = Math.min(N - 1, Math.ceil((Math.max(ax, bx, cx) - x0) / CELL));
      const gy0 = Math.max(0, Math.floor((Math.min(ay, by, cy) - y0) / CELL));
      const gy1 = Math.min(N - 1, Math.ceil((Math.max(ay, by, cy) - y0) / CELL));
      for (let gy = gy0; gy <= gy1; gy++) {
        const py = y0 + (gy + 0.5) * CELL;
        for (let gx = gx0; gx <= gx1; gx++) {
          const px = x0 + (gx + 0.5) * CELL;
          const w0 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / den;
          const w1 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / den;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          if (overWater(px, py)) continue;
          const i = gy * N + gx;
          const h = w0 * az + w1 * bz + w2 * cz;
          if (Number.isNaN(g[i]!) || h > g[i]!) g[i] = h;
        }
      }
    }
  }

  console.log("\n  drape error vs terrain (bridges excluded)");
  console.log("  layer       tris    median      p95      p99      max    >6cm");
  console.log("  " + "-".repeat(62));
  for (const [name, d] of [...devs].sort()) {
    const abs = d.map(Math.abs).sort((p, q) => p - q);
    const over = d.filter((v) => Math.abs(v) > 0.06).length;
    console.log(
      `  ${name.padEnd(9)} ${String(d.length).padStart(6)}` +
        `${`${(pct(abs, 0.5) * 100).toFixed(1)}cm`.padStart(10)}${`${(pct(abs, 0.95) * 100).toFixed(1)}cm`.padStart(9)}` +
        `${`${(pct(abs, 0.99) * 100).toFixed(1)}cm`.padStart(9)}${`${(pct(abs, 1) * 100).toFixed(1)}cm`.padStart(9)}` +
        `${`${((over / Math.max(1, d.length)) * 100).toFixed(1)}%`.padStart(8)}`,
    );
  }

  // The decisive test: where two layers overlap, is the intended one on top?
  console.log("\n  layer-order inversions where layers overlap");
  const names = [...grids.keys()].sort((a, b) => offsets.get(a)! - offsets.get(b)!);
  let any = false;
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const lower = names[i]!;
      const upper = names[j]!;
      const gl = grids.get(lower)!;
      const gu = grids.get(upper)!;
      let overlap = 0;
      const deficit: number[] = []; // how far the upper layer sank below the lower
      for (let k = 0; k < gl.length; k++) {
        if (Number.isNaN(gl[k]!) || Number.isNaN(gu[k]!)) continue;
        overlap++;
        if (gu[k]! <= gl[k]!) deficit.push(gl[k]! - gu[k]!);
      }
      if (overlap < 200) continue;
      any = true;
      deficit.sort((p, q) => p - q);
      const gap = offsets.get(upper)! - offsets.get(lower)!;
      console.log(
        `  ${(upper.split(" ")[0] + " over " + lower.split(" ")[0]).padEnd(22)}` +
          `${`${((overlap * CELL * CELL) / 1000).toFixed(1)}k m²`.padStart(9)}` +
          `${`${((deficit.length / overlap) * 100).toFixed(2)}%`.padStart(9)} inverted` +
          `   gap ${(gap * 100).toFixed(0)}cm` +
          `   lift needed p99 ${`${(pct(deficit, 0.99) * 100).toFixed(0)}cm`.padStart(6)}` +
          ` max ${`${(pct(deficit, 1) * 100).toFixed(0)}cm`.padStart(6)}`,
      );
    }
  }
  if (!any) console.log("  (no layer pair overlaps meaningfully in this tile)");
}

console.log(
  "\nRead:\n" +
    "  drape error — how far a draped triangle's flat interior sits from the\n" +
    "    terrain beneath it. Layers are stacked 1-9 cm apart, so anything past\n" +
    "    ~6 cm means geometry can no longer express the intended order.\n" +
    "  inversions — the share of overlapping ground where the upper layer has\n" +
    "    actually ended up at or below the lower one. This is the number that\n" +
    "    decides the fix: near zero means a cheap render-order change is enough.",
);
