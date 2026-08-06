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

export type TileWorkerRequest = PrismTileRequest;
export type TileWorkerResult = PrismTileResult;
