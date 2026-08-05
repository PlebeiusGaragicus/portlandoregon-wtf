import * as THREE from "three";
import { heightAt, type GameMap, type Heightfield, type StreetEdge } from "@battle-juice/shared";
import { toScene } from "./camera.js";
import { radialGlowTexture } from "./props.js";

// Ambient emergency traffic: fire engines/trucks, police cars and ambulances
// running code 3 along the real street graph. Purely decorative and fully
// client-side — the sim never sees them. Vehicles spawn from their real
// facilities near the camera; fire apparatus stay inside their first-due
// area and periodically return to the station and disappear.

const MAX_FIRE = 9;
const MAX_POLICE = 7;
const MAX_AMBULANCE = 5;
const CAP = MAX_FIRE + MAX_POLICE + MAX_AMBULANCE;

const SPEED_MIN = 14; // m/s — code 3 through city streets
const SPEED_MAX = 21;
const FMA_RADIUS = 2200; // m — fire apparatus wander this far from home
const SPAWN_NEAR = 6000; // m — facilities eligible around the camera focus
const DESPAWN_FAR = 7500; // m — too far from focus: recycle the vehicle
const HOME_DONE = 130; // m — close enough to the station to "back in"
const FLASH_HZ = 4.2;

interface VehicleKind {
  color: number;
  /** Lightbar flash pair. */
  flashA: number;
  flashB: number;
  /** Body size: length, width, height (m). */
  size: [number, number, number];
}

const KINDS: Record<"engine" | "truck" | "police" | "ambulance", VehicleKind> = {
  engine: { color: 0xb92418, flashA: 0xff2a1a, flashB: 0xffffff, size: [8.2, 2.5, 3.1] },
  truck: { color: 0xa81f14, flashA: 0xff2a1a, flashB: 0xffffff, size: [11.5, 2.5, 3.3] },
  police: { color: 0x272b34, flashA: 0x2f62ff, flashB: 0xff2a1a, size: [5.2, 2.0, 1.7] },
  ambulance: { color: 0xe4e6e9, flashA: 0xff2a1a, flashB: 0xffffff, size: [6.6, 2.4, 2.6] },
};

interface Vehicle {
  kind: keyof typeof KINDS;
  /** Home facility (fire station / hospital), world meters. */
  home: { x: number; y: number } | null;
  mode: "roam" | "return";
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
  heading: number;
  glow: THREE.Sprite;
}

interface Facility {
  x: number;
  y: number;
  node: number;
}

export class Actors {
  group = new THREE.Group();

  private adj = new Map<number, StreetEdge[]>();
  private nodePos = new Map<number, { x: number; y: number }>();
  private fireHomes: Facility[] = [];
  private ambHomes: Facility[] = [];
  private policeHomes: Facility[] = [];
  private vehicles: Vehicle[] = [];
  private respawnCooldown = 0;

