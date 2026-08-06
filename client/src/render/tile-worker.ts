/// <reference lib="webworker" />
import * as THREE from "three";
import type {
  DetailFeatureSlice,
  DetailGroupResult,
  DetailMaterialSlot,
  DetailStreetSlice,
  DetailTileRequest,
  DetailTileResult,
  PrismGroupResult,
  PrismTileRequest,
  PrismTileResult,
  TileWorkerRequest,
} from "./tile-worker-protocol.js";
import { DETAIL_MATERIAL } from "./tile-worker-protocol.js";

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

interface DetailSoup {
  materialSlot: DetailMaterialSlot;
  renderOrder: number;
  solid: boolean;
  position: number[];
  normal: number[];
}

const DETAIL_ORDER = {
  sidewalk: 0.5,
  trail: 4,
  street: 5,
  rail: 6,
  marking: 8,
  laneLine: 9,
} as const;
const DRAPE_EDGE = 10;
const DRAPE_DEPTH_CAP = 12;
const SKIRT_SEG = 30;
const DECAL_Y = 0.09;
const SIDEWALK_Y = 0.03;
const CURB_H = 0.14;
const RIBBON_STEP = 15;
const PACK_MAX_EXTENT = 2000;
const RAIL_WIDTH = [4, 3.2, 2.6, 3.2] as const;
const RAIL_MATERIAL = [
  DETAIL_MATERIAL.rail,
  DETAIL_MATERIAL.railMax,
  DETAIL_MATERIAL.railStreetcar,
  DETAIL_MATERIAL.railWes,
] as const;

function detailSoup(
  soups: Map<DetailMaterialSlot, DetailSoup>,
  materialSlot: DetailMaterialSlot,
  renderOrder: number,
  solid = false,
): DetailSoup {
  let soup = soups.get(materialSlot);
  if (!soup) {
    soup = { materialSlot, renderOrder, solid, position: [], normal: [] };
    soups.set(materialSlot, soup);
  }
  return soup;
}

function detailGround(request: DetailTileRequest): (x: number, y: number) => number {
  const h = request.height;
  if (!h) return () => 0;
  return (x, y) => {
    const fx = Math.max(0, Math.min(h.mapCols - 1.001, x / h.cellSize));
    const fy = Math.max(0, Math.min(h.mapRows - 1.001, y / h.cellSize));
    const globalCol = Math.floor(fx);
    const globalRow = Math.floor(fy);
    const col = globalCol - h.originCol;
    const row = globalRow - h.originRow;
    const tx = fx - globalCol;
    const ty = fy - globalRow;
    const i = row * h.cols + col;
    const v00 = h.data[i]!;
    const v10 = h.data[i + 1]!;
    const v01 = h.data[i + h.cols]!;
    const v11 = h.data[i + h.cols + 1]!;
    const value =
      tx + ty <= 1
        ? v00 + (v10 - v00) * tx + (v01 - v00) * ty
        : v11 + (v01 - v11) * (1 - tx) + (v10 - v11) * (1 - ty);
    return value * h.scale;
  };
}

function subdivideDetail(
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
  if (longest === ab) {
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    subdivideDetail(ax, ay, mx, my, cx, cy, depth + 1, emit);
    subdivideDetail(mx, my, bx, by, cx, cy, depth + 1, emit);
  } else if (longest === bc) {
    const mx = (bx + cx) / 2;
    const my = (by + cy) / 2;
    subdivideDetail(ax, ay, bx, by, mx, my, depth + 1, emit);
    subdivideDetail(ax, ay, mx, my, cx, cy, depth + 1, emit);
  } else {
    const mx = (cx + ax) / 2;
    const my = (cy + ay) / 2;
    subdivideDetail(ax, ay, bx, by, mx, my, depth + 1, emit);
    subdivideDetail(mx, my, bx, by, cx, cy, depth + 1, emit);
  }
}

function featureRings(slice: DetailFeatureSlice, feature: number): THREE.Vector2[][] {
  const rings: THREE.Vector2[][] = [];
  for (let ring = slice.featureRingStart[feature]!; ring < slice.featureRingStart[feature + 1]!; ring++) {
    const points: THREE.Vector2[] = [];
    for (let point = slice.ringOffset[ring]!; point < slice.ringOffset[ring + 1]!; point++) {
      points.push(new THREE.Vector2(slice.coords[point * 2]!, slice.coords[point * 2 + 1]!));
    }
    rings.push(points);
  }
  return rings;
}

