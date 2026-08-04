import * as THREE from "three";
import { ENTITY_RADIUS, type Entity, type Snapshot } from "@battle-juice/shared";
import { toScene } from "./camera.js";

const PLAYER_COLORS = ["#4f7cff", "#ff5f4f", "#3ecf6a", "#e6b93e", "#b45fff", "#3ec9cf"];
const RING_COLOR = 0xffffff;
const SELECTED_COLOR = 0xffd84f;

function colorFor(ownerId: string): string {
  const n = Number(ownerId.replace(/\D/g, "")) || 0;
  return PLAYER_COLORS[n % PLAYER_COLORS.length]!;
}

interface Marker {
  root: THREE.Group;
  own: boolean;
  ring: THREE.Mesh | null; // own units only
  routeLine: THREE.Line | null; // own units only
  x: number;
  y: number;
}

/** Per-entity 3D markers, reconciled and interpolated from snapshots. */
export class UnitLayer {
  readonly group = new THREE.Group();
  private markers = new Map<string, Marker>();
  private selectedId: string | null = null;

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
      marker.x = x;
      marker.y = y;
      marker.root.position.copy(toScene(x, y, 0));

      if (marker.routeLine) {
        if (e.path && e.path.length > 0) {
          // Route ahead of the squad, in marker-local coordinates.
          const pts = [new THREE.Vector3(0, 0.5, 0)];
          for (const p of e.path) pts.push(toScene(p.x - x, p.y - y, 0.5));
          marker.routeLine.geometry.setFromPoints(pts);
          marker.routeLine.visible = true;
        } else {
          marker.routeLine.visible = false;
        }
      }
    }
    for (const [id, marker] of this.markers) {
      if (!seen.has(id)) {
        this.group.remove(marker.root);
        this.markers.delete(id);
        if (this.selectedId === id) this.selectedId = null;
      }
    }
  }

  /** Nearest own squad within maxDist meters of a ground point, or null. */
  nearestOwn(x: number, y: number, maxDist: number): string | null {
    let best: string | null = null;
    let bestDist = maxDist;
    for (const [id, m] of this.markers) {
      if (!m.own) continue;
      const d = Math.hypot(m.x - x, m.y - y);
      if (d <= bestDist) {
        bestDist = d;
        best = id;
      }
    }
    return best;
  }

  setSelected(id: string | null): void {
    this.selectedId = id;
    for (const [mid, m] of this.markers) {
      if (!m.ring) continue;
      const selected = mid === id;
      (m.ring.material as THREE.MeshBasicMaterial).color.setHex(selected ? SELECTED_COLOR : RING_COLOR);
      m.ring.scale.setScalar(selected ? 1.25 : 1);
    }
  }

  selected(): string | null {
    return this.selectedId;
  }

  private makeMarker(e: Entity): Marker {
    const root = new THREE.Group();
    const own = e.ownerId === this.myPlayerId;
    const color = new THREE.Color(colorFor(e.ownerId));

    const bodyGeo = new THREE.CylinderGeometry(ENTITY_RADIUS, ENTITY_RADIUS, 1.5, 12);
    const body = new THREE.Mesh(bodyGeo, new THREE.MeshLambertMaterial({ color }));
    body.position.y = 0.75;
    root.add(body);

    let ring: THREE.Mesh | null = null;
    if (own) {
      ring = new THREE.Mesh(
        new THREE.TorusGeometry(ENTITY_RADIUS + 1, 0.35, 6, 24),
        new THREE.MeshBasicMaterial({ color: RING_COLOR }),
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.3;
      root.add(ring);

      // X-ray ghost: same shape, drawn ONLY where the normal depth test
      // fails — i.e. exactly where the squad is hidden behind a building.
      const ghost = new THREE.Mesh(
        bodyGeo,
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.35,
          depthWrite: false,
          depthFunc: THREE.GreaterDepth,
        }),
      );
      ghost.position.y = 0.75;
      ghost.renderOrder = 10;
      root.add(ghost);
    }

    root.add(makeLabel(e.name));

    let routeLine: THREE.Line | null = null;
    if (own) {
      routeLine = new THREE.Line(
        new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ color: 0x4f7cff, transparent: true, opacity: 0.6 }),
      );
      routeLine.visible = false;
      routeLine.frustumCulled = false;
      root.add(routeLine);
    }
    return { root, own, ring, routeLine, x: e.x, y: e.y };
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
