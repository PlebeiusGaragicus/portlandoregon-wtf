import * as THREE from "three";
import { heightAt, type GameMap, type Heightfield, type StreetEdge } from "@battle-juice/shared";
import { toScene } from "./camera.js";
import { Dispatch } from "./dispatch.js";
import { radialGlowTexture } from "./props.js";

// Ambient emergency traffic: fire engines/trucks, police cars and ambulances
// running code 3 along the real street graph. Purely decorative and fully
// client-side — the sim never sees them. Vehicles spawn from their real
// facilities near the camera; fire apparatus stay inside their first-due
// area and periodically return to the station and disappear.

const MAX_FIRE = 9;
const MAX_POLICE = 30;
const MAX_AMBULANCE_DAY = 40;
const MAX_AMBULANCE_NIGHT = 20;
const MAX_CITYBUS = 12;
const MAX_SCHOOLBUS = 10; // only during school runs
const MAX_TANK = 5;
const CAP = MAX_FIRE + MAX_POLICE + MAX_AMBULANCE_DAY + MAX_CITYBUS + MAX_SCHOOLBUS + MAX_TANK;
const TRAILER_CAP = MAX_CITYBUS;

/** School buses run the morning pickup and afternoon drop-off windows. */
function schoolRun(hour: number): boolean {
  return (hour >= 7 && hour < 9.5) || (hour >= 14 && hour < 16.5);
}

const SPEED_MIN = 14; // m/s — code 3 through city streets
const SPEED_MAX = 21;
const FMA_RADIUS = 2200; // m — fire apparatus wander this far from home
const SPAWN_NEAR = 6000; // m — facilities eligible around the camera focus
const DESPAWN_FAR = 7500; // m — too far from focus: recycle the vehicle
const HOME_DONE = 130; // m — close enough to the station to "back in"
const FLASH_HZ = 4.2;
const ACCEL = 4; // m/s^2
const BRAKE = 9;
const TURN_EASE = 4.2; // body heading chase rate (1/s)
const AVOID_AHEAD = 20; // m — start giving way to a vehicle ahead
const CRASH_DIST = 3.1; // m — close enough to trade paint
const SCENE_RADIUS = 65; // m — near enough to the call to work it

interface VehicleKind {
  color: number;
  /** Code-3 lightbar + glow (emergency kinds only). */
  lights: boolean;
  /** Lightbar flash pair. */
  flashA: number;
  flashB: number;
  /** Body size: length, width, height (m). */
  size: [number, number, number];
  /** Articulated rear section (city bus) — hinged at the body's tail. */
  trailer?: [number, number, number];
  speedMin: number;
  speedMax: number;
}

const KINDS: Record<
  "engine" | "truck" | "police" | "ambulance" | "schoolbus" | "citybus" | "tank",
  VehicleKind
> = {
  engine: { color: 0xb92418, lights: true, flashA: 0xff2a1a, flashB: 0xffffff, size: [8.2, 2.5, 3.1], speedMin: 14, speedMax: 21 },
  truck: { color: 0xa81f14, lights: true, flashA: 0xff2a1a, flashB: 0xffffff, size: [11.5, 2.5, 3.3], speedMin: 14, speedMax: 21 },
  police: { color: 0x272b34, lights: true, flashA: 0x2f62ff, flashB: 0xff2a1a, size: [5.2, 2.0, 1.7], speedMin: 14, speedMax: 21 },
  ambulance: { color: 0xe4e6e9, lights: true, flashA: 0xff2a1a, flashB: 0xffffff, size: [6.6, 2.4, 2.6], speedMin: 14, speedMax: 21 },
  schoolbus: { color: 0xe8a91c, lights: false, flashA: 0, flashB: 0, size: [10.5, 2.5, 3.0], speedMin: 9, speedMax: 12 },
  citybus: { color: 0x2f8b46, lights: false, flashA: 0, flashB: 0, size: [9.0, 2.55, 3.1], trailer: [8.2, 2.55, 3.1], speedMin: 8, speedMax: 11 },
  tank: { color: 0x4b5320, lights: false, flashA: 0, flashB: 0, size: [7.6, 3.4, 2.5], speedMin: 5, speedMax: 9 },
};

