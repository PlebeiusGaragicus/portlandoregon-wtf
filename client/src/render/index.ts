import * as THREE from "three";
import {
  findTile,
  heightAt,
  raycastHeightfield,
  tileKeyAt,
  worldToLatLon,
  type BuildingStore,
  type CityLod,
  type LayerStores,
  type PropStore,
  type StreetStore,
  type GameMap,
  type Heightfield,
} from "@battle-juice/shared";
import { Actors } from "./actors.js";
import {
  CameraRig,
  OVERVIEW_ORTHO_START,
  OVERVIEW_TRANSITION_START,
  toScene,
  toWorldXY,
  type CameraCoverage,
} from "./camera.js";
import { Controls, type ControlDelegate } from "./controls.js";
import { DayNight } from "./daynight.js";
import { HANDHELD as DEVICE_HANDHELD } from "../device.js";
import { FireSim } from "./fire.js";
import { buildCityModel, type CityModel } from "../city.js";
import { FpvMode } from "./fpv.js";
import { buildLandmarks, type LandmarkLayer } from "./landmarks.js";
import { Minimap } from "./minimap.js";
import { buildProps, radialGlowTexture, type PropLayers } from "./props.js";
import { TileScheduler } from "./tile-scheduler.js";
import {
  buildWorld,
  type BuildingTileStats,
  type TileCacheStats,
  type WorldLayers,
} from "./world.js";
import { createViewSaver, restoreView } from "../view.js";
import type { OverviewAtlasSource } from "../overview-atlas.js";
import {
  buildOverview,
  resolveZoomTierVisibility,
  type OverviewGameplayMarker,
  type OverviewLayer,
  type ZoomTierVisibility,
} from "./overview.js";

/** Release every currently attached Three.js resource exactly once. Detached
 * streaming caches expose their own dispose methods. */
function disposeTree(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse((o) => {
    if (o instanceof THREE.InstancedMesh) o.dispose();
    if (!(o instanceof THREE.Mesh || o instanceof THREE.Line || o instanceof THREE.Points || o instanceof THREE.Sprite)) return;
    if ("geometry" in o && o.geometry instanceof THREE.BufferGeometry) geometries.add(o.geometry);
    const own = Array.isArray(o.material) ? o.material : [o.material];
    for (const material of own) {
      if (!(material instanceof THREE.Material)) continue;
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
      if (material instanceof THREE.ShaderMaterial) {
        for (const uniform of Object.values(material.uniforms)) {
          if (uniform.value instanceof THREE.Texture) textures.add(uniform.value);
        }
      }
    }
  });
  for (const texture of textures) texture.dispose();
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
}

// Zoom thresholds (meters of vertical view).
const BLEND_START = 2200; // street tint starts brightening
const BLEND_END = 3200;
/** Atlas ground is fully established before urban massing starts to fade in. */
const OVERVIEW_GROUND_START = OVERVIEW_TRANSITION_START * 0.65;
/** Also prevents a late async atlas load from appearing in one frame. */
const OVERVIEW_READY_FADE_SECONDS = 0.6;

const SKY_R = 20000; // FPV sky dome radius, inside the FPV far plane
/** Desktop shadow cutoff: above this the shadows are subpixel, so skip the
 * pass. DETAIL.shadowView carries the per-device value. */
const SHADOW_MAX_VIEW = 8000;
/**
 * Building detail tiers.
 *
 * The whole city is ALWAYS drawn — every building, to the horizon — as one
 * instanced-box draw call costing ~48 MB. Full prisms, which are ~57 vertices
 * each and 1.1 GB for the city, exist only for the tiles you are close enough
 * to tell the difference on.
 *
 * So these thresholds are not a visibility budget; they only decide where the
 * boxes get upgraded to real geometry. Zooming out never removes the city:
 * the box tier stays on until DETAIL.farTextureView, where a runtime-baked
 * overhead photograph of those same boxes takes over (see syncImpostor).
 */
const PRISM_NEAR_VIEW = 1200; // below: 5x5 km of full prisms
const PRISM_FAR_VIEW = 3000; // below: 3x3. above: boxes alone read fine
const HANDHELD = DEVICE_HANDHELD;
/**
 * How much city to keep built, and how fast to build it.
 *
 * One tunable, chosen once from what the device is, rather than a mobile
 * branch through the renderer: the same code runs everywhere and only these
 * numbers move. A handheld keeps a smaller window and fills it more slowly —
 * it has a fraction of the memory bandwidth and no fan.
 *
 * `prism` is the full-geometry radius (boxes cover the rest of the city
 * regardless). `dressing` and `props` are gated by `propsView`; props
 * deliberately runs wider than that gate so trees are never seen appearing.
 *
 * `perFrame` is the ration. A 5x5 window is 25 tiles; building it in one go
 * blocks for seconds on a phone, so it arrives over a second or two instead,
 * nearest first.
 */
const DETAIL = HANDHELD
  ? {
      prism: 1,
      dressing: 1,
      props: 2,
      // The gates move with the windows. A window tighter than the gate that
      // draws it is exactly how you get things popping in at a boundary, so
      // these two numbers are set together or not at all.
      propsView: 1400,
      nearPropsView: 700,
      perFrame: { buildings: 1, dressing: 1, props: 1 },
      // A shadow pass re-renders every resident mesh into the map. At 2048
      // that is four times the fill of 1024 for a difference you cannot see
      // on a 6-inch screen, and fill rate is exactly what makes a phone hot.
      shadowMap: 1024,
      // Shadows are subpixel long before this, and the pass is the single
      // most expensive thing a frame does.
      shadowView: 2500,
      // A phone submitting the whole city as boxes is the thing the streaming
      // work exists to avoid, so the flat far texture takes over earlier —
      // trading some wide-zoom sharpness (2048 px across a 43 km map) for a
      // frame that is one textured quad instead of 6.5M triangles.
      farTextureView: 6500,
      farTextureSize: 2048,
      // 30 fps. The scene is a strategy map, not a shooter, and halving the
      // frame rate roughly halves the GPU energy per second — the thing the
      // phone was reporting as heat and stutter.
      // Ask slightly below two 60 Hz ticks so timer jitter cannot turn the
      // cap into an accidental 20 fps cadence.
      frameGapMs: 1000 / 35,
    }
  : {
      prism: 2,
      dressing: 2,
      props: 4,
      propsView: 3000,
      nearPropsView: 1000,
      perFrame: { buildings: 2, dressing: 2, props: 4 },
      shadowMap: 2048,
      shadowView: SHADOW_MAX_VIEW,
      // Minimum span where a 4096-texel fallback has enough resolution. The
      // actual swap is delayed to the dynamic top-down handoff.
      farTextureView: 11000,
      farTextureSize: 4096,
      frameGapMs: 0,
    };

