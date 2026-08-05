import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  heightAt,
  type Building,
  type GameMap,
  type Heightfield,
  type Landmark,
  type RailLine,
  type RailStop,
  type StreetEdge,
  type WaterBody,
} from "@battle-juice/shared";

/** Terrain height lookup (world meters). Flat maps use () => 0. */
export type GroundFn = (x: number, y: number) => number;

/** Growing vertex-soup accumulator — direct buffer writes, no per-feature
 * BufferGeometry/merge round-trips (those made city load take ~36 s). */
interface Soup {
  pos: number[];
  nrm: number[];
  col?: number[];
}

const GROUND_COLOR = 0x262c36; // city-block base
const WATER_COLOR = 0x1b2f42; // deep river blue
const PARK_COLOR = 0x2c4434; // greenspace
const TRAIL_COLOR = 0x6b5f4c; // dirt path
const STREET_COLOR = 0x3a4150; // asphalt
const WATER_Y = 0.1; // between ground and streets
const PARK_Y = 0.18;
const SIDEWALK_COLOR = 0x555c66; // concrete, lighter than asphalt
const SIDEWALK_Y = 0.22;
const STREET_Y = 0.28; // lift above ground to avoid z-fighting
const MARK_WHITE = 0xb9c0c8; // painted pavement markings
const MARK_YELLOW = 0xc2a53a;
const MARK_Y = 0.33;
const TRAIL_Y = 0.36;

// Palette variants per normalized building use — true-to-life variety:
// warm single-family, terracotta multi-family, cool commercial/office,
// muddy industrial, pale institutional.
const USE_TINTS: Record<string, number[]> = {
  sfr: [0x9d9078, 0xa89a80, 0x8f836e],
  mfr: [0xa17a68, 0x96705f, 0x8d6a5e],
  com: [0x7d8aa0, 0x74809a, 0x8891a6],
  off: [0x6f8096, 0x7a8aa2],
  ind: [0x6e6a63, 0x7a7168, 0x635f58],
  inst: [0x9aa0a8, 0xa2a8b2],
  other: [0x707786, 0x7d8290, 0x8a8578],
};

// Landmark buildings are painted per civic kind, not palette-tinted. The
// plate/pad styling for each kind lives here too so world, landmark and
// minimap layers agree.
export interface LandmarkTheme {
  building: number;
  plateBg: string;
  plateBorder: string;
  plateText: string;
}
export const LANDMARK_THEMES: Record<Landmark["kind"], LandmarkTheme> = {
  "fire-station": { building: 0xd8281a, plateBg: "rgba(120, 20, 12, 0.9)", plateBorder: "#ff8b7c", plateText: "#ffd3cb" },
  police: { building: 0x2b56c4, plateBg: "rgba(18, 38, 110, 0.9)", plateBorder: "#7ea1ff", plateText: "#cfdcff" },
  hospital: { building: 0xdde2e7, plateBg: "rgba(12, 84, 96, 0.9)", plateBorder: "#63d6e2", plateText: "#cdf3f7" },
  "city-hall": { building: 0xd9a441, plateBg: "rgba(110, 80, 14, 0.9)", plateBorder: "#ffd67e", plateText: "#ffeec9" },
};
const LANDMARK_RGB = new Map<Landmark["kind"], number[]>(
  (Object.entries(LANDMARK_THEMES) as [Landmark["kind"], LandmarkTheme][]).map(([k, t]) => {
    const c = new THREE.Color(t.building);
    return [k, [c.r, c.g, c.b]];
  }),
);

// Rail network styling (freight rail, MAX, streetcar, WES).
const RAIL_STYLE: Record<RailLine["kind"], { color: number; width: number }> = {
  rail: { color: 0x574f45, width: 4 },
  max: { color: 0x3172d9, width: 3.2 },
  streetcar: { color: 0x3aa38b, width: 2.6 },
  wes: { color: 0x8055d9, width: 3.2 },
};
const YARD_COLOR = 0x36322b; // ballast/gravel
const YARD_Y = 0.14; // under streets, over parks
const RAIL_Y = 0.44; // over streets/trails so crossings read
const STOP_Y = 0.5;
const STOP_RADIUS = 5; // m platform disc

