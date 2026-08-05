import * as THREE from "three";
import { heightAt, type GameMap, type Heightfield } from "@battle-juice/shared";
import { toScene } from "./camera.js";
import { radialGlowTexture } from "./props.js";
import type { PropLayers } from "./props.js";
import type { BuildingShells } from "./world.js";
import { CYCLES_PER_DAY } from "./daynight.js";

// Disaster sim. A fire is a localized actor attached to its fuel: each burning
// building carries a set of fire CELLS sampled over its walls and roof; the
// flame front creeps cell-to-cell from the ignition point, so the fire visibly
// starts somewhere, grows like a blob, and chars the building EXACTLY where it
// has burned (per-vertex, via BuildingShells.charLocal). Burn clocks run on
// GAME time (small buildings burn 3-4 game hours, big commercial a full game
// day). Big fires loft embers downwind that start new fires; smoke is a tall
// black buoyant plume; burnt-out sites collapse to jagged walk-through ash
// heaps that smolder for 1-2 game days. Crews EXTINGUISH (not fast-forward):
// a knocked-down fire leaves the burned part scarred and the rest intact.
// All visuals are two instanced billboard pools — two draw calls.

/** Real seconds per game hour (day/night runs CYCLES_PER_DAY per real day). */
const REAL_PER_GAME_H = 3600 / CYCLES_PER_DAY;

const SMOKE_MAX = 2000;
const GLOW_MAX = 1400;
const EMBER_MAX = 130;
const SPREAD_TICK = 4; // real s between spread rolls per burning building
const TREE_IGNITE_R = 14; // m from a burning building
const TREE_TREE_R = 10;
const TREE_BURN_S = 40; // ~8 game minutes
const SUPPRESS_R = 85; // m — a fire crew on scene works the fire
const CELL_FLAME_LOD = 2500; // beyond this, one aggregate glow per fire

/** Burn duration in GAME hours by normalized use (before size scaling). */
const BURN_H: Record<string, number> = {
  sfr: 3.5, mfr: 4.5, com: 12, off: 14, ind: 10, inst: 8, other: 6,
};
const WOOD = new Set(["sfr", "mfr"]);

interface FireCell {
  x: number; y: number; // fuel anchor on the building
  fx: number; fy: number; // flame render position (nudged off the wall)
  z: number; // flame column base
  top: number; // flame column max top
  delay: number; // real s after ignition before the front arrives
  i: number; // current intensity 0..1
  char: number; // monotonic burn damage 0..1 (drives localized char)
}

interface Burn {
  bi: number;
  t: number; // real seconds burning
  dur: number; // real seconds for full burn-down
  spreadClock: number;
  smokeClock: number;
  emberClock: number;
  charClock: number;
  knock: number; // 0..1 extinguishment progress while a crew works it
  suppressed: boolean;
  x: number;
  y: number;
  z: number; // roof height (plume anchor)
  size: number; // visual scale ~ sqrt(area)
  height: number;
  smoky: number; // smoke multiplier (commercial headers)
  wood: boolean;
  cells: FireCell[];
  cellR: number; // char falloff radius per cell
  intensity: number; // aggregate 0..1 (drives smoke, embers, spread)
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

interface Ember {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  t: number;
  life: number;
}

/** Free-standing ball of fire (shift+click, gas): catches what's around it or
 * goes out on its own. */
interface Fireball {
  x: number; y: number; z: number;
  t: number;
  life: number;
  size: number;
  tryClock: number;
}

/** Long-tail smoke source: rubble and burnt shells smoking for 1-2 game days. */
interface Smolder {
  x: number; y: number; z: number;
  until: number; // sim-time cutoff (real s)
  clock: number;
  period: number;
  grey: number;
  size: number;
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
  private embers: Ember[] = [];
  private fireballs: Fireball[] = [];
  private smolders: Smolder[] = [];
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
  /** Everything that has pancaked — FPV consumes this to open collision. */
  readonly collapsed: number[] = [];

