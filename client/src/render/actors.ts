import * as THREE from "three";
import { heightAt, type GameMap, type Heightfield, type StreetStore } from "@battle-juice/shared";
import { toScene } from "./camera.js";
import { streetsFrom, type StreetAccess } from "../streets.js";
import { Dispatch } from "./dispatch.js";
import { radialGlowTexture } from "./props.js";

// Ambient emergency traffic: fire engines/trucks, police cars and ambulances
// running code 3 along the real street graph. Purely decorative and fully
// client-side — the sim never sees them. Vehicles spawn from their real
// facilities near the camera. Fire apparatus are different: every mapped
// station owns a persistent engine + truck roster, hidden in their bays until
// dispatch and returned to the same bay when the call closes.

const MAX_POLICE = 30;
const MAX_AMBULANCE_DAY = 40;
const MAX_AMBULANCE_NIGHT = 20;
const MAX_CITYBUS = 12;
const MAX_SCHOOLBUS = 10; // only during school runs
const MAX_TANK = 5;
const NON_FIRE_CAP = MAX_POLICE + MAX_AMBULANCE_DAY + MAX_CITYBUS + MAX_SCHOOLBUS + MAX_TANK;
const TRAILER_CAP = MAX_CITYBUS;

/** Monotonic vehicle identity (stable across the vehicles array mutating). */
let nextUid = 1;

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
  home: Facility | null;
  mode: "available" | "roam" | "return" | "return-bay" | "respond" | "onscene";
  /** Dispatch destination while responding. */
  goal: { x: number; y: number } | null;
  respondT: number;
  fireScanT: number;
  /** Stable identity for cross-system hooks (hose crews). */
  uid: number;
  /** Owning fire-station roster slot; null for all ambient vehicles. */
  stationId: number | null;
  stationSlot: 0 | 1 | null;
  /** Trucks queue behind their station's engine instead of spawning overlapped. */
  departDelay: number;
  /** Dispatch reservation; prevents simultaneous calls double-booking. */
  incidentId: number | null;
  /** Planned street-edge route for response/return travel. */
  routeEdges: number[];
  routeGoalNode: number;
  routeMode: "respond" | "return" | null;
  routeGoalX: number;
  routeGoalY: number;
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
  id: number;
  x: number;
  y: number;
  node: number;
}

export interface FireRosterSpec<T> {
  station: T;
  stationId: number;
  stationSlot: 0 | 1;
  kind: "engine" | "truck";
}

/** Deterministic two-piece company assignment for every mapped station. */
export function buildFireRoster<T extends { id: number }>(stations: readonly T[]): FireRosterSpec<T>[] {
  return stations.flatMap((station) => [
    { station, stationId: station.id, stationSlot: 0 as const, kind: "engine" as const },
    { station, stationId: station.id, stationSlot: 1 as const, kind: "truck" as const },
  ]);
}

export interface FireApparatusSnapshot {
  uid: number;
  stationId: number;
  stationSlot: 0 | 1;
  kind: "engine" | "truck";
  mode: Vehicle["mode"];
  incidentId: number | null;
  x: number;
  y: number;
}

export class Actors {
  group = new THREE.Group();

  /** Fire-sim hooks (wired by the renderer). Dispatch fire incidents ignite
   * a real building; tanks ask for a bombardment at their position. */
  onFireIncident: ((x: number, y: number) => void) | null = null;
  onTankFire: ((x: number, y: number) => void) | null = null;

  private adj = new Map<number, number[]>();
  private nodePos = new Map<number, { x: number; y: number }>();
  private edgeLengths: number[] = [];
  private routeCache = new Map<string, number[]>();
  private goalNodeCache = new Map<string, number>();
  private streets: StreetAccess;
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

