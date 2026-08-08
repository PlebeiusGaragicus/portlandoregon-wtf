import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  buildingHeight,
  buildingUse,
  findFeatureTile,
  forEachRingVertex,
  heightAt,
  ringBase,
  ringCount,
  featureRings,
  ringLength,
  tileKeyAt,
  type BuildingStore,
  type CityLod,
  type FeatureStore,
  type GameMap,
  type LayerStores,
  type Heightfield,
  type Landmark,
  type RailLine,
  type RailStop,
  type RoadClass,
  type StreetEdge,
  type StreetStore,
  type WaterBody,
} from "@portlandoregon/shared";
import { buildCityModel, type CityModel } from "../city.js";
import { HANDHELD } from "../device.js";
import { buildGroundMap } from "./groundmap.js";
import { streetsFrom, type StreetAccess } from "../streets.js";
import { geometryBytes } from "./bytes.js";
import { TileScheduler, type TileTicket } from "./tile-scheduler.js";
import {
  DETAIL_MATERIAL,
  type DetailFeatureSlice,
  type DetailGroupResult,
  type DetailHeightSlice,
  type DetailStreetSlice,
  type DetailTileRequest,
  type DetailTileResult,
  type PrismTileRequest,
  type PrismTileResult,
} from "./tile-worker-protocol.js";

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
// frustum-culls off-screen chunks. Every building renders at every zoom,
// as boxes at least, until the runtime-baked far texture takes over near
// max zoom-out (see setViewHeight).
const TILE = 1000; // meters

export interface WorldLayers {
  group: THREE.Group;
  /** Street-level dressing (sidewalks, pavement paint) — hidden when zoomed
   * out, like props (subpixel there anyway). */
  detail: THREE.Group;
  /** Zoom-driven cosmetics (street tint brightens from altitude). */
  setBlend(f: number): void;
  /**
   * Switch the zoom tiers.
   *
   * Above `textureAbove` the box far tier gives way to the flat far texture
   * — but only once a runtime bake has been installed via
   * {@link WorldLayers.setFarTexture}; until then the boxes stay on at every
   * zoom, because the shipped city-lod texture is a density underlay, not a
   * substitute for the city.
   *
   * Above `groundAbove` the baked ground map (water, parks, streets for the
   * whole map) fades in — it exists to carry exactly what the streamed
   * dressing window stops providing there, so callers pass the same gate
   * that hides the dressing.
   */
  setViewHeight(height: number, textureAbove?: number, groundAbove?: number): void;
  /** Install the runtime-baked overhead city photograph on the far drape. */
  setFarTexture(texture: THREE.Texture): void;
  /** Keep a bounded high-resolution terrain window around the camera. */
  syncGround(x: number, y: number, viewHeight: number, budget?: number, residentByteBudget?: number): void;
  terrainStats(): TileCacheStats;
  /** Stop workers and release detached streaming caches. */
  dispose(): void;
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
  /** As BuildingTiles.sync: evicts fully, builds at most `budget` tiles. */
  sync(
    want: Iterable<number>,
    budget?: number,
    residentByteBudget?: number,
    uploadByteBudget?: number,
  ): void;
  buildAll(): void;
  stats(): TileCacheStats;
  dispose(): void;
}

export interface TileCacheStats {
  tiles: number;
  verts: number;
  residentBytes: number;
  uploadBytes: number;
  evicted: number;
}

export interface BuildingTileStats extends TileCacheStats {
  pending: number;
  inFlight: number;
  completed: number;
  pendingBytes: number;
  completedBytes: number;
}

export interface TileByteLimits {
  residentBytes: number;
  completedBytes: number;
  uploadBytes: number;
}

