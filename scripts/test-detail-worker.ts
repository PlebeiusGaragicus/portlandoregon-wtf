import * as THREE from "three";
import {
  layersFromMap,
  storeFromBuildings,
  type GameMap,
  type Heightfield,
} from "@battle-juice/shared";
import { buildWorld } from "../client/src/render/world.js";
import {
  buildDetailTile,
} from "../client/src/render/tile-worker.js";
import {
  DETAIL_MATERIAL,
  type DetailFeatureSlice,
  type DetailTileRequest,
} from "../client/src/render/tile-worker-protocol.js";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
}

type Ring = [number, number][];
interface Feature {
  rings: Ring[];
  attr?: number;
  span?: boolean;
}

function features(items: Feature[]): DetailFeatureSlice {
  const featureRingStart = new Uint32Array(items.length + 1);
  const ringOffsets = [0];
  const coords: number[] = [];
  for (let feature = 0; feature < items.length; feature++) {
    for (const ring of items[feature]!.rings) {
      for (const [x, y] of ring) coords.push(x, y);
      ringOffsets.push(coords.length / 2);
    }
    featureRingStart[feature + 1] = ringOffsets.length - 1;
  }
  return {
    featureRingStart,
    ringOffset: Uint32Array.from(ringOffsets),
    coords: Float32Array.from(coords),
    attr: Uint8Array.from(items.map((item) => item.attr ?? 0)),
    span: Uint8Array.from(items.map((item) => item.span ? 1 : 0)),
  };
}

const rectangle = (x: number, y: number, w: number, h = w): Ring => [
  [x, y], [x + w, y], [x + w, y + h], [x, y + h],
];
const line = (y: number, bend = 0): Ring => [[20, y], [170, y + bend], [350, y]];

const sidewalks: Feature[] = [];
for (let row = 0; row < 3; row++) {
  for (let col = 0; col < 3; col++) {
    sidewalks.push({ rings: [rectangle(20 + col * 105, 20 + row * 105, 82, 26)] });
  }
}
const markingAreas: Feature[] = [
  { rings: [rectangle(80, 185, 18, 9)], attr: 0 },
  { rings: [rectangle(115, 185, 18, 9)], attr: 1 },
];
const markingLines: Feature[] = [{ rings: [line(160, 12)] }];
const trails: Feature[] = [{ rings: [line(245, -18)] }];
const rails: Feature[] = [0, 1, 2, 3].map((attr, index) => ({
  rings: [line(275 + index * 16, index % 2 ? 8 : -8)],
  attr,
}));
const streetLine = line(130, 20);

const heightfield: Heightfield = {
  cols: 10,
  rows: 10,
  cellSize: 50,
  scale: 0.25,
  data: Uint16Array.from({ length: 100 }, (_, index) => (index % 10) * 3 + Math.floor(index / 10) * 2),
};

const request: DetailTileRequest = {
  type: "details",
  tile: 0,
  generation: 7,
  cell: heightfield.cellSize,
  sidewalks: features(sidewalks),
  markingAreas: features(markingAreas),
  markingLines: features(markingLines),
  streets: {
    lineStart: new Uint32Array([0, streetLine.length]),
    coords: Float32Array.from(streetLine.flat()),
    width: new Float32Array([11]),
    span: new Uint8Array([1]),
  },
  trails: features(trails),
  rails: features(rails),
  height: {
    originCol: 0,
    originRow: 0,
    cols: heightfield.cols,
    rows: heightfield.rows,
    mapCols: heightfield.cols,
    mapRows: heightfield.rows,
    cellSize: heightfield.cellSize,
    scale: heightfield.scale,
    data: heightfield.data.slice(),
  },
};

const result = buildDetailTile(request);
const actualBytes = result.groups.reduce(
  (sum, group) => sum + group.position.byteLength + group.normal.byteLength,
  0,
);
check("dense result returns geometry", result.groups.length >= 9, `${result.groups.length} material groups`);
check("result bytes are actual transferred bytes", result.bytes === actualBytes, `${result.bytes} vs ${actualBytes}`);
check(
  "material and render-order metadata survive",
  result.groups.every((group) => Number.isFinite(group.renderOrder)) &&
    result.groups.some((group) => group.materialSlot === DETAIL_MATERIAL.sidewalk && group.solid) &&
    result.groups.some((group) => group.materialSlot === DETAIL_MATERIAL.railWes && !group.solid),
);