// Tile size for chunked meshes — one merged mesh per tile so the GPU
// frustum-culls off-screen chunks. Every building renders at every zoom.
const TILE = 1000; // meters

export interface WorldLayers {
  group: THREE.Group;
  /** Street-level dressing (sidewalks, pavement paint) — hidden when zoomed
   * out, like props (subpixel there anyway). */
  detail: THREE.Group;
  /** Zoom-driven cosmetics (street tint brightens from altitude). */
  setBlend(f: number): void;
}

/** Static map meshes: terrain (or flat ground), water, tiled street ribbons
 * + buildings — all draped onto the heightfield when one is provided. */
export function buildWorld(map: GameMap, hf?: Heightfield | null): WorldLayers {
  const ground: GroundFn = hf ? (x, y) => heightAt(hf, x, y) : () => 0;
  const group = new THREE.Group();
  if (hf) {
    // Water/parks/yards are painted INTO the terrain's vertex colors instead
    // of draped as separate polygons: no z-fighting, no sliver triangles
    // from earcutting the huge clipped river rings — and since 3DEP is
    // hydro-flattened, water-tinted terrain IS the river surface (including
    // the drop at Willamette Falls).
    for (const mesh of buildTerrainTiles(map, hf)) group.add(mesh);
  } else {
    group.add(buildGround(map));
    const parks = flatPolys(map.parks ?? [], PARK_COLOR, PARK_Y);
    if (parks) group.add(parks);
    const water = flatPolys(map.water ?? [], WATER_COLOR, WATER_Y);
    if (water) group.add(water);
    const yards = flatPolys(map.railYards ?? [], YARD_COLOR, YARD_Y);
    if (yards) group.add(yards);
  }

  // Ribbon legs that cross water are bridges: their deck spans between the
  // bank heights instead of sagging onto the riverbed. (Land overpasses
  // still drape — the ZLEV rule is phase 2.)
  const overWater = waterTester(map.water ?? [], map.meta.width, map.meta.height);

  const trails = buildTrails(map.trails ?? [], ground, overWater);
  if (trails) group.add(trails);

  const streetMat = new THREE.MeshLambertMaterial({ color: STREET_COLOR, side: THREE.DoubleSide });
  for (const mesh of buildStreetTiles(map.edges, streetMat, ground, overWater)) group.add(mesh);

  for (const mesh of buildRails(map.rails ?? [], ground, overWater)) group.add(mesh);
  const stops = buildRailStops(map.railStops ?? [], ground);
  if (stops) group.add(stops);

  const landmarkBuildings = new Map<number, Landmark["kind"]>();
  for (const m of map.landmarks ?? []) for (const id of m.buildingIds ?? []) landmarkBuildings.set(id, m.kind);
  for (const mesh of buildBuildingTiles(map.buildings, landmarkBuildings, ground)) group.add(mesh);

  // Street-level dressing, in its own zoom-gated group.
  const detail = new THREE.Group();
  group.add(detail);
  for (const mesh of drapedPolyTiles(
    (map.sidewalks ?? []).map((s) => ({ rings: s.rings, color: SIDEWALK_COLOR })),
    SIDEWALK_Y,
    ground,
  )) detail.add(mesh);
  for (const mesh of drapedPolyTiles(
    (map.markingAreas ?? []).map((a) => ({ rings: a.rings, color: a.style === "yellow" ? MARK_YELLOW : MARK_WHITE })),
    MARK_Y,
    ground,
  )) detail.add(mesh);
  {
    const laneTiles = new Map<number, Soup>();
    for (const l of map.markingLines ?? []) {
      const [mx, my] = l.polyline[Math.floor(l.polyline.length / 2)]!;
      let soup = laneTiles.get(tileKey(mx, my));
      if (!soup) laneTiles.set(tileKey(mx, my), (soup = { pos: [], nrm: [] }));
      pushRibbon(soup.pos, l.polyline, 0.35, MARK_Y, ground);
    }
    const laneMat = new THREE.MeshLambertMaterial({ color: MARK_YELLOW, side: THREE.DoubleSide });
    for (const soup of laneTiles.values()) detail.add(soupMesh(soup, laneMat));
  }

  const streetNear = new THREE.Color(STREET_COLOR);
  const streetFar = new THREE.Color(0x5a6478); // brighter so the grid reads from altitude
  return {
    group,
    detail,
    setBlend(f: number): void {
      const t = Math.min(1, Math.max(0, f));
      streetMat.color.lerpColors(streetNear, streetFar, t);
    },
  };
}

