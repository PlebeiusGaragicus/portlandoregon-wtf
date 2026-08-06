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
  type RoadClass,
  type StreetEdge,
  type WaterBody,
} from "@battle-juice/shared";
import { buildCityModel, type CityModel } from "../city.js";

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
const SIDEWALK_COLOR = 0x555c66; // concrete, lighter than asphalt
/**
 * Every flat paved layer sits at ONE height, and their order is decided by
 * draw order rather than by geometry.
 *
 * They used to be stacked in centimetre steps — street 0.09, rail 0.10, stop
 * 0.12, marking 0.15, trail 0.18 — with a shared polygonOffset bias holding
 * the whole stack above the terrain. That works only while a draped triangle
 * stays within a centimetre or two of the ground it is painted on, and it
 * doesn't: measured on real tiles, rail inverted against street across 11% of
 * the ground they share, because the gap between them was 1 cm and the drape
 * error is larger than that almost everywhere interesting.
 *
 * A hover cannot express layer order at this scale. So none of them hover
 * relative to each other: they are coplanar, they do not write depth (so they
 * never depth-test against each other), and DECAL_ORDER decides who paints
 * last. Ordering becomes exact and terrain-independent.
 *
 * The polygonOffset bias still does its original job — winning against the
 * terrain mesh — and must stay IDENTICAL for every decal: its slope-scaled
 * term varies per triangle, so distinct biases between coplanar layers tear
 * into sawtooth patches on steep grazing views.
 */
const DECAL_Y = 0.09;
/** Assign a decal's place in the paint order. Coplanar decals write no
 * depth, so this is the ONLY thing deciding which one is visible. */
function order<T extends THREE.Object3D>(meshes: T[], at: number): T[] {
  for (const m of meshes) m.renderOrder = at;
  return meshes;
}

/** Paint order, low to high. Terrain and buildings are 0. */
const DECAL_ORDER = {
  water: 1,
  park: 2,
  yard: 3,
  trail: 4,
  street: 5,
  rail: 6,
  railStop: 7,
  marking: 8,
  laneLine: 9,
} as const;
/** Sidewalks are the exception: a raised slab with skirt walls is real
 * geometry, not paint, so it keeps writing depth and occludes properly. It
 * draws before the decals so its depth is there to reject anything the curb
 * covers. */
const SIDEWALK_ORDER = 0.5;
const SIDEWALK_Y = 0.03;
const CURB_H = 0.14; // raised concrete: sidewalk tops sit a curb above grade
// Rendered curb-to-curb widths, wider than the baked graph widths: the paved
// roadway should fill its right-of-way up to the sidewalks, leaving only a
// planting strip. (edge.width stays the sim/graph number.)
const RENDER_WIDTH: Record<RoadClass, number> = { arterial: 17, collector: 13.5, local: 11, alley: 5, path: 2.5 };
const MARK_WHITE = 0xb9c0c8; // painted pavement markings
const MARK_YELLOW = 0xc2a53a;

/**
 * Decal-style material: drawn essentially on the terrain surface, pulled
 * toward the camera in depth so it always wins against the ground mesh.
 *
 * `solid` opts out of the coplanar scheme for geometry that has real height
 * (sidewalk slabs): it writes depth so it can occlude, at the cost of being
 * ordered by depth rather than by draw order.
 */