const empty = buildDetailTile({
  ...request,
  tile: 99,
  generation: 1,
  sidewalks: features([]),
  markingAreas: features([]),
  markingLines: features([]),
  streets: {
    lineStart: new Uint32Array([0]),
    coords: new Float32Array(),
    width: new Float32Array(),
    span: new Uint8Array(),
  },
  trails: features([]),
  rails: features([]),
  height: null,
});
check("empty tile returns no buffers", empty.groups.length === 0 && empty.bytes === 0);

const map = {
  meta: { name: "worker-equivalence", sourceDate: "test", origin: { lat: 0, lon: 0 }, width: 450, height: 450 },
  buildings: [],
  props: [],
  nodes: [],
  landmarks: [],
  sidewalks: sidewalks.map((item, id) => ({ id, rings: item.rings })),
  markingAreas: markingAreas.map((item, id) => ({
    id,
    rings: item.rings,
    style: item.attr === 1 ? "yellow" : "white",
  })),
  markingLines: markingLines.map((item, id) => ({ id, polyline: item.rings[0], style: "white" })),
  edges: [{
    id: 1,
    a: 0,
    b: 1,
    polyline: streetLine,
    width: 11,
    class: "local",
    struct: "bridge",
    name: "TEST",
  }],
  trails: trails.map((item, id) => ({ id, polyline: item.rings[0] })),
  rails: rails.map((item, id) => ({
    id,
    polyline: item.rings[0],
    kind: ["rail", "max", "streetcar", "wes"][item.attr ?? 0],
  })),
} as unknown as GameMap;

const world = buildWorld(map, storeFromBuildings([]), layersFromMap(map), heightfield);
world.detailTiles.group.updateMatrixWorld(true);

function addPoint(byOrder: Map<number, string[]>, order: number, x: number, y: number, z: number): void {
  let points = byOrder.get(order);
  if (!points) byOrder.set(order, (points = []));
  points.push(`${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`);
}

const syncPoints = new Map<number, string[]>();
const vector = new THREE.Vector3();
world.detailTiles.group.traverse((object) => {
  if (!(object instanceof THREE.Mesh)) return;
  const position = object.geometry.getAttribute("position") as THREE.BufferAttribute;
  for (let vertex = 0; vertex < position.count; vertex++) {
    vector.set(position.getX(vertex), position.getY(vertex), position.getZ(vertex)).applyMatrix4(object.matrixWorld);
    addPoint(syncPoints, object.renderOrder, vector.x, vector.y, vector.z);
  }
});

const workerPoints = new Map<number, string[]>();
for (const group of result.groups) {
  const position = new THREE.BufferAttribute(group.position, 3, group.position instanceof Int16Array);
  for (let vertex = 0; vertex < position.count; vertex++) {
    addPoint(
      workerPoints,
      group.renderOrder,
      group.positionOffset[0] + position.getX(vertex) * group.positionScale[0],
      group.positionOffset[1] + position.getY(vertex) * group.positionScale[1],
      group.positionOffset[2] + position.getZ(vertex) * group.positionScale[2],
    );
  }
}

const orders = [...new Set([...syncPoints.keys(), ...workerPoints.keys()])].sort((a, b) => a - b);
let mismatched = 0;
for (const order of orders) {
  const sync = syncPoints.get(order)?.sort() ?? [];
  const worked = workerPoints.get(order)?.sort() ?? [];
  if (sync.length !== worked.length || sync.some((point, index) => point !== worked[index])) mismatched++;
}
check(
  "worker geometry matches synchronous reference",
  mismatched === 0 && orders.length >= 6,
  `${mismatched} mismatched of ${orders.length} render orders`,
);

world.dispose();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exitCode = failed ? 1 : 0;