  constructor(private map: GameMap, hf: Heightfield | null, streetStore?: StreetStore) {
    this.terrain = hf ? (x, y) => heightAt(hf, x, y) : () => 0;
    this.streets = streetsFrom(map, streetStore);

    // Drivable graph: real streets only, no paths/alleys/tunnels.
    for (let i = 0; i < this.streets.edgeCount; i++) {
      const e = this.streets.edge(i);
      if (e.class === "path" || e.class === "alley" || e.struct === "tunnel") continue;
      let edgeLength = 0;
      for (let point = 1; point < e.polyline.length; point++) {
        edgeLength += Math.hypot(
          e.polyline[point]![0] - e.polyline[point - 1]![0],
          e.polyline[point]![1] - e.polyline[point - 1]![1],
        );
      }
      this.edgeLengths[i] = edgeLength;
      let la = this.adj.get(e.a);
      if (!la) this.adj.set(e.a, (la = []));
      la.push(i);
      let lb = this.adj.get(e.b);
      if (!lb) this.adj.set(e.b, (lb = []));
      lb.push(i);
    }
    for (let i = 0; i < this.streets.nodeCount; i++) {
      const n = this.streets.node(i);
      if (this.adj.has(n.id)) this.nodePos.set(n.id, { x: n.x, y: n.y });
    }

    const snap = (id: number, x: number, y: number): Facility => {
      let best = -1;
      let bd = Infinity;
      for (const [id, p] of this.nodePos) {
        const d = (p.x - x) ** 2 + (p.y - y) ** 2;
        if (d < bd) {
          bd = d;
          best = id;
        }
      }
      return { id, x, y, node: best };
    };
    for (const lm of map.landmarks ?? []) {
      if (lm.kind === "fire-station") this.fireHomes.push(snap(lm.id, lm.x, lm.y));
      else if (lm.kind === "hospital") this.ambHomes.push(snap(lm.id, lm.x, lm.y));
      else if (lm.kind === "police") this.policeHomes.push(snap(lm.id, lm.x, lm.y));
      else if (lm.kind === "school") this.schoolHomes.push(snap(lm.id, lm.x, lm.y));
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
    const vehicleCapacity = this.fireHomes.length * 2 + NON_FIRE_CAP;
    this.body = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), bodyMat, vehicleCapacity);
    this.body.castShadow = true;
    const barMat = new THREE.MeshBasicMaterial(); // unlit: lightbars burn through any hour
    this.bar = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), barMat, vehicleCapacity);
    this.trailer = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), bodyMat, TRAILER_CAP);
    this.trailer.castShadow = true;
    // Instance matrices place vehicles all over the city, but three.js culls
    // an InstancedMesh by its raw geometry bounds (a 1 m box at the origin) —
    // never cull these, or the fleet only renders near the map's SW corner.
    this.body.frustumCulled = this.bar.frustumCulled = this.trailer.frustumCulled = false;
    this.body.count = this.bar.count = this.trailer.count = 0;
    this.group.add(this.body, this.bar, this.trailer);

    // Every station starts staffed, independent of camera position. Available
    // rigs remain hidden logical records until Dispatch changes their mode.
    for (const spec of buildFireRoster(this.fireHomes)) {
      if (!this.spawnAt(spec.kind, spec.station, false, "available", spec.stationId, spec.stationSlot)) {
        throw new Error(`Fire station ${spec.stationId} has no drivable road connection`);
      }
    }
  }

  /** Fire crews working a scene — the burn sim uses them as suppressors. */
  fireUnitsOnScene(): { id: number; x: number; y: number }[] {
    return this.vehicles
      .filter((v) => (v.kind === "engine" || v.kind === "truck") && v.mode === "onscene")
      .map((v) => ({ id: v.uid, x: v.x, y: v.y }));
  }

  /** Read-only roster state for regression tests and browser diagnostics. */
  fireApparatusSnapshot(): FireApparatusSnapshot[] {
    return this.vehicles
      .filter((v): v is Vehicle & { kind: "engine" | "truck"; stationId: number; stationSlot: 0 | 1 } =>
        (v.kind === "engine" || v.kind === "truck") && v.stationId !== null && v.stationSlot !== null)
      .map((v) => ({
        uid: v.uid,
        stationId: v.stationId,
        stationSlot: v.stationSlot,
        kind: v.kind,
        mode: v.mode,
        incidentId: v.incidentId,
        x: v.x,
        y: v.y,
      }));
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

  /** Burn-sim probe (renderer wires it): active fire near (x, y)? Keeps
   * crews and fire calls on scene until the fire is actually out. */
  hasFireNear: ((x: number, y: number, r: number) => boolean) | null = null;

  update(dt: number, timeSec: number, focus: { x: number; y: number }, night = 0, hour = 12): void {
    this.spawn(focus, dt, night, hour);
    this.dispatch.hasFireNear = this.hasFireNear;
    this.dispatch.update(dt, timeSec, focus, this.vehicles);

    for (const v of this.vehicles) if (v.mode === "roam") v.patience -= dt;
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
    const visible = this.vehicles.filter((v) => v.mode !== "available");
    let iBar = 0;
    let iTrail = 0;
    this.body.count = visible.length;
    visible.forEach((v, i) => {
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
          v.glow.visible = true;
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
    if (nPol < MAX_POLICE) {
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
      (MAX_POLICE - nPol) + (maxAmb - nAmb) + (MAX_CITYBUS - nBus) + (maxSchool - nSchool);
    this.respawnCooldown = spawned ? (deficit > 12 ? 0.25 : 0.9 + Math.random() * 2.5) : 1.5;
  }

  private randomFacilityNear(focus: { x: number; y: number }): Facility | null {
    // Any drivable node within 3km — police prowl even far from a precinct.
    const ids = [...this.nodePos.keys()];
    for (let tries = 0; tries < 40; tries++) {
      const id = ids[Math.floor(Math.random() * ids.length)]!;
      const p = this.nodePos.get(id)!;
      if (Math.hypot(p.x - focus.x, p.y - focus.y) < 3000) return { id: -1, x: p.x, y: p.y, node: id };
    }
    return null;
  }

  private spawnAt(
    kind: keyof typeof KINDS,
    home: Facility,
    homeless = false,
    mode: Vehicle["mode"] = "roam",
    stationId: number | null = null,
    stationSlot: 0 | 1 | null = null,
  ): boolean {
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
      home: homeless ? null : home,
      mode,
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
      fireScanT: 0,
      uid: nextUid++,
      stationId,
      stationSlot,
      departDelay: stationSlot === 1 ? 2.5 : 0,
      incidentId: null,
      routeEdges: [],
      routeGoalNode: -1,
      routeMode: null,
      routeGoalX: NaN,
      routeGoalY: NaN,
      sceneT: 0,
      trailHeading: 0,
      expire: false,
      bombardT: 6 + Math.random() * 14,
      glow,
    };
    if (mode === "available") {
      this.enterStationConnector(v, false);
      if (v.glow) v.glow.visible = false;
    } else {
      this.enterEdge(v, edge, home.node);
    }
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

  /** Bay landmark <-> snapped street-node connector. It is deliberately a
   * real path segment so dispatch never teleports a rig tens of metres from
   * the station pin onto the road network. */
  private enterStationConnector(v: Vehicle, inbound: boolean): void {
    const home = v.home;
    if (!home) return;
    const node = this.nodePos.get(home.node);
    if (!node) return;
    const start: [number, number] = inbound ? [node.x, node.y] : [home.x, home.y];
    const end: [number, number] = inbound ? [home.x, home.y] : [node.x, node.y];
    v.pts = [start, end];
    v.bridge = false;
    v.hA = this.terrain(start[0], start[1]);
    v.hB = this.terrain(end[0], end[1]);
    v.edgeLen = Math.hypot(end[0] - start[0], end[1] - start[1]);
    v.traveled = 0;
    v.seg = 0;
    v.segT = 0;
    v.edgeId = inbound ? -3 : -2;
    v.endNode = inbound ? -1 : home.node;
    v.x = start[0];
    v.y = start[1];
    v.heading = Math.atan2(end[1] - start[1], end[0] - start[0]);
    v.rHeading = v.trailHeading = v.heading;
    if (inbound) v.mode = "return-bay";
  }

  private parkAtStation(v: Vehicle): void {
    v.mode = "available";
    v.goal = null;
    v.incidentId = null;
    v.routeEdges = [];
    v.routeGoalNode = -1;
    v.routeMode = null;
    v.curSpeed = 0;
    v.departDelay = v.stationSlot === 1 ? 2.5 : 0;
    v.ox = 0;
    v.oy = 0;
    if (v.glow) v.glow.visible = false;
    // Pre-stage the outbound connector. Dispatch only has to reserve the
    // apparatus and switch it to respond for it to pull out immediately.
    this.enterStationConnector(v, false);
  }

  private enterEdge(v: Vehicle, edgeIndex: number, fromNode: number): void {
    const edge = this.streets.edge(edgeIndex);
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
    if (v.mode === "available") return true;
    const focusDist = Math.hypot(v.x - focus.x, v.y - focus.y);
    if ((v.stationId === null && focusDist > DESPAWN_FAR) || (v.expire && focusDist > 450)) {
      this.kill(v);
      return false;
    }
    if (v.stationId === null && v.home && v.mode === "roam" && v.patience <= 0) v.mode = "return";
    if (v.stationId === null && v.home && v.mode === "return" && Math.hypot(v.x - v.home.x, v.y - v.home.y) < HOME_DONE) {
      this.kill(v); // backed into the bay
      return false;
    }

    // Dispatch lifecycle.
    const fireUnit = v.kind === "engine" || v.kind === "truck";
    this.ensureGoalRoute(v);
    if (v.mode === "respond" && v.goal) {
      v.respondT -= dt;
      if (Math.hypot(v.x - v.goal.x, v.y - v.goal.y) < SCENE_RADIUS) {
        v.mode = "onscene";
        v.sceneT = 25 + Math.random() * 40;
      } else if (v.respondT <= 0) {
        // Station apparatus release through Dispatch, which restores the
        // missing alarm slot and sends this rig home. Ambient units resume.
        v.mode = fireUnit && v.stationId !== null ? "return" : "roam";
        v.goal = v.home ? { x: v.home.x, y: v.home.y } : null;
      }
    } else if (v.mode === "onscene") {
      v.sceneT -= dt;
      if (v.sceneT <= 0) {
        if (fireUnit && v.incidentId !== null) {
          // Dispatch owns the assignment and closes it when the real fire is
          // out; do not freeload onto another incident.
          v.sceneT = 2;
        } else {
          v.goal = v.home ? { x: v.home.x, y: v.home.y } : null;
          v.mode = v.home ? "return" : "roam";
          v.patience = 40 + Math.random() * 60;
        }
      }
    }

    if (v.mode === "respond" && v.edgeId === -2 && v.departDelay > 0) {
      v.departDelay = Math.max(0, v.departDelay - dt);
      v.curSpeed = 0;
      return true;
    }

    // Passing a working fire beats driving circles around the address: any
    // fire unit rolling past flames stops HERE and goes to work.
    if (fireUnit && v.stationId === null && (v.mode === "respond" || v.mode === "roam")) {
      v.fireScanT -= dt;
      if (v.fireScanT <= 0) {
        v.fireScanT = 1.2;
        if (this.hasFireNear?.(v.x, v.y, 55)) {
          v.mode = "onscene";
          v.sceneT = 22 + Math.random() * 18;
        }
      }
    }

    // Speed: cruise, braked for corners, dispatch stops and traffic ahead.
    // Responding with lights on means code 3 — about 60 mph.
    const cruise = v.mode === "respond" && KINDS[v.kind].lights ? Math.max(v.speed, 27) : v.speed;
    let target = v.mode === "onscene" ? 0 : cruise;
    const err = Math.abs(Math.atan2(Math.sin(v.heading - v.rHeading), Math.cos(v.heading - v.rHeading)));
    target = Math.min(target, cruise * Math.max(0.22, 1 - err * 1.15));
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
        if (v.mode === "return-bay") {
          this.parkAtStation(v);
          return true;
        }
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
    const vs = this.vehicles.filter((v) => v.mode !== "available");
    for (let i = 0; i < vs.length; i++) {
      const a = vs[i]!;
      for (let j = i + 1; j < vs.length; j++) {
        const b = vs[j]!;
        // Same-alarm companies stack tightly at a scene and often leave
        // together. Do not let this simple local traffic model permanently
        // gridlock station rigs against one another.
        if (a.stationId !== null && b.stationId !== null) continue;
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

  private nearestRoadNode(goal: { x: number; y: number }): number {
    const key = `${Math.round(goal.x)},${Math.round(goal.y)}`;
    const cached = this.goalNodeCache.get(key);
    if (cached !== undefined) return cached;
    let best = -1;
    let bestDistance = Infinity;
    for (const [node, point] of this.nodePos) {
      const distance = (point.x - goal.x) ** 2 + (point.y - goal.y) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = node;
      }
    }
    if (this.goalNodeCache.size >= 256) this.goalNodeCache.clear();
    this.goalNodeCache.set(key, best);
    return best;
  }

  /** A* over the drivable graph. Cached station/incident pairs let a whole
   * company share one route and reuse its reverse path on the trip home. */
  private shortestRoute(from: number, to: number): { edges: number[]; distance: number } {
    if (from === to) return { edges: [], distance: 0 };
    const key = `${from}>${to}`;
    const cached = this.routeCache.get(key);
    if (cached) {
      return {
        edges: [...cached],
        distance: cached.reduce((sum, edge) => sum + (this.edgeLengths[edge] ?? 0), 0),
      };
    }
    const destination = this.nodePos.get(to);
    if (!destination || !this.nodePos.has(from)) return { edges: [], distance: Infinity };

    type Step = { node: number; score: number };
    const heap: Step[] = [];
    const push = (step: Step): void => {
      heap.push(step);
      let index = heap.length - 1;
      while (index > 0) {
        const parent = (index - 1) >> 1;
        if (heap[parent]!.score <= step.score) break;
        heap[index] = heap[parent]!;
        index = parent;
      }
      heap[index] = step;
    };
    const pop = (): Step | undefined => {
      const first = heap[0];
      const last = heap.pop();
      if (!first || !last || heap.length === 0) return first;
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        if (left >= heap.length) break;
        const child =
          right < heap.length && heap[right]!.score < heap[left]!.score ? right : left;
        if (heap[child]!.score >= last.score) break;
        heap[index] = heap[child]!;
        index = child;
      }
      heap[index] = last;
      return first;
    };
    const heuristic = (node: number): number => {
      const point = this.nodePos.get(node)!;
      return Math.hypot(point.x - destination.x, point.y - destination.y);
    };

    const cost = new Map<number, number>([[from, 0]]);
    const cameFrom = new Map<number, { node: number; edge: number }>();
    push({ node: from, score: heuristic(from) });
    while (heap.length) {
      const current = pop()!;
      const currentCost = cost.get(current.node);
      if (currentCost === undefined || current.score > currentCost + heuristic(current.node) + 1e-6) continue;
      if (current.node === to) break;
      for (const edgeIndex of this.adj.get(current.node) ?? []) {
        const edge = this.streets.edge(edgeIndex);
        const next = edge.a === current.node ? edge.b : edge.a;
        const nextCost = currentCost + (this.edgeLengths[edgeIndex] || 1);
        if (nextCost >= (cost.get(next) ?? Infinity)) continue;
        cost.set(next, nextCost);
        cameFrom.set(next, { node: current.node, edge: edgeIndex });
        push({ node: next, score: nextCost + heuristic(next) });
      }
    }

    if (!cameFrom.has(to)) return { edges: [], distance: Infinity };
    const edges: number[] = [];
    let node = to;
    while (node !== from) {
      const step = cameFrom.get(node);
      if (!step) return { edges: [], distance: Infinity };
      edges.push(step.edge);
      node = step.node;
    }
    edges.reverse();
    if (this.routeCache.size >= 256) this.routeCache.clear();
    this.routeCache.set(key, edges);
    this.routeCache.set(`${to}>${from}`, [...edges].reverse());
    return { edges: [...edges], distance: cost.get(to)! };
  }

  private ensureGoalRoute(v: Vehicle): void {
    const mode = v.mode === "respond" || v.mode === "return" ? v.mode : null;
    const goal = mode === "respond" ? v.goal : mode === "return" ? v.home : null;
    if (!mode || !goal) return;
    if (v.routeMode === mode && v.routeGoalX === goal.x && v.routeGoalY === goal.y) return;
    const target = this.nearestRoadNode(goal);
    const route = this.shortestRoute(v.endNode, target);
    v.routeEdges = route.edges;
    v.routeGoalNode = target;
    v.routeMode = mode;
    v.routeGoalX = goal.x;
    v.routeGoalY = goal.y;
    if (mode === "respond" && Number.isFinite(route.distance)) {
      v.respondT = Math.max(v.respondT, 60 + route.distance / 15);
    }
  }

  private nextEdge(v: Vehicle): boolean {
    const node = v.endNode;
    const pos = this.nodePos.get(node);
    const options = this.adj.get(node);
    if (!pos || !options?.length) return false;
    if (v.stationId !== null && v.mode === "return" && v.home?.node === node) {
      this.enterStationConnector(v, true);
      return true;
    }
    if (v.mode === "respond" && v.routeGoalNode === node && v.routeEdges.length === 0) {
      v.mode = "onscene";
      v.sceneT = 25 + Math.random() * 40;
      return false;
    }
    while (v.routeEdges.length) {
      const planned = v.routeEdges.shift()!;
      const edge = this.streets.edge(planned);
      if (edge.a === node || edge.b === node) {
        this.enterEdge(v, planned, node);
        return true;
      }
      // A stale route should fall back safely and be replanned if the goal
      // changes, never feed an unrelated edge into enterEdge.
      v.routeEdges = [];
    }
    const fresh = options.filter((edge) => this.streets.edge(edge).id !== v.edgeId);
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
    const weights = cands.map((edgeIndex) => {
      const e = this.streets.edge(edgeIndex);
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
        if (v.mode === "available" || !KINDS[v.kind].lights) continue; // buses and parked rigs don't wail
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
