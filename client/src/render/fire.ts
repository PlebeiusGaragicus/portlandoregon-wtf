import * as THREE from "three";
import { heightAt, type GameMap, type Heightfield } from "@battle-juice/shared";
import { toScene } from "./camera.js";
import { radialGlowTexture } from "./props.js";
import type { PropLayers } from "./props.js";
import type { BuildingShells } from "./world.js";

// Disaster sim: buildings ignite, burn realistically (wood-frame houses fast,
// commercial blocks longer and bigger), char in place, sometimes collapse to
// rubble; fire spreads building-to-building with the wind, trees torch and
// blacken. Explosions (tank shells, gas) scar/ignite/flatten. All visuals are
// two instanced billboard pools (flame glow + smoke) — two draw calls total.

const SMOKE_MAX = 520;
const GLOW_MAX = 320;
const SPREAD_TICK = 1.9; // s between spread rolls per burning building
const TREE_IGNITE_R = 14; // m from a burning building
const TREE_TREE_R = 10;
const TREE_BURN_S = 24;
const SUPPRESS_R = 85; // m — a fire crew on scene knocks fires down
const CHAR_STEPS = 6;

/** Burn duration seconds by normalized use (before size scaling). */
const BURN_S: Record<string, number> = {
  sfr: 75, mfr: 115, com: 210, off: 230, ind: 175, inst: 145, other: 125,
};
const WOOD = new Set(["sfr", "mfr"]);

interface Burn {
  bi: number;
  t: number; // seconds burning
  dur: number;
  spreadClock: number;
  smokeClock: number;
  charLevel: number;
  suppressed: boolean;
  x: number;
  y: number;
  z: number; // flame anchor (roof-ish)
  size: number; // visual scale ~ sqrt(area)
  smoky: number; // smoke multiplier (commercial headers)
}

interface Puff {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  t: number;
  life: number;
  size: number;
  grow: number;
  grey: number;
  alpha: number;
}

interface Flash {
  x: number; y: number; z: number;
  t: number;
  life: number;
  size: number;
  color: THREE.Color;
}

interface Tree {
  x: number;
  y: number;
  /** 0 = green, 1 = burning, 2 = charred. */
  state: number;
  t: number;
}

