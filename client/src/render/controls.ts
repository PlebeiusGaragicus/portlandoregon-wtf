import type { GameMap } from "@battle-juice/shared";
import { CameraRig } from "./camera.js";

const DRAG_THRESHOLD_PX = 4;
const SNAP = Math.PI / 4; // 8 rotation snap angles
const TWEEN_RATE = 12; // theta easing, higher = snappier
const TILT_SPEED = 1.2; // rad/s while R/F held

/** What the renderer exposes to input handling. */
export interface ControlDelegate {
  /** Tactical selection/dispatch is inhibited when zoomed to strategic view. */
  isStrategic(): boolean;
  selectAt(clientX: number, clientY: number): void;
  marqueeSelect(x0: number, y0: number, x1: number, y1: number): void;
  dispatchAt(clientX: number, clientY: number): void;
  deselect(): void;
  /** Zoom keeping the world point under the cursor fixed. */
  zoomAt(clientX: number, clientY: number, factor: number): void;
}

/**
 * Traditional map scheme: left click selects (off-click deselects), left drag
 * marquee-selects, right click dispatches, middle drag pans, WASD pans, Q/E
 * rotates (snapped), R/F tilts, N faces north, wheel zooms toward the cursor.
 * In strategic view (far zoom) left drag pans instead and selection is off.
 */
export class Controls {
  private thetaGoal = 0;
  private keys = new Set<string>();
  private pointer: { x: number; y: number; button: number; mode: "idle" | "maybe" | "pan" | "marquee" } | null = null;
  private marqueeEl: HTMLDivElement;
  private disposers: (() => void)[] = [];

  constructor(
    private canvas: HTMLCanvasElement,
    private rig: CameraRig,
    private map: GameMap,
    private delegate: ControlDelegate,
  ) {
    this.marqueeEl = document.createElement("div");
    this.marqueeEl.id = "marquee";
    this.marqueeEl.style.display = "none";
    canvas.parentElement?.appendChild(this.marqueeEl);

    this.listen(canvas, "contextmenu", (e: MouseEvent) => e.preventDefault());
    this.listen(canvas, "pointerdown", (e: PointerEvent) => {
      if (e.button === 1) {
        this.pointer = { x: e.clientX, y: e.clientY, button: 1, mode: "pan" };
      } else if (e.button === 0) {
        this.pointer = { x: e.clientX, y: e.clientY, button: 0, mode: "maybe" };
      } else {
        return;
      }
      canvas.setPointerCapture(e.pointerId);
    });
    this.listen(canvas, "pointermove", (e: PointerEvent) => {
      const p = this.pointer;
      if (!p) return;
      if (p.mode === "maybe") {
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > DRAG_THRESHOLD_PX) {
          p.mode = this.delegate.isStrategic() ? "pan" : "marquee";
        }
      }
      if (p.mode === "pan") {
        this.rig.panScreen(e.movementX, e.movementY, this.canvas.clientHeight);
        this.rig.clampToMap(this.map);
      } else if (p.mode === "marquee") {
        this.drawMarquee(p.x, p.y, e.clientX, e.clientY);
      }
    });
    this.listen(canvas, "pointerup", (e: PointerEvent) => {
      const p = this.pointer;
      this.pointer = null;
      this.marqueeEl.style.display = "none";
      if (!p) return;
      if (p.mode === "maybe") {
        // A clean click.
        if (e.button === 0 && !this.delegate.isStrategic()) this.delegate.selectAt(e.clientX, e.clientY);
      } else if (p.mode === "marquee") {
        this.delegate.marqueeSelect(p.x, p.y, e.clientX, e.clientY);
      }
    });
    this.listen(canvas, "pointercancel", () => {
      this.pointer = null;
      this.marqueeEl.style.display = "none";
    });
    // Right click never drags: dispatch on the raw event.
    this.listen(canvas, "pointerdown", (e: PointerEvent) => {
      if (e.button === 2 && !this.delegate.isStrategic()) this.delegate.dispatchAt(e.clientX, e.clientY);
    });
    this.listen(canvas, "wheel", (e: WheelEvent) => {
      e.preventDefault();
      this.delegate.zoomAt(e.clientX, e.clientY, Math.pow(1.1, e.deltaY / 100));
    });
    this.listen(window, "keydown", (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (e.repeat) return;
      if (k === "q") this.thetaGoal += SNAP;
      else if (k === "e") this.thetaGoal -= SNAP;
      else if (k === "n") this.faceNorth();
      else if (k === "escape") this.delegate.deselect();
      else this.keys.add(k);
    });
    this.listen(window, "keyup", (e: KeyboardEvent) => {
      this.keys.delete(e.key.toLowerCase());
    });
  }

  faceNorth(): void {
    // Tween to the nearest full turn (theta = 0 mod 2pi).
    this.thetaGoal = Math.round(this.rig.theta / (2 * Math.PI)) * 2 * Math.PI;
  }

  /** Advance tweens, held-key panning and tilting. dt in seconds. */
  update(dt: number): void {
    const d = this.thetaGoal - this.rig.theta;
    if (Math.abs(d) < 1e-4) this.rig.theta = this.thetaGoal;
    else this.rig.theta += d * Math.min(1, dt * TWEEN_RATE);

    let rightAmt = 0;
    let fwdAmt = 0;
    if (this.keys.has("a") || this.keys.has("arrowleft")) rightAmt -= 1;
    if (this.keys.has("d") || this.keys.has("arrowright")) rightAmt += 1;
    if (this.keys.has("s") || this.keys.has("arrowdown")) fwdAmt -= 1;
    if (this.keys.has("w") || this.keys.has("arrowup")) fwdAmt += 1;
    if (rightAmt || fwdAmt) {
      this.rig.panKeys(rightAmt, fwdAmt, dt);
      this.rig.clampToMap(this.map);
    }

    if (this.keys.has("r")) this.rig.tiltBy(TILT_SPEED * dt);
    if (this.keys.has("f")) this.rig.tiltBy(-TILT_SPEED * dt);
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
    this.marqueeEl.remove();
  }

  private drawMarquee(x0: number, y0: number, x1: number, y1: number): void {
    const s = this.marqueeEl.style;
    s.display = "block";
    s.left = `${Math.min(x0, x1)}px`;
    s.top = `${Math.min(y0, y1)}px`;
    s.width = `${Math.abs(x1 - x0)}px`;
    s.height = `${Math.abs(y1 - y0)}px`;
  }

  private listen<K extends keyof HTMLElementEventMap>(t: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void): void;
  private listen<K extends keyof WindowEventMap>(t: Window, type: K, fn: (e: WindowEventMap[K]) => void): void;
  private listen(t: HTMLElement | Window, type: string, fn: (e: never) => void): void {
    t.addEventListener(type, fn as EventListener, { passive: false });
    this.disposers.push(() => t.removeEventListener(type, fn as EventListener));
  }
}
