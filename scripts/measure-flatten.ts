// What would flattening the ground stack into one surface actually cost?
//
//   npx tsx --max-old-space-size=8192 scripts/measure-flatten.ts
//
// The worry is sliver explosion. Flattening resolves the overlapping decal
// layers into a single planar subdivision, and every place two layer
// boundaries cross becomes a new vertex. Downtown is where that is worst:
// asphalt, crosswalk ladders, stop bars and lane lines all pile into the same
// 20 m box at every intersection.
//
// The cost of a planar subdivision is exact and countable without doing the
// booleans: output vertices = input boundary vertices + edge crossings. So
// this builds the real input polygons for a tile (ribbons offset from
// centrelines exactly as the renderer does, plus the polygon layers as-is),
// counts crossings with a uniform grid, and compares against what the tile
// costs today.
//
// The raster alternative is measured in the same run, since the same bake
// would produce it: a per-tile label image, which is also the LOD2 texture.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import * as THREE from "three";
import {
  decodeHeightfield,
  heightAt,
  latLonToWorld,
  layersFromMap,
  storeFromBuildings,
  type GameMap,
  type Heightfield,
} from "@battle-juice/shared";
import { buildWorld } from "../client/src/render/world.js";

const MAP_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "../client/src/public/map");
const toBuf = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

const map = JSON.parse(gunzipSync(readFileSync(join(MAP_DIR, "map.json.gz"))).toString("utf8")) as GameMap;
const hf: Heightfield = decodeHeightfield(toBuf(gunzipSync(readFileSync(join(MAP_DIR, "heightmap.bin.gz")))));

const TILE = 1000;
const SITES = [
  { name: "downtown", lat: 45.5203, lon: -122.6765 },
  { name: "east residential", lat: 45.5155, lon: -122.6125 },
];

// Render widths, matching world.ts.
const RENDER_WIDTH: Record<string, number> = { arterial: 17, collector: 13.5, local: 11, alley: 5, path: 2.5 };
const RAIL_WIDTH: Record<string, number> = { rail: 4, max: 3.2, streetcar: 2.6, wes: 3.2 };

type Ring = [number, number][];

/** A polyline swept to a ribbon, one quad per segment — the same shape the
 * renderer draws, which is what the flattener would have to consume. */
function ribbon(line: [number, number][], width: number): Ring[] {
  const h = width / 2;
  const out: Ring[] = [];
  for (let i = 0; i + 1 < line.length; i++) {
    const [x1, y1] = line[i]!;
    const [x2, y2] = line[i + 1]!;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    const nx = (-dy / len) * h;
    const ny = (dx / len) * h;
    out.push([[x1 + nx, y1 + ny], [x2 + nx, y2 + ny], [x2 - nx, y2 - ny], [x1 - nx, y1 - ny]]);
  }
  return out;
}