function buildPolygons(
  slice: DetailFeatureSlice,
  soups: Map<DetailMaterialSlot, DetailSoup>,
  materialOf: (feature: number) => DetailMaterialSlot,
  renderOrder: number,
  yOff: number,
  ground: (x: number, y: number) => number,
  curb = 0,
): void {
  const featureCount = Math.max(0, slice.featureRingStart.length - 1);
  for (let feature = 0; feature < featureCount; feature++) {
    const rings = featureRings(slice, feature);
    const outer = rings[0];
    if (!outer || outer.length < 3) continue;
    const soup = detailSoup(soups, materialOf(feature), renderOrder, curb > 0);
    const holes = rings.slice(1).filter((ring) => ring.length >= 3);
    const flat = outer.concat(...holes);
    for (const triangle of THREE.ShapeUtils.triangulateShape(outer, holes)) {
      const a = flat[triangle[0]!];
      const b = flat[triangle[1]!];
      const c = flat[triangle[2]!];
      if (!a || !b || !c) continue;
      const emit = (x: number, y: number): void => {
        soup.position.push(x, yOff + curb + ground(x, y), -y);
        if (curb) soup.normal.push(0, 1, 0);
      };
      subdivideDetail(a.x, a.y, b.x, b.y, c.x, c.y, 0, emit);
    }
    if (!curb) continue;
    const lo = yOff - 0.4;
    const hi = yOff + curb;
    for (const ring of rings) {
      if (ring.length < 3) continue;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]!;
        const b = ring[(i + 1) % ring.length]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const length = Math.hypot(dx, dy);
        if (length < 1e-6) continue;
        const nx = dy / length;
        const ny = -dx / length;
        const segments = Math.max(1, Math.ceil(length / SKIRT_SEG));
        for (let segment = 0; segment < segments; segment++) {
          const ax = a.x + (dx * segment) / segments;
          const ay = a.y + (dy * segment) / segments;
          const bx = a.x + (dx * (segment + 1)) / segments;
          const by = a.y + (dy * (segment + 1)) / segments;
          const ga = ground(ax, ay);
          const gb = ground(bx, by);
          soup.position.push(
            ax, ga + lo, -ay,
            bx, gb + lo, -by,
            bx, gb + hi, -by,
            ax, ga + lo, -ay,
            bx, gb + hi, -by,
            ax, ga + hi, -ay,
          );
          for (let vertex = 0; vertex < 6; vertex++) soup.normal.push(nx, 0, -ny);
        }
      }
    }
  }
}

function addCrossings(ts: number[], u0: number, u1: number): void {
  if (u0 === u1) return;
  const lo = Math.min(u0, u1);
  const hi = Math.max(u0, u1);
  for (let k = Math.ceil(lo); k <= Math.floor(hi); k++) {
    const t = (k - u0) / (u1 - u0);
    if (t > 1e-4 && t < 1 - 1e-4) ts.push(t);
  }
}

function resampleDetail(coords: Float32Array, from: number, to: number, cell: number, step: number): number[] {
  if (to - from < 2) return [];
  const out = [coords[from * 2]!, coords[from * 2 + 1]!];
  for (let point = from + 1; point < to; point++) {
    const ax = coords[(point - 1) * 2]!;
    const ay = coords[(point - 1) * 2 + 1]!;
    const bx = coords[point * 2]!;
    const by = coords[point * 2 + 1]!;
    const length = Math.hypot(bx - ax, by - ay);
    const ts: number[] = [];
    const segments = Math.ceil(length / step);
    for (let k = 1; k < segments; k++) ts.push(k / segments);
    if (Number.isFinite(cell)) {
      addCrossings(ts, ax / cell, bx / cell);
      addCrossings(ts, ay / cell, by / cell);
      addCrossings(ts, (ax + ay) / cell, (bx + by) / cell);
    }
    ts.sort((a, b) => a - b);
    let last = 0;
    for (const t of ts) {
      if (t - last < 1e-4) continue;
      last = t;
      out.push(ax + (bx - ax) * t, ay + (by - ay) * t);
    }
    out.push(bx, by);
  }
  return out;
}

