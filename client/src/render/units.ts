import * as THREE from "three";
import { ENTITY_RADIUS, type Entity, type Snapshot } from "@battle-juice/shared";
import { toScene } from "./camera.js";

const PLAYER_COLORS = ["#4f7cff", "#ff5f4f", "#3ecf6a", "#e6b93e", "#b45fff", "#3ec9cf"];

function colorFor(ownerId: string): string {
  const n = Number(ownerId.replace(/\D/g, "")) || 0;
  return PLAYER_COLORS[n % PLAYER_COLORS.length]!;
}

interface Marker {
  root: THREE.Group;
  targetLine: THREE.Line | null; // own units only
}

/** Per-entity 3D markers, reconciled and interpolated from snapshots. */
export class UnitLayer {
  readonly group = new THREE.Group();
  private markers = new Map<string, Marker>();

  constructor(private myPlayerId: string) {}

  /** Position markers at prev->curr interpolation factor t (0..1). */
  sync(curr: Snapshot, prev: Snapshot | null, t: number): void {
    const seen = new Set<string>();
    for (const e of curr.entities) {
      seen.add(e.id);
      let marker = this.markers.get(e.id);
      if (!marker) {
        marker = this.makeMarker(e);
        this.markers.set(e.id, marker);
        this.group.add(marker.root);
      }
      const before = prev?.entities.find((p) => p.id === e.id);
      const x = before ? before.x + (e.x - before.x) * t : e.x;
      const y = before ? before.y + (e.y - before.y) * t : e.y;
      marker.root.position.copy(toScene(x, y, 0));

      if (marker.targetLine) {
        if (e.target) {
          const pts = [toScene(0, 0, 0.4), toScene(e.target.x - x, e.target.y - y, 0.4)];
          marker.targetLine.geometry.setFromPoints(pts);
          marker.targetLine.visible = true;
        } else {
          marker.targetLine.visible = false;
        }
      }
    }
    for (const [id, marker] of this.markers) {
      if (!seen.has(id)) {
        this.group.remove(marker.root);
        this.markers.delete(id);
      }
    }
  }

  private makeMarker(e: Entity): Marker {
    const root = new THREE.Group();
    const own = e.ownerId === this.myPlayerId;
    const color = new THREE.Color(colorFor(e.ownerId));

    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(ENTITY_RADIUS, ENTITY_RADIUS, 1.5, 12),
      new THREE.MeshLambertMaterial({ color }),
    );
    body.position.y = 0.75;
    root.add(body);

    if (own) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(ENTITY_RADIUS + 1, 0.35, 6, 24),
        new THREE.MeshBasicMaterial({ color: 0xffffff }),
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.3;
      root.add(ring);
    }

    root.add(makeLabel(e.name));

    let targetLine: THREE.Line | null = null;
    if (own) {
      targetLine = new THREE.Line(
        new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ color: 0x4f7cff, transparent: true, opacity: 0.5 }),
      );
      targetLine.visible = false;
      targetLine.frustumCulled = false;
      root.add(targetLine);
    }
    return { root, targetLine };
  }
}

function makeLabel(name: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  ctx.font = "600 34px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fillRect(0, 0, 256, 64);
  ctx.fillStyle = "#e6e6e6";
  ctx.fillText(name.slice(0, 14), 128, 34);

  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true }),
  );
  sprite.scale.set(20, 5, 1); // world meters (orthographic)
  sprite.position.y = ENTITY_RADIUS + 6;
  return sprite;
}
