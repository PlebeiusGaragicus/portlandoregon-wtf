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
const GLOW_MAX = 1200;
const FLAME_MAX = 3600;
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
 * goes out on its own. Renders as a fixed cluster of ground-hugging flame
 * tongues — a mass clinging to the surface, not orbiting sprites. */
interface Fireball {
  x: number; y: number; z: number;
  t: number;
  life: number;
  size: number;
  tryClock: number;
  /** Sub-flame anchors (fixed offsets + flicker seed), set at spawn. */
  subs: { ox: number; oy: number; seed: number }[];
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

/**
 * Ragged flame sprite with the COLOR baked in: white-hot core low on the
 * axis, orange body, deep-red ragged edge, base sitting on the bottom edge
 * of the quad (so sprites anchor ON the fuel, not hovering over it). Drawn
 * with normal blending the body is essentially opaque — fire you cannot see
 * through, unlike the additive glow halos.
 */
function flameAtlas(): THREE.CanvasTexture {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 512;
  const ctx = cv.getContext("2d")!;
  ctx.globalCompositeOperation = "lighter";
  const blob = (x: number, y: number, r: number, rgb: string, a: number) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${rgb},${a})`);
    g.addColorStop(0.6, `rgba(${rgb},${a * 0.55})`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  };
  // 4x4 atlas: 12 DIFFERENT flame tongues + 4 roiling near-opaque fire
  // balls. Instances pick a slot, so a burning block is never the same
  // sprite copy-pasted. Colors sit between ghost-glow and cartoon sticker:
  // deep red body, orange heart, small warm core.
  const drawTongue = (ox: number, oy: number) => {
    const lean = (Math.random() - 0.5) * 24;
    const wob = 4 + Math.random() * 9;
    const ph = Math.random() * Math.PI * 2;
    const axis = (t: number) => ox + 64 + lean * t + Math.sin(t * 6 + ph) * wob * t;
    for (let i = 0; i < 80; i++) {
      const t = Math.pow(Math.random(), 0.85);
      const y = oy + 118 - t * 100;
      const w = 29 * (1 - t * 0.7);
      const x = axis(t) + (Math.random() - 0.5) * 2 * w;
      const r = 14 * (1 - t * 0.55) + 4 + Math.random() * 5;
      blob(x, y, r, `255,${Math.round(52 + (1 - t) * 70)},14`, 0.42);
    }
    for (let i = 0; i < 30; i++) {
      const t = Math.random() * 0.7;
      const y = oy + 116 - t * 92;
      const x = axis(t) + (Math.random() - 0.5) * 24 * (1 - t * 0.6);
      const r = 10 * (1 - t * 0.45) + 3;
      blob(x, y, r, "255,148,42", 0.5);
    }
    for (let i = 0; i < 10; i++) {
      const t = Math.random() * 0.32;
      const y = oy + 112 - t * 70;
      const x = axis(t) + (Math.random() - 0.5) * 12;
      const r = 6.5 * (1 - t * 0.4) + 2;
      blob(x, y, r, "255,214,138", 0.6);
    }
  };
  // Roiling ball of fire: dense (mostly opaque) center, ragged round edge.
  const drawBall = (ox: number, oy: number) => {
    const cx = ox + 64;
    const cy = oy + 64;
    for (let i = 0; i < 30; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.pow(Math.random(), 0.7) * 38;
      blob(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 12 + Math.random() * 9, "232,44,10", 0.5);
    }
    for (let i = 0; i < 20; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.pow(Math.random(), 0.8) * 25;
      blob(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 9 + Math.random() * 7, "255,122,30", 0.55);
    }
    for (let i = 0; i < 11; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.random() * 13;
      blob(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 6 + Math.random() * 5, "255,202,96", 0.62);
    }
  };
  for (let slot = 0; slot < 16; slot++) {
    const ox = (slot & 3) * 128;
    const oy = (slot >> 2) * 128;
    if (BALL_SLOTS.includes(slot)) drawBall(ox, oy);
    else drawTongue(ox, oy);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Atlas slot layout (4x4). Slots 8-11 are the round fire balls. */
const BALL_SLOTS = [8, 9, 10, 11];
const TONGUE_SLOTS = [0, 1, 2, 3, 4, 5, 6, 7, 12, 13, 14, 15];
/** Canvas slot → UV offset (CanvasTexture flips Y: top canvas row = high v). */
function slotUv(slot: number): [number, number] {
  return [(slot & 3) * 0.25, 0.75 - (slot >> 2) * 0.25];
}

// The renderer uses a logarithmic depth buffer: raw ShaderMaterials MUST
// include three's logdepthbuf chunks or their fragments lose every depth
// test and silently vanish.
function billboardMaterial(
  tex: THREE.Texture,
  blending: THREE.Blending,
  useMapColor = false,
  uvScale = 1,
  worldFixed = false,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { map: { value: tex } },
    // worldFixed: the quad stands in the WORLD (vertical, yawed by iRot)
    // instead of turning to face the camera — crossed pairs of these read as
    // a 3D flame when you orbit, not a Doom sprite.
    side: worldFixed ? THREE.DoubleSide : THREE.FrontSide,
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      attribute vec3 iPos;
      attribute float iSize;
      attribute vec3 iColor;
      attribute float iAlpha;
      attribute vec2 iUv;
      attribute float iRot;
      varying vec2 vUv;
      varying vec3 vC;
      varying float vA;
      void main() {
        vUv = uv * ${uvScale.toFixed(4)} + iUv;
        vC = iColor;
        vA = iAlpha;
        ${worldFixed
          ? `vec3 off = vec3(position.x * cos(iRot), position.y, position.x * sin(iRot)) * iSize;
        vec4 mv = modelViewMatrix * vec4(iPos + off, 1.0);`
          : `vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
        mv.xy += position.xy * iSize;`}
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
        vec4 t = texture2D(map, vUv);
        ${useMapColor
          ? "gl_FragColor = vec4(t.rgb * vC, vA * min(1.0, t.a * 1.15));"
          : "gl_FragColor = vec4(vC, vA * t.a);"}
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
  private iuv: THREE.InstancedBufferAttribute;
  private irot: THREE.InstancedBufferAttribute;
  private geo: THREE.InstancedBufferGeometry;
  private n = 0;

  constructor(
    cap: number,
    tex: THREE.Texture,
    blending: THREE.Blending,
    renderOrder: number,
    useMapColor = false,
    atlasDim = 1,
    worldFixed = false,
  ) {
    const plane = new THREE.PlaneGeometry(1, 1);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = plane.index;
    this.geo.setAttribute("position", plane.getAttribute("position"));
    this.geo.setAttribute("uv", plane.getAttribute("uv"));
    this.pos = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.size = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
    this.color = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
    this.iuv = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2);
    this.irot = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
    this.geo.setAttribute("iPos", this.pos);
    this.geo.setAttribute("iSize", this.size);
    this.geo.setAttribute("iColor", this.color);
    this.geo.setAttribute("iAlpha", this.alpha);
    this.geo.setAttribute("iUv", this.iuv);
    this.geo.setAttribute("iRot", this.irot);
    this.mesh = new THREE.Mesh(this.geo, billboardMaterial(tex, blending, useMapColor, 1 / atlasDim, worldFixed));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
  }

  begin(): void {
    this.n = 0;
  }

  push(
    x: number, y: number, z: number, size: number,
    r: number, g: number, b: number, a: number,
    u = 0, v = 0, rot = 0,
  ): void {
    if (this.n >= this.size.count) return;
    const i = this.n++;
    const sv = toScene(x, y, z);
    this.pos.setXYZ(i, sv.x, sv.y, sv.z);
    this.size.setX(i, size);
    this.color.setXYZ(i, r, g, b);
    this.alpha.setX(i, a);
    this.iuv.setXY(i, u, v);
    this.irot.setX(i, rot);
  }

  end(): void {
    this.geo.instanceCount = this.n;
    this.pos.needsUpdate = true;
    this.size.needsUpdate = true;
    this.color.needsUpdate = true;
    this.alpha.needsUpdate = true;
    this.iuv.needsUpdate = true;
    this.irot.needsUpdate = true;
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
  /** Emission clocks for the merged neighborhood sky plumes. */
  private plumeClocks = new Map<number, number>();

  private smoke: BillboardPool;
  private glow: BillboardPool;
  private flames: BillboardPool;

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
    // Draw order: light halos under the solid flame bodies, smoke on top.
    this.glow = new BillboardPool(GLOW_MAX, tex, THREE.AdditiveBlending, 40);
    this.flames = new BillboardPool(FLAME_MAX, flameAtlas(), THREE.NormalBlending, 41, true, 4, true);
    this.smoke = new BillboardPool(SMOKE_MAX, tex, THREE.NormalBlending, 42);
    this.group.add(this.glow.mesh, this.flames.mesh, this.smoke.mesh);
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
    // Head start: a fresh ignition is VISIBLY on fire immediately, not a
    // smolder you have to squint for.
    burn.t = Math.min(40, dur * 0.06) * 0.7;
    this.status[bi] = 1;
    this.burns.set(bi, burn);
    this.onNewFire?.(burn.x, burn.y);
    return true;
  }

  /** Feed an ALREADY-burning building (another fireball, a shell): advance
   * the burn, wake the cells around the impact, shrug off some knockdown.
   * Thirty fireballs into one big block now means an inferno, not nothing. */
  stoke(bi: number, x: number, y: number): void {
    const burn = this.burns.get(bi);
    if (!burn) return;
    burn.t = Math.min(burn.t + burn.dur * 0.06, burn.dur * 0.85);
    burn.knock = Math.max(0, burn.knock - 0.35);
    const wake = Math.max(0, burn.t - 1);
    for (const c of burn.cells) {
      if (Math.hypot(c.x - x, c.y - y) < 28) c.delay = Math.min(c.delay, wake);
    }
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
    // A fireball ON a building sits on its ROOF (not buried inside) and
    // takes immediately — or stokes a fire that's already going.
    const direct = this.buildingAt(x, y, this.terrain(x, y) + 1);
    const z = (direct >= 0
      ? this.shells.base(direct) + this.map.buildings[direct]!.height
      : this.terrain(x, y)) + 1.2;
    this.flash(x, y, z + 3, 22, 0xffb066);
    if (direct >= 0 && !this.igniteBuilding(direct, x, y)) this.stoke(direct, x, y);
    for (let i = 0; i < 6; i++) {
      const a = Math.random() * Math.PI * 2;
      this.spawnPuff(
        x + Math.cos(a) * 1.5, y + Math.sin(a) * 1.5, z + 1 + Math.random() * 2,
        Math.cos(a) * 3, Math.sin(a) * 3, 4 + Math.random() * 4,
        2.5 + Math.random() * 2, 3.4, 0.07 + Math.random() * 0.05, 6 + Math.random() * 5,
      );
    }
    const size = 11 + Math.random() * 5;
    const subs = [];
    for (let i = 0; i < 8; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * size * 0.55;
      subs.push({ ox: Math.cos(a) * r, oy: Math.sin(a) * r, seed: Math.random() * 100 });
    }
    this.fireballs.push({
      x, y, z,
      t: 0,
      life: 18 + Math.random() * 18,
      size,
      tryClock: 0.4,
      subs,
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

  /** Any building actively burning within r of (x, y) — keeps crews and
   * incidents on scene until the fire is actually out. */
  hasFireNear(x: number, y: number, r: number): boolean {
    for (const b of this.burns.values()) {
      if (Math.hypot(b.x - x, b.y - y) < r) return true;
    }
    return false;
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

    // Shared sky plumes: burns in the same ~110 m neighborhood pool their
    // smoke into one column (weighted centroid, summed rate).
    const plumes = new Map<number, { x: number; y: number; grey: number; top: number; rate: number }>();

    // Buildings.
    for (const burn of [...this.burns.values()]) {
      // Mutual radiation: nearby fires feed each other — a cluster burns
      // hotter, faster, and jumps farther. THE conflagration feedback loop.
      let heat = 0;
      for (const other of this.burns.values()) {
        if (other.bi === burn.bi) continue;
        const d = Math.hypot(other.x - burn.x, other.y - burn.y);
        if (d < 90) heat += other.intensity * (1 - d / 90);
      }
      burn.t += dt * (1 + Math.min(0.8, heat * 0.15));
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
        const feed = 1 + Math.min(2.5, heat * 0.6);
        const reach = 14 + this.windSpeed * 2.2 + burn.size * 0.4 + Math.min(12, heat * 3);
        const baseP = (burn.wood ? 0.028 : 0.016) * burn.intensity * feed;
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
          burn.emberClock = (2.5 + Math.random() * 5 / Math.max(0.3, burn.intensity)) / (1 + heat * 0.4);
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

      // Smoke, two-part: a THICK dark base boiling right off the burning
      // cells (short-lived, high alpha), while the tall sky column is emitted
      // by the shared plume cluster below — nearby fires merge into ONE
      // column instead of forty (fill-rate is the FPV killer).
      const grey = burn.suppressed
        ? 0.5 // steam-white while the crew works it
        : burn.wood
          ? 0.09 + Math.random() * 0.06
          : 0.045 + Math.random() * 0.05; // commercial: near-black
      burn.smokeClock -= dt;
      if (burn.smokeClock <= 0 && burn.intensity > 0.02) {
        // Fast, fat, fully-opaque puffs rooted at the roof line over the
        // burning cells: a continuous churning column, not scattered dots.
        burn.smokeClock = 0.28 / Math.max(0.18, burn.intensity * burn.smoky);
        let src: FireCell | null = null;
        for (let tries = 0; tries < 4 && !src; tries++) {
          const c = burn.cells[Math.floor(Math.random() * burn.cells.length)]!;
          if (c.i > 0.15) src = c;
        }
        const sx = src ? src.x : burn.x;
        const sy = src ? src.y : burn.y;
        this.spawnPuff(
          sx, sy, burn.z + 1 + Math.random() * 3,
          wx * this.windSpeed * 0.15, wy * this.windSpeed * 0.15,
          2.6 + Math.random() * 1.8,
          9 + burn.size * 0.55, 2.6,
          burn.suppressed ? grey : grey * 0.5, // pitch black right off the fire
          8 + Math.random() * 4,
          1,
        );
      }
      // Contribute to the shared plume for this neighborhood.
      if (burn.intensity > 0.02) {
        const rate = burn.smoky * (0.8 + burn.intensity * 3.4) * (0.6 + burn.size / 9);
        const pk = Math.floor(burn.y / 110) * 8192 + Math.floor(burn.x / 110);
        const acc = plumes.get(pk);
        if (acc) {
          acc.x += burn.x * rate;
          acc.y += burn.y * rate;
          acc.grey += grey * rate;
          acc.top = Math.max(acc.top, burn.z);
          acc.rate += rate;
        } else {
          plumes.set(pk, { x: burn.x * rate, y: burn.y * rate, grey: grey * rate, top: burn.z, rate });
        }
      }
    }

    // Emit the merged sky columns: rate is CAPPED per cluster — a whole
    // burning block makes one column of fewer, larger, more opaque puffs
    // instead of forty overlapping plumes.
    for (const [pk, acc] of plumes) {
      const w = acc.rate;
      const rate = Math.min(3.2, w);
      let clock = (this.plumeClocks.get(pk) ?? 0) - dt;
      if (clock <= 0) {
        clock = Math.max(clock + 1 / rate, -0.5);
        const px = acc.x / w + (Math.random() - 0.5) * 8;
        const py = acc.y / w + (Math.random() - 0.5) * 8;
        this.spawnPuff(
          px, py, acc.top + 5,
          wx * this.windSpeed * 0.3, wy * this.windSpeed * 0.3,
          9 + Math.random() * 6 + Math.min(6, w * 0.4),
          12 + Math.sqrt(w) * 9, 4.5, acc.grey / w,
          26 + Math.random() * 18,
          0.75,
        );
      }
      this.plumeClocks.set(pk, clock);
    }
    for (const pk of this.plumeClocks.keys()) {
      if (!plumes.has(pk)) this.plumeClocks.delete(pk);
    }

    // Fireballs: roil, try to catch fuel, gutter out.
    for (let i = this.fireballs.length - 1; i >= 0; i--) {
      const fb = this.fireballs[i]!;
      fb.t += dt;
      if (fb.t >= fb.life) {
        this.fireballs.splice(i, 1);
        continue;
      }
      // Fire crawls: the ball drifts downwind and can shed children.
      fb.x += wx * this.windSpeed * 0.14 * dt;
      fb.y += wy * this.windSpeed * 0.14 * dt;
      fb.tryClock -= dt;
      if (fb.tryClock <= 0) {
        fb.tryClock = 0.7;
        // Direct contact always threatens; centroids can sit far from the
        // click on big footprints, so test the point itself too.
        const under = this.buildingAt(fb.x, fb.y, fb.z - fb.size);
        if (under >= 0 && Math.random() < 0.6 && !this.igniteBuilding(under, fb.x, fb.y)) {
          this.stoke(under, fb.x, fb.y);
        }
        this.nearBuildings(fb.x, fb.y, 26, (bi) => {
          if (Math.random() < 0.22 && !this.igniteBuilding(bi, fb.x, fb.y) && Math.random() < 0.4) {
            this.stoke(bi, fb.x, fb.y);
          }
        });
        if (Math.random() < 0.16 && this.fireballs.length < 40) {
          const a = this.windDir + (Math.random() - 0.5) * 2.4;
          const d = 8 + Math.random() * 8;
          const cx = fb.x + Math.cos(a) * d;
          const cy = fb.y + Math.sin(a) * d;
          const cb = this.buildingAt(cx, cy, this.terrain(cx, cy) + 1);
          const cz = (cb >= 0
            ? this.shells.base(cb) + this.map.buildings[cb]!.height
            : this.terrain(cx, cy)) + 1.2;
          const subs = [];
          for (let i = 0; i < 6; i++) {
            const sa = Math.random() * Math.PI * 2;
            const sr = Math.sqrt(Math.random()) * fb.size * 0.4;
            subs.push({ ox: Math.cos(sa) * sr, oy: Math.sin(sa) * sr, seed: Math.random() * 100 });
          }
          this.fireballs.push({
            x: cx, y: cy, z: cz,
            t: 0,
            life: 8 + Math.random() * 10,
            size: fb.size * (0.65 + Math.random() * 0.25),
            tryClock: 0.5,
            subs,
          });
        }
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

  /** One flame = two crossed world-fixed quads, each a DIFFERENT atlas
   * tongue: orbiting the fire shows changing structure, not a rotating
   * cardboard cutout, and no two fires read identical. */
  private pushFlame(x: number, y: number, z: number, s: number, a: number, variant: number, yaw: number): void {
    const aa = Math.min(1, a);
    const [u1, v1] = slotUv(TONGUE_SLOTS[variant % 12]!);
    const [u2, v2] = slotUv(TONGUE_SLOTS[(variant * 7 + 3) % 12]!);
    this.flames.push(x, y, z, s, 1, 1, 1, aa * 0.82, u1, v1, yaw);
    this.flames.push(x, y, z, s * 0.94, 1, 1, 1, aa * 0.7, u2, v2, yaw + Math.PI / 2);
  }

  /** Mostly-opaque roiling fire ball stuck to a surface (crossed quads). */
  private pushBall(x: number, y: number, z: number, s: number, a: number, variant: number, yaw: number): void {
    const aa = Math.min(1, a);
    const [u1, v1] = slotUv(BALL_SLOTS[variant & 3]!);
    const [u2, v2] = slotUv(BALL_SLOTS[(variant + 1) & 3]!);
    this.flames.push(x, y, z, s, 1, 1, 1, aa * 0.9, u1, v1, yaw);
    this.flames.push(x, y, z, s * 0.9, 1, 1, 1, aa * 0.75, u2, v2, yaw + Math.PI / 2);
  }

  private writeBillboards(focus: { x: number; y: number }): void {
    const RANGE = 9000;
    this.glow.begin();
    this.flames.begin();
    // Flame sprites carry their own baked color and are near-opaque (normal
    // blending): iColor stays white, iAlpha is coverage. Glow is only the
    // light they throw.
    for (const burn of this.burns.values()) {
      const dist = Math.hypot(burn.x - focus.x, burn.y - focus.y);
      if (dist > RANGE) continue;
      const flick = 0.82 + 0.18 * Math.sin(this.time * 13 + burn.bi) * Math.sin(this.time * 29 + burn.x);
      if (dist > CELL_FLAME_LOD) {
        // Far away: one aggregate flame — the pixels wouldn't resolve cells.
        const s = burn.size * (0.9 + burn.intensity) * flick;
        this.pushFlame(burn.x, burn.y, burn.z - 2 + s * 0.44, s, burn.intensity * 1.5, burn.bi, burn.bi * 0.7);
        this.glow.push(burn.x, burn.y, burn.z + 2, s * 2, 1, 0.35, 0.07, 0.4 * burn.intensity * flick);
        continue;
      }
      // Light halo over the whole fire.
      if (burn.intensity > 0.05) {
        this.glow.push(burn.x, burn.y, burn.z + 2, burn.size * (1.3 + burn.intensity), 1, 0.4, 0.1, 0.45 * burn.intensity * flick);
      }
      // Localized flame bodies per burning cell, base ON the fuel. Size
      // breathes only slightly; the FLICKER lives in brightness/alpha.
      for (let ci = 0; ci < burn.cells.length; ci++) {
        const c = burn.cells[ci]!;
        if (c.i < 0.03) continue;
        const szf = 0.93 + 0.07 * Math.sin(this.time * 6 + ci * 2.7 + burn.bi);
        const alf = 0.72 + 0.28 * Math.sin(this.time * 13 + ci * 3.1 + burn.bi) * Math.sin(this.time * 23 + ci);
        const s = (5 + c.i * (8 + burn.height * 0.22)) * szf;
        this.pushFlame(c.fx, c.fy, c.z + s * 0.42, s, c.i * 1.35 * alf, burn.bi + ci, burn.bi * 1.3 + ci * 0.9);
        this.glow.push(c.fx, c.fy, c.z + s * 0.55, s * 1.5, 1, 0.42, 0.1, 0.32 * c.i * alf);
        // Roiling fire balls STUCK to the facade at varied heights — the
        // structure itself unmistakably reads as on fire.
        if (c.i > 0.12) {
          const hb = ((ci * 2654435761) >>> 0) % 100 / 100;
          const onRoof = c.z >= burn.z - 0.5;
          const bz = onRoof ? c.z + 1.5 : c.z + 1.2 + burn.height * (0.15 + 0.55 * hb);
          const bs = (2.4 + c.i * 3.4 + burn.height * 0.06) * (0.9 + 0.1 * Math.sin(this.time * 8 + ci * 1.9));
          this.pushBall(c.fx, c.fy, bz, bs, (0.5 + 0.5 * c.i) * alf, burn.bi + ci, burn.bi + ci * 0.8);
        }
      }
      // Heavily involved: bigger flame bodies over every cell plus a central
      // inferno rooted in the structure — a raging mass, not a glow ball.
      if (burn.intensity > 0.45) {
        const k = (burn.intensity - 0.45) / 0.55;
        for (let ci = 0; ci < burn.cells.length; ci++) {
          const c = burn.cells[ci]!;
          if (c.i < 0.25) continue;
          const szf = 0.92 + 0.08 * Math.sin(this.time * 5 + ci * 4.1 + burn.bi * 2);
          const alf = 0.7 + 0.3 * Math.sin(this.time * 9 + ci * 4.1 + burn.bi * 2);
          const s = (9 + burn.height * 0.35 + burn.size * 0.4) * szf * k;
          this.pushFlame(c.fx, c.fy, c.z + s * 0.42, s, (0.75 * k + 0.15) * alf, burn.bi + ci * 2 + 1, burn.bi * 0.6 + ci * 1.7);
        }
        const sC = burn.size * (1.1 + k * 1.3) * (0.94 + 0.06 * flick);
        this.pushFlame(burn.x, burn.y, burn.z - burn.height * 0.35 + sC * 0.44, sC, 0.3 + k * 0.8 * flick, burn.bi * 3, burn.bi * 2.1);
      }
    }
    for (const fb of this.fireballs) {
      if (Math.hypot(fb.x - focus.x, fb.y - focus.y) > RANGE) continue;
      const k = 1 - fb.t / fb.life;
      this.glow.push(fb.x, fb.y, fb.z + fb.size * 0.3, fb.size * 1.6 * (0.5 + k * 0.5), 1, 0.32, 0.05, 0.4 * k);
      let si = 0;
      for (const sub of fb.subs) {
        const fl = 0.6 + 0.4 * Math.sin(this.time * 12 + sub.seed) * Math.sin(this.time * 27 + sub.seed * 3);
        const s = fb.size * (0.62 + 0.18 * fl) * (0.55 + k * 0.45);
        this.pushFlame(fb.x + sub.ox, fb.y + sub.oy, fb.z - 1 + s * 0.44, s, k * 1.25 * (0.55 + fl * 0.45), si++, sub.seed);
      }
    }
    // Embers: white-hot core inside an orange halo — brands you can track
    // sailing over the rooftops.
    for (const e of this.embers) {
      if (Math.hypot(e.x - focus.x, e.y - focus.y) > RANGE) continue;
      const tw = 0.7 + 0.3 * Math.sin(this.time * 31 + e.x * 7);
      const fade = 1 - Math.pow(e.t / e.life, 2);
      this.glow.push(e.x, e.y, e.z, 3.8 * tw, 1, 0.4, 0.08, 0.95 * tw * fade);
      this.glow.push(e.x, e.y, e.z, 1.9 * tw, 1, 0.8, 0.45, fade);
      this.glow.push(e.x, e.y, e.z, 0.9, 1, 0.97, 0.85, fade);
    }
    for (const ti of this.burningTrees) {
      const t = this.trees[ti]!;
      if (Math.hypot(t.x - focus.x, t.y - focus.y) > RANGE) continue;
      const f = Math.min(1, t.t / TREE_BURN_S);
      const a = Math.sin(f * Math.PI);
      const gz = this.terrain(t.x, t.y);
      const s = 7 + 5 * a;
      this.pushFlame(t.x, t.y, gz + s * 0.44, s, a * 1.2, ti, ti * 0.63);
      this.glow.push(t.x, t.y, gz + 4, s * 1.5, 1, 0.38, 0.08, 0.5 * a);
    }
    for (const fl of this.flashes) {
      const k = 1 - fl.t / fl.life;
      this.glow.push(fl.x, fl.y, fl.z, fl.size * (0.6 + (1 - k) * 0.8), fl.color.r, fl.color.g, fl.color.b, k * 0.95);
    }
    this.glow.end();
    this.flames.end();

    this.smoke.begin();
    for (const p of this.puffs) {
      if (Math.hypot(p.x - focus.x, p.y - focus.y) > RANGE) continue;
      const f = p.t / p.life;
      // Fast ramp-in, long opaque middle: smoke is a body, not a veil.
      const a = Math.min(1, Math.sin(Math.min(1, f) * Math.PI) * 2.6) * p.alpha;
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
