import * as THREE from "three";
import { ENTITY_RADIUS, TICK_MS, type GameMap, type Snapshot } from "@battle-juice/shared";
import { CameraRig, toWorldXY } from "./camera.js";
import { Controls, type ControlDelegate } from "./controls.js";
import { updateCurvature } from "./curvature.js";
import { Minimap } from "./minimap.js";
import { buildProps } from "./props.js";
import { Sky } from "./sky.js";
import { UnitLayer } from "./units.js";
import { buildWorld, type WorldLayers } from "./world.js";

// Zoom thresholds (meters of vertical view).
const BLEND_START = 2200; // street tint starts brightening
const BLEND_END = 3200;
const PROPS_VIEW = 3000; // above: hide trees/signs/signals (subpixel anyway)
const STRATEGIC_VIEW = 4500; // above: read-only map navigation, no orders

const TACTICAL_HINT =
  "left click/drag select · right click move · WASD pan · wheel zoom · Q/E rotate · R/F tilt · N north";
const STRATEGIC_HINT = "strategic view — zoom in to command · drag/WASD pan · Q/E rotate · R/F tilt · N north";

export interface RendererOpts {
  /** A move order for one selected squad. */
  onCommand: (entityId: string, target: { x: number; y: number }) => void;
}

/**
 * Three.js renderer: orthographic tilt-shift camera over the baked map, with
 * a tactical (command) mode and a read-only strategic mode at far zoom.
 */
export class Renderer {
  readonly playerId: string;

  private webgl: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera();
  private rig: CameraRig;
  private controls: Controls;
  private units: UnitLayer;
  private world: WorldLayers;
  private props: THREE.Group;
  private sky: Sky;
  private minimap: Minimap;
  private compass: HTMLDivElement;
  private hintEl: HTMLElement | null;
  private resizeObserver: ResizeObserver;
  private raycaster = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  private prev: Snapshot | null = null;
  private curr: Snapshot | null = null;
  private currAt = 0;
  private lastFrame = 0;
  private lastHintStrategic: boolean | null = null;
  private disposed = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private myPlayerId: string,
    map: GameMap,
    opts: RendererOpts,
  ) {
    this.playerId = myPlayerId;
    this.webgl = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.webgl.setPixelRatio(window.devicePixelRatio);
    this.scene.background = new THREE.Color(0x14171c);

    const hemi = new THREE.HemisphereLight(0xbfd0e8, 0x33302a, 0.9);
    const sun = new THREE.DirectionalLight(0xfff2dd, 1.4);
    sun.position.set(0.6, 1, 0.35).normalize(); // world-fixed: shading stays put as camera spins
    this.scene.add(hemi, sun);

    this.world = buildWorld(map);
    this.scene.add(this.world.group);
    this.props = buildProps(map);
    this.scene.add(this.props);
    this.units = new UnitLayer(myPlayerId);
    this.scene.add(this.units.group);
    this.sky = new Sky(map);
    this.scene.add(this.sky.group);

    this.rig = new CameraRig(map);

    const delegate: ControlDelegate = {
      isStrategic: () => this.rig.viewHeight > STRATEGIC_VIEW,
      selectAt: (cx, cy) => {
        const p = this.toWorld(cx, cy);
        if (!p) return;
        const pickRadius = Math.max(ENTITY_RADIUS * 2, this.rig.viewHeight * 0.02);
        const picked = this.units.nearestOwn(p.x, p.y, pickRadius);
        this.units.setSelected(picked ? [picked] : []); // off-click deselects
      },
      marqueeSelect: (x0, y0, x1, y1) => {
        const ids: string[] = [];
        const rect = {
          left: Math.min(x0, x1),
          right: Math.max(x0, x1),
          top: Math.min(y0, y1),
          bottom: Math.max(y0, y1),
        };
        for (const u of this.units.ownPositions()) {
          const s = this.toScreen(u.x, u.y);
          if (s && s.x >= rect.left && s.x <= rect.right && s.y >= rect.top && s.y <= rect.bottom) {
            ids.push(u.id);
          }
        }
        if (ids.length) this.units.setSelected(ids);
      },
      dispatchAt: (cx, cy) => {
        const p = this.toWorld(cx, cy);
        if (!p) return;
        for (const id of this.units.selected()) opts.onCommand(id, p);
      },
      deselect: () => this.units.setSelected([]),
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
    this.hintEl = document.getElementById("hint");

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();

    this.lastFrame = performance.now();
    requestAnimationFrame(() => this.frame());
  }

  pushSnapshot(s: Snapshot): void {
    // First snapshot: start the camera on your own unit, not the map center.
    if (!this.curr) {
      const own = s.entities.find((e) => e.ownerId === this.myPlayerId);
      if (own) this.rig.target = { x: own.x, y: own.y };
    }
    this.prev = this.curr;
    this.curr = s;
    this.currAt = performance.now();
  }

  /** Client (CSS-pixel) position -> world meters via ground-plane raycast. */
  toWorld(clientX: number, clientY: number): { x: number; y: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, hit)) return null;
    return toWorldXY(hit);
  }

  /** World meters -> client CSS pixels. */
  private toScreen(x: number, y: number): { x: number; y: number } | null {
    const v = new THREE.Vector3(x, 0, -y).project(this.camera);
    if (v.z > 1) return null;
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: rect.left + ((v.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - v.y) / 2) * rect.height,
    };
  }

  dispose(): void {
    this.disposed = true;
    this.controls.dispose();
    this.minimap.dispose();
    this.compass.remove();
    this.resizeObserver.disconnect();
    this.canvas.style.filter = "";
    this.webgl.dispose();
  }

  private resize(): void {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.webgl.setSize(w, h, false);
  }

  private applyCamera(): void {
    const aspect = (this.canvas.clientWidth || 1) / (this.canvas.clientHeight || 1);
    this.rig.apply(this.camera, aspect);
  }

  private frame(): void {
    if (this.disposed) return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    this.controls.update(dt);

    const vh = this.rig.viewHeight;
    this.world.setBlend((vh - BLEND_START) / (BLEND_END - BLEND_START));
    this.props.visible = vh < PROPS_VIEW;
    this.units.setViewScale(Math.max(1, vh / 800));
    this.sky.update(dt, vh);
    updateCurvature(this.rig.target.x, this.rig.target.y, vh);

    // Strategic-view mode hint.
    const strategic = vh > STRATEGIC_VIEW;
    if (strategic !== this.lastHintStrategic && this.hintEl) {
      this.hintEl.textContent = strategic ? STRATEGIC_HINT : TACTICAL_HINT;
      this.lastHintStrategic = strategic;
    }

    if (this.curr) {
      const t = this.prev ? Math.min(1, (now - this.currAt) / TICK_MS) : 1;
      this.units.sync(this.curr, this.prev, t);
    }

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
    this.minimap.update(corners, this.units.allPositions());

    this.webgl.render(this.scene, this.camera);
    requestAnimationFrame(() => this.frame());
  }
}