  private smoke: BillboardPool;
  private glow: BillboardPool;

  /** A fresh fire started somewhere no incident covers — dispatch hook. */
  onNewFire: ((x: number, y: number) => void) | null = null;
  /** A building pancaked (FPV collision hook). */
  onCollapse: ((bi: number) => void) | null = null;

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

  /** Sample fire cells over the building: perimeter columns + roof points.
   * The front creeps outward from the ignition point at a speed that has the
   * whole building involved by ~40% of the burn. */
  private makeCells(bi: number, dur: number, ix: number, iy: number): { cells: FireCell[]; cellR: number } {
    const b = this.map.buildings[bi]!;
    const base = this.shells.base(bi);
    const roof = base + b.height;
    const ring = b.footprint;
    const ccx = this.cx[bi]!;
    const ccy = this.cy[bi]!;
    let perim = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x1, y1] = ring[i]!;
      const [x2, y2] = ring[(i + 1) % ring.length]!;
      perim += Math.hypot(x2 - x1, y2 - y1);
    }
    const spacing = Math.max(6, perim / 22);
    const cells: FireCell[] = [];
    const addCell = (x: number, y: number, z: number, top: number) => {
      // Flames render just off the wall, leaning away from the centroid, so
      // they visibly lick the facade instead of clipping inside it.
      const dx = x - ccx;
      const dy = y - ccy;
      const d = Math.hypot(dx, dy) || 1;
      cells.push({
        x, y,
        fx: x + (dx / d) * 1.1,
        fy: y + (dy / d) * 1.1,
        z, top, delay: 0, i: 0, char: 0,
      });
    };
    let carry = spacing * 0.5;
    for (let i = 0; i < ring.length; i++) {
      const [x1, y1] = ring[i]!;
      const [x2, y2] = ring[(i + 1) % ring.length]!;
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (len < 1e-6) continue;
      let along = carry;
      while (along < len) {
        const t = along / len;
        addCell(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, base + 0.4, roof + 3 + b.height * 0.25);
        along += spacing;
      }
      carry = along - len;
    }
    if (cells.length === 0) addCell(ccx, ccy, base + 0.4, roof + 4);
    // Roof cells for broad buildings — fire through the roof, not just walls.
    const area = this.area(bi);
    if (area > 500) {
      let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
      for (const [px, py] of ring) {
        xmin = Math.min(xmin, px); ymin = Math.min(ymin, py);
        xmax = Math.max(xmax, px); ymax = Math.max(ymax, py);
      }
      const step = Math.max(10, Math.sqrt(area / 10));
      let added = 0;
      for (let y = ymin + step * 0.5; y < ymax && added < 12; y += step) {
        for (let x = xmin + step * 0.5; x < xmax && added < 12; x += step) {
          if (!pointInRing(x, y, ring)) continue;
          cells.push({ x, y, fx: x, fy: y, z: roof, top: roof + 6 + b.height * 0.3, delay: 0, i: 0, char: 0 });
          added++;
        }
      }
    }
    // Front creep: delay per cell from distance to the ignition point. The
    // NEAREST cell lights immediately — a fresh fire is visible at once.
    let maxD = 1;
    for (const c of cells) maxD = Math.max(maxD, Math.hypot(c.x - ix, c.y - iy));
    const frontSpeed = maxD / (dur * 0.4);
    let minDelay = Infinity;
    for (const c of cells) {
      c.delay = Math.hypot(c.x - ix, c.y - iy) / Math.max(0.02, frontSpeed);
      minDelay = Math.min(minDelay, c.delay);
    }
    for (const c of cells) c.delay -= minDelay;
    return { cells, cellR: spacing * 2.4 };
  }

  // ---- public actions ------------------------------------------------------

  /** Ignite; (ix, iy) localizes where on the building the fire starts. */
  igniteBuilding(bi: number, ix?: number, iy?: number): boolean {
    if (!this.shells.has(bi) || this.status[bi] !== 0 || this.burns.has(bi)) return false;
    const b = this.map.buildings[bi]!;
    const area = this.area(bi);
    const use = b.use ?? "other";
    const sizeScale = 0.8 + Math.min(1.6, Math.sqrt(area) / 40);
    const dur = (BURN_H[use] ?? BURN_H["other"]!) * REAL_PER_GAME_H * sizeScale;
    const ox = ix ?? this.cx[bi]! + (Math.random() - 0.5) * 6;
    const oy = iy ?? this.cy[bi]! + (Math.random() - 0.5) * 6;
    const { cells, cellR } = this.makeCells(bi, dur, ox, oy);
    const burn: Burn = {
      bi,
      t: 0,
      dur,
      spreadClock: SPREAD_TICK * (0.5 + Math.random()),
      smokeClock: 0,
      emberClock: 4 + Math.random() * 6,
      charClock: 1.5 + Math.random(),
      knock: 0,
      suppressed: false,
      x: this.cx[bi]!,
      y: this.cy[bi]!,
      z: this.shells.base(bi) + b.height,
      size: Math.min(30, 5 + Math.sqrt(area) * 0.55),
      height: b.height,
      smoky: WOOD.has(use) ? 1 : 1.9,
      wood: WOOD.has(use),
      cells,
      cellR,
      intensity: 0,
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
    return best >= 0 ? this.igniteBuilding(best, x, y) : false;
  }

  /** Drop a free-standing fireball at (x, y): it roils for a few seconds and
   * catches whatever fuel is around it — or goes out if there is none. */
  fireball(x: number, y: number): void {
    const z = this.terrain(x, y) + 1.2;
    this.flash(x, y, z + 3, 22, 0xffb066);
    for (let i = 0; i < 6; i++) {
      const a = Math.random() * Math.PI * 2;
      this.spawnPuff(
        x + Math.cos(a) * 1.5, y + Math.sin(a) * 1.5, z + 1 + Math.random() * 2,
        Math.cos(a) * 3, Math.sin(a) * 3, 4 + Math.random() * 4,
        2.5 + Math.random() * 2, 3.4, 0.07 + Math.random() * 0.05, 6 + Math.random() * 5,
      );
    }
    this.fireballs.push({
      x, y, z,
      t: 0,
      life: 6 + Math.random() * 6,
      size: 11 + Math.random() * 5,
      tryClock: 0.4,
    });
  }

  /** Structural damage (punch, shell). Scars locally, may ignite, may
   * collapse. (px, py) is the impact point for localized scarring. */
  damageBuilding(bi: number, dmg: number, igniteChance: number, px?: number, py?: number): void {
    if (!this.shells.has(bi) || this.status[bi] === 3) return;
    let hp = this.hp.get(bi) ?? this.maxHp(bi);
    hp -= dmg;
    if (hp <= 0) {
      this.collapse(bi);
      return;
    }
    this.hp.set(bi, hp);
    const scar = 1 - hp / this.maxHp(bi);
    if (this.status[bi] === 0) {
      const ix = px ?? this.cx[bi]!;
      const iy = py ?? this.cy[bi]!;
      // Blast/punch scarring stays where it landed.
      this.shells.charLocal(bi, [{ x: ix, y: iy, f: Math.min(0.8, 0.25 + scar * 0.7), r: 7 + dmg * 1.5 }]);
    }
    if (Math.random() < igniteChance) this.igniteBuilding(bi, px, py);
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
      this.damageBuilding(bi, power * fall, 0.35 * fall, x, y);
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

  private addSmolder(x: number, y: number, z: number, gameHours: number, grey: number, size: number): void {
    this.smolders.push({
      x, y, z,
      until: this.time + gameHours * REAL_PER_GAME_H,
      clock: Math.random() * 3,
      period: 2.2 + Math.random() * 2.5,
      grey,
      size,
    });
  }

  private collapse(bi: number): void {
    const wasBurning = this.status[bi] === 1;
    this.status[bi] = 3;
    this.hp.delete(bi);
    this.burns.delete(bi);
    this.shells.collapse(bi);
    this.collapsed.push(bi);
    this.onCollapse?.(bi);
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
    // Rubble that burned smolders for 1-2 game days.
    if (wasBurning) this.addSmolder(x, y, z + 1.5, 24 + Math.random() * 24, 0.34, 3.5);
  }

  /** A crew finished knocking the fire down. The burned part keeps its scars;
   * a mostly-consumed building becomes a charred shell, otherwise it stands
   * (and could catch again). */
  private extinguish(burn: Burn): void {
    this.burns.delete(burn.bi);
    if (this.status[burn.bi] !== 1) return;
    let charSum = 0;
    for (const c of burn.cells) charSum += c.char;
    const consumed = charSum / burn.cells.length;
    this.applyChar(burn);
    this.status[burn.bi] = consumed > 0.8 ? 2 : 0;
    // Steam-off, then a light smolder for a few game hours.
    for (let i = 0; i < 5; i++) {
      this.spawnPuff(
        burn.x + (Math.random() - 0.5) * burn.size * 0.5,
        burn.y + (Math.random() - 0.5) * burn.size * 0.5,
        burn.z + 1,
        0, 0, 3 + Math.random() * 2,
        3 + Math.random() * 2, 2.8, 0.6, 6 + Math.random() * 4,
      );
    }
    this.addSmolder(burn.x, burn.y, burn.z + 0.5, 2 + consumed * 6, 0.45, 2.5);
  }

  /** Burned to the ground on its own: black shell, maybe pancake. */
  private burnOut(burn: Burn): void {
    this.burns.delete(burn.bi);
    if (this.status[burn.bi] !== 1) return;
    if (burn.wood && Math.random() < 0.45) {
      this.collapse(burn.bi); // still status 1 here → rubble gets its smolder
      return;
    }
    this.status[burn.bi] = 2;
    this.shells.char(burn.bi, 1);
    // Unextinguished shells smoke for about a game day.
    this.addSmolder(burn.x, burn.y, burn.z + 1, 18 + Math.random() * 12, 0.32, 3);
  }

  /** Push current per-cell burn damage into the building's vertex colors. */
  private applyChar(burn: Burn): void {
    const srcs: { x: number; y: number; f: number; r: number }[] = [];
    for (const c of burn.cells) {
      if (c.char > 0.02) srcs.push({ x: c.x, y: c.y, f: c.char, r: burn.cellR });
    }
    if (srcs.length) this.shells.charLocal(burn.bi, srcs);
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
    alpha = 0.5,
  ): void {
    if (this.puffs.length >= SMOKE_MAX) this.puffs.shift();
    this.puffs.push({ x, y, z, vx, vy, vz, t: 0, life, size, grow, grey, alpha });
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
      burn.t += dt;
      const f = burn.t / burn.dur;
      if (f >= 1) {
        this.burnOut(burn);
        continue;
      }

      // Crew on scene: extinguishment builds; if they leave early it rekindles.
      burn.suppressed = suppressors.some((s) => Math.hypot(s.x - burn.x, s.y - burn.y) < SUPPRESS_R);
      const knockS = 120 + burn.dur * 0.05;
      if (burn.suppressed) burn.knock = Math.min(1, burn.knock + dt / knockS);
      else burn.knock = Math.max(0, burn.knock - dt / 90);
      if (burn.knock >= 1) {
        this.extinguish(burn);
        continue;
      }

      // Front creep: per-cell intensity + monotonic burn damage. The fire is
      // a blob that grows from the ignition point across the fuel.
      const ramp = Math.min(40, burn.dur * 0.06);
      const tail = 1 - Math.max(0, (f - 0.82) / 0.18);
      let iSum = 0;
      for (const c of burn.cells) {
        const tl = burn.t - c.delay;
        if (tl <= 0) {
          c.i = 0;
          continue;
        }
        c.i = Math.min(1, tl / ramp) * tail * (1 - burn.knock);
        c.char = Math.max(c.char, Math.min(1, tl / (burn.dur * 0.55)));
        iSum += c.i;
      }
      burn.intensity = iSum / burn.cells.length;

      // Localized charring, throttled (partial color-buffer uploads only).
      burn.charClock -= dt;
      if (burn.charClock <= 0) {
        burn.charClock = 2.2 + Math.random();
        this.applyChar(burn);
      }

      // Spread to neighbors: slow rolls over an hours-long burn, driven by
      // how involved the fire actually is right now.
      burn.spreadClock -= dt;
      if (burn.spreadClock <= 0 && f > 0.04 && burn.intensity > 0.2 && !burn.suppressed) {
        burn.spreadClock = SPREAD_TICK * (0.7 + Math.random() * 0.6);
        const reach = 14 + this.windSpeed * 2.2 + burn.size * 0.4;
        const baseP = (burn.wood ? 0.028 : 0.016) * burn.intensity;
        this.nearBuildings(burn.x, burn.y, reach, (bi, d) => {
          if (bi === burn.bi || this.status[bi] !== 0) return;
          const dx = (this.cx[bi]! - burn.x) / (d || 1);
          const dy = (this.cy[bi]! - burn.y) / (d || 1);
          const downwind = 0.55 + 0.45 * (dx * wx + dy * wy) * Math.min(1, this.windSpeed / 5);
          const nUse = this.map.buildings[bi]!.use ?? "other";
          const catchMul = WOOD.has(nUse) ? 1 : 0.55;
          if (Math.random() < baseP * downwind * catchMul * (1 - d / (reach + 1))) {
            // The neighbor catches on the side FACING this fire.
            const off = Math.sqrt(this.area(bi)) * 0.4;
            this.igniteBuilding(bi, this.cx[bi]! - dx * off, this.cy[bi]! - dy * off);
          }
        });
        this.nearTrees(burn.x, burn.y, TREE_IGNITE_R + burn.size * 0.4, (ti) => {
          if (Math.random() < 0.12) this.igniteTree(ti);
        });
      }

      // Embers: a big enough fire lofts brands downwind.
      if (burn.intensity * burn.size > 7 && !burn.suppressed) {
        burn.emberClock -= dt;
        if (burn.emberClock <= 0 && this.embers.length < EMBER_MAX) {
          burn.emberClock = 2.5 + Math.random() * 5 / Math.max(0.3, burn.intensity);
          this.embers.push({
            x: burn.x + (Math.random() - 0.5) * burn.size,
            y: burn.y + (Math.random() - 0.5) * burn.size,
            z: burn.z + 4 + Math.random() * (8 + burn.size * 0.5),
            vx: wx * this.windSpeed * (1.2 + Math.random()) + (Math.random() - 0.5) * 3,
            vy: wy * this.windSpeed * (1.2 + Math.random()) + (Math.random() - 0.5) * 3,
            vz: 5 + Math.random() * 9,
            t: 0,
            life: 4 + Math.random() * 6,
          });
        }
      }

      // Smoke: tall black buoyant plume off the burning cells.
      burn.smokeClock -= dt;
      if (burn.smokeClock <= 0 && burn.intensity > 0.02) {
        const rate = burn.smoky * (0.8 + burn.intensity * 3.4) * (0.6 + burn.size / 9);
        burn.smokeClock = 1 / rate;
        // Emit from a random burning cell so the column tracks the blob.
        let src: FireCell | null = null;
        for (let tries = 0; tries < 4 && !src; tries++) {
          const c = burn.cells[Math.floor(Math.random() * burn.cells.length)]!;
          if (c.i > 0.15) src = c;
        }
        const sx = src ? src.x : burn.x;
        const sy = src ? src.y : burn.y;
        const sz = src ? Math.max(src.z + 2, burn.z) : burn.z + 2;
        const grey = burn.suppressed
          ? 0.5 // steam-white while the crew works it
          : burn.wood
            ? 0.09 + Math.random() * 0.06
            : 0.045 + Math.random() * 0.05; // commercial: near-black column
        this.spawnPuff(
          sx, sy, sz,
          wx * this.windSpeed * 0.25, wy * this.windSpeed * 0.25,
          8 + Math.random() * 7 + burn.size * 0.1,
          6 + burn.size * 0.55, 3.6 + burn.smoky * 1.6, grey,
          24 + Math.random() * 20 + burn.smoky * 6,
          0.68,
        );
      }
    }

    // Fireballs: roil, try to catch fuel, gutter out.
    for (let i = this.fireballs.length - 1; i >= 0; i--) {
      const fb = this.fireballs[i]!;
      fb.t += dt;
      if (fb.t >= fb.life) {
        this.fireballs.splice(i, 1);
        continue;
      }
      fb.tryClock -= dt;
      if (fb.tryClock <= 0) {
        fb.tryClock = 0.7;
        this.nearBuildings(fb.x, fb.y, 16, (bi) => {
          if (Math.random() < 0.28) this.igniteBuilding(bi, fb.x, fb.y);
        });
        this.nearTrees(fb.x, fb.y, 12, (ti) => {
          if (Math.random() < 0.4) this.igniteTree(ti);
        });
        // Rolling black smoke off the ball.
        this.spawnPuff(
          fb.x, fb.y, fb.z + fb.size * 0.4,
          0, 0, 5 + Math.random() * 4,
          fb.size * 0.5, 3.5, 0.08, 8 + Math.random() * 6,
        );
      }
    }

    // Embers: loft, sail downwind, land, maybe start something.
    for (let i = this.embers.length - 1; i >= 0; i--) {
      const e = this.embers[i]!;
      e.t += dt;
      e.vz -= 4.5 * dt;
      e.x += (e.vx + wx * this.windSpeed * 0.8) * dt;
      e.y += (e.vy + wy * this.windSpeed * 0.8) * dt;
      e.z += e.vz * dt;
      const landed = e.z <= this.terrain(e.x, e.y) + 1;
      if (landed || e.t >= e.life) {
        if (landed && Math.random() < 0.3) {
          if (!this.igniteNear(e.x, e.y, 13)) {
            this.nearTrees(e.x, e.y, 9, (ti) => {
              if (Math.random() < 0.5) this.igniteTree(ti);
            });
          }
        }
        this.embers.splice(i, 1);
      }
    }

    // Smolders: rubble and burnt shells smoking for game-days.
    for (let i = this.smolders.length - 1; i >= 0; i--) {
      const s = this.smolders[i]!;
      if (this.time > s.until) {
        this.smolders.splice(i, 1);
        continue;
      }
      s.clock -= dt;
      if (s.clock <= 0) {
        s.clock = s.period;
        if (Math.hypot(s.x - focus.x, s.y - focus.y) < 5000) {
          this.spawnPuff(
            s.x + (Math.random() - 0.5) * 4, s.y + (Math.random() - 0.5) * 4, s.z,
            0, 0, 1.6 + Math.random() * 1.4,
            s.size, 1.6, s.grey, 12 + Math.random() * 8,
          );
        }
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
          if (Math.random() < 0.15) this.igniteBuilding(bi, t.x, t.y);
        });
      }
    }

    // Smoke particles: buoyant rise that bends over into the wind with age —
    // the classic plume shape, hundreds of meters tall for a big fire.
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i]!;
      p.t += dt;
      if (p.t >= p.life) {
        this.puffs.splice(i, 1);
        continue;
      }
      const windAge = Math.min(1.8, 0.35 + p.t * 0.05);
      p.x += (p.vx + wx * this.windSpeed * windAge) * dt;
      p.y += (p.vy + wy * this.windSpeed * windAge) * dt;
      p.z += p.vz * dt;
      p.vx *= 1 - dt * 0.4;
      p.vy *= 1 - dt * 0.4;
      p.vz *= 1 - dt * 0.045; // buoyancy fades slowly — the column keeps rising
      p.size += p.grow * dt * (1 - (p.t / p.life) * 0.5);
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
      const dist = Math.hypot(burn.x - focus.x, burn.y - focus.y);
      if (dist > RANGE) continue;
      const flick = 0.82 + 0.18 * Math.sin(this.time * 13 + burn.bi) * Math.sin(this.time * 29 + burn.x);
      if (dist > CELL_FLAME_LOD) {
        // Far away: one aggregate glow — the pixels wouldn't resolve cells.
        const s = burn.size * (0.5 + burn.intensity) * flick;
        this.glow.push(burn.x, burn.y, burn.z + 1, s, 1, 0.42, 0.1, 0.75 * burn.intensity * flick);
        this.glow.push(burn.x, burn.y, burn.z + 1 + s * 0.3, s * 1.6, 1, 0.25, 0.04, 0.3 * burn.intensity * flick);
        continue;
      }
      // Near: localized flames per burning cell, climbing the walls.
      for (let ci = 0; ci < burn.cells.length; ci++) {
        const c = burn.cells[ci]!;
        if (c.i < 0.03) continue;
        const cf = 0.75 + 0.25 * Math.sin(this.time * 11 + ci * 2.7 + burn.bi) * Math.sin(this.time * 23 + ci);
        const colH = c.z + (c.top - c.z) * Math.min(1, c.i * 1.15);
        const s = (3.4 + c.i * (5.5 + burn.height * 0.16)) * cf;
        // Base fire at the fuel, tongue partway up the column, tip licking the top.
        this.glow.push(c.fx, c.fy, c.z + s * 0.35, s, 1, 0.44, 0.1, 0.8 * c.i * cf);
        this.glow.push(c.fx, c.fy, c.z + (colH - c.z) * 0.55, s * 0.85, 1, 0.3, 0.05, 0.5 * c.i * cf);
        this.glow.push(c.fx, c.fy, colH, s * 0.6, 1, 0.2, 0.03, 0.3 * c.i * cf);
      }
      // Heavily involved: one merged body of flame over the roof — the
      // building reads engulfed, not dotted.
      if (burn.intensity > 0.45) {
        const k = (burn.intensity - 0.45) / 0.55;
        const s = burn.size * (0.8 + k * 0.9) * flick;
        this.glow.push(burn.x, burn.y, burn.z + burn.height * 0.15, s, 1, 0.4, 0.08, 0.55 * k * flick);
        this.glow.push(burn.x, burn.y, burn.z + s * 0.4, s * 1.3, 1, 0.24, 0.04, 0.3 * k * flick);
      }
    }
    for (const fb of this.fireballs) {
      if (Math.hypot(fb.x - focus.x, fb.y - focus.y) > RANGE) continue;
      const k = 1 - fb.t / fb.life;
      const roil = 0.8 + 0.2 * Math.sin(this.time * 17 + fb.x);
      for (let j = 0; j < 3; j++) {
        const a = this.time * (2 + j) + j * 2.1;
        this.glow.push(
          fb.x + Math.cos(a) * fb.size * 0.25,
          fb.y + Math.sin(a) * fb.size * 0.25,
          fb.z + fb.size * (0.25 + j * 0.22),
          fb.size * (1.15 - j * 0.2) * roil * (0.5 + k * 0.5),
          1, 0.42 - j * 0.1, 0.08, 0.88 * k * roil,
        );
      }
    }
    for (const e of this.embers) {
      if (Math.hypot(e.x - focus.x, e.y - focus.y) > RANGE) continue;
      const tw = 0.6 + 0.4 * Math.sin(this.time * 31 + e.x * 7);
      this.glow.push(e.x, e.y, e.z, 0.5 + 0.8 * tw, 1, 0.55, 0.15, 0.85 * tw * (1 - e.t / e.life));
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