function createDetailTiles(
  layers: LayerStores,
  edges: StreetAccess,
  streetMat: THREE.MeshLambertMaterial,
  overWater: (p: [number, number][]) => boolean,
  ground: GroundFn,
  cell: number,
  hf?: Heightfield | null,
): DecalTiles {
  const group = new THREE.Group();
  const TS = TILE;

  // Feature stores arrive pre-partitioned into sorted typed-array tile slices.
  // The browser no longer rebuilds six city-wide Map<number, number[]> indexes.
  const swStore = layers.sidewalks;
  const areaStore = layers.markingAreas;
  const lineStore = layers.markingLines;
  const trailStore = layers.trails;
  const railStore = layers.rails;
  const tileBounds = (store: FeatureStore, key: number): [number, number] => {
    if (store.tileSize !== TS) return [0, 0];
    const tile = findFeatureTile(store, key);
    return tile < 0 ? [0, 0] : [store.tileStart[tile]!, store.tileStart[tile + 1]!];
  };

  const laneMat = decalMat({ color: MARK_YELLOW });
  const trailMat = decalMat({ color: TRAIL_COLOR });
  const sidewalkMat = decalMat({ color: SIDEWALK_COLOR, solid: true });
  const markingWhiteMat = decalMat({ color: MARK_WHITE });
  const markingYellowMat = decalMat({ color: MARK_YELLOW });
  const railMats = new Map<RailLine["kind"], THREE.Material>();
  const railMat = (kind: RailLine["kind"]): THREE.Material => {
    let material = railMats.get(kind);
    if (!material) {
      material = decalMat({ color: RAIL_STYLE[kind].color });
      railMats.set(kind, material);
    }
    return material;
  };
  const detailMaterial = (group: DetailGroupResult): THREE.Material => {
    switch (group.materialSlot) {
      case DETAIL_MATERIAL.sidewalk: return sidewalkMat;
      case DETAIL_MATERIAL.markingWhite: return markingWhiteMat;
      case DETAIL_MATERIAL.markingYellow: return markingYellowMat;
      case DETAIL_MATERIAL.street: return streetMat;
      case DETAIL_MATERIAL.laneLine: return laneMat;
      case DETAIL_MATERIAL.trail: return trailMat;
      case DETAIL_MATERIAL.railMax: return railMat("max");
      case DETAIL_MATERIAL.railStreetcar: return railMat("streetcar");
      case DETAIL_MATERIAL.railWes: return railMat("wes");
      default: return railMat("rail");
    }
  };
  const sharedMaterials = new Set<THREE.Material>([
    streetMat, laneMat, trailMat, sidewalkMat, markingWhiteMat, markingYellowMat,
  ]);
  const live = new Map<number, THREE.Mesh[]>();
  const liveBytes = new Map<number, number>();
  let verts = 0;
  let residentBytes = 0;
  let uploadBytes = 0;
  let evicted = 0;

  function buildSync(key: number): void {
    if (live.has(key)) return;
    const meshes: THREE.Mesh[] = [];
    const [swFrom, swTo] = tileBounds(swStore, key);
    for (const m of order(
      drapedPolyTiles(
        Array.from({ length: swTo - swFrom }, (_, offset) => ({
          rings: featureRings(swStore, swFrom + offset),
          color: SIDEWALK_COLOR,
        })),
        SIDEWALK_Y,
        ground,
        CURB_H,
      ),
      SIDEWALK_ORDER,
    )) meshes.push(m);
    const [areaFrom, areaTo] = tileBounds(areaStore, key);
    for (const m of order(
      drapedPolyTiles(
        Array.from({ length: areaTo - areaFrom }, (_, offset) => ({
          rings: featureRings(areaStore, areaFrom + offset),
          color: areaStore.attr[areaFrom + offset] === 1 ? MARK_YELLOW : MARK_WHITE,
        })),
        DECAL_Y,
        ground,
      ),
      DECAL_ORDER.marking,
    )) meshes.push(m);
    // Accurate, terrain-conforming asphalt for the tiles you are close to.
    // The coarse city-wide version underneath is the same colour at the same
    // height and writes no depth, so the two simply agree where they overlap.
    const streetIdx = edges.tileEdges(key, TS);
    if (streetIdx.length) {
      const soup: Soup = { pos: [], nrm: [] };
      for (let at = 0; at < streetIdx.length; at++) {
        const i = streetIdx[at]!;
        const e = edges.edge(i);
        if (e.struct === "tunnel") continue; // roads vanish into the hillside
        const [la, lb] = deckLift(e);
        pushRibbon(
          soup.pos, e.polyline, RENDER_WIDTH[e.class] ?? e.width, DECAL_Y, ground, cell,
          e.struct === "bridge" || overWater(e.polyline), RIBBON_STEP, la, lb,
        );
      }
      if (soup.pos.length) meshes.push(...order([soupMesh(soup, streetMat)], DECAL_ORDER.street));
    }

    const [lineFrom, lineTo] = tileBounds(lineStore, key);
    if (lineTo > lineFrom) {
      const soup: Soup = { pos: [], nrm: [] };
      for (let i = lineFrom; i < lineTo; i++) {
        pushRibbon(soup.pos, featureRings(lineStore, i)[0]!, 0.35, DECAL_Y, ground, cell);
      }
      if (soup.pos.length) meshes.push(...order([soupMesh(soup, laneMat)], DECAL_ORDER.laneLine));
    }
    const [trailFrom, trailTo] = tileBounds(trailStore, key);
    if (trailTo > trailFrom) {
      const soup: Soup = { pos: [], nrm: [] };
      for (let i = trailFrom; i < trailTo; i++) {
        const line = featureRings(trailStore, i)[0]!;
        pushRibbon(soup.pos, line, 2.5, DECAL_Y, ground, cell, overWater(line), Infinity);
      }
      if (soup.pos.length) meshes.push(...order([soupMesh(soup, trailMat)], DECAL_ORDER.trail));
    }
    const [railFrom, railTo] = tileBounds(railStore, key);
    if (railTo > railFrom) {
      const soups = new Map<RailLine["kind"], Soup>();
      for (let i = railFrom; i < railTo; i++) {
        const kind = RAIL_KINDS[railStore.attr[i]!] ?? "rail";
        let soup = soups.get(kind);
        if (!soup) {
          soup = { pos: [], nrm: [] };
          soups.set(kind, soup);
        }
        const line = featureRings(railStore, i)[0]!;
        pushRibbon(soup.pos, line, RAIL_STYLE[kind].width, DECAL_Y, ground, cell, overWater(line), Infinity);
      }
      for (const [kind, soup] of soups) {
        if (soup.pos.length) meshes.push(...order([soupMesh(soup, railMat(kind))], DECAL_ORDER.rail));
      }
    }
    let tileBytes = 0;
    for (const m of meshes) {
      m.receiveShadow = true;
      group.add(m);
      verts += (m.geometry.getAttribute("position") as THREE.BufferAttribute).count;
      tileBytes += geometryBytes(m.geometry);
    }
    live.set(key, meshes);
    liveBytes.set(key, tileBytes);
    residentBytes += tileBytes;
    uploadBytes += tileBytes;
  }

  function evict(key: number): void {
    const meshes = live.get(key);
    if (!meshes) return;
    for (const m of meshes) {
      verts -= (m.geometry.getAttribute("position") as THREE.BufferAttribute).count;
      group.remove(m);
      m.geometry.dispose();
      const materials = Array.isArray(m.material) ? m.material : [m.material];
      for (const material of materials) {
        if (
          !sharedMaterials.has(material) &&
          ![...railMats.values()].includes(material)
        ) material.dispose();
      }
    }
    residentBytes -= liveBytes.get(key) ?? 0;
    liveBytes.delete(key);
    live.delete(key);
    evicted++;
  }

  const occupied = new Set<number>([
    ...swStore.tileKey,
    ...areaStore.tileKey,
    ...lineStore.tileKey,
    ...trailStore.tileKey,
    ...railStore.tileKey,
    ...Array.from(edges.renderTileKeys(TS)),
  ]);

  function featureSlice(
    store: FeatureStore,
    key: number,
    spanOf?: (line: [number, number][]) => boolean,
  ): DetailFeatureSlice {
    const [from, to] = tileBounds(store, key);
    if (to <= from) {
      return {
        featureRingStart: new Uint32Array(1),
        ringOffset: new Uint32Array(1),
        coords: new Float32Array(),
        attr: new Uint8Array(),
        span: new Uint8Array(),
      };
    }
    const sourceRing = store.ringStart[from]!;
    const sourceRingEnd = store.ringStart[to]!;
    const sourcePoint = store.ringOffset[sourceRing]!;
    const sourcePointEnd = store.ringOffset[sourceRingEnd]!;
    const featureRingStart = new Uint32Array(to - from + 1);
    for (let feature = from; feature <= to; feature++) {
      featureRingStart[feature - from] = store.ringStart[feature]! - sourceRing;
    }
    const ringOffset = new Uint32Array(sourceRingEnd - sourceRing + 1);
    for (let ring = sourceRing; ring <= sourceRingEnd; ring++) {
      ringOffset[ring - sourceRing] = store.ringOffset[ring]! - sourcePoint;
    }
    const span = new Uint8Array(to - from);
    if (spanOf) {
      for (let feature = from; feature < to; feature++) {
        span[feature - from] = spanOf(featureRings(store, feature)[0] ?? []) ? 1 : 0;
      }
    }
    return {
      featureRingStart,
      ringOffset,
      coords: store.coords.slice(sourcePoint * 2, sourcePointEnd * 2),
      attr: store.attr.slice(from, to),
      span,
    };
  }

  function streetSlice(key: number): DetailStreetSlice {
    const indices = edges.tileEdges(key, TS);
    const coords: number[] = [];
    const width: number[] = [];
    const span: number[] = [];
    const lineStart = [0];
    for (let at = 0; at < indices.length; at++) {
      const edge = edges.edge(indices[at]!);
      if (edge.struct === "tunnel") continue;
      for (const [x, y] of edge.polyline) coords.push(x, y);
      lineStart.push(coords.length / 2);
      width.push(RENDER_WIDTH[edge.class] ?? edge.width);
      span.push(edge.struct === "bridge" || overWater(edge.polyline) ? 1 : 0);
    }
    return {
      lineStart: Uint32Array.from(lineStart),
      coords: Float32Array.from(coords),
      width: Float32Array.from(width),
      span: Uint8Array.from(span),
    };
  }

  function heightSlice(request: Omit<DetailTileRequest, "height">): DetailHeightSlice | null {
    if (!hf) return null;
    const coordinateArrays = [
      request.sidewalks.coords,
      request.markingAreas.coords,
      request.markingLines.coords,
      request.streets.coords,
      request.trails.coords,
      request.rails.coords,
    ];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const coords of coordinateArrays) {
      for (let point = 0; point < coords.length; point += 2) {
        minX = Math.min(minX, coords[point]!);
        minY = Math.min(minY, coords[point + 1]!);
        maxX = Math.max(maxX, coords[point]!);
        maxY = Math.max(maxY, coords[point + 1]!);
      }
    }
    if (!Number.isFinite(minX)) return null;
    let margin = 2;
    for (const width of request.streets.width) margin = Math.max(margin, width / 2);
    const baseCol = (x: number): number =>
      Math.floor(Math.max(0, Math.min(hf.cols - 1.001, x / hf.cellSize)));
    const baseRow = (y: number): number =>
      Math.floor(Math.max(0, Math.min(hf.rows - 1.001, y / hf.cellSize)));
    const originCol = baseCol(minX - margin);
    const originRow = baseRow(minY - margin);
    const endCol = Math.min(hf.cols - 1, baseCol(maxX + margin) + 1);
    const endRow = Math.min(hf.rows - 1, baseRow(maxY + margin) + 1);
    const cols = endCol - originCol + 1;
    const rows = endRow - originRow + 1;
    const data = new Uint16Array(cols * rows);
    for (let row = 0; row < rows; row++) {
      const source = (originRow + row) * hf.cols + originCol;
      data.set(hf.data.subarray(source, source + cols), row * cols);
    }
    return {
      originCol,
      originRow,
      cols,
      rows,
      mapCols: hf.cols,
      mapRows: hf.rows,
      cellSize: hf.cellSize,
      scale: hf.scale,
      data,
    };
  }

  function detailRequest(key: number, generation: number): DetailTileRequest {
    const partial: Omit<DetailTileRequest, "height"> = {
      type: "details",
      tile: key,
      generation,
      cell,
      sidewalks: featureSlice(swStore, key),
      markingAreas: featureSlice(areaStore, key),
      markingLines: featureSlice(lineStore, key),
      streets: streetSlice(key),
      trails: featureSlice(trailStore, key, overWater),
      rails: featureSlice(railStore, key, overWater),
    };
    return { ...partial, height: heightSlice(partial) };
  }

  function requestTransfers(request: DetailTileRequest): Transferable[] {
    const transfers: Transferable[] = [];
    const addFeature = (slice: DetailFeatureSlice): void => {
      transfers.push(
        slice.featureRingStart.buffer,
        slice.ringOffset.buffer,
        slice.coords.buffer,
        slice.attr.buffer,
        slice.span.buffer,
      );
    };
    addFeature(request.sidewalks);
    addFeature(request.markingAreas);
    addFeature(request.markingLines);
    transfers.push(
      request.streets.lineStart.buffer,
      request.streets.coords.buffer,
      request.streets.width.buffer,
      request.streets.span.buffer,
    );
    addFeature(request.trails);
    addFeature(request.rails);
    if (request.height) transfers.push(request.height.data.buffer);
    return transfers;
  }

  const scheduler = new TileScheduler();
  const completed: { ticket: TileTicket; result: DetailTileResult }[] = [];
  const liveTickets = new Map<number, TileTicket>();
  let active: TileTicket | null = null;
  let worker: Worker | null = null;

  function startWorker(): Worker | null {
    if (typeof window === "undefined" || typeof Worker === "undefined") return null;
    const next = new Worker(new URL("./tile-worker.ts", import.meta.url), { type: "module" });
    next.addEventListener("message", (event: MessageEvent<DetailTileResult>) => {
      const result = event.data;
      const ticket: TileTicket = {
        kind: "dressing",
        key: result.tile,
        generation: result.generation,
        priority: 0,
      };
      if (active?.key === ticket.key && active.generation === ticket.generation) active = null;
      if (scheduler.complete(ticket, result.bytes)) completed.push({ ticket, result });
    });
    next.addEventListener("error", () => {
      if (active) scheduler.retry(active);
      active = null;
      if (worker === next) {
        next.terminate();
        worker = null;
      }
    });
    return next;
  }
  worker = startWorker();

  function stopActive(): void {
    if (!worker || !active) return;
    worker.postMessage({ type: "cancel-details", tile: active.key, generation: active.generation });
    worker.terminate();
    active = null;
    worker = startWorker();
  }

  function scheduleDetail(): void {
    if (!worker || active) return;
    const ticket = scheduler.claim(1)[0];
    if (!ticket) return;
    const request = detailRequest(ticket.key, ticket.generation);
    active = ticket;
    worker.postMessage(request, requestTransfers(request));
  }

  function acceptDetail(result: DetailTileResult): void {
    const meshes: THREE.Mesh[] = [];
    let tileBytes = 0;
    for (const built of result.groups) {
      if (!built.position.length) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.BufferAttribute(built.position, 3, built.position instanceof Int16Array),
      );
      geometry.setAttribute("normal", new THREE.BufferAttribute(built.normal, 3, true));
      const mesh = seal(new THREE.Mesh(geometry, detailMaterial(built)));
      mesh.position.set(...built.positionOffset);
      mesh.scale.set(...built.positionScale);
      mesh.renderOrder = built.renderOrder;
      mesh.receiveShadow = true;
      mesh.userData["detailMaterial"] = built.materialSlot;
      mesh.userData["solid"] = built.solid;
      group.add(mesh);
      verts += built.position.length / 3;
      tileBytes += geometryBytes(geometry);
      meshes.push(mesh);
    }
    live.set(result.tile, meshes);
    liveBytes.set(result.tile, tileBytes);
    residentBytes += tileBytes;
    uploadBytes += tileBytes;
    packError.h = Math.max(packError.h, result.packErrorH);
    packError.v = Math.max(packError.v, result.packErrorV);
  }

  return {
    group,
    sync(
      want: Iterable<number>,
      budget = Infinity,
      residentByteBudget = Infinity,
      uploadByteBudget = Infinity,
    ): void {
      const order = [...want];
      const keep = new Set(order);
      for (const key of [...live.keys()]) {
        if (keep.has(key)) continue;
        evict(key);
        liveTickets.delete(key);
      }
      if (worker) {
        const wanted = order.filter((key) => occupied.has(key));
        const wantedSet = new Set(wanted);
        scheduler.updateWanted("dressing", wanted);
        if (active && !wantedSet.has(active.key)) stopActive();
        const rank = new Map(order.map((key, index) => [key, index]));
        completed.sort(
          (a, b) => (rank.get(a.ticket.key) ?? Number.MAX_SAFE_INTEGER) -
            (rank.get(b.ticket.key) ?? Number.MAX_SAFE_INTEGER),
        );
        let made = 0;
        let wrappedBytes = 0;
        for (let index = 0; index < completed.length;) {
          const done = completed[index]!;
          if (!keep.has(done.ticket.key)) {
            completed.splice(index, 1);
            continue;
          }
          if (made >= budget) break;
          if (made > 0 && wrappedBytes + done.result.bytes > uploadByteBudget) break;
          completed.splice(index, 1);
          if (!scheduler.accept(done.ticket)) continue;
          acceptDetail(done.result);
          wrappedBytes += done.result.bytes;
          liveTickets.set(done.ticket.key, done.ticket);
          made++;
        }
        // Completed wrapping and worker admission are separate frame budgets:
        // keep the worker busy after accepting the previous tile.
        if (budget > 0) scheduleDetail();
        for (let i = order.length - 1; residentBytes > residentByteBudget && i > 0; i--) {
          const key = order[i]!;
          const ticket = liveTickets.get(key);
          if (!live.has(key)) continue;
          evict(key);
          liveTickets.delete(key);
          if (ticket) scheduler.retry(ticket);
        }
        return;
      }
      let made = 0;
      for (const key of order) {
        if (made >= budget) break;
        if (!occupied.has(key) || live.has(key)) continue;
        buildSync(key);
        made++;
      }
      // The nearest wanted tile is the visible core and remains pinned. If a
      // dense outer tile pushes the cache over budget, drop farthest first.
      for (let i = order.length - 1; residentBytes > residentByteBudget && i > 0; i--) {
        const key = order[i]!;
        if (live.has(key)) evict(key);
      }
    },
    buildAll(): void {
      worker?.terminate();
      worker = null;
      active = null;
      completed.length = 0;
      scheduler.reset();
      liveTickets.clear();
      for (const key of occupied) buildSync(key);
    },
    stats: () => ({ tiles: live.size, verts, residentBytes, uploadBytes, evicted }),
    dispose(): void {
      worker?.terminate();
      worker = null;
      active = null;
      completed.length = 0;
      scheduler.reset();
      for (const key of [...live.keys()]) evict(key);
      laneMat.dispose();
      trailMat.dispose();
      sidewalkMat.dispose();
      markingWhiteMat.dispose();
      markingYellowMat.dispose();
      for (const material of railMats.values()) material.dispose();
      group.removeFromParent();
    },
  };
}

