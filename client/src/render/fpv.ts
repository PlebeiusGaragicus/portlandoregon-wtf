import * as THREE from "three";
import { heightAt, type GameMap, type Heightfield } from "@battle-juice/shared";
import type { CityModel } from "../city.js";
import { toScene } from "./camera.js";

// First-person walk/fly mode. Physics runs in world meters (x east, y north,
// z up); the camera is derived each frame. Buildings are solid: walls block
// horizontal motion below the roofline, rooftops are walkable.

const EYE = 1.65; // eye height above the feet
const WALK = 7;
const SPRINT = 18;
const FLY = 45;
const FLY_SPRINT = 140;
const FLY_VERT = 22;
const GRAVITY = -26;
const MAX_FALL = 110; // terminal velocity — sky-drop entries stay snappy but landable
const JUMP = 9.5;
const ACCEL = 14; // horizontal velocity easing, higher = snappier
const STEP = 0.9; // max ledge height feet can pop over / stand across
const BODY_R = 0.55; // keep-out from walls so the near plane never clips inside
const DOUBLE_TAP_MS = 300;
const MAX_PITCH = Math.PI / 2 - 0.05;
const SENS = 0.0024; // radians per pixel of mouse travel

const CELL = 100; // meters — collision grid bucket

interface Solid {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
  /** Footprint edges as [x1, y1, x2, y2, ...]. */
  segs: number[];
  /** Absolute roof height (matches the rendered prism top). */
  top: number;
}

/** Uniform-grid index of building prisms for FPV collision + roof support. */
class SolidIndex {
  private solids: Solid[] = [];
  private grid = new Map<number, number[]>();
  /** Collapsed buildings (by map.buildings index == solid index): the ash
   * heap is scenery, not structure — you walk straight through it. */
  readonly dead = new Set<number>();
  private cols: number;
  private rows: number;

