/// <reference lib="webworker" />
import * as THREE from "three";
import type {
  PrismGroupResult,
  PrismTileRequest,
  PrismTileResult,
  TileWorkerRequest,
} from "./tile-worker-protocol.js";

interface WorkGroup {
  position: number[];
  normal: number[];
  color: number[];
  building: number[];
  start: number[];
  count: number[];
  recordColor: number[];
}

const groups = new Map<number, WorkGroup>();
const getGroup = (slot: number): WorkGroup => {
  let group = groups.get(slot);
  if (!group) {
    group = { position: [], normal: [], color: [], building: [], start: [], count: [], recordColor: [] };
    groups.set(slot, group);
  }
  return group;
};

function buildPrisms(request: PrismTileRequest): PrismTileResult {
  groups.clear();
  for (let local = 0; local < request.buildingIndex.length; local++) {
    const group = getGroup(request.materialSlot[local]!);
    const start = group.position.length / 3;
    const ringFrom = request.buildingRingStart[local]!;
    const ringTo = request.buildingRingStart[local + 1]!;
    const base = request.baseZ[local]!;
    const h = base + 1 + request.height[local]! + (request.sourceId[local]! % 7) * 0.06;
    const red = request.color[local * 3]!;
    const green = request.color[local * 3 + 1]!;
    const blue = request.color[local * 3 + 2]!;

    for (let ring = ringFrom; ring < ringTo; ring++) {
      const from = request.ringOffset[ring]!;
      const to = request.ringOffset[ring + 1]!;
      const length = to - from;
      for (let i = 0; i < length; i++) {
        const a = (from + i) * 2;
        const b = (from + ((i + 1) % length)) * 2;
        const ax = request.coords[a]!;
        const ay = request.coords[a + 1]!;
        const bx = request.coords[b]!;
        const by = request.coords[b + 1]!;
        const dx = bx - ax;
        const dy = by - ay;
        const edgeLength = Math.hypot(dx, dy);
        if (edgeLength < 1e-9) continue;
        const nx = dy / edgeLength;
        const nz = dx / edgeLength;
        group.position.push(ax, base, -ay, bx, base, -by, bx, h, -by, ax, base, -ay, bx, h, -by, ax, h, -ay);
        for (let v = 0; v < 6; v++) group.normal.push(nx, 0, nz);
        const shade = 0.68;
        group.color.push(
          red * shade, green * shade, blue * shade,
          red * shade, green * shade, blue * shade,
          red, green, blue,
          red * shade, green * shade, blue * shade,
          red, green, blue,
          red, green, blue,
        );
      }
    }

    const rings: THREE.Vector2[][] = [];
    for (let ring = ringFrom; ring < ringTo; ring++) {
      const points: THREE.Vector2[] = [];
      for (let point = request.ringOffset[ring]!; point < request.ringOffset[ring + 1]!; point++) {
        points.push(new THREE.Vector2(request.coords[point * 2]!, request.coords[point * 2 + 1]!));
      }
      rings.push(points);
    }
    const outer = rings[0] ?? [];
    const holes = rings.slice(1);
    const flat = outer.concat(...holes);
    for (const triangle of THREE.ShapeUtils.triangulateShape(outer, holes)) {
      for (const index of triangle) {
        const point = flat[index];
        if (!point) continue;
        group.position.push(point.x, h, -point.y);
        group.normal.push(0, 1, 0);
        group.color.push(red * 0.88, green * 0.88, blue * 0.88);
      }
    }
    group.building.push(request.buildingIndex[local]!);
    group.start.push(start);
    group.count.push(group.position.length / 3 - start);
    group.recordColor.push(red, green, blue);
  }

  let bytes = 0;
  const resultGroups: PrismGroupResult[] = [];
  for (const [materialSlot, group] of groups) {
    const result: PrismGroupResult = {
      materialSlot,
      position: Float32Array.from(group.position),
      normal: Float32Array.from(group.normal),
      color: Float32Array.from(group.color),
      recordBuilding: Uint32Array.from(group.building),
      recordStart: Uint32Array.from(group.start),
      recordCount: Uint32Array.from(group.count),
      recordColor: Float32Array.from(group.recordColor),
    };
    bytes +=
      result.position.byteLength + result.normal.byteLength + result.color.byteLength +
      result.recordBuilding.byteLength + result.recordStart.byteLength +
      result.recordCount.byteLength + result.recordColor.byteLength;
    resultGroups.push(result);
  }
  // Do not retain the last tile's JS number[] staging buffers while idle.
  // They are several times larger than the transferred typed arrays.
  groups.clear();
  return { type: "prisms", tile: request.tile, generation: request.generation, groups: resultGroups, bytes };
}

self.addEventListener("message", (event: MessageEvent<TileWorkerRequest>) => {
  const result = buildPrisms(event.data);
  const transfer: Transferable[] = [];
  for (const group of result.groups) {
    transfer.push(
      group.position.buffer,
      group.normal.buffer,
      group.color.buffer,
      group.recordBuilding.buffer,
      group.recordStart.buffer,
      group.recordCount.buffer,
      group.recordColor.buffer,
    );
  }
  self.postMessage(result, { transfer });
});