/**
 * Every building's vertex range inside its merged tile mesh, so the fire and
 * destruction sim can recolor (char) or rewrite (collapse to rubble) ONE
 * building in place — no per-building meshes, no soup rebuilds. Buildings
 * are addressed by their index in the building store.
 */
export class BuildingShells {
  onChar: ((building: number, amount: number) => void) | null = null;
  onCollapse: ((building: number) => void) | null = null;
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

  private wallVertexCount(bi: number): number {
    let edges = 0;
    for (let ring = 0; ring < ringCount(this.store, bi); ring++) edges += ringLength(this.store, bi, ring);
    return edges * 6;
  }

  private baseColorAt(bi: number, vertex: number, wallVertices: number): [number, number, number] {
    const r = this.rgb[bi * 3]!;
    const g = this.rgb[bi * 3 + 1]!;
    const b = this.rgb[bi * 3 + 2]!;
    if (vertex >= wallVertices) return [r * ROOF_SHADE, g * ROOF_SHADE, b * ROOF_SHADE];
    const shaded = vertex % 6 === 0 || vertex % 6 === 1 || vertex % 6 === 3;
    return shaded ? [r * WALL_BASE_SHADE, g * WALL_BASE_SHADE, b * WALL_BASE_SHADE] : [r, g, b];
  }

  /** Blend a building's vertex colors toward char black (t: 0..1). */
  char(bi: number, t: number): void {
    this.onChar?.(bi, t);
    const mi = this.meshIdx[bi]!;
    if (mi < 0) return;
    const mesh = this.meshes.get(mi);
    if (!mesh) return;
    const col = mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    const s = this.start[bi]!;
    const n = this.vcount[bi]!;
    const wallVertices = this.wallVertexCount(bi);
    const [cr, cg, cb] = this.charRGB as [number, number, number];
    for (let v = 0; v < n; v++) {
      const [r, g, b] = this.baseColorAt(bi, v, wallVertices);
      col.setXYZ(
        s + v,
        r * (1 - t) + cr * t,
        g * (1 - t) + cg * t,
        b * (1 - t) + cb * t,
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
    let farAmount = 0;
    for (const source of srcs) if (source.f > farAmount) farAmount = source.f;
    this.onChar?.(bi, farAmount);
    const mi = this.meshIdx[bi]!;
    if (mi < 0 || srcs.length === 0) return;
    const mesh = this.meshes.get(mi);
    if (!mesh) return;
    const col = mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    const pos = mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    const s = this.start[bi]!;
    const n = this.vcount[bi]!;
    const wallVertices = this.wallVertexCount(bi);
    const [cr, cg, cb] = this.charRGB as [number, number, number];
    const base = this.baseZ[bi]!;
    const hInv = 1 / Math.max(1, buildingHeight(this.store, bi));
    for (let v = 0; v < n; v++) {
      const wx = pos.getX(s + v);
      const wy = -pos.getZ(s + v); // scene z back to world y
      const relH = Math.min(1, Math.max(0, (pos.getY(s + v) - base) * hInv));
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
      const [r, g, b] = this.baseColorAt(bi, v, wallVertices);
      col.setXYZ(
        s + v,
        r * (1 - t) + cr * t,
        g * (1 - t) + cg * t,
        b * (1 - t) + cb * t,
      );
    }
    this.upload(col, s, n, 3);
  }

  /** Rewrite the prism as a jagged ash mound (same vertex count, in place).
   * Anything above the base gets a hashed rubble height and is pulled toward
   * the centroid, with per-vertex ash-gray speckle — a heap, not a box. */
  collapse(bi: number): void {
    this.onCollapse?.(bi);
    const mi = this.meshIdx[bi]!;
    if (mi < 0) return;
    const mesh = this.meshes.get(mi);
    if (!mesh) return;
    const rubbleH = Math.max(1.4, Math.min(5, buildingHeight(this.store, bi) * 0.16));
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
    const pos = mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    const col = mesh.geometry.getAttribute("color") as THREE.BufferAttribute;
    const s = this.start[bi]!;
    const n = this.vcount[bi]!;
    for (let v = 0; v < n; v++) {
      const at = s + v;
      const wx = pos.getX(at);
      const wz = pos.getY(at);
      const wy = -pos.getZ(at);
      const h1 = hash2(wx * 0.73 + 11.3, wy * 0.61 - 4.7);
      const h2 = hash2(wx * 1.91 - 3.1, wy * 1.37 + 8.9);
      if (wz > base + 0.35) {
        // Top-of-heap vertex: jagged height, leaning inward — collapsed mass
        // slumps toward the middle of the footprint.
        const lean = 0.12 + h2 * 0.14;
        pos.setXYZ(
          at,
          wx + (ccx - wx) * lean,
          base + 0.4 + h1 * h1 * (rubbleH + 1.6),
          -(wy + (ccy - wy) * lean),
        );
      }
      // Ash speckle: charred black through pale gray ash.
      const g = 0.09 + h2 * 0.2;
      col.setXYZ(at, g * 1.04, g, g * 0.94);
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
  streetStore?: StreetStore,
  cityLod?: CityLod,
): WorldLayers {
  const it = buildWorldSteps(map, buildings, layers, hf, city, buildEveryBuilding, streetStore, cityLod);
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}

/**
 * buildWorld as a generator, yielding the label of the step it is ABOUT to
 * run. Kept for headless tools and tests, which want the whole world back
 * from one call; the client boots through {@link beginWorld} instead.
 */
export function* buildWorldSteps(
  map: GameMap,
  buildings: BuildingStore,
  layers: LayerStores,
  hf?: Heightfield | null,
  city: CityModel = buildCityModel(buildings, hf),
  buildEveryBuilding = true,
  streetStore?: StreetStore,
  cityLod?: CityLod,
): Generator<string, WorldLayers, void> {
  const { world, steps } = beginWorld(map, buildings, layers, hf, city, false, streetStore, cityLod);
  let seen = "";
  for (const label of steps) {
    // Slices are frame-sized, so many share a label. A caller pumping this
    // for a progress log wants one line per phase, not per slice.
    if (label !== seen) yield (seen = label);
  }
  if (buildEveryBuilding) {
    yield `${buildings.count} building prisms`;
    world.buildings.buildAll();
    yield `${(map.sidewalks ?? []).length} sidewalk slabs + ${(map.markingLines ?? []).length} lane lines`;
    world.detailTiles.buildAll();
  }
  world.syncGround(map.meta.width / 2, map.meta.height / 2, 0, Infinity);
  return world;
}

/** A world you can render immediately, plus the work still to be poured into
 * it. See {@link beginWorld}. */
export interface WorldBoot {
  /** Complete enough to hand to the renderer on the spot: empty of terrain and
   * streets, but with every group, material and tile manager in place. */
  world: WorldLayers;
  /**
   * One frame-sized slice of remaining build work per step, yielding the name
   * of the phase it just advanced. Drain it from the frame loop.
   */
  steps: Generator<string, void, void>;
}

/**
 * The far drape: a heightfield-conforming plane over the whole map. It ships
 * with the baked city-lod density texture, but that is only a placeholder —
 * the renderer photographs the far box tier into a render target at runtime
 * and installs it via setFarTexture, and only then may this replace the
 * boxes (near max zoom-out, where the camera is forced top-down and a flat
 * picture is indistinguishable from geometry).
 */
function buildCityLodMesh(map: GameMap, lod: CityLod, hf?: Heightfield | null): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(
    map.meta.width,
    map.meta.height,
    Math.max(1, lod.cols - 1),
    Math.max(1, lod.rows - 1),
  );
  geo.rotateX(-Math.PI / 2);
  geo.translate(map.meta.width / 2, 0, -map.meta.height / 2);
  const position = geo.getAttribute("position") as THREE.BufferAttribute;
  if (hf) {
    for (let i = 0; i < position.count; i++) {
      position.setY(i, heightAt(hf, position.getX(i), -position.getZ(i)) + 0.45);
    }
    position.needsUpdate = true;
    geo.computeVertexNormals();
  }
  const texture = new THREE.DataTexture(lod.data, lod.cols, lod.rows, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -3,
  });
  const mesh = new THREE.Mesh(geo, material);
  mesh.userData["cityLod"] = true;
  mesh.renderOrder = DECAL_ORDER.street + 0.25;
  mesh.frustumCulled = true;
  return mesh;
}

/**
 * Split the world build into "enough to draw" and "everything else".
 *
 * buildWorld is ~2 s on a laptop and ~20 s on a phone, and all of it used to
 * happen before the first frame — so the phone showed a loading screen for
 * twenty seconds and then a finished city. Nothing in it is actually needed to
 * render: terrain, streets, rails and trails are just meshes being added to a
 * group, and a group renders fine while it is filling up.
 *
 * So the skeleton — groups, materials, the building and dressing tile managers
 * — is built here (a few milliseconds), and the rest comes back as a generator
 * of small slices. The renderer starts on frame one and the city arrives
 * around the camera over the next few seconds, interactively the whole time.
 *
 * Fill order is deliberate: terrain, then the far building tier, then streets,
 * rails and trails. Ground and massing are what make the view legible from
 * altitude, which is where the camera starts.
 */
export function beginWorld(
  map: GameMap,
  buildings: BuildingStore,
  layers: LayerStores,
  hf?: Heightfield | null,
  city: CityModel = buildCityModel(buildings, hf),
  deferFar = true,
  streetStore?: StreetStore,
  cityLod?: CityLod,
): WorldBoot {
  const ground: GroundFn = hf ? (x, y) => heightAt(hf, x, y) : () => 0;
  const group = new THREE.Group();
  // Needed by both the flat fallback and the bridge test in the fill.
  const waterRings = featurePolys(layers.water);
  // Terrain cell size lets ribbon vertices land exactly where the ground
  // surface kinks, so draped decals conform instead of clipping.
  const cell = hf ? hf.cellSize : Infinity;
  const streetMat = decalMat({ color: STREET_COLOR });
  // Bridge structure is solid geometry, not paint: it writes depth so the
  // slab occludes the water under it and the piers occlude each other.
  const bridgeMat = new THREE.MeshLambertMaterial({ color: BRIDGE_COLOR });
  const streets = streetsFrom(map, streetStore);
  const terrain = hf ? createTerrainCache(map, layers, hf) : null;
  if (terrain) group.add(terrain.group);

  const landmarkBuildings = new Map<number, Landmark["kind"]>();
  for (const m of map.landmarks ?? []) for (const id of m.buildingIds ?? []) landmarkBuildings.set(id, m.kind);
  const tiles = createBuildingTiles(buildings, landmarkBuildings, city, deferFar);
  group.add(tiles.group);
  const lod2 = cityLod ? buildCityLodMesh(map, cityLod, hf) : null;
  if (lod2) {
    lod2.visible = false;
    group.add(lod2);
  }
  /** No zoom hides the boxes until a real runtime bake replaces the shipped
   * density texture — see setViewHeight. */
  let farTextureReady = false;

  // The whole map's flat features as one baked texture, for every view the
  // dressing window does not reach. Null in headless tools (no canvas).
  const groundMap = buildGroundMap({
    width: map.meta.width,
    height: map.meta.height,
    hf: hf ?? null,
    texSize: HANDHELD ? 2048 : 4096,
    colors: {
      water: WATER_COLOR,
      park: PARK_COLOR,
      yard: YARD_COLOR,
      // The altitude street tint (streetFar below): the ground map only
      // shows from altitude, where the ribbons would have blended to this.
      street: 0x5a6478,
    },
    water: waterRings,
    parks: featurePolys(layers.parks),
    yards: featurePolys(layers.railYards),
    streets,
    streetWidth: (i) => {
      const edge = streets.edge(i);
      return RENDER_WIDTH[edge.class] ?? edge.width;
    },
    skipEdge: (i) => streets.edge(i).struct === "tunnel",
  });
  if (groundMap) groundMap.mesh.visible = false;

  // Street-level dressing, in its own zoom-gated group — streamed, because
  // sidewalks alone outweigh every building in the city.
  const detail = new THREE.Group();
  group.add(detail);
  const detailTiles = createDetailTiles(layers, streets, streetMat, overWaterLater, ground, cell, hf);
  detail.add(detailTiles.group);

  // The water test needs the rasterized mask, which is cheap but not free, and
  // createDetailTiles only calls it per streamed tile — long after the fill
  // below has built it.
  let overWater: ((p: [number, number][]) => boolean) | null = null;
  function overWaterLater(p: [number, number][]): boolean {
    if (!overWater) overWater = waterTester(waterRings, map.meta.width, map.meta.height);
    return overWater(p);
  }

  const streetNear = new THREE.Color(STREET_COLOR);
  const streetFar = new THREE.Color(0x5a6478); // brighter so the grid reads from altitude
  const world: WorldLayers = {
    group,
    detail,
    shells: tiles.shells,
    buildings: tiles,
    detailTiles,
    setBlend(f: number): void {
      const t = Math.min(1, Math.max(0, f));
      streetMat.color.lerpColors(streetNear, streetFar, t);
    },
    setViewHeight(height: number, textureAbove = Infinity, groundAbove = Infinity): void {
      const textureTier = Boolean(lod2) && farTextureReady && height >= textureAbove;
      tiles.far.visible = !textureTier;
      if (lod2) lod2.visible = textureTier;
      if (groundMap) groundMap.mesh.visible = height >= groundAbove;
    },
    setFarTexture(texture: THREE.Texture): void {
      if (!lod2) return;
      const mat = lod2.material as THREE.MeshBasicMaterial;
      if (mat.map !== texture) {
        mat.map?.dispose();
        mat.map = texture;
        mat.needsUpdate = true;
      }
      farTextureReady = true;
    },
    syncGround(x: number, y: number, viewHeight: number, budget = 1, residentByteBudget = Infinity): void {
      terrain?.sync(x, y, viewHeight, budget, residentByteBudget);
    },
    terrainStats: () => terrain?.stats() ?? { tiles: 0, verts: 0, residentBytes: 0, uploadBytes: 0, evicted: 0 },
    dispose(): void {
      tiles.dispose();
      detailTiles.dispose();
      bridgeMat.dispose();
      terrain?.dispose();
      groundMap?.dispose();
      if (lod2) {
        lod2.removeFromParent();
        lod2.geometry.dispose();
        const mat = lod2.material as THREE.MeshBasicMaterial;
        mat.map?.dispose();
        mat.dispose();
      }
      group.removeFromParent();
    },
  };

  /** Add a finished mesh to the world at the given paint order. Shadow flags
   * are set here rather than by a one-shot traverse in the renderer, because
   * these meshes arrive over the first few seconds rather than up front. */
  function place(mesh: THREE.Mesh, at: number): void {
    mesh.receiveShadow = true;
    // Decals (streets, rails, paint — polygonOffset materials) hug the terrain
    // within centimeters, far below the shadow map's depth resolution: letting
    // them cast just shadow-acnes the ground black.
    const m = mesh.material as THREE.Material;
    mesh.castShadow = !("polygonOffset" in m && m.polygonOffset);
    group.add(...order([mesh], at));
  }

  /** Drain a mesh generator, placing what it produces, one slice per step. */
  function* pour(
    label: string,
    it: Generator<THREE.Mesh | null, void, void>,
    at: number,
  ): Generator<string, void, void> {
    for (const mesh of it) {
      if (mesh) place(mesh, at);
      yield label;
    }
  }

  function* fill(): Generator<string, void, void> {
    if (hf) {
      for (const _ of terrain!.prepare()) yield "terrain";
    } else {
      place(buildGround(map), 0);
      const parks = flatPolys(featurePolys(layers.parks), PARK_COLOR, DECAL_Y);
      if (parks) place(parks, DECAL_ORDER.park);
      const flat = flatPolys(waterRings, WATER_COLOR, DECAL_Y);
      if (flat) place(flat, DECAL_ORDER.water);
      const yards = flatPolys(featurePolys(layers.railYards), YARD_COLOR, DECAL_Y);
      if (yards) place(yards, DECAL_ORDER.yard);
      yield "flat ground";
    }

    // The whole city's massing, one draw call. Second because it is the other
    // half of what the opening view is made of.
    for (const _ of tiles.fillFar()) yield "buildings";

    // Third: the flat features for everywhere the dressing window is not.
    // (setViewHeight owns its visibility; the texture is transparent until
    // the fill finishes, so placing it early shows nothing.)
    if (groundMap) {
      place(groundMap.mesh, DECAL_ORDER.street);
      for (const _ of groundMap.fill()) yield "ground map";
    }

    // Ribbon legs that cross water are bridges: their deck spans between the
    // bank heights instead of sagging onto the riverbed. (Land overpasses
    // still drape — the ZLEV rule is phase 2.)
    overWater ??= waterTester(waterRings, map.meta.width, map.meta.height);
    const water = overWater;
    yield "water mask";

    // Streets, trails and rail ribbons share the camera-window cache in
    // createDetailTiles. Keeping a second city-wide coarse copy consumed GPU
    // memory and still submitted off-screen tiles; past the window, the
    // baked ground map carries the streets instead.
    const stops = buildRailStops(map.railStops ?? [], ground);
    if (stops) place(stops, DECAL_ORDER.railStop);
    yield "rails";

    // Bridge structure: the slab, barriers and piers under the deck the road
    // ribbon paints. Real geometry rather than a decal, so it writes depth
    // and occludes the water beneath it.
    yield* pour("bridges", buildBridges(streets, ground, cell, water, bridgeMat), DECAL_ORDER.laneLine + 1);
  }

  return { world, steps: fill() };
}

/** One keying scheme for the whole client. These buckets are internal to the
 * boot fill and never looked up from outside, but a second scheme is exactly
 * how props ended up unreachable — so there is only the one. */
function tileKey(x: number, y: number): number {
  return tileKeyAt(x, y, TILE);
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
function* paintMask(
  bodies: { rings: [number, number][][] }[],
  hf: Heightfield,
  out: Uint8Array,
  cat: number,
): Generator<void, void, void> {
  const cell = hf.cellSize;
  let scanned = 0;
  // Rows the CURRENT body touches, sparse. A dense array of hf.rows lists was
  // allocated per body — parks are ~12k bodies a block wide, so that was
  // millions of empty arrays and a full-height scan for each one.
  const rowHits = new Map<number, number[]>();
  for (const body of bodies) {
    rowHits.clear();
    for (const ring of body.rings) {
      // The Willamette is one body with rings tens of thousands of vertices
      // long — enough that a whole body was a half-second slice on a laptop.
      // Budgeted by vertices, because parks are the opposite case: thousands
      // of tiny rings, where a yield per ring is pure overhead.
      scanned += ring.length;
      if (scanned >= MASK_VERT_SLICE) {
        scanned = 0;
        yield;
      }
      for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = ring[i]!;
        const [x2, y2] = ring[(i + 1) % ring.length]!;
        if (y1 === y2) continue;
        const rLo = Math.max(0, Math.ceil(Math.min(y1, y2) / cell));
        const rHi = Math.min(hf.rows - 1, Math.floor(Math.max(y1, y2) / cell));
        for (let r = rLo; r <= rHi; r++) {
          const yc = r * cell;
          if (yc >= Math.min(y1, y2) && yc < Math.max(y1, y2)) {
            let xs = rowHits.get(r);
            if (!xs) rowHits.set(r, (xs = []));
            xs.push(x1 + ((yc - y1) / (y2 - y1)) * (x2 - x1));
          }
        }
      }
    }
    let filled = 0;
    for (const [r, hits] of rowHits) {
      if (++filled % MASK_ROW_SLICE === 0) yield;
      const xs = hits.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil(xs[k]! / cell));
        const c1 = Math.min(hf.cols - 1, Math.floor(xs[k + 1]! / cell));
        for (let c = c0; c <= c1; c++) out[r * hf.cols + c] = cat;
      }
    }
  }
}