function tileKey(x: number, y: number): number {
  return Math.floor(y / TILE) * 4096 + Math.floor(x / TILE);
}

function buildGround(map: GameMap): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(map.meta.width, map.meta.height);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshLambertMaterial({ color: GROUND_COLOR });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(map.meta.width / 2, 0, -map.meta.height / 2);
  return mesh;
}

const TERRAIN_CHUNK = 40; // heightfield cells per terrain mesh (~1.2 km)

// Terrain vertex tint categories (painted from map polygons).
const CAT_GROUND = 0;
const CAT_PARK = 1;
const CAT_YARD = 2;
const CAT_WATER = 3;
const CAT_RGB: number[][] = [GROUND_COLOR, PARK_COLOR, YARD_COLOR, WATER_COLOR].map((hex) => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
});

/**
 * Even-odd scanline fill of polygon bodies onto the heightfield vertex grid
 * (all rings together, so island holes come free). Writes `cat` where inside.
 */
function paintMask(bodies: WaterBody[], hf: Heightfield, out: Uint8Array, cat: number): void {
  const cell = hf.cellSize;
  for (const body of bodies) {
    const rowHits: number[][] = Array.from({ length: hf.rows }, () => []);
    for (const ring of body.rings) {
      for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = ring[i]!;
        const [x2, y2] = ring[(i + 1) % ring.length]!;
        if (y1 === y2) continue;
        const rLo = Math.max(0, Math.ceil(Math.min(y1, y2) / cell));
        const rHi = Math.min(hf.rows - 1, Math.floor(Math.max(y1, y2) / cell));
        for (let r = rLo; r <= rHi; r++) {
          const yc = r * cell;
          if (yc >= Math.min(y1, y2) && yc < Math.max(y1, y2)) {
            rowHits[r]!.push(x1 + ((yc - y1) / (y2 - y1)) * (x2 - x1));
          }
        }
      }
    }
    for (let r = 0; r < hf.rows; r++) {
      const xs = rowHits[r]!.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil(xs[k]! / cell));
        const c1 = Math.min(hf.cols - 1, Math.floor(xs[k + 1]! / cell));
        for (let c = c0; c <= c1; c++) out[r * hf.cols + c] = cat;
      }
    }
  }
}

/** Displaced terrain grid, chunked for frustum culling. Indexed geometry,
 * vertex-colored by the park/yard/water masks. */
