import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { Building, GameMap, Landmark, RailLine, RailStop, StreetEdge, WaterBody } from "@battle-juice/shared";

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
const WATER_Y = 0.05; // between ground and streets
const PARK_Y = 0.07;
const STREET_Y = 0.1; // lift above ground to avoid z-fighting
const TRAIL_Y = 0.12;

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
const YARD_Y = 0.065; // under streets, over parks
const RAIL_Y = 0.14; // over streets/trails so crossings read
const STOP_Y = 0.16;
const STOP_RADIUS = 5; // m platform disc

// Tile size for chunked meshes — one merged mesh per tile so the GPU
// frustum-culls off-screen chunks. Every building renders at every zoom.
const TILE = 1000; // meters

export interface WorldLayers {
  group: THREE.Group;
  /** Zoom-driven cosmetics (street tint brightens from altitude). */
  setBlend(f: number): void;
}

/** Static map meshes: ground, water, tiled street ribbons + buildings. */
export function buildWorld(map: GameMap): WorldLayers {
  const group = new THREE.Group();
  group.add(buildGround(map));
  const parks = buildPolys(map.parks ?? [], PARK_COLOR, PARK_Y);
  if (parks) group.add(parks);
  const water = buildPolys(map.water ?? [], WATER_COLOR, WATER_Y);
  if (water) group.add(water);
  const trails = buildTrails(map.trails ?? []);
  if (trails) group.add(trails);
  const yards = buildPolys(map.railYards ?? [], YARD_COLOR, YARD_Y);
  if (yards) group.add(yards);

  const streetMat = new THREE.MeshLambertMaterial({ color: STREET_COLOR, side: THREE.DoubleSide });
  for (const mesh of buildStreetTiles(map.edges, streetMat)) group.add(mesh);

  for (const mesh of buildRails(map.rails ?? [])) group.add(mesh);
  const stops = buildRailStops(map.railStops ?? []);
  if (stops) group.add(stops);

  const landmarkBuildings = new Map<number, Landmark["kind"]>();
  for (const m of map.landmarks ?? []) for (const id of m.buildingIds ?? []) landmarkBuildings.set(id, m.kind);
  for (const mesh of buildBuildingTiles(map.buildings, landmarkBuildings)) group.add(mesh);

  const streetNear = new THREE.Color(STREET_COLOR);
  const streetFar = new THREE.Color(0x5a6478); // brighter so the grid reads from altitude
  return {
    group,
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

function buildPolys(bodies: WaterBody[], color: number, y: number): THREE.Mesh | null {
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
  const mat = new THREE.MeshLambertMaterial({ color });
  return new THREE.Mesh(merged, mat);
}

function buildTrails(trails: { polyline: [number, number][] }[]): THREE.Mesh | null {
  const parts: THREE.BufferGeometry[] = [];
  for (const t of trails) {
    const geo = ribbon(t.polyline, 2.5, TRAIL_Y);
    if (geo) parts.push(geo);
  }
  if (parts.length === 0) return null;
  const merged = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ color: TRAIL_COLOR, side: THREE.DoubleSide }));
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
function buildStreetTiles(edges: StreetEdge[], mat: THREE.MeshLambertMaterial): THREE.Mesh[] {
  const tiles = new Map<number, Soup>();
  for (const edge of edges) {
    const [mx, my] = edge.polyline[Math.floor(edge.polyline.length / 2)]!;
    const key = tileKey(mx, my);
    let soup = tiles.get(key);
    if (!soup) tiles.set(key, (soup = { pos: [], nrm: [] }));
    pushRibbon(soup.pos, edge.polyline, edge.width, STREET_Y);
  }
  return [...tiles.values()].map((soup) => soupMesh(soup, mat));
}

