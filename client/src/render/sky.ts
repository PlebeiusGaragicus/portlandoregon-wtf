import * as THREE from "three";
import type { GameMap } from "@battle-juice/shared";
import { toScene } from "./camera.js";

// Sparse drifting clouds, visible only from strategic altitude. Soft radial
// sprites — cheap, and they sell the scale with the curvature.

const CLOUD_COUNT = 42;

function jitter(i: number): number {
  return (Math.sin(i * 127.1 + 311.7) * 43758.5453) % 1; // deterministic
}

export class Sky {
  readonly group = new THREE.Group();
  private mats: THREE.SpriteMaterial[] = [];
  private speeds: number[] = [];
  private width: number;
  private height: number;

  constructor(map: GameMap) {
    this.width = map.meta.width;
    this.height = map.meta.height;
    const texture = makeCloudTexture();
    for (let i = 0; i < CLOUD_COUNT; i++) {
      const mat = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(mat);
      const x = Math.abs(jitter(i * 3)) * this.width;
      const y = Math.abs(jitter(i * 3 + 1)) * this.height;
      const h = 900 + Math.abs(jitter(i * 3 + 2)) * 600;
      sprite.position.copy(toScene(x, y, h));
      const scale = 500 + Math.abs(jitter(i * 7)) * 900;
      sprite.scale.set(scale, scale * 0.45, 1);
      this.group.add(sprite);
      this.mats.push(mat);
      this.speeds.push(4 + Math.abs(jitter(i * 11)) * 8); // m/s drift
    }
    this.group.visible = false;
  }

  /** Drift and fade with altitude. dt in seconds. */
  update(dt: number, viewHeight: number): void {
    const fade = Math.min(1, Math.max(0, (viewHeight - 3000) / 4000));
    this.group.visible = fade > 0.01;
    if (!this.group.visible) return;
    this.group.children.forEach((sprite, i) => {
      sprite.position.x += this.speeds[i]! * dt;
      if (sprite.position.x > this.width + 800) sprite.position.x = -800;
      this.mats[i]!.opacity = 0.28 * fade;
    });
  }
}

function makeCloudTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 64;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(64, 32, 4, 64, 32, 60);
  g.addColorStop(0, "rgba(235, 240, 248, 0.9)");
  g.addColorStop(0.6, "rgba(225, 232, 244, 0.35)");
  g.addColorStop(1, "rgba(225, 232, 244, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 64);
  return new THREE.CanvasTexture(c);
}
