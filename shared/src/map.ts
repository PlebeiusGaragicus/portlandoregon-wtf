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
  | { kind: "light"; x: number; y: number };

/** Render-only trail polyline (parks paths, regional corridors). */
export interface Trail {
  id: number;
  polyline: [number, number][];
}

/** Named civic point of interest (fire stations today), drawn with a label. */
export interface Landmark {
  id: number;
  kind: "fire-station";
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
}