/** Heightfield rows filled per mask slice, and ring vertices scanned per
 * slice of the edge pass. */
const MASK_ROW_SLICE = 256;
const MASK_VERT_SLICE = 20_000;

/**
 * Displaced terrain grid, chunked for frustum culling. Indexed geometry,
 * vertex-colored by the park/yard/water masks.
 *
 * A generator, one chunk per step: this is the single biggest thing standing
 * between a cold start and a first frame (~0.8 s on a laptop, ~8 s on a
 * phone), and a caller draining it across frames turns that block into ground
 * that fills in while the page is already responding.
 */
function* terrainTiles(map: GameMap, layers: LayerStores, hf: Heightfield): Generator<THREE.Mesh | null, void, void> {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const cell = hf.cellSize;
  const lastC = hf.cols - 1;
  const lastR = hf.rows - 1;
  const px = (c: number): number => (c === lastC ? map.meta.width : c * cell);
  const py = (r: number): number => (r === lastR ? map.meta.height : r * cell);

  const mask = new Uint8Array(hf.cols * hf.rows); // CAT_GROUND
  for (const _ of paintMask(featurePolys(layers.parks), hf, mask, CAT_PARK)) yield null;
  for (const _ of paintMask(featurePolys(layers.railYards), hf, mask, CAT_YARD)) yield null;
  for (const _ of paintMask(featurePolys(layers.water), hf, mask, CAT_WATER)) yield null;

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
      yield seal(new THREE.Mesh(geo, mat));
    }
  }
}

interface TerrainCache {
  group: THREE.Group;
  prepare(): Generator<void, void, void>;
  sync(x: number, y: number, viewHeight: number, budget?: number, residentByteBudget?: number): void;
  stats(): TileCacheStats;
  dispose(): void;
}

/** High-resolution terrain is rebuilt from the retained 3DEP heightfield in a
 * bounded camera cache. A cheap flat backing and the LOD2 drape cover wide
 * views; crossing the whole map no longer leaves every uploaded chunk alive. */
