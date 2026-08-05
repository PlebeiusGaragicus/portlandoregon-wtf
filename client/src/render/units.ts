import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { ENTITY_RADIUS, SQUAD_POP, type Entity, type Snapshot } from "@battle-juice/shared";
import { toScene } from "./camera.js";

const PLAYER_COLORS = ["#4f7cff", "#ff5f4f", "#3ecf6a", "#e6b93e", "#b45fff", "#3ec9cf"];
const SELECTED_COLOR = 0xffd84f;

export function colorFor(ownerId: string): string {
  const n = Number(ownerId.replace(/\D/g, "")) || 0;
  return PLAYER_COLORS[n % PLAYER_COLORS.length]!;
}

/** Selected-squad facts for the HUD roster. */
export interface SquadInfo {
  id: string;
  name: string;
  pop: number;
  color: string;
}

/** One member of a squad: a tiny independent agent with its own position,
 * facing and stride, so the group flows like a crowd instead of a stamp. */
interface Person {
  x: number;
  y: number;
  px: number; // previous-frame position, for measuring own motion
  py: number;
  heading: number;
  phase: number; // walk-cycle clock
  amp: number; // stride blend 0..1
}

interface Marker {
  root: THREE.Group;
  own: boolean;
  name: string;
  color: THREE.Color;
  pop: number;
  people: Person[];
  routeMesh: THREE.Mesh | null; // own units only — world-space thick ribbon
  tracer: THREE.Line;
  bar: THREE.Sprite;
  barCtx: CanvasRenderingContext2D;
  barTexture: THREE.CanvasTexture;
  lastStrength: number;
  x: number;
  y: number;
  heading: number; // squad travel direction (formation frame)
}

const ROUTE_Y = 0.35; // above streets, below units
const ROUTE_WIDTH = 3.5; // meters, scaled with zoom

// Stick-figure proportions (meters; feet at y=0).
const HIP_Y = 0.74;
const LEG_LEN = 0.74;
const SHOULDER_Y = 1.32;
const ARM_LEN = 0.58;
const CROWD_SPREAD = 1.5; // meters between people in the blob
const LEADER_SCALE = 1.18;

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

function bodyGeometry(): THREE.BufferGeometry {
  const torso = new THREE.CylinderGeometry(0.12, 0.16, 0.62, 5);
  torso.translate(0, SHOULDER_Y - 0.31, 0);
  const head = new THREE.SphereGeometry(0.15, 6, 5);
  head.translate(0, SHOULDER_Y + 0.24, 0);
  const merged = mergeGeometries([torso, head]);
  torso.dispose();
  head.dispose();
  return merged;
}

/** Limb cylinder hanging from its pivot (top at the origin). */
function limbGeometry(rTop: number, rBot: number, len: number): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(rTop, rBot, len, 5);
  geo.translate(0, -len / 2, 0);
  return geo;
}

/** Flat ring on the ground under a selected person (feet-sized halo). */
function discGeometry(): THREE.BufferGeometry {
  const geo = new THREE.RingGeometry(0.42, 0.62, 16);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, 0.18, 0); // above streets/trails, below the route ribbon
  return geo;
}

function flagGeometry(): THREE.BufferGeometry {
  const pole = new THREE.CylinderGeometry(0.03, 0.03, 2.4, 5);
  pole.translate(0, 1.2, 0);
  const banner = new THREE.BoxGeometry(0.6, 0.34, 0.03);
  banner.translate(0.33, 2.15, 0);
  const merged = mergeGeometries([pole, banner]);
  pole.dispose();
  banner.dispose();
  return merged;
}

// Scratch objects for per-instance matrix composition (no per-frame allocs).
const _base = new THREE.Matrix4();
const _m = new THREE.Matrix4();
const _step = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _UP = new THREE.Vector3(0, 1, 0);

/**
 * Instanced crowd: every person in every squad drawn with seven draw calls
 * total (body, four swinging limbs, leader flags, selection discs). Slots
 * beyond the live head count are hidden by shrinking `.count`.
 */
class CrowdPools {
  private body: THREE.InstancedMesh;
  private legL: THREE.InstancedMesh;
  private legR: THREE.InstancedMesh;
  private armL: THREE.InstancedMesh;
  private armR: THREE.InstancedMesh;
  private flags: THREE.InstancedMesh;
  private discs: THREE.InstancedMesh;
  private capacity = 0;
  private flagCapacity = 0;
  private used = 0;
  private flagsUsed = 0;
  private discsUsed = 0;

