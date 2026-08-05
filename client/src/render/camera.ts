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

const MIN_VIEW_HEIGHT = 150; // meters visible vertically at max zoom-in
const MAX_VIEW_HEIGHT = 12000; // hard zoom-out cap (minimap covers the rest)
const FOV_DEG = 35; // narrow-ish perspective: depth without fisheye
const HALF_FOV = (FOV_DEG * Math.PI) / 360;

/**
 * Perspective camera rig: a ground-plane target, a continuous azimuth theta,
 * a variable elevation tilt, and zoom expressed as visible meters at the
 * target (viewHeight). Snap rotation is purely input policy — theta itself
 * is continuous. Tilt is zoom-coupled: far zoom eases toward top-down so the
 * frustum never grazes the horizon.
 */
export class CameraRig {
  target: { x: number; y: number };
  theta = 0; // azimuth, radians; 0 = north up
  viewHeight = 400;
  tilt = (55 * Math.PI) / 180; // elevation angle above the ground (variable)
  static readonly MIN_TILT = (25 * Math.PI) / 180;
  static readonly MAX_TILT = (80 * Math.PI) / 180;
  private static readonly FAR_MIN_TILT = (50 * Math.PI) / 180;
  private mapW: number;
  private mapH: number;
  private lastAspect = 16 / 9;

  constructor(map: GameMap) {
    this.target = { x: map.meta.width / 2, y: map.meta.height / 2 };
    this.mapW = map.meta.width;
    this.mapH = map.meta.height;
  }

  /** Camera-to-target distance that shows viewHeight meters at the target. */
  private dist(vh = this.viewHeight): number {
    return vh / (2 * Math.tan(HALF_FOV));
  }

  /** Lowest allowed tilt at this zoom — rises toward top-down when far out. */
  private minTiltFor(vh: number): number {
    const t = Math.min(1, Math.max(0, (vh - 2000) / (MAX_VIEW_HEIGHT - 2000)));
    return CameraRig.MIN_TILT + t * (CameraRig.FAR_MIN_TILT - CameraRig.MIN_TILT);
  }

  /**
   * Half-extents of the view's ground footprint for the current rotation and
   * tilt (conservative: the far edge, where perspective is widest). Keeping
   * this inside the map means no blank space at any screen edge.
   */
  private viewExtents(vh = this.viewHeight): { ex: number; ey: number } {
    const d = this.dist(vh);
    const h = d * Math.sin(this.tilt); // camera height
    const back = d * Math.cos(this.tilt); // horizontal setback from target
    const fFar = h / Math.tan(this.tilt - HALF_FOV) - back;
    const fNear = back - h / Math.tan(this.tilt + HALF_FOV);
    const slantFar = h / Math.sin(this.tilt - HALF_FOV);
    const halfW = this.lastAspect * Math.tan(HALF_FOV) * slantFar * Math.cos(HALF_FOV);
    const fwd = Math.max(fFar, fNear);
    const c = Math.abs(Math.cos(this.theta));
    const s = Math.abs(Math.sin(this.theta));
    return { ex: c * halfW + s * fwd, ey: s * halfW + c * fwd };
  }

  /** Keep zoom, tilt and target such that the view never leaves the map. */
  private constrain(): void {
    this.viewHeight = Math.min(MAX_VIEW_HEIGHT, Math.max(MIN_VIEW_HEIGHT, this.viewHeight));
    this.tilt = Math.min(CameraRig.MAX_TILT, Math.max(this.minTiltFor(this.viewHeight), this.tilt));
    let { ex, ey } = this.viewExtents();
    // Extents are linear in viewHeight at fixed tilt, so one shrink pass fits.
    const shrink = Math.min(1, this.mapW / (2 * ex), this.mapH / (2 * ey));
    if (shrink < 1) {
      this.viewHeight = Math.max(MIN_VIEW_HEIGHT, this.viewHeight * shrink);
      ({ ex, ey } = this.viewExtents());
    }
    const clampAxis = (v: number, half: number, dim: number): number =>
      2 * half >= dim ? dim / 2 : Math.min(dim - half, Math.max(half, v));
    this.target.x = clampAxis(this.target.x, ex, this.mapW);
    this.target.y = clampAxis(this.target.y, ey, this.mapH);
  }

  /** Ground direction from camera toward target ("screen up" on the ground). */
  forward(): { x: number; y: number } {
    return { x: -Math.sin(this.theta), y: Math.cos(this.theta) };
  }

  /** Ground direction matching "screen right". */
  right(): { x: number; y: number } {
    return { x: Math.cos(this.theta), y: Math.sin(this.theta) };
  }

  apply(cam: THREE.PerspectiveCamera, aspect: number): void {
    this.lastAspect = aspect;
    this.constrain(); // every frame: zoom, tilt, pan can all push out of fit
    const f = this.forward();
    const d = this.dist();
    const horiz = d * Math.cos(this.tilt);
    const camX = this.target.x - f.x * horiz;
    const camY = this.target.y - f.y * horiz;
    const camH = d * Math.sin(this.tilt);

    cam.position.copy(toScene(camX, camY, camH));
    cam.up.set(0, 1, 0);
    cam.lookAt(toScene(this.target.x, this.target.y, 0));

    cam.fov = FOV_DEG;
    cam.aspect = aspect;
    cam.near = Math.max(1, d * 0.02);
    cam.far = d * 8;
    cam.updateProjectionMatrix();
  }

  /** Drag the map by a screen-pixel delta (the ground follows the pointer). */
  panScreen(dxPx: number, dyPx: number, canvasHeightPx: number): void {
    const mpp = this.viewHeight / canvasHeightPx; // meters per pixel at target
    const f = this.forward();
    const r = this.right();
    // Vertical screen distance foreshortens ground-forward motion by sin(tilt).
    const fwd = (dyPx * mpp) / Math.sin(this.tilt);
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
    this.viewHeight = Math.min(MAX_VIEW_HEIGHT, Math.max(MIN_VIEW_HEIGHT, this.viewHeight * factor));
  }

  tiltBy(delta: number): void {
    this.tilt = Math.min(
      CameraRig.MAX_TILT,
      Math.max(this.minTiltFor(this.viewHeight), this.tilt + delta),
    );
    this.constrain();
  }

  clampToMap(_map?: GameMap): void {
    this.constrain();
  }
}
