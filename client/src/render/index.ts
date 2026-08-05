import * as THREE from "three";
import { heightAt, raycastHeightfield, type GameMap, type Heightfield } from "@battle-juice/shared";
import { Actors } from "./actors.js";
import { CameraRig, toScene, toWorldXY } from "./camera.js";
import { Controls, type ControlDelegate } from "./controls.js";
import { DayNight } from "./daynight.js";
import { FireSim } from "./fire.js";
import { FpvMode } from "./fpv.js";
import { buildLandmarks, type LandmarkLayer } from "./landmarks.js";
import { Minimap } from "./minimap.js";
import { buildProps, radialGlowTexture, type PropLayers } from "./props.js";
import { buildWorld, type WorldLayers } from "./world.js";

// Zoom thresholds (meters of vertical view).
const BLEND_START = 2200; // street tint starts brightening
const BLEND_END = 3200;
const PROPS_VIEW = 3000; // above: hide trees/street lights (subpixel anyway)
const NEAR_PROPS_VIEW = 1000; // above: hide small street furniture (signs, hydrants, benches...)

const START_VIEW = 2600; // spectator reveal: district scale, then explore

const SKY_R = 20000; // FPV sky dome radius, inside the FPV far plane
const SHADOW_MAX_VIEW = 8000; // above: shadows are subpixel, skip the pass

export interface PrebuiltLayers {
  world: WorldLayers;
  props: PropLayers;
  landmarks: LandmarkLayer;
}

export interface RendererOpts {
  /** World geometry built ahead of time (loading-screen time). */
  prebuilt?: PrebuiltLayers;
  /** Terrain heightfield; absent = flat ground. */
  heightfield?: Heightfield | null;
}

/**
 * Three.js renderer: perspective tilted camera over the baked map. Currently
 * spectator-only — navigation, no unit command (units return in a later
 * phase; the selection/dispatch delegate hooks stay no-ops until then).
 */
export class Renderer {
  private webgl: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera();
  private rig: CameraRig;
  private controls: Controls;
  private world: WorldLayers;
  private props: PropLayers;
  private landmarks: LandmarkLayer;
  private minimap: Minimap;
  private compass: HTMLDivElement;
  private resizeObserver: ResizeObserver;
  private raycaster = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  private hemi!: THREE.HemisphereLight;
  private sun!: THREE.DirectionalLight;
  private daynight = new DayNight();
  private actors!: Actors;
  /** Fire + destruction sim (public: debug harnesses drive it). */
  fire!: FireSim;
  private shake = 0;
  private punchCd = 0;
  private boomCtx: AudioContext | null = null;
  private lastNight = -1;
  private hudClock!: HTMLDivElement;
  private hudScale!: HTMLDivElement;
  private hudScaleBar!: HTMLDivElement;
  private hudScaleLabel!: HTMLSpanElement;
  private lastScaleText = "";
  private hf: Heightfield | null;
  private ground: (x: number, y: number) => number;

  private map: GameMap;
  private sky: THREE.Mesh | null = null;
  private skyBody: THREE.Mesh | null = null;
  private skyBodyMat: THREE.MeshBasicMaterial | null = null;
  private fpvProps: PropLayers | null = null;
  /** FPV distance culling: small geometry hidden past its threshold. */
  private fpvCull: { obj: THREE.Object3D; x: number; z: number; range: number }[] = [];
  private fpvCullDirty = false;
  private fpv: FpvMode | null = null;
  private fpvOn = false;
  private fpvHint: HTMLDivElement;
  private fadeEl: HTMLDivElement;
  private fpvHintTimer = 0;
  private fpvDisposers: (() => void)[] = [];

  private lastFrame = 0;
  private disposed = false;