function createTerrainCache(map: GameMap, layers: LayerStores, hf: Heightfield): TerrainCache {
  const group = new THREE.Group();
  // Lambert, not Basic: the backing must dim with the day/night lights like
  // the real terrain chunks sitting on it, or wide night views show a bright
  // sheet with a dark window punched out around the camera. One lit quad.
  const backing = buildGround(map);
  seal(backing);
  backing.position.y = -2;
  group.add(backing);
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  const mask = new Uint8Array(hf.cols * hf.rows);
  const live = new Map<number, THREE.Mesh>();
  const liveBytes = new Map<number, number>();
  const backingBytes = geometryBytes(backing.geometry);
  let residentBytes = backingBytes;
  let uploadBytes = backingBytes;
  let evicted = 0;
  const chunksX = Math.ceil((hf.cols - 1) / TERRAIN_CHUNK);
  const chunksY = Math.ceil((hf.rows - 1) / TERRAIN_CHUNK);
  let ready = false;

  function* prepare(): Generator<void, void, void> {
    for (const _ of paintMask(featurePolys(layers.parks), hf, mask, CAT_PARK)) yield;
    for (const _ of paintMask(featurePolys(layers.railYards), hf, mask, CAT_YARD)) yield;
    for (const _ of paintMask(featurePolys(layers.water), hf, mask, CAT_WATER)) yield;
    ready = true;
  }

  function build(cx: number, cy: number): void {
    const key = cy * chunksX + cx;
    if (live.has(key)) return;
    const lastC = hf.cols - 1;
    const lastR = hf.rows - 1;
    const c0 = cx * TERRAIN_CHUNK;
    const r0 = cy * TERRAIN_CHUNK;
    const c1 = Math.min(lastC, c0 + TERRAIN_CHUNK);
    const r1 = Math.min(lastR, r0 + TERRAIN_CHUNK);
    const width = c1 - c0 + 1;
    const height = r1 - r0 + 1;
    const position = new Float32Array(width * height * 3);
    const normal = new Int8Array(width * height * 3);
    const color = new Uint8Array(width * height * 3);
    let at = 0;
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const wx = col === lastC ? map.meta.width : col * hf.cellSize;
        const wy = row === lastR ? map.meta.height : row * hf.cellSize;
        position[at] = wx;
        position[at + 1] = hf.data[row * hf.cols + col]! * hf.scale;
        position[at + 2] = -wy;
        const rgb = CAT_RGB[mask[row * hf.cols + col]!]!;
        color[at] = Math.round(rgb[0]! * 255);
        color[at + 1] = Math.round(rgb[1]! * 255);
        color[at + 2] = Math.round(rgb[2]! * 255);
        const cm = Math.max(0, col - 1);
        const cp = Math.min(lastC, col + 1);
        const rm = Math.max(0, row - 1);
        const rp = Math.min(lastR, row + 1);
        const gx = ((hf.data[row * hf.cols + cp]! - hf.data[row * hf.cols + cm]!) * hf.scale) / ((cp - cm) * hf.cellSize);
        const gy = ((hf.data[rp * hf.cols + col]! - hf.data[rm * hf.cols + col]!) * hf.scale) / ((rp - rm) * hf.cellSize);
        const inv = 127 / Math.hypot(gx, 1, gy);
        normal[at] = Math.round(-gx * inv);
        normal[at + 1] = Math.round(inv);
        normal[at + 2] = Math.round(gy * inv);
        at += 3;
      }
    }
    const index: number[] = [];
    for (let row = 0; row < height - 1; row++) {
      for (let col = 0; col < width - 1; col++) {
        const a = row * width + col;
        const b = a + 1;
        const d = a + width;
        index.push(a, b, d, b, d + 1, d);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(normal, 3, true));
    geometry.setAttribute("color", new THREE.BufferAttribute(color, 3, true));
    geometry.setIndex(index);
    const mesh = seal(new THREE.Mesh(geometry, material));
    mesh.receiveShadow = true;
    group.add(mesh);
    live.set(key, mesh);
    const bytes = geometryBytes(geometry);
    liveBytes.set(key, bytes);
    residentBytes += bytes;
    uploadBytes += bytes;
  }

  return {
    group,
    prepare,
    sync(x: number, y: number, viewHeight: number, budget = 1, residentByteBudget = Infinity): void {
      if (!ready) return;
      const span = TERRAIN_CHUNK * hf.cellSize;
      const centerX = Math.max(0, Math.min(chunksX - 1, Math.floor(x / span)));
      const centerY = Math.max(0, Math.min(chunksY - 1, Math.floor(y / span)));
      const radius = viewHeight < 3000 ? 2 : 1;
      const wanted: { key: number; x: number; y: number; d: number }[] = [];
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const tx = centerX + dx;
          const ty = centerY + dy;
          if (tx < 0 || ty < 0 || tx >= chunksX || ty >= chunksY) continue;
          wanted.push({ key: ty * chunksX + tx, x: tx, y: ty, d: dx * dx + dy * dy });
        }
      }
      wanted.sort((a, b) => a.d - b.d);
      const keep = new Set(wanted.map((tile) => tile.key));
      for (const [key, mesh] of live) {
        if (keep.has(key)) continue;
        mesh.removeFromParent();
        mesh.geometry.dispose();
        residentBytes -= liveBytes.get(key) ?? 0;
        liveBytes.delete(key);
        live.delete(key);
        evicted++;
      }
      let made = 0;
      for (const tile of wanted) {
        if (made >= budget) break;
        if (live.has(tile.key)) continue;
        build(tile.x, tile.y);
        made++;
      }
      for (let i = wanted.length - 1; residentBytes > residentByteBudget && i > 0; i--) {
        const tile = wanted[i]!;
        const mesh = live.get(tile.key);
        if (!mesh) continue;
        mesh.removeFromParent();
        mesh.geometry.dispose();
        residentBytes -= liveBytes.get(tile.key) ?? 0;
        liveBytes.delete(tile.key);
        live.delete(tile.key);
        evicted++;
      }
    },
    stats: () => ({
      tiles: live.size,
      verts: [...live.values()].reduce(
        (sum, mesh) => sum + (mesh.geometry.getAttribute("position") as THREE.BufferAttribute).count,
        0,
      ),
      residentBytes,
      uploadBytes,
      evicted,
    }),
    dispose(): void {
      for (const mesh of live.values()) mesh.geometry.dispose();
      live.clear();
      liveBytes.clear();
      residentBytes = 0;
      backing.geometry.dispose();
      (backing.material as THREE.Material).dispose();
      material.dispose();
      group.removeFromParent();
    },
  };
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

/**
 * Every trail as ONE mesh, but built in slices.
 *
 * Trails are thin and scattered city-wide, so splitting them into tiles would
 * buy nothing but draw calls. What costs time is the ribbon loop, and that
 * chunks fine: the soup grows across several steps and becomes a mesh at the
 * end. Same shape for rails below.
 */
function* trailTiles(
  trails: { polyline: [number, number][] }[],
  ground: GroundFn,
  cell: number,
  overWater: (p: [number, number][]) => boolean,
): Generator<THREE.Mesh | null, void, void> {
  if (trails.length === 0) return;
  const mat = decalMat({ color: TRAIL_COLOR });
  const buckets = new Map<number, { polyline: [number, number][] }[]>();
  for (const t of trails) {
    const [mx, my] = t.polyline[Math.floor(t.polyline.length / 2)] ?? [0, 0];
    const key = tileKey(mx, my);
    let list = buckets.get(key);
    if (!list) buckets.set(key, (list = []));
    list.push(t);
  }
  yield null;
  for (const list of buckets.values()) {
    const soup: Soup = { pos: [], nrm: [] };
    for (const t of list) {
      pushRibbon(soup.pos, t.polyline, 2.5, DECAL_Y, ground, cell, overWater(t.polyline), Infinity);
    }
    yield soup.pos.length ? soupMesh(soup, mat) : null;
  }
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
/**
 * Largest extent, in meters, worth packing a mesh's positions into Int16.
 *
 * Quantization error is extent/65534, so a 2 km mesh lands at 3 cm and a
 * city-spanning one at 66 cm. Anything past this stays Float32 rather than
 * visibly wobble — which is also why trails and rails are tiled: as one mesh
 * each they spanned 43 km and could not be packed at all.
 */
const PACK_MAX_EXTENT = 2000;

/** Worst quantization error any packed mesh could show, in meters: horizontal
 * (x + z, the diagonal bound) and vertical. Reported by the boot log and
 * asserted by scripts/test-pack.ts. */
export const packError = { h: 0, v: 0 };

/**
 * Positions as Int16 with the mesh transform carrying scale and offset —
 * 6 bytes a vertex instead of 12.
 *
 * Only ever applied to geometry whose normals are all straight up. An
 * axis-aligned scale transforms normals by its inverse transpose, which leaves
 * (0, 1, 0) exactly (0, 1, 0) but tilts everything else — so a non-uniform
 * scale is free here and would be wrong on terrain or on sidewalk skirts.
 *
 * The per-axis scale is what makes the precision work: a street tile is ~1 km
 * across but only tens of meters tall, so the vertical component — the one
 * that decides whether a decal sits on the ground or in it — quantizes to
 * fractions of a millimeter while the horizontal lands at 1.5 cm.
 */
function packPositions(mesh: THREE.Mesh): void {
  const attr = mesh.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
  const src = attr?.array;
  if (!attr || !(src instanceof Float32Array) || attr.count === 0) return;

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i]!;
    const y = src[i + 1]!;
    const z = src[i + 2]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  if (Math.max(maxX - minX, maxY - minY, maxZ - minZ) > PACK_MAX_EXTENT) return;

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;
  // A degenerate axis (a perfectly flat tile) gets a tiny non-zero scale, so
  // every component quantizes to 0 and reconstructs exactly at the centre.
  const hx = Math.max((maxX - minX) / 2, 1e-6);
  const hy = Math.max((maxY - minY) / 2, 1e-6);
  const hz = Math.max((maxZ - minZ) / 2, 1e-6);
  // Reciprocals hoisted: this runs over every vertex in the city's decal
  // layers, and a divide per component showed up as ~190 ms of the fill.
  const kx = 32767 / hx;
  const ky = 32767 / hy;
  const kz = 32767 / hz;
  const q = new Int16Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    q[i] = Math.round((src[i]! - cx) * kx);
    q[i + 1] = Math.round((src[i + 1]! - cy) * ky);
    q[i + 2] = Math.round((src[i + 2]! - cz) * kz);
  }
  // Both forms exist right here, so the error this introduces is measurable
  // exactly rather than argued from the bit width. Kept because the vertical
  // component is the one that decides whether a decal sits on the ground.
  packError.h = Math.max(packError.h, (hx + hz) / 65534);
  packError.v = Math.max(packError.v, hy / 65534);
  mesh.geometry.setAttribute("position", new THREE.BufferAttribute(q, 3, true));
  mesh.position.set(cx, cy, cz);
  mesh.scale.set(hx, hy, hz);
}

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
  // Only the constant-up case — see packPositions. `packed` is off for the
  // headless comparisons that read raw float attributes back.
  if (packed && !nrm) packPositions(mesh);
  return sealed ? seal(mesh) : mesh;
}

