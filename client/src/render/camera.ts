import * as THREE from "three";
import type { GameMap } from "@battle-juice/shared";

// World frame is meters, x east, y north. Scene frame is three.js y-up:
// world (x, y) at height h -> scene (x, h, -y).
export function toScene(x: number, y: number, h = 0): THREE.Vector3 {
  return new THREE.Vector3(x, h, -y);
}

export function toWorldXY(v: THREE.Vector3): { x: number; y: number } {
  return { x: v.x, y: -v.z };
}

export const MIN_VIEW_HEIGHT = 70; // meters visible vertically at max zoom-in
/** Empty border around the rotated city at maximum zoom-out. */
export const CITY_FIT_PADDING = 1.08;
/** Fraction of the fit span where the camera starts becoming an overview. */
export const OVERVIEW_TRANSITION_START = 0.28;
/** Fraction of the fit span where top-down perspective hands off to ortho. */
export const OVERVIEW_ORTHO_START = 0.72;
export const FOV_DEG = 35; // narrow-ish perspective: depth without fisheye
const HALF_FOV = (FOV_DEG * Math.PI) / 360;
const TOP_DOWN = Math.PI / 2;

export interface CameraCoverage {
  /** Current vertical span divided by the padded, rotated full-city fit span. */
  coverage: number;
  /** Smoothed 0..1 overview transition amount. */
  transition: number;
  /** Vertical span that fits the rotated city at the current aspect. */
  fitSpan: number;
  /** Rotated city bounds along screen-right and screen-up. */
  rotatedWidth: number;
  rotatedHeight: number;
  /** Tilt actually rendered; `tilt` remains the user's tactical preference. */
  effectiveTilt: number;
  /** True after perspective has reached a matched top-down projection. */
  orthographic: boolean;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function smoothstep(value: number): number {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

/**
 * Camera rig shared by the tilted perspective and top-down orthographic map
 * cameras. Zoom remains one continuous vertical ground span. At city scale
 * the effective tilt eases to 90 degrees; only then does an exactly matched
 * orthographic frustum take over.
 */
export class CameraRig {
  target: { x: number; y: number };
  theta = 0; // azimuth, radians; 0 = north up
  viewHeight = 400;
  /** User's tactical elevation preference. Overview forcing does not erase it. */
  tilt = (55 * Math.PI) / 180;
  static readonly MIN_TILT = (25 * Math.PI) / 180;
  static readonly MAX_TILT = (80 * Math.PI) / 180;
  private mapW: number;
  private mapH: number;
  private lastAspect = 16 / 9;
  private lastFitSpan: number;

  constructor(map: GameMap) {
    this.target = { x: map.meta.width / 2, y: map.meta.height / 2 };
    this.mapW = map.meta.width;
    this.mapH = map.meta.height;
    this.lastFitSpan = this.fitSpan(this.lastAspect).fitSpan;
  }

  /** Camera-to-target distance that shows viewHeight meters at the target. */
  private dist(vh = this.viewHeight): number {
    return vh / (2 * Math.tan(HALF_FOV));
  }

  private fitSpan(aspect: number): Pick<CameraCoverage, "fitSpan" | "rotatedWidth" | "rotatedHeight"> {
    const c = Math.abs(Math.cos(this.theta));
    const s = Math.abs(Math.sin(this.theta));
    const rotatedWidth = c * this.mapW + s * this.mapH;
    const rotatedHeight = s * this.mapW + c * this.mapH;
    return {
      rotatedWidth,
      rotatedHeight,
      fitSpan: CITY_FIT_PADDING * Math.max(rotatedHeight, rotatedWidth / Math.max(1e-6, aspect)),
    };
  }

  /**
   * Public transition/coverage metrics. Rendering and overview-layer blending
   * consume the same values, so camera and art cannot drift into separate
   * threshold systems.
   */
  metrics(aspect = this.lastAspect): CameraCoverage {
    const fit = this.fitSpan(aspect);
    const coverage = clamp01(this.viewHeight / fit.fitSpan);
    const transition = smoothstep(
      (coverage - OVERVIEW_TRANSITION_START) /
        (OVERVIEW_ORTHO_START - OVERVIEW_TRANSITION_START),
    );
    const effectiveTilt = this.tilt + (TOP_DOWN - this.tilt) * transition;
    return {
      ...fit,
      coverage,
      transition,
      effectiveTilt,
      orthographic: coverage >= OVERVIEW_ORTHO_START - 1e-8,
    };
  }

  /**
   * Ground-plane corner offsets from the target. Perspective is asymmetric:
   * the top of the screen reaches farther than the bottom until tilt reaches
   * 90 degrees. Computing the actual four rays avoids premature recentering.
   */
  private footprint(metrics: CameraCoverage): { x: number; y: number }[] {
    const f = this.forward();
    const r = this.right();
    const halfH = this.viewHeight / 2;
    if (metrics.orthographic) {
      const halfW = halfH * this.lastAspect;
      return [
        { x: r.x * -halfW + f.x * halfH, y: r.y * -halfW + f.y * halfH },
        { x: r.x * halfW + f.x * halfH, y: r.y * halfW + f.y * halfH },
        { x: r.x * halfW - f.x * halfH, y: r.y * halfW - f.y * halfH },
        { x: r.x * -halfW - f.x * halfH, y: r.y * -halfW - f.y * halfH },
      ];
    }

    const tilt = metrics.effectiveTilt;
    const d = this.dist();
    const cameraHeight = d * Math.sin(tilt);
    const setback = d * Math.cos(tilt);
    const tanHalf = Math.tan(HALF_FOV);
    const result: { x: number; y: number }[] = [];
    for (const sy of [1, -1]) {
      const denominator = Math.sin(tilt) - sy * tanHalf * Math.cos(tilt);
      const rayScale = cameraHeight / Math.max(1e-6, denominator);
      const forwardOffset =
        -setback + rayScale * (Math.cos(tilt) + sy * tanHalf * Math.sin(tilt));
      for (const sx of [-1, 1]) {
        const rightOffset = rayScale * sx * this.lastAspect * tanHalf;
        result.push({
          x: r.x * rightOffset + f.x * forwardOffset,
          y: r.y * rightOffset + f.y * forwardOffset,
        });
      }
    }
    return result;
  }

  /** Keep target inside the remaining legal interval; center only when the
   * footprint has grown too large for an interval to exist. */
  private constrain(): void {
    this.tilt = Math.min(CameraRig.MAX_TILT, Math.max(CameraRig.MIN_TILT, this.tilt));
    const fit = this.fitSpan(this.lastAspect);
    const wasFit = this.viewHeight >= this.lastFitSpan * (1 - 1e-7);
    if (wasFit && Number.isFinite(this.lastFitSpan)) this.viewHeight = fit.fitSpan;
    this.lastFitSpan = fit.fitSpan;
    this.viewHeight = Math.min(fit.fitSpan, Math.max(MIN_VIEW_HEIGHT, this.viewHeight));

    const corners = this.footprint(this.metrics());
    const xs = corners.map((corner) => corner.x);
    const ys = corners.map((corner) => corner.y);
    const clampAxis = (value: number, minOffset: number, maxOffset: number, dimension: number): number => {
      const low = -minOffset;
      const high = dimension - maxOffset;
      return low <= high
        ? Math.min(high, Math.max(low, value))
        : (low + high) / 2;
    };
    this.target.x = clampAxis(this.target.x, Math.min(...xs), Math.max(...xs), this.mapW);
    this.target.y = clampAxis(this.target.y, Math.min(...ys), Math.max(...ys), this.mapH);
  }

  /** Ground direction from camera toward target ("screen up" on the ground). */
  forward(): { x: number; y: number } {
    return { x: -Math.sin(this.theta), y: Math.cos(this.theta) };
  }

  /** Ground direction matching "screen right". */
  right(): { x: number; y: number } {
    return { x: Math.cos(this.theta), y: Math.sin(this.theta) };
  }

  /** `baseH`: terrain height at the target — the whole rig rides on it so
   * the focus point sits on the ground, not at sea level. */
  apply(cam: THREE.PerspectiveCamera | THREE.OrthographicCamera, aspect: number, baseH = 0): void {
    const metrics = this.updateViewport(aspect);
    const f = this.forward();
    const d = this.dist();
    const horiz = d * Math.cos(metrics.effectiveTilt);
    const camX = this.target.x - f.x * horiz;
    const camY = this.target.y - f.y * horiz;
    const camH = baseH + d * Math.sin(metrics.effectiveTilt);

    cam.position.copy(toScene(camX, camY, camH));
    // The usual world-up vector becomes collinear with the view ray at 90°.
    // This equivalent no-roll camera-up basis keeps azimuth well-defined all
    // the way through top-down, which is essential for the projection swap.
    cam.up.set(
      f.x * Math.sin(metrics.effectiveTilt),
      Math.cos(metrics.effectiveTilt),
      -f.y * Math.sin(metrics.effectiveTilt),
    );
    cam.lookAt(toScene(this.target.x, this.target.y, baseH));

    if (cam instanceof THREE.PerspectiveCamera) {
      cam.fov = FOV_DEG;
      cam.aspect = aspect;
    } else {
      const halfH = this.viewHeight / 2;
      cam.left = -halfH * aspect;
      cam.right = halfH * aspect;
      cam.top = halfH;
      cam.bottom = -halfH;
    }
    cam.near = Math.max(1, d * 0.02);
    cam.far = d * 8;
    cam.updateProjectionMatrix();
  }

  /** Install a viewport aspect and resolve all dynamic fit constraints before
   * the renderer chooses perspective or orthographic projection. */
  updateViewport(aspect: number): CameraCoverage {
    this.lastAspect = Math.max(1e-6, aspect);
    this.constrain();
    return this.metrics();
  }

  /** Drag the map by a screen-pixel delta (the ground follows the pointer). */
  panScreen(dxPx: number, dyPx: number, canvasHeightPx: number): void {
    const mpp = this.viewHeight / canvasHeightPx; // meters per pixel at target
    const f = this.forward();
    const r = this.right();
    // Vertical screen distance foreshortens ground-forward motion by sin(tilt).
    const fwd = (dyPx * mpp) / Math.sin(this.metrics().effectiveTilt);
    this.target.x += -dxPx * mpp * r.x + fwd * f.x;
    this.target.y += -dxPx * mpp * r.y + fwd * f.y;
  }

  /** Pan in camera-relative ground directions (keyboard), dt in seconds. */
  panKeys(rightAmt: number, fwdAmt: number, dt: number): void {
    const speed = this.viewHeight * 1.2; // meters per second, zoom-relative
    const f = this.forward();
    const r = this.right();
    this.target.x += (r.x * rightAmt + f.x * fwdAmt) * speed * dt;
    this.target.y += (r.y * rightAmt + f.y * fwdAmt) * speed * dt;
  }

  zoomBy(factor: number): void {
    this.viewHeight *= factor;
    this.constrain();
  }

  tiltBy(delta: number): void {
    this.tilt = Math.min(CameraRig.MAX_TILT, Math.max(CameraRig.MIN_TILT, this.tilt + delta));
    this.constrain();
  }

  /** Shift the camera target so `current` lands where `wanted` was in world
   * space. Screen-anchored zoom/rotate/tilt unproject before and after, then
   * use this single correction so map boundaries are resolved consistently. */
  alignWorldPoint(
    wanted: { x: number; y: number },
    current: { x: number; y: number },
  ): void {
    this.target.x += wanted.x - current.x;
    this.target.y += wanted.y - current.y;
    this.constrain();
  }

  clampToMap(_map?: GameMap): void {
    this.constrain();
  }
}
