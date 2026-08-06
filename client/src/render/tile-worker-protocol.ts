export interface PrismTileRequest {
  type: "prisms";
  tile: number;
  generation: number;
  buildingIndex: Uint32Array;
  sourceId: Uint32Array;
  buildingRingStart: Uint32Array;
  ringOffset: Uint32Array;
  coords: Float32Array;
  height: Float32Array;
  baseZ: Float32Array;
  color: Float32Array;
  /** 0 = ordinary, 1+ = landmark material slot. */
  materialSlot: Uint8Array;
}

export interface PrismGroupResult {
  materialSlot: number;
  position: Float32Array;
  normal: Float32Array;
  color: Float32Array;
  /** global building index, first vertex, vertex count, then RGB */
  recordBuilding: Uint32Array;
  recordStart: Uint32Array;
  recordCount: Uint32Array;
  recordColor: Float32Array;
}

export interface PrismTileResult {
  type: "prisms";
  tile: number;
  generation: number;
  groups: PrismGroupResult[];
  bytes: number;
}

/** A normalized, transferable slice of one FeatureStore tile. */
export interface DetailFeatureSlice {
  /** Ring index per feature, relative to this slice. */
  featureRingStart: Uint32Array;
  /** Point index per ring, relative to coords. */
  ringOffset: Uint32Array;
  coords: Float32Array;
  attr: Uint8Array;
  /** Whether a line feature spans water (unused for polygon layers). */
  span: Uint8Array;
}

/** Transferable street polylines. Width and span are per line. */
export interface DetailStreetSlice {
  lineStart: Uint32Array;
  coords: Float32Array;
  width: Float32Array;
  span: Uint8Array;
}

/**
 * The smallest rectangular heightfield window touched by a detail tile.
 * Global dimensions are retained so edge clamping exactly matches heightAt.
 */
export interface DetailHeightSlice {
  originCol: number;
  originRow: number;
  cols: number;
  rows: number;
  mapCols: number;
  mapRows: number;
  cellSize: number;
  scale: number;
  data: Uint16Array;
}

export interface DetailTileRequest {
  type: "details";
  tile: number;
  generation: number;
  cell: number;
  sidewalks: DetailFeatureSlice;
  markingAreas: DetailFeatureSlice;
  markingLines: DetailFeatureSlice;
  streets: DetailStreetSlice;
  trails: DetailFeatureSlice;
  rails: DetailFeatureSlice;
  height: DetailHeightSlice | null;
}

export interface DetailTileCancel {
  type: "cancel-details";
  tile: number;
  generation: number;
}

/** Stable material identities carried across the worker boundary. */
export const DETAIL_MATERIAL = {
  sidewalk: 0,
  markingWhite: 1,
  markingYellow: 2,
  street: 3,
  laneLine: 4,
  trail: 5,
  rail: 6,
  railMax: 7,
  railStreetcar: 8,
  railWes: 9,
} as const;

export type DetailMaterialSlot = (typeof DETAIL_MATERIAL)[keyof typeof DETAIL_MATERIAL];

export interface DetailGroupResult {
  materialSlot: DetailMaterialSlot;
  renderOrder: number;
  solid: boolean;
  /** Float32 for tilted sidewalk normals, packed Int16 for all-up layers. */
  position: Float32Array | Int16Array;
  /** Normalized signed bytes. */
  normal: Int8Array;
  /** Transform used to reconstruct packed positions. */
  positionOffset: [number, number, number];
  positionScale: [number, number, number];
}

export interface DetailTileResult {
  type: "details";
  tile: number;
  generation: number;
  groups: DetailGroupResult[];
  /** Exact sum of the transferable result buffers. */
  bytes: number;
  packErrorH: number;
  packErrorV: number;
}

export type TileWorkerRequest = PrismTileRequest | DetailTileRequest | DetailTileCancel;
export type TileWorkerResult = PrismTileResult | DetailTileResult;