/** Street ribbons, written straight into per-tile buffers (all normals up). */
function* streetTiles(
  edges: StreetAccess,
  mat: THREE.MeshLambertMaterial,
  ground: GroundFn,
  cell: number,
  overWater: (p: [number, number][]) => boolean,
  step = RIBBON_STEP,
): Generator<THREE.Mesh | null, void, void> {
  // Bucket first (cheap, no geometry), then build one tile per slice — so the
  // street grid appears tile by tile instead of all at once at the end.
  const buckets = new Map<number, number[]>();
  for (let i = 0; i < edges.edgeCount; i++) {
    const edge = edges.edge(i);
    if (edge.struct === "tunnel") continue; // roads vanish into the hillside
    const [mx, my] = edge.polyline[Math.floor(edge.polyline.length / 2)]!;
    const key = tileKey(mx, my);
    let list = buckets.get(key);
    if (!list) buckets.set(key, (list = []));
    list.push(i);
  }
  yield null;
  for (const list of buckets.values()) {
    const soup: Soup = { pos: [], nrm: [] };
    for (const index of list) {
      const edge = edges.edge(index);
      const span = edge.struct === "bridge" || overWater(edge.polyline);
      const [la, lb] = deckLift(edge);
      pushRibbon(soup.pos, edge.polyline, RENDER_WIDTH[edge.class] ?? edge.width, DECAL_Y, ground, cell, span, step, la, lb);
    }
    yield soupMesh(soup, mat);
  }
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
/**
 * A draped ribbon: two triangle strips sharing a centre row.
 *
 * Written flat on purpose. The obvious version — arrays of [x, y] points, a
 * `quad` of four [x, y, z] tuples per quad, a fresh [0,1,2,0,2,3] index
 * literal allocated per quad — makes several million short-lived arrays to
 * build a city, and ribbons were 16 of the 20 seconds a phone spent inside
 * buildWorld. Heights were sampled about four times per point too, once for
 * every quad corner landing on it.
 *
 * Same geometry, same winding, same vertex order.
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
  liftA = 0,
  liftB = 0,
): void {
  if (rawPolyline.length < 2) return;
  const polyline = resample(rawPolyline, cell, step);
  const n = polyline.length;
  if (n < 2) return;
  const half = width / 2;

  // Three parallel rows of plain numbers: left offset, centre, right offset.
  const X = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  const Y = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  const H = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  const along = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const px = polyline[i]![0];
    const py = polyline[i]![1];
    if (i > 0) {
      along[i] = along[i - 1]! + Math.hypot(px - polyline[i - 1]![0], py - polyline[i - 1]![1]);
    }
    // Average the normals of the segments meeting here, so corners mitre.
    let nx = 0;
    let ny = 0;
    for (let j = i - 1; j <= i; j++) {
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
    X[0]![i] = px + (nx / nlen) * half;
    Y[0]![i] = py + (ny / nlen) * half;
    X[1]![i] = px;
    Y[1]![i] = py;
    X[2]![i] = px - (nx / nlen) * half;
    Y[2]![i] = py - (ny / nlen) * half;
  }

  // One height sample per row point, not one per quad corner.
  const total = along[n - 1]! || 1;
  const hA = ground(polyline[0]![0], polyline[0]![1]) + liftA;
  const hB = ground(polyline[n - 1]![0], polyline[n - 1]![1]) + liftB;
  for (let r = 0; r < 3; r++) {
    const xs = X[r]!;
    const ys = Y[r]!;
    const hs = H[r]!;
    for (let i = 0; i < n; i++) {
      const g = ground(xs[i]!, ys[i]!);
      hs[i] = span ? Math.max(g, hA + (hB - hA) * (along[i]! / total)) : g;
    }
  }

  // Two strips with a shared center row: sampling the centerline height too
  // lets wide roads fold across a terrain crease instead of planking over it
  // (or being sliced by it).
  for (let i = 0; i < n - 1; i++) {
    for (let r = 0; r < 2; r++) {
      const ax = X[r]!;
      const ay = Y[r]!;
      const ah = H[r]!;
      const bx = X[r + 1]!;
      const by = Y[r + 1]!;
      const bh = H[r + 1]!;
      const a0x = ax[i]!, a0y = ay[i]!, a0h = atY + ah[i]!;
      const b0x = bx[i]!, b0y = by[i]!, b0h = atY + bh[i]!;
      const b1x = bx[i + 1]!, b1y = by[i + 1]!, b1h = atY + bh[i + 1]!;
      const a1x = ax[i + 1]!, a1y = ay[i + 1]!, a1h = atY + ah[i + 1]!;
      pos.push(a0x, a0h, -a0y, b0x, b0h, -b0y, b1x, b1h, -b1y);
      pos.push(a0x, a0h, -a0y, b1x, b1h, -b1y, a1x, a1h, -a1y);
    }
  }
}
function* railTiles(
  rails: { polyline: [number, number][]; kind: RailLine["kind"] }[],
  ground: GroundFn,
  cell: number,
  overWater: (p: [number, number][]) => boolean,
): Generator<THREE.Mesh | null, void, void> {
  const mats = new Map<RailLine["kind"], THREE.Material>();
  const matOf = (kind: RailLine["kind"]): THREE.Material => {
    let m = mats.get(kind);
    if (!m) mats.set(kind, (m = decalMat({ color: RAIL_STYLE[kind].color })));
    return m;
  };
  const buckets = new Map<string, { kind: RailLine["kind"]; lines: [number, number][][] }>();
  for (const r of rails) {
    const [mx, my] = r.polyline[Math.floor(r.polyline.length / 2)] ?? [0, 0];
    const key = `${tileKey(mx, my)}:${r.kind}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { kind: r.kind, lines: [] }));
    b.lines.push(r.polyline);
  }
  yield null;
  for (const b of buckets.values()) {
    const soup: Soup = { pos: [], nrm: [] };
    for (const line of b.lines) {
      pushRibbon(soup.pos, line, RAIL_STYLE[b.kind].width, DECAL_Y, ground, cell, overWater(line), Infinity);
    }
    yield soup.pos.length ? soupMesh(soup, matOf(b.kind)) : null;
  }
}


// ---------------------------------------------------------------- bridges
//
// The road ribbon paints a bridge deck as a single draped surface: seen from
// the river a crossing is a floating sheet of asphalt with nothing holding it
// up. These are the parts that make it a structure — the slab it is paved on,
// the barriers along its edges, and the piers carrying it down to the ground.
//
// The deck surface itself stays the road ribbon's job. Everything here hangs
// off exactly the same deck-height rule (`deckHeights`), so the structure sits
// under the road rather than beside it.

const DECK_THICKNESS = 1.7; // m of slab below the road surface
const PARAPET_HEIGHT = 1.15; // m of barrier above it
const PARAPET_WIDTH = 0.5;
const PIER_SPACING = 45; // m between piers along the span
const PIER_HALF_WIDTH = 1.7;
/** Below this much air under the slab, a pier would be a kerb. */
const PIER_MIN_CLEARANCE = 2.5;
const BRIDGE_COLOR = 0x6d6c68; // weathered structural concrete
/**
 * Height of one grade-separation level. Standard highway vertical clearance
 * is ~4.9 m; adding the slab puts the upper road surface here above the lower
 * one, which is what ZLEV 2 means.
 */
const LEVEL_HEIGHT = 6.5;

/** Metres to raise each end of a deck, from its resolved grade level. Only
 * spans lift: a road merely marked level 2 without a bridge structure is not
 * something we can hold up. */
export function deckLift(edge: Pick<StreetEdge, "struct" | "zlev">): [number, number] {
  if (edge.struct !== "bridge") return [0, 0];
  const z = edge.zlev ?? [1, 1];
  return [Math.max(0, z[0] - 1) * LEVEL_HEIGHT, Math.max(0, z[1] - 1) * LEVEL_HEIGHT];
}

/** Push a flat quad (a-b-c-d, counter-clockwise seen from outside) with one
 * face normal. World coords in, scene coords out. */
function pushQuad(
  soup: Soup,
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  c: readonly [number, number, number],
  d: readonly [number, number, number],
): void {
  const ux = b[0] - a[0], uy = b[2] - a[2], uz = -(b[1] - a[1]);
  const vx = c[0] - a[0], vy = c[2] - a[2], vz = -(c[1] - a[1]);
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len; ny /= len; nz /= len;
  const p = (v: readonly [number, number, number]): void => {
    soup.pos.push(v[0], v[2], -v[1]);
    soup.nrm!.push(nx, ny, nz);
  };
  p(a); p(b); p(c);
  p(a); p(c); p(d);
}

/**
 * Deck geometry for one bridge leg: centre line, edge offsets and the deck
 * height at each station. Mirrors `pushRibbon`'s span branch exactly — the
 * same mitred normals and the same `max(terrain, lerp(bank, bank))` — because
 * a structure that disagrees with the road surface by even a few centimetres
 * shows as z-fighting along the whole span.
 */
export function deckStations(
  rawPolyline: [number, number][],
  width: number,
  ground: GroundFn,
  cell: number,
  liftA = 0,
  liftB = 0,
): { lx: Float64Array; ly: Float64Array; rx: Float64Array; ry: Float64Array; h: Float64Array; cx: Float64Array; cy: Float64Array } | null {
  const polyline = resample(rawPolyline, cell);
  const n = polyline.length;
  if (n < 2) return null;
  const half = width / 2;
  const lx = new Float64Array(n), ly = new Float64Array(n);
  const rx = new Float64Array(n), ry = new Float64Array(n);
  const cx = new Float64Array(n), cy = new Float64Array(n);
  const h = new Float64Array(n);
  const along = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const px = polyline[i]![0];
    const py = polyline[i]![1];
    if (i > 0) along[i] = along[i - 1]! + Math.hypot(px - polyline[i - 1]![0], py - polyline[i - 1]![1]);
    let nx = 0, ny = 0;
    for (let j = i - 1; j <= i; j++) {
      const a = polyline[j];
      const b = polyline[j + 1];
      if (!a || !b) continue;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const l = Math.hypot(dx, dy) || 1;
      nx += -dy / l;
      ny += dx / l;
    }
    const nl = Math.hypot(nx, ny) || 1;
    cx[i] = px; cy[i] = py;
    lx[i] = px + (nx / nl) * half; ly[i] = py + (ny / nl) * half;
    rx[i] = px - (nx / nl) * half; ry[i] = py - (ny / nl) * half;
  }

  const total = along[n - 1]! || 1;
  const hA = ground(polyline[0]![0], polyline[0]![1]) + liftA;
  const hB = ground(polyline[n - 1]![0], polyline[n - 1]![1]) + liftB;
  for (let i = 0; i < n; i++) {
    const g = ground(cx[i]!, cy[i]!);
    h[i] = Math.max(g, hA + (hB - hA) * (along[i]! / total));
  }
  return { lx, ly, rx, ry, h, cx, cy };
}