  constructor(map: GameMap, city: CityModel) {
    this.cols = Math.max(1, Math.ceil(map.meta.width / CELL));
    this.rows = Math.max(1, Math.ceil(map.meta.height / CELL));
    // Solid index == map.buildings index (see `dead`), which is also the city
    // model's index — every building gets an entry, degenerate or not.
    for (let bi = 0; bi < map.buildings.length; bi++) {
      const b = map.buildings[bi]!;
      let xmin = Infinity;
      let ymin = Infinity;
      let xmax = -Infinity;
      let ymax = -Infinity;
      const segs: number[] = [];
      const ring = b.footprint;
      for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = ring[i]!;
        const [x2, y2] = ring[(i + 1) % ring.length]!;
        segs.push(x1, y1, x2, y2);
        xmin = Math.min(xmin, x1);
        ymin = Math.min(ymin, y1);
        xmax = Math.max(xmax, x1);
        ymax = Math.max(ymax, y1);
      }
      // The city model sinks the prism base 1 m (so uphill walls show no gap);
      // the roof you can stand on is the visible top, so add it back.
      this.solids.push({ xmin, ymin, xmax, ymax, segs, top: city.baseZ[bi]! + 1 + b.height });
      const c0 = this.clampC(Math.floor(xmin / CELL));
      const c1 = this.clampC(Math.floor(xmax / CELL));
      const r0 = this.clampR(Math.floor(ymin / CELL));
      const r1 = this.clampR(Math.floor(ymax / CELL));
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const key = r * this.cols + c;
          const list = this.grid.get(key);
          if (list) list.push(bi);
          else this.grid.set(key, [bi]);
        }
      }
    }
  }

  private clampC(c: number): number {
    return Math.max(0, Math.min(this.cols - 1, c));
  }
  private clampR(r: number): number {
    return Math.max(0, Math.min(this.rows - 1, r));
  }

  private each(xmin: number, ymin: number, xmax: number, ymax: number, fn: (s: Solid) => void): void {
    const c0 = this.clampC(Math.floor(xmin / CELL));
    const c1 = this.clampC(Math.floor(xmax / CELL));
    const r0 = this.clampR(Math.floor(ymin / CELL));
    const r1 = this.clampR(Math.floor(ymax / CELL));
    const seen = new Set<number>();
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cell = this.grid.get(r * this.cols + c);
        if (!cell) continue;
        for (const idx of cell) {
          if (seen.has(idx) || this.dead.has(idx)) continue;
          seen.add(idx);
          const s = this.solids[idx]!;
          if (s.xmax < xmin || s.xmin > xmax || s.ymax < ymin || s.ymin > ymax) continue;
          fn(s);
        }
      }
    }
  }

  /** Would walking a->b at foot height z hit a wall? Roofs at/below the feet
   * don't count — you can stand on them and step off their edges. */
  blocked(ax: number, ay: number, bx: number, by: number, z: number): boolean {
    let hit = false;
    this.each(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by), (s) => {
      if (hit || z >= s.top - STEP) return;
      const e = s.segs;
      for (let i = 0; i < e.length; i += 4) {
        if (segsIntersect(ax, ay, bx, by, e[i]!, e[i + 1]!, e[i + 2]!, e[i + 3]!)) {
          hit = true;
          return;
        }
      }
    });
    return hit;
  }

  /** Highest walkable surface under feet at (x, y): terrain, or a roof the
   * feet are already at/above (falling onto or standing on it). */
  support(x: number, y: number, z: number, terrain: number): number {
    let sup = terrain;
    this.each(x, y, x, y, (s) => {
      if (s.top > sup && z >= s.top - STEP && pointInside(x, y, s.segs)) sup = s.top;
    });
    return sup;
  }

  /** Push a point out of any wall closer than r (the camera's personal
   * space). Two passes handle corners where the first push lands you near a
   * second wall. Returns the corrected position. */
  pushOut(x: number, y: number, z: number, r: number): { x: number; y: number } {
    for (let pass = 0; pass < 2; pass++) {
      let moved = false;
      this.each(x - r, y - r, x + r, y + r, (s) => {
        if (z >= s.top - STEP) return;
        const e = s.segs;
        for (let i = 0; i < e.length; i += 4) {
          const ax = e[i]!;
          const ay = e[i + 1]!;
          const bx = e[i + 2]!;
          const by = e[i + 3]!;
          const dx = bx - ax;
          const dy = by - ay;
          const len2 = dx * dx + dy * dy || 1e-9;
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
          const cx = ax + dx * t;
          const cy = ay + dy * t;
          let nx = x - cx;
          let ny = y - cy;
          const d = Math.hypot(nx, ny);
          if (d >= r) continue;
          if (d < 1e-6) {
            // Standing exactly on the wall line: shove along its outward
            // normal (outer rings are CCW, so (dy, -dx) points outside).
            const nl = Math.hypot(dx, dy) || 1;
            nx = dy / nl;
            ny = -dx / nl;
          } else {
            nx /= d;
            ny /= d;
          }
          x += nx * (r - d);
          y += ny * (r - d);
          moved = true;
        }
      });
      if (!moved) break;
    }
    return { x, y };
  }

  /** Is (x, y) inside a prism that rises above foot height z? */
  inside(x: number, y: number, z: number): boolean {
    let hit = false;
    this.each(x, y, x, y, (s) => {
      if (!hit && z < s.top - STEP && pointInside(x, y, s.segs)) hit = true;
    });
    return hit;
  }
}

function segsIntersect(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): boolean {
  const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  if (d1 > 0 === d2 > 0) return false;
  const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  return d3 > 0 !== d4 > 0;
}

function pointInside(px: number, py: number, segs: number[]): boolean {
  let inside = false;
  for (let i = 0; i < segs.length; i += 4) {
    const y1 = segs[i + 1]!;
    const y2 = segs[i + 3]!;
    if (y1 > py === y2 > py) continue;
    const x1 = segs[i]!;
    const x2 = segs[i + 2]!;
    if (px < x1 + ((py - y1) / (y2 - y1)) * (x2 - x1)) inside = !inside;
  }
  return inside;
}

