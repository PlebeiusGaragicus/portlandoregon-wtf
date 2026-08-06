import * as THREE from "three";
import {
  heightAt,
  PROP_KINDS,
  propRotation,
  tileKeyAt,
  type GameMap,
  type Heightfield,
  type Prop,
  type PropStore,
} from "@battle-juice/shared";
import { toScene } from "./camera.js";
import { geometryBytes } from "./bytes.js";

const TRUNK_COLOR = 0x5c4a36;
const CANOPY_BASE = new THREE.Color(0x3e7c4f);
const SIGN_POLE_COLOR = 0x9aa0ab;
/** Sign variants, in the order the prop store encodes them. */
const SIGN_VARIANTS = ["stop", "street-name", "other"] as const;
const SIGN_FACE: Record<Extract<Prop, { kind: "sign" }>["sign"], number> = {
  stop: 0xe74c3c,
  "street-name": 0x2ecc71,
  other: 0x8a8f99,
};
// Fuller, slightly bigger trees — same icosahedron, just scaled (wider than
// tall) so the canopy reads lush without any extra polygons.
const CANOPY_RADIUS: Record<1 | 2 | 3, number> = { 1: 2.0, 2: 3.1, 3: 4.3 };

/** Map-view prop magnification: street furniture reads from the sky at a bit
 * over life size. FPV rebuilds with scale 1 so everything is life-sized. */
export const ICON_SCALE = 2.5;

/** Soft radial gradient (hot center, feathered edge) for lamp pools and
 * sky bodies — cheap fake bloom: an additive textured quad. */
export function radialGlowTexture(size = 128): THREE.CanvasTexture {
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const ctx = cv.getContext("2d")!;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.18, "rgba(255,255,255,0.75)");
  grad.addColorStop(0.45, "rgba(255,255,255,0.28)");
  grad.addColorStop(0.75, "rgba(255,255,255,0.07)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export interface PropLayers {
  /** Everything (contains `near`). */
  group: THREE.Group;
  /** Lamplight pools: every lamp in the city, always resident, in one draw
   * call. Kept OUT of `group` — and out of the tile streaming — so the night
   * city glows at any zoom and anywhere on the map, whether or not the lamp
   * posts themselves are currently built. */
  glow: THREE.Group;
  /**
   * Make exactly these 1 km tiles resident, building and evicting as needed.
   * Returns true when anything changed, so the caller can restore state that
   * lives on the meshes — burnt tree tints, most of all.
   *
   * Props are ~864k instances and 59 MB of matrices city-wide, and they are
   * already invisible above PROPS_VIEW. Streaming them at a radius WIDER than
   * that gate means nothing ever pops: a tile leaves the resident set only
   * once it is too far to be drawn anyway.
   */
  sync(want: Iterable<number>, budget?: number, residentByteBudget?: number): boolean;
  /** Build the whole city — headless tools and the FPV prop set. */
  buildAll(): void;
  /** Day/night dial: 0 = daylight (lamps off) .. 1 = deep night (full glow). */
  setNight(n: number): void;
  /** Small street furniture — signs, signals, meters, benches, racks, speed
   * cushions, hydrants. Gated to a much closer zoom than trees/lights. */
  near: THREE.Group;
  /** Recolor one tree canopy by its global tree index (fire tints: green ->
   * ember -> charred black). Cheap: one instanced color write. */
  paintTree(gi: number, color: THREE.Color): void;
  /** Release tile-owned instance buffers and the shared prop resources. */
  dispose(): void;
  /** Debug/benchmark counters that do not force a renderer readback. */
  stats(): {
    tiles: number;
    instances: number;
    matrixBytes: number;
    residentBytes: number;
    uploadBytes: number;
    evicted: number;
  };
}

type Tree = Extract<Prop, { kind: "tree" }>;
type Sign = Extract<Prop, { kind: "sign" }>;
type Signal = Extract<Prop, { kind: "signal" }>;
type Light = Extract<Prop, { kind: "light" }>;
type Simple = Extract<Prop, { kind: "meter" | "furniture" | "bikerack" | "bump" | "hydrant" }>;