function pushDetailRibbon(
  position: number[],
  coords: Float32Array,
  from: number,
  to: number,
  width: number,
  ground: (x: number, y: number) => number,
  cell: number,
  span: boolean,
  step = RIBBON_STEP,
): void {
  const line = resampleDetail(coords, from, to, cell, step);
  const count = line.length / 2;
  if (count < 2) return;
  const half = width / 2;
  const xRows = [new Float64Array(count), new Float64Array(count), new Float64Array(count)];
  const yRows = [new Float64Array(count), new Float64Array(count), new Float64Array(count)];
  const heights = [new Float64Array(count), new Float64Array(count), new Float64Array(count)];
  const along = new Float64Array(count);
  for (let point = 0; point < count; point++) {
    const x = line[point * 2]!;
    const y = line[point * 2 + 1]!;
    if (point > 0) {
      along[point] =
        along[point - 1]! +
        Math.hypot(x - line[(point - 1) * 2]!, y - line[(point - 1) * 2 + 1]!);
    }
    let nx = 0;
    let ny = 0;
    for (let segment = point - 1; segment <= point; segment++) {
      if (segment < 0 || segment + 1 >= count) continue;
      const ax = line[segment * 2]!;
      const ay = line[segment * 2 + 1]!;
      const bx = line[(segment + 1) * 2]!;
      const by = line[(segment + 1) * 2 + 1]!;
      const length = Math.hypot(bx - ax, by - ay) || 1;
      nx += -(by - ay) / length;
      ny += (bx - ax) / length;
    }
    const normalLength = Math.hypot(nx, ny) || 1;
    xRows[0]![point] = x + (nx / normalLength) * half;
    yRows[0]![point] = y + (ny / normalLength) * half;
    xRows[1]![point] = x;
    yRows[1]![point] = y;
    xRows[2]![point] = x - (nx / normalLength) * half;
    yRows[2]![point] = y - (ny / normalLength) * half;
  }
  const total = along[count - 1]! || 1;
  const startHeight = ground(line[0]!, line[1]!);
  const endHeight = ground(line[(count - 1) * 2]!, line[(count - 1) * 2 + 1]!);
  for (let row = 0; row < 3; row++) {
    for (let point = 0; point < count; point++) {
      const sampled = ground(xRows[row]![point]!, yRows[row]![point]!);
      heights[row]![point] = span
        ? Math.max(sampled, startHeight + (endHeight - startHeight) * (along[point]! / total))
        : sampled;
    }
  }
  for (let point = 0; point < count - 1; point++) {
    for (let row = 0; row < 2; row++) {
      const ax = xRows[row]!;
      const ay = yRows[row]!;
      const ah = heights[row]!;
      const bx = xRows[row + 1]!;
      const by = yRows[row + 1]!;
      const bh = heights[row + 1]!;
      position.push(
        ax[point]!, DECAL_Y + ah[point]!, -ay[point]!,
        bx[point]!, DECAL_Y + bh[point]!, -by[point]!,
        bx[point + 1]!, DECAL_Y + bh[point + 1]!, -by[point + 1]!,
        ax[point]!, DECAL_Y + ah[point]!, -ay[point]!,
        bx[point + 1]!, DECAL_Y + bh[point + 1]!, -by[point + 1]!,
        ax[point + 1]!, DECAL_Y + ah[point + 1]!, -ay[point + 1]!,
      );
    }
  }
}

function firstRing(slice: DetailFeatureSlice, feature: number): [number, number] {
  const ring = slice.featureRingStart[feature]!;
  return [slice.ringOffset[ring]!, slice.ringOffset[ring + 1]!];
}

function buildFeatureRibbons(
  slice: DetailFeatureSlice,
  soups: Map<DetailMaterialSlot, DetailSoup>,
  materialOf: (feature: number) => DetailMaterialSlot,
  renderOrder: number,
  widthOf: (feature: number) => number,
  ground: (x: number, y: number) => number,
  cell: number,
  step = RIBBON_STEP,
): void {
  const count = Math.max(0, slice.featureRingStart.length - 1);
  for (let feature = 0; feature < count; feature++) {
    const [from, to] = firstRing(slice, feature);
    const soup = detailSoup(soups, materialOf(feature), renderOrder);
    pushDetailRibbon(
      soup.position,
      slice.coords,
      from,
      to,
      widthOf(feature),
      ground,
      cell,
      slice.span[feature] === 1,
      step,
    );
  }
}

function packNormal(values: number[], vertexComponents: number): Int8Array {
  if (!values.length) {
    const up = new Int8Array(vertexComponents);
    for (let i = 1; i < up.length; i += 3) up[i] = 127;
    return up;
  }
  const packed = new Int8Array(values.length);
  for (let i = 0; i < values.length; i++) {
    packed[i] = Math.max(-127, Math.min(127, Math.round(values[i]! * 127)));
  }
  return packed;
}

