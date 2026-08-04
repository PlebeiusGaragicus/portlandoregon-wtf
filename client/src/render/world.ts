import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { Building, GameMap, StreetEdge, WaterBody } from "@battle-juice/shared";

const GROUND_COLOR = 0x262c36; // city-block base
const WATER_COLOR = 0x1b2f42; // deep river blue
const STREET_COLOR = 0x3a4150; // asphalt
const WATER_Y = 0.05; // between ground and streets
const STREET_Y = 0.1; // lift above ground to avoid z-fighting
const BUILDING_TINTS = [0x707786, 0x7d8290, 0x8a8578];

/** Static map meshes: ground, water, street ribbons, extruded buildings. */
export function buildWorld(map: GameMap): THREE.Group {
  const group = new THREE.Group();
  group.add(buildGround(map));
  const water = buildWater(map.water ?? []);
  if (water) group.add(water);
  const streets = buildStreets(map.edges);
  if (streets) group.add(streets);
  const buildings = buildBuildings(map.buildings);
  if (buildings) group.add(buildings);
  return group;
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
  return new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ color: WATER_COLOR }));
}

function buildGround(map: GameMap): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(map.meta.width, map.meta.height);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: GROUND_COLOR }));
  mesh.position.set(map.meta.width / 2, 0, -map.meta.height / 2);
  return mesh;
}

/** One merged flat ribbon geometry for all street centerlines. */
function buildStreets(edges: StreetEdge[]): THREE.Mesh | null {
  const parts: THREE.BufferGeometry[] = [];
  for (const edge of edges) {
    const geo = ribbon(edge.polyline, edge.width);
    if (geo) parts.push(geo);
  }
  if (parts.length === 0) return null;
  const merged = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  const mat = new THREE.MeshLambertMaterial({ color: STREET_COLOR, side: THREE.DoubleSide });
  return new THREE.Mesh(merged, mat);
}

/** Triangle-strip ribbon along a polyline with mitered joints, at STREET_Y. */
function ribbon(polyline: [number, number][], width: number): THREE.BufferGeometry | null {
  if (polyline.length < 2) return null;
  const half = width / 2;
  const left: [number, number][] = [];
  const right: [number, number][] = [];

  for (let i = 0; i < polyline.length; i++) {
    const [px, py] = polyline[i]!;
    // Averaged unit normal of the adjacent segments (simple miter).
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

/** All buildings merged into one vertex-colored geometry (single draw call). */
function buildBuildings(buildings: Building[]): THREE.Mesh | null {
  const parts: THREE.BufferGeometry[] = [];
  for (const b of buildings) {
    const geo = prism(b);
    if (geo) parts.push(geo);
  }
  if (parts.length === 0) return null;
  const merged = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  return new THREE.Mesh(merged, mat);
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