const BYTE_BUDGETS = HANDHELD
  ? {
      buildings: 128 * 1024 * 1024,
      dressing: 48 * 1024 * 1024,
      terrain: 32 * 1024 * 1024,
      props: 48 * 1024 * 1024,
      completed: 24 * 1024 * 1024,
      uploadPerFrame: 4 * 1024 * 1024,
    }
  : {
      buildings: 256 * 1024 * 1024,
      dressing: 96 * 1024 * 1024,
      terrain: 64 * 1024 * 1024,
      props: 96 * 1024 * 1024,
      completed: 64 * 1024 * 1024,
      uploadPerFrame: 8 * 1024 * 1024,
    };

/**
 * Render scale, capped.
 *
 * A 3x phone renders nine pixels for every one it can show a difference at,
 * and every one of them costs fill rate, power and heat — the reported iPhone
 * viewport is 390x844 at 3x, which is 2.96M pixels per frame. At this art
 * style (flat-shaded blocks, no fine texture detail) the third factor buys
 * nothing you can see and costs everything you can feel.
 *
 * 2x is still retina-sharp for edges, which is all this scene has.
 */
/** Milliseconds per frame given to the unfinished world build. Small enough
 * that the camera stays smooth while the city arrives. */
const BOOT_BUDGET_MS = HANDHELD ? 6 : 10;

const MAX_PIXEL_RATIO = 2;
function pixelRatio(): number {
  return Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
}

/** See Renderer.impostor. */
interface ImpostorRig {
  target: THREE.WebGLRenderTarget;
  camera: THREE.OrthographicCamera;
  scene: THREE.Scene;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
}

export interface PrebuiltLayers {
  world: WorldLayers;
  props: PropLayers;
  landmarks: LandmarkLayer;
}

export interface RendererOpts {
  /** World geometry built ahead of time (loading-screen time). */
  prebuilt?: PrebuiltLayers;
  /**
   * Remaining world build, drained from the frame loop.
   *
   * `prebuilt.world` from {@link beginWorld} is renderable but empty of
   * terrain and streets; this is the rest of it. The renderer spends a slice
   * of every frame on it until it runs out, so the city fills in while the
   * page is already interactive instead of before it exists.
   */
  boot?: Generator<string, void, void>;
  /** Called with the phase name each time the boot generator advances, and
   * with null when it finishes. Feeds the boot console. */
  onBootProgress?: (phase: string | null) => void;
  /** Terrain heightfield; absent = flat ground. */
  heightfield?: Heightfield | null;
  /** Prebuilt city model. Must be the same one `prebuilt.world` was built
   * from — the sim and the geometry have to agree on where the ground is. */
  city?: CityModel;
  /**
   * Optional atlas request started by main before tactical construction.
   * The renderer never awaits it; failure leaves the existing fallback tiers.
   */
  overview?: Promise<OverviewAtlasSource | null>;
}

export interface RendererDebugStats {
  booting: boolean;
  paused: boolean;
  fpv: boolean;
  view: { x: number; y: number; height: number };
  overview: { ready: boolean; coverage: number; transition: number; orthographic: boolean; complete: boolean };
  render: { frame: number; calls: number; triangles: number; points: number; lines: number };
  memory: { geometries: number; textures: number };
  buildings: BuildingTileStats;
  dressing: TileCacheStats;
  terrain: TileCacheStats;
  props: {
    tiles: number;
    instances: number;
    matrixBytes: number;
    residentBytes: number;
    uploadBytes: number;
    evicted: number;
  };
  fire: { active: number; collapsed: number };
  /** Cumulative CPU wall times. Benchmark snapshots subtract these counters. */
  timing: {
    frames: number;
    totalMs: number;
    maxFrameMs: number;
    bootMs: number;
    tileSyncMs: number;
    actorsMs: number;
    fireMs: number;
    drawMs: number;
  };
  /** Cumulative cache activity available from today's synchronous cache APIs. */
  cache: {
    syncs: number;
    windowChanges: number;
    buildingTilesBuilt: number;
    buildingTilesEvicted: number;
    propChanges: number;
    impostorBakes: number;
  };
  scheduler: ReturnType<TileScheduler["stats"]>;
}

export interface DebugFireScenario {
  ignited: number[];
  damaged: number[];
  activeBefore: number;
  activeAfter: number;
}

/**
 * Three.js renderer: a tilted perspective tactical camera that continuously
 * becomes a fit-city top-down orthographic overview.
 */
export class Renderer {
  private webgl: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private perspectiveCamera = new THREE.PerspectiveCamera();
  private overviewCamera = new THREE.OrthographicCamera();
  private camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = this.perspectiveCamera;
  private rig: CameraRig;
  private saveView: () => void;
  /** Wall-clock of the last camera-position write; throttled, see frame(). */
  private lastViewSave = 0;
  private onPageHide: () => void;
  private onPageShow: () => void;
  private onVisibilityChange: () => void;
  private onContextLost: (event: Event) => void;
  private onContextRestored: () => void;
  private controls: Controls;
  private world: WorldLayers;
  private props: PropLayers;
  private landmarks: LandmarkLayer;
  private minimap: Minimap;
  private compass: HTMLDivElement;
  private resizeObserver: ResizeObserver;
  private raycaster = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  /** Full-city raster layers; optional, with tactical rendering as fallback. */
  readonly overview: OverviewLayer;
  private overviewReady = false;
  private overviewReveal = 0;
  private cameraMetrics: CameraCoverage | null = null;
  private overviewComplete = false;
  private nextOverviewMarkerUpdate = 0;

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
  private city: CityModel;
  /** Last synced tile window, so the sync early-outs when nothing moved. */
  private tileCx = NaN;
  private tileCy = NaN;
  private tileRadius = -1;
  private tileDetailRadius = -2;
  private tilePropRadius = -2;
  private wantBuildings: number[] = [];
  private wantDressing: number[] = [];
  private wantProps: number[] = [];
  private tileScheduler = new TileScheduler();
  private ground: (x: number, y: number) => number;

  private map: GameMap;
  private sky: THREE.Mesh | null = null;
  private skyBody: THREE.Mesh | null = null;
  private skyBodyMat: THREE.MeshBasicMaterial | null = null;
  private fpvProps: PropLayers | null = null;
  /** FPV distance culling: small geometry hidden past its threshold. */
  private fpv: FpvMode | null = null;
  private fpvOn = false;
  private fpvHint: HTMLDivElement;
  private fadeEl: HTMLDivElement;
  private fpvHintTimer = 0;
  private fpvDisposers: (() => void)[] = [];
  /** Drag-to-look state, used whenever pointer lock is not in effect. */
  private fpvDrag: { id: number; x: number; y: number; moved: boolean } | null = null;