function buildTerrainTiles(map: GameMap, hf: Heightfield): THREE.Mesh[] {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const meshes: THREE.Mesh[] = [];
  const cell = hf.cellSize;
  const lastC = hf.cols - 1;
  const lastR = hf.rows - 1;
  const px = (c: number): number => (c === lastC ? map.meta.width : c * cell);
  const py = (r: number): number => (r === lastR ? map.meta.height : r * cell);

  const mask = new Uint8Array(hf.cols * hf.rows); // CAT_GROUND
  paintMask(map.parks ?? [], hf, mask, CAT_PARK);
  paintMask(map.railYards ?? [], hf, mask, CAT_YARD);
  paintMask(map.water ?? [], hf, mask, CAT_WATER);

  for (let r0 = 0; r0 < lastR; r0 += TERRAIN_CHUNK) {
    for (let c0 = 0; c0 < lastC; c0 += TERRAIN_CHUNK) {
      const c1 = Math.min(lastC, c0 + TERRAIN_CHUNK);
      const r1 = Math.min(lastR, r0 + TERRAIN_CHUNK);
      const w = c1 - c0 + 1;
      const h = r1 - r0 + 1;
      const pos = new Float32Array(w * h * 3);
      const nrm = new Float32Array(w * h * 3);
      const col = new Float32Array(w * h * 3);
      let i = 0;
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const wx = px(c);
          const wy = py(r);
          const wz = hf.data[r * hf.cols + c]! * hf.scale;
          pos[i] = wx;
          pos[i + 1] = wz;
          pos[i + 2] = -wy;
          const rgb = CAT_RGB[mask[r * hf.cols + c]!]!;
          col[i] = rgb[0]!;
          col[i + 1] = rgb[1]!;
          col[i + 2] = rgb[2]!;
          // Central differences on the raw grid (cheap, no bilinear).
          const cm = Math.max(0, c - 1);
          const cp = Math.min(lastC, c + 1);
          const rm = Math.max(0, r - 1);
          const rp = Math.min(lastR, r + 1);
          const gx = ((hf.data[r * hf.cols + cp]! - hf.data[r * hf.cols + cm]!) * hf.scale) / ((cp - cm) * cell);
          const gy = ((hf.data[rp * hf.cols + c]! - hf.data[rm * hf.cols + c]!) * hf.scale) / ((rp - rm) * cell);
          const inv = 1 / Math.hypot(gx, 1, gy);
          nrm[i] = -gx * inv;
          nrm[i + 1] = inv;
          nrm[i + 2] = gy * inv;
          i += 3;
        }
      }
      const index: number[] = [];
      for (let r = 0; r < h - 1; r++) {
        for (let c = 0; c < w - 1; c++) {
          const a = r * w + c;
          const b = a + 1;
          const d = a + w;
          const e = d + 1;
          // Scene z is -y: swap winding so faces point up.
          index.push(a, b, d, b, e, d);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
      geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
      geo.setIndex(index);
      meshes.push(new THREE.Mesh(geo, mat));
    }
  }
  return meshes;
}

const DRAPE_EDGE = 25; // m — subdivide small-poly triangles down to this
const DRAPE_N_CAP = 16;

/**
 * Small polygons (sidewalk strips, painted markings) draped onto terrain and
 * bucketed into 1 km tile meshes, one material per color. Earcut is safe
 * here — these are compact, clean shapes, unlike the clipped river rings.
 */
function drapedPolyTiles(
  bodies: { rings: [number, number][][]; color: number }[],
  yOff: number,
  ground: GroundFn,
): THREE.Mesh[] {
  // color -> tile -> soup
  const byColor = new Map<number, Map<number, Soup>>();
  for (const body of bodies) {
    const outer = body.rings[0];
    if (!outer || outer.length < 3) continue;
    let tiles = byColor.get(body.color);
    if (!tiles) byColor.set(body.color, (tiles = new Map()));
    const key = tileKey(outer[0]![0], outer[0]![1]);
    let soup = tiles.get(key);
    if (!soup) tiles.set(key, (soup = { pos: [], nrm: [] }));

    const outerV = outer.map(([x, y]) => new THREE.Vector2(x, y));
    const holesV = body.rings.slice(1).filter((r) => r.length >= 3).map((r) => r.map(([x, y]) => new THREE.Vector2(x, y)));
    const flat: THREE.Vector2[] = outerV.concat(...holesV);
    for (const tri of THREE.ShapeUtils.triangulateShape(outerV, holesV)) {
      const a = flat[tri[0]!];
      const b = flat[tri[1]!];
      const c = flat[tri[2]!];
      if (!a || !b || !c) continue;
      const maxEdge = Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a));
      const n = Math.max(1, Math.min(DRAPE_N_CAP, Math.ceil(maxEdge / DRAPE_EDGE)));
      const P = (i: number, j: number): [number, number] => [
        a.x + ((b.x - a.x) * i + (c.x - a.x) * j) / n,
        a.y + ((b.y - a.y) * i + (c.y - a.y) * j) / n,
      ];
      const emit = (p: [number, number]): void => {
        soup!.pos.push(p[0], yOff + ground(p[0], p[1]), -p[1]);
      };
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n - i; j++) {
          emit(P(i, j));
          emit(P(i + 1, j));
          emit(P(i, j + 1));
          if (j < n - i - 1) {
            emit(P(i + 1, j));
            emit(P(i + 1, j + 1));
            emit(P(i, j + 1));
          }
        }
      }
    }
  }
  const meshes: THREE.Mesh[] = [];
  for (const [color, tiles] of byColor) {
    const mat = new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide });
    for (const soup of tiles.values()) meshes.push(soupMesh(soup, mat));
  }
  return meshes;
}

