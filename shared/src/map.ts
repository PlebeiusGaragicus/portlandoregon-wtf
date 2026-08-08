// Baked game map types. Pure data — no imports, no three.js (renderer-only
// concerns stay in client/src/render/; the sim consumes only nodes/edges/entries).
//
// World frame: meters. Origin at the map's SW corner, x east, y north.
// All coordinates lie in [0, meta.width] x [0, meta.height].

export type RoadClass = "arterial" | "collector" | "local" | "alley" | "path";

export interface MapMeta {
  name: string;
  /** Extraction date (matches data/MANIFEST.json), or "synthetic". */
  sourceDate: string;
  /** WGS84 position of world (0, 0). */
  origin: { lat: number; lon: number };
  /** Play area size in meters. */
  width: number;
  height: number;
}

/** Street intersection (graph node). */
export interface StreetNode {
  id: number;
  x: number;
  y: number;
}

/** Street segment (graph edge) between nodes `a` and `b`. */
export interface StreetEdge {
  id: number;
  a: number;
  b: number;
  /** Simplified centerline in local meters, endpoints at nodes a/b. */
  polyline: [number, number][];
  /** Render width in meters (derived from road class). */
  width: number;
  /** e.g. "NW COUCH ST" — free flavor for the UI. */
  name: string;
  class: RoadClass;
  /** Grade separation (from Portland's STRUC_TYPE): bridges/viaducts span
   * between endpoint heights; tunnels are not rendered. Absent = at grade. */
  struct?: "bridge" | "tunnel";
  /**
   * Deck level at each end, from Portland's F_ZLEV/T_ZLEV. 1 is grade, 2 is
   * one level up, and so on. This is the only thing that says an overpass is
   * above the road it crosses: the 30 m DEM does not resolve the cut beneath
   * it, so terrain alone leaves every land bridge lying flat on the ground.
   */
  zlev?: [number, number];
  /**
   * Deck width in metres, measured from the city's published bridge outline.
   * Absent when the span sits on no published deck, in which case the
   * renderer falls back to the road class's drawn width.
   */
  deckWidth?: number;
}

/** Normalized building category, for palette/gameplay variety. */
export type BuildingUse = "sfr" | "mfr" | "com" | "off" | "ind" | "inst" | "other";

/** Extruded 2.5D building prism. */
export interface Building {
  id: number;
  /** Outer ring, CCW, not closed (first point not repeated). */
  footprint: [number, number][];
  /** Inner rings (courtyards), CW. */
  holes?: [number, number][][];
  /** Extrusion height in meters. */
  height: number;
  /** Normalized use category (older baked maps carry raw BLDG_USE strings). */
  use?: string;
}

/** Water surface polygon (render-only). rings[0] is the outer ring; the
 * rest are holes (islands). */
export interface WaterBody {
  id: number;
  rings: [number, number][][];
}

/** Decorative city props — renderer-only, invisible to the sim. */
export type Prop =
  | { kind: "tree"; x: number; y: number; size: 1 | 2 | 3 }
  | { kind: "sign"; x: number; y: number; rot: number; sign: "stop" | "street-name" | "other" }
  | { kind: "signal"; x: number; y: number }
  | { kind: "light"; x: number; y: number }
  | { kind: "meter"; x: number; y: number }
  | { kind: "furniture"; x: number; y: number }
  | { kind: "bikerack"; x: number; y: number }
  | { kind: "bump"; x: number; y: number }
  | { kind: "hydrant"; x: number; y: number };

/** Render-only trail polyline (parks paths, regional corridors). */
export interface Trail {
  id: number;
  polyline: [number, number][];
}

/** Rail line (render-only): heavy freight rail, MAX light rail, Portland
 * Streetcar, or WES commuter rail. */
export interface RailLine {
  id: number;
  polyline: [number, number][];
  kind: "rail" | "max" | "streetcar" | "wes";
}

/** Rail transit stop/station platform (render-only). */
export interface RailStop {
  id: number;
  x: number;
  y: number;
  kind: "max" | "streetcar" | "wes";
  name: string;
}

/** Painted pavement area (crosswalk ladder, stop bar, island). */
export interface MarkingArea {
  id: number;
  rings: [number, number][][];
  style: "white" | "yellow";
}

/** Painted lane line. */
export interface MarkingLine {
  id: number;
  polyline: [number, number][];
  style: "white" | "yellow";
}

/** Named civic point of interest, drawn with a label. */
/**
 * A bridge deck outline. The street graph already spans bridges between
 * endpoint heights; this carries the real deck footprint and, for the 13
 * Willamette crossings, the name — the only bridge layer the city publishes
 * with one.
 */
export interface BridgeDeck {
  id: number;
  rings: [number, number][][];
  /** Willamette crossings only; the 520 road bridges are unnamed at source. */
  name?: string;
  kind: "river" | "road";
}

export interface Landmark {
  id: number;
  kind: "fire-station" | "police" | "hospital" | "city-hall" | "school";
  /** Short map label, e.g. "Station 12". */
  label: string;
  /** Full name from the source, e.g. "Portland Fire Station 12". */
  name: string;
  address: string;
  x: number;
  y: number;
  /** Footprint cluster the landmark occupies — those prisms are painted as
   * the landmark. A list because the footprint DB splits one hall into
   * several prisms. Absent/empty when no footprint matched. */
  buildingIds?: number[];
}

export interface GameMap {
  meta: MapMeta;
  nodes: StreetNode[];
  edges: StreetEdge[];
  buildings: Building[];
  /** Boundary node ids — deploy zones / future supply entry edges. */
  entries: { north: number[]; south: number[] };
  props: Prop[];
  /** River/water surfaces (absent on maps baked before Tier 2). */
  water?: WaterBody[];
  /** Park/greenspace polygons (render-only). */
  parks?: WaterBody[];
  /** Trails (render-only). */
  trails?: Trail[];
  /** Labeled civic landmarks (absent on maps baked before landmarks). */
  landmarks?: Landmark[];
  /** Rail lines: freight, MAX, streetcar, WES (render-only). */
  rails?: RailLine[];
  /** Railroad yard polygons (render-only). */
  railYards?: WaterBody[];
  /** Rail transit stops (render-only). */
  railStops?: RailStop[];
  /** Sidewalk polygons (render-only; Portland city limits). */
  sidewalks?: WaterBody[];
  /** Painted pavement shapes — crosswalks, stop bars, islands (render-only). */
  markingAreas?: MarkingArea[];
  /** Painted lane centerlines (render-only). */
  markingLines?: MarkingLine[];
  bridges?: BridgeDeck[];
}
