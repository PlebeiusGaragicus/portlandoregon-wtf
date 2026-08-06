import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  buildingHeight,
  buildingUse,
  forEachRingVertex,
  heightAt,
  ringBase,
  ringCount,
  featureAnchor,
  featureRings,
  ringLength,
  tileKeyAt,
  type BuildingStore,
  type FeatureStore,
  type GameMap,
  type LayerStores,
  type Heightfield,
  type Landmark,
  type RailLine,
  type RailStop,
  type RoadClass,
  type StreetEdge,
  type WaterBody,
} from "@battle-juice/shared";
import { buildCityModel, type CityModel } from "../city.js";

/** Rail kinds, in the order the layer store encodes them. */
const RAIL_KINDS = ["rail", "max", "streetcar", "wes"] as const;

/**
 * Store -> the object shapes the mesh builders still take.
 *
 * These allocate, which is the thing the stores exist to avoid — so they are
 * called per tile, or once at boot for a layer that is built whole and then
 * dropped. Never per frame, and never over a streamed layer's full extent.
 */
function featurePolys(store: FeatureStore): { rings: [number, number][][] }[] {
  const out: { rings: [number, number][][] }[] = [];
  for (let i = 0; i < store.count; i++) out.push({ rings: featureRings(store, i) });
  return out;
}

function featureLines<K extends string>(
  store: FeatureStore,
  kinds?: readonly K[],
): { polyline: [number, number][]; kind: K }[] {
  const out: { polyline: [number, number][]; kind: K }[] = [];
  for (let i = 0; i < store.count; i++) {
    out.push({
      polyline: featureRings(store, i)[0] ?? [],
      kind: (kinds ? kinds[store.attr[i]!] ?? kinds[0]! : ("" as K)),
    });
  }
  return out;
}

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
  /** Streamable building geometry. Empty until synced, unless the caller
   * asked for the whole city up front. */
  buildings: BuildingTiles;
  /** Streamable street-level dressing (sidewalks, pavement paint). */
  detailTiles: DecalTiles;
}

/**
 * Street-level dressing, streamed the way buildings are.
 *
 * Sidewalks alone were 18.6M vertices and 277 MB — more than every building
 * in the city as boxes, several times over — and they are already invisible
 * above 3 km because at that range they are subpixel. So they have no
 * business existing as geometry for the 99% of the map you are not standing
 * on.
 *
 * Unlike buildings there is no far tier: the correct appearance at distance
 * is "not drawn", which is what the zoom gate already did.
 */
export interface DecalTiles {
  group: THREE.Group;
  sync(want: Iterable<number>): void;
  buildAll(): void;
  stats(): { tiles: number; verts: number };
}

function createDetailTiles(
  layers: LayerStores,
  edges: StreetEdge[],
  streetMat: THREE.MeshLambertMaterial,
  overWater: (p: [number, number][]) => boolean,
  ground: GroundFn,
  cell: number,
): DecalTiles {
  const group = new THREE.Group();
  const TS = TILE;

  // Features are filed under one tile by a representative point, so a slab
  // that straddles a tile line belongs to exactly one of them and is never
  // built twice or dropped by both.
  const sidewalks = new Map<number, number[]>();
  const areas = new Map<number, number[]>();
  const lines = new Map<number, number[]>();
  const file = (index: Map<number, number[]>, key: number, i: number): void => {
    const at = index.get(key);
    if (at) at.push(i);
    else index.set(key, [i]);
  };
  // Filed straight from the stores — no feature objects are created until a
  // tile is actually built, and then only that tile's.
  const swStore = layers.sidewalks;
  const areaStore = layers.markingAreas;
  const lineStore = layers.markingLines;
  const fileAll = (store: FeatureStore, index: Map<number, number[]>): void => {
    for (let i = 0; i < store.count; i++) {
      const [x, y] = featureAnchor(store, i);
      file(index, tileKeyAt(x, y, TS), i);
    }
  };
  fileAll(swStore, sidewalks);
  fileAll(areaStore, areas);
  fileAll(lineStore, lines);
  const streets = new Map<number, number[]>();
  edges.forEach((e, i) => {
    if (e.struct === "tunnel") return; // roads vanish into the hillside
    const [mx, my] = e.polyline[Math.floor(e.polyline.length / 2)]!;
    file(streets, tileKeyAt(mx, my, TS), i);
  });

  const laneMat = decalMat({ color: MARK_YELLOW });
  const live = new Map<number, THREE.Mesh[]>();
  let verts = 0;

  function build(key: number): void {
    if (live.has(key)) return;
    const meshes: THREE.Mesh[] = [];
    for (const m of order(
      drapedPolyTiles(
        (sidewalks.get(key) ?? []).map((i) => ({ rings: featureRings(swStore, i), color: SIDEWALK_COLOR })),
        SIDEWALK_Y,
        ground,
        CURB_H,
      ),
      SIDEWALK_ORDER,
    )) meshes.push(m);
    for (const m of order(
      drapedPolyTiles(
        (areas.get(key) ?? []).map((i) => ({
          rings: featureRings(areaStore, i),
          color: areaStore.attr[i] === 1 ? MARK_YELLOW : MARK_WHITE,
        })),
        DECAL_Y,
        ground,
      ),
      DECAL_ORDER.marking,
    )) meshes.push(m);
    // Accurate, terrain-conforming asphalt for the tiles you are close to.
    // The coarse city-wide version underneath is the same colour at the same
    // height and writes no depth, so the two simply agree where they overlap.
    const streetIdx = streets.get(key) ?? [];
    if (streetIdx.length) {
      const soup: Soup = { pos: [], nrm: [] };
      for (const i of streetIdx) {
        const e = edges[i]!;
        pushRibbon(
          soup.pos, e.polyline, RENDER_WIDTH[e.class] ?? e.width, DECAL_Y, ground, cell,
          e.struct === "bridge" || overWater(e.polyline),
        );
      }
      if (soup.pos.length) meshes.push(...order([soupMesh(soup, streetMat)], DECAL_ORDER.street));
    }

    const laneIdx = lines.get(key) ?? [];
    if (laneIdx.length) {
      const soup: Soup = { pos: [], nrm: [] };
      for (const i of laneIdx) pushRibbon(soup.pos, featureRings(lineStore, i)[0]!, 0.35, DECAL_Y, ground, cell);
      if (soup.pos.length) meshes.push(...order([soupMesh(soup, laneMat)], DECAL_ORDER.laneLine));
    }
    for (const m of meshes) {
      m.receiveShadow = true;
      group.add(m);
      verts += (m.geometry.getAttribute("position") as THREE.BufferAttribute).count;
    }
    live.set(key, meshes);
  }

  function evict(key: number): void {
    const meshes = live.get(key);
    if (!meshes) return;
    for (const m of meshes) {
      verts -= (m.geometry.getAttribute("position") as THREE.BufferAttribute).count;
      group.remove(m);
      m.geometry.dispose();
    }
    live.delete(key);
  }

  const occupied = new Set<number>([...sidewalks.keys(), ...areas.keys(), ...lines.keys(), ...streets.keys()]);
  return {
    group,
    sync(want: Iterable<number>): void {
      const keep = want instanceof Set ? (want as Set<number>) : new Set(want);
      for (const key of [...live.keys()]) if (!keep.has(key)) evict(key);
      for (const key of keep) if (occupied.has(key)) build(key);
    },
    buildAll(): void {
      for (const key of occupied) build(key);
    },
    stats: () => ({ tiles: live.size, verts }),
  };
}