/** Flat polygon bodies (no-heightfield fallback only). */
function flatPolys(bodies: WaterBody[], color: number, y: number): THREE.Mesh | null {
  const parts: THREE.BufferGeometry[] = [];
  for (const body of bodies) {
    const outer = body.rings[0];
    if (!outer || outer.length < 3) continue;
    const shape = new THREE.Shape(outer.map(([x, py]) => new THREE.Vector2(x, py)));
    for (const hole of body.rings.slice(1)) {
      if (hole.length >= 3) shape.holes.push(new THREE.Path(hole.map(([x, py]) => new THREE.Vector2(x, py))));
    }
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, y, 0);
    geo.deleteAttribute("uv");
    parts.push(geo);
  }
  if (parts.length === 0) return null;
  const merged = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ color }));
}

const WATER_MASK_CELL = 40; // m

/**
 * Scanline-rasterized water mask (even-odd fill over all rings, so island
 * holes come free). Returns a polyline tester: true when any vertex or
 * segment midpoint lies in water — i.e. this leg is a bridge.
 */
function waterTester(
  water: WaterBody[],
  width: number,
  height: number,
): (polyline: [number, number][]) => boolean {
  const cols = Math.max(1, Math.ceil(width / WATER_MASK_CELL));
  const rows = Math.max(1, Math.ceil(height / WATER_MASK_CELL));
  const mask = new Uint8Array(cols * rows);
  for (const body of water) {
    const rowHits: number[][] = Array.from({ length: rows }, () => []);
    for (const ring of body.rings) {
      for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = ring[i]!;
        const [x2, y2] = ring[(i + 1) % ring.length]!;
        if (y1 === y2) continue;
        const rLo = Math.max(0, Math.ceil((Math.min(y1, y2) / WATER_MASK_CELL) - 0.5));
        const rHi = Math.min(rows - 1, Math.floor((Math.max(y1, y2) / WATER_MASK_CELL) - 0.5));
        for (let r = rLo; r <= rHi; r++) {
          const yc = (r + 0.5) * WATER_MASK_CELL;
          if (yc >= Math.min(y1, y2) && yc < Math.max(y1, y2)) {
            rowHits[r]!.push(x1 + ((yc - y1) / (y2 - y1)) * (x2 - x1));
          }
        }
      }
    }
    for (let r = 0; r < rows; r++) {
      const xs = rowHits[r]!.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.round(xs[k]! / WATER_MASK_CELL - 0.5));
        const c1 = Math.min(cols - 1, Math.round(xs[k + 1]! / WATER_MASK_CELL - 0.5));
        for (let c = c0; c <= c1; c++) mask[r * cols + c] = 1;
      }
    }
  }
  const wet = (x: number, y: number): boolean => {
    const c = Math.floor(x / WATER_MASK_CELL);
    const r = Math.floor(y / WATER_MASK_CELL);
    return c >= 0 && r >= 0 && c < cols && r < rows && mask[r * cols + c] === 1;
  };
  return (polyline) => {
    for (let i = 0; i < polyline.length; i++) {
      const [x, y] = polyline[i]!;
      if (wet(x, y)) return true;
      const next = polyline[i + 1];
      if (next && wet((x + next[0]) / 2, (y + next[1]) / 2)) return true;
    }
    return false;
  };
}

function buildTrails(
  trails: { polyline: [number, number][] }[],
  ground: GroundFn,
  overWater: (p: [number, number][]) => boolean,
): THREE.Mesh | null {
  if (trails.length === 0) return null;
  const soup: Soup = { pos: [], nrm: [] };
  for (const t of trails) {
    pushRibbon(soup.pos, t.polyline, 2.5, TRAIL_Y, ground, overWater(t.polyline));
  }
  if (soup.pos.length === 0) return null;
  return soupMesh(soup, new THREE.MeshLambertMaterial({ color: TRAIL_COLOR, side: THREE.DoubleSide }));
}

