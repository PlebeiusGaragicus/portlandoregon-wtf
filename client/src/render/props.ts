import * as THREE from "three";
import type { GameMap, Prop } from "@battle-juice/shared";
import { toScene } from "./camera.js";

const TRUNK_COLOR = 0x5c4a36;
const CANOPY_BASE = new THREE.Color(0x3e7c4f);
const SIGN_POLE_COLOR = 0x9aa0ab;
const SIGN_FACE: Record<Extract<Prop, { kind: "sign" }>["sign"], number> = {
  stop: 0xc0392b,
  "street-name": 0x27713f,
  other: 0x8a8f99,
};
const CANOPY_RADIUS: Record<1 | 2 | 3, number> = { 1: 1.5, 2: 2.5, 3: 3.5 };

const TILE = 1000; // meters — instanced meshes chunked for frustum culling

type Tree = Extract<Prop, { kind: "tree" }>;
type Sign = Extract<Prop, { kind: "sign" }>;
type Signal = Extract<Prop, { kind: "signal" }>;

/** All decorative props, tiled into InstancedMeshes per prop family. */
export function buildProps(map: GameMap): THREE.Group {
  const group = new THREE.Group();
  const byTile = new Map<number, { trees: Tree[]; signs: Sign[]; signals: Signal[] }>();
  for (const p of map.props) {
    const key = Math.floor(p.y / TILE) * 4096 + Math.floor(p.x / TILE);
    let bucket = byTile.get(key);
    if (!bucket) {
      bucket = { trees: [], signs: [], signals: [] };
      byTile.set(key, bucket);
    }
    if (p.kind === "tree") bucket.trees.push(p);
    else if (p.kind === "sign") bucket.signs.push(p);
    else bucket.signals.push(p);
  }

  // Shared geometries/materials across all tiles.
  const flat = { flatShading: true } as const;
  const trunkGeo = new THREE.CylinderGeometry(0.25, 0.35, 2, 5);
  const canopyGeo = new THREE.IcosahedronGeometry(1, 0);
  const trunkMat = new THREE.MeshLambertMaterial({ color: TRUNK_COLOR, ...flat });
  const canopyMat = new THREE.MeshLambertMaterial({ ...flat });
  const poleGeo = new THREE.CylinderGeometry(0.06, 0.06, 2.5, 5);
  const faceGeo = new THREE.BoxGeometry(0.7, 0.7, 0.08);
  const poleMat = new THREE.MeshLambertMaterial({ color: SIGN_POLE_COLOR });
  const faceMat = new THREE.MeshLambertMaterial({ ...flat });
  const sigPoleGeo = new THREE.CylinderGeometry(0.1, 0.12, 4.5, 5);
  const sigHeadGeo = new THREE.BoxGeometry(0.4, 1.0, 0.4);
  const sigPoleMat = new THREE.MeshLambertMaterial({ color: 0x4a505c });
  const sigHeadMat = new THREE.MeshLambertMaterial({ color: 0x2b2f36, ...flat });

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
        m.makeTranslation(toScene(t.x, t.y, 1));
        trunks.setMatrixAt(i, m);
        m.makeScale(r, r, r).setPosition(toScene(t.x, t.y, 1.6 + r * 0.8));
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
        m.makeTranslation(toScene(s.x, s.y, 1.25));
        poles.setMatrixAt(i, m);
        q.setFromAxisAngle(up, s.rot);
        m.compose(toScene(s.x, s.y, 2.3), q, one);
        faces.setMatrixAt(i, m);
        faces.setColorAt(i, color.setHex(SIGN_FACE[s.sign]));
      });
      group.add(poles, faces);
    }
    if (bucket.signals.length) {
      const poles = new THREE.InstancedMesh(sigPoleGeo, sigPoleMat, bucket.signals.length);
      const heads = new THREE.InstancedMesh(sigHeadGeo, sigHeadMat, bucket.signals.length);
      bucket.signals.forEach((s, i) => {
        m.makeTranslation(toScene(s.x, s.y, 2.25));
        poles.setMatrixAt(i, m);
        m.makeTranslation(toScene(s.x, s.y, 4.6));
        heads.setMatrixAt(i, m);
      });
      group.add(poles, heads);
    }
  }
  return group;
}

// Deterministic per-index jitter in [-1, 1] (no Math.random — stable frames).
function jitter(i: number): number {
  return (Math.sin(i * 127.1 + 311.7) * 43758.5453) % 1;
}
