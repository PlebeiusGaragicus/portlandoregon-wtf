import * as THREE from "three";
import { heightAt, type GameMap, type Heightfield, type Prop } from "@battle-juice/shared";
import { toScene } from "./camera.js";

const TRUNK_COLOR = 0x5c4a36;
const CANOPY_BASE = new THREE.Color(0x3e7c4f);
const SIGN_POLE_COLOR = 0x9aa0ab;
const SIGN_FACE: Record<Extract<Prop, { kind: "sign" }>["sign"], number> = {
  stop: 0xe74c3c, // bright — signs are deliberately oversized RTS icons
  "street-name": 0x2ecc71,
  other: 0x8a8f99,
};
const CANOPY_RADIUS: Record<1 | 2 | 3, number> = { 1: 1.5, 2: 2.5, 3: 3.5 };

const TILE = 1000; // meters — instanced meshes chunked for frustum culling

type Tree = Extract<Prop, { kind: "tree" }>;
type Sign = Extract<Prop, { kind: "sign" }>;
type Signal = Extract<Prop, { kind: "signal" }>;
type Light = Extract<Prop, { kind: "light" }>;
type Simple = Extract<Prop, { kind: "meter" | "furniture" | "bikerack" }>;

/** All decorative props, tiled into InstancedMeshes per prop family. */
export function buildProps(map: GameMap, hf?: Heightfield | null): THREE.Group {
  const g = hf ? (x: number, y: number): number => heightAt(hf, x, y) : (): number => 0;
  const group = new THREE.Group();
  const byTile = new Map<
    number,
    { trees: Tree[]; signs: Sign[]; signals: Signal[]; lights: Light[]; meters: Simple[]; furniture: Simple[]; racks: Simple[] }
  >();
  for (const p of map.props) {
    const key = Math.floor(p.y / TILE) * 4096 + Math.floor(p.x / TILE);
    let bucket = byTile.get(key);
    if (!bucket) {
      bucket = { trees: [], signs: [], signals: [], lights: [], meters: [], furniture: [], racks: [] };
      byTile.set(key, bucket);
    }
    if (p.kind === "tree") bucket.trees.push(p);
    else if (p.kind === "sign") bucket.signs.push(p);
    else if (p.kind === "signal") bucket.signals.push(p);
    else if (p.kind === "light") bucket.lights.push(p);
    else if (p.kind === "meter") bucket.meters.push(p);
    else if (p.kind === "furniture") bucket.furniture.push(p);
    else bucket.racks.push(p);
  }

  // Shared geometries/materials across all tiles.
  const flat = { flatShading: true } as const;
  const trunkGeo = new THREE.CylinderGeometry(0.25, 0.35, 2, 5);
  const canopyGeo = new THREE.IcosahedronGeometry(1, 0);
  const trunkMat = new THREE.MeshLambertMaterial({ color: TRUNK_COLOR, ...flat });
  const canopyMat = new THREE.MeshLambertMaterial({ ...flat });
  // Deliberately oversized (RTS icon scale) — real-size signs are invisible.
  const poleGeo = new THREE.CylinderGeometry(0.18, 0.18, 5, 5);
  const faceGeo = new THREE.BoxGeometry(2.2, 2.2, 0.25);
  const poleMat = new THREE.MeshLambertMaterial({ color: SIGN_POLE_COLOR });
  const faceMat = new THREE.MeshLambertMaterial({ ...flat });
  const sigPoleGeo = new THREE.CylinderGeometry(0.1, 0.12, 4.5, 5);
  const sigHeadGeo = new THREE.BoxGeometry(0.4, 1.0, 0.4);
  const sigPoleMat = new THREE.MeshLambertMaterial({ color: 0x4a505c });
  const sigHeadMat = new THREE.MeshLambertMaterial({ color: 0x2b2f36, ...flat });
  const lightPoleGeo = new THREE.CylinderGeometry(0.08, 0.12, 7, 5);
  const lightHeadGeo = new THREE.SphereGeometry(0.45, 6, 5);
  const lightPoleMat = new THREE.MeshLambertMaterial({ color: 0x555b66 });
  const lightHeadMat = new THREE.MeshBasicMaterial({ color: 0xffd9a0 }); // warm glow, unlit
  // Street-level dressing points (real PBOT assets, stylized shapes).
  const meterGeo = new THREE.CylinderGeometry(0.05, 0.05, 1.3, 5);
  const meterHeadGeo = new THREE.BoxGeometry(0.24, 0.32, 0.12);
  const meterMat = new THREE.MeshLambertMaterial({ color: 0x7b828d });
  const meterHeadMat = new THREE.MeshLambertMaterial({ color: 0x3d434d, ...flat });
  const benchGeo = new THREE.BoxGeometry(1.5, 0.45, 0.55);
  const benchMat = new THREE.MeshLambertMaterial({ color: 0x6a5946, ...flat });
  const rackGeo = new THREE.TorusGeometry(0.4, 0.055, 5, 10, Math.PI);
  const rackMat = new THREE.MeshLambertMaterial({ color: 0x8a919c });

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const one = new THREE.Vector3(1, 1, 1);
  const color = new THREE.Color();

  for (const bucket of byTile.values()) {
    if (bucket.trees.length) {
      const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, bucket.trees.length);
      const canopies = new THREE.InstancedMesh(canopyGeo, canopyMat, bucket.trees.length);
      bucket.trees.forEach((t, i) => {
        const r = CANOPY_RADIUS[t.size];
        const gz = g(t.x, t.y);
        m.makeTranslation(toScene(t.x, t.y, gz + 1));
        trunks.setMatrixAt(i, m);
        m.makeScale(r, r, r).setPosition(toScene(t.x, t.y, gz + 1.6 + r * 0.8));
        canopies.setMatrixAt(i, m);
        color.copy(CANOPY_BASE).offsetHSL(jitter(i) * 0.04, jitter(i + 1) * 0.08, jitter(i + 2) * 0.05);
        canopies.setColorAt(i, color);
      });
      group.add(trunks, canopies);
    }
    if (bucket.signs.length) {
      const poles = new THREE.InstancedMesh(poleGeo, poleMat, bucket.signs.length);
      const faces = new THREE.InstancedMesh(faceGeo, faceMat, bucket.signs.length);
      bucket.signs.forEach((s, i) => {
        const gz = g(s.x, s.y);
        m.makeTranslation(toScene(s.x, s.y, gz + 2.5));
        poles.setMatrixAt(i, m);
        q.setFromAxisAngle(up, s.rot);
        m.compose(toScene(s.x, s.y, gz + 4.6), q, one);
        faces.setMatrixAt(i, m);
        faces.setColorAt(i, color.setHex(SIGN_FACE[s.sign]));
      });
      group.add(poles, faces);
    }
    if (bucket.signals.length) {
      const poles = new THREE.InstancedMesh(sigPoleGeo, sigPoleMat, bucket.signals.length);
      const heads = new THREE.InstancedMesh(sigHeadGeo, sigHeadMat, bucket.signals.length);
      bucket.signals.forEach((s, i) => {
        const gz = g(s.x, s.y);
        m.makeTranslation(toScene(s.x, s.y, gz + 2.25));
        poles.setMatrixAt(i, m);
        m.makeTranslation(toScene(s.x, s.y, gz + 4.6));
        heads.setMatrixAt(i, m);
      });
      group.add(poles, heads);
    }
    if (bucket.lights.length) {
      const poles = new THREE.InstancedMesh(lightPoleGeo, lightPoleMat, bucket.lights.length);
      const heads = new THREE.InstancedMesh(lightHeadGeo, lightHeadMat, bucket.lights.length);
      bucket.lights.forEach((s, i) => {
        const gz = g(s.x, s.y);
        m.makeTranslation(toScene(s.x, s.y, gz + 3.5));
        poles.setMatrixAt(i, m);
        m.makeTranslation(toScene(s.x, s.y, gz + 7.1));
        heads.setMatrixAt(i, m);
      });
      group.add(poles, heads);
    }
    if (bucket.meters.length) {
      const poles = new THREE.InstancedMesh(meterGeo, meterMat, bucket.meters.length);
      const heads = new THREE.InstancedMesh(meterHeadGeo, meterHeadMat, bucket.meters.length);
      bucket.meters.forEach((s, i) => {
        const gz = g(s.x, s.y);
        m.makeTranslation(toScene(s.x, s.y, gz + 0.65));
        poles.setMatrixAt(i, m);
        q.setFromAxisAngle(up, jitter(i) * Math.PI);
        m.compose(toScene(s.x, s.y, gz + 1.4), q, one);
        heads.setMatrixAt(i, m);
      });
      group.add(poles, heads);
    }
    if (bucket.furniture.length) {
      const benches = new THREE.InstancedMesh(benchGeo, benchMat, bucket.furniture.length);
      bucket.furniture.forEach((s, i) => {
        q.setFromAxisAngle(up, jitter(i) * Math.PI);
        m.compose(toScene(s.x, s.y, g(s.x, s.y) + 0.25), q, one);
        benches.setMatrixAt(i, m);
      });
      group.add(benches);
    }
    if (bucket.racks.length) {
      const racks = new THREE.InstancedMesh(rackGeo, rackMat, bucket.racks.length);
      bucket.racks.forEach((s, i) => {
        q.setFromAxisAngle(up, jitter(i) * Math.PI);
        m.compose(toScene(s.x, s.y, g(s.x, s.y) + 0.42), q, one);
        racks.setMatrixAt(i, m);
      });
      group.add(racks);
    }
  }
  return group;
}

// Deterministic per-index jitter in [-1, 1] (no Math.random — stable frames).
function jitter(i: number): number {
  return (Math.sin(i * 127.1 + 311.7) * 43758.5453) % 1;
}
