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
const MAX_VIEW_HEIGHT = 1800;
const CAMERA_DIST = 2000; // orthographic: any comfortably large constant

/**
 * Orthographic camera rig: a ground-plane target, a continuous azimuth theta,
 * a fixed elevation tilt, and zoom expressed as visible meters (viewHeight).
 * Snap rotation is purely input policy — theta itself is continuous.
 */
export class CameraRig {
  target: { x: number; y: number };
  theta = 0; // azimuth, radians; 0 = north up
  viewHeight = 400;
  readonly tilt = (55 * Math.PI) / 180; // elevation angle above the ground

  constructor(map: GameMap) {
    this.target = { x: map.meta.width / 2, y: map.meta.height / 2 };
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
    this.viewHeight = Math.min(MAX_VIEW_HEIGHT, Math.max(MIN_VIEW_HEIGHT, this.viewHeight * factor));
  }

  clampToMap(map: GameMap): void {
    this.target.x = Math.min(map.meta.width, Math.max(0, this.target.x));
    this.target.y = Math.min(map.meta.height, Math.max(0, this.target.y));
  }
}