for (const site of SITES) {
  const c = latLonToWorld(map.meta, { lat: site.lat, lon: site.lon });
  const x0 = Math.floor(c.x / TILE) * TILE;
  const y0 = Math.floor(c.y / TILE) * TILE;
  const hit = (x: number, y: number): boolean => x >= x0 && x < x0 + TILE && y >= y0 && y < y0 + TILE;

  // --- what the tile costs today -------------------------------------------
  const line = <T extends { polyline: [number, number][] }>(f: T[]): T[] =>
    f.filter((e) => e.polyline.some(([x, y]) => hit(x, y)));
  const poly = <T extends { rings: Ring[] }>(f: T[]): T[] =>
    f.filter((p) => p.rings.some((r) => r.some(([x, y]) => hit(x, y))));
  const sub = {
    ...map,
    buildings: [], props: [], landmarks: [],
    edges: line(map.edges),
    trails: line(map.trails ?? []),
    rails: line(map.rails ?? []),
    markingLines: line(map.markingLines ?? []),
    sidewalks: poly(map.sidewalks ?? []),
    markingAreas: poly(map.markingAreas ?? []),
    water: poly(map.water ?? []),
    parks: poly(map.parks ?? []),
    railYards: poly(map.railYards ?? []),
  } as GameMap;

  const world = buildWorld(sub, storeFromBuildings(sub.buildings), layersFromMap(sub), hf);
  let decalVerts = 0;
  let decalTris = 0;
  world.group.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const pos = o.geometry.getAttribute("position") as THREE.BufferAttribute;
    const v0 = pos.getY(0) - heightAt(hf, pos.getX(0), -pos.getZ(0));
    if (v0 < 0.01) return; // terrain
    decalVerts += pos.count;
    decalTris += (o.geometry.getIndex()?.count ?? pos.count) / 3;
  });

  // --- what flattening would cost ------------------------------------------
  // Every layer as boundary rings, in paint order. This is the flattener's
  // input; the output subdivision has one vertex per input vertex plus one
  // per crossing.
  const rings: Ring[] = [];
  for (const e of sub.edges) rings.push(...ribbon(e.polyline, RENDER_WIDTH[e.class] ?? 11));
  for (const r of sub.rails ?? []) rings.push(...ribbon(r.polyline, RAIL_WIDTH[r.kind] ?? 4));
  for (const t of sub.trails ?? []) rings.push(...ribbon(t.polyline, 2.5));
  for (const l of sub.markingLines ?? []) rings.push(...ribbon(l.polyline, 0.35));
  for (const s of sub.sidewalks ?? []) rings.push(...s.rings);
  for (const a of sub.markingAreas ?? []) rings.push(...a.rings);

  // Segments, clipped to the tile by midpoint.
  const seg: number[] = []; // x1,y1,x2,y2 flat
  for (const r of rings) {
    for (let i = 0; i < r.length; i++) {
      const [ax, ay] = r[i]!;
      const [bx, by] = r[(i + 1) % r.length]!;
      if (!hit((ax + bx) / 2, (ay + by) / 2)) continue;
      seg.push(ax, ay, bx, by);
    }
  }
  const nSeg = seg.length / 4;

  // Crossings, bucketed into a uniform grid so this stays tractable.
  const G = 10; // m buckets
  const GN = TILE / G;
  const buckets = new Map<number, number[]>();
  for (let s = 0; s < nSeg; s++) {
    const ax = seg[s * 4]!, ay = seg[s * 4 + 1]!, bx = seg[s * 4 + 2]!, by = seg[s * 4 + 3]!;
    const cx0 = Math.max(0, Math.floor((Math.min(ax, bx) - x0) / G));
    const cx1 = Math.min(GN - 1, Math.floor((Math.max(ax, bx) - x0) / G));
    const cy0 = Math.max(0, Math.floor((Math.min(ay, by) - y0) / G));
    const cy1 = Math.min(GN - 1, Math.floor((Math.max(ay, by) - y0) / G));
    for (let gy = cy0; gy <= cy1; gy++) {
      for (let gx = cx0; gx <= cx1; gx++) {
        const k = gy * GN + gx;
        const b = buckets.get(k);
        if (b) b.push(s);
        else buckets.set(k, [s]);
      }
    }
  }
  const crossed = new Set<number>();
  for (const list of buckets.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const p = list[i]!, q = list[j]!;
        const ax = seg[p * 4]!, ay = seg[p * 4 + 1]!, bx = seg[p * 4 + 2]!, by = seg[p * 4 + 3]!;
        const cx = seg[q * 4]!, cy = seg[q * 4 + 1]!, dx = seg[q * 4 + 2]!, dy = seg[q * 4 + 3]!;
        const d = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
        if (Math.abs(d) < 1e-12) continue;
        const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / d;
        const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / d;
        if (t <= 0 || t >= 1 || u <= 0 || u >= 1) continue;
        crossed.add(p < q ? p * 1e7 + q : q * 1e7 + p);
      }
    }
  }
  const crossings = crossed.size;
  // A planar subdivision triangulates to roughly 2 triangles per vertex.
  const flatVerts = nSeg + crossings;
  const flatTris = flatVerts * 2;

  console.log(`\n=== ${site.name} — tile (${x0}, ${y0}) ===`);
  console.log(`  today (draped decal layers)   ${decalVerts.toLocaleString()} verts, ${decalTris.toLocaleString()} tris`);
  console.log(`  flatten input                 ${nSeg.toLocaleString()} boundary segments`);
  console.log(`  crossings to resolve          ${crossings.toLocaleString()}`);
  console.log(`  flattened subdivision        ~${flatVerts.toLocaleString()} verts, ~${flatTris.toLocaleString()} tris`);
  console.log(`  change                        ${(((flatTris - decalTris) / decalTris) * 100).toFixed(0)}% triangles`);

  // --- the raster alternative ----------------------------------------------
  // One byte of surface class per texel, painted in the same priority order a
  // flattener would use. Ground truth for a per-tile ground texture, and the
  // LOD2 input from the same bake.
  const CLASSES: [Ring[], number][] = [
    [(sub.trails ?? []).flatMap((t) => ribbon(t.polyline, 2.5)), 1],
    [sub.edges.flatMap((e) => ribbon(e.polyline, RENDER_WIDTH[e.class] ?? 11)), 2],
    [(sub.rails ?? []).flatMap((r) => ribbon(r.polyline, RAIL_WIDTH[r.kind] ?? 4)), 3],
    [(sub.sidewalks ?? []).flatMap((w) => w.rings), 4],
    [(sub.markingAreas ?? []).flatMap((a) => a.rings), 5],
    [(sub.markingLines ?? []).flatMap((l) => ribbon(l.polyline, 0.35)), 6],
  ];

  /** Scanline fill of one ring — bbox filling would have made the label field
   * a near-solid blob and flattered the compressed size by ~10x. */
  function fillRing(img: Uint8Array, n: number, res: number, ring: Ring, id: number): void {
    let miny = Infinity;
    let maxy = -Infinity;
    for (const [, y] of ring) {
      miny = Math.min(miny, y);
      maxy = Math.max(maxy, y);
    }
    const gy0 = Math.max(0, Math.floor((miny - y0) / res));
    const gy1 = Math.min(n - 1, Math.ceil((maxy - y0) / res));
    const xs: number[] = [];
    for (let gy = gy0; gy <= gy1; gy++) {
      const py = y0 + (gy + 0.5) * res;
      xs.length = 0;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i]!;
        const [xj, yj] = ring[j]!;
        if (yi > py === yj > py) continue;
        xs.push(xi + ((py - yi) / (yj - yi)) * (xj - xi));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const gx0 = Math.max(0, Math.ceil((xs[k]! - x0) / res - 0.5));
        const gx1 = Math.min(n - 1, Math.floor((xs[k + 1]! - x0) / res - 0.5));
        for (let gx = gx0; gx <= gx1; gx++) img[gy * n + gx] = id;
      }
    }
  }

  for (const res of [1, 0.5, 0.25]) {
    const n = TILE / res;
    const img = new Uint8Array(n * n);
    for (const [ringList, id] of CLASSES) for (const r of ringList) fillRing(img, n, res, r, id);
    let painted = 0;
    for (let i = 0; i < img.length; i++) if (img[i]) painted++;
    const gz = gzipSync(img, { level: 9 }).length;
    console.log(
      `  raster @ ${String(res).padEnd(4)} m/texel   ${String(n).padStart(4)}x${n}, ` +
        `${((painted / img.length) * 100).toFixed(0)}% painted, ` +
        `${(img.length / 1e6).toFixed(1)} MB raw, ${(gz / 1e6).toFixed(2)} MB gzipped`,
    );
  }
}