  private lastFrame = 0;
  /** When the last frame was actually rendered, for the frame-rate cap. */
  private lastRender = 0;
  private qualityScale = 1;
  private adaptiveFrameGap = DETAIL.frameGapMs;
  private slowFrames = 0;
  private fastFrames = 0;
  private lastQualityChange = 0;
  /** True while the tab is hidden and the loop has stopped scheduling. */
  private paused = false;
  /** The one scheduled main-loop callback. Tracking it prevents duplicate
   * loops across visibility and bfcache transitions. */
  private rafId: number | null = null;
  private disposed = false;
  /** Remaining world build; null once drained. See pourWorld. */
  private boot: Generator<string, void, void> | null = null;
  private bootPhase: string | null = null;
  private onBootProgress?: (phase: string | null) => void;
  private debugTiming = {
    frames: 0,
    totalMs: 0,
    maxFrameMs: 0,
    bootMs: 0,
    tileSyncMs: 0,
    actorsMs: 0,
    fireMs: 0,
    drawMs: 0,
  };
  private debugCache = {
    syncs: 0,
    windowChanges: 0,
    buildingTilesBuilt: 0,
    buildingTilesEvicted: 0,
    propChanges: 0,
    impostorBakes: 0,
  };

  /**
   * Offscreen rig that photographs the far box tier straight down, so wide
   * zoom can draw one textured quad instead of 538k boxes. Built lazily on
   * the first approach to DETAIL.farTextureView; null until then.
   */
  private impostor: ImpostorRig | null = null;
  /** Day/night cycle position the current bake was lit for. */
  private impostorBakedT = -1;
  /** buildings.farVersion() at bake time — damage/boot-fill staleness. */
  private impostorBakedVersion = -1;
  private lastImpostorBake = -Infinity;