function findPropTile(store: PropStore, key: number): number {
  let lo = 0;
  let hi = store.tileKey.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const value = store.tileKey[mid]!;
    if (value === key) return mid;
    if (value < key) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/**
 * All decorative props, tiled into InstancedMeshes per prop family.
 * Dimensions are life-size meters multiplied by `s` (trees are always
 * life-size — they already read at every zoom).
 */
export function buildProps(map: GameMap, store: PropStore, hf?: Heightfield | null, s = ICON_SCALE): PropLayers {
  const g = hf ? (x: number, y: number): number => heightAt(hf, x, y) : (): number => 0;
  const group = new THREE.Group();
  const near = new THREE.Group();
  const glow = new THREE.Group();
  group.add(near);
  // A bucket is transient and holds only one tile while it is being built.
  // The binary store is already tile-sorted, so retaining a second city-wide
  // Map<number, number[]> would rebuild the boxed object graph we removed.
  interface Bucket {
    trees: number[];
    signs: number[];
    signals: number[];
    lights: number[];
    meters: number[];
    furniture: number[];
    racks: number[];
    bumps: number[];
    hydrants: number[];
  }
  // Global tree index (order of tree props in the store) -> instanced slot,
  // so the fire sim can tint canopies across every built prop set. FireSim
  // walks the store in the same order, so the two agree.
  const treeSlots = new Map<number, { mesh: THREE.InstancedMesh; i: number }>();
  const px = store.x;
  const py = store.y;

  function bucketForTile(tile: number): Bucket {
    const bucket: Bucket = {
      trees: [], signs: [], signals: [], lights: [], meters: [],
      furniture: [], racks: [], bumps: [], hydrants: [],
    };
    const from = store.tileStart[tile]!;
    const to = store.tileStart[tile + 1]!;
    for (let i = from; i < to; i++) {
      switch (PROP_KINDS[store.kind[i]!]) {
        case "tree": bucket.trees.push(i); break;
        case "sign": bucket.signs.push(i); break;
        case "signal": bucket.signals.push(i); break;
        case "light": bucket.lights.push(i); break;
        case "meter": bucket.meters.push(i); break;
        case "furniture": bucket.furniture.push(i); break;
        case "bikerack": bucket.racks.push(i); break;
        case "bump": bucket.bumps.push(i); break;
        default: bucket.hydrants.push(i); break;
      }
    }
    return bucket;
  }

  // Shared geometries/materials across all tiles. Life-size meters x s.
  const flat = { flatShading: true } as const;
  const trunkGeo = new THREE.CylinderGeometry(0.3, 0.42, 2.6, 5);
  const canopyGeo = new THREE.IcosahedronGeometry(1, 0);
  const trunkMat = new THREE.MeshLambertMaterial({ color: TRUNK_COLOR, ...flat });
  const canopyMat = new THREE.MeshLambertMaterial({ ...flat });
  const poleGeo = new THREE.CylinderGeometry(0.06 * s, 0.06 * s, 3.2 * s, 5);
  const faceGeo = new THREE.BoxGeometry(0.8 * s, 0.8 * s, 0.08 * s);
  const poleMat = new THREE.MeshLambertMaterial({ color: SIGN_POLE_COLOR });
  const faceMat = new THREE.MeshLambertMaterial({ ...flat });
  const sigPoleGeo = new THREE.CylinderGeometry(0.1 * s, 0.12 * s, 4.5 * s, 5);
  const sigHeadGeo = new THREE.BoxGeometry(0.4 * s, 1.0 * s, 0.4 * s);
  const sigPoleMat = new THREE.MeshLambertMaterial({ color: 0x4a505c });
  const sigHeadMat = new THREE.MeshLambertMaterial({ color: 0x2b2f36, ...flat });
  const lightPoleGeo = new THREE.CylinderGeometry(0.08 * s, 0.12 * s, 7 * s, 5);
  const lightHeadGeo = new THREE.SphereGeometry(0.45 * s, 6, 5);
  const lightPoleMat = new THREE.MeshLambertMaterial({ color: 0x555b66 });
  const lightHeadMat = new THREE.MeshBasicMaterial({ color: 0xffd9a0 }); // warm glow, unlit
  // Additive pool of lamplight on the pavement under each luminaire: a wide
  // quad with a radial-gradient texture — soft-edged, bloom-ish, one instanced
  // draw for the whole city.
  // Life-size (FPV) pools stay tighter: at eye level the wide quads stack
  // into additive overdraw across the whole frustum.
  const POOL_R = s > 1 ? 9 * s : 7;
  const poolGeo = new THREE.PlaneGeometry(POOL_R * 2, POOL_R * 2);
  poolGeo.rotateX(-Math.PI / 2);
  const poolTexture = radialGlowTexture();
  const poolMat = new THREE.MeshBasicMaterial({
    map: poolTexture,
    color: 0xffc078,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const pools: THREE.Object3D[] = [];
  const meterGeo = new THREE.CylinderGeometry(0.05 * s, 0.05 * s, 1.3 * s, 5);
  const meterHeadGeo = new THREE.BoxGeometry(0.24 * s, 0.32 * s, 0.12 * s);
  const meterMat = new THREE.MeshLambertMaterial({ color: 0x7b828d });
  const meterHeadMat = new THREE.MeshLambertMaterial({ color: 0x3d434d, ...flat });
  const benchGeo = new THREE.BoxGeometry(1.5 * s, 0.45 * s, 0.55 * s);
  const benchMat = new THREE.MeshLambertMaterial({ color: 0x6a5946, ...flat });
  const rackGeo = new THREE.TorusGeometry(0.4 * s, 0.055 * s, 5, 10, Math.PI);
  const rackMat = new THREE.MeshLambertMaterial({ color: 0x8a919c });
  // Speed cushion: a squashed asphalt disc lying in the lane.
  const bumpGeo = new THREE.CylinderGeometry(1.6 * s, 1.75 * s, 0.22 * s, 10);
  const bumpMat = new THREE.MeshLambertMaterial({ color: 0x4a4744, ...flat });
  // Hydrant: squat barrel + bonnet, classic red.
  const hydrantGeo = new THREE.CylinderGeometry(0.14 * s, 0.17 * s, 0.6 * s, 6);
  const hydrantCapGeo = new THREE.SphereGeometry(0.15 * s, 6, 4);
  const hydrantMat = new THREE.MeshLambertMaterial({ color: 0xb33327, ...flat });

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const one = new THREE.Vector3(1, 1, 1);
  const color = new THREE.Color();

  /**
   * Every lamplight pool in the city, in one instanced mesh that is never
   * evicted.
   *
   * The pools used to be built per tile alongside the poles, which meant they
   * vanished the moment a tile was evicted — so zooming out turned the night
   * city dark, which is the one view the glow exists for. Keeping `glow` out
   * of `group` protected it from the zoom VISIBILITY gate but not from
   * eviction.
   *
   * A pool is a quad and a matrix, so all 65,868 of them cost ~4 MB and one
   * draw call, and the rasterizer's bill is set by screen area rather than
   * instance count — a lamp two miles away is a few pixels whether or not its
   * pole exists. So the lamp geometry keeps streaming and the light itself
   * simply stays.
   */
  {
    // Four-kilometre chunks keep the light city resident while allowing the
    // GPU to reject off-screen regions. The old one-mesh tier transformed all
    // 65k quads every frame because its city-wide bounds could not be culled.
    const chunks = new Map<number, number[]>();
    for (let pi = 0; pi < store.count; pi++) {
      if (PROP_KINDS[store.kind[pi]!] !== "light") continue;
      const key = tileKeyAt(px[pi]!, py[pi]!, 4000);
      const list = chunks.get(key);
      if (list) list.push(pi);
      else chunks.set(key, [pi]);
    }
    for (const list of chunks.values()) {
      const mesh = new THREE.InstancedMesh(poolGeo, poolMat, list.length);
      for (let i = 0; i < list.length; i++) {
        const pi = list[i]!;
        const lx = px[pi]!;
        const ly = py[pi]!;
        m.makeTranslation(toScene(lx, ly, g(lx, ly) + 0.4));
        mesh.setMatrixAt(i, m);
      }
      mesh.computeBoundingSphere();
      mesh.visible = false; // setNight turns it on
      pools.push(mesh);
      glow.add(mesh);
    }
  }

  /** Tiles currently built, and the meshes each contributed. */
  const live = new Map<number, THREE.Object3D[]>();
  const liveBytes = new Map<number, number>();
  let tileResidentBytes = 0;
  let uploadBytes = 0;
  let evicted = 0;
  const instanceBytes = (objects: Iterable<THREE.Object3D>): number => {
    let bytes = 0;
    for (const object of objects) {
      if (!(object instanceof THREE.InstancedMesh)) continue;
      bytes += object.instanceMatrix.array.byteLength + (object.instanceColor?.array.byteLength ?? 0);
    }
    return bytes;
  };
  function buildTile(key: number): void {
    const tile = findPropTile(store, key);
    if (tile < 0 || live.has(key)) return;
    const bucket = bucketForTile(tile);
    const made: THREE.Object3D[] = [];
    const add = (parent: THREE.Group, ...ms: THREE.Object3D[]): void => {
      parent.add(...ms);
      made.push(...ms);
    };
    {
    if (bucket.trees.length) {
      const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, bucket.trees.length);
      const canopies = new THREE.InstancedMesh(canopyGeo, canopyMat, bucket.trees.length);
      trunks.castShadow = canopies.castShadow = true;
      bucket.trees.forEach((pi, i) => {
        const tx = px[pi]!;
        const ty = py[pi]!;
        const r = CANOPY_RADIUS[(store.variant[pi] ?? 1) as 1 | 2 | 3];
        const gz = g(tx, ty);
        m.makeTranslation(toScene(tx, ty, gz + 1.3));
        trunks.setMatrixAt(i, m);
        // Wider than tall: a fuller crown from the same icosahedron.
        m.makeScale(r * 1.12, r * 0.92, r * 1.12).setPosition(toScene(tx, ty, gz + 1.8 + r * 0.78));
        canopies.setMatrixAt(i, m);
        color.copy(CANOPY_BASE).offsetHSL(jitter(i) * 0.04, jitter(i + 1) * 0.08, jitter(i + 2) * 0.05);
        canopies.setColorAt(i, color);
        const gi = store.treeOrdinal[pi]!;
        if (gi >= 0) treeSlots.set(gi, { mesh: canopies, i });
      });
      add(group, trunks, canopies);
    }
    if (bucket.signs.length) {
      const poles = new THREE.InstancedMesh(poleGeo, poleMat, bucket.signs.length);
      const faces = new THREE.InstancedMesh(faceGeo, faceMat, bucket.signs.length);
      poles.castShadow = faces.castShadow = true;
      bucket.signs.forEach((pi, i) => {
        const sx = px[pi]!;
        const sy = py[pi]!;
        const gz = g(sx, sy);
        m.makeTranslation(toScene(sx, sy, gz + 1.6 * s));
        poles.setMatrixAt(i, m);
        q.setFromAxisAngle(up, propRotation(store, pi));
        m.compose(toScene(sx, sy, gz + 2.7 * s), q, one);
        faces.setMatrixAt(i, m);
        faces.setColorAt(i, color.setHex(SIGN_FACE[SIGN_VARIANTS[store.variant[pi]!] ?? "other"]!));
      });
      add(near, poles, faces);
    }
    if (bucket.signals.length) {
      const poles = new THREE.InstancedMesh(sigPoleGeo, sigPoleMat, bucket.signals.length);
      const heads = new THREE.InstancedMesh(sigHeadGeo, sigHeadMat, bucket.signals.length);
      poles.castShadow = heads.castShadow = true;
      bucket.signals.forEach((pi, i) => {
        const si = { x: px[pi]!, y: py[pi]! };
        const gz = g(si.x, si.y);
        m.makeTranslation(toScene(si.x, si.y, gz + 2.25 * s));
        poles.setMatrixAt(i, m);
        m.makeTranslation(toScene(si.x, si.y, gz + 4.6 * s));
        heads.setMatrixAt(i, m);
      });
      add(near, poles, heads);
    }
    if (bucket.lights.length) {
      // The lamp itself is geometry and streams like everything else. Its
      // light does NOT — see the city-wide pool tier below.
      const poles = new THREE.InstancedMesh(lightPoleGeo, lightPoleMat, bucket.lights.length);
      const heads = new THREE.InstancedMesh(lightHeadGeo, lightHeadMat, bucket.lights.length);
      poles.castShadow = true;
      bucket.lights.forEach((pi, i) => {
        const si = { x: px[pi]!, y: py[pi]! };
        const gz = g(si.x, si.y);
        m.makeTranslation(toScene(si.x, si.y, gz + 3.5 * s));
        poles.setMatrixAt(i, m);
        m.makeTranslation(toScene(si.x, si.y, gz + 7.1 * s));
        heads.setMatrixAt(i, m);
      });
      add(group, poles, heads);
    }
    if (bucket.meters.length) {
      const poles = new THREE.InstancedMesh(meterGeo, meterMat, bucket.meters.length);
      const heads = new THREE.InstancedMesh(meterHeadGeo, meterHeadMat, bucket.meters.length);
      bucket.meters.forEach((pi, i) => {
        const si = { x: px[pi]!, y: py[pi]! };
        const gz = g(si.x, si.y);
        m.makeTranslation(toScene(si.x, si.y, gz + 0.65 * s));
        poles.setMatrixAt(i, m);
        q.setFromAxisAngle(up, jitter(i) * Math.PI);
        m.compose(toScene(si.x, si.y, gz + 1.4 * s), q, one);
        heads.setMatrixAt(i, m);
      });
      add(near, poles, heads);
    }
    if (bucket.furniture.length) {
      const benches = new THREE.InstancedMesh(benchGeo, benchMat, bucket.furniture.length);
      bucket.furniture.forEach((pi, i) => {
        const si = { x: px[pi]!, y: py[pi]! };
        q.setFromAxisAngle(up, jitter(i) * Math.PI);
        m.compose(toScene(si.x, si.y, g(si.x, si.y) + 0.25 * s), q, one);
        benches.setMatrixAt(i, m);
      });
      add(near, benches);
    }
    if (bucket.racks.length) {
      const racks = new THREE.InstancedMesh(rackGeo, rackMat, bucket.racks.length);
      bucket.racks.forEach((pi, i) => {
        const si = { x: px[pi]!, y: py[pi]! };
        q.setFromAxisAngle(up, jitter(i) * Math.PI);
        m.compose(toScene(si.x, si.y, g(si.x, si.y) + 0.42 * s), q, one);
        racks.setMatrixAt(i, m);
      });
      add(near, racks);
    }
    if (bucket.bumps.length) {
      const bumps = new THREE.InstancedMesh(bumpGeo, bumpMat, bucket.bumps.length);
      bucket.bumps.forEach((pi, i) => {
        const si = { x: px[pi]!, y: py[pi]! };
        m.makeTranslation(toScene(si.x, si.y, g(si.x, si.y) + 0.32 * s));
        bumps.setMatrixAt(i, m);
      });
      add(near, bumps);
    }
    if (bucket.hydrants.length) {
      const barrels = new THREE.InstancedMesh(hydrantGeo, hydrantMat, bucket.hydrants.length);
      const caps = new THREE.InstancedMesh(hydrantCapGeo, hydrantMat, bucket.hydrants.length);
      bucket.hydrants.forEach((pi, i) => {
        const si = { x: px[pi]!, y: py[pi]! };
        const gz = g(si.x, si.y);
        m.makeTranslation(toScene(si.x, si.y, gz + 0.3 * s));
        barrels.setMatrixAt(i, m);
        m.makeTranslation(toScene(si.x, si.y, gz + 0.62 * s));
        caps.setMatrixAt(i, m);
      });
      add(near, barrels, caps);
    }
  }
    live.set(key, made);
    const bytes = instanceBytes(made);
    liveBytes.set(key, bytes);
    tileResidentBytes += bytes;
    uploadBytes += bytes;
  }

  function evictTile(key: number): void {
    const made = live.get(key);
    if (!made) return;
    for (const o of made) {
      o.removeFromParent();
      if (o instanceof THREE.InstancedMesh) {
        // Instance matrices and colours belong to the tile mesh. Three.js
        // releases those GPU buffers only when the InstancedMesh itself is
        // disposed. Its geometry is shared by every tile, so disposing
        // o.geometry here invalidates still-live tiles and forces re-uploads.
        o.dispose();
      } else if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
      }
    }
    const tile = findPropTile(store, key);
    if (tile >= 0) {
      for (let pi = store.tileStart[tile]!; pi < store.tileStart[tile + 1]!; pi++) {
        const gi = store.treeOrdinal[pi]!;
        if (gi >= 0) treeSlots.delete(gi);
      }
    }
    tileResidentBytes -= liveBytes.get(key) ?? 0;
    liveBytes.delete(key);
    live.delete(key);
    evicted++;
  }

  const dayOff = new THREE.Color(0x565c66);
  const nightOn = new THREE.Color(0xffd9a0);
  return {
    group,
    near,
    glow,
    sync(want: Iterable<number>, budget = Infinity, residentByteBudget = Infinity): boolean {
      const order = [...want];
      const keep = new Set(order);
      let changed = false;
      for (const key of [...live.keys()]) {
        if (keep.has(key)) continue;
        evictTile(key);
        changed = true;
      }
      let made = 0;
      for (const key of order) {
        if (made >= budget) break;
        if (live.has(key) || findPropTile(store, key) < 0) continue;
        buildTile(key);
        made++;
        changed = true;
      }
      for (let i = order.length - 1; tileResidentBytes > residentByteBudget && i > 0; i--) {
        const key = order[i]!;
        if (!live.has(key)) continue;
        evictTile(key);
        changed = true;
      }
      return changed;
    },
    buildAll(): void {
      for (const key of store.tileKey) buildTile(key);
    },
    setNight(n: number): void {
      lightHeadMat.color.copy(dayOff).lerp(nightOn, n);
      poolMat.opacity = 0.5 * n;
      const on = n > 0.03;
      for (const pm of pools) pm.visible = on;
    },
    paintTree(gi: number, c: THREE.Color): void {
      const slot = treeSlots.get(gi);
      if (!slot) return;
      slot.mesh.setColorAt(slot.i, c);
      if (slot.mesh.instanceColor) slot.mesh.instanceColor.needsUpdate = true;
    },
    dispose(): void {
      for (const key of [...live.keys()]) evictTile(key);
      for (const o of pools) {
        o.removeFromParent();
        if (o instanceof THREE.InstancedMesh) o.dispose();
      }
      pools.length = 0;
      group.removeFromParent();
      glow.removeFromParent();
      for (const geo of [
        trunkGeo, canopyGeo, poleGeo, faceGeo, sigPoleGeo, sigHeadGeo,
        lightPoleGeo, lightHeadGeo, poolGeo, meterGeo, meterHeadGeo,
        benchGeo, rackGeo, bumpGeo, hydrantGeo, hydrantCapGeo,
      ]) geo.dispose();
      for (const mat of [
        trunkMat, canopyMat, poleMat, faceMat, sigPoleMat, sigHeadMat,
        lightPoleMat, lightHeadMat, poolMat, meterMat, meterHeadMat,
        benchMat, rackMat, bumpMat, hydrantMat,
      ]) mat.dispose();
      poolTexture.dispose();
      treeSlots.clear();
    },
    stats(): {
      tiles: number;
      instances: number;
      matrixBytes: number;
      residentBytes: number;
      uploadBytes: number;
      evicted: number;
    } {
      let instances = 0;
      let matrixBytes = 0;
      for (const made of live.values()) {
        for (const o of made) {
          if (!(o instanceof THREE.InstancedMesh)) continue;
          instances += o.count;
          matrixBytes += o.instanceMatrix.array.byteLength + (o.instanceColor?.array.byteLength ?? 0);
        }
      }
      for (const o of pools) {
        if (!(o instanceof THREE.InstancedMesh)) continue;
        instances += o.count;
        matrixBytes += o.instanceMatrix.array.byteLength + (o.instanceColor?.array.byteLength ?? 0);
      }
      const sharedBytes = [
        trunkGeo, canopyGeo, poleGeo, faceGeo, sigPoleGeo, sigHeadGeo,
        lightPoleGeo, lightHeadGeo, poolGeo, meterGeo, meterHeadGeo,
        benchGeo, rackGeo, bumpGeo, hydrantGeo, hydrantCapGeo,
      ].reduce((sum, geometry) => sum + geometryBytes(geometry), 0);
      return {
        tiles: live.size,
        instances,
        matrixBytes,
        residentBytes: sharedBytes + matrixBytes,
        uploadBytes,
        evicted,
      };
    },
  };
}

// Deterministic per-index jitter in [-1, 1] (no Math.random — stable frames).
function jitter(i: number): number {
  return (Math.sin(i * 127.1 + 311.7) * 43758.5453) % 1;
}