interface Vehicle {
  kind: keyof typeof KINDS;
  /** Home facility (fire station / hospital), world meters. */
  home: { x: number; y: number } | null;
  mode: "roam" | "return" | "respond" | "onscene";
  /** Dispatch destination while responding. */
  goal: { x: number; y: number } | null;
  respondT: number;
  sceneT: number;
  /** Seconds until this roamer heads home (fire/ambulance). */
  patience: number;
  pts: [number, number][]; // oriented polyline of the current edge
  bridge: boolean;
  hA: number; // oriented endpoint terrain heights (bridge lerp)
  hB: number;
  edgeLen: number;
  traveled: number; // m along the edge
  seg: number;
  segT: number; // m into the current segment
  edgeId: number;
  endNode: number;
  speed: number;
  phase: number; // flash phase offset
  x: number;
  y: number;
  heading: number; // path direction (instant)
  rHeading: number; // rendered body heading (eased — no snapping at corners)
  curSpeed: number; // actual speed (eased toward cruise/brake targets)
  /** Transient crash shove, decays back to the lane. */
  ox: number;
  oy: number;
  /** Per-frame speed ceiling imposed by traffic ahead. */
  avoidCap: number;
  /** Articulated rear section's own heading — pivots at the hinge. */
  trailHeading: number;
  /** Off-shift (school bus after the bell): despawn once out of sight. */
  expire: boolean;
  /** Seconds until this tank fires its main gun again. */
  bombardT: number;
  glow: THREE.Sprite | null;
}

interface Facility {
  x: number;
  y: number;
  node: number;
}

export class Actors {
  group = new THREE.Group();

  /** Fire-sim hooks (wired by the renderer). Dispatch fire incidents ignite
   * a real building; tanks ask for a bombardment at their position. */
  onFireIncident: ((x: number, y: number) => void) | null = null;
  onTankFire: ((x: number, y: number) => void) | null = null;

  private adj = new Map<number, StreetEdge[]>();
  private nodePos = new Map<number, { x: number; y: number }>();
  private fireHomes: Facility[] = [];
  private ambHomes: Facility[] = [];
  private policeHomes: Facility[] = [];
  private schoolHomes: Facility[] = [];
  private dispatch: Dispatch;
  private vehicles: Vehicle[] = [];
  private respawnCooldown = 0;

  private body: THREE.InstancedMesh;
  private bar: THREE.InstancedMesh;
  private trailer: THREE.InstancedMesh;
  private glowTex = radialGlowTexture();
  private terrain: (x: number, y: number) => number;

