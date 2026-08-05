import * as THREE from "three";
import { heightAt, raycastHeightfield, type GameMap, type Heightfield } from "@battle-juice/shared";
import { CameraRig, toWorldXY } from "./camera.js";
import { Controls, type ControlDelegate } from "./controls.js";
import { FpvMode } from "./fpv.js";
import { buildLandmarks, type LandmarkLayer } from "./landmarks.js";
import { Minimap } from "./minimap.js";
import { buildProps, type PropLayers } from "./props.js";
import { buildWorld, type WorldLayers } from "./world.js";

// Zoom thresholds (meters of vertical view).
const BLEND_START = 2200; // street tint starts brightening
const BLEND_END = 3200;
const PROPS_VIEW = 3000; // above: hide trees/street lights (subpixel anyway)
const NEAR_PROPS_VIEW = 1000; // above: hide small street furniture (signs, hydrants, benches...)

const START_VIEW = 2600; // spectator reveal: district scale, then explore

// FPV atmosphere: dusk gradient sky dome, haze in the horizon color.
const SKY_ZENITH = 0x10151f;
const SKY_HORIZON = 0x39465e;
const FOG_COLOR = 0x323e55;
const SKY_R = 20000; // inside the FPV far plane

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

  private hf: Heightfield | null;
  private ground: (x: number, y: number) => number;

  private map: GameMap;
  private sky: THREE.Mesh | null = null;
  private fpvProps: PropLayers | null = null;
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

    const hemi = new THREE.HemisphereLight(0xbfd0e8, 0x33302a, 0.9);
    const sun = new THREE.DirectionalLight(0xfff2dd, 1.4);
    sun.position.set(0.6, 1, 0.35).normalize(); // world-fixed: shading stays put as camera spins
    this.scene.add(hemi, sun);

    this.hf = opts.heightfield ?? null;
    const hf = this.hf;
    this.ground = hf ? (x, y) => heightAt(hf, x, y) : () => 0;
    this.world = opts.prebuilt?.world ?? buildWorld(map, hf);
    this.scene.add(this.world.group);
    this.props = opts.prebuilt?.props ?? buildProps(map, hf);
    this.scene.add(this.props.group);
    this.landmarks = opts.prebuilt?.landmarks ?? buildLandmarks(map, hf);
    this.scene.add(this.landmarks.group);

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
    this.compass.addEventListener("click", () => this.controls.faceNorth());
    parent.appendChild(this.compass);

    this.map = map;
    this.fpvHint = document.createElement("div");
    this.fpvHint.id = "fpvhint";
    parent.appendChild(this.fpvHint);
    this.fadeEl = document.createElement("div");
    this.fadeEl.id = "modefade";
    parent.appendChild(this.fadeEl);
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
      this.compass.style.display = "";
      this.hint("", 0);
      return;
    }
    // Lazy: collision index + life-size props are built on first entry.
    if (!this.fpvProps) {
      this.fpvProps = buildProps(this.map, this.hf, 1);
      this.fpvProps.group.visible = false;
      this.scene.add(this.fpvProps.group);
    }
    // Enter skydiving from roughly the map camera's altitude — dramatic from
    // street zoom, capped so strategic view doesn't mean a minute of freefall.
    const dropH = Math.min(600, Math.max(200, this.rig.viewHeight * 1.2));
    if (!this.fpv) {
      this.fpv = new FpvMode(this.map, this.hf, this.rig.target, this.rig.theta, dropH);
    } else {
      this.fpv.place(this.rig.target.x, this.rig.target.y, dropH);
      this.fpv.yaw = this.rig.theta;
    }
    this.fpvOn = true;
    this.controls.active = false;
    this.minimap.el.style.display = "none";
    this.compass.style.display = "none";
    this.lockPointer();
    this.hint("WASD move · Shift sprint · Space jump · double-Space fly (Space up, C down) · V exit", 6000);
  }

  /** Lazily built gradient dome that rides on the FPV camera. */
  private ensureSky(): THREE.Mesh {
    if (this.sky) return this.sky;
    const geo = new THREE.SphereGeometry(SKY_R, 24, 12);
    const pos = geo.attributes["position"]!;
    const colors = new Float32Array(pos.count * 3);
    const zen = new THREE.Color(SKY_ZENITH);
    const hor = new THREE.Color(SKY_HORIZON);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const t = Math.max(0, pos.getY(i) / SKY_R); // below horizon stays horizon-colored
      c.copy(hor).lerp(zen, Math.pow(t, 0.6));
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.BackSide,
      fog: false,
      depthWrite: false,
    });
    this.sky = new THREE.Mesh(geo, mat);
    this.sky.renderOrder = -1;
    this.scene.add(this.sky);
    return this.sky;
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
    on(this.canvas, "pointerdown", () => {
      if (this.fpvOn && document.pointerLockElement !== this.canvas) this.lockPointer();
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
    this.fpvHint.remove();
    this.fadeEl.remove();
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

    if (this.fpvOn && this.fpv) {
      this.fpv.update(dt);
      // Street level: full detail, street-scale tint, dusk sky + distance
      // haze in the sky's horizon color. Landmark plates are billboards sized
      // for the map view — at eye height they wallpaper the horizon, so off.
      this.world.setBlend(0);
      this.props.group.visible = false;
      if (this.fpvProps) this.fpvProps.group.visible = true;
      this.world.detail.visible = true;
      this.landmarks.group.visible = false;
      if (!this.scene.fog) this.scene.fog = new THREE.FogExp2(FOG_COLOR, 0.00008);
      this.ensureSky().visible = true;
      const aspect = (this.canvas.clientWidth || 1) / (this.canvas.clientHeight || 1);
      this.fpv.apply(this.camera, aspect);
      this.sky!.position.copy(this.camera.position);
      this.webgl.render(this.scene, this.camera);
      requestAnimationFrame(() => this.frame());
      return;
    }
    if (this.scene.fog) this.scene.fog = null;
    if (this.sky) this.sky.visible = false;
    if (this.fpvProps) this.fpvProps.group.visible = false;
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

    this.webgl.render(this.scene, this.camera);
    requestAnimationFrame(() => this.frame());
  }
}