/**
 * Every building's vertex range inside its merged tile mesh, so the fire and
 * destruction sim can recolor (char) or rewrite (collapse to rubble) ONE
 * building in place — no per-building meshes, no soup rebuilds. Buildings
 * are addressed by their index in the building store.
 */
export class BuildingShells {
  /** mesh slot per building (-1 = no geometry, e.g. degenerate footprint). */
  private meshIdx: Int32Array;
  private start: Uint32Array; // first vertex of the prism
  private vcount: Uint32Array;
  private rgb: Float32Array; // build-time tint (palette or landmark theme)
  /** Live meshes by slot. Slots come and go as tiles stream in and out, so
   * this is a Map rather than a dense array. */
  private meshes = new Map<number, THREE.Mesh>();
  private nextSlot = 0;
  private charRGB = [0.09, 0.082, 0.078];

  /** `baseZ` is borrowed from the city model, not copied: rebuilding a prism
   * has to use the SAME base the original build used, and the city model is
   * where that now comes from. */
  constructor(private store: BuildingStore, private baseZ: Float32Array) {
    this.meshIdx = new Int32Array(store.count).fill(-1);
    this.start = new Uint32Array(store.count);
    this.vcount = new Uint32Array(store.count);
    this.rgb = new Float32Array(store.count * 3);
  }

  record(bi: number, meshIdx: number, vertStart: number, vertCount: number, rgb: number[]): void {
    this.meshIdx[bi] = meshIdx;
    this.start[bi] = vertStart;
    this.vcount[bi] = vertCount;
    this.rgb[bi * 3] = rgb[0]!;
    this.rgb[bi * 3 + 1] = rgb[1]!;
    this.rgb[bi * 3 + 2] = rgb[2]!;
  }

  /** Register a freshly built tile mesh; returns its slot. */
  addMesh(mesh: THREE.Mesh): number {
    const slot = this.nextSlot++;
    this.meshes.set(slot, mesh);
    return slot;
  }

  meshAt(slot: number): THREE.Mesh | undefined {
    return this.meshes.get(slot);
  }

  dropMesh(mesh: THREE.Mesh): void {
    for (const [slot, m] of this.meshes) {
      if (m === mesh) {
        this.meshes.delete(slot);
        return;
      }
    }
  }

  /** A tile went away: its buildings still exist, they just have no geometry
   * until it is rebuilt. Every surgery method already no-ops on -1. */
  forget(from: number, to: number): void {
    for (let bi = from; bi < to; bi++) this.meshIdx[bi] = -1;
  }