  private bodyGeo = bodyGeometry();
  private legGeo = limbGeometry(0.055, 0.05, LEG_LEN);
  private armGeo = limbGeometry(0.045, 0.04, ARM_LEN);
  private flagGeo = flagGeometry();
  private discGeo = discGeometry();
  private material = new THREE.MeshLambertMaterial();
  // Selection discs: unlit gold pucks under each selected person's feet.
  private discMaterial = new THREE.MeshBasicMaterial({
    color: SELECTED_COLOR,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  });

  constructor(private group: THREE.Group) {
    this.body = this.legL = this.legR = this.armL = this.armR = this.flags = this.discs = null!;
    this.grow(128, 16);
  }

  private makePool(geo: THREE.BufferGeometry, capacity: number, material: THREE.Material): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geo, material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false; // instances span the whole map
    this.group.add(mesh);
    return mesh;
  }

  private grow(capacity: number, flagCapacity: number): void {
    for (const old of [this.body, this.legL, this.legR, this.armL, this.armR, this.flags, this.discs]) {
      if (old) {
        this.group.remove(old);
        old.dispose();
      }
    }
    this.capacity = capacity;
    this.flagCapacity = flagCapacity;
    this.body = this.makePool(this.bodyGeo, capacity, this.material);
    this.legL = this.makePool(this.legGeo, capacity, this.material);
    this.legR = this.makePool(this.legGeo, capacity, this.material);
    this.armL = this.makePool(this.armGeo, capacity, this.material);
    this.armR = this.makePool(this.armGeo, capacity, this.material);
    this.flags = this.makePool(this.flagGeo, flagCapacity, this.material);
    this.discs = this.makePool(this.discGeo, capacity, this.discMaterial);
  }

  begin(people: number, units: number): void {
    if (people > this.capacity || units > this.flagCapacity) {
      this.grow(Math.ceil(people / 128 + 1) * 128, Math.ceil(units / 16 + 1) * 16);
    }
    this.used = 0;
    this.flagsUsed = 0;
    this.discsUsed = 0;
  }

  /**
   * One person. (px, py) world meters of their feet, heading in world
   * radians, swing in radians (legs; arms counter-swing), scale s.
   */
  person(px: number, py: number, heading: number, swing: number, s: number, color: THREE.Color): void {
    if (this.used >= this.capacity) return;
    const i = this.used++;
    // Scene yaw that points local +Z along the world heading.
    const yaw = Math.atan2(Math.cos(heading), -Math.sin(heading));
    _q.setFromAxisAngle(_UP, yaw);
    _base.compose(_v.set(px, 0, -py), _q, _s.set(s, s, s));

    this.body.setMatrixAt(i, _base);
    this.body.setColorAt(i, color);
    this.limb(this.legL, i, -0.1, HIP_Y, swing, color);
    this.limb(this.legR, i, 0.1, HIP_Y, -swing, color);
    this.limb(this.armL, i, -0.24, SHOULDER_Y, -swing * 0.7, color);
    this.limb(this.armR, i, 0.24, SHOULDER_Y, swing * 0.7, color);
  }

  private limb(pool: THREE.InstancedMesh, i: number, lx: number, ly: number, swing: number, color: THREE.Color): void {
    _step.makeTranslation(lx, ly, 0);
    _m.multiplyMatrices(_base, _step);
    _step.makeRotationX(swing);
    _m.multiply(_step);
    pool.setMatrixAt(i, _m);
    pool.setColorAt(i, color);
  }

  flag(px: number, py: number, heading: number, s: number, color: THREE.Color): void {
    if (this.flagsUsed >= this.flagCapacity) return;
    const i = this.flagsUsed++;
    const yaw = Math.atan2(Math.cos(heading), -Math.sin(heading));
    _q.setFromAxisAngle(_UP, yaw);
    _m.compose(_v.set(px, 0, -py), _q, _s.set(s, s, s));
    this.flags.setMatrixAt(i, _m);
    this.flags.setColorAt(i, color);
  }

  /** Selection puck under one person's feet. */
  disc(px: number, py: number, s: number): void {
    if (this.discsUsed >= this.capacity) return;
    const i = this.discsUsed++;
    _q.identity();
    _m.compose(_v.set(px, 0, -py), _q, _s.set(s, s, s));
    this.discs.setMatrixAt(i, _m);
  }

  commit(): void {
    for (const pool of [this.body, this.legL, this.legR, this.armL, this.armR]) {
      pool.count = this.used;
      pool.instanceMatrix.needsUpdate = true;
      if (pool.instanceColor) pool.instanceColor.needsUpdate = true;
    }
    this.flags.count = this.flagsUsed;
    this.flags.instanceMatrix.needsUpdate = true;
    if (this.flags.instanceColor) this.flags.instanceColor.needsUpdate = true;
    this.discs.count = this.discsUsed;
    this.discs.instanceMatrix.needsUpdate = true;
  }
}

