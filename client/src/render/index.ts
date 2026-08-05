import * as THREE from "three";
import { ENTITY_RADIUS, SQUAD_POP, SQUAD_SPACING, TICK_MS, type GameMap, type Snapshot } from "@battle-juice/shared";
import { CameraRig, toWorldXY } from "./camera.js";
import { Controls, type ControlDelegate } from "./controls.js";
import { buildLandmarks, type LandmarkLayer } from "./landmarks.js";
import { Minimap } from "./minimap.js";
import { buildProps } from "./props.js";
import { UnitLayer } from "./units.js";
import { buildWorld, type WorldLayers } from "./world.js";

// Zoom thresholds (meters of vertical view).
const BLEND_START = 2200; // street tint starts brightening
const BLEND_END = 3200;
const PROPS_VIEW = 3000; // above: hide trees/signs/signals (subpixel anyway)
const STRATEGIC_VIEW = 4500; // above: read-only map navigation, no orders

export interface PrebuiltLayers {
  world: WorldLayers;
  props: THREE.Group;
  landmarks: LandmarkLayer;
}

export interface RendererOpts {
  /** A move order for one selected squad. */
  onCommand: (entityId: string, target: { x: number; y: number }) => void;
  /** World geometry built ahead of join (login-screen time); reused on rejoin. */
  prebuilt?: PrebuiltLayers;
}

/**
 * Three.js renderer: perspective tilted camera over the baked map, with a
 * tactical (command) mode and a read-only strategic mode at far zoom.
 */
export class Renderer {
  readonly playerId: string;

  private webgl: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera();
  private rig: CameraRig;
  private controls: Controls;
  private units: UnitLayer;
  private world: WorldLayers;
  private props: THREE.Group;
  private landmarks: LandmarkLayer;
  private minimap: Minimap;
  private compass: HTMLDivElement;
  private hud: HTMLDivElement;
  private hudSig = "";
  private resizeObserver: ResizeObserver;
  private raycaster = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  private prev: Snapshot | null = null;
  private curr: Snapshot | null = null;
  private currAt = 0;
  private lastFrame = 0;
  private lastStrategic: boolean | null = null;
  private disposed = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private myPlayerId: string,
    map: GameMap,
    opts: RendererOpts,
  ) {
    this.playerId = myPlayerId;
    // Log depth: a perspective frustum spanning tens of km would otherwise
    // z-fight the street ribbons floating 0.1 m over the ground.
    this.webgl = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
    this.webgl.setPixelRatio(window.devicePixelRatio);
    this.scene.background = new THREE.Color(0x14171c);

    const hemi = new THREE.HemisphereLight(0xbfd0e8, 0x33302a, 0.9);
    const sun = new THREE.DirectionalLight(0xfff2dd, 1.4);
    sun.position.set(0.6, 1, 0.35).normalize(); // world-fixed: shading stays put as camera spins
    this.scene.add(hemi, sun);

    this.world = opts.prebuilt?.world ?? buildWorld(map);
    this.scene.add(this.world.group);
    this.props = opts.prebuilt?.props ?? buildProps(map);
    this.scene.add(this.props);
    this.landmarks = opts.prebuilt?.landmarks ?? buildLandmarks(map);
    this.scene.add(this.landmarks.group);
    this.units = new UnitLayer(myPlayerId);
    this.scene.add(this.units.group);

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
        // Multi-squad orders fan out around the click (sunflower slots) so
        // squads arrive as a dispersed crowd instead of a stack.
        const ids = this.units.selected();
        ids.forEach((id, i) => {
          const r = i === 0 ? 0 : SQUAD_SPACING * 1.4 * Math.sqrt(i);
          const a = i * 2.39996;
          opts.onCommand(id, { x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r });
        });
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
    this.hud = document.createElement("div");
    this.hud.id = "hud";
    parent.appendChild(this.hud);

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
    this.hud.remove();
    this.resizeObserver.disconnect();
    this.canvas.style.filter = "";
    this.webgl.dispose();
  }

  private resize(): void {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.webgl.setSize(w, h, false);
  }

  /** Bottom-of-screen roster: one avatar card per selected squad. Rebuilt
   * only when the selection or a head count changes. */
  private updateHud(): void {
    const squads = this.units.selectedInfo();
    const sig = squads.map((s) => `${s.id}:${s.pop}`).join("|");
    if (sig === this.hudSig) return;
    this.hudSig = sig;
    this.hud.replaceChildren();
    for (const s of squads) {
      const card = document.createElement("div");
      card.className = "hud-card";
      card.appendChild(avatarCanvas(s.color));
      const info = document.createElement("div");
      const name = document.createElement("div");
      name.className = "hud-name";
      name.textContent = s.name;
      const pop = document.createElement("div");
      pop.className = "hud-pop";
      pop.textContent = `${s.pop} / ${SQUAD_POP}`;
      const bar = document.createElement("div");
      bar.className = "hud-bar";
      const fill = document.createElement("div");
      fill.style.width = `${Math.round((s.pop / SQUAD_POP) * 100)}%`;
      fill.style.background = s.pop > SQUAD_POP / 2 ? "#3ecf6a" : s.pop > SQUAD_POP / 4 ? "#e6b93e" : "#ff5f4f";
      bar.appendChild(fill);
      info.append(name, pop, bar);
      card.appendChild(info);
      // Clicking a card narrows the selection to that one squad.
      card.addEventListener("pointerdown", () => this.units.setSelected([s.id]));
      this.hud.appendChild(card);
    }
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
    this.landmarks.setViewScale(vh);

    // Cursor telegraphs whether commands are possible at this zoom
    // (grab = navigate-only strategic view).
    const strategic = vh > STRATEGIC_VIEW;
    if (strategic !== this.lastStrategic) {
      this.canvas.style.cursor = strategic ? "grab" : "crosshair";
      this.lastStrategic = strategic;
    }

    if (this.curr) {
      const t = this.prev ? Math.min(1, (now - this.currAt) / TICK_MS) : 1;
      this.units.sync(this.curr, this.prev, t);
    }
    this.updateHud();

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

/** Little stick-figure portrait in the squad's color, for HUD cards. */
function avatarCanvas(color: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.className = "hud-avatar";
  c.width = 44;
  c.height = 56;
  const ctx = c.getContext("2d")!;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(22, 12, 7, 0, Math.PI * 2); // head
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(22, 19);
  ctx.lineTo(22, 36); // torso
  ctx.moveTo(22, 24);
  ctx.lineTo(11, 32); // arms
  ctx.moveTo(22, 24);
  ctx.lineTo(33, 32);
  ctx.moveTo(22, 36);
  ctx.lineTo(14, 51); // legs
  ctx.moveTo(22, 36);
  ctx.lineTo(30, 51);
  ctx.stroke();
  return c;
}
