// Hand-authored synthetic map: 400 x 300 m, 3x3 street grid, a few box
// buildings and props. Exists so the renderer and sim have a consumer-free
// test level before the Portland extraction pipeline lands.
import type { GameMap, Prop, StreetEdge, StreetNode } from "../map.js";

// Grid columns at x = 50/200/350, rows at y = 50/150/250. Node id = row * 3 + col.
const XS = [50, 200, 350] as const;
const YS = [50, 150, 250] as const;

const nodes: StreetNode[] = [];
for (let row = 0; row < YS.length; row++) {
  for (let col = 0; col < XS.length; col++) {
    nodes.push({ id: row * 3 + col, x: XS[col]!, y: YS[row]! });
  }
}

function edge(id: number, a: number, b: number, name: string, cls: StreetEdge["class"], width: number): StreetEdge {
  const na = nodes[a]!;
  const nb = nodes[b]!;
  return {
    id,
    a,
    b,
    polyline: [
      [na.x, na.y],
      [nb.x, nb.y],
    ],
    width,
    name,
    class: cls,
  };
}

const edges: StreetEdge[] = [
  // East-west rows (south to north)
  edge(0, 0, 1, "SW TEST ST", "local", 8),
  edge(1, 1, 2, "SW TEST ST", "local", 8),
  edge(2, 3, 4, "MAIN AVE", "arterial", 14),
  edge(3, 4, 5, "MAIN AVE", "arterial", 14),
  edge(4, 6, 7, "NW MOCK ST", "local", 8),
  edge(5, 7, 8, "NW MOCK ST", "local", 8),
  // North-south columns (west to east)
  edge(6, 0, 3, "1ST AVE", "local", 8),
  edge(7, 3, 6, "1ST AVE", "local", 8),
  edge(8, 1, 4, "2ND AVE", "collector", 10),
  edge(9, 4, 7, "2ND AVE", "collector", 10),
  edge(10, 2, 5, "3RD AVE", "local", 8),
  edge(11, 5, 8, "3RD AVE", "local", 8),
];

// Box buildings inside the four blocks (streets are ~8-14 m wide; keep clear).
function box(id: number, x0: number, y0: number, x1: number, y1: number, height: number, use?: string) {
  return {
    id,
    footprint: [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ] as [number, number][],
    height,
    ...(use ? { use } : {}),
  };
}

const buildings = [
  box(0, 65, 65, 130, 135, 12, "OFFICE"),
  box(1, 145, 70, 190, 130, 30, "OFFICE"),
  box(2, 215, 65, 340, 100, 8, "WAREHOUSE"),
  box(3, 215, 110, 280, 135, 18, "APARTMENT"),
  box(4, 65, 165, 185, 235, 40, "OFFICE"),
  box(5, 215, 170, 340, 235, 15, "APARTMENT"),
];

const props: Prop[] = [
  // Trees along MAIN AVE
  { kind: "tree", x: 80, y: 142, size: 2 },
  { kind: "tree", x: 120, y: 142, size: 3 },
  { kind: "tree", x: 160, y: 142, size: 1 },
  { kind: "tree", x: 240, y: 158, size: 2 },
  { kind: "tree", x: 280, y: 158, size: 3 },
  { kind: "tree", x: 320, y: 142, size: 2 },
  // Trees in the NW block courtyard edge
  { kind: "tree", x: 60, y: 245, size: 2 },
  { kind: "tree", x: 200, y: 245, size: 3 },
  // Signs at intersections
  { kind: "sign", x: 194, y: 144, rot: 0, sign: "stop" },
  { kind: "sign", x: 206, y: 156, rot: Math.PI, sign: "stop" },
  { kind: "sign", x: 44, y: 144, rot: 0, sign: "street-name" },
  { kind: "sign", x: 356, y: 156, rot: Math.PI, sign: "street-name" },
  // One signal at the central intersection
  { kind: "signal", x: 208, y: 144 },
];

export const testMap: GameMap = {
  meta: {
    name: "testmap",
    sourceDate: "synthetic",
    origin: { lat: 0, lon: 0 },
    width: 400,
    height: 300,
  },
  nodes,
  edges,
  buildings,
  entries: { north: [6, 7, 8], south: [0, 1, 2] },
  props,
};
