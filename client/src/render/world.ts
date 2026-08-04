import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { Building, GameMap, StreetEdge, WaterBody } from "@battle-juice/shared";

const GROUND_COLOR = 0x262c36; // city-block base
const WATER_COLOR = 0x1b2f42; // deep river blue
const STREET_COLOR = 0x3a4150; // asphalt
const WATER_Y = 0.05; // between ground and streets
const STREET_Y = 0.1; // lift above ground to avoid z-fighting
const BUILDING_TINTS = [0x707786, 0x7d8290, 0x8a8578];

// Tile size for chunked meshes — one merged mesh per tile so the GPU
// frustum-culls off-screen chunks. Every building renders at every zoom.
const TILE = 1000; // meters

export interface WorldLayers {
  group: THREE.Group;
  /** Zoom-driven cosmetics (street tint brightens from altitude). */
  setBlend(f: number): void;
}

/** Static map meshes: ground, water, tiled street ribbons + buildings. */
export function buildWorld(map: GameMap): WorldLayers {
  const group = new THREE.Group();
  group.add(buildGround(map));
  const water = buildWater(map.water ?? []);
  if (water) group.add(water);

  const streetMat = new THREE.MeshLambertMaterial({ color: STREET_COLOR, side: THREE.DoubleSide });
  for (const mesh of buildStreetTiles(map.edges, streetMat)) group.add(mesh);

  const built = buildBuildingTiles(map.buildings, () => true);
  for (const mesh of built.meshes) group.add(mesh);

  const streetNear = new THREE.Color(STREET_COLOR);
  const streetFar = new THREE.Color(0x5a6478); // brighter so the grid reads from altitude
  return {
    group,
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

function buildWater(bodies: WaterBody[]): THREE.Mesh | null {
  const parts: THREE.BufferGeometry[] = [];
  for (const body of bodies) {
    const outer = body.rings[0];
    if (!outer || outer.length < 3) continue;
    const shape = new THREE.Shape(outer.map(([x, y]) => new THREE.Vector2(x, y)));
    for (const hole of body.rings.slice(1)) {
      if (hole.length >= 3) shape.holes.push(new THREE.Path(hole.map(([x, y]) => new THREE.Vector2(x, y))));
    }
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, WATER_Y, 0);
    geo.deleteAttribute("uv");
    parts.push(geo);
  }
  if (parts.length === 0) return null;
  const merged = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  const mat = new THREE.MeshLambertMaterial({ color: WATER_COLOR });
  return new THREE.Mesh(merged, mat);
}

/** Street ribbons, merged per tile (keyed by segment midpoint). */
function buildStreetTiles(edges: StreetEdge[], mat: THREE.MeshLambertMaterial): THREE.Mesh[] {
  const tiles = new Map<number, THREE.BufferGeometry[]>();
  for (const edge of edges) {
    const geo = ribbon(edge.polyline, edge.width);
    if (!geo) continue;
    const [mx, my] = edge.polyline[Math.floor(edge.polyline.length / 2)]!;
    const key = tileKey(mx, my);
    const list = tiles.get(key);
    if (list) list.push(geo);
    else tiles.set(key, [geo]);
  }
  const meshes: THREE.Mesh[] = [];
  for (const parts of tiles.values()) {
    const merged = mergeGeometries(parts);
    for (const p of parts) p.dispose();
    meshes.push(new THREE.Mesh(merged, mat));
  }
  return meshes;
}

/** Triangle-strip ribbon along a polyline with mitered joints, at STREET_Y. */
function ribbon(polyline: [number, number][], width: number): THREE.BufferGeometry | null {
  if (polyline.length < 2) return null;
  const half = width / 2;
  const left: [number, number][] = [];
  const right: [number, number][] = [];

  for (let i = 0; i < polyline.length; i++) {
    const [px, py] = polyline[i]!;
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

  const positions: number[] = [];
  for (let i = 0; i < polyline.length - 1; i++) {
    const quad = [left[i]!, right[i]!, right[i + 1]!, left[i + 1]!];
    for (const idx of [0, 1, 2, 0, 2, 3]) {
      const [wx, wy] = quad[idx]!;
      positions.push(wx, STREET_Y, -wy);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  return geo;
}

/** Buildings merged per tile (keyed by first footprint vertex). */
function buildBuildingTiles(
  buildings: Building[],
  keep: (b: Building) => boolean,
): { meshes: THREE.Mesh[]; material: THREE.MeshLambertMaterial } {
  const tiles = new Map<number, THREE.BufferGeometry[]>();
  for (const b of buildings) {
    if (!keep(b)) continue;
    const geo = prism(b);
    if (!geo) continue;
    const [fx, fy] = b.footprint[0]!;
    const key = tileKey(fx, fy);
    const list = tiles.get(key);
    if (list) list.push(geo);
    else tiles.set(key, [geo]);
  }
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const meshes: THREE.Mesh[] = [];
  for (const parts of tiles.values()) {
    const merged = mergeGeometries(parts);
    for (const p of parts) p.dispose();
    meshes.push(new THREE.Mesh(merged, material));
  }
  return { meshes, material };
}

function prism(b: Building): THREE.BufferGeometry | null {
  if (b.footprint.length < 3) return null;
  const shape = new THREE.Shape(b.footprint.map(([x, y]) => new THREE.Vector2(x, y)));
  for (const hole of b.holes ?? []) {
    shape.holes.push(new THREE.Path(hole.map(([x, y]) => new THREE.Vector2(x, y))));
  }
  const geo = new THREE.ExtrudeGeometry(shape, { depth: b.height, bevelEnabled: false });
  // Shape XY is world XY; extrusion +z becomes scene +y (up), shape y -> -z.
  geo.rotateX(-Math.PI / 2);

  const tint = new THREE.Color(BUILDING_TINTS[b.id % BUILDING_TINTS.length]!);
  const count = geo.getAttribute("position").count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = tint.r;
    colors[i * 3 + 1] = tint.g;
    colors[i * 3 + 2] = tint.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.deleteAttribute("uv"); // merge requires consistent attributes; uv unused
  return geo;
}
