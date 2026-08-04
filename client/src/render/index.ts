import * as THREE from "three";
import { ENTITY_RADIUS, TICK_MS, type GameMap, type Snapshot } from "@battle-juice/shared";
import { CameraRig, toWorldXY } from "./camera.js";
import { Controls } from "./controls.js";
import { buildProps } from "./props.js";
import { UnitLayer } from "./units.js";
import { buildWorld } from "./world.js";

export interface RendererOpts {
  /** A move order: the selected squad and a street-snapped-later target. */
  onCommand: (entityId: string, target: { x: number; y: number }) => void;
}

/**
 * Three.js renderer: orthographic tilted camera over the baked map, with
 * drag/WASD pan, wheel zoom, and Q/E snap rotation. Keeps the old renderer's
 * snapshot-interpolation contract (pushSnapshot / prev->curr lerp per tick).
 */
export class Renderer {
  private webgl: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera();
  private rig: CameraRig;
  private controls: Controls;
  private units: UnitLayer;
  private resizeObserver: ResizeObserver;
  private raycaster = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  private prev: Snapshot | null = null;
  private curr: Snapshot | null = null;
  private currAt = 0;
  private lastFrame = 0;
  private disposed = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private myPlayerId: string,
    map: GameMap,
    opts: RendererOpts,
  ) {
    this.webgl = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.webgl.setPixelRatio(window.devicePixelRatio);
    this.scene.background = new THREE.Color(0x14171c);

    const hemi = new THREE.HemisphereLight(0xbfd0e8, 0x33302a, 0.9);
    const sun = new THREE.DirectionalLight(0xfff2dd, 1.4);
    sun.position.set(0.6, 1, 0.35).normalize(); // world-fixed: shading stays put as camera spins
    this.scene.add(hemi, sun);

    this.scene.add(buildWorld(map));
    this.scene.add(buildProps(map));
    this.units = new UnitLayer(myPlayerId);
    this.scene.add(this.units.group);

    this.rig = new CameraRig(map);
    this.controls = new Controls(canvas, this.rig, map, (cx, cy) => {
      const p = this.toWorld(cx, cy);
      if (!p) return;
      // Click near an own squad selects it; otherwise dispatch the selection.
      const pickRadius = Math.max(ENTITY_RADIUS * 2, this.rig.viewHeight * 0.02);
      const picked = this.units.nearestOwn(p.x, p.y, pickRadius);
      if (picked) {
        this.units.setSelected(picked);
      } else {
        const selected = this.units.selected();
        if (selected) opts.onCommand(selected, p);
      }
    });
    window.addEventListener("keydown", this.onKeyDown);

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

  dispose(): void {
    this.disposed = true;
    this.controls.dispose();
    this.resizeObserver.disconnect();
    window.removeEventListener("keydown", this.onKeyDown);
    this.webgl.dispose();
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") this.units.setSelected(null);
  };

  private resize(): void {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.webgl.setSize(w, h, false);
  }

  private frame(): void {
    if (this.disposed) return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    this.controls.update(dt);

    if (this.curr) {
      const t = this.prev ? Math.min(1, (now - this.currAt) / TICK_MS) : 1;
      this.units.sync(this.curr, this.prev, t);
    }

    const aspect = (this.canvas.clientWidth || 1) / (this.canvas.clientHeight || 1);
    this.rig.apply(this.camera, aspect);
    this.webgl.render(this.scene, this.camera);
    requestAnimationFrame(() => this.frame());
  }
}