export class FpvMode {
  x: number;
  y: number;
  z: number; // feet
  yaw: number; // matches CameraRig.theta convention: 0 = facing north
  pitch = -0.06;
  flying = false;

  private vx = 0;
  private vy = 0;
  private vz = 0;
  private dropping = false; // sky-drop entry in progress (auto-levels the view near touchdown)
  private grounded = false;
  private lastSpaceAt = -Infinity;
  private keys = new Set<string>();
  private solids: SolidIndex;
  private terrain: (x: number, y: number) => number;
  private mapW: number;
  private mapH: number;

  constructor(
    map: GameMap,
    hf: Heightfield | null,
    city: CityModel,
    start: { x: number; y: number },
    yaw: number,
    dropHeight = 0,
  ) {
    this.terrain = hf ? (x, y) => heightAt(hf, x, y) : () => 0;
    this.solids = new SolidIndex(map, city);
    this.mapW = map.meta.width;
    this.mapH = map.meta.height;
    this.x = start.x;
    this.y = start.y;
    this.z = 0;
    this.yaw = yaw;
    this.place(start.x, start.y, dropHeight);
  }

  /** Fire sim hook: a collapsed building stops being solid. */
  markCollapsed(bi: number): void {
    this.solids.dead.add(bi);
  }

  /** Put the player at (x, y) — nudged out along a golden-angle spiral if that
   * point is inside a building (walls would trap them). With `dropHeight` the
   * player enters skydiving: that far above the ground, looking down. */
  place(x: number, y: number, dropHeight = 0): void {
    this.dropping = dropHeight > 0;
    if (this.dropping) {
      // Skydive entry: keep the exact spot (dropping onto a roof is a
      // feature) and start the fall above whatever stands there.
      this.pitch = -0.95;
      this.x = Math.min(this.mapW, Math.max(0, x));
      this.y = Math.min(this.mapH, Math.max(0, y));
      const top = this.solids.support(this.x, this.y, Infinity, this.terrain(this.x, this.y));
      this.z = top + dropHeight;
      this.vx = this.vy = this.vz = 0;
      this.flying = false;
      return;
    }
    for (let i = 0; i < 120; i++) {
      const r = 1.9 * Math.sqrt(i);
      const a = i * 2.39996;
      const px = Math.min(this.mapW, Math.max(0, x + r * Math.cos(a)));
      const py = Math.min(this.mapH, Math.max(0, y + r * Math.sin(a)));
      const gz = this.terrain(px, py);
      if (!this.solids.inside(px, py, gz)) {
        this.x = px;
        this.y = py;
        this.z = gz + dropHeight;
        this.vx = this.vy = this.vz = 0;
        this.flying = false;
        return;
      }
    }
    // Deep inside a superblock: land on whatever the roof is instead.
    this.x = x;
    this.y = y;
    this.z = this.solids.support(x, y, Infinity, this.terrain(x, y)) + dropHeight;
    this.vx = this.vy = this.vz = 0;
    this.flying = false;
  }

  look(dxPx: number, dyPx: number): void {
    this.yaw -= dxPx * SENS;
    this.pitch = Math.min(MAX_PITCH, Math.max(-MAX_PITCH, this.pitch - dyPx * SENS));
  }

  keyDown(key: string): void {
    if (key === " ") {
      const now = performance.now();
      if (now - this.lastSpaceAt < DOUBLE_TAP_MS) {
        this.flying = !this.flying;
        this.dropping = false; // catching yourself mid-skydive
        this.vz = 0;
        this.lastSpaceAt = -Infinity; // a triple tap shouldn't re-toggle
      } else {
        this.lastSpaceAt = now;
        if (!this.flying && this.grounded) this.vz = JUMP;
      }
    }
    this.keys.add(key);
  }

  keyUp(key: string): void {
    this.keys.delete(key);
  }

  releaseKeys(): void {
    this.keys.clear();
  }