function finishDetailGroup(soup: DetailSoup): {
  group: DetailGroupResult;
  packErrorH: number;
  packErrorV: number;
} {
  const normal = packNormal(soup.normal, soup.position.length);
  let position: Float32Array | Int16Array = Float32Array.from(soup.position);
  let positionOffset: [number, number, number] = [0, 0, 0];
  let positionScale: [number, number, number] = [1, 1, 1];
  let packErrorH = 0;
  let packErrorV = 0;
  if (!soup.normal.length && position.length) {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < position.length; i += 3) {
      minX = Math.min(minX, position[i]!);
      minY = Math.min(minY, position[i + 1]!);
      minZ = Math.min(minZ, position[i + 2]!);
      maxX = Math.max(maxX, position[i]!);
      maxY = Math.max(maxY, position[i + 1]!);
      maxZ = Math.max(maxZ, position[i + 2]!);
    }
    if (Math.max(maxX - minX, maxY - minY, maxZ - minZ) <= PACK_MAX_EXTENT) {
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const cz = (minZ + maxZ) / 2;
      const hx = Math.max((maxX - minX) / 2, 1e-6);
      const hy = Math.max((maxY - minY) / 2, 1e-6);
      const hz = Math.max((maxZ - minZ) / 2, 1e-6);
      const packed = new Int16Array(position.length);
      for (let i = 0; i < position.length; i += 3) {
        packed[i] = Math.round(((position[i]! - cx) * 32767) / hx);
        packed[i + 1] = Math.round(((position[i + 1]! - cy) * 32767) / hy);
        packed[i + 2] = Math.round(((position[i + 2]! - cz) * 32767) / hz);
      }
      position = packed;
      positionOffset = [cx, cy, cz];
      positionScale = [hx, hy, hz];
      packErrorH = (hx + hz) / 65534;
      packErrorV = hy / 65534;
    }
  }
  return {
    group: {
      materialSlot: soup.materialSlot,
      renderOrder: soup.renderOrder,
      solid: soup.solid,
      position,
      normal,
      positionOffset,
      positionScale,
    },
    packErrorH,
    packErrorV,
  };
}

export function buildDetailTile(request: DetailTileRequest): DetailTileResult {
  const soups = new Map<DetailMaterialSlot, DetailSoup>();
  const ground = detailGround(request);
  buildPolygons(
    request.sidewalks,
    soups,
    () => DETAIL_MATERIAL.sidewalk,
    DETAIL_ORDER.sidewalk,
    SIDEWALK_Y,
    ground,
    CURB_H,
  );
  buildPolygons(
    request.markingAreas,
    soups,
    (feature) => request.markingAreas.attr[feature] === 1
      ? DETAIL_MATERIAL.markingYellow
      : DETAIL_MATERIAL.markingWhite,
    DETAIL_ORDER.marking,
    DECAL_Y,
    ground,
  );
  for (let line = 0; line + 1 < request.streets.lineStart.length; line++) {
    const soup = detailSoup(soups, DETAIL_MATERIAL.street, DETAIL_ORDER.street);
    pushDetailRibbon(
      soup.position,
      request.streets.coords,
      request.streets.lineStart[line]!,
      request.streets.lineStart[line + 1]!,
      request.streets.width[line]!,
      ground,
      request.cell,
      request.streets.span[line] === 1,
    );
  }
  buildFeatureRibbons(
    request.markingLines,
    soups,
    () => DETAIL_MATERIAL.laneLine,
    DETAIL_ORDER.laneLine,
    () => 0.35,
    ground,
    request.cell,
  );
  buildFeatureRibbons(
    request.trails,
    soups,
    () => DETAIL_MATERIAL.trail,
    DETAIL_ORDER.trail,
    () => 2.5,
    ground,
    request.cell,
    Infinity,
  );
  buildFeatureRibbons(
    request.rails,
    soups,
    (feature) => RAIL_MATERIAL[request.rails.attr[feature]!] ?? DETAIL_MATERIAL.rail,
    DETAIL_ORDER.rail,
    (feature) => RAIL_WIDTH[request.rails.attr[feature]!] ?? RAIL_WIDTH[0],
    ground,
    request.cell,
    Infinity,
  );

  let bytes = 0;
  let packErrorH = 0;
  let packErrorV = 0;
  const resultGroups: DetailGroupResult[] = [];
  for (const soup of soups.values()) {
    if (!soup.position.length) continue;
    const finished = finishDetailGroup(soup);
    bytes += finished.group.position.byteLength + finished.group.normal.byteLength;
    packErrorH = Math.max(packErrorH, finished.packErrorH);
    packErrorV = Math.max(packErrorV, finished.packErrorV);
    resultGroups.push(finished.group);
  }
  return {
    type: "details",
    tile: request.tile,
    generation: request.generation,
    groups: resultGroups,
    bytes,
    packErrorH,
    packErrorV,
  };
}

const cancelledDetails = new Map<number, number>();
const workerScope = typeof self === "undefined" ? null : self;
workerScope?.addEventListener("message", (event: MessageEvent<TileWorkerRequest>) => {
  const request = event.data;
  if (request.type === "cancel-details") {
    cancelledDetails.set(request.tile, Math.max(cancelledDetails.get(request.tile) ?? 0, request.generation));
    return;
  }
  if (request.type === "details" && (cancelledDetails.get(request.tile) ?? 0) >= request.generation) return;
  const result = request.type === "prisms" ? buildPrisms(request) : buildDetailTile(request);
  if (result.type === "details" && (cancelledDetails.get(result.tile) ?? 0) >= result.generation) return;
  const transfer: Transferable[] = [];
  if (result.type === "prisms") {
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
  } else {
    for (const group of result.groups) transfer.push(group.position.buffer, group.normal.buffer);
  }
  workerScope.postMessage(result, { transfer });
});