/** Legacy single-geometry ribbon (trails only — low count). */
function ribbon(polyline: [number, number][], width: number, atY = STREET_Y): THREE.BufferGeometry | null {
  if (polyline.length < 2) return null;
  const pos: number[] = [];
  pushRibbon(pos, polyline, width, atY);
  if (pos.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  const up = new Float32Array(pos.length);
  for (let i = 1; i < up.length; i += 3) up[i] = 1;
  geo.setAttribute("normal", new THREE.BufferAttribute(up, 3));
  return geo;
}

/** Flat mitered ribbon along a polyline, appended to a position array. */
function pushRibbon(pos: number[], polyline: [number, number][], width: number, atY: number): void {
  if (polyline.length < 2) return;
  const half = width / 2;
  const left: [number, number][] = [];
  const right: [number, number][] = [];

  for (let i = 0; i < polyline.length; i++) {
    const [px, py] = polyline[i]!;
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

  for (let i = 0; i < polyline.length - 1; i++) {
    const quad = [left[i]!, right[i]!, right[i + 1]!, left[i + 1]!];
    for (const idx of [0, 1, 2, 0, 2, 3]) {
      const [wx, wy] = quad[idx]!;
      pos.push(wx, atY, -wy);
    }
  }
}

/** One mesh per rail kind: ribbon polylines in that kind's color. */
function buildRails(rails: RailLine[]): THREE.Mesh[] {
  const soups = new Map<RailLine["kind"], Soup>();
  for (const r of rails) {
    let soup = soups.get(r.kind);
    if (!soup) soups.set(r.kind, (soup = { pos: [], nrm: [] }));
    pushRibbon(soup.pos, r.polyline, RAIL_STYLE[r.kind].width, RAIL_Y);
  }
  return [...soups.entries()].map(([kind, soup]) =>
    soupMesh(soup, new THREE.MeshLambertMaterial({ color: RAIL_STYLE[kind].color, side: THREE.DoubleSide })),
  );
}

/** Rail stops as flat platform discs in their line's color (one mesh). */
function buildRailStops(stops: RailStop[]): THREE.Mesh | null {
  if (stops.length === 0) return null;
  const soup: Soup = { pos: [], nrm: [], col: [] };
  const SEGS = 12;
  for (const s of stops) {
    const c = new THREE.Color(RAIL_STYLE[s.kind].color).multiplyScalar(1.35);
    for (let i = 0; i < SEGS; i++) {
      const a0 = (i / SEGS) * Math.PI * 2;
      const a1 = ((i + 1) / SEGS) * Math.PI * 2;
      soup.pos.push(
        s.x, STOP_Y, -s.y,
        s.x + Math.cos(a0) * STOP_RADIUS, STOP_Y, -(s.y + Math.sin(a0) * STOP_RADIUS),
        s.x + Math.cos(a1) * STOP_RADIUS, STOP_Y, -(s.y + Math.sin(a1) * STOP_RADIUS),
      );
      for (let v = 0; v < 3; v++) soup.col!.push(c.r, c.g, c.b);
    }
  }
  return soupMesh(soup, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
}

/** Buildings written straight into per-tile buffers (keyed by first vertex). */
function buildBuildingTiles(buildings: Building[], landmarks: Map<number, Landmark["kind"]>): THREE.Mesh[] {
  // Palette colors as flat rgb triples, resolved once.
  const palettes = new Map<string, number[][]>();
  for (const [use, hexes] of Object.entries(USE_TINTS)) {
    palettes.set(use, hexes.map((h) => {
      const c = new THREE.Color(h);
      return [c.r, c.g, c.b];
    }));
  }
  const tiles = new Map<number, Soup>();
  for (const b of buildings) {
    if (b.footprint.length < 3) continue;
    const [fx, fy] = b.footprint[0]!;
    const key = tileKey(fx, fy);
    let soup = tiles.get(key);
    if (!soup) tiles.set(key, (soup = { pos: [], nrm: [], col: [] }));
    const landmarkKind = landmarks.get(b.id);
    if (landmarkKind) {
      pushPrism(soup, b, LANDMARK_RGB.get(landmarkKind)!);
      continue;
    }
    const palette = palettes.get(b.use ?? "other") ?? palettes.get("other")!;
    pushPrism(soup, b, palette[b.id % palette.length]!);
  }
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  return [...tiles.values()].map((soup) => soupMesh(soup, material));
}

/**
 * One building: earcut roof at height + a wall quad per ring edge, appended
 * directly to the tile soup. Winding conventions (outer CCW, holes CW) make
 * one wall formula serve both: (dy, -dx) is outward for CCW and points into
 * the courtyard for CW holes — exactly the visible side each time.
 */
function pushPrism(soup: Soup, b: Building, rgb: number[]): void {
  const h = b.height;
  const rings = [b.footprint, ...(b.holes ?? [])];
  const before = soup.pos.length;

  // Walls.
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
      soup.pos.push(ax, 0, -ay, bx, 0, -by, bx, h, -by, ax, 0, -ay, bx, h, -by, ax, h, -ay);
      for (let v = 0; v < 6; v++) soup.nrm.push(nx, 0, nz);
    }
  }

  // Roof: earcut over outer + holes (indices into the concatenated rings).
  const outerV = b.footprint.map(([x, y]) => new THREE.Vector2(x, y));
  const holesV = (b.holes ?? []).map((ring) => ring.map(([x, y]) => new THREE.Vector2(x, y)));
  const flat: THREE.Vector2[] = outerV.concat(...holesV);
  const triangles = THREE.ShapeUtils.triangulateShape(outerV, holesV);
  for (const tri of triangles) {
    for (const idx of tri) {
      const v = flat[idx];
      if (!v) continue;
      soup.pos.push(v.x, h, -v.y);
      soup.nrm.push(0, 1, 0);
    }
  }

  const added = (soup.pos.length - before) / 3;
  for (let v = 0; v < added; v++) soup.col!.push(rgb[0]!, rgb[1]!, rgb[2]!);
}