  /** Blend a building's vertex colors toward char black (t: 0..1). */
  char(bi: number, t: number): void {
    const mi = this.meshIdx[bi]!;
    if (mi < 0) return;
    const mesh = this.meshes.get(mi);
    if (!mesh) return;
    const col = mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    // Rebuild the original per-vertex color pattern and lerp toward char —
    // no snapshots needed; the pattern is deterministic from the soup layout.
    const tmp: Soup = { pos: [], nrm: [], col: [] };
    pushPrism(tmp, this.store, bi, [this.rgb[bi * 3]!, this.rgb[bi * 3 + 1]!, this.rgb[bi * 3 + 2]!], this.baseZ[bi]!);
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
    const mesh = this.meshes.get(mi);
    if (!mesh) return;
    const col = mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    const tmp: Soup = { pos: [], nrm: [], col: [] };
    pushPrism(tmp, this.store, bi, [this.rgb[bi * 3]!, this.rgb[bi * 3 + 1]!, this.rgb[bi * 3 + 2]!], this.baseZ[bi]!);
    const s = this.start[bi]!;
    const n = Math.min(this.vcount[bi]!, tmp.pos.length / 3);
    const [cr, cg, cb] = this.charRGB as [number, number, number];
    const base = this.baseZ[bi]!;
    const hInv = 1 / Math.max(1, buildingHeight(this.store, bi));
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
    const mesh = this.meshes.get(mi);
    if (!mesh) return;
    const tmp: Soup = { pos: [], nrm: [], col: [] };
    const rubbleH = Math.max(1.4, Math.min(5, buildingHeight(this.store, bi) * 0.16));
    pushPrism(tmp, this.store, bi, [0.16, 0.15, 0.14], this.baseZ[bi]!, rubbleH);
    let ccx = 0;
    let ccy = 0;
    forEachRingVertex(this.store, bi, 0, (px, py) => {
      ccx += px;
      ccy += py;
    });
    const nOuter = Math.max(1, ringLength(this.store, bi, 0));
    ccx /= nOuter;
    ccy /= nOuter;
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
export function buildWorld(
  map: GameMap,
  buildings: BuildingStore,
  layers: LayerStores,
  hf?: Heightfield | null,
  city?: CityModel,
  buildEveryBuilding = true,
): WorldLayers {
  const it = buildWorldSteps(map, buildings, layers, hf, city, buildEveryBuilding);
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
  buildings: BuildingStore,
  layers: LayerStores,
  hf?: Heightfield | null,
  city: CityModel = buildCityModel(buildings, hf),
  buildEveryBuilding = true,
): Generator<string, WorldLayers, void> {
  const ground: GroundFn = hf ? (x, y) => heightAt(hf, x, y) : () => 0;
  const group = new THREE.Group();
  // Needed by both the flat fallback and the bridge test below.
  const waterRings = featurePolys(layers.water);
  yield hf ? "terrain mesh" : "flat ground plane";
  if (hf) {
    // Water/parks/yards are painted INTO the terrain's vertex colors instead
    // of draped as separate polygons: no z-fighting, no sliver triangles
    // from earcutting the huge clipped river rings — and since 3DEP is
    // hydro-flattened, water-tinted terrain IS the river surface (including
    // the drop at Willamette Falls).
    for (const mesh of buildTerrainTiles(map, layers, hf)) group.add(mesh);
  } else {
    group.add(buildGround(map));
    const parks = flatPolys(featurePolys(layers.parks), PARK_COLOR, DECAL_Y);
    if (parks) group.add(...order([parks], DECAL_ORDER.park));
    const water = flatPolys(waterRings, WATER_COLOR, DECAL_Y);
    if (water) group.add(...order([water], DECAL_ORDER.water));
    const yards = flatPolys(featurePolys(layers.railYards), YARD_COLOR, DECAL_Y);
    if (yards) group.add(...order([yards], DECAL_ORDER.yard));
  }

  // Ribbon legs that cross water are bridges: their deck spans between the
  // bank heights instead of sagging onto the riverbed. (Land overpasses
  // still drape — the ZLEV rule is phase 2.)
  yield "water mask";
  const overWater = waterTester(waterRings, map.meta.width, map.meta.height);

  // Terrain cell size lets ribbon vertices land exactly where the ground
  // surface kinks, so draped decals conform instead of clipping.
  const cell = hf ? hf.cellSize : Infinity;

  yield `${layers.trails.count} trails`;
  const trails = buildTrails(featureLines(layers.trails), ground, cell, overWater);
  if (trails) group.add(...order([trails], DECAL_ORDER.trail));

  yield `${map.edges.length} street edges`;
  const streetMat = decalMat({ color: STREET_COLOR });
  // Coarse asphalt for the WHOLE city, always resident: vertices only where
  // the source polyline bends, with no resampling onto the terrain grid.
  // 16.98M vertices become 1.6M, which is what makes the street grid
  // affordable to keep everywhere — and the grid is most of what you read
  // when you look at the city from altitude. Accurate ribbons stream on top
  // near the camera; see createDetailTiles.
  for (const mesh of order(
    buildStreetTiles(map.edges, streetMat, ground, Infinity, overWater, FAR_RIBBON_STEP),
    DECAL_ORDER.street,
  )) {
    group.add(mesh);
  }

  yield `${layers.rails.count} rail lines + ${(map.railStops ?? []).length} stops`;
  for (const mesh of order(
    buildRails(featureLines(layers.rails, RAIL_KINDS), ground, cell, overWater),
    DECAL_ORDER.rail,
  )) group.add(mesh);
  const stops = buildRailStops(map.railStops ?? [], ground);
  if (stops) group.add(...order([stops], DECAL_ORDER.railStop));

  const landmarkBuildings = new Map<number, Landmark["kind"]>();
  for (const m of map.landmarks ?? []) for (const id of m.buildingIds ?? []) landmarkBuildings.set(id, m.kind);
  const tiles = createBuildingTiles(buildings, landmarkBuildings, city);
  group.add(tiles.group);
  if (buildEveryBuilding) {
    // Headless tools and tests still want the whole city in one call. The
    // renderer does NOT take this path — it syncs tiles from the camera.
    yield `${buildings.count} building prisms`;
    tiles.buildAll();
  }

  // Street-level dressing, in its own zoom-gated group — streamed, because
  // sidewalks alone outweigh every building in the city.
  const detail = new THREE.Group();
  group.add(detail);
  const detailTiles = createDetailTiles(layers, map.edges, streetMat, overWater, ground, cell);
  detail.add(detailTiles.group);
  if (buildEveryBuilding) {
    yield `${(map.sidewalks ?? []).length} sidewalk slabs + ${(map.markingLines ?? []).length} lane lines`;
    detailTiles.buildAll();
  }

  const streetNear = new THREE.Color(STREET_COLOR);
  const streetFar = new THREE.Color(0x5a6478); // brighter so the grid reads from altitude
  return {
    group,
    detail,
    shells: tiles.shells,
    buildings: tiles,
    detailTiles,
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
function paintMask(bodies: { rings: [number, number][][] }[], hf: Heightfield, out: Uint8Array, cat: number): void {
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
function buildTerrainTiles(map: GameMap, layers: LayerStores, hf: Heightfield): THREE.Mesh[] {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const meshes: THREE.Mesh[] = [];
  const cell = hf.cellSize;
  const lastC = hf.cols - 1;
  const lastR = hf.rows - 1;
  const px = (c: number): number => (c === lastC ? map.meta.width : c * cell);
  const py = (r: number): number => (r === lastR ? map.meta.height : r * cell);

  const mask = new Uint8Array(hf.cols * hf.rows); // CAT_GROUND
  paintMask(featurePolys(layers.parks), hf, mask, CAT_PARK);
  paintMask(featurePolys(layers.railYards), hf, mask, CAT_YARD);
  paintMask(featurePolys(layers.water), hf, mask, CAT_WATER);

  for (let r0 = 0; r0 < lastR; r0 += TERRAIN_CHUNK) {
    for (let c0 = 0; c0 < lastC; c0 += TERRAIN_CHUNK) {
      const c1 = Math.min(lastC, c0 + TERRAIN_CHUNK);
      const r1 = Math.min(lastR, r0 + TERRAIN_CHUNK);
      const w = c1 - c0 + 1;
      const h = r1 - r0 + 1;
      const pos = new Float32Array(w * h * 3);
      // Normals and colours as normalized bytes: the terrain is the largest
      // always-resident mesh in the map, and it never needs more than a byte
      // of either.
      const nrm = new Int8Array(w * h * 3);
      const col = new Uint8Array(w * h * 3);
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
          col[i] = Math.round(rgb[0]! * 255);
          col[i + 1] = Math.round(rgb[1]! * 255);
          col[i + 2] = Math.round(rgb[2]! * 255);
          // Central differences on the raw grid (cheap, no bilinear).
          const cm = Math.max(0, c - 1);
          const cp = Math.min(lastC, c + 1);
          const rm = Math.max(0, r - 1);
          const rp = Math.min(lastR, r + 1);
          const gx = ((hf.data[r * hf.cols + cp]! - hf.data[r * hf.cols + cm]!) * hf.scale) / ((cp - cm) * cell);
          const gy = ((hf.data[rp * hf.cols + c]! - hf.data[rm * hf.cols + c]!) * hf.scale) / ((rp - rm) * cell);
          const inv = 127 / Math.hypot(gx, 1, gy);
          nrm[i] = Math.round(-gx * inv);
          nrm[i + 1] = Math.round(inv);
          nrm[i + 2] = Math.round(gy * inv);
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
      geo.setAttribute("normal", new THREE.BufferAttribute(nrm, 3, true));
      geo.setAttribute("color", new THREE.BufferAttribute(col, 3, true));
      geo.setIndex(index);
      meshes.push(seal(new THREE.Mesh(geo, mat)));
    }
  }
  return meshes;
}

const DRAPE_EDGE = 10; // m — subdivide draped triangles down to this
/** Bisection depth cap: 2^12 sub-triangles is far past anything sane, and it
 * bounds a pathological input. */
const DRAPE_DEPTH_CAP = 12;
/**
 * Skirt wall segment length. The skirt is a 54 cm band hugging the ground
 * along a slab's edge; it only has to follow the terrain, and the terrain is
 * a 30 m grid, so segmenting at 12 m was sampling a straight line 2.5x over.
 * With the slab interior fixed, these walls were most of what was left of the
 * sidewalks' 34M vertices.
 */
const SKIRT_SEG = 30;

/**
 * Split a triangle until every edge is under {@link DRAPE_EDGE}, by
 * repeatedly bisecting its LONGEST edge.
 *
 * The previous version laid an n x n barycentric grid over each triangle with
 * n from the longest edge, which is isotropic in parameter space but not in
 * the world. Earcutting a block-long sidewalk gives long thin slivers, and a
 * 100 m x 3 m sliver got n = 10 — a hundred sub-triangles to describe
 * something that needs about ten. Sidewalks came to 34M vertices, 643 per
 * slab, more than every building in the city put together.
 *
 * Longest-edge bisection costs O(area) on fat triangles and O(length) on thin
 * ones, which is what draping actually needs.
 */
function subdivide(
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number,
  depth: number,
  emit: (x: number, y: number) => void,
): void {
  const ab = Math.hypot(bx - ax, by - ay);
  const bc = Math.hypot(cx - bx, cy - by);
  const ca = Math.hypot(ax - cx, ay - cy);
  const longest = Math.max(ab, bc, ca);
  if (longest <= DRAPE_EDGE || depth >= DRAPE_DEPTH_CAP) {
    emit(ax, ay);
    emit(bx, by);
    emit(cx, cy);
    return;
  }
  // Bisect the longest edge; both halves keep the original winding.
  if (longest === ab) {
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    subdivide(ax, ay, mx, my, cx, cy, depth + 1, emit);
    subdivide(mx, my, bx, by, cx, cy, depth + 1, emit);
  } else if (longest === bc) {
    const mx = (bx + cx) / 2;
    const my = (by + cy) / 2;
    subdivide(ax, ay, bx, by, mx, my, depth + 1, emit);
    subdivide(ax, ay, mx, my, cx, cy, depth + 1, emit);
  } else {
    const mx = (cx + ax) / 2;
    const my = (cy + ay) / 2;
    subdivide(ax, ay, bx, by, mx, my, depth + 1, emit);
    subdivide(mx, my, bx, by, cx, cy, depth + 1, emit);
  }
}

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
      const emit = (px: number, py: number): void => {
        soup!.pos.push(px, yOff + curb + ground(px, py), -py);
        if (curb) soup!.nrm.push(0, 1, 0);
      };
      subdivide(a.x, a.y, b.x, b.y, c.x, c.y, 0, emit);
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
          const segs = Math.max(1, Math.ceil(len / SKIRT_SEG));
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
function flatPolys(bodies: { rings: [number, number][][] }[], color: number, y: number): THREE.Mesh | null {
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
  water: { rings: [number, number][][] }[],
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
/**
 * Hand a static mesh's vertex data to the GPU and stop paying for it twice.
 *
 * three.js keeps every attribute's typed array on the JS side after uploading
 * it, so a resident mesh costs its vertices once in WebGL and again in the
 * heap. For geometry nobody ever reads back — terrain, asphalt, sidewalks,
 * paint, rails — the second copy is pure waste, and it is a big one: this is
 * most of the difference between what a headless profile reports and what the
 * browser tab does.
 *
 * `onUpload` fires once, after the buffer reaches the GPU, so dropping the
 * array there is safe. Two things must NOT be sealed: building tile meshes,
 * whose position and colour arrays are the fire sim's canvas, and anything
 * whose attributes are ever marked needsUpdate — a re-upload would send an
 * empty array.
 *
 * The bounding sphere is computed here rather than lazily at first render,
 * because computing it later would need the vertices this just threw away.
 * (FPV distance culling asks for it on mode entry, which is exactly late
 * enough to have been a nasty one to find.)
 */
function seal(mesh: THREE.Mesh): THREE.Mesh {
  const geo = mesh.geometry;
  if (!geo.boundingSphere) geo.computeBoundingSphere();
  // Keep each array's own type — an index buffer replaced by a Float32Array
  // would be a lie about the geometry even if nothing reads it again.
  const drop = function (this: THREE.BufferAttribute): void {
    const Same = this.array.constructor as new (n: number) => THREE.TypedArray;
    this.array = new Same(0);
  };
  for (const attr of Object.values(geo.attributes)) (attr as THREE.BufferAttribute).onUpload(drop);
  geo.index?.onUpload(drop);
  return mesh;
}

/**
 * A unit-range attribute (normal, colour) as normalized bytes instead of
 * floats.
 *
 * Both only ever carry values WebGL can reconstruct from a byte: a colour
 * channel in 0..1 and a normal component in -1..1. Storing them as Float32 is
 * 12 bytes each where 3 will do, and vertex data is now the single largest
 * thing the tab holds — so this is 24 bytes off every vertex of every static
 * mesh, on the GPU as well as in the heap.
 *
 * The precision is well inside what is visible: 1/255 of a colour channel,
 * and about half a degree of normal, on flat-shaded ground.
 *
 * Buildings keep their Float32 colours regardless — see soupMesh's `packed`.
 */
function packUnit(values: number[], signed: boolean): THREE.BufferAttribute {
  const n = values.length;
  if (signed) {
    const out = new Int8Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.max(-127, Math.min(127, Math.round(values[i]! * 127)));
    return new THREE.BufferAttribute(out, 3, true);
  }
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.max(0, Math.min(255, Math.round(values[i]! * 255)));
  return new THREE.BufferAttribute(out, 3, true);
}

/**
 * `packed` is false for building tiles: BufferAttribute.setXYZ writes raw
 * values, so the fire sim's charLocal would have to know it was writing into
 * a normalized byte array. Their geometry is streamed and small; the ground
 * layers it would save on are the ones that are always resident anyway.
 */
function soupMesh(soup: Soup, material: THREE.Material, sealed = true, packed = true): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(soup.pos, 3));
  const nrm = soup.nrm.length ? soup.nrm : null;
  if (nrm) {
    geo.setAttribute("normal", packed ? packUnit(nrm, true) : new THREE.Float32BufferAttribute(nrm, 3));
  } else if (packed) {
    // All-up normals: one byte per component, 127 being 1.0.
    const up = new Int8Array(soup.pos.length);
    for (let i = 1; i < up.length; i += 3) up[i] = 127;
    geo.setAttribute("normal", new THREE.BufferAttribute(up, 3, true));
  } else {
    const up = new Float32Array(soup.pos.length);
    for (let i = 1; i < up.length; i += 3) up[i] = 1;
    geo.setAttribute("normal", new THREE.BufferAttribute(up, 3));
  }
  if (soup.col) {
    geo.setAttribute("color", packed ? packUnit(soup.col, false) : new THREE.Float32BufferAttribute(soup.col, 3));
  }
  const mesh = new THREE.Mesh(geo, material);
  return sealed ? seal(mesh) : mesh;
}

/** Street ribbons, written straight into per-tile buffers (all normals up). */
function buildStreetTiles(
  edges: StreetEdge[],
  mat: THREE.MeshLambertMaterial,
  ground: GroundFn,
  cell: number,
  overWater: (p: [number, number][]) => boolean,
  step = RIBBON_STEP,
): THREE.Mesh[] {
  const tiles = new Map<number, Soup>();
  for (const edge of edges) {
    if (edge.struct === "tunnel") continue; // roads vanish into the hillside
    const [mx, my] = edge.polyline[Math.floor(edge.polyline.length / 2)]!;
    const key = tileKey(mx, my);
    let soup = tiles.get(key);
    if (!soup) tiles.set(key, (soup = { pos: [], nrm: [] }));
    const span = edge.struct === "bridge" || overWater(edge.polyline);
    pushRibbon(soup.pos, edge.polyline, RENDER_WIDTH[edge.class] ?? edge.width, DECAL_Y, ground, cell, span, step);
  }
  return [...tiles.values()].map((soup) => soupMesh(soup, mat));
}

const RIBBON_STEP = 15; // m — max span between ribbon cross-sections
/**
 * Cross-section spacing for the always-resident coarse street tier.
 *
 * Measured sag against the real heightfield: 15 m gives p95 11 cm, 30 m gives
 * 25 cm, 90 m gives 57 cm with 1.6% of spans over a metre. Sag sinks a road
 * INTO the hillside, where the depth test eats it — so on the West Hills a
 * loose setting shows as gaps in the street grid seen from the air, which is
 * exactly the view this tier exists to serve. 30 m costs 57 MB more than 90 m
 * and keeps that at 0.27%.
 */
const FAR_RIBBON_STEP = 30;

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
function resample(polyline: [number, number][], cell: number, step = RIBBON_STEP): [number, number][] {
  const out: [number, number][] = [polyline[0]!];
  for (let i = 1; i < polyline.length; i++) {
    const [ax, ay] = polyline[i - 1]!;
    const [bx, by] = polyline[i]!;
    const len = Math.hypot(bx - ax, by - ay);
    const ts: number[] = [];
    const n = Math.ceil(len / step);
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
  step = RIBBON_STEP,
): void {
  if (rawPolyline.length < 2) return;
  const polyline = resample(rawPolyline, cell, step);
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
  rails: { polyline: [number, number][]; kind: RailLine["kind"] }[],
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

/**
 * Buildings as streamable tiles.
 *
 * The store is written in tile order, so a tile's buildings are a contiguous
 * index range — building one tile touches nothing else. That is the whole
 * point: resident geometry becomes a function of how much the camera can see,
 * not of how big the city is. Portland costs the same as a map ten times
 * larger.
 *
 * Nothing here holds sim state. A tile can be thrown away and rebuilt at any
 * time; damage comes back because it lives in ScarField, and the fire sim
 * repaints a rebuilt tile through FireSim.restoreAppearance.
 */
export interface BuildingTiles {
  group: THREE.Group;
  shells: BuildingShells;
  /** Whole-city massing, one draw call, always resident. */
  far: THREE.InstancedMesh;
  /**
   * Make exactly `want` resident. Returns the building index ranges that were
   * newly built, so the caller can repaint their damage.
   */
  sync(want: Iterable<number>): { built: [number, number][]; evicted: number };
  /** Build the whole city at once — the old behaviour, for headless tools. */
  buildAll(): void;
  stats(): { tiles: number; verts: number };
}

export function createBuildingTiles(
  store: BuildingStore,
  landmarks: Map<number, Landmark["kind"]>,
  city: CityModel,
): BuildingTiles {
  const group = new THREE.Group();
  const shells = new BuildingShells(store, city.baseZ);

  // Palette colors as flat rgb triples, resolved once for the whole city.
  const palettes = new Map<string, number[][]>();
  for (const [use, hexes] of Object.entries(USE_TINTS)) {
    palettes.set(use, hexes.map((h) => {
      const c = new THREE.Color(h);
      return [c.r, c.g, c.b];
    }));
  }
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const lmMaterials = new Map<Landmark["kind"], THREE.MeshLambertMaterial>();
  const lmMaterial = (kind: Landmark["kind"]): THREE.MeshLambertMaterial => {
    let m = lmMaterials.get(kind);
    if (!m) {
      // Lighter-tier kinds keep the tint but not the glow.
      lmMaterials.set(kind, (m = new THREE.MeshLambertMaterial({
        vertexColors: true,
        flatShading: true,
        emissive: new THREE.Color(LANDMARK_THEMES[kind].building),
        emissiveIntensity: kind === "school" ? 0 : 0.42,
      })));
    }
    return m;
  };

  /**
   * Far tier: every building in the city as one instanced box.
   *
   * Full prisms are ~57 vertices each and 1.1 GB for the city, which is why
   * they have to stream. A box is a shared geometry plus a per-instance
   * transform and colour — about 76 bytes each, 48 MB for all 538k, in a
   * SINGLE draw call. So the whole city can just... stay. Flying at altitude
   * shows the real skyline again, and nothing pops at the horizon.
   *
   * The trade is per-building detail: an instance has one colour, so it
   * cannot carry charLocal's soot gradient or collapse's rubble mound. That
   * is exactly why it is the FAR tier — anything near the camera is a real
   * prism with all of that intact, and its box is hidden.
   */
  const boxGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const far = new THREE.InstancedMesh(
    boxGeo,
    new THREE.MeshLambertMaterial({ flatShading: true }),
    Math.max(1, store.count),
  );
  far.frustumCulled = false; // one mesh spanning the whole map
  far.castShadow = false; // the near prisms cast; boxes at range would not read
  far.receiveShadow = true;
  far.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  group.add(far);

  const m4 = new THREE.Matrix4();
  const col = new THREE.Color();

  /** Oriented box for one building, from the longest footprint edge. An
   * axis-aligned box would fatten every diagonal building; using the longest
   * edge as the axis keeps blocks looking like blocks. */
  function setBox(bi: number, hidden: boolean): void {
    if (!city.valid[bi] || hidden) {
      m4.makeScale(0, 0, 0);
      far.setMatrixAt(bi, m4);
      return;
    }
    const from = ringBase(store, bi, 0);
    const n = ringLength(store, bi, 0);
    const c = store.coords;
    let ux = 1;
    let uy = 0;
    let best = -1;
    for (let i = 0; i < n; i++) {
      const p = (from + i) * 2;
      const q = (from + ((i + 1) % n)) * 2;
      const dx = c[q]! - c[p]!;
      const dy = c[q + 1]! - c[p + 1]!;
      const len = dx * dx + dy * dy;
      if (len > best) {
        best = len;
        const l = Math.sqrt(len) || 1;
        ux = dx / l;
        uy = dy / l;
      }
    }
    let uMin = Infinity;
    let uMax = -Infinity;
    let vMin = Infinity;
    let vMax = -Infinity;
    for (let i = 0; i < n; i++) {
      const p = (from + i) * 2;
      const u = c[p]! * ux + c[p + 1]! * uy;
      const v = -c[p]! * uy + c[p + 1]! * ux;
      if (u < uMin) uMin = u;
      if (u > uMax) uMax = u;
      if (v < vMin) vMin = v;
      if (v > vMax) vMax = v;
    }
    const cu = (uMin + uMax) / 2;
    const cv = (vMin + vMax) / 2;
    // Back to world: the frame is (u along the edge, v perpendicular).
    const wx = cu * ux - cv * uy;
    const wy = cu * uy + cv * ux;
    // Match pushPrism's roof height so the tiers agree where they meet.
    const h = 1 + buildingHeight(store, bi);
    m4.makeRotationY(-Math.atan2(uy, ux));
    m4.scale(new THREE.Vector3(Math.max(0.5, uMax - uMin), h, Math.max(0.5, vMax - vMin)));
    m4.setPosition(wx, city.baseZ[bi]!, -wy);
    far.setMatrixAt(bi, m4);
  }

  for (let bi = 0; bi < store.count; bi++) {
    setBox(bi, false);
    const palette = palettes.get(buildingUse(store, bi)) ?? palettes.get("other")!;
    const qx = Math.round(city.cx[bi]! / 45);
    const qy = Math.round(city.cy[bi]! / 45);
    const hash = ((qx * 73856093) ^ (qy * 19349663)) >>> 0;
    const rgb = palette[hash % palette.length]!;
    far.setColorAt(bi, col.setRGB(rgb[0]!, rgb[1]!, rgb[2]!));
  }
  far.instanceMatrix.needsUpdate = true;
  if (far.instanceColor) far.instanceColor.needsUpdate = true;

  /** Show or hide a tile's boxes — hidden exactly when its prisms are up, so
   * the two tiers never overlap and never z-fight. */
  function setFarTile(t: number, hidden: boolean): void {
    const from = store.tileStart[t]!;
    const to = store.tileStart[t + 1]!;
    for (let bi = from; bi < to; bi++) setBox(bi, hidden);
    far.instanceMatrix.needsUpdate = true;
  }

  /** Resident tiles by index into store.tileKey. */
  const live = new Map<number, THREE.Mesh[]>();
  let residentVerts = 0;

  function build(t: number): void {
    if (live.has(t)) return;
    const from = store.tileStart[t]!;
    const to = store.tileStart[t + 1]!;
    const base: Soup = { pos: [], nrm: [], col: [] };
    // Landmark prisms need their own emissive material, so they go in a
    // sibling soup per kind rather than the tile's main one.
    const lmSoups = new Map<Landmark["kind"], Soup>();
    const pending: { bi: number; slot: number | Landmark["kind"]; start: number; count: number; rgb: number[] }[] = [];

    for (let bi = from; bi < to; bi++) {
      if (!city.valid[bi]) continue;
      const z = city.baseZ[bi]!;
      const kind = landmarks.get(store.id[bi]!);
      if (kind) {
        let ls = lmSoups.get(kind);
        if (!ls) lmSoups.set(kind, (ls = { pos: [], nrm: [], col: [] }));
        const rgb = LANDMARK_RGB.get(kind)!;
        const s0 = ls.pos.length / 3;
        pushPrism(ls, store, bi, rgb, z);
        pending.push({ bi, slot: kind, start: s0, count: ls.pos.length / 3 - s0, rgb });
        continue;
      }
      // Tint keyed on a coarse spatial hash, not the part id: the footprint DB
      // splits one building into stacked parts (podium/tower/penthouse), and
      // per-part colors painted those as random patches. Nearby parts of the
      // same use now share a tint, so the massing reads as ONE structure.
      const palette = palettes.get(buildingUse(store, bi)) ?? palettes.get("other")!;
      const qx = Math.round(city.cx[bi]! / 45);
      const qy = Math.round(city.cy[bi]! / 45);
      const hash = ((qx * 73856093) ^ (qy * 19349663)) >>> 0;
      const rgb = palette[hash % palette.length]!;
      const s0 = base.pos.length / 3;
      pushPrism(base, store, bi, rgb, z);
      pending.push({ bi, slot: 0, start: s0, count: base.pos.length / 3 - s0, rgb });
    }

    const meshes: THREE.Mesh[] = [];
    const slotOf = new Map<number | Landmark["kind"], number>();
    if (base.pos.length) {
      slotOf.set(0, shells.addMesh(soupMesh(base, material, false, false)));
      meshes.push(shells.meshAt(slotOf.get(0)!)!);
    }
    for (const [kind, soup] of lmSoups) {
      slotOf.set(kind, shells.addMesh(soupMesh(soup, lmMaterial(kind), false, false)));
      meshes.push(shells.meshAt(slotOf.get(kind)!)!);
    }
    for (const p of pending) shells.record(p.bi, slotOf.get(p.slot)!, p.start, p.count, p.rgb);
    for (const m of meshes) {
      m.receiveShadow = true;
      m.castShadow = true;
      group.add(m);
      residentVerts += (m.geometry.getAttribute("position") as THREE.BufferAttribute).count;
    }
    live.set(t, meshes);
    setFarTile(t, true);
  }

  function evict(t: number): void {
    const meshes = live.get(t);
    if (!meshes) return;
    for (const m of meshes) {
      residentVerts -= (m.geometry.getAttribute("position") as THREE.BufferAttribute).count;
      group.remove(m);
      shells.dropMesh(m);
      m.geometry.dispose();
    }
    // The buildings themselves keep existing — only their geometry is gone.
    shells.forget(store.tileStart[t]!, store.tileStart[t + 1]!);
    live.delete(t);
    setFarTile(t, false);
  }

  return {
    group,
    shells,
    far,
    sync(want: Iterable<number>): { built: [number, number][]; evicted: number } {
      const keep = want instanceof Set ? (want as Set<number>) : new Set(want);
      const built: [number, number][] = [];
      let evicted = 0;
      for (const t of [...live.keys()]) {
        if (keep.has(t)) continue;
        evict(t);
        evicted++;
      }
      for (const t of keep) {
        if (t < 0 || t >= store.tileKey.length || live.has(t)) continue;
        build(t);
        built.push([store.tileStart[t]!, store.tileStart[t + 1]!]);
      }
      return { built, evicted };
    },
    buildAll(): void {
      for (let t = 0; t < store.tileKey.length; t++) build(t);
    },
    stats: () => ({ tiles: live.size, verts: residentVerts }),
  };
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

/** One building's prism, read straight out of the store — no object graph,
 * no per-vertex arrays. `height` overrides the stored height (collapse
 * rebuilds the same footprint as a low rubble mound). */
function pushPrism(soup: Soup, store: BuildingStore, bi: number, rgb: number[], base = 0, height?: number): void {
  // Tiny deterministic per-part lift: the footprint DB nests same-height
  // parts (podium duplicates), and exactly coplanar roofs shimmer.
  const h = base + 1 + (height ?? buildingHeight(store, bi)) + (store.id[bi]! % 7) * 0.06;
  const nRings = ringCount(store, bi);
  const r = rgb[0]!;
  const g = rgb[1]!;
  const bl = rgb[2]!;
  const s = WALL_BASE_SHADE;

  // Walls: bottom vertices shaded, top full color — the GPU interpolates a
  // smooth ambient-occlusion-ish gradient up the facade.
  for (let k = 0; k < nRings; k++) {
    const from = ringBase(store, bi, k);
    const n = ringLength(store, bi, k);
    for (let i = 0; i < n; i++) {
      const a = (from + i) * 2;
      const bIdx = (from + ((i + 1) % n)) * 2;
      const ax = store.coords[a]!;
      const ay = store.coords[a + 1]!;
      const bx = store.coords[bIdx]!;
      const by = store.coords[bIdx + 1]!;
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
  // THREE's triangulator wants Vector2s, so this is the one place a building
  // still allocates — bounded by its own ring, not by the city.
  const toV = (k: number): THREE.Vector2[] => {
    const out: THREE.Vector2[] = [];
    forEachRingVertex(store, bi, k, (x, y) => out.push(new THREE.Vector2(x, y)));
    return out;
  };
  const outerV = toV(0);
  const holesV: THREE.Vector2[][] = [];
  for (let k = 1; k < nRings; k++) holesV.push(toV(k));
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