/** Turn a soup into a mesh (normals constant-up when nrm is empty). */
function soupMesh(soup: Soup, material: THREE.Material): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(soup.pos, 3));
  if (soup.nrm.length) {
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(soup.nrm, 3));
  } else {
    const up = new Float32Array(soup.pos.length);
    for (let i = 1; i < up.length; i += 3) up[i] = 1;
    geo.setAttribute("normal", new THREE.BufferAttribute(up, 3));
  }
  if (soup.col) geo.setAttribute("color", new THREE.Float32BufferAttribute(soup.col, 3));
  return new THREE.Mesh(geo, material);
}

/** Street ribbons, written straight into per-tile buffers (all normals up). */
function buildStreetTiles(
  edges: StreetEdge[],
  mat: THREE.MeshLambertMaterial,
  ground: GroundFn,
  overWater: (p: [number, number][]) => boolean,
): THREE.Mesh[] {
  const tiles = new Map<number, Soup>();
  for (const edge of edges) {
    if (edge.struct === "tunnel") continue; // roads vanish into the hillside
    const [mx, my] = edge.polyline[Math.floor(edge.polyline.length / 2)]!;
    const key = tileKey(mx, my);
    let soup = tiles.get(key);
    if (!soup) tiles.set(key, (soup = { pos: [], nrm: [] }));
    const span = edge.struct === "bridge" || overWater(edge.polyline);
    pushRibbon(soup.pos, edge.polyline, edge.width, STREET_Y, ground, span);
  }
  return [...tiles.values()].map((soup) => soupMesh(soup, mat));
}

const RIBBON_STEP = 15; // m — resample so drape tracks terrain triangles

/** Insert points so no segment exceeds RIBBON_STEP (long straight street
 * segments would otherwise let terrain poke through the draped ribbon). */
