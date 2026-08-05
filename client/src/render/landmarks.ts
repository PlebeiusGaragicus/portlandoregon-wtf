import * as THREE from "three";
import type { Building, GameMap, Landmark } from "@battle-juice/shared";
import { toScene } from "./camera.js";
import { LANDMARK_THEMES } from "./world.js";

// Civic landmarks (fire stations, police, hospitals, city halls). The
// building itself carries the identity — buildWorld paints the matched prism
// in the kind's color — so this layer only adds the name plate above its
// roof, plus a colored pad for pins that never matched a footprint.

const PLATE_CLEARANCE = 8; // m above the roof
const MIN_PLATE_H = 22; // m — floor for flat/short buildings
const PAD_RADIUS = 12; // m, unmatched landmarks only

/** Zoom (viewHeight, m) past which plates are dropped — they'd overlap. */
const LABEL_MAX_VIEW = 6000;

export interface LandmarkLayer {
  group: THREE.Group;
  /** Called per frame with the camera's visible meters, to keep plates legible. */
  setViewScale(viewHeight: number): void;
}

export function buildLandmarks(map: GameMap): LandmarkLayer {
  const group = new THREE.Group();
  const marks = map.landmarks ?? [];
  const byId = new Map<number, Building>();
  for (const b of map.buildings) byId.set(b.id, b);

  const pads = new THREE.Group();
  const plates = new THREE.Group();
  group.add(pads, plates);

  const padGeo = new THREE.CircleGeometry(PAD_RADIUS, 24).rotateX(-Math.PI / 2);
  const padMats = new Map<Landmark["kind"], THREE.MeshBasicMaterial>();
  const padMat = (kind: Landmark["kind"]): THREE.MeshBasicMaterial => {
    let mat = padMats.get(kind);
    if (!mat) {
      mat = new THREE.MeshBasicMaterial({
        color: LANDMARK_THEMES[kind].building,
        transparent: true,
        opacity: 0.7,
        depthWrite: false,
      });
      padMats.set(kind, mat);
    }
    return mat;
  };

  for (const m of marks) {
    const bs = (m.buildingIds ?? []).flatMap((id) => byId.get(id) ?? []);
    // Plates ride the roof of the painted cluster; unmatched ones get a pad
    // on the ground so the station is still findable.
    const anchor = bs.length ? clusterCenter(bs) : [m.x, m.y];
    const tallest = bs.reduce((h, b) => Math.max(h, b.height), 0);
    const h = Math.max(MIN_PLATE_H, tallest + PLATE_CLEARANCE);
    if (!bs.length) {
      const pad = new THREE.Mesh(padGeo, padMat(m.kind));
      pad.position.copy(toScene(m.x, m.y, 0.4));
      pads.add(pad);
    }
    plates.add(plate(m, anchor[0]!, anchor[1]!, h));
  }

  plates.renderOrder = 4;

  return {
    group,
    setViewScale(viewHeight: number): void {
      // Plates stay pinned just over their roof — they name a building, so
      // drifting upward with zoom would detach the label from its subject.
      // depthTest is off, so they stay readable through the skyline anyway.
      plates.visible = viewHeight < LABEL_MAX_VIEW;
    },
  };
}

/** Area-weighted center of the cluster's footprints, so the plate hangs over
 * the hall rather than a corner shed. */
function clusterCenter(bs: Building[]): [number, number] {
  let x = 0;
  let y = 0;
  let total = 0;
  for (const b of bs) {
    let cx = 0;
    let cy = 0;
    for (const [px, py] of b.footprint) {
      cx += px;
      cy += py;
    }
    const w = Math.max(1, ringArea(b.footprint));
    x += (cx / b.footprint.length) * w;
    y += (cy / b.footprint.length) * w;
    total += w;
  }
  return [x / total, y / total];
}

function ringArea(ring: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i]!;
    const [x2, y2] = ring[(i + 1) % ring.length]!;
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

/** Billboarded name plate — a canvas texture on a screen-space sprite. */
function plate(m: Landmark, x: number, y: number, height: number): THREE.Sprite {
  const text = m.label;
  const font = "bold 24px system-ui, sans-serif";
  const measure = document.createElement("canvas").getContext("2d")!;
  measure.font = font;
  const padX = 14;
  const w = Math.ceil(measure.measureText(text).width) + padX * 2;
  const h = 40;

  const theme = LANDMARK_THEMES[m.kind];
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = theme.plateBg;
  roundRect(ctx, 0.5, 0.5, w - 1, h - 1, 7);
  ctx.fill();
  ctx.strokeStyle = theme.plateBorder;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.font = font;
  ctx.fillStyle = theme.plateText;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, w / 2, h / 2 + 1);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, sizeAttenuation: false, depthTest: false, transparent: true }),
  );
  // sizeAttenuation off: scale is in NDC units, so plates keep a constant
  // on-screen size at every zoom.
  sprite.scale.set((w / h) * 0.032, 0.032, 1);
  sprite.position.copy(toScene(x, y, height));
  sprite.userData.baseHeight = height;
  sprite.userData.landmark = m;
  return sprite;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