function decalMat(
  opts: THREE.MeshLambertMaterialParameters & { solid?: boolean },
): THREE.MeshLambertMaterial {
  const { solid, ...rest } = opts;
  return new THREE.MeshLambertMaterial({
    ...rest,
    side: THREE.DoubleSide,
    // Coplanar decals must not depth-test against each other — with no depth
    // written, the only thing they test against is the terrain.
    depthWrite: solid === true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}

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
  // Lighter tier: schools are numerous (580+), so a muted tint only — no
  // emissive glow, no minimap dot, labels only at very close zoom.
  school: { building: 0x8f8563, plateBg: "rgba(66, 60, 38, 0.88)", plateBorder: "#c9bd8d", plateText: "#ece5c8" },
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
  /** In-place surgery on the merged building soups (fire/destruction). */
  shells: BuildingShells;
}

/**
 * Every building's vertex range inside its merged tile mesh, so the fire and
 * destruction sim can recolor (char) or rewrite (collapse to rubble) ONE
 * building in place — no per-building meshes, no soup rebuilds. Buildings
 * are addressed by their index in map.buildings.
 */
export class BuildingShells {
  /** mesh slot per building (-1 = no geometry, e.g. degenerate footprint). */
  private meshIdx: Int32Array;
  private start: Uint32Array; // first vertex of the prism
  private vcount: Uint32Array;
  private rgb: Float32Array; // build-time tint (palette or landmark theme)
  private meshes: THREE.Mesh[] = [];
  private charRGB = [0.09, 0.082, 0.078];

  /** `baseZ` is borrowed from the city model, not copied: rebuilding a prism
   * has to use the SAME base the original build used, and the city model is
   * where that now comes from. */
  constructor(private buildings: Building[], private baseZ: Float32Array) {
    this.meshIdx = new Int32Array(buildings.length).fill(-1);
    this.start = new Uint32Array(buildings.length);
    this.vcount = new Uint32Array(buildings.length);
    this.rgb = new Float32Array(buildings.length * 3);
  }

  record(bi: number, meshIdx: number, vertStart: number, vertCount: number, rgb: number[]): void {
    this.meshIdx[bi] = meshIdx;
    this.start[bi] = vertStart;
    this.vcount[bi] = vertCount;
    this.rgb[bi * 3] = rgb[0]!;
    this.rgb[bi * 3 + 1] = rgb[1]!;
    this.rgb[bi * 3 + 2] = rgb[2]!;
  }

  finalize(meshes: THREE.Mesh[]): void {
    this.meshes = meshes;
  }

  /** Blend a building's vertex colors toward char black (t: 0..1). */
  char(bi: number, t: number): void {
    const mi = this.meshIdx[bi]!;
    if (mi < 0) return;
    const mesh = this.meshes[mi];
    const b = this.buildings[bi];
    if (!mesh || !b) return;
    const col = mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    // Rebuild the original per-vertex color pattern and lerp toward char —
    // no snapshots needed; the pattern is deterministic from the soup layout.
    const tmp: Soup = { pos: [], nrm: [], col: [] };
    pushPrism(tmp, b, [this.rgb[bi * 3]!, this.rgb[bi * 3 + 1]!, this.rgb[bi * 3 + 2]!], this.baseZ[bi]!);
    const s = this.start[bi]!;
    const n = this.vcount[bi]!;
    const [cr, cg, cb] = this.charRGB as [number, number, number];
    const src = tmp.col!;
    for (let v = 0; v < n; v++) {
      col.setXYZ(
        s + v,
        src[v * 3]! * (1 - t) + cr * t,
        src[v * 3 + 1]! * (1 - t) + cg * t,
        src[v * 3 + 2]! * (1 - t) + cb * t,
      );
    }
    this.upload(col, s, n, 3);
  }

  /**
   * Localized charring: blend vertex colors toward char black by proximity to
   * burn sources (fire cells, blast points). Each source is {x, y, f, r} —
   * world position, char strength 0..1, falloff radius. Rebuilds the original
   * pattern each call, so callers pass MONOTONIC per-source strengths; scars
   * persist in the color buffer after the fire is out.
   */
  charLocal(bi: number, srcs: { x: number; y: number; f: number; r: number }[]): void {
    const mi = this.meshIdx[bi]!;
    if (mi < 0 || srcs.length === 0) return;
    const mesh = this.meshes[mi];
    const b = this.buildings[bi];
    if (!mesh || !b) return;
    const col = mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    const tmp: Soup = { pos: [], nrm: [], col: [] };
    pushPrism(tmp, b, [this.rgb[bi * 3]!, this.rgb[bi * 3 + 1]!, this.rgb[bi * 3 + 2]!], this.baseZ[bi]!);
    const s = this.start[bi]!;
    const n = Math.min(this.vcount[bi]!, tmp.pos.length / 3);
    const [cr, cg, cb] = this.charRGB as [number, number, number];
    const base = this.baseZ[bi]!;
    const hInv = 1 / Math.max(1, b.height);
    const src = tmp.col!;
    for (let v = 0; v < n; v++) {
      const wx = tmp.pos[v * 3]!;
      const wy = -tmp.pos[v * 3 + 2]!; // scene z back to world y
      const relH = Math.min(1, Math.max(0, (tmp.pos[v * 3 + 1]! - base) * hInv));
      let c = 0;
      for (const sc of srcs) {
        const d = Math.hypot(wx - sc.x, wy - sc.y);
        if (d >= sc.r) continue;
        const k = 1 - d / sc.r;
        const f = sc.f * Math.sqrt(k);
        if (f > c) c = f;
      }
      // Soot climbs: upper walls blacken slightly ahead of the base.
      const t = Math.min(1, c * (0.8 + 0.35 * relH));
      col.setXYZ(
        s + v,
        src[v * 3]! * (1 - t) + cr * t,
        src[v * 3 + 1]! * (1 - t) + cg * t,
        src[v * 3 + 2]! * (1 - t) + cb * t,
      );
    }
    this.upload(col, s, n, 3);
  }

  /** Rewrite the prism as a jagged ash mound (same vertex count, in place).
   * Anything above the base gets a hashed rubble height and is pulled toward
   * the centroid, with per-vertex ash-gray speckle — a heap, not a box. */
  collapse(bi: number): void {
    const mi = this.meshIdx[bi]!;
    if (mi < 0) return;
    const mesh = this.meshes[mi];
    const b = this.buildings[bi];
    if (!mesh || !b) return;
    const tmp: Soup = { pos: [], nrm: [], col: [] };
    const rubbleH = Math.max(1.4, Math.min(5, b.height * 0.16));
    pushPrism(tmp, { ...b, height: rubbleH }, [0.16, 0.15, 0.14], this.baseZ[bi]!);
    let ccx = 0;
    let ccy = 0;
    for (const [px, py] of b.footprint) {
      ccx += px;
      ccy += py;
    }
    ccx /= b.footprint.length;
    ccy /= b.footprint.length;
    const base = this.baseZ[bi]!;
    const nv = tmp.pos.length / 3;
    for (let v = 0; v < nv; v++) {
      const wx = tmp.pos[v * 3]!;
      const wz = tmp.pos[v * 3 + 1]!;
      const wy = -tmp.pos[v * 3 + 2]!;
      const h1 = hash2(wx * 0.73 + 11.3, wy * 0.61 - 4.7);
      const h2 = hash2(wx * 1.91 - 3.1, wy * 1.37 + 8.9);
      if (wz > base + 0.35) {
        // Top-of-heap vertex: jagged height, leaning inward — collapsed mass
        // slumps toward the middle of the footprint.
        const lean = 0.12 + h2 * 0.14;
        tmp.pos[v * 3] = wx + (ccx - wx) * lean;
        tmp.pos[v * 3 + 2] = -(wy + (ccy - wy) * lean);
        tmp.pos[v * 3 + 1] = base + 0.4 + h1 * h1 * (rubbleH + 1.6);
      }
      // Ash speckle: charred black through pale gray ash.
      const g = 0.09 + h2 * 0.2;
      tmp.col![v * 3] = g * 1.04;
      tmp.col![v * 3 + 1] = g;
      tmp.col![v * 3 + 2] = g * 0.94;
    }
    const pos = mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    const col = mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    const s = this.start[bi]!;
    const n = Math.min(this.vcount[bi]!, nv);
    for (let v = 0; v < n; v++) {
      pos.setXYZ(s + v, tmp.pos[v * 3]!, tmp.pos[v * 3 + 1]!, tmp.pos[v * 3 + 2]!);
      col.setXYZ(s + v, tmp.col![v * 3]!, tmp.col![v * 3 + 1]!, tmp.col![v * 3 + 2]!);
    }
    this.upload(pos, s, n, 3);
    this.upload(col, s, n, 3);
  }

  private upload(attr: THREE.BufferAttribute, start: number, count: number, itemSize: number): void {
    const a = attr as THREE.BufferAttribute & { addUpdateRange?: (s: number, c: number) => void };
    if (a.addUpdateRange) a.addUpdateRange(start * itemSize, count * itemSize);
    attr.needsUpdate = true;
  }
}

/** Static map meshes: terrain (or flat ground), water, tiled street ribbons
 * + buildings — all draped onto the heightfield when one is provided.
 *
 * Drains {@link buildWorldSteps}. Callers that want to report progress (the
 * boot console) should drive the generator instead. */
export function buildWorld(map: GameMap, hf?: Heightfield | null, city?: CityModel): WorldLayers {
  const it = buildWorldSteps(map, hf, city);
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}

/**
 * buildWorld as a generator, yielding the label of the step it is ABOUT to
 * run. This is the slowest thing in the whole client (~20 s on a laptop), and
 * a caller that pumps it between animation frames can both paint the label
 * and keep the page alive — a single opaque "building the city" line is
 * useless when the interesting question is which step ate the time (or died).
 */
export function* buildWorldSteps(
  map: GameMap,
  hf?: Heightfield | null,
  city: CityModel = buildCityModel(map, hf),
): Generator<string, WorldLayers, void> {
  const ground: GroundFn = hf ? (x, y) => heightAt(hf, x, y) : () => 0;
  const group = new THREE.Group();
  yield hf ? "terrain mesh" : "flat ground plane";
  if (hf) {
    // Water/parks/yards are painted INTO the terrain's vertex colors instead
    // of draped as separate polygons: no z-fighting, no sliver triangles
    // from earcutting the huge clipped river rings — and since 3DEP is
    // hydro-flattened, water-tinted terrain IS the river surface (including
    // the drop at Willamette Falls).
    for (const mesh of buildTerrainTiles(map, hf)) group.add(mesh);
  } else {
    group.add(buildGround(map));
    const parks = flatPolys(map.parks ?? [], PARK_COLOR, DECAL_Y);
    if (parks) group.add(...order([parks], DECAL_ORDER.park));
    const water = flatPolys(map.water ?? [], WATER_COLOR, DECAL_Y);
    if (water) group.add(...order([water], DECAL_ORDER.water));
    const yards = flatPolys(map.railYards ?? [], YARD_COLOR, DECAL_Y);
    if (yards) group.add(...order([yards], DECAL_ORDER.yard));
  }

  // Ribbon legs that cross water are bridges: their deck spans between the
  // bank heights instead of sagging onto the riverbed. (Land overpasses
  // still drape — the ZLEV rule is phase 2.)
  yield "water mask";
  const overWater = waterTester(map.water ?? [], map.meta.width, map.meta.height);

  // Terrain cell size lets ribbon vertices land exactly where the ground
  // surface kinks, so draped decals conform instead of clipping.
  const cell = hf ? hf.cellSize : Infinity;

  yield `${(map.trails ?? []).length} trails`;
  const trails = buildTrails(map.trails ?? [], ground, cell, overWater);
  if (trails) group.add(...order([trails], DECAL_ORDER.trail));

  yield `${map.edges.length} street edges`;
  const streetMat = decalMat({ color: STREET_COLOR });
  for (const mesh of order(buildStreetTiles(map.edges, streetMat, ground, cell, overWater), DECAL_ORDER.street)) {
    group.add(mesh);
  }

  yield `${(map.rails ?? []).length} rail lines + ${(map.railStops ?? []).length} stops`;
  for (const mesh of order(buildRails(map.rails ?? [], ground, cell, overWater), DECAL_ORDER.rail)) group.add(mesh);
  const stops = buildRailStops(map.railStops ?? [], ground);
  if (stops) group.add(...order([stops], DECAL_ORDER.railStop));

  yield `${map.buildings.length} building prisms`;
  const landmarkBuildings = new Map<number, Landmark["kind"]>();
  for (const m of map.landmarks ?? []) for (const id of m.buildingIds ?? []) landmarkBuildings.set(id, m.kind);
  const { meshes: buildingMeshes, shells } = buildBuildingTiles(map.buildings, landmarkBuildings, city);
  for (const mesh of buildingMeshes) group.add(mesh);

  // Street-level dressing, in its own zoom-gated group.
  const detail = new THREE.Group();
  group.add(detail);
  yield `${(map.sidewalks ?? []).length} sidewalk slabs`;
  for (const mesh of order(
    drapedPolyTiles(
      (map.sidewalks ?? []).map((s) => ({ rings: s.rings, color: SIDEWALK_COLOR })),
      SIDEWALK_Y,
      ground,
      CURB_H,
    ),
    SIDEWALK_ORDER,
  )) detail.add(mesh);
  yield `${(map.markingAreas ?? []).length} painted areas + ${(map.markingLines ?? []).length} lane lines`;
  for (const mesh of order(
    drapedPolyTiles(
      (map.markingAreas ?? []).map((a) => ({ rings: a.rings, color: a.style === "yellow" ? MARK_YELLOW : MARK_WHITE })),
      DECAL_Y,
      ground,
    ),
    DECAL_ORDER.marking,
  )) detail.add(mesh);
  {
    const laneTiles = new Map<number, Soup>();
    for (const l of map.markingLines ?? []) {
      const [mx, my] = l.polyline[Math.floor(l.polyline.length / 2)]!;
      let soup = laneTiles.get(tileKey(mx, my));
      if (!soup) laneTiles.set(tileKey(mx, my), (soup = { pos: [], nrm: [] }));
      pushRibbon(soup.pos, l.polyline, 0.35, DECAL_Y, ground, cell);
    }
    const laneMat = decalMat({ color: MARK_YELLOW });
    const lanes = [...laneTiles.values()].map((soup) => soupMesh(soup, laneMat));
    for (const mesh of order(lanes, DECAL_ORDER.laneLine)) detail.add(mesh);
  }

  const streetNear = new THREE.Color(STREET_COLOR);
  const streetFar = new THREE.Color(0x5a6478); // brighter so the grid reads from altitude
  return {
    group,
    detail,
    shells,
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

const DRAPE_EDGE = 10; // m — subdivide small-poly triangles down to this
const DRAPE_N_CAP = 32;

/**
 * Small polygons (sidewalk strips, painted markings) draped onto terrain and
 * bucketed into 1 km tile meshes, one material per color. Earcut is safe
 * here — these are compact, clean shapes, unlike the clipped river rings.
 */
function drapedPolyTiles(
  bodies: { rings: [number, number][][]; color: number }[],
  yOff: number,
  ground: GroundFn,
  /** Extrude tops this far above grade with skirt walls along the rings —
   * raised concrete slabs (sidewalks) instead of flat paint. */
  curb = 0,
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
        soup!.pos.push(p[0], yOff + curb + ground(p[0], p[1]), -p[1]);
        if (curb) soup!.nrm.push(0, 1, 0);
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
    if (curb) {
      // Skirt walls along every ring edge, sunk below grade so slopes never
      // open a gap under the slab.
      const lo = yOff - 0.4;
      const hi = yOff + curb;
      for (const ring of body.rings) {
        if (ring.length < 3) continue;
        for (let i = 0; i < ring.length; i++) {
          const [x1, y1] = ring[i]!;
          const [x2, y2] = ring[(i + 1) % ring.length]!;
          const len = Math.hypot(x2 - x1, y2 - y1);
          if (len < 1e-6) continue;
          const nx = (y2 - y1) / len;
          const ny = -(x2 - x1) / len;
          const segs = Math.max(1, Math.ceil(len / 12));
          for (let k = 0; k < segs; k++) {
            const ax = x1 + ((x2 - x1) * k) / segs;
            const ay = y1 + ((y2 - y1) * k) / segs;
            const bx = x1 + ((x2 - x1) * (k + 1)) / segs;
            const by = y1 + ((y2 - y1) * (k + 1)) / segs;
            const ga = ground(ax, ay);
            const gb = ground(bx, by);
            const wall: [number, number, number][] = [
              [ax, ga + lo, ay],
              [bx, gb + lo, by],
              [bx, gb + hi, by],
              [ax, ga + lo, ay],
              [bx, gb + hi, by],
              [ax, ga + hi, ay],
            ];
            for (const [wx, wh, wy] of wall) {
              soup.pos.push(wx, wh, -wy);
              soup.nrm.push(nx, 0, -ny);
            }
          }
        }
      }
    }
  }
  const meshes: THREE.Mesh[] = [];
  for (const [color, tiles] of byColor) {
    const mat = decalMat({ color, solid: curb > 0 });
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
  cell: number,
  overWater: (p: [number, number][]) => boolean,
): THREE.Mesh | null {
  if (trails.length === 0) return null;
  const soup: Soup = { pos: [], nrm: [] };
  for (const t of trails) {
    pushRibbon(soup.pos, t.polyline, 2.5, DECAL_Y, ground, cell, overWater(t.polyline));
  }
  if (soup.pos.length === 0) return null;
  return soupMesh(soup, decalMat({ color: TRAIL_COLOR }));
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
  cell: number,
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
    pushRibbon(soup.pos, edge.polyline, RENDER_WIDTH[edge.class] ?? edge.width, DECAL_Y, ground, cell, span);
  }
  return [...tiles.values()].map((soup) => soupMesh(soup, mat));
}

const RIBBON_STEP = 15; // m — max span between ribbon cross-sections

/** Push the segment parameters (0..1) where `u` crosses integer values. */
function addCrossings(ts: number[], u0: number, u1: number): void {
  if (u0 === u1) return;
  const lo = Math.min(u0, u1);
  const hi = Math.max(u0, u1);
  for (let k = Math.ceil(lo); k <= Math.floor(hi); k++) {
    const t = (k - u0) / (u1 - u0);
    if (t > 1e-4 && t < 1 - 1e-4) ts.push(t);
  }
}

/**
 * Insert points so no span exceeds RIBBON_STEP AND a vertex lands wherever
 * the segment crosses a terrain grid line (columns, rows, and the cell
 * anti-diagonals the mesh is triangulated along). Between two such vertices
 * the terrain surface is planar, so a draped ribbon sampled at them conforms
 * exactly instead of letting slopes poke through mid-span.
 */
function resample(polyline: [number, number][], cell: number): [number, number][] {
  const out: [number, number][] = [polyline[0]!];
  for (let i = 1; i < polyline.length; i++) {
    const [ax, ay] = polyline[i - 1]!;
    const [bx, by] = polyline[i]!;
    const len = Math.hypot(bx - ax, by - ay);
    const ts: number[] = [];
    const n = Math.ceil(len / RIBBON_STEP);
    for (let k = 1; k < n; k++) ts.push(k / n);
    if (Number.isFinite(cell)) {
      addCrossings(ts, ax / cell, bx / cell);
      addCrossings(ts, ay / cell, by / cell);
      addCrossings(ts, (ax + ay) / cell, (bx + by) / cell);
    }
    ts.sort((p, q) => p - q);
    let last = 0;
    for (const t of ts) {
      if (t - last < 1e-4) continue;
      last = t;
      out.push([ax + (bx - ax) * t, ay + (by - ay) * t]);
    }
    out.push([bx, by]);
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
  cell: number,
  span = false,
): void {
  if (rawPolyline.length < 2) return;
  const polyline = resample(rawPolyline, cell);
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

  // Two strips with a shared center row: sampling the centerline height too
  // lets wide roads fold across a terrain crease instead of planking over it
  // (or being sliced by it).
  const rows = [left, polyline, right];
  for (let i = 0; i < polyline.length - 1; i++) {
    for (let s = 0; s < 2; s++) {
      const A = rows[s]!;
      const B = rows[s + 1]!;
      const quad: [number, number, number][] = [
        [...A[i]!, heightOf(i, A[i]![0], A[i]![1])],
        [...B[i]!, heightOf(i, B[i]![0], B[i]![1])],
        [...B[i + 1]!, heightOf(i + 1, B[i + 1]![0], B[i + 1]![1])],
        [...A[i + 1]!, heightOf(i + 1, A[i + 1]![0], A[i + 1]![1])],
      ];
      for (const idx of [0, 1, 2, 0, 2, 3]) {
        const [wx, wy, wh] = quad[idx]!;
        pos.push(wx, atY + wh, -wy);
      }
    }
  }
}

/** One mesh per rail kind: ribbon polylines in that kind's color. */
function buildRails(
  rails: RailLine[],
  ground: GroundFn,
  cell: number,
  overWater: (p: [number, number][]) => boolean,
): THREE.Mesh[] {
  const soups = new Map<RailLine["kind"], Soup>();
  for (const r of rails) {
    let soup = soups.get(r.kind);
    if (!soup) soups.set(r.kind, (soup = { pos: [], nrm: [] }));
    pushRibbon(soup.pos, r.polyline, RAIL_STYLE[r.kind].width, DECAL_Y, ground, cell, overWater(r.polyline));
  }
  return [...soups.entries()].map(([kind, soup]) =>
    soupMesh(soup, decalMat({ color: RAIL_STYLE[kind].color })),
  );
}

/** Rail stops as flat platform discs in their line's color (one mesh). */
function buildRailStops(stops: RailStop[], ground: GroundFn): THREE.Mesh | null {
  if (stops.length === 0) return null;
  const soup: Soup = { pos: [], nrm: [], col: [] };
  const SEGS = 12;
  for (const s of stops) {
    const c = new THREE.Color(RAIL_STYLE[s.kind].color).multiplyScalar(1.35);
    const y = DECAL_Y + ground(s.x, s.y);
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
  return soupMesh(soup, decalMat({ vertexColors: true }));
}

/** Buildings written straight into per-tile buffers (keyed by first vertex). */
function buildBuildingTiles(
  buildings: Building[],
  landmarks: Map<number, Landmark["kind"]>,
  city: CityModel,
): { meshes: THREE.Mesh[]; shells: BuildingShells } {
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
  const shells = new BuildingShells(buildings, city.baseZ);
  // Per-building vertex ranges, resolved to mesh indices after the loop
  // (tile and landmark soups interleave while building).
  const pending: { bi: number; key: number | string; start: number; count: number; rgb: number[] }[] = [];
  for (let bi = 0; bi < buildings.length; bi++) {
    const b = buildings[bi]!;
    if (!city.valid[bi]) continue;
    const [fx, fy] = b.footprint[0]!;
    const key = tileKey(fx, fy);
    let soup = tiles.get(key);
    if (!soup) tiles.set(key, (soup = { pos: [], nrm: [], col: [] }));
    const base = city.baseZ[bi]!;
    const cx = city.cx[bi]!;
    const cy = city.cy[bi]!;
    const landmarkKind = landmarks.get(b.id);
    if (landmarkKind) {
      let ls = lmSoups.get(landmarkKind);
      if (!ls) lmSoups.set(landmarkKind, (ls = { pos: [], nrm: [], col: [] }));
      const lmRgb = LANDMARK_RGB.get(landmarkKind)!;
      const s0 = ls.pos.length / 3;
      pushPrism(ls, b, lmRgb, base);
      pending.push({ bi, key: `lm:${landmarkKind}`, start: s0, count: ls.pos.length / 3 - s0, rgb: lmRgb });
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
    const rgb = palette[hash % palette.length]!;
    const s0 = soup.pos.length / 3;
    pushPrism(soup, b, rgb, base);
    pending.push({ bi, key, start: s0, count: soup.pos.length / 3 - s0, rgb });
  }
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const meshes = [...tiles.values()].map((soup) => soupMesh(soup, material));
  const keyIndex = new Map<number | string, number>();
  [...tiles.keys()].forEach((k, i) => keyIndex.set(k, i));
  for (const [kind, soup] of lmSoups) {
    // Lighter-tier kinds keep the tint but not the glow.
    const emissive = kind === "school" ? 0 : 0.42;
    keyIndex.set(`lm:${kind}`, meshes.length);
    meshes.push(
      soupMesh(
        soup,
        new THREE.MeshLambertMaterial({
          vertexColors: true,
          flatShading: true,
          emissive: new THREE.Color(LANDMARK_THEMES[kind].building),
          emissiveIntensity: emissive,
        }),
      ),
    );
  }
  for (const p of pending) {
    shells.record(p.bi, keyIndex.get(p.key)!, p.start, p.count, p.rgb);
  }
  shells.finalize(meshes);
  return { meshes, shells };
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

/** Deterministic 2D hash → 0..1 (rubble jitter must survive rebuilds). */
function hash2(x: number, y: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

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