  constructor(
    private canvas: HTMLCanvasElement,
    map: GameMap,
    opts: RendererOpts = {},
  ) {
    // Log depth: a perspective frustum spanning tens of km would otherwise
    // z-fight the street ribbons floating just over the ground.
    this.webgl = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
    this.webgl.setPixelRatio(window.devicePixelRatio);
    this.scene.background = new THREE.Color(0x14171c);

    this.hemi = new THREE.HemisphereLight(0xbfd0e8, 0x33302a, 0.9);
    this.sun = new THREE.DirectionalLight(0xfff2dd, 1.4);
    // Shadows: one directional (sun or moon) with an ortho box re-fit around
    // the camera focus every frame — city-wide maps can't fit one shadow map.
    this.webgl.shadowMap.enabled = true;
    this.webgl.shadowMap.type = THREE.PCFShadowMap;
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 6000;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 2;
    this.scene.add(this.hemi, this.sun, this.sun.target);

    this.hf = opts.heightfield ?? null;
    const hf = this.hf;
    this.ground = hf ? (x, y) => heightAt(hf, x, y) : () => 0;
    this.world = opts.prebuilt?.world ?? buildWorld(map, hf);
    this.world.group.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      o.receiveShadow = true;
      // Decals (streets, sidewalks, paint — polygonOffset materials) hug the
      // terrain within centimeters, far below the shadow map's depth
      // resolution: letting them cast just shadow-acnes the ground black.
      const m = o.material as THREE.Material;
      o.castShadow = !("polygonOffset" in m && m.polygonOffset);
    });
    this.scene.add(this.world.group);
    this.props = opts.prebuilt?.props ?? buildProps(map, hf);
    this.scene.add(this.props.group, this.props.glow);
    this.landmarks = opts.prebuilt?.landmarks ?? buildLandmarks(map, hf);
    this.scene.add(this.landmarks.group);
    this.actors = new Actors(map, hf);
    this.scene.add(this.actors.group);

    // Disaster sim: fires, spread, destruction — wired into dispatch both
    // ways (real fires open calls; dispatch fire incidents ignite for real).
    this.fire = new FireSim(map, hf, this.world.shells);
    this.fire.addPropSet(this.props);
    this.scene.add(this.fire.group);
    this.fire.onNewFire = (x, y) => this.actors.reportFire(x, y, this.ground(x, y));
    this.fire.onCollapse = (bi) => this.fpv?.markCollapsed(bi);
    this.actors.hasFireNear = (x, y, r) => this.fire.hasFireNear(x, y, r);
    this.actors.onFireIncident = (x, y) => this.fire.igniteNear(x, y, 90);
    this.actors.onTankFire = (x, y) => {
      const bi = this.fire.randomTargetNear(x, y, 45, 320);
      if (bi < 0) return;
      const c = this.fire.centerOf(bi);
      this.fire.flash(x, y, this.ground(x, y) + 2.4, 8);
      window.setTimeout(() => {
        this.fire.explosion(c.x, c.y, c.z, 13, 4.2);
        if (this.fpvOn && this.fpv) {
          const d = Math.hypot(c.x - this.fpv.x, c.y - this.fpv.y);
          if (d < 1500) this.boom(Math.min(0.5, 320 / (d + 120)), 70);
          this.shake = Math.min(1, this.shake + Math.min(0.7, 260 / (d + 60)));
        }
      }, 450);
    };

    this.rig = new CameraRig(map);
    this.rig.viewHeight = START_VIEW;

    // Spectator delegate: everything is map navigation; command hooks no-op.
    const delegate: ControlDelegate = {
      isStrategic: () => true,
      selectAt: () => {},
      marqueeSelect: () => {},
      dispatchAt: () => {},
      deselect: () => {},
      zoomAt: (cx, cy, factor) => {
        const before = this.toWorld(cx, cy);
        this.rig.zoomBy(factor);
        this.applyCamera();
        const after = this.toWorld(cx, cy);
        if (before && after) {
          this.rig.target.x += before.x - after.x;
          this.rig.target.y += before.y - after.y;
          this.rig.clampToMap(map);
        }
      },
    };
    this.controls = new Controls(canvas, this.rig, map, delegate);

    const parent = canvas.parentElement ?? document.body;
    this.minimap = new Minimap(map, parent, (x, y) => {
      this.rig.target = { x, y };
    });
    this.compass = document.createElement("div");
    this.compass.id = "compass";
    this.compass.innerHTML = "<span>N</span>";
    this.compass.addEventListener("click", () => {
      if (this.fpvOn && this.fpv) {
        this.fpv.yaw = Math.round(this.fpv.yaw / (2 * Math.PI)) * 2 * Math.PI;
      } else {
        this.controls.faceNorth();
      }
    });
    parent.appendChild(this.compass);

    this.map = map;
    this.fpvHint = document.createElement("div");
    this.fpvHint.id = "fpvhint";
    parent.appendChild(this.fpvHint);
    this.fadeEl = document.createElement("div");
    this.fadeEl.id = "modefade";
    parent.appendChild(this.fadeEl);
    this.hudClock = document.createElement("div");
    this.hudClock.id = "hudclock";
    this.hudClock.title = "Advance 3 hours";
    this.hudClock.addEventListener("click", () => {
      this.daynight.offsetT = (this.daynight.offsetT + 3 / 24) % 1;
    });
    parent.appendChild(this.hudClock);
    this.hudScale = document.createElement("div");
    this.hudScale.id = "hudscale";
    this.hudScaleBar = document.createElement("div");
    this.hudScaleBar.className = "bar";
    this.hudScaleLabel = document.createElement("span");
    this.hudScale.append(this.hudScaleBar, this.hudScaleLabel);
    parent.appendChild(this.hudScale);
    this.wireFpvInput();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();

    this.lastFrame = performance.now();
    requestAnimationFrame(() => this.frame());
  }

  /** Client (CSS-pixel) position -> world meters: terrain raymarch when a
   * heightfield is loaded, flat ground plane otherwise. */
  toWorld(clientX: number, clientY: number): { x: number; y: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    if (this.hf) {
      const o = this.raycaster.ray.origin;
      const d = this.raycaster.ray.direction;
      const hit = raycastHeightfield(
        this.hf,
        { x: o.x, y: -o.z, z: o.y },
        { x: d.x, y: -d.z, z: d.y },
      );
      return hit ? { x: hit.x, y: hit.y } : null;
    }
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, hit)) return null;
    return toWorldXY(hit);
  }

  /** Cut to dark, then fade the new mode in — covers the camera jump (and
   * the one-time collision/props build on first FPV entry). */
  private flashFade(): void {
    const s = this.fadeEl.style;
    s.transition = "none";
    s.opacity = "1";
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        s.transition = "opacity 0.6s ease";
        s.opacity = "0";
      }),
    );
  }

  /** Toggle first-person walk/fly mode at the current camera focus. */
  toggleFpv(): void {
    this.flashFade();
    if (this.fpvOn) {
      this.fpvOn = false;
      if (this.fpv) {
        this.rig.target = { x: this.fpv.x, y: this.fpv.y };
        this.rig.theta = this.fpv.yaw;
        this.rig.viewHeight = 450;
        this.rig.clampToMap(this.map);
      }
      if (document.pointerLockElement === this.canvas) document.exitPointerLock();
      this.controls.active = true;
      this.minimap.el.style.display = "";
      this.hudScale.style.display = "";
      this.hint("", 0);
      return;
    }
    // Lazy: collision index + life-size props are built on first entry.
    if (!this.fpvProps) {
      this.fpvProps = buildProps(this.map, this.hf, 1);
      this.fpvProps.group.visible = false;
      this.fpvProps.glow.visible = false;
      this.fpvProps.setNight(this.daynight.night);
      this.fire.addPropSet(this.fpvProps);
      this.scene.add(this.fpvProps.group, this.fpvProps.glow);
      // Distance-cull registry: 1 km prop/paint tiles vanish once they're too
      // far to read; the altitude fog swallows the transition.
      const seen = new Set<THREE.Object3D>();
      const register = (root: THREE.Object3D, range: number): void => {
        root.traverse((o) => {
          if (!(o instanceof THREE.Mesh) || seen.has(o)) return;
          seen.add(o);
          if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
          const c = o.geometry.boundingSphere!.center;
          this.fpvCull.push({ obj: o, x: c.x, z: c.z, range: range + o.geometry.boundingSphere!.radius });
        });
      };
      register(this.fpvProps.near, 2200); // street furniture: unreadable past 2 km
      register(this.fpvProps.group, 3200); // trees/street lights
      register(this.fpvProps.glow, 3800);
      register(this.world.detail, 2400); // sidewalks/paint
    }
    // Enter skydiving from roughly the map camera's altitude — dramatic from
    // street zoom, capped so strategic view doesn't mean a minute of freefall.
    const dropH = Math.min(600, Math.max(200, this.rig.viewHeight * 1.2));
    if (!this.fpv) {
      this.fpv = new FpvMode(this.map, this.hf, this.rig.target, this.rig.theta, dropH);
      // Buildings that pancaked before FPV existed are already walk-through.
      for (const bi of this.fire.collapsed) this.fpv.markCollapsed(bi);
    } else {
      this.fpv.place(this.rig.target.x, this.rig.target.y, dropH);
      this.fpv.yaw = this.rig.theta;
    }
    this.fpvOn = true;
    this.controls.active = false;
    this.minimap.el.style.display = "none";
    this.hudScale.style.display = "none";
    this.lockPointer();
    this.hint("WASD move · Shift sprint · Space jump · double-Space fly (Space up, C down) · click PUNCH · V exit", 6000);
  }

  /** Anti-hero mode: a punch cracks (and sometimes torches) what's in front
   * of you. A few blows level a house; towers take real work. */
  private punch(): void {
    if (!this.fpv || this.punchCd > 0) return;
    this.punchCd = 0.32;
    const f = this.fpv;
    const dx = -Math.sin(f.yaw);
    const dy = Math.cos(f.yaw);
    for (const reach of [1.6, 3.1, 4.6]) {
      const px = f.x + dx * reach;
      const py = f.y + dy * reach;
      const bi = this.fire.buildingAt(px, py, f.z);
      if (bi < 0) continue;
      this.fire.damageBuilding(bi, 2.3, 0.3, px, py);
      this.fire.flash(px, py, f.z + 1.5, 3.2, 0xffe9c9);
      this.fire.dust(px, py, f.z, 4);
      this.shake = Math.min(1, this.shake + 0.5);
      this.boom(0.22, 110);
      return;
    }
    this.shake = Math.min(1, this.shake + 0.1); // whiff
  }

  /** Short thump — punches and shellfire. */
  private boom(gain: number, freq: number): void {
    try {
      this.boomCtx ??= new AudioContext();
      const t = this.boomCtx.currentTime;
      const o = this.boomCtx.createOscillator();
      o.type = "sine";
      o.frequency.setValueAtTime(freq, t);
      o.frequency.exponentialRampToValueAtTime(28, t + 0.35);
      const g = this.boomCtx.createGain();
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
      o.connect(g).connect(this.boomCtx.destination);
      o.start(t);
      o.stop(t + 0.5);
    } catch {
      /* no audio available */
    }
  }

  /** Lazily built gradient dome that rides on the FPV camera; recolored
   * every frame from the day/night palette. */
  private ensureSky(): THREE.Mesh {
    if (this.sky) return this.sky;
    const geo = new THREE.SphereGeometry(SKY_R, 24, 12);
    const pos = geo.attributes["position"]!;
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3));
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.BackSide,
      fog: false,
      depthWrite: false,
    });
    this.sky = new THREE.Mesh(geo, mat);
    this.sky.renderOrder = -1;
    this.scene.add(this.sky);
    this.recolorSky();
    return this.sky;
  }

  /** Sun/moon: a soft additive billboard riding the sky dome (FPV only). */
  private updateSkyBody(): void {
    if (!this.skyBody) {
      this.skyBodyMat = new THREE.MeshBasicMaterial({
        map: radialGlowTexture(256),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      });
      this.skyBody = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.skyBodyMat);
      this.skyBody.renderOrder = 0; // over the dome, under the world
      this.scene.add(this.skyBody);
    }
    const dn = this.daynight;
    this.skyBody.visible = true;
    const bodyDist = this.camera.far * 0.78;
    this.skyBody.position.copy(this.camera.position).addScaledVector(dn.lightDir, bodyDist);
    this.skyBody.quaternion.copy(this.camera.quaternion);
    const size = bodyDist * (dn.day ? 0.148 : 0.085);
    this.skyBody.scale.set(size, size, 1);
    this.skyBodyMat!.color.copy(dn.lightColor).multiplyScalar(dn.day ? 1 : 1.25);
  }

  private skyColor = new THREE.Color();
  private recolorSky(): void {
    if (!this.sky) return;
    const geo = this.sky.geometry;
    const pos = geo.attributes["position"]!;
    const col = geo.attributes["color"]!;
    const dn = this.daynight;
    const c = this.skyColor;
    for (let i = 0; i < pos.count; i++) {
      const t = Math.max(0, pos.getY(i) / SKY_R); // below horizon stays horizon-colored
      c.copy(dn.horizon).lerp(dn.zenith, Math.pow(t, 0.6));
      col.setXYZ(i, c.r, c.g, c.b);
    }
    col.needsUpdate = true;
  }

  /** Chrome returns a promise that rejects when lock is unavailable
   * (headless, iframe policies) — FPV still works, just without capture. */
  private lockPointer(): void {
    try {
      const p = this.canvas.requestPointerLock() as unknown;
      if (p instanceof Promise) p.catch(() => {});
    } catch {
      /* no pointer capture available */
    }
  }

  private hint(text: string, holdMs: number): void {
    clearTimeout(this.fpvHintTimer);
    if (!text) {
      this.fpvHint.classList.remove("show");
      return;
    }
    this.fpvHint.textContent = text;
    this.fpvHint.classList.add("show");
    if (holdMs > 0) {
      this.fpvHintTimer = window.setTimeout(() => this.fpvHint.classList.remove("show"), holdMs);
    }
  }

  private wireFpvInput(): void {
    const on = <K extends keyof WindowEventMap>(t: Window | Document | HTMLElement, type: string, fn: (e: never) => void): void => {
      t.addEventListener(type, fn as EventListener);
      this.fpvDisposers.push(() => t.removeEventListener(type, fn as EventListener));
    };
    on(window, "keydown", (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k === "v" && !e.repeat) {
        this.toggleFpv();
        return;
      }
      if (k === "t" && !e.repeat) {
        this.daynight.offsetT = (this.daynight.offsetT + 3 / 24) % 1;
        return;
      }
      if (!this.fpvOn || !this.fpv) return;
      if (k === " ") e.preventDefault();
      if (!e.repeat) this.fpv.keyDown(k);
    });
    on(window, "keyup", (e: KeyboardEvent) => {
      this.fpv?.keyUp(e.key.toLowerCase());
    });
    on(window, "blur", () => this.fpv?.releaseKeys());
    on(this.canvas, "mousemove", (e: MouseEvent) => {
      if (this.fpvOn && document.pointerLockElement === this.canvas && this.fpv) {
        this.fpv.look(e.movementX, e.movementY);
      }
    });
    on(this.canvas, "pointerdown", (e: MouseEvent) => {
      if (this.fpvOn) {
        if (document.pointerLockElement !== this.canvas) {
          this.lockPointer();
          return;
        }
        if (e.button === 0) this.punch();
        return;
      }
      // Disaster director: shift+click torches the nearest building.
      if (e.shiftKey) {
        const w = this.toWorld(e.clientX, e.clientY);
        if (w) {
          this.fire.fireball(w.x, w.y);
          this.hint("fireball", 1100);
        }
      }
    });
    on(document, "pointerlockchange", () => {
      if (!this.fpvOn) return;
      if (document.pointerLockElement !== this.canvas) {
        this.fpv?.releaseKeys();
        this.hint("Click to look around · V to exit", 0);
      } else {
        this.hint("", 0);
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const d of this.fpvDisposers) d();
    this.fpvDisposers = [];
    this.actors.dispose();
    this.fpvHint.remove();
    this.fadeEl.remove();
    this.hudClock.remove();
    this.hudScale.remove();
    this.controls.dispose();
    this.minimap.dispose();
    this.compass.remove();
    this.resizeObserver.disconnect();
    this.webgl.dispose();
  }

  private resize(): void {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.webgl.setSize(w, h, false);
  }

  private applyCamera(): void {
    const aspect = (this.canvas.clientWidth || 1) / (this.canvas.clientHeight || 1);
    this.rig.apply(this.camera, aspect, this.ground(this.rig.target.x, this.rig.target.y));
  }

  private frame(): void {
    if (this.disposed) return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    this.daynight.update(Date.now());

    if (this.fpvOn && this.fpv) {
      this.fpv.update(dt);
      // Street level: full detail, street-scale tint, gradient sky + distance
      // haze in the sky's horizon color. Landmark plates are billboards sized
      // for the map view — at eye height they wallpaper the horizon, so off.
      this.world.setBlend(0);
      this.props.group.visible = false;
      this.props.glow.visible = false;
      if (this.fpvProps) {
        this.fpvProps.group.visible = true;
        this.fpvProps.glow.visible = true;
      }
      this.world.detail.visible = true;
      this.landmarks.group.visible = false;
      if (!this.scene.fog) this.scene.fog = new THREE.FogExp2(0x323e55, 0.00008);
      this.ensureSky().visible = true;
      const aspect = (this.canvas.clientWidth || 1) / (this.canvas.clientHeight || 1);
      this.actors.setListener({ x: this.fpv.x, y: this.fpv.y });
      this.actors.update(dt, now / 1000, { x: this.fpv.x, y: this.fpv.y }, this.daynight.night, this.daynight.t * 24);
      this.fire.update(dt, { x: this.fpv.x, y: this.fpv.y }, this.actors.fireUnitsOnScene());
      this.punchCd -= dt;
      // Draw distance scales with altitude: short and hazy at street level
      // (nearby blocks occlude everything anyway), the whole city from the
      // air. Fog density is tied to the far plane so the cutoff hides in haze.
      const altAbove = this.fpv.z - this.ground(this.fpv.x, this.fpv.y);
      const far = Math.min(30000, Math.max(5500, 5500 + altAbove * 55));
      this.fpv.apply(this.camera, aspect, far);
      if (this.shake > 0.002) {
        this.camera.position.x += (Math.random() - 0.5) * this.shake * 0.3;
        this.camera.position.y += (Math.random() - 0.5) * this.shake * 0.3;
        this.camera.rotation.z += (Math.random() - 0.5) * this.shake * 0.022;
        this.shake *= Math.exp(-dt * 5.5);
      }
      (this.scene.fog as THREE.FogExp2).density = 1.7 / far;
      this.sky!.scale.setScalar((far * 0.85) / SKY_R);
      this.compass.style.setProperty("--rot", `${this.fpv.yaw}rad`);
      this.sky!.position.copy(this.camera.position);
      this.updateSkyBody();
      const cx = this.camera.position.x;
      const cz = this.camera.position.z;
      for (const e of this.fpvCull) {
        e.obj.visible = (e.x - cx) ** 2 + (e.z - cz) ** 2 < e.range * e.range;
      }
      this.fpvCullDirty = true;
      this.applyDayNight(this.fpv.x, this.fpv.y, this.fpv.z, true);
      this.webgl.render(this.scene, this.camera);
      requestAnimationFrame(() => this.frame());
      return;
    }
    if (this.scene.fog) this.scene.fog = null;
    if (this.fpvCullDirty) {
      // world.detail children are shared with the map view — restore them.
      for (const e of this.fpvCull) e.obj.visible = true;
      this.fpvCullDirty = false;
    }
    if (this.sky) this.sky.visible = false;
    if (this.skyBody) this.skyBody.visible = false;
    this.props.glow.visible = true;
    if (this.fpvProps) {
      this.fpvProps.group.visible = false;
      this.fpvProps.glow.visible = false;
    }
    this.landmarks.group.visible = true;
    this.controls.update(dt);

    const vh = this.rig.viewHeight;
    this.world.setBlend((vh - BLEND_START) / (BLEND_END - BLEND_START));
    this.props.group.visible = vh < PROPS_VIEW;
    this.props.near.visible = vh < NEAR_PROPS_VIEW;
    this.world.detail.visible = vh < PROPS_VIEW;
    this.landmarks.setViewScale(vh);

    this.applyCamera();

    // HUD: compass needle tracks where world north points on screen.
    this.compass.style.setProperty("--rot", `${this.rig.theta}rad`);
    const rect = this.canvas.getBoundingClientRect();
    const corners = [
      this.toWorld(rect.left, rect.top),
      this.toWorld(rect.right, rect.top),
      this.toWorld(rect.right, rect.bottom),
      this.toWorld(rect.left, rect.bottom),
    ];
    this.minimap.update(corners, []);

    this.actors.setListener(null);
    this.actors.update(dt, now / 1000, this.rig.target, this.daynight.night, this.daynight.t * 24);
    this.fire.update(dt, this.rig.target, this.actors.fireUnitsOnScene());
    this.applyDayNight(this.rig.target.x, this.rig.target.y, this.ground(this.rig.target.x, this.rig.target.y), vh < SHADOW_MAX_VIEW);
    this.updateScaleBar(vh);

    this.webgl.render(this.scene, this.camera);
    requestAnimationFrame(() => this.frame());
  }

  /** Apply the current sun/moon to lights, sky, fog and lamp glow, and re-fit
   * the shadow box around the focus point (fx, fy world meters, fz height). */
  private applyDayNight(fx: number, fy: number, fz: number, shadows: boolean): void {
    const dn = this.daynight;
    this.sun.color.copy(dn.lightColor);
    this.sun.intensity = dn.lightIntensity;
    this.hemi.intensity = dn.hemiIntensity;
    this.hemi.color.copy(dn.zenith).lerp(dn.horizon, 0.5).multiplyScalar(2.2);

    const focus = toScene(fx, fy, fz);
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(dn.lightDir, 2500);
    this.sun.castShadow = shadows;
    if (shadows) {
      // Fit the shadow ortho box to what's on screen (FPV gets a fixed box).
      const half = this.fpvOn ? 700 : Math.min(4500, Math.max(350, this.rig.viewHeight * 1.1));
      const sc = this.sun.shadow.camera;
      if (Math.abs(sc.right - half) > 1) {
        sc.left = -half;
        sc.right = half;
        sc.top = half;
        sc.bottom = -half;
        sc.updateProjectionMatrix();
      }
    }

    (this.scene.background as THREE.Color).copy(dn.fog).multiplyScalar(0.55);
    if (this.scene.fog instanceof THREE.FogExp2) this.scene.fog.color.copy(dn.fog);
    if (this.sky?.visible) this.recolorSky();

    if (Math.abs(dn.night - this.lastNight) > 0.01) {
      this.lastNight = dn.night;
      this.props.setNight(dn.night);
      this.fpvProps?.setNight(dn.night);
    }

    const alt = this.fpvOn ? ` · ▲${Math.round(fz)} m` : "";
    // Focus position, world meters + WGS84 — so a screenshot pins the exact
    // spot for debugging (world x/y feed rig.target / fpv.place directly).
    const o = this.map.meta.origin;
    const lat = o.lat + fy / 111320;
    const lon = o.lon + fx / (111320 * Math.cos((lat * Math.PI) / 180));
    const pos = ` · ${Math.round(fx)}E ${Math.round(fy)}N · ${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    const label = `${dn.day ? "☀" : "☾"} ${dn.clock}${alt}${pos}`;
    if (this.hudClock.textContent !== label) this.hudClock.textContent = label;
  }

  /** Distance scale bar (map view only): a nice round length near 150 px. */
  private updateScaleBar(vh: number): void {
    const mpp = vh / (this.canvas.clientHeight || 1);
    const steps = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
    let d = steps[0]!;
    for (const c of steps) if (c / mpp <= 190) d = c;
    const text = d >= 1000 ? `${d / 1000} km` : `${d} m`;
    if (text !== this.lastScaleText) {
      this.lastScaleText = text;
      this.hudScaleLabel.textContent = text;
    }
    this.hudScaleBar.style.width = `${(d / mpp).toFixed(1)}px`;
  }
}