  // Siren (FPV only): a two-tone wail whose volume tracks the nearest unit.
  private audio: AudioContext | null = null;
  private sirenGain: GainNode | null = null;
  private sirenOsc: OscillatorNode | null = null;
  private listener: { x: number; y: number } | null = null;

  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v3 = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);
  private color = new THREE.Color();

  constructor(private map: GameMap, hf: Heightfield | null) {
    this.terrain = hf ? (x, y) => heightAt(hf, x, y) : () => 0;

    // Drivable graph: real streets only, no paths/alleys/tunnels.
    for (const e of map.edges) {
      if (e.class === "path" || e.class === "alley" || e.struct === "tunnel") continue;
      let la = this.adj.get(e.a);
      if (!la) this.adj.set(e.a, (la = []));
      la.push(e);
      let lb = this.adj.get(e.b);
      if (!lb) this.adj.set(e.b, (lb = []));
      lb.push(e);
    }
    for (const n of map.nodes) if (this.adj.has(n.id)) this.nodePos.set(n.id, { x: n.x, y: n.y });

    const snap = (x: number, y: number): Facility => {
      let best = -1;
      let bd = Infinity;
      for (const [id, p] of this.nodePos) {
        const d = (p.x - x) ** 2 + (p.y - y) ** 2;
        if (d < bd) {
          bd = d;
          best = id;
        }
      }
      return { x, y, node: best };
    };
    for (const lm of map.landmarks ?? []) {
      if (lm.kind === "fire-station") this.fireHomes.push(snap(lm.x, lm.y));
      else if (lm.kind === "hospital") this.ambHomes.push(snap(lm.x, lm.y));
      else if (lm.kind === "police") this.policeHomes.push(snap(lm.x, lm.y));
      else if (lm.kind === "school") this.schoolHomes.push(snap(lm.x, lm.y));
    }
    this.dispatch = new Dispatch(
      (focus, range) => {
        const ids = [...this.nodePos.keys()];
        for (let tries = 0; tries < 40; tries++) {
          const p = this.nodePos.get(ids[Math.floor(Math.random() * ids.length)]!)!;
          if (Math.hypot(p.x - focus.x, p.y - focus.y) < range) {
            return { x: p.x, y: p.y, z: this.terrain(p.x, p.y) };
          }
        }
        return null;
      },
      (x, y) => this.onFireIncident?.(x, y),
    );
    this.group.add(this.dispatch.group);

    const bodyMat = new THREE.MeshLambertMaterial({ flatShading: true });
    this.body = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), bodyMat, CAP);
    this.body.castShadow = true;
    const barMat = new THREE.MeshBasicMaterial(); // unlit: lightbars burn through any hour
    this.bar = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), barMat, CAP);
    this.trailer = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), bodyMat, TRAILER_CAP);
    this.trailer.castShadow = true;
    // Instance matrices place vehicles all over the city, but three.js culls
    // an InstancedMesh by its raw geometry bounds (a 1 m box at the origin) —
    // never cull these, or the fleet only renders near the map's SW corner.
    this.body.frustumCulled = this.bar.frustumCulled = this.trailer.frustumCulled = false;
    this.body.count = this.bar.count = this.trailer.count = 0;
    this.group.add(this.body, this.bar, this.trailer);
  }

  /** Fire crews working a scene — the burn sim uses them as suppressors. */
  fireUnitsOnScene(): { x: number; y: number }[] {
    return this.vehicles
      .filter((v) => (v.kind === "engine" || v.kind === "truck") && v.mode === "onscene")
      .map((v) => ({ x: v.x, y: v.y }));
  }

  /** Report a real fire to dispatch (dedupes against open fire calls). */
  reportFire(x: number, y: number, z: number): void {
    this.dispatch.report(x, y, z);
  }

  /** FPV listener position for the siren (null = map view, siren muted). */
  setListener(pos: { x: number; y: number } | null): void {
    this.listener = pos;
    if (pos && !this.audio) this.initSiren();
  }

  update(dt: number, timeSec: number, focus: { x: number; y: number }, night = 0, hour = 12): void {
    this.spawn(focus, dt, night, hour);
    this.dispatch.update(dt, timeSec, focus, this.vehicles);

    for (const v of this.vehicles) v.patience -= dt;
    // Tanks near the camera bombard the neighborhood.
    for (const v of this.vehicles) {
      if (v.kind !== "tank") continue;
      v.bombardT -= dt;
      if (v.bombardT <= 0 && Math.hypot(v.x - focus.x, v.y - focus.y) < 2500) {
        v.bombardT = 11 + Math.random() * 17;
        this.onTankFire?.(v.x, v.y);
      }
    }
    this.interact(dt);
    this.vehicles = this.vehicles.filter((v) => this.advance(v, dt, focus));

    // Write instances (bars only for lighted kinds, trailers only for buses).
    let iBar = 0;
    let iTrail = 0;
    this.body.count = this.vehicles.length;
    this.vehicles.forEach((v, i) => {
      const k = KINDS[v.kind];
      const gz = this.groundAt(v);
      const [L, W, H] = k.size;
      const rx = v.x + v.ox;
      const ry = v.y + v.oy;
      // rHeading is the eased body yaw; a yaw of exactly that about scene-up
      // maps local +x (the box length) onto the travel dir.
      this.q.setFromAxisAngle(this.up, v.rHeading);
      this.m.compose(toScene(rx, ry, gz + 0.4 + H / 2), this.q, this.v3.set(L, H, W));
      this.body.setMatrixAt(i, this.m);
      this.body.setColorAt(i, this.color.setHex(k.color));

      if (k.trailer) {
        // Trailer pivots at the hinge on the tractor's tail and swings its
        // heading toward the tractor's as the bus moves (classic tow model).
        const [tl, tw, th] = k.trailer;
        let d = v.rHeading - v.trailHeading;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        v.trailHeading += d * Math.min(1, (Math.max(1, v.curSpeed) * dt) / (tl * 0.55));
        const hx = rx - Math.cos(v.rHeading) * (L / 2);
        const hy = ry - Math.sin(v.rHeading) * (L / 2);
        const tx = hx - Math.cos(v.trailHeading) * (tl / 2);
        const ty = hy - Math.sin(v.trailHeading) * (tl / 2);
        this.q.setFromAxisAngle(this.up, v.trailHeading);
        this.m.compose(toScene(tx, ty, gz + 0.4 + th / 2), this.q, this.v3.set(tl, th, tw));
        this.trailer.setMatrixAt(iTrail, this.m);
        this.trailer.setColorAt(iTrail, this.color.setHex(k.color));
        iTrail++;
      }

      if (k.lights) {
        const flash = Math.sin(timeSec * Math.PI * 2 * FLASH_HZ + v.phase) > 0;
        this.q.setFromAxisAngle(this.up, v.rHeading);
        this.m.compose(
          toScene(rx, ry, gz + 0.4 + H + 0.18),
          this.q,
          this.v3.set(Math.min(2.2, L * 0.3), 0.3, W * 0.75),
        );
        this.bar.setMatrixAt(iBar, this.m);
        this.bar.setColorAt(iBar, this.color.setHex(flash ? k.flashA : k.flashB));
        iBar++;
        if (v.glow) {
          const gm = v.glow.material as THREE.SpriteMaterial;
          gm.color.setHex(flash ? k.flashA : k.flashB);
          gm.opacity = 0.2 + 0.45 * night; // subtle by day, a beacon after dark
          v.glow.position.copy(toScene(rx, ry, gz + H + 2.5));
        }
      }
    });
    this.bar.count = iBar;
    this.trailer.count = iTrail;
    this.body.instanceMatrix.needsUpdate = true;
    this.bar.instanceMatrix.needsUpdate = true;
    this.trailer.instanceMatrix.needsUpdate = true;
    if (this.body.instanceColor) this.body.instanceColor.needsUpdate = true;
    if (this.bar.instanceColor) this.bar.instanceColor.needsUpdate = true;
    if (this.trailer.instanceColor) this.trailer.instanceColor.needsUpdate = true;

    this.updateSiren(timeSec);
  }

  private groundAt(v: Vehicle): number {
    const t = this.terrain(v.x, v.y);
    if (!v.bridge) return t;
    const s = v.edgeLen > 0 ? v.traveled / v.edgeLen : 0;
    return Math.max(t, v.hA + (v.hB - v.hA) * s);
  }

  // ---- population ----------------------------------------------------------

  private spawn(focus: { x: number; y: number }, dt: number, night: number, hour: number): void {
    // School's out: buses finish their block and vanish once out of sight.
    const inSession = schoolRun(hour);
    if (!inSession) {
      for (const v of this.vehicles) if (v.kind === "schoolbus") v.expire = true;
    }
    this.respawnCooldown -= dt;
    if (this.respawnCooldown > 0) return;
    const count = (k: (v: Vehicle) => boolean): number => this.vehicles.filter(k).length;
    const nFire = count((v) => v.kind === "engine" || v.kind === "truck");
    const nPol = count((v) => v.kind === "police");
    const nAmb = count((v) => v.kind === "ambulance");
    const nBus = count((v) => v.kind === "citybus");
    const nSchool = count((v) => v.kind === "schoolbus");
    const maxAmb = night > 0.5 ? MAX_AMBULANCE_NIGHT : MAX_AMBULANCE_DAY;
    const maxSchool = inSession ? MAX_SCHOOLBUS : 0;

    // Nightfall thins the ambulance fleet: extras head back to a hospital.
    if (nAmb > maxAmb) {
      let extra = nAmb - maxAmb;
      for (const v of this.vehicles) {
        if (extra <= 0) break;
        if (v.kind === "ambulance" && v.mode === "roam") {
          v.mode = "return";
          extra--;
        }
      }
    }

    const near = (fs: Facility[]): Facility[] =>
      fs.filter((f) => Math.hypot(f.x - focus.x, f.y - focus.y) < SPAWN_NEAR);

    let spawned = false;
    if (nFire < MAX_FIRE) {
      const homes = near(this.fireHomes);
      const h = homes[Math.floor(Math.random() * homes.length)];
      if (h) spawned = this.spawnAt(Math.random() < 0.7 ? "engine" : "truck", h);
    } else if (nPol < MAX_POLICE) {
      const homes = near(this.policeHomes);
      const h = homes.length
        ? homes[Math.floor(Math.random() * homes.length)]!
        : this.randomFacilityNear(focus);
      // Precinct cars are homed (they cycle back to the precinct); cars far
      // from any precinct patrol homeless and recycle by distance.
      if (h) spawned = this.spawnAt("police", h, homes.length === 0);
    } else if (nAmb < maxAmb) {
      const homes = near(this.ambHomes);
      const h = homes.length
        ? homes[Math.floor(Math.random() * homes.length)]!
        : this.randomFacilityNear(focus); // no hospital in range: post up anyway
      if (h) spawned = this.spawnAt("ambulance", h, !homes.length);
    } else if (nBus < MAX_CITYBUS) {
      const h = this.randomFacilityNear(focus);
      if (h) spawned = this.spawnAt("citybus", h, true);
    } else if (count((v) => v.kind === "tank") < MAX_TANK) {
      const h = this.randomFacilityNear(focus);
      if (h) spawned = this.spawnAt("tank", h, true);
    } else if (nSchool < maxSchool) {
      const homes = near(this.schoolHomes);
      const h = homes.length
        ? homes[Math.floor(Math.random() * homes.length)]!
        : this.randomFacilityNear(focus);
      if (h) spawned = this.spawnAt("schoolbus", h, homes.length === 0);
    }
    // Stagger arrivals — but fill a big deficit briskly after a view change.
    const deficit =
      MAX_FIRE - nFire + (MAX_POLICE - nPol) + (maxAmb - nAmb) + (MAX_CITYBUS - nBus) + (maxSchool - nSchool);
    this.respawnCooldown = spawned ? (deficit > 12 ? 0.25 : 0.9 + Math.random() * 2.5) : 1.5;
  }

  private randomFacilityNear(focus: { x: number; y: number }): Facility | null {
    // Any drivable node within 3km — police prowl even far from a precinct.
    const ids = [...this.nodePos.keys()];
    for (let tries = 0; tries < 40; tries++) {
      const id = ids[Math.floor(Math.random() * ids.length)]!;
      const p = this.nodePos.get(id)!;
      if (Math.hypot(p.x - focus.x, p.y - focus.y) < 3000) return { x: p.x, y: p.y, node: id };
    }
    return null;
  }

  private spawnAt(kind: keyof typeof KINDS, home: Facility, homeless = false): boolean {
    const edges = this.adj.get(home.node);
    if (!edges?.length) return false;
    const edge = edges[Math.floor(Math.random() * edges.length)]!;
    const k = KINDS[kind];
    let glow: THREE.Sprite | null = null;
    if (k.lights) {
      glow = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.glowTex,
          transparent: true,
          opacity: 0.5,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      glow.scale.set(11, 11, 1);
      this.group.add(glow);
    }
    const v: Vehicle = {
      kind,
      home: homeless ? null : { x: home.x, y: home.y },
      mode: "roam",
      patience: 70 + Math.random() * 140,
      pts: [],
      bridge: false,
      hA: 0,
      hB: 0,
      edgeLen: 0,
      traveled: 0,
      seg: 0,
      segT: 0,
      edgeId: -1,
      endNode: -1,
      speed: k.speedMin + Math.random() * (k.speedMax - k.speedMin),
      phase: Math.random() * Math.PI * 2,
      x: home.x,
      y: home.y,
      heading: 0,
      rHeading: 0,
      curSpeed: 0,
      ox: 0,
      oy: 0,
      avoidCap: Infinity,
      goal: null,
      respondT: 0,
      sceneT: 0,
      trailHeading: 0,
      expire: false,
      bombardT: 6 + Math.random() * 14,
      glow,
    };
    this.enterEdge(v, edge, home.node);
    v.rHeading = v.trailHeading = this.pathHeading(v);
    this.vehicles.push(v);
    return true;
  }

  private kill(v: Vehicle): void {
    if (v.glow) {
      v.glow.removeFromParent();
      (v.glow.material as THREE.SpriteMaterial).dispose();
    }
  }

  // ---- driving -------------------------------------------------------------

  private enterEdge(v: Vehicle, edge: StreetEdge, fromNode: number): void {
    const fwd = edge.a === fromNode;
    v.pts = fwd ? edge.polyline : [...edge.polyline].reverse();
    v.endNode = fwd ? edge.b : edge.a;
    v.edgeId = edge.id;
    v.bridge = edge.struct === "bridge";
    const p0 = v.pts[0]!;
    const pn = v.pts[v.pts.length - 1]!;
    v.hA = this.terrain(p0[0], p0[1]);
    v.hB = this.terrain(pn[0], pn[1]);
    let len = 0;
    for (let i = 1; i < v.pts.length; i++) {
      len += Math.hypot(v.pts[i]![0] - v.pts[i - 1]![0], v.pts[i]![1] - v.pts[i - 1]![1]);
    }
    v.edgeLen = len;
    v.traveled = 0;
    v.seg = 0;
    v.segT = 0;
  }

  /** Path heading at the vehicle's current segment. */
  private pathHeading(v: Vehicle): number {
    const a = v.pts[v.seg] ?? v.pts[v.pts.length - 2];
    const b = v.pts[v.seg + 1] ?? v.pts[v.pts.length - 1];
    if (!a || !b) return v.heading;
    return Math.atan2(b[1] - a[1], b[0] - a[0]);
  }

  /** Move the vehicle; false = despawn it. */
  private advance(v: Vehicle, dt: number, focus: { x: number; y: number }): boolean {
    const focusDist = Math.hypot(v.x - focus.x, v.y - focus.y);
    if (focusDist > DESPAWN_FAR || (v.expire && focusDist > 450)) {
      this.kill(v);
      return false;
    }
    if (v.home && v.mode === "roam" && v.patience <= 0) v.mode = "return";
    if (v.home && v.mode === "return" && Math.hypot(v.x - v.home.x, v.y - v.home.y) < HOME_DONE) {
      this.kill(v); // backed into the bay
      return false;
    }

    // Dispatch lifecycle.
    if (v.mode === "respond" && v.goal) {
      v.respondT -= dt;
      if (Math.hypot(v.x - v.goal.x, v.y - v.goal.y) < SCENE_RADIUS) {
        v.mode = "onscene";
        v.sceneT = 25 + Math.random() * 40;
      } else if (v.respondT <= 0) {
        v.mode = "roam"; // couldn't find the address — back on patrol
        v.goal = null;
      }
    } else if (v.mode === "onscene") {
      v.sceneT -= dt;
      if (v.sceneT <= 0) {
        v.goal = null;
        v.mode = v.home ? "return" : "roam";
        v.patience = 40 + Math.random() * 60;
      }
    }

    // Speed: cruise, braked for corners, dispatch stops and traffic ahead.
    let target = v.mode === "onscene" ? 0 : v.speed;
    const err = Math.abs(Math.atan2(Math.sin(v.heading - v.rHeading), Math.cos(v.heading - v.rHeading)));
    target = Math.min(target, v.speed * Math.max(0.22, 1 - err * 1.15));
    if (v.avoidCap < target) target = v.avoidCap;
    const delta = target - v.curSpeed;
    v.curSpeed += Math.max(-BRAKE * dt, Math.min(ACCEL * dt, delta));
    if (v.curSpeed < 0.02 && target === 0) v.curSpeed = 0;

    // Crash shove decays back to the lane.
    const decay = Math.exp(-dt * 2.1);
    v.ox *= decay;
    v.oy *= decay;

    let left = v.curSpeed * dt;
    while (left > 0) {
      const a = v.pts[v.seg];
      const b = v.pts[v.seg + 1];
      if (!a || !b) {
        if (!this.nextEdge(v)) return true; // boxed in: idle this frame
        continue;
      }
      const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]) || 0.001;
      const remain = segLen - v.segT;
      const step = Math.min(left, remain);
      v.segT += step;
      v.traveled += step;
      left -= step;
      const t = v.segT / segLen;
      v.x = a[0] + (b[0] - a[0]) * t;
      v.y = a[1] + (b[1] - a[1]) * t;
      v.heading = Math.atan2(b[1] - a[1], b[0] - a[0]); // world math angle
      if (v.segT >= segLen - 1e-6) {
        v.seg++;
        v.segT = 0;
      }
    }
    // Body yaw chases the path direction — corners are steered, not snapped.
    const dh = Math.atan2(Math.sin(v.heading - v.rHeading), Math.cos(v.heading - v.rHeading));
    v.rHeading += dh * Math.min(1, dt * TURN_EASE);
    return true;
  }

  /** Pairwise traffic sense: brake for a vehicle ahead; trade paint (and a
   * shove) when two actually meet. O(n^2) over ~100 units — negligible. */
  private interact(dt: number): void {
    for (const v of this.vehicles) v.avoidCap = Infinity;
    const vs = this.vehicles;
    for (let i = 0; i < vs.length; i++) {
      const a = vs[i]!;
      for (let j = i + 1; j < vs.length; j++) {
        const b = vs[j]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        if (d > AVOID_AHEAD) continue;
        // Give way to whoever is in front of your nose.
        const aAhead = (dx * Math.cos(a.rHeading) + dy * Math.sin(a.rHeading)) / (d || 1);
        const bAhead = (-dx * Math.cos(b.rHeading) - dy * Math.sin(b.rHeading)) / (d || 1);
        if (aAhead > 0.6) a.avoidCap = Math.min(a.avoidCap, Math.max(0, (d - 5) * 0.9));
        if (bAhead > 0.6) b.avoidCap = Math.min(b.avoidCap, Math.max(0, (d - 5) * 0.9));
        if (d < CRASH_DIST) {
          // Bump: both stop dead and get shoved apart, then recover.
          const nx = d > 0.01 ? dx / d : 1;
          const ny = d > 0.01 ? dy / d : 0;
          const push = (CRASH_DIST - d) * 0.55 + 0.4;
          a.ox -= nx * push;
          a.oy -= ny * push;
          b.ox += nx * push;
          b.oy += ny * push;
          a.curSpeed = Math.min(a.curSpeed, 0.5);
          b.curSpeed = Math.min(b.curSpeed, 0.5);
        }
      }
    }
  }

  private nextEdge(v: Vehicle): boolean {
    const node = v.endNode;
    const pos = this.nodePos.get(node);
    const options = this.adj.get(node);
    if (!pos || !options?.length) return false;
    const fresh = options.filter((e) => e.id !== v.edgeId);
    const cands = fresh.length ? fresh : options; // dead end: U-turn

    // Direction bias: returners steer home; fire apparatus that strayed past
    // the edge of their first-due area steer back toward it.
    let goal: { x: number; y: number } | null = null;
    if (v.mode === "respond" && v.goal) goal = v.goal;
    else if (v.home) {
      if (v.mode === "return") goal = v.home;
      else if (Math.hypot(pos.x - v.home.x, pos.y - v.home.y) > FMA_RADIUS) goal = v.home;
    }
    let total = 0;
    const weights = cands.map((e) => {
      let w = 1;
      if (v.kind === "citybus") {
        w = e.class === "arterial" ? 2.4 : e.class === "collector" ? 1.5 : 0.55;
      }
      if (goal) {
        const fwd = e.a === node;
        const next = e.polyline[fwd ? 1 : e.polyline.length - 2] ?? e.polyline[fwd ? 0 : e.polyline.length - 1]!;
        const dx = next[0] - pos.x;
        const dy = next[1] - pos.y;
        const dl = Math.hypot(dx, dy) || 1;
        const gx = goal.x - pos.x;
        const gy = goal.y - pos.y;
        const gl = Math.hypot(gx, gy) || 1;
        const dot = (dx * gx + dy * gy) / (dl * gl);
        w = Math.max(0.08, 1 + 2.6 * dot); // strong but not deterministic
      }
      total += w;
      return w;
    });
    let r = Math.random() * total;
    let pick = cands[cands.length - 1]!;
    for (let i = 0; i < cands.length; i++) {
      r -= weights[i]!;
      if (r <= 0) {
        pick = cands[i]!;
        break;
      }
    }
    this.enterEdge(v, pick, node);
    return true;
  }

  // ---- siren ---------------------------------------------------------------

  private initSiren(): void {
    try {
      this.audio = new AudioContext();
      const osc = this.audio.createOscillator();
      osc.type = "triangle";
      const gain = this.audio.createGain();
      gain.gain.value = 0;
      osc.connect(gain).connect(this.audio.destination);
      osc.start();
      this.sirenOsc = osc;
      this.sirenGain = gain;
    } catch {
      this.audio = null;
    }
  }

  private updateSiren(timeSec: number): void {
    if (!this.audio || !this.sirenGain || !this.sirenOsc) return;
    let target = 0;
    if (this.listener) {
      if (this.audio.state === "suspended") void this.audio.resume();
      let nearest = Infinity;
      for (const v of this.vehicles) {
        if (!KINDS[v.kind].lights) continue; // buses don't wail
        nearest = Math.min(nearest, Math.hypot(v.x - this.listener.x, v.y - this.listener.y));
      }
      if (Number.isFinite(nearest)) target = 0.1 * Math.max(0, 1 - nearest / 900) ** 1.6;
      // Classic wail: sweep between the two tones.
      const wail = 850 + 420 * Math.sin(timeSec * 2 * Math.PI * 0.45);
      this.sirenOsc.frequency.setTargetAtTime(wail, this.audio.currentTime, 0.05);
    }
    this.sirenGain.gain.setTargetAtTime(target, this.audio.currentTime, 0.25);
  }

  dispose(): void {
    this.dispatch.dispose();
    for (const v of this.vehicles) this.kill(v);
    this.vehicles = [];
    if (this.sirenOsc) this.sirenOsc.stop();
    if (this.audio) void this.audio.close();
  }
}