/** Slab sides and soffit, edge barriers, and piers down to the ground. */
function pushBridge(
  soup: Soup,
  rawPolyline: [number, number][],
  width: number,
  ground: GroundFn,
  cell: number,
  liftA = 0,
  liftB = 0,
): void {
  const s = deckStations(rawPolyline, width, ground, cell, liftA, liftB);
  if (!s) return;
  const { lx, ly, rx, ry, h, cx, cy } = s;
  const n = h.length;
  const top = (i: number, x: Float64Array, y: Float64Array): [number, number, number] =>
    [x[i]!, y[i]!, h[i]! + DECAL_Y];
  const bot = (i: number, x: Float64Array, y: Float64Array): [number, number, number] =>
    [x[i]!, y[i]!, h[i]! - DECK_THICKNESS];

  for (let i = 0; i < n - 1; i++) {
    // Fascia: the slab edge you see from the water, both sides.
    pushQuad(soup, top(i, lx, ly), bot(i, lx, ly), bot(i + 1, lx, ly), top(i + 1, lx, ly));
    pushQuad(soup, top(i + 1, rx, ry), bot(i + 1, rx, ry), bot(i, rx, ry), top(i, rx, ry));
    // Soffit: the underside, which is what you actually see from below.
    pushQuad(soup, bot(i, lx, ly), bot(i, rx, ry), bot(i + 1, rx, ry), bot(i + 1, lx, ly));

    // Barriers. Inset so they stand ON the deck rather than floating off its
    // edge, and capped so the top reads as a rail rather than a bare sheet.
    for (const [ex, ey, ox, oy] of [[lx, ly, cx, cy], [rx, ry, cx, cy]] as const) {
      const t = PARAPET_WIDTH / (width / 2);
      const ix = (i: number): number => ex[i]! + (ox[i]! - ex[i]!) * t;
      const iy = (i: number): number => ey[i]! + (oy[i]! - ey[i]!) * t;
      const o0: [number, number, number] = [ex[i]!, ey[i]!, h[i]! + DECAL_Y];
      const o1: [number, number, number] = [ex[i + 1]!, ey[i + 1]!, h[i + 1]! + DECAL_Y];
      const oc0: [number, number, number] = [ex[i]!, ey[i]!, h[i]! + PARAPET_HEIGHT];
      const oc1: [number, number, number] = [ex[i + 1]!, ey[i + 1]!, h[i + 1]! + PARAPET_HEIGHT];
      const ic0: [number, number, number] = [ix(i), iy(i), h[i]! + PARAPET_HEIGHT];
      const ic1: [number, number, number] = [ix(i + 1), iy(i + 1), h[i + 1]! + PARAPET_HEIGHT];
      const ii0: [number, number, number] = [ix(i), iy(i), h[i]! + DECAL_Y];
      const ii1: [number, number, number] = [ix(i + 1), iy(i + 1), h[i + 1]! + DECAL_Y];
      pushQuad(soup, o0, oc0, oc1, o1); // outer face
      pushQuad(soup, ii1, ic1, ic0, ii0); // inner face
      pushQuad(soup, oc0, ic0, ic1, oc1); // top cap
    }
  }

  // Piers, evenly along the span wherever there is genuine air underneath.
  let sinceP = PIER_SPACING / 2; // offset so a short span still gets one
  for (let i = 0; i < n - 1; i++) {
    const seg = Math.hypot(cx[i + 1]! - cx[i]!, cy[i + 1]! - cy[i]!);
    sinceP += seg;
    if (sinceP < PIER_SPACING) continue;
    sinceP = 0;
    const px = cx[i]!;
    const py = cy[i]!;
    const g = ground(px, py);
    const under = h[i]! - DECK_THICKNESS;
    if (under - g < PIER_MIN_CLEARANCE) continue;
    // Piers follow the deck: wide crossings get chunkier columns.
    const hw = Math.min(PIER_HALF_WIDTH * 1.8, Math.max(PIER_HALF_WIDTH, width * 0.12));
    const dx = cx[i + 1]! - px;
    const dy = cy[i + 1]! - py;
    const l = Math.hypot(dx, dy) || 1;
    const ax = (dx / l) * hw;
    const ay = (dy / l) * hw;
    const bx = (-dy / l) * hw;
    const by = (dx / l) * hw;
    const corner = (sa: number, sb: number, z: number): [number, number, number] =>
      [px + ax * sa + bx * sb, py + ay * sa + by * sb, z];
    for (const [s0, s1] of [[[1, 1], [1, -1]], [[1, -1], [-1, -1]], [[-1, -1], [-1, 1]], [[-1, 1], [1, 1]]] as const) {
      pushQuad(
        soup,
        corner(s0[0], s0[1], under),
        corner(s0[0], s0[1], g - 1),
        corner(s1[0], s1[1], g - 1),
        corner(s1[0], s1[1], under),
      );
    }
  }
}

/**
 * Bridge structures, tiled like the street ribbons so the GPU can cull them.
 * Only legs the street layer already treats as spanning get one, so this
 * cannot invent a bridge where the road merely drapes.
 */
function* buildBridges(
  edges: StreetAccess,
  ground: GroundFn,
  cell: number,
  overWater: (p: [number, number][]) => boolean,
  material: THREE.Material,
): Generator<THREE.Mesh | null, void, void> {
  const buckets = new Map<number, number[]>();
  for (let i = 0; i < edges.edgeCount; i++) {
    const edge = edges.edge(i);
    if (edge.struct === "tunnel") continue;
    if (edge.struct !== "bridge" && !overWater(edge.polyline)) continue;
    const [mx, my] = edge.polyline[Math.floor(edge.polyline.length / 2)]!;
    const key = tileKey(mx, my);
    let list = buckets.get(key);
    if (!list) buckets.set(key, (list = []));
    list.push(i);
  }
  yield null;
  for (const list of buckets.values()) {
    const soup: Soup = { pos: [], nrm: [] };
    for (const index of list) {
      const edge = edges.edge(index);
      const [la, lb] = deckLift(edge);
      pushBridge(soup, edge.polyline, RENDER_WIDTH[edge.class] ?? edge.width, ground, cell, la, lb);
    }
    yield soup.pos.length ? soupMesh(soup, material, true, false) : null;
  }
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
  /** Whole-city massing in bounded tile chunks for GPU frustum culling. */
  far: THREE.Group;
  /**
   * Make `want` resident, building at most `budget` tiles this call.
   *
   * Eviction always completes — it is cheap and frees memory. Building is
   * rationed, because doing a whole window at once is a multi-second block on
   * a phone, which reads as the app freezing. `want` is taken in order, so
   * pass it nearest-first and the view fills in from the camera outward.
   *
   * Returns the building index ranges newly built, for repainting damage.
   */
  sync(
    want: Iterable<number>,
    budget?: number,
    byteLimits?: Partial<TileByteLimits>,
  ): { built: [number, number][]; evicted: number };
  /** Build the whole city at once — the old behaviour, for headless tools. */
  buildAll(): void;
  /**
   * Place the far tier's boxes, a batch of tiles per step.
   *
   * Filling 538k instances is ~0.3 s on a laptop and seconds on a phone, so
   * with `deferFar` the mesh starts empty (`count = 0`) and grows here. Safe
   * to drain lazily: `sync` may build prisms for tiles this has not reached
   * yet, and the fill checks residency before un-hiding a tile's boxes.
   * Already complete (a no-op) unless `deferFar` was set.
   */
  fillFar(): Generator<void, void, void>;
  /**
   * Monotonic counter bumped whenever the far tier's appearance changes —
   * tiles filling in during boot, char tints, collapses. Lets the renderer
   * know its baked overhead photograph of the boxes has gone stale.
   */
  farVersion(): number;
  has(tile: number): boolean;
  stats(): BuildingTileStats;
  dispose(): void;
}

/** Far-tier tiles placed per fill step. */
const FAR_FILL_SLICE = 64;