// The renderer uses a logarithmic depth buffer: raw ShaderMaterials MUST
// include three's logdepthbuf chunks or their fragments lose every depth
// test and silently vanish.
function billboardMaterial(tex: THREE.Texture, blending: THREE.Blending): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { map: { value: tex } },
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      attribute vec3 iPos;
      attribute float iSize;
      attribute vec3 iColor;
      attribute float iAlpha;
      varying vec2 vUv;
      varying vec3 vC;
      varying float vA;
      void main() {
        vUv = uv;
        vC = iColor;
        vA = iAlpha;
        vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
        mv.xy += position.xy * iSize;
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform sampler2D map;
      varying vec2 vUv;
      varying vec3 vC;
      varying float vA;
      void main() {
        #include <logdepthbuf_fragment>
        float a = texture2D(map, vUv).a;
        gl_FragColor = vec4(vC, vA * a);
        if (gl_FragColor.a < 0.003) discard;
      }`,
    transparent: true,
    depthWrite: false,
    blending,
  });
}

/** Instanced view-aligned quad pool (works under both cameras). */
class BillboardPool {
  mesh: THREE.Mesh;
  private pos: THREE.InstancedBufferAttribute;
  private size: THREE.InstancedBufferAttribute;
  private color: THREE.InstancedBufferAttribute;
  private alpha: THREE.InstancedBufferAttribute;
  private geo: THREE.InstancedBufferGeometry;
  private n = 0;

  constructor(cap: number, tex: THREE.Texture, blending: THREE.Blending, renderOrder: number) {
    const plane = new THREE.PlaneGeometry(1, 1);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = plane.index;
    this.geo.setAttribute("position", plane.getAttribute("position"));
    this.geo.setAttribute("uv", plane.getAttribute("uv"));
    this.pos = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.size = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
    this.color = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
    this.geo.setAttribute("iPos", this.pos);
    this.geo.setAttribute("iSize", this.size);
    this.geo.setAttribute("iColor", this.color);
    this.geo.setAttribute("iAlpha", this.alpha);
    this.mesh = new THREE.Mesh(this.geo, billboardMaterial(tex, blending));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
  }

  begin(): void {
    this.n = 0;
  }

  push(x: number, y: number, z: number, size: number, r: number, g: number, b: number, a: number): void {
    if (this.n >= this.size.count) return;
    const i = this.n++;
    const v = toScene(x, y, z);
    this.pos.setXYZ(i, v.x, v.y, v.z);
    this.size.setX(i, size);
    this.color.setXYZ(i, r, g, b);
    this.alpha.setX(i, a);
  }

  end(): void {
    this.geo.instanceCount = this.n;
    this.pos.needsUpdate = true;
    this.size.needsUpdate = true;
    this.color.needsUpdate = true;
    this.alpha.needsUpdate = true;
  }
}

export class FireSim {
  group = new THREE.Group();

  /** 0 intact, 1 burning, 2 charred shell, 3 rubble. */
  private status: Uint8Array;
  private hp = new Map<number, number>();
  private burns = new Map<number, Burn>();
  private puffs: Puff[] = [];
  private flashes: Flash[] = [];
  private trees: Tree[] = [];
  private burningTrees = new Set<number>();
  private treeGrid = new Map<number, number[]>();
  private grid = new Map<number, number[]>(); // building centroid buckets
  private cx: Float32Array;
  private cy: Float32Array;
  private terrain: (x: number, y: number) => number;
  private propSets: PropLayers[] = [];
  private windDir = Math.random() * Math.PI * 2;
  private windSpeed = 3;
  private time = 0;
  private treeColor = new THREE.Color();

  private smoke: BillboardPool;
  private glow: BillboardPool;

  /** A fresh fire started somewhere no incident covers — dispatch hook. */
  onNewFire: ((x: number, y: number) => void) | null = null;

  private static CELL = 45;

  constructor(
    private map: GameMap,
    hf: Heightfield | null,
    private shells: BuildingShells,
  ) {
    this.terrain = hf ? (x, y) => heightAt(hf, x, y) : () => 0;
    const n = map.buildings.length;
    this.status = new Uint8Array(n);
    this.cx = new Float32Array(n);
    this.cy = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const fp = map.buildings[i]!.footprint;
      if (fp.length < 3) continue;
      let x = 0;
      let y = 0;
      for (const [px, py] of fp) {
        x += px;
        y += py;
      }
      x /= fp.length;
      y /= fp.length;
      this.cx[i] = x;
      this.cy[i] = y;
      const key = this.cellKey(x, y);
      const cell = this.grid.get(key);
      if (cell) cell.push(i);
      else this.grid.set(key, [i]);
    }
    let ti = 0;
    for (const p of map.props) {
      if (p.kind !== "tree") continue;
      this.trees.push({ x: p.x, y: p.y, state: 0, t: 0 });
      const key = this.cellKey(p.x, p.y);
      const cell = this.treeGrid.get(key);
      if (cell) cell.push(ti);
      else this.treeGrid.set(key, [ti]);
      ti++;
    }
    const tex = radialGlowTexture();
    this.glow = new BillboardPool(GLOW_MAX, tex, THREE.AdditiveBlending, 40);
    this.smoke = new BillboardPool(SMOKE_MAX, tex, THREE.NormalBlending, 41);
    this.group.add(this.glow.mesh, this.smoke.mesh);
  }

  /** Prop sets whose trees this sim recolors (map set + lazy FPV set). */
  addPropSet(p: PropLayers): void {
    this.propSets.push(p);
    // A late-built set must show already-burnt trees.
    for (const gi of this.burningTrees) this.paintTreeState(gi);
    for (let gi = 0; gi < this.trees.length; gi++) {
      if (this.trees[gi]!.state === 2) this.paintTreeState(gi);
    }
  }

  private cellKey(x: number, y: number): number {
    return Math.floor(y / FireSim.CELL) * 8192 + Math.floor(x / FireSim.CELL);
  }

  private nearBuildings(x: number, y: number, r: number, fn: (bi: number, d: number) => void): void {
    const c0 = Math.floor((x - r) / FireSim.CELL);
    const c1 = Math.floor((x + r) / FireSim.CELL);
    const r0 = Math.floor((y - r) / FireSim.CELL);
    const r1 = Math.floor((y + r) / FireSim.CELL);
    for (let ry = r0; ry <= r1; ry++) {
      for (let cx = c0; cx <= c1; cx++) {
        const cell = this.grid.get(ry * 8192 + cx);
        if (!cell) continue;
        for (const bi of cell) {
          const d = Math.hypot(this.cx[bi]! - x, this.cy[bi]! - y);
          if (d <= r) fn(bi, d);
        }
      }
    }
  }

  private nearTrees(x: number, y: number, r: number, fn: (ti: number, d: number) => void): void {
    const c0 = Math.floor((x - r) / FireSim.CELL);
    const c1 = Math.floor((x + r) / FireSim.CELL);
    const r0 = Math.floor((y - r) / FireSim.CELL);
    const r1 = Math.floor((y + r) / FireSim.CELL);
    for (let ry = r0; ry <= r1; ry++) {
      for (let cx = c0; cx <= c1; cx++) {
        const cell = this.treeGrid.get(ry * 8192 + cx);
        if (!cell) continue;
        for (const ti of cell) {
          const t = this.trees[ti]!;
          const d = Math.hypot(t.x - x, t.y - y);
          if (d <= r) fn(ti, d);
        }
      }
    }
  }

  private area(bi: number): number {
    const fp = this.map.buildings[bi]!.footprint;
    let a = 0;
    for (let i = 0; i < fp.length; i++) {
      const [x1, y1] = fp[i]!;
      const [x2, y2] = fp[(i + 1) % fp.length]!;
      a += x1 * y2 - x2 * y1;
    }
    return Math.abs(a / 2);
  }

  private maxHp(bi: number): number {
    const b = this.map.buildings[bi]!;
    return 2 + Math.sqrt(this.area(bi)) / 7 + b.height / 12;
  }

  // ---- public actions ------------------------------------------------------

  igniteBuilding(bi: number): boolean {
    if (!this.shells.has(bi) || this.status[bi] !== 0 || this.burns.has(bi)) return false;
    const b = this.map.buildings[bi]!;
    const area = this.area(bi);
    const use = b.use ?? "other";
    const sizeScale = 0.8 + Math.min(1.6, Math.sqrt(area) / 40);
    const burn: Burn = {
      bi,
      t: 0,
      dur: (BURN_S[use] ?? BURN_S["other"]!) * sizeScale,
      spreadClock: SPREAD_TICK * (0.5 + Math.random()),
      smokeClock: 0,
      charLevel: -1,
      suppressed: false,
      x: this.cx[bi]!,
      y: this.cy[bi]!,
      z: this.shells.base(bi) + b.height,
      size: Math.min(30, 5 + Math.sqrt(area) * 0.55),
      smoky: WOOD.has(use) ? 1 : 1.9,
    };
    this.status[bi] = 1;
    this.burns.set(bi, burn);
    this.onNewFire?.(burn.x, burn.y);
    return true;
  }

  /** Ignite the closest intact building to (x, y). */
  igniteNear(x: number, y: number, r = 60): boolean {
    let best = -1;
    let bd = Infinity;
    this.nearBuildings(x, y, r, (bi, d) => {
      if (this.status[bi] === 0 && d < bd) {
        bd = d;
        best = bi;
      }
    });
    return best >= 0 ? this.igniteBuilding(best) : false;
  }

  /** Structural damage (punch, shell). Chars, may ignite, may collapse. */
  damageBuilding(bi: number, dmg: number, igniteChance: number): void {
    if (!this.shells.has(bi) || this.status[bi] === 3) return;
    let hp = this.hp.get(bi) ?? this.maxHp(bi);
    hp -= dmg;
    if (hp <= 0) {
      this.collapse(bi);
      return;
    }
    this.hp.set(bi, hp);
    // Blast scarring: progressive darkening with damage.
    const scar = 1 - hp / this.maxHp(bi);
    if (this.status[bi] === 0) this.shells.char(bi, Math.min(0.55, scar * 0.7));
    if (Math.random() < igniteChance) this.igniteBuilding(bi);
  }

  /** Brief light flash (muzzle, punch spark). */
  flash(x: number, y: number, z: number, size: number, hex = 0xffd9a2): void {
    this.flashes.push({ x, y, z, t: 0, life: 0.3, size, color: new THREE.Color(hex) });
  }

  /** Small dust burst (punch impact). */
  dust(x: number, y: number, z: number, n = 3): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      this.spawnPuff(
        x, y, z + 0.5,
        Math.cos(a) * 2.5, Math.sin(a) * 2.5, 1 + Math.random() * 1.5,
        1.1 + Math.random(), 2.2, 0.36, 1.1 + Math.random(),
      );
    }
  }

  /** Area blast: flash, dust, damage + ignition around (x, y). */
  explosion(x: number, y: number, z: number, radius = 14, power = 4.5): void {
    this.flashes.push({
      x, y, z: z + 3,
      t: 0,
      life: 0.45,
      size: radius * 1.8,
      color: new THREE.Color(0xffc37a),
    });
    for (let i = 0; i < 9; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 3 + Math.random() * 9;
      this.spawnPuff(
        x + Math.cos(a) * 2, y + Math.sin(a) * 2, z + 1 + Math.random() * 3,
        Math.cos(a) * sp, Math.sin(a) * sp, 2.5 + Math.random() * 4,
        2.5 + Math.random() * 2.5, 3.2, 0.32, 2.8 + Math.random() * 1.6,
      );
    }
    this.nearBuildings(x, y, radius, (bi, d) => {
      const fall = 1 - (d / radius) * 0.7;
      this.damageBuilding(bi, power * fall, 0.35 * fall);
    });
    this.nearTrees(x, y, radius, (ti) => this.igniteTree(ti));
  }

  /** Building index whose footprint contains (x, y) and rises above z. */
  buildingAt(x: number, y: number, z: number): number {
    let hit = -1;
    this.nearBuildings(x, y, 42, (bi) => {
      if (hit >= 0 || this.status[bi] === 3) return;
      const b = this.map.buildings[bi]!;
      if (this.shells.base(bi) + b.height < z + 0.5) return;
      if (pointInRing(x, y, b.footprint)) hit = bi;
    });
    return hit;
  }

  /** A random standing building within [rMin, rMax] of (x, y) — tank target. */
  randomTargetNear(x: number, y: number, rMin: number, rMax: number): number {
    const found: number[] = [];
    this.nearBuildings(x, y, rMax, (bi, d) => {
      if (d >= rMin && this.status[bi] !== 3) found.push(bi);
    });
    return found.length ? found[Math.floor(Math.random() * found.length)]! : -1;
  }

  centerOf(bi: number): { x: number; y: number; z: number } {
    return { x: this.cx[bi]!, y: this.cy[bi]!, z: this.shells.base(bi) };
  }

  get activeFires(): number {
    return this.burns.size;
  }

  // ---- simulation ----------------------------------------------------------

  private collapse(bi: number): void {
    const wasBurning = this.status[bi] === 1;
    this.status[bi] = 3;
    this.hp.delete(bi);
    this.burns.delete(bi);
    this.shells.collapse(bi);
    const x = this.cx[bi]!;
    const y = this.cy[bi]!;
    const z = this.shells.base(bi);
    // Dust cloud rolling out of the fall.
    for (let i = 0; i < 8; i++) {
      const a = Math.random() * Math.PI * 2;
      this.spawnPuff(
        x + Math.cos(a) * 4, y + Math.sin(a) * 4, z + 2,
        Math.cos(a) * 5, Math.sin(a) * 5, 1.5 + Math.random() * 2,
        4 + Math.random() * 3, 4, 0.42, 3.5 + Math.random() * 2,
      );
    }
    if (wasBurning && Math.random() < 0.5) {
      // Rubble keeps smoldering a while.
      const burn = this.burns.get(bi);
      if (!burn) {
        this.status[bi] = 1;
        this.burns.set(bi, {
          bi, t: 0, dur: 25, spreadClock: 999, smokeClock: 0, charLevel: CHAR_STEPS,
          suppressed: true, x, y, z: z + 2, size: 4, smoky: 0.8,
        });
      }
    }
  }

  private igniteTree(ti: number): void {
    const t = this.trees[ti]!;
    if (t.state !== 0) return;
    t.state = 1;
    t.t = 0;
    this.burningTrees.add(ti);
  }

  private paintTreeState(gi: number): void {
    const t = this.trees[gi]!;
    if (t.state === 1) {
      const f = Math.min(1, t.t / TREE_BURN_S);
      // Green -> ember orange -> black.
      if (f < 0.45) this.treeColor.setHex(0x3e7c4f).lerp(new THREE.Color(0xd96a1e), f / 0.45);
      else this.treeColor.setHex(0xd96a1e).lerp(new THREE.Color(0x1a1512), (f - 0.45) / 0.55);
    } else if (t.state === 2) {
      this.treeColor.setHex(0x1a1512);
    } else {
      return;
    }
    for (const p of this.propSets) p.paintTree(gi, this.treeColor);
  }

  private spawnPuff(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    size: number, grow: number, grey: number, life: number,
  ): void {
    if (this.puffs.length >= SMOKE_MAX) this.puffs.shift();
    this.puffs.push({ x, y, z, vx, vy, vz, t: 0, life, size, grow, grey, alpha: 0.5 });
  }

  update(dt: number, focus: { x: number; y: number }, suppressors: { x: number; y: number }[]): void {
    this.time += dt;
    // Wind wanders slowly; it is THE conflagration variable.
    this.windDir += (Math.sin(this.time * 0.023) + Math.sin(this.time * 0.011 + 2)) * 0.06 * dt;
    this.windSpeed = 3.5 + 2.8 * Math.sin(this.time * 0.017 + 1);
    const wx = Math.cos(this.windDir);
    const wy = Math.sin(this.windDir);

    // Buildings.
    for (const burn of [...this.burns.values()]) {
      burn.t += dt * (burn.suppressed ? 2.6 : 1);
      const f = burn.t / burn.dur;
      if (f >= 1) {
        // Burnt out: charred shell; wood-frame sometimes pancakes.
        this.burns.delete(burn.bi);
        if (this.status[burn.bi] === 1) {
          this.status[burn.bi] = 2;
          this.shells.char(burn.bi, 1);
          const use = this.map.buildings[burn.bi]!.use ?? "other";
          if (!burn.suppressed && WOOD.has(use) && Math.random() < 0.45) this.collapse(burn.bi);
        }
        continue;
      }
      // Progressive char in discrete steps (partial buffer uploads only).
      const level = Math.floor(f * CHAR_STEPS);
      if (level !== burn.charLevel && this.status[burn.bi] === 1) {
        burn.charLevel = level;
        this.shells.char(burn.bi, Math.min(1, 0.15 + (level / CHAR_STEPS) * 0.85));
      }
      // Suppression: any fire crew close by keeps it from jumping.
      burn.suppressed = suppressors.some((s) => Math.hypot(s.x - burn.x, s.y - burn.y) < SUPPRESS_R);

      // Spread.
      burn.spreadClock -= dt;
      if (burn.spreadClock <= 0 && f > 0.18 && f < 0.8) {
        burn.spreadClock = SPREAD_TICK * (0.7 + Math.random() * 0.6);
        const reach = 15 + this.windSpeed * 2.2 + burn.size * 0.35;
        const use = this.map.buildings[burn.bi]!.use ?? "other";
        const baseP = (WOOD.has(use) ? 0.5 : 0.32) * (burn.suppressed ? 0.12 : 1);
        this.nearBuildings(burn.x, burn.y, reach, (bi, d) => {
          if (bi === burn.bi || this.status[bi] !== 0) return;
          const dx = (this.cx[bi]! - burn.x) / (d || 1);
          const dy = (this.cy[bi]! - burn.y) / (d || 1);
          const downwind = 0.55 + 0.45 * (dx * wx + dy * wy) * Math.min(1, this.windSpeed / 5);
          const nUse = this.map.buildings[bi]!.use ?? "other";
          const catchMul = WOOD.has(nUse) ? 1 : 0.55;
          if (Math.random() < baseP * downwind * catchMul * (1 - d / (reach + 1)) ) this.igniteBuilding(bi);
        });
        this.nearTrees(burn.x, burn.y, TREE_IGNITE_R + burn.size * 0.4, (ti) => {
          if (Math.random() < 0.5) this.igniteTree(ti);
        });
      }

      // Smoke header: puff rate scales with fire size and phase.
      burn.smokeClock -= dt;
      const involved = Math.min(1, f / 0.25) * (1 - Math.max(0, (f - 0.75) / 0.25) * 0.7);
      if (burn.smokeClock <= 0) {
        burn.smokeClock = 0.75 / (burn.smoky * (0.4 + involved) * (0.6 + burn.size / 18));
        const dark = burn.smoky > 1.4 ? 0.16 : 0.3; // commercial: black header
        this.spawnPuff(
          burn.x + (Math.random() - 0.5) * burn.size * 0.5,
          burn.y + (Math.random() - 0.5) * burn.size * 0.5,
          burn.z + 2,
          wx * this.windSpeed * 0.4, wy * this.windSpeed * 0.4,
          4.5 + Math.random() * 3 + burn.smoky,
          burn.size * 0.45 + 2, 2.6 + burn.smoky, dark + Math.random() * 0.08,
          5 + burn.smoky * 3 + Math.random() * 3,
        );
      }
    }

    // Trees.
    for (const ti of [...this.burningTrees]) {
      const t = this.trees[ti]!;
      t.t += dt;
      this.paintTreeState(ti);
      if (t.t >= TREE_BURN_S) {
        t.state = 2;
        this.burningTrees.delete(ti);
        this.paintTreeState(ti);
        continue;
      }
      if (Math.random() < dt * 0.35) {
        this.nearTrees(t.x, t.y, TREE_TREE_R, (tj) => {
          if (Math.random() < 0.4) this.igniteTree(tj);
        });
        this.nearBuildings(t.x, t.y, 9, (bi) => {
          if (Math.random() < 0.15) this.igniteBuilding(bi);
        });
      }
    }

    // Particles.
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i]!;
      p.t += dt;
      if (p.t >= p.life) {
        this.puffs.splice(i, 1);
        continue;
      }
      p.x += (p.vx + wx * this.windSpeed * 0.5) * dt;
      p.y += (p.vy + wy * this.windSpeed * 0.5) * dt;
      p.z += p.vz * dt;
      p.vx *= 1 - dt * 0.6;
      p.vy *= 1 - dt * 0.6;
      p.size += p.grow * dt;
    }
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const fl = this.flashes[i]!;
      fl.t += dt;
      if (fl.t >= fl.life) this.flashes.splice(i, 1);
    }

    this.writeBillboards(focus);
  }

  private writeBillboards(focus: { x: number; y: number }): void {
    const RANGE = 9000;
    this.glow.begin();
    for (const burn of this.burns.values()) {
      if (Math.hypot(burn.x - focus.x, burn.y - focus.y) > RANGE) continue;
      const f = burn.t / burn.dur;
      const involved = Math.min(1, f / 0.25) * (1 - Math.max(0, (f - 0.7) / 0.3) * 0.85);
      const flick = 0.82 + 0.18 * Math.sin(this.time * 13 + burn.bi) * Math.sin(this.time * 29 + burn.x);
      const s = (burn.size * (0.5 + involved)) * flick;
      // Twin glows: hot core low, softer lick above.
      this.glow.push(burn.x, burn.y, burn.z + 1, s, 1, 0.42, 0.1, 0.75 * involved * flick);
      this.glow.push(burn.x, burn.y, burn.z + 1 + s * 0.3, s * 1.6, 1, 0.25, 0.04, 0.3 * involved * flick);
    }
    for (const ti of this.burningTrees) {
      const t = this.trees[ti]!;
      if (Math.hypot(t.x - focus.x, t.y - focus.y) > RANGE) continue;
      const f = Math.min(1, t.t / TREE_BURN_S);
      const a = Math.sin(f * Math.PI);
      this.glow.push(t.x, t.y, this.terrain(t.x, t.y) + 4, 6 + 3 * a, 1, 0.38, 0.08, 0.6 * a);
    }
    for (const fl of this.flashes) {
      const k = 1 - fl.t / fl.life;
      this.glow.push(fl.x, fl.y, fl.z, fl.size * (0.6 + (1 - k) * 0.8), fl.color.r, fl.color.g, fl.color.b, k * 0.95);
    }
    this.glow.end();

    this.smoke.begin();
    for (const p of this.puffs) {
      if (Math.hypot(p.x - focus.x, p.y - focus.y) > RANGE) continue;
      const f = p.t / p.life;
      const a = Math.sin(Math.min(1, f) * Math.PI) * p.alpha;
      this.smoke.push(p.x, p.y, p.z, p.size, p.grey, p.grey, p.grey * 1.05, a);
    }
    this.smoke.end();
  }
}

function pointInRing(px: number, py: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
