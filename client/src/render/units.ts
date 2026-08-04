import * as THREE from "three";
import { ENTITY_RADIUS, SQUAD_STRENGTH, type Entity, type Snapshot } from "@battle-juice/shared";
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
  routeMesh: THREE.Mesh | null; // own units only — world-space thick ribbon
  tracer: THREE.Line;
  bar: THREE.Sprite;
  barCtx: CanvasRenderingContext2D;
  barTexture: THREE.CanvasTexture;
  lastStrength: number;
  x: number;
  y: number;
}

const ROUTE_Y = 0.35; // above streets, below units
const ROUTE_WIDTH = 3.5; // meters, scaled with zoom

/** Flat world-space ribbon along route points (thick, unlike gl lines). */
function routeGeometry(points: { x: number; y: number }[], width: number): THREE.BufferGeometry {
  const half = width / 2;
  const positions: number[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * half;
    const ny = (dx / len) * half;
    // Two triangles per segment (unmitred — overlaps at joints are invisible).
    const quad: [number, number][] = [
      [a.x + nx, a.y + ny],
      [a.x - nx, a.y - ny],
      [b.x - nx, b.y - ny],
      [b.x + nx, b.y + ny],
    ];
    for (const idx of [0, 1, 2, 0, 2, 3]) {
      const [wx, wy] = quad[idx]!;
      positions.push(wx, ROUTE_Y, -wy);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  return geo;
}

/** Per-entity 3D markers, reconciled and interpolated from snapshots. */
export class UnitLayer {
  readonly group = new THREE.Group();
  private markers = new Map<string, Marker>();
  private selectedIds = new Set<string>();
  private viewScale = 1;

  constructor(private myPlayerId: string) {}

  /** Grow markers when zoomed out so armies stay visible at city scale. */
  setViewScale(s: number): void {
    this.viewScale = s;
  }

  /** Position markers at prev->curr interpolation factor t (0..1). */
  sync(curr: Snapshot, prev: Snapshot | null, t: number): void {
    const seen = new Set<string>();
    // Pass 1: reconcile markers and update positions.
    for (const e of curr.entities) {
      seen.add(e.id);
      let marker = this.markers.get(e.id);
      if (!marker) {
        marker = this.makeMarker(e);
        this.markers.set(e.id, marker);
        this.group.add(marker.root);
      }
      const before = prev?.entities.find((p) => p.id === e.id);
      marker.x = before ? before.x + (e.x - before.x) * t : e.x;
      marker.y = before ? before.y + (e.y - before.y) * t : e.y;
      marker.root.position.copy(toScene(marker.x, marker.y, 0));
      marker.root.scale.setScalar(this.viewScale);
      if (e.strength !== marker.lastStrength) {
        marker.lastStrength = e.strength;
        drawBar(marker.barCtx, e.strength / SQUAD_STRENGTH);
        marker.barTexture.needsUpdate = true;
      }
    }
    for (const [id, marker] of this.markers) {
      if (!seen.has(id)) {
        this.group.remove(marker.root);
        if (marker.routeMesh) {
          marker.routeMesh.geometry.dispose();
          this.group.remove(marker.routeMesh);
        }
        this.markers.delete(id);
        this.selectedIds.delete(id);
      }
    }

    // Pass 2: route ribbons and tracers (need everyone's fresh positions).
    const inv = 1 / this.viewScale;
    const flicker = 0.45 + 0.35 * Math.abs(Math.sin(performance.now() / 40));
    for (const e of curr.entities) {
      const marker = this.markers.get(e.id)!;

      if (marker.routeMesh) {
        if (e.path && e.path.length > 0) {
          // Fresh geometry every update: three's setFromPoints reuses the
          // buffer without trimming, leaving stale tail segments.
          marker.routeMesh.geometry.dispose();
          marker.routeMesh.geometry = routeGeometry(
            [{ x: marker.x, y: marker.y }, ...e.path],
            ROUTE_WIDTH * this.viewScale,
          );
          marker.routeMesh.visible = true;
        } else {
          marker.routeMesh.visible = false;
        }
      }

      const targetMarker = e.firingAt ? this.markers.get(e.firingAt) : undefined;
      if (targetMarker) {
        marker.tracer.geometry.dispose();
        marker.tracer.geometry = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(0, 2, 0),
          toScene((targetMarker.x - marker.x) * inv, (targetMarker.y - marker.y) * inv, 2),
        ]);
        (marker.tracer.material as THREE.LineBasicMaterial).opacity = flicker;
        marker.tracer.visible = true;
      } else {
        marker.tracer.visible = false;
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

  setSelected(ids: string[]): void {
    this.selectedIds = new Set(ids.filter((id) => this.markers.get(id)?.own));
    for (const [mid, m] of this.markers) {
      if (!m.ring) continue;
      const selected = this.selectedIds.has(mid);
      (m.ring.material as THREE.MeshBasicMaterial).color.setHex(selected ? SELECTED_COLOR : RING_COLOR);
      m.ring.scale.setScalar(selected ? 1.25 : 1);
    }
  }

  selected(): string[] {
    return [...this.selectedIds];
  }

  /** Current own-squad world positions (for marquee tests and the minimap). */
  ownPositions(): { id: string; x: number; y: number }[] {
    const out: { id: string; x: number; y: number }[] = [];
    for (const [id, m] of this.markers) if (m.own) out.push({ id, x: m.x, y: m.y });
    return out;
  }

  /** All marker positions with ownership (minimap dots). */
  allPositions(): { own: boolean; x: number; y: number }[] {
    const out: { own: boolean; x: number; y: number }[] = [];
    for (const m of this.markers.values()) out.push({ own: m.own, x: m.x, y: m.y });
    return out;
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

    // Strength bar sprite, redrawn only when strength changes.
    const barCanvas = document.createElement("canvas");
    barCanvas.width = 64;
    barCanvas.height = 10;
    const barCtx = barCanvas.getContext("2d")!;
    drawBar(barCtx, e.strength / SQUAD_STRENGTH);
    const barTexture = new THREE.CanvasTexture(barCanvas);
    const bar = new THREE.Sprite(new THREE.SpriteMaterial({ map: barTexture, transparent: true }));
    bar.scale.set(12, 1.9, 1);
    bar.position.y = ENTITY_RADIUS + 3.2;
    root.add(bar);

    const tracer = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.7 }),
    );
    tracer.visible = false;
    tracer.frustumCulled = false;
    root.add(tracer);

    let routeMesh: THREE.Mesh | null = null;
    if (own) {
      routeMesh = new THREE.Mesh(
        new THREE.BufferGeometry(),
        new THREE.MeshBasicMaterial({ color: 0x5b8cff, transparent: true, opacity: 0.8, depthWrite: false }),
      );
      routeMesh.visible = false;
      routeMesh.frustumCulled = false;
      this.group.add(routeMesh); // world-space, not under the (scaled) marker
    }
    return {
      root,
      own,
      ring,
      routeMesh,
      tracer,
      bar,
      barCtx,
      barTexture,
      lastStrength: e.strength,
      x: e.x,
      y: e.y,
    };
  }
}

function drawBar(ctx: CanvasRenderingContext2D, fraction: number): void {
  const f = Math.max(0, Math.min(1, fraction));
  ctx.clearRect(0, 0, 64, 10);
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(0, 0, 64, 10);
  ctx.fillStyle = f > 0.5 ? "#3ecf6a" : f > 0.25 ? "#e6b93e" : "#ff5f4f";
  ctx.fillRect(1, 1, 62 * f, 8);
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