export function createBuildingTiles(
  store: BuildingStore,
  landmarks: Map<number, Landmark["kind"]>,
  city: CityModel,
  deferFar = false,
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

  /** Far tier: immutable tile-local instance buffers. The old single mesh
   * submitted all 538k boxes every frame and dirtied a ~35 MB matrix buffer
   * whenever one near tile changed. Tile chunks retain the same compact boxes
   * while allowing frustum culling and visibility changes with no uploads. */
  const boxGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const boxMaterial = new THREE.MeshLambertMaterial({ flatShading: true });
  const far = new THREE.Group();
  const farTiles: (THREE.InstancedMesh | null)[] = new Array(store.tileKey.length).fill(null);
  group.add(far);

  const m4 = new THREE.Matrix4();
  const col = new THREE.Color();
  const farChar = new Uint8Array(store.count);
  const farCollapsed = new Uint8Array(store.count);

  /** Oriented box for one building, from the longest footprint edge. An
   * axis-aligned box would fatten every diagonal building; using the longest
   * edge as the axis keeps blocks looking like blocks. */
  function setBox(mesh: THREE.InstancedMesh, slot: number, bi: number): void {
    if (!city.valid[bi]) {
      m4.makeScale(0, 0, 0);
      mesh.setMatrixAt(slot, m4);
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
    const h = farCollapsed[bi] ? Math.max(1.4, Math.min(5, buildingHeight(store, bi) * 0.16)) : 1 + buildingHeight(store, bi);
    m4.makeRotationY(-Math.atan2(uy, ux));
    m4.scale(new THREE.Vector3(Math.max(0.5, uMax - uMin), h, Math.max(0.5, vMax - vMin)));
    m4.setPosition(wx, city.baseZ[bi]!, -wy);
    mesh.setMatrixAt(slot, m4);
  }

  /** Resident tiles by index into store.tileKey. Declared before the far fill
   * because that fill has to know which tiles already have prisms. */
  const live = new Map<number, THREE.Mesh[]>();
  const liveBytes = new Map<number, number>();
  let residentVerts = 0;
  let residentBytes = 0;
  let uploadBytes = 0;
  let evictedTotal = 0;

  /** Tint keyed on a coarse spatial hash — see `build` for why not per part. */
  function tintOf(bi: number): number[] {
    const palette = palettes.get(buildingUse(store, bi)) ?? palettes.get("other")!;
    const qx = Math.round(city.cx[bi]! / 45);
    const qy = Math.round(city.cy[bi]! / 45);
    const hash = ((qx * 73856093) ^ (qy * 19349663)) >>> 0;
    return palette[hash % palette.length]!;
  }

  function farTintOf(bi: number): [number, number, number] {
    const rgb = tintOf(bi);
    const amount = farCollapsed[bi] ? 0.92 : farChar[bi]! / 255;
    return [
      rgb[0]! * (1 - amount) + 0.09 * amount,
      rgb[1]! * (1 - amount) + 0.082 * amount,
      rgb[2]! * (1 - amount) + 0.078 * amount,
    ];
  }

  /** Boxes placed so far, one self-culling mesh per tile. */
  let farFilled = 0;
  let farVersion = 0;
  function buildFarTile(tile: number): void {
    if (farTiles[tile]) return;
    farVersion++;
    const from = store.tileStart[tile]!;
    const to = store.tileStart[tile + 1]!;
    const mesh = new THREE.InstancedMesh(boxGeo, boxMaterial, Math.max(1, to - from));
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    for (let bi = from; bi < to; bi++) {
      const slot = bi - from;
      setBox(mesh, slot, bi);
      const rgb = farTintOf(bi);
      mesh.setColorAt(slot, col.setRGB(rgb[0]!, rgb[1]!, rgb[2]!));
    }
    mesh.count = to - from;
    mesh.userData["tile"] = tile;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.visible = !live.has(tile);
    farTiles[tile] = mesh;
    far.add(mesh);
  }

  function growFar(upto: number): void {
    for (; farFilled < upto; farFilled++) buildFarTile(farFilled);
  }
  if (!deferFar) growFar(store.tileKey.length);

  /** Visibility changes are now metadata-only: no city-wide matrix upload. */
  function setFarTile(t: number, hidden: boolean): void {
    const mesh = farTiles[t];
    if (mesh) mesh.visible = !hidden;
  }

  function tileForBuilding(building: number): number {
    let lo = 0;
    let hi = store.tileStart.length - 2;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (building < store.tileStart[mid]!) hi = mid - 1;
      else if (building >= store.tileStart[mid + 1]!) lo = mid + 1;
      else return mid;
    }
    return -1;
  }

  function refreshFarBuilding(building: number): void {
    const tile = tileForBuilding(building);
    const mesh = tile >= 0 ? farTiles[tile] : null;
    if (!mesh) return;
    const slot = building - store.tileStart[tile]!;
    setBox(mesh, slot, building);
    const rgb = farTintOf(building);
    mesh.setColorAt(slot, col.setRGB(rgb[0], rgb[1], rgb[2]));
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    farVersion++;
  }
  shells.onChar = (building, amount) => {
    farChar[building] = Math.max(farChar[building]!, Math.round(Math.min(1, Math.max(0, amount)) * 255));
    refreshFarBuilding(building);
  };
  shells.onCollapse = (building) => {
    farCollapsed[building] = 1;
    farChar[building] = 255;
    refreshFarBuilding(building);
  };

  function buildSync(t: number): void {
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
      const rgb = tintOf(bi);
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
    const bytes = meshes.reduce((sum, mesh) => sum + geometryBytes(mesh.geometry), 0);
    liveBytes.set(t, bytes);
    residentBytes += bytes;
    uploadBytes += bytes;
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
    residentBytes -= liveBytes.get(t) ?? 0;
    liveBytes.delete(t);
    live.delete(t);
    evictedTotal++;
    setFarTile(t, false);
  }

  // Browser-only prism worker. Node/headless tools keep the synchronous path,
  // which makes their deterministic geometry tests independent of Worker.
  const landmarkKinds = Object.keys(LANDMARK_THEMES) as Landmark["kind"][];
  const generation = new Uint32Array(store.tileKey.length);
  const pending = new Map<number, number>();
  const pendingRequestBytes = new Map<number, number>();
  const completed: PrismTileResult[] = [];
  let inFlight = 0;
  const worker =
    typeof window !== "undefined" && typeof Worker !== "undefined"
      ? new Worker(new URL("./tile-worker.ts", import.meta.url), { type: "module" })
      : null;
  worker?.addEventListener("message", (event: MessageEvent<PrismTileResult>) => {
    inFlight = Math.max(0, inFlight - 1);
    pendingRequestBytes.set(event.data.tile, 0);
    completed.push(event.data);
  });

  function prismRequest(tile: number, requestGeneration: number): PrismTileRequest {
    const from = store.tileStart[tile]!;
    const to = store.tileStart[tile + 1]!;
    const buildingCount = to - from;
    const sourceRing = store.ringStart[from]!;
    const sourceRingEnd = store.ringStart[to]!;
    const sourcePoint = store.ringOffset[sourceRing]!;
    const sourcePointEnd = store.ringOffset[sourceRingEnd]!;
    const buildingIndex = new Uint32Array(buildingCount);
    const sourceId = new Uint32Array(buildingCount);
    const buildingRingStart = new Uint32Array(buildingCount + 1);
    const ringOffset = new Uint32Array(sourceRingEnd - sourceRing + 1);
    const coords = store.coords.slice(sourcePoint * 2, sourcePointEnd * 2);
    const height = new Float32Array(buildingCount);
    const baseZ = new Float32Array(buildingCount);
    const color = new Float32Array(buildingCount * 3);
    const materialSlot = new Uint8Array(buildingCount);
    for (let local = 0; local < buildingCount; local++) {
      const bi = from + local;
      buildingIndex[local] = bi;
      sourceId[local] = store.id[bi]!;
      buildingRingStart[local] = store.ringStart[bi]! - sourceRing;
      height[local] = buildingHeight(store, bi);
      baseZ[local] = city.baseZ[bi]!;
      const kind = landmarks.get(store.id[bi]!);
      const rgb = kind ? LANDMARK_RGB.get(kind)! : tintOf(bi);
      color.set(rgb, local * 3);
      materialSlot[local] = kind ? landmarkKinds.indexOf(kind) + 1 : 0;
    }
    buildingRingStart[buildingCount] = sourceRingEnd - sourceRing;
    for (let ring = sourceRing; ring <= sourceRingEnd; ring++) {
      ringOffset[ring - sourceRing] = store.ringOffset[ring]! - sourcePoint;
    }
    return {
      type: "prisms",
      tile,
      generation: requestGeneration,
      buildingIndex,
      sourceId,
      buildingRingStart,
      ringOffset,
      coords,
      height,
      baseZ,
      color,
      materialSlot,
    };
  }

  function schedule(tile: number): void {
    if (!worker || pending.has(tile) || live.has(tile)) return;
    const requestGeneration = generation[tile]! + 1;
    generation[tile] = requestGeneration;
    const request = prismRequest(tile, requestGeneration);
    pending.set(tile, requestGeneration);
    pendingRequestBytes.set(
      tile,
      request.buildingIndex.byteLength + request.sourceId.byteLength +
        request.buildingRingStart.byteLength + request.ringOffset.byteLength +
        request.coords.byteLength + request.height.byteLength + request.baseZ.byteLength +
        request.color.byteLength + request.materialSlot.byteLength,
    );
    inFlight++;
    worker.postMessage(request, [
      request.buildingIndex.buffer,
      request.sourceId.buffer,
      request.buildingRingStart.buffer,
      request.ringOffset.buffer,
      request.coords.buffer,
      request.height.buffer,
      request.baseZ.buffer,
      request.color.buffer,
      request.materialSlot.buffer,
    ]);
  }

  function accept(result: PrismTileResult): [number, number] | null {
    if (generation[result.tile] !== result.generation || live.has(result.tile)) return null;
    pending.delete(result.tile);
    pendingRequestBytes.delete(result.tile);
    const meshes: THREE.Mesh[] = [];
    for (const built of result.groups) {
      if (!built.position.length) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(built.position, 3));
      geometry.setAttribute("normal", new THREE.BufferAttribute(built.normal, 3));
      geometry.setAttribute("color", new THREE.BufferAttribute(built.color, 3));
      const kind = built.materialSlot ? landmarkKinds[built.materialSlot - 1] : undefined;
      const mesh = new THREE.Mesh(geometry, kind ? lmMaterial(kind) : material);
      const slot = shells.addMesh(mesh);
      for (let i = 0; i < built.recordBuilding.length; i++) {
        shells.record(
          built.recordBuilding[i]!,
          slot,
          built.recordStart[i]!,
          built.recordCount[i]!,
          [built.recordColor[i * 3]!, built.recordColor[i * 3 + 1]!, built.recordColor[i * 3 + 2]!],
        );
      }
      mesh.receiveShadow = true;
      mesh.castShadow = true;
      group.add(mesh);
      residentVerts += built.position.length / 3;
      meshes.push(mesh);
    }
    live.set(result.tile, meshes);
    const bytes = meshes.reduce((sum, mesh) => sum + geometryBytes(mesh.geometry), 0);
    liveBytes.set(result.tile, bytes);
    residentBytes += bytes;
    uploadBytes += bytes;
    setFarTile(result.tile, true);
    return [store.tileStart[result.tile]!, store.tileStart[result.tile + 1]!];
  }

  return {
    group,
    shells,
    far,
    sync(
      want: Iterable<number>,
      budget = Infinity,
      byteLimits: Partial<TileByteLimits> = {},
    ): { built: [number, number][]; evicted: number } {
      const order = [...want];
      const keep = new Set(order);
      const limits: TileByteLimits = {
        residentBytes: byteLimits.residentBytes ?? Infinity,
        completedBytes: byteLimits.completedBytes ?? 64 * 1024 * 1024,
        uploadBytes: byteLimits.uploadBytes ?? 8 * 1024 * 1024,
      };
      const built: [number, number][] = [];
      let evicted = 0;
      for (const t of [...live.keys()]) {
        if (keep.has(t)) continue;
        evict(t);
        evicted++;
      }
      for (const [t] of pending) {
        if (keep.has(t)) continue;
        generation[t] = generation[t]! + 1;
        pending.delete(t);
        pendingRequestBytes.delete(t);
      }
      const rank = new Map(order.map((tile, index) => [tile, index]));
      completed.sort(
        (a, b) => (rank.get(a.tile) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.tile) ?? Number.MAX_SAFE_INTEGER),
      );
      let queuedBytes = completed.reduce((sum, result) => sum + result.bytes, 0);
      while (queuedBytes > limits.completedBytes && completed.length > 1) {
        const result = completed.pop()!;
        queuedBytes -= result.bytes;
        if (pending.get(result.tile) === result.generation) {
          pending.delete(result.tile);
          pendingRequestBytes.delete(result.tile);
          generation[result.tile] = generation[result.tile]! + 1;
        }
      }
      // Wrap/upload completed buffers under both byte and time limits. One
      // result is always accepted so low-end devices cannot starve.
      const uploadStarted = performance.now();
      let uploadedBytes = 0;
      for (let i = 0; i < completed.length; ) {
        const result = completed[i]!;
        if (generation[result.tile] !== result.generation || !keep.has(result.tile)) {
          completed.splice(i, 1);
          continue;
        }
        if (
          built.length &&
          (uploadedBytes + result.bytes > limits.uploadBytes || performance.now() - uploadStarted > 4)
        ) break;
        completed.splice(i, 1);
        uploadedBytes += result.bytes;
        const range = accept(result);
        if (range) built.push(range);
      }
      let made = 0;
      for (const t of order) {
        if (made >= budget) break;
        if (t < 0 || t >= store.tileKey.length || live.has(t)) continue;
        if (worker) {
          if (inFlight >= 2) break;
          schedule(t);
        } else {
          buildSync(t);
          built.push([store.tileStart[t]!, store.tileStart[t + 1]!]);
        }
        made++;
      }
      for (let i = order.length - 1; residentBytes > limits.residentBytes && i > 0; i--) {
        const tile = order[i]!;
        if (!live.has(tile)) continue;
        evict(tile);
        evicted++;
      }
      return { built, evicted };
    },
    buildAll(): void {
      growFar(store.tileKey.length);
      for (let t = 0; t < store.tileKey.length; t++) buildSync(t);
    },
    *fillFar(): Generator<void, void, void> {
      while (farFilled < store.tileKey.length) {
        growFar(Math.min(store.tileKey.length, farFilled + FAR_FILL_SLICE));
        yield;
      }
    },
    farVersion: () => farVersion,
    has: (tile) => live.has(tile),
    stats: () => ({
      tiles: live.size,
      verts: residentVerts,
      residentBytes,
      uploadBytes,
      evicted: evictedTotal,
      pending: Math.max(0, pending.size - completed.length),
      inFlight,
      completed: completed.length,
      pendingBytes: [...pendingRequestBytes.values()].reduce((sum, bytes) => sum + bytes, 0),
      completedBytes: completed.reduce((sum, result) => sum + result.bytes, 0),
    }),
    dispose(): void {
      worker?.terminate();
      completed.length = 0;
      pending.clear();
      pendingRequestBytes.clear();
      for (const tile of [...live.keys()]) evict(tile);
      for (const mesh of farTiles) {
        if (!mesh) continue;
        mesh.removeFromParent();
        mesh.dispose();
      }
      boxGeo.dispose();
      boxMaterial.dispose();
      material.dispose();
      for (const lm of lmMaterials.values()) lm.dispose();
      group.removeFromParent();
    },
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
