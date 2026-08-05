import * as THREE from "three";
import { heightAt, raycastHeightfield, type GameMap, type Heightfield } from "@battle-juice/shared";
import { CameraRig, toWorldXY } from "./camera.js";
import { Controls, type ControlDelegate } from "./controls.js";
import { buildLandmarks, type LandmarkLayer } from "./landmarks.js";
import { Minimap } from "./minimap.js";
import { buildProps } from "./props.js";
import { buildWorld, type WorldLayers } from "./world.js";

// Zoom thresholds (meters of vertical view).
const BLEND_START = 2200; // street tint starts brightening
const BLEND_END = 3200;
const PROPS_VIEW = 3000; // above: hide trees/signs/signals (subpixel anyway)

const START_VIEW = 2600; // spectator reveal: district scale, then explore

export interface PrebuiltLayers {
  world: WorldLayers;
  props: THREE.Group;
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
  private props: THREE.Group;
  private landmarks: LandmarkLayer;
  private minimap: Minimap;
  private compass: HTMLDivElement;
  private resizeObserver: ResizeObserver;
  private raycaster = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  private hf: Heightfield | null;
  private ground: (x: number, y: number) => number;

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
    this.scene.add(this.props);
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

  dispose(): void {
    this.disposed = true;
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

    this.controls.update(dt);

    const vh = this.rig.viewHeight;
    this.world.setBlend((vh - BLEND_START) / (BLEND_END - BLEND_START));
    this.props.visible = vh < PROPS_VIEW;
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