  private body: THREE.InstancedMesh;
  private bar: THREE.InstancedMesh;
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
    }

    const bodyMat = new THREE.MeshLambertMaterial({ flatShading: true });
    this.body = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), bodyMat, CAP);
    this.body.castShadow = true;
    const barMat = new THREE.MeshBasicMaterial(); // unlit: lightbars burn through any hour
    this.bar = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), barMat, CAP);
    this.body.count = this.bar.count = 0;
    this.group.add(this.body, this.bar);
  }

  /** FPV listener position for the siren (null = map view, siren muted). */
  setListener(pos: { x: number; y: number } | null): void {
    this.listener = pos;
    if (pos && !this.audio) this.initSiren();
  }

  update(dt: number, timeSec: number, focus: { x: number; y: number }, night = 0): void {
    this.spawn(focus, dt);

    for (const v of this.vehicles) v.patience -= dt;
    this.vehicles = this.vehicles.filter((v) => this.advance(v, dt, focus));

    // Write instances.
    this.body.count = this.bar.count = this.vehicles.length;
    this.vehicles.forEach((v, i) => {
      const k = KINDS[v.kind];
      const gz = this.groundAt(v);
      const [L, W, H] = k.size;
      // heading is the world math angle of travel; a yaw of exactly that
      // about scene-up maps local +x (the box length) onto the travel dir.
      this.q.setFromAxisAngle(this.up, v.heading);
      this.m.compose(toScene(v.x, v.y, gz + 0.4 + H / 2), this.q, this.v3.set(L, H, W));
      this.body.setMatrixAt(i, this.m);
      this.body.setColorAt(i, this.color.setHex(k.color));
      const flash = Math.sin(timeSec * Math.PI * 2 * FLASH_HZ + v.phase) > 0;
      this.m.compose(
        toScene(v.x, v.y, gz + 0.4 + H + 0.18),
        this.q,
        this.v3.set(Math.min(2.2, L * 0.3), 0.3, W * 0.75),
      );
      this.bar.setMatrixAt(i, this.m);
      this.bar.setColorAt(i, this.color.setHex(flash ? k.flashA : k.flashB));
      const gm = v.glow.material as THREE.SpriteMaterial;
      gm.color.setHex(flash ? k.flashA : k.flashB);
      gm.opacity = 0.2 + 0.45 * night; // subtle by day, a beacon after dark
      v.glow.position.copy(toScene(v.x, v.y, gz + H + 2.5));
    });
    this.body.instanceMatrix.needsUpdate = true;
    this.bar.instanceMatrix.needsUpdate = true;
    if (this.body.instanceColor) this.body.instanceColor.needsUpdate = true;
    if (this.bar.instanceColor) this.bar.instanceColor.needsUpdate = true;

    this.updateSiren(timeSec);
  }

  private groundAt(v: Vehicle): number {
    const t = this.terrain(v.x, v.y);
    if (!v.bridge) return t;
    const s = v.edgeLen > 0 ? v.traveled / v.edgeLen : 0;
    return Math.max(t, v.hA + (v.hB - v.hA) * s);
  }

  // ---- population ----------------------------------------------------------

  private spawn(focus: { x: number; y: number }, dt: number): void {
    this.respawnCooldown -= dt;
    if (this.respawnCooldown > 0) return;
    const count = (k: (v: Vehicle) => boolean): number => this.vehicles.filter(k).length;
    const nFire = count((v) => v.kind === "engine" || v.kind === "truck");
    const nPol = count((v) => v.kind === "police");
    const nAmb = count((v) => v.kind === "ambulance");

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
      if (h) spawned = this.spawnAt("police", h, /* homeless */ true);
    } else if (nAmb < MAX_AMBULANCE) {
      const homes = near(this.ambHomes);
      const h = homes[Math.floor(Math.random() * homes.length)];
      if (h) spawned = this.spawnAt("ambulance", h);
    }
    // Stagger arrivals so a fresh view doesn't materialize a whole fleet.
    this.respawnCooldown = spawned ? 0.9 + Math.random() * 2.5 : 1.5;
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
    const glow = new THREE.Sprite(
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
      speed: SPEED_MIN + Math.random() * (SPEED_MAX - SPEED_MIN),
      phase: Math.random() * Math.PI * 2,
      x: home.x,
      y: home.y,
      heading: 0,
      glow,
    };
    this.enterEdge(v, edge, home.node);
    this.vehicles.push(v);
    return true;
  }

  private kill(v: Vehicle): void {
    v.glow.removeFromParent();
    (v.glow.material as THREE.SpriteMaterial).dispose();
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

  /** Move the vehicle; false = despawn it. */
  private advance(v: Vehicle, dt: number, focus: { x: number; y: number }): boolean {
    if (Math.hypot(v.x - focus.x, v.y - focus.y) > DESPAWN_FAR) {
      this.kill(v);
      return false;
    }
    if (v.home && v.mode === "roam" && v.patience <= 0) v.mode = "return";
    if (v.home && v.mode === "return" && Math.hypot(v.x - v.home.x, v.y - v.home.y) < HOME_DONE) {
      this.kill(v); // backed into the bay
      return false;
    }

    let left = v.speed * dt;
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
    return true;
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
    if (v.home) {
      if (v.mode === "return") goal = v.home;
      else if (Math.hypot(pos.x - v.home.x, pos.y - v.home.y) > FMA_RADIUS) goal = v.home;
    }
    let total = 0;
    const weights = cands.map((e) => {
      let w = 1;
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
    for (const v of this.vehicles) this.kill(v);
    this.vehicles = [];
    if (this.sirenOsc) this.sirenOsc.stop();
    if (this.audio) void this.audio.close();
  }
}