/** Sunflower blob offsets: person i of the crowd, in crowd-local meters
 * (+y is the direction of travel). The leader (i=0) walks out front. */
function crowdOffset(i: number, pop: number): { x: number; y: number } {
  if (i === 0) {
    const front = CROWD_SPREAD * Math.sqrt(pop) * 0.75 + 0.8;
    return { x: 0, y: front };
  }
  const r = CROWD_SPREAD * Math.sqrt(i - 0.5);
  const a = i * 2.39996; // golden angle
  return { x: Math.cos(a) * r, y: Math.sin(a) * r };
}

/** Per-squad walking crowds, reconciled and interpolated from snapshots. */
export class UnitLayer {
  readonly group = new THREE.Group();
  private markers = new Map<string, Marker>();
  private selectedIds = new Set<string>();
  private viewScale = 1;
  private pools = new CrowdPools(this.group);
  private lastSync = 0;

  constructor(private myPlayerId: string) {}

  /** Grow markers when zoomed out so armies stay visible at city scale. */
  setViewScale(s: number): void {
    this.viewScale = s;
  }

  /** Position markers at prev->curr interpolation factor t (0..1). */
  sync(curr: Snapshot, prev: Snapshot | null, t: number): void {
    const now = performance.now();
    const dt = this.lastSync ? Math.min(0.1, (now - this.lastSync) / 1000) : 0.016;
    this.lastSync = now;

    const seen = new Set<string>();
    let totalPeople = 0;
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
      const nx = before ? before.x + (e.x - before.x) * t : e.x;
      const ny = before ? before.y + (e.y - before.y) * t : e.y;
      const mdx = nx - marker.x;
      const mdy = ny - marker.y;
      const moved = Math.hypot(mdx, mdy);
      if (moved > 0.05) {
        // Ease the crowd's facing toward the direction of travel.
        const want = Math.atan2(mdy, mdx);
        let d = want - marker.heading;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        marker.heading += d * Math.min(1, dt * 8);
      }
      marker.x = nx;
      marker.y = ny;
      marker.pop = Math.max(1, Math.ceil(e.strength));
      totalPeople += marker.pop;
      marker.root.position.copy(toScene(marker.x, marker.y, 0));
      marker.root.scale.setScalar(this.viewScale);
      if (e.strength !== marker.lastStrength) {
        marker.lastStrength = e.strength;
        drawBar(marker.barCtx, e.strength / SQUAD_POP);
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

    // Pass 2: the crowds as individuals. Each person springs toward their
    // formation slot, shoulders away from squadmates, and animates off their
    // own motion — stragglers lag, corners get cut, the group stays loose.
    // Figures are drawn stylized-large (min 1.9x life size) so they still
    // read as people at the closest allowed zoom.
    this.pools.begin(totalPeople, this.markers.size);
    const s = this.viewScale;
    const pScale = Math.max(1.9, s);
    const minSep = CROWD_SPREAD * s;
    const seekGain = Math.min(1, dt * 2.8);
    const sepGain = Math.min(1, dt * 4);
    for (const [id, marker] of this.markers) {
      const selected = this.selectedIds.has(id);
      const ppl = marker.people;
      const cos = Math.cos(marker.heading);
      const sin = Math.sin(marker.heading);
      // Reconcile head count; newcomers step straight into their slot.
      while (ppl.length < marker.pop) {
        const o = crowdOffset(ppl.length, marker.pop);
        const wx = marker.x + (o.y * cos - o.x * sin) * s;
        const wy = marker.y + (o.y * sin + o.x * cos) * s;
        ppl.push({ x: wx, y: wy, px: wx, py: wy, heading: marker.heading, phase: ppl.length * 1.7, amp: 0 });
      }
      if (ppl.length > marker.pop) ppl.length = marker.pop;

      // Seek formation slots.
      for (let i = 0; i < ppl.length; i++) {
        const p = ppl[i]!;
        const o = crowdOffset(i, ppl.length);
        const tx = marker.x + (o.y * cos - o.x * sin) * s;
        const ty = marker.y + (o.y * sin + o.x * cos) * s;
        p.x += (tx - p.x) * seekGain;
        p.y += (ty - p.y) * seekGain;
      }
      // Personal space: shoulder apart when closer than a stride.
      for (let i = 0; i < ppl.length; i++) {
        for (let j = i + 1; j < ppl.length; j++) {
          const a = ppl[i]!;
          const b = ppl[j]!;
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let d = Math.hypot(dx, dy);
          if (d >= minSep) continue;
          if (d < 1e-6) {
            dx = Math.cos(i * 2.4 + j);
            dy = Math.sin(i * 2.4 + j);
            d = 1;
          }
          const push = ((minSep - d) / 2) * sepGain;
          const ux = (dx / d) * push;
          const uy = (dy / d) * push;
          a.x -= ux;
          a.y -= uy;
          b.x += ux;
          b.y += uy;
        }
      }
      // Animate off each person's own motion and draw them.
      for (let i = 0; i < ppl.length; i++) {
        const p = ppl[i]!;
        const moved = Math.hypot(p.x - p.px, p.y - p.py);
        const speed = moved / dt / s; // person-relative pace
        if (moved > 0.02) {
          const want = Math.atan2(p.y - p.py, p.x - p.px);
          let dh = want - p.heading;
          while (dh > Math.PI) dh -= 2 * Math.PI;
          while (dh < -Math.PI) dh += 2 * Math.PI;
          p.heading += dh * Math.min(1, dt * 10);
        }
        p.amp += ((speed > 0.6 ? 1 : 0) - p.amp) * Math.min(1, dt * 6);
        p.phase += Math.min(speed, 11) * dt * 1.1;
        p.px = p.x;
        p.py = p.y;
        const swing = p.amp * 0.55 * Math.sin(p.phase);
        const ps = pScale * (i === 0 ? LEADER_SCALE : 1);
        this.pools.person(p.x, p.y, p.heading, swing, ps, marker.color);
        if (selected) this.pools.disc(p.x, p.y, ps);
      }
      const lead = ppl[0]!;
      this.pools.flag(lead.x, lead.y, lead.heading, pScale, marker.color);
    }
    this.pools.commit();

    // Pass 3: route ribbons and tracers (need everyone's fresh positions).
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
    // Selection is drawn as per-person ground discs during sync.
    this.selectedIds = new Set(ids.filter((id) => this.markers.get(id)?.own));
  }

  selected(): string[] {
    return [...this.selectedIds];
  }

  /** Facts about the selected squads, for the HUD roster (stable order). */
  selectedInfo(): SquadInfo[] {
    const out: SquadInfo[] = [];
    for (const [id, m] of this.markers) {
      if (this.selectedIds.has(id)) {
        out.push({ id, name: m.name, pop: m.pop, color: `#${m.color.getHexString()}` });
      }
    }
    return out;
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

    if (own) {
      // X-ray blob: drawn ONLY where the normal depth test fails — i.e.
      // exactly where the squad is hidden behind a building.
      const ghost = new THREE.Mesh(
        new THREE.CylinderGeometry(ENTITY_RADIUS, ENTITY_RADIUS, 1.8, 12),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.35,
          depthWrite: false,
          depthFunc: THREE.GreaterDepth,
        }),
      );
      ghost.position.y = 0.9;
      ghost.renderOrder = 10;
      root.add(ghost);
    }

    root.add(makeLabel(e.name));

    // Strength bar sprite, redrawn only when strength changes.
    const barCanvas = document.createElement("canvas");
    barCanvas.width = 64;
    barCanvas.height = 10;
    const barCtx = barCanvas.getContext("2d")!;
    drawBar(barCtx, e.strength / SQUAD_POP);
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
      name: e.name,
      color,
      pop: Math.max(1, Math.ceil(e.strength)),
      people: [],
      routeMesh,
      tracer,
      bar,
      barCtx,
      barTexture,
      lastStrength: e.strength,
      x: e.x,
      y: e.y,
      heading: Math.PI / 2, // face north until they move
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
  sprite.scale.set(20, 5, 1);
  sprite.position.y = ENTITY_RADIUS + 6;
  return sprite;
}