  constructor(
    private canvas: HTMLCanvasElement,
    map: GameMap,
    private store: BuildingStore,
    private propStore: PropStore,
    private layers: LayerStores,
    private streetStore: StreetStore,
    private cityLod: CityLod,
    opts: RendererOpts = {},
  ) {
    // Log depth: a perspective frustum spanning tens of km would otherwise
    // z-fight the street ribbons floating just over the ground.
    this.webgl = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
    this.webgl.setPixelRatio(pixelRatio() * this.qualityScale);
    this.scene.background = new THREE.Color(0x14171c);
    this.overview = buildOverview({
      source: opts.overview ?? Promise.resolve(null),
      map: {
        name: map.meta.name,
        sourceDate: map.meta.sourceDate,
        width: map.meta.width,
        height: map.meta.height,
      },
      handheld: HANDHELD,
      maxTextureSize: this.webgl.capabilities.maxTextureSize,
      maxAnisotropy: this.webgl.capabilities.getMaxAnisotropy(),
      landmarks: map.landmarks ?? [],
    });
    this.overview.group.visible = false;
    this.scene.add(this.overview.group);
    void this.overview.ready.then((ready) => {
      if (!this.disposed) this.overviewReady = ready;
    });

    this.hemi = new THREE.HemisphereLight(0xbfd0e8, 0x33302a, 0.9);
    this.sun = new THREE.DirectionalLight(0xfff2dd, 1.4);
    // Shadows: one directional (sun or moon) with an ortho box re-fit around
    // the camera focus every frame — city-wide maps can't fit one shadow map.
    this.webgl.shadowMap.enabled = true;
    this.webgl.shadowMap.type = THREE.PCFShadowMap;
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(DETAIL.shadowMap, DETAIL.shadowMap);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 6000;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 2;
    this.scene.add(this.hemi, this.sun, this.sun.target);

    this.boot = opts.boot ?? null;
    this.onBootProgress = opts.onBootProgress;
    this.hf = opts.heightfield ?? null;
    const hf = this.hf;
    this.ground = hf ? (x, y) => heightAt(hf, x, y) : () => 0;
    this.city = opts.city ?? buildCityModel(store, hf);
    this.world = opts.prebuilt?.world ?? buildWorld(map, store, layers, hf, this.city, true, streetStore, cityLod);
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
    this.props = opts.prebuilt?.props ?? buildProps(map, this.propStore, hf);
    this.scene.add(this.props.group, this.props.glow);
    this.landmarks = opts.prebuilt?.landmarks ?? buildLandmarks(map, store, hf);
    this.scene.add(this.landmarks.group);
    this.actors = new Actors(map, hf, streetStore);
    this.scene.add(this.actors.group);

    // Disaster sim: fires, spread, destruction — wired into dispatch both
    // ways (real fires open calls; dispatch fire incidents ignite for real).
    this.fire = new FireSim(map, store, propStore, hf, this.city, this.world.shells);
    this.fire.addPropSet(this.props);
    this.scene.add(this.fire.group);
    this.fire.onNewFire = (x, y) => this.actors.reportFire(x, y, this.ground(x, y));
    this.fire.onCollapse = (bi) => this.fpv?.markCollapsed(bi);
    this.actors.hasFireNear = (x, y, r) => this.fire.hasFireNear(x, y, r);
    this.actors.nearestFire = (x, y, r) => this.fire.nearestFire(x, y, r);
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
    // First visit opens on the default place at full zoom; a returning visitor
    // picks up where they left the camera.
    restoreView(this.rig, map);
    this.saveView = createViewSaver(this.rig, map);

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
    }, streetStore);
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

    // The frame loop stops when the tab is hidden or closed, so catch the last
    // second of movement here. pagehide fires on mobile Safari's bfcache path
    // where unload does not.
    this.onPageHide = () => {
      this.saveView();
      this.pauseFrames();
    };
    this.onPageShow = () => {
      if (!document.hidden) this.resumeFrames();
    };
    this.onVisibilityChange = () => {
      this.saveView();
      if (document.hidden) this.pauseFrames();
      else this.resumeFrames();
    };
    // Sealed static attributes intentionally drop their CPU arrays after the
    // first upload. A restored WebGL context therefore cannot reconstruct the
    // scene from Three.js alone; reload from the compact source stores.
    this.onContextLost = (event: Event) => {
      event.preventDefault();
      this.pauseFrames();
    };
    this.onContextRestored = () => {
      if (!this.disposed) window.location.reload();
    };
    window.addEventListener("pagehide", this.onPageHide);
    window.addEventListener("pageshow", this.onPageShow);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);

    this.lastFrame = performance.now();
    this.paused = document.hidden;
    this.scheduleFrame();
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
      if (hit) return { x: hit.x, y: hit.y };
      // A padded fit-city view deliberately has screen corners outside the
      // heightfield. Fall through to the sea-level plane so the minimap quad
      // and cursor anchor remain defined there.
    }
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, hit)) return null;
    return toWorldXY(hit);
  }

  /**
   * Generic strategic marker seam for authoritative gameplay state. Callers
   * provide only state they actually own; the renderer does not synthesize
   * units or objectives from ambient actors.
   */
  setOverviewMarkers(markers: readonly OverviewGameplayMarker[]): void {
    this.overview.setGameplayMarkers(markers);
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
        this.controls.syncRotation();
      }
      if (document.pointerLockElement === this.canvas) document.exitPointerLock();
      this.fpvDrag = null;
      this.controls.active = true;
      this.minimap.el.style.display = "";
      this.hudScale.style.display = "";
      if (this.fpvProps) {
        this.fire.removePropSet(this.fpvProps);
        this.fpvProps.dispose();
        this.fpvProps = null;
      }
      this.hint("", 0);
      return;
    }
    // Lazy: collision index + life-size props are built on first entry.
    if (!this.fpvProps) {
      this.fpvProps = buildProps(this.map, this.propStore, this.hf, 1);
      this.fpvProps.group.visible = false;
      this.fpvProps.glow.visible = false;
      this.fpvProps.setNight(this.daynight.night);
      this.fire.addPropSet(this.fpvProps);
      this.scene.add(this.fpvProps.group, this.fpvProps.glow);
      // No distance-cull registry any more: prop and dressing tiles stream on
      // a radius tighter than the ranges it used, and it kept evicted meshes
      // alive by holding references to them.
    }
    // Enter skydiving from roughly the map camera's altitude — dramatic from
    // street zoom, capped so strategic view doesn't mean a minute of freefall.
    const dropH = Math.min(600, Math.max(200, this.rig.viewHeight * 1.2));
    if (!this.fpv) {
      this.fpv = new FpvMode(this.map, this.store, this.hf, this.city, this.rig.target, this.rig.theta, dropH);
      // Buildings that pancaked before FPV existed are already walk-through.
      for (const bi of this.fire.collapsed) this.fpv.markCollapsed(bi);
    } else {
      this.fpv.place(this.rig.target.x, this.rig.target.y, dropH);
      this.fpv.yaw = this.rig.theta;
    }
    this.fpvOn = true;
    // Only one prop cache may be resident. FPV has a much smaller life-size
    // window; keeping the hidden strategic cache doubled instance buffers.
    this.props.sync([]);
    this.controls.active = false;
    this.minimap.el.style.display = "none";
    this.hudScale.style.display = "none";
    this.lockPointer();
    this.hint("WASD move · Shift sprint · Space jump · double-Space fly (Space up, C down) · drag look · click PUNCH · V exit", 6000);
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
   * (headless, unfocused document, iframe policies). Swallowing that is fine
   * BECAUSE there is a fallback: drag-to-look in wireFpvInput covers every
   * case where the lock does not engage, including touch, where it does not
   * exist at all. */
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
    on(this.canvas, "pointermove", (e: PointerEvent) => {
      const d = this.fpvDrag;
      if (!this.fpvOn || !this.fpv || !d || e.pointerId !== d.id) return;
      // Once the lock engages, movementX/Y take over and the drag would
      // double-count.
      if (document.pointerLockElement === this.canvas) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      d.x = e.clientX;
      d.y = e.clientY;
      if (dx || dy) d.moved = true;
      this.fpv.look(dx, dy);
    });
    const endDrag = (e: PointerEvent): void => {
      const d = this.fpvDrag;
      if (!d || e.pointerId !== d.id) return;
      this.fpvDrag = null;
      // A tap that never moved is a punch — the click-to-punch gesture, for
      // the path where there is no lock to click into.
      if (!d.moved && this.fpvOn && document.pointerLockElement !== this.canvas) this.punch();
    };
    on(this.canvas, "pointerup", endDrag);
    on(this.canvas, "pointercancel", endDrag);
    on(this.canvas, "pointerdown", (e: PointerEvent) => {
      if (this.fpvOn) {
        if (document.pointerLockElement === this.canvas) {
          if (e.button === 0) this.punch();
          return;
        }
        // Not locked: look by dragging instead. Pointer lock is the nicer
        // input when it is available, but it is not always — the request can
        // be refused (unfocused document, embedded frames, and it resolves
        // asynchronously so a refusal is invisible), and on touch it does not
        // exist at all. Without this, FPV had exactly one way to look around
        // and no fallback when it failed.
        this.fpvDrag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
        this.canvas.setPointerCapture(e.pointerId);
        if (e.pointerType !== "touch") this.lockPointer();
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
        this.hint("Drag to look · tap to punch · V to exit", 0);
      } else {
        this.hint("", 0);
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    this.pauseFrames();
    this.saveView();
    window.removeEventListener("pagehide", this.onPageHide);
    window.removeEventListener("pageshow", this.onPageShow);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
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
    this.world.dispose();
    this.props.dispose();
    this.fpvProps?.dispose();
    this.impostor?.target.dispose();
    this.overview.dispose();
    disposeTree(this.scene);
    this.scene.clear();
    this.boot?.return();
    this.boot = null;
    void this.boomCtx?.close();
    this.boomCtx = null;
    this.webgl.dispose();
  }

  private scheduleFrame(): void {
    if (this.disposed || this.paused || this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.frame();
    });
  }

  private pauseFrames(): void {
    this.paused = true;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  private resumeFrames(): void {
    if (this.disposed || document.hidden) return;
    this.paused = false;
    this.lastFrame = performance.now();
    this.lastRender = 0;
    this.scheduleFrame();
  }

  private resize(): void {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    // Re-apply the cap: dragging a window between displays changes DPR.
    this.webgl.setPixelRatio(pixelRatio() * this.qualityScale);
    this.webgl.setSize(w, h, false);
  }

  private ensureImpostor(): ImpostorRig {
    if (this.impostor) return this.impostor;
    const w = this.map.meta.width;
    const h = this.map.meta.height;
    const width = Math.min(DETAIL.farTextureSize, this.webgl.capabilities.maxTextureSize);
    const height = Math.max(1, Math.round((width * h) / w));
    const target = new THREE.WebGLRenderTarget(width, height, { stencilBuffer: false });
    // Round-trip through sRGB so the photograph samples back exactly as the
    // boxes would have rasterized on screen.
    target.texture.colorSpace = THREE.SRGBColorSpace;
    target.texture.minFilter = THREE.LinearFilter;
    target.texture.magFilter = THREE.LinearFilter;
    target.texture.generateMipmaps = false;

    // Straight down, north up: screen right = +x (east), screen up = -z
    // (north). Framebuffer row 0 lands on the map's south edge, matching the
    // south-to-north row order the drape's UVs were built for.
    const camera = new THREE.OrthographicCamera(-w / 2, w / 2, h / 2, -h / 2, 1, 5500);
    camera.position.set(w / 2, 4500, -h / 2);
    camera.up.set(0, 0, -1);
    camera.lookAt(w / 2, 0, -h / 2);

    const scene = new THREE.Scene();
    const hemi = new THREE.HemisphereLight(0xbfd0e8, 0x33302a, 0.9);
    const sun = new THREE.DirectionalLight(0xfff2dd, 1.4);
    scene.add(hemi, sun, sun.target);
    this.impostor = { target, camera, scene, sun, hemi };
    return this.impostor;
  }

  /**
   * Photograph the far box tier into the impostor target and install it as
   * the wide-zoom far texture. One extra render of ~6.5M flat-shaded
   * triangles — a few milliseconds on desktop, a rare one-frame spike on a
   * phone — in exchange for wide zoom drawing a single textured quad.
   */
  private bakeImpostor(now: number): void {
    const rig = this.ensureImpostor();
    // Light the photograph the way applyDayNight lights the live scene, so
    // the swap is invisible. No shadows: the live scene has them off at
    // these altitudes too (DETAIL.shadowView < farTextureView).
    const dn = this.daynight;
    rig.sun.color.copy(dn.lightColor);
    rig.sun.intensity = dn.lightIntensity;
    const cx = this.map.meta.width / 2;
    const cz = -this.map.meta.height / 2;
    rig.sun.position.set(cx, 0, cz).addScaledVector(dn.lightDir, 4000);
    rig.sun.target.position.set(cx, 0, cz);
    rig.hemi.intensity = dn.hemiIntensity;
    rig.hemi.color.copy(dn.zenith).lerp(dn.horizon, 0.5).multiplyScalar(2.2);

    // Borrow the far group: every tile visible (tiles under resident prisms
    // are hidden on screen, but their boxes are the right massing here).
    const far = this.world.buildings.far;
    const prevParent = far.parent;
    const prevVisible = far.visible;
    const prevChildren = far.children.map((child) => child.visible);
    for (const child of far.children) child.visible = true;
    far.visible = true;
    rig.scene.add(far);

    const prevTarget = this.webgl.getRenderTarget();
    const prevColor = new THREE.Color();
    this.webgl.getClearColor(prevColor);
    const prevAlpha = this.webgl.getClearAlpha();
    // Transparent where there is no building, so terrain and water below the
    // drape stay the real thing.
    this.webgl.setRenderTarget(rig.target);
    this.webgl.setClearColor(0x000000, 0);
    this.webgl.render(rig.scene, rig.camera);
    this.webgl.setRenderTarget(prevTarget);
    this.webgl.setClearColor(prevColor, prevAlpha);

    prevParent?.add(far);
    far.visible = prevVisible;
    far.children.forEach((child, i) => {
      child.visible = prevChildren[i] ?? child.visible;
    });

    this.world.setFarTexture(rig.target.texture);
    this.impostorBakedT = dn.t;
    this.impostorBakedVersion = this.world.buildings.farVersion();
    this.lastImpostorBake = now;
    this.debugCache.impostorBakes++;
  }

  /**
   * Keep the far photograph fresh. Bakes happen only on approach to the swap
   * altitude (there is no cost while zoomed in), and go stale when the
   * day/night cycle drifts (~30 in-game minutes), boot fills in more far
   * tiles, or fire chars/collapses a building. Rebakes are throttled so a
   * city-wide blaze costs at most one extra render every few seconds.
   */
  private syncImpostor(vh: number, textureView: number, now: number): void {
    if (this.overviewReady) return;
    // 0.8: bake before the swap altitude, so crossing it never shows a gap.
    if (vh < textureView * 0.8) return;
    const version = this.world.buildings.farVersion();
    const stale =
      version !== this.impostorBakedVersion ||
      Math.abs(this.daynight.t - this.impostorBakedT) > 0.02;
    if (!stale) return;
    if (this.impostorBakedVersion >= 0 && now - this.lastImpostorBake < 4000) return;
    this.bakeImpostor(now);
  }

  /**
   * Keep the building tiles around the camera resident and drop the rest.
   *
   * Cheap to call every frame: it early-outs unless the camera has actually
   * crossed into a different tile or changed zoom band, so the work happens
   * only when the visible set really changes.
   */
  private syncBuildingTiles(focus: { x: number; y: number }, viewHeight: number): void {
    const store = this.store;
    if (!store.tileKey.length || !Number.isFinite(store.tileSize)) return;
    const syncStarted = performance.now();
    this.debugCache.syncs++;
    const { x, y } = focus;
    // At altitude a prism and a box are the same handful of pixels, so the
    // near tier shrinks to nothing rather than growing to cover the view.
    const radius = viewHeight < PRISM_NEAR_VIEW ? DETAIL.prism : viewHeight < PRISM_FAR_VIEW ? DETAIL.prism - 1 : 0;
    // Three independent windows: prisms upgrade the boxes near the camera,
    // dressing and props exist wherever their zoom gates would show them.
    const detailRadius = viewHeight < DETAIL.propsView ? DETAIL.dressing : -1;
    const propRadius = viewHeight < DETAIL.propsView ? DETAIL.props : -1;
    const cx = Math.floor(x / store.tileSize);
    const cy = Math.floor(y / store.tileSize);

    // Recompute the wanted windows only when the view actually moved; the
    // build queue below is drained every frame regardless.
    //
    // Every radius has to be in this test, not just the prism one. On a
    // handheld the props gate (1400 m) sits inside a prism band (1200-3000 m),
    // so zooming from 1500 to 1300 changes what props want without changing
    // `radius` — and the windows were never recomputed, leaving the phone with
    // no props at all until the camera happened to cross a tile line.
    if (
      cx !== this.tileCx ||
      cy !== this.tileCy ||
      radius !== this.tileRadius ||
      detailRadius !== this.tileDetailRadius ||
      propRadius !== this.tilePropRadius
    ) {
      this.debugCache.windowChanges++;
      this.tileCx = cx;
      this.tileCy = cy;
      this.tileRadius = radius;
      this.tileDetailRadius = detailRadius;
      this.tilePropRadius = propRadius;

      const span = Math.max(radius, detailRadius, propRadius);
      // Nearest first, so a window fills in from the camera outward instead of
      // from a corner — it matters once building is rationed per frame.
      const ring: { dx: number; dy: number }[] = [];
      for (let dy = -span; dy <= span; dy++) for (let dx = -span; dx <= span; dx++) ring.push({ dx, dy });
      ring.sort((a, b) => a.dx * a.dx + a.dy * a.dy - (b.dx * b.dx + b.dy * b.dy));

      this.wantBuildings = [];
      this.wantDressing = [];
      this.wantProps = [];
      for (const { dx, dy } of ring) {
        const key = tileKeyAt((cx + dx) * store.tileSize, (cy + dy) * store.tileSize, store.tileSize);
        if (Math.abs(dx) <= detailRadius && Math.abs(dy) <= detailRadius) this.wantDressing.push(key);
        if (Math.abs(dx) <= propRadius && Math.abs(dy) <= propRadius) this.wantProps.push(key);
        if (Math.abs(dx) > radius || Math.abs(dy) > radius) continue;
        const t = findTile(store, key);
        if (t >= 0) this.wantBuildings.push(t);
      }
    }

    // One fair nearest-first admission queue now rations every streamed
    // layer. Individual caches still own geometry and eviction; the scheduler
    // decides which kinds may consume this frame's construction/upload slice.
    this.tileScheduler.updateWanted("buildings", this.wantBuildings);
    this.tileScheduler.updateWanted("dressing", this.wantDressing);
    this.tileScheduler.updateWanted("props", this.wantProps);
    const terrainKey = tileKeyAt(x, y, store.tileSize);
    this.tileScheduler.updateWanted("terrain", [terrainKey]);
    const tickets = this.tileScheduler.claim(
      DETAIL.perFrame.buildings + DETAIL.perFrame.dressing + DETAIL.perFrame.props + 1,
    );
    const budgets = { buildings: 0, dressing: 0, terrain: 0, props: 0 };
    for (const ticket of tickets) budgets[ticket.kind]++;

    const { built, evicted } = this.world.buildings.sync(this.wantBuildings, budgets.buildings, {
      residentBytes: BYTE_BUDGETS.buildings,
      completedBytes: BYTE_BUDGETS.completed,
      uploadBytes: BYTE_BUDGETS.uploadPerFrame,
    });
    this.debugCache.buildingTilesBuilt += built.length;
    this.debugCache.buildingTilesEvicted += evicted;
    this.world.detailTiles.sync(
      this.wantDressing,
      budgets.dressing,
      BYTE_BUDGETS.dressing,
      BYTE_BUDGETS.uploadPerFrame,
    );
    this.world.syncGround(x, y, viewHeight, budgets.terrain, BYTE_BUDGETS.terrain);
    let propsChanged = this.props.sync(this.wantProps, budgets.props, BYTE_BUDGETS.props);
    // The life-size FPV set streams on the same window.
    if (
      this.fpvOn &&
      this.fpvProps &&
      this.fpvProps.sync(this.wantProps, budgets.props, BYTE_BUDGETS.props)
    ) propsChanged = true;
    if (propsChanged) {
      this.debugCache.propChanges++;
      this.fire.repaintTrees();
    }
    // A rebuilt tile comes back pristine — the fire sim owns what happened to
    // it, so it repaints the damage. This is why scars had to move out of the
    // colour buffer before tiling could exist.
    for (const [from, to] of built) {
      for (let bi = from; bi < to; bi++) this.fire.restoreAppearance(bi);
    }
    for (const ticket of tickets) {
      if (ticket.kind === "buildings") {
        const accepted =
          this.world.buildings.has(ticket.key) ||
          built.some(([from]) => this.store.tileStart[ticket.key] === from);
        if (!accepted) {
          this.tileScheduler.retry(ticket);
          continue;
        }
      }
      this.tileScheduler.complete(ticket, 0);
      this.tileScheduler.accept(ticket);
    }
    this.debugTiming.tileSyncMs += performance.now() - syncStarted;
  }

  /**
   * Spend this frame's share of the remaining world build.
   *
   * Time-budgeted rather than slice-counted: a terrain chunk and a street tile
   * are wildly different amounts of work, and what matters is that the frame
   * still lands. BOOT_BUDGET_MS is the slack in a 60 Hz frame after the scene
   * is drawn — overshooting by one slice is unavoidable (a slice is atomic),
   * which is why the slices themselves are small.
   *
   * Also why the whole thing is checked against a wall clock and not a slice
   * count: on a phone one slice may already blow the budget, and the loop must
   * then do exactly one and get out.
   */
  private pourWorld(): void {
    if (!this.boot) return;
    const until = performance.now() + BOOT_BUDGET_MS;
    let phase: string | null = null;
    do {
      const r = this.boot.next();
      if (r.done) {
        this.boot = null;
        this.onBootProgress?.(null);
        return;
      }
      phase = r.value;
    } while (performance.now() < until);
    if (phase !== this.bootPhase) this.onBootProgress?.((this.bootPhase = phase));
  }

  private applyCamera(): CameraCoverage {
    const aspect = (this.canvas.clientWidth || 1) / (this.canvas.clientHeight || 1);
    const metrics = this.rig.updateViewport(aspect);
    this.camera = metrics.orthographic ? this.overviewCamera : this.perspectiveCamera;
    this.rig.apply(this.camera, aspect, this.ground(this.rig.target.x, this.rig.target.y));
    this.cameraMetrics = metrics;
    return metrics;
  }

  private updateOverview(metrics: CameraCoverage, dt: number): ZoomTierVisibility {
    if (this.overviewReady) {
      this.overviewReveal = Math.min(1, this.overviewReveal + dt / OVERVIEW_READY_FADE_SECONDS);
    } else {
      this.overviewReveal = 0;
    }
    const groundCamera = THREE.MathUtils.smoothstep(
      metrics.coverage,
      OVERVIEW_GROUND_START,
      OVERVIEW_TRANSITION_START,
    );
    const ground = groundCamera * this.overviewReveal;
    const urban = metrics.transition * this.overviewReveal;
    const visibility = resolveZoomTierVisibility({
      transition: metrics.transition,
      atlasReady: this.overviewReady,
      groundOpacity: ground,
      urbanOpacity: urban,
    });
    this.overview.setOpacity({ ground, urban, symbols: visibility.symbolOpacity });
    this.overview.group.visible = visibility.atlas || visibility.symbols;
    this.overview.symbols.visible = visibility.symbols;
    this.overviewComplete = urban >= 1 - 1e-4;
    return visibility;
  }

  private frame(): void {
    if (this.disposed) return;
    const now = performance.now();
    if (typeof document !== "undefined" && document.hidden) {
      // Stop the loop outright; onPageHide restarts it. Nothing is scheduled
      // from here, so a backgrounded tab costs exactly nothing.
      this.paused = true;
      return;
    }
    // Frame-rate cap, skipped while the world is still filling in — the pour
    // is budgeted per executed frame, so capping during boot would just make
    // the city take twice as long to arrive.
    // Half-millisecond tolerance prevents a nominal 33.3 ms pair of rAF
    // ticks from missing by floating-point jitter and falling to 20 fps.
    if (this.adaptiveFrameGap && !this.boot && now - this.lastRender + 0.5 < this.adaptiveFrameGap) {
      this.scheduleFrame();
      return;
    }
    this.lastRender = now;
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    if (this.boot) {
      const bootStarted = performance.now();
      this.pourWorld();
      this.debugTiming.bootMs += performance.now() - bootStarted;
    }
    this.daynight.update(Date.now());

    // Both camera modes stream buildings, and FPV especially: walking is the
    // one case where the focus moves continuously across tile lines.
    this.syncBuildingTiles(
      this.fpvOn && this.fpv ? { x: this.fpv.x, y: this.fpv.y } : this.rig.target,
      this.fpvOn ? 0 : this.rig.viewHeight,
    );

    // Remember where the camera is, at most once a second. The saver itself
    // no-ops when nothing moved, so a parked camera costs one comparison.
    if (now - this.lastViewSave > 1000) {
      this.lastViewSave = now;
      this.saveView();
    }

    if (this.fpvOn && this.fpv) {
      this.fpv.update(dt);
      this.overview.group.visible = false;
      this.world.group.visible = true;
      this.actors.group.visible = true;
      this.fire.group.visible = true;
      // Street level: full detail, street-scale tint, gradient sky + distance
      // haze in the sky's horizon color. Landmark plates are billboards sized
      // for the map view — at eye height they wallpaper the horizon, so off.
      this.world.setBlend(0);
      this.world.setViewHeight(0);
      this.world.syncGround(this.fpv.x, this.fpv.y, 0, 1);
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
      const actorsStarted = performance.now();
      this.actors.update(dt, now / 1000, { x: this.fpv.x, y: this.fpv.y }, this.daynight.night, this.daynight.t * 24);
      this.debugTiming.actorsMs += performance.now() - actorsStarted;
      const fireStarted = performance.now();
      this.fire.update(dt, { x: this.fpv.x, y: this.fpv.y }, this.actors.fireUnitsOnScene());
      this.debugTiming.fireMs += performance.now() - fireStarted;
      this.punchCd -= dt;
      // Draw distance scales with altitude: short and hazy at street level
      // (nearby blocks occlude everything anyway), the whole city from the
      // air. Fog density is tied to the far plane so the cutoff hides in haze.
      const altAbove = this.fpv.z - this.ground(this.fpv.x, this.fpv.y);
      const far = Math.min(30000, Math.max(5500, 5500 + altAbove * 55));
      this.camera = this.perspectiveCamera;
      this.fpv.apply(this.perspectiveCamera, aspect, far);
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
      this.applyDayNight(this.fpv.x, this.fpv.y, this.fpv.z, !HANDHELD);
      const drawStarted = performance.now();
      this.webgl.render(this.scene, this.camera);
      this.debugTiming.drawMs += performance.now() - drawStarted;
      const frameMs = performance.now() - now;
      this.recordDebugFrame(frameMs);
      this.observeRenderCost(frameMs);
      this.scheduleFrame();
      return;
    }
    if (this.scene.fog) this.scene.fog = null;
    if (this.sky) this.sky.visible = false;
    if (this.skyBody) this.skyBody.visible = false;
    if (this.fpvProps) {
      this.fpvProps.group.visible = false;
      this.fpvProps.glow.visible = false;
    }
    this.controls.update(dt);

    const metrics = this.applyCamera();
    const vh = this.rig.viewHeight;
    this.world.setBlend((vh - BLEND_START) / (BLEND_END - BLEND_START));
    // A flat fallback replaces boxes only once camera perspective is gone.
    // `DETAIL` is a texture-resolution floor; fitSpan makes the gate map,
    // aspect and rotation aware.
    const fallbackTextureView = Math.max(
      DETAIL.farTextureView,
      metrics.fitSpan * OVERVIEW_ORTHO_START,
    );
    this.syncImpostor(vh, fallbackTextureView, now);
    // The ground map takes over exactly where the dressing window gives up.
    this.world.setViewHeight(vh, fallbackTextureView, DETAIL.propsView);
    const visibility = this.updateOverview(metrics, dt);
    // Every zoom-owned layer consumes the same decision. This leaves no frame
    // where tactical and overview landmarks both claim the city, and the live
    // city remains a complete fallback when the optional atlas is unavailable.
    this.world.group.visible = visibility.tacticalWorld;
    this.props.group.visible = visibility.tacticalDetails && vh < DETAIL.propsView;
    this.props.near.visible = visibility.tacticalDetails && vh < DETAIL.nearPropsView;
    this.props.glow.visible = visibility.tacticalEffects;
    this.world.detail.visible = visibility.tacticalDetails && vh < DETAIL.propsView;
    this.landmarks.group.visible = visibility.tacticalLandmarks;
    this.actors.group.visible = visibility.tacticalEffects;
    this.fire.group.visible = visibility.tacticalEffects;
    // Once the whole city is the primary canvas, the inset repeats the same
    // information and obscures a quarter of portrait/compact viewports.
    this.minimap.el.style.display = visibility.owner === "overview" ? "none" : "";
    this.landmarks.setViewScale(vh);
    if (visibility.symbols) {
      this.overview.updateView(this.camera, {
        width: this.canvas.clientWidth || 1,
        height: this.canvas.clientHeight || 1,
      });
    }

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
    const actorsStarted = performance.now();
    this.actors.update(dt, now / 1000, this.rig.target, this.daynight.night, this.daynight.t * 24);
    this.debugTiming.actorsMs += performance.now() - actorsStarted;
    const fireStarted = performance.now();
    this.fire.update(dt, this.rig.target, this.actors.fireUnitsOnScene());
    if (visibility.symbols && now >= this.nextOverviewMarkerUpdate) {
      this.overview.setFireMarkers(this.fire.overviewSnapshot());
      this.nextOverviewMarkerUpdate = now + 200;
    }
    this.debugTiming.fireMs += performance.now() - fireStarted;
    this.applyDayNight(this.rig.target.x, this.rig.target.y, this.ground(this.rig.target.x, this.rig.target.y), vh < DETAIL.shadowView);
    this.updateScaleBar(vh);

    const drawStarted = performance.now();
    this.webgl.render(this.scene, this.camera);
    this.debugTiming.drawMs += performance.now() - drawStarted;
    const frameMs = performance.now() - now;
    this.recordDebugFrame(frameMs);
    this.observeRenderCost(frameMs);
    this.scheduleFrame();
  }

  private recordDebugFrame(frameMs: number): void {
    this.debugTiming.frames++;
    this.debugTiming.totalMs += frameMs;
    this.debugTiming.maxFrameMs = Math.max(this.debugTiming.maxFrameMs, frameMs);
  }

  /** Runtime thermal/load response. It moves slowly, with hysteresis, so a
   * single boot spike cannot make quality pump between tiers. */
  private observeRenderCost(renderMs: number): void {
    if (this.boot || performance.now() - this.lastQualityChange < 3000) return;
    if (renderMs > 25) {
      this.slowFrames++;
      this.fastFrames = 0;
    } else if (renderMs < 12) {
      this.fastFrames++;
      this.slowFrames = 0;
    } else {
      this.slowFrames = 0;
      this.fastFrames = 0;
    }
    if (this.slowFrames >= 20 && this.qualityScale > 0.6) {
      this.qualityScale = Math.max(0.6, this.qualityScale - 0.2);
      this.adaptiveFrameGap = Math.max(this.adaptiveFrameGap, 1000 / 30);
      this.lastQualityChange = performance.now();
      this.slowFrames = 0;
      this.resize();
    } else if (this.fastFrames >= 300 && this.qualityScale < 1) {
      this.qualityScale = Math.min(1, this.qualityScale + 0.1);
      this.lastQualityChange = performance.now();
      this.fastFrames = 0;
      this.resize();
    }
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
      this.overview.setDayNightTint(dn.night);
    }

    const alt = this.fpvOn ? ` · ▲${Math.round(fz)} m` : "";
    // Focus position, world meters + WGS84 — so a screenshot pins the exact
    // spot for debugging (world x/y feed rig.target / fpv.place directly).
    const { lat, lon } = worldToLatLon(this.map.meta, fx, fy);
    const pos = ` · ${Math.round(fx)}E ${Math.round(fy)}N · ${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    const label = `${dn.day ? "☀" : "☾"} ${dn.clock}${alt}${pos}`;
    if (this.hudClock.textContent !== label) this.hudClock.textContent = label;
  }

  /** Stable, side-effect-free counters for the local browser benchmark. */
  debugStats(): RendererDebugStats {
    const r = this.webgl.info.render;
    const m = this.webgl.info.memory;
    return {
      booting: this.boot !== null,
      paused: this.paused,
      fpv: this.fpvOn,
      view: { x: this.rig.target.x, y: this.rig.target.y, height: this.rig.viewHeight },
      overview: {
        ready: this.overviewReady,
        coverage: this.cameraMetrics?.coverage ?? 0,
        transition: this.cameraMetrics?.transition ?? 0,
        orthographic: this.cameraMetrics?.orthographic ?? false,
        complete: this.overviewComplete,
      },
      render: { frame: r.frame, calls: r.calls, triangles: r.triangles, points: r.points, lines: r.lines },
      memory: { geometries: m.geometries, textures: m.textures },
      buildings: this.world.buildings.stats(),
      dressing: this.world.detailTiles.stats(),
      terrain: this.world.terrainStats(),
      props: this.props.stats(),
      fire: { active: this.fire.activeFires, collapsed: this.fire.collapsed.length },
      timing: { ...this.debugTiming },
      cache: { ...this.debugCache },
      scheduler: this.tileScheduler.stats(),
    };
  }

  /** Deterministic camera/time controls used only by the local benchmark. */
  debugSetView(x: number, y: number, height: number): void {
    this.rig.target = { x, y };
    this.rig.viewHeight = Math.max(70, height);
    this.rig.clampToMap(this.map);
  }

  debugSetNight(night: boolean): void {
    this.daynight.overrideT = night ? 0 : 0.5;
  }

  debugSetFpv(on: boolean): void {
    if (on !== this.fpvOn) this.toggleFpv();
  }

  /**
   * Remove autonomous ignition/suppression inputs so a benchmark starts with
   * a clean fire workload. Production callbacks are untouched unless the
   * explicit benchmark entry point invokes this control.
   */
  debugPrepareBenchmark(): void {
    this.actors.onFireIncident = null;
    this.actors.onTankFire = null;
    this.fire.onNewFire = null;
  }

  /**
   * Seed a repeatable visible workload without changing FireSim's production
   * randomness or exposing its internals. Building choices come from fixed
   * quantiles of the current near-tile window; explicit impact coordinates
   * make ignition and damage placement repeatable for a staged map.
   */
  debugStartActiveFireScenario(): DebugFireScenario {
    const activeBefore = this.fire.activeFires;
    const candidates: number[] = [];
    const seen = new Set<number>();
    const samplesPerTile = 8;
    for (const tile of this.wantBuildings) {
      const from = this.store.tileStart[tile]!;
      const to = this.store.tileStart[tile + 1]!;
      const count = to - from;
      for (let sample = 0; sample < samplesPerTile; sample++) {
        const bi = from + Math.floor(((sample + 0.5) * count) / samplesPerTile);
        if (bi < from || bi >= to || seen.has(bi) || this.city.valid[bi] !== 1) continue;
        seen.add(bi);
        candidates.push(bi);
      }
    }
    // Tiny/sparse tiles can make quantiles collide. Deterministically fill any
    // remaining slots from the same visible window.
    if (candidates.length < 48) {
      for (const tile of this.wantBuildings) {
        const from = this.store.tileStart[tile]!;
        const to = this.store.tileStart[tile + 1]!;
        for (let bi = from; bi < to && candidates.length < 48; bi++) {
          if (seen.has(bi) || this.city.valid[bi] !== 1) continue;
          seen.add(bi);
          candidates.push(bi);
        }
        if (candidates.length >= 48) break;
      }
    }

    const ignited: number[] = [];
    const damaged: number[] = [];
    for (const bi of candidates) {
      const center = this.fire.centerOf(bi);
      if (ignited.length < 24 && (ignited.length <= damaged.length || damaged.length >= 24)) {
        if (this.fire.igniteBuilding(bi, center.x, center.y)) ignited.push(bi);
      } else if (damaged.length < 24) {
        this.fire.damageBuilding(bi, 0.75, 0, center.x, center.y);
        damaged.push(bi);
      }
      if (ignited.length >= 24 && damaged.length >= 24) break;
    }
    return { ignited, damaged, activeBefore, activeAfter: this.fire.activeFires };
  }

  /** Exercise the same single-loop pause/resume path as lifecycle handlers. */
  debugPauseResume(): void {
    this.pauseFrames();
    this.resumeFrames();
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
