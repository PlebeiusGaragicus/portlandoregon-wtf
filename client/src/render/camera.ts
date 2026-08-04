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

const MIN_VIEW_HEIGHT = 60; // meters visible vertically at max zoom-in
const CAMERA_DIST = 8000; // orthographic: any comfortably large constant

/**
 * Orthographic camera rig: a ground-plane target, a continuous azimuth theta,
 * a fixed elevation tilt, and zoom expressed as visible meters (viewHeight).
 * Snap rotation is purely input policy — theta itself is continuous.
 */
export class CameraRig {
  target: { x: number; y: number };
  theta = 0; // azimuth, radians; 0 = north up
  viewHeight = 400;
  tilt = (55 * Math.PI) / 180; // elevation angle above the ground (variable)
  static readonly MIN_TILT = (25 * Math.PI) / 180;
  static readonly MAX_TILT = (80 * Math.PI) / 180;
  private mapW: number;
  private mapH: number;
  private lastAspect = 16 / 9;

  constructor(map: GameMap) {
    this.target = { x: map.meta.width / 2, y: map.meta.height / 2 };
    this.mapW = map.meta.width;
    this.mapH = map.meta.height;
  }

  /**
   * Radius of the circle covering the view's ground footprint — with this
   * circle kept inside the map, no blank space shows at any rotation.
   */
  private viewRadius(vh = this.viewHeight): number {
    return 0.5 * Math.hypot(vh * this.lastAspect, vh / Math.sin(this.tilt));
  }

  /** Largest viewHeight whose footprint circle still fits inside the map. */
  private maxViewHeightFit(): number {
    const minDim = Math.min(this.mapW, this.mapH);
    return minDim / Math.hypot(this.lastAspect, 1 / Math.sin(this.tilt));
  }

  /** Keep zoom and target such that the view never leaves the map. */
  private constrain(): void {
    this.viewHeight = Math.min(this.maxViewHeightFit(), Math.max(MIN_VIEW_HEIGHT, this.viewHeight));
    const r = this.viewRadius();
    const clampAxis = (v: number, dim: number): number =>
      2 * r >= dim ? dim / 2 : Math.min(dim - r, Math.max(r, v));
    this.target.x = clampAxis(this.target.x, this.mapW);
    this.target.y = clampAxis(this.target.y, this.mapH);
  }

  /** Ground direction from camera toward target ("screen up" on the ground). */
  forward(): { x: number; y: number } {
    return { x: -Math.sin(this.theta), y: Math.cos(this.theta) };
  }

  /** Ground direction matching "screen right". */
  right(): { x: number; y: number } {
    return { x: Math.cos(this.theta), y: Math.sin(this.theta) };
  }

  apply(cam: THREE.OrthographicCamera, aspect: number): void {
    this.lastAspect = aspect;
    this.constrain(); // every frame: zoom, tilt, pan can all push out of fit
    const f = this.forward();
    const horiz = CAMERA_DIST * Math.cos(this.tilt);
    const camX = this.target.x - f.x * horiz;
    const camY = this.target.y - f.y * horiz;
    const camH = CAMERA_DIST * Math.sin(this.tilt);

    cam.position.copy(toScene(camX, camY, camH));
    cam.up.set(0, 1, 0);
    cam.lookAt(toScene(this.target.x, this.target.y, 0));

    const halfH = this.viewHeight / 2;
    const halfW = halfH * aspect;
    cam.left = -halfW;
    cam.right = halfW;
    cam.top = halfH;
    cam.bottom = -halfH;
    cam.near = 1;
    cam.far = CAMERA_DIST * 2 + 1000;
    cam.updateProjectionMatrix();
  }

  /** Drag the map by a screen-pixel delta (the ground follows the pointer). */
  panScreen(dxPx: number, dyPx: number, canvasHeightPx: number): void {
    const mpp = this.viewHeight / canvasHeightPx; // meters per pixel
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
    this.viewHeight = Math.min(this.maxViewHeightFit(), Math.max(MIN_VIEW_HEIGHT, this.viewHeight * factor));
  }

  tiltBy(delta: number): void {
    this.tilt = Math.min(CameraRig.MAX_TILT, Math.max(CameraRig.MIN_TILT, this.tilt + delta));
    this.constrain();
  }

  clampToMap(_map?: GameMap): void {
    this.constrain();
  }
}