function resample(polyline: [number, number][]): [number, number][] {
  const out: [number, number][] = [polyline[0]!];
  for (let i = 1; i < polyline.length; i++) {
    const [ax, ay] = polyline[i - 1]!;
    const [bx, by] = polyline[i]!;
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.ceil(len / RIBBON_STEP);
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  return out;
}

/**
 * Mitered ribbon along a polyline, draped onto the terrain. When `span` is
 * set (the leg crosses water) the deck height interpolates between the two
 * endpoint bank heights — never below approach terrain — so bridges span
 * instead of sagging into the river.
 */
function pushRibbon(
  pos: number[],
  rawPolyline: [number, number][],
  width: number,
  atY: number,
  ground: GroundFn,
  span = false,
): void {
  if (rawPolyline.length < 2) return;
  const polyline = resample(rawPolyline);
  const half = width / 2;
  const left: [number, number][] = [];
  const right: [number, number][] = [];
  const along: number[] = [0];

  for (let i = 0; i < polyline.length; i++) {
    const [px, py] = polyline[i]!;
    if (i > 0) {
      const [qx, qy] = polyline[i - 1]!;
      along.push(along[i - 1]! + Math.hypot(px - qx, py - qy));
    }
    let nx = 0;
    let ny = 0;
    for (const j of [i - 1, i]) {
      const a = polyline[j];
      const b = polyline[j + 1];
      if (!a || !b) continue;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len = Math.hypot(dx, dy) || 1;
      nx += -dy / len;
      ny += dx / len;
    }
    const nlen = Math.hypot(nx, ny) || 1;
    left.push([px + (nx / nlen) * half, py + (ny / nlen) * half]);
    right.push([px - (nx / nlen) * half, py - (ny / nlen) * half]);
  }

  const total = along[along.length - 1]! || 1;
  const hA = ground(polyline[0]![0], polyline[0]![1]);
  const hB = ground(polyline[polyline.length - 1]![0], polyline[polyline.length - 1]![1]);
  const heightOf = (i: number, wx: number, wy: number): number => {
    const g = ground(wx, wy);
    if (!span) return g;
    const lerp = hA + (hB - hA) * (along[i]! / total);
    return Math.max(g, lerp);
  };

  for (let i = 0; i < polyline.length - 1; i++) {
    const quad: [number, number, number][] = [
      [...left[i]!, heightOf(i, left[i]![0], left[i]![1])],
      [...right[i]!, heightOf(i, right[i]![0], right[i]![1])],
      [...right[i + 1]!, heightOf(i + 1, right[i + 1]![0], right[i + 1]![1])],
      [...left[i + 1]!, heightOf(i + 1, left[i + 1]![0], left[i + 1]![1])],
    ];
    for (const idx of [0, 1, 2, 0, 2, 3]) {
      const [wx, wy, wh] = quad[idx]!;
      pos.push(wx, atY + wh, -wy);
    }
  }
}

/** One mesh per rail kind: ribbon polylines in that kind's color. */
function buildRails(
  rails: RailLine[],
  ground: GroundFn,
  overWater: (p: [number, number][]) => boolean,
): THREE.Mesh[] {
  const soups = new Map<RailLine["kind"], Soup>();
  for (const r of rails) {
    let soup = soups.get(r.kind);
    if (!soup) soups.set(r.kind, (soup = { pos: [], nrm: [] }));
    pushRibbon(soup.pos, r.polyline, RAIL_STYLE[r.kind].width, RAIL_Y, ground, overWater(r.polyline));
  }
  return [...soups.entries()].map(([kind, soup]) =>
    soupMesh(soup, new THREE.MeshLambertMaterial({ color: RAIL_STYLE[kind].color, side: THREE.DoubleSide })),
  );
}

/** Rail stops as flat platform discs in their line's color (one mesh). */
function buildRailStops(stops: RailStop[], ground: GroundFn): THREE.Mesh | null {
  if (stops.length === 0) return null;
  const soup: Soup = { pos: [], nrm: [], col: [] };
  const SEGS = 12;
  for (const s of stops) {
    const c = new THREE.Color(RAIL_STYLE[s.kind].color).multiplyScalar(1.35);
    const y = STOP_Y + ground(s.x, s.y);
    for (let i = 0; i < SEGS; i++) {
      const a0 = (i / SEGS) * Math.PI * 2;
      const a1 = ((i + 1) / SEGS) * Math.PI * 2;
      soup.pos.push(
        s.x, y, -s.y,
        s.x + Math.cos(a0) * STOP_RADIUS, y, -(s.y + Math.sin(a0) * STOP_RADIUS),
        s.x + Math.cos(a1) * STOP_RADIUS, y, -(s.y + Math.sin(a1) * STOP_RADIUS),
      );
      for (let v = 0; v < 3; v++) soup.col!.push(c.r, c.g, c.b);
    }
  }
  return soupMesh(soup, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
}

/** Buildings written straight into per-tile buffers (keyed by first vertex). */
function buildBuildingTiles(
  buildings: Building[],
  landmarks: Map<number, Landmark["kind"]>,
  ground: GroundFn,
): THREE.Mesh[] {
  // Palette colors as flat rgb triples, resolved once.
  const palettes = new Map<string, number[][]>();
  for (const [use, hexes] of Object.entries(USE_TINTS)) {
    palettes.set(use, hexes.map((h) => {
      const c = new THREE.Color(h);
      return [c.r, c.g, c.b];
    }));
  }
  const tiles = new Map<number, Soup>();
  // Landmark prisms get their own soup per kind: an emissive material makes
  // the building itself glow in its civic color, day and night.
  const lmSoups = new Map<Landmark["kind"], Soup>();
  for (const b of buildings) {
    if (b.footprint.length < 3) continue;
    const [fx, fy] = b.footprint[0]!;
    const key = tileKey(fx, fy);
    let soup = tiles.get(key);
    if (!soup) tiles.set(key, (soup = { pos: [], nrm: [], col: [] }));
    // Base at the lowest footprint corner, sunk 1 m so slopes never show a
    // gap under the uphill wall.
    let base = Infinity;
    let cx = 0;
    let cy = 0;
    for (const [vx, vy] of b.footprint) {
      base = Math.min(base, ground(vx, vy));
      cx += vx;
      cy += vy;
    }
    base = (Number.isFinite(base) ? base : 0) - 1;
    cx /= b.footprint.length;
    cy /= b.footprint.length;
    const landmarkKind = landmarks.get(b.id);
    if (landmarkKind) {
      let ls = lmSoups.get(landmarkKind);
      if (!ls) lmSoups.set(landmarkKind, (ls = { pos: [], nrm: [], col: [] }));
      pushPrism(ls, b, LANDMARK_RGB.get(landmarkKind)!, base);
      continue;
    }
    // Tint keyed on a coarse spatial hash, not the part id: the footprint DB
    // splits one building into stacked parts (podium/tower/penthouse), and
    // per-part colors painted those as random patches. Nearby parts of the
    // same use now share a tint, so the massing reads as ONE structure.
    const palette = palettes.get(b.use ?? "other") ?? palettes.get("other")!;
    const qx = Math.round(cx / 45);
    const qy = Math.round(cy / 45);
    const hash = ((qx * 73856093) ^ (qy * 19349663)) >>> 0;
    pushPrism(soup, b, palette[hash % palette.length]!, base);
  }
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const meshes = [...tiles.values()].map((soup) => soupMesh(soup, material));
  for (const [kind, soup] of lmSoups) {
    meshes.push(
      soupMesh(
        soup,
        new THREE.MeshLambertMaterial({
          vertexColors: true,
          flatShading: true,
          emissive: new THREE.Color(LANDMARK_THEMES[kind].building),
          emissiveIntensity: 0.42,
        }),
      ),
    );
  }
  return meshes;
}

/**
 * One building: earcut roof at height + a wall quad per ring edge, appended
 * directly to the tile soup. Winding conventions (outer CCW, holes CW) make
 * one wall formula serve both: (dy, -dx) is outward for CCW and points into
 * the courtyard for CW holes — exactly the visible side each time.
 */
// Vertical light falloff: wall bases sit in street shadow, roofs are dusty
// membrane rather than facade — cheap cues that make stacked massing read.
const WALL_BASE_SHADE = 0.68;
const ROOF_SHADE = 0.88;

function pushPrism(soup: Soup, b: Building, rgb: number[], base = 0): void {
  // Tiny deterministic per-part lift: the footprint DB nests same-height
  // parts (podium duplicates), and exactly coplanar roofs shimmer.
  const h = base + 1 + b.height + (b.id % 7) * 0.06;
  const rings = [b.footprint, ...(b.holes ?? [])];
  const r = rgb[0]!;
  const g = rgb[1]!;
  const bl = rgb[2]!;
  const s = WALL_BASE_SHADE;

  // Walls: bottom vertices shaded, top full color — the GPU interpolates a
  // smooth ambient-occlusion-ish gradient up the facade.
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const [ax, ay] = ring[i]!;
      const [bx, by] = ring[(i + 1) % ring.length]!;
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) continue;
      const nx = dy / len;
      const nz = dx / len; // scene-frame z component of the outward normal
      // Two triangles: (A, B, B_top), (A, B_top, A_top) — outward-facing.
      soup.pos.push(ax, base, -ay, bx, base, -by, bx, h, -by, ax, base, -ay, bx, h, -by, ax, h, -ay);
      for (let v = 0; v < 6; v++) soup.nrm.push(nx, 0, nz);
      // Vertex order: bot, bot, top, bot, top, top.
      soup.col!.push(r * s, g * s, bl * s, r * s, g * s, bl * s, r, g, bl);
      soup.col!.push(r * s, g * s, bl * s, r, g, bl, r, g, bl);
    }
  }

  // Roof: earcut over outer + holes (indices into the concatenated rings).
  const outerV = b.footprint.map(([x, y]) => new THREE.Vector2(x, y));
  const holesV = (b.holes ?? []).map((ring) => ring.map(([x, y]) => new THREE.Vector2(x, y)));
  const flat: THREE.Vector2[] = outerV.concat(...holesV);
  const triangles = THREE.ShapeUtils.triangulateShape(outerV, holesV);
  const rr = r * ROOF_SHADE;
  const rg = g * ROOF_SHADE;
  const rb = bl * ROOF_SHADE;
  for (const tri of triangles) {
    for (const idx of tri) {
      const v = flat[idx];
      if (!v) continue;
      soup.pos.push(v.x, h, -v.y);
      soup.nrm.push(0, 1, 0);
      soup.col!.push(rr, rg, rb);
    }
  }
}