  update(dt: number): void {
    const sprint = this.keys.has("shift");
    const speed = this.flying ? (sprint ? FLY_SPRINT : FLY) : sprint ? SPRINT : WALK;

    // Horizontal intent in the yaw frame.
    let f = 0;
    let r = 0;
    if (this.keys.has("w") || this.keys.has("arrowup")) f += 1;
    if (this.keys.has("s") || this.keys.has("arrowdown")) f -= 1;
    if (this.keys.has("d") || this.keys.has("arrowright")) r += 1;
    if (this.keys.has("a") || this.keys.has("arrowleft")) r -= 1;
    const mag = Math.hypot(f, r) || 1;
    const fx = -Math.sin(this.yaw);
    const fy = Math.cos(this.yaw);
    const wantX = ((f * fx + r * fy) / mag) * speed;
    const wantY = ((f * fy - r * fx) / mag) * speed;
    const ease = Math.min(1, ACCEL * dt);
    this.vx += (wantX - this.vx) * ease;
    this.vy += (wantY - this.vy) * ease;

    // Horizontal move with wall sliding: full step, then axis-separated.
    const nx = Math.min(this.mapW, Math.max(0, this.x + this.vx * dt));
    const ny = Math.min(this.mapH, Math.max(0, this.y + this.vy * dt));
    if (!this.solids.blocked(this.x, this.y, nx, ny, this.z)) {
      this.x = nx;
      this.y = ny;
    } else if (!this.solids.blocked(this.x, this.y, nx, this.y, this.z)) {
      this.x = nx;
    } else if (!this.solids.blocked(this.x, this.y, this.x, ny, this.z)) {
      this.y = ny;
    }
    // Personal space: never stand so close to a wall that the camera's near
    // plane pokes through it and shows the hollow interior.
    const clear = this.solids.pushOut(this.x, this.y, this.z, BODY_R);
    this.x = clear.x;
    this.y = clear.y;

    // Vertical. Roof eligibility uses the PRE-fall height: a fast fall can
    // cross a whole roof-catch window in one frame, and testing only the
    // post-fall z would tunnel straight through the slab.
    const z0 = this.z;
    if (this.flying) {
      const vert = this.keys.has(" ") ? 1 : this.keys.has("c") ? -1 : 0;
      this.vz = vert * FLY_VERT * (sprint ? 3 : 1);
      this.z += this.vz * dt;
    } else {
      this.vz = Math.max(-MAX_FALL, this.vz + GRAVITY * dt);
      this.z += this.vz * dt;
    }
    const sup = this.solids.support(this.x, this.y, Math.max(z0, this.z), this.terrain(this.x, this.y));
    if (this.z <= sup && (!this.flying || this.vz < 0)) {
      // Flying upward passes freely through a roof plane; everything else
      // lands, and descending onto a surface folds the wings.
      this.z = sup;
      if (this.vz < 0) {
        if (this.flying) this.flying = false;
        this.vz = 0;
      }
      this.grounded = true;
      this.dropping = false;
    } else {
      this.grounded = this.z - sup < 0.05 && this.z <= sup + 0.05;
    }
    // Sky-drop entry: raise the gaze from the rushing ground to the street
    // ahead as touchdown nears (the player's mouse still steers freely).
    if (this.dropping && this.z - sup < 150) {
      this.pitch += (-0.06 - this.pitch) * Math.min(1, dt * 3.5);
    }
  }

  apply(cam: THREE.PerspectiveCamera, aspect: number, far = 30000): void {
    const eye = toScene(this.x, this.y, this.z + EYE);
    cam.position.copy(eye);
    const cp = Math.cos(this.pitch);
    cam.up.set(0, 1, 0);
    cam.lookAt(
      eye.x + -Math.sin(this.yaw) * cp,
      eye.y + Math.sin(this.pitch),
      eye.z + -Math.cos(this.yaw) * cp,
    );
    cam.fov = 70;
    cam.aspect = aspect;
    cam.near = 0.3;
    cam.far = far;
    cam.updateProjectionMatrix();
  }
}
