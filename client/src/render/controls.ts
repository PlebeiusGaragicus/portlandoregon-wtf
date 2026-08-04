import type { GameMap } from "@battle-juice/shared";
import type { CameraRig } from "./camera.js";

const DRAG_THRESHOLD_PX = 4;
const SNAP = Math.PI / 4; // 8 snap angles
const TWEEN_RATE = 12; // theta easing, higher = snappier

/**
 * Pointer/wheel/keyboard input -> CameraRig mutations.
 * A left press that never travels past the drag threshold is a ground click.
 */
export class Controls {
  private thetaGoal = 0;
  private keys = new Set<string>();
  private pointerDown: { x: number; y: number; button: number } | null = null;
  private dragging = false;
  private disposers: (() => void)[] = [];

  constructor(
    private canvas: HTMLCanvasElement,
    private rig: CameraRig,
    private map: GameMap,
    private onGroundClick: (clientX: number, clientY: number) => void,
  ) {
    this.listen(canvas, "pointerdown", (e: PointerEvent) => {
      if (e.button !== 0 && e.button !== 1) return;
      this.pointerDown = { x: e.clientX, y: e.clientY, button: e.button };
      this.dragging = e.button === 1; // middle button drags immediately
      canvas.setPointerCapture(e.pointerId);
    });
    this.listen(canvas, "pointermove", (e: PointerEvent) => {
      if (!this.pointerDown) return;
      if (!this.dragging) {
        const dist = Math.hypot(e.clientX - this.pointerDown.x, e.clientY - this.pointerDown.y);
        if (dist > DRAG_THRESHOLD_PX) this.dragging = true;
      }
      if (this.dragging) {
        this.rig.panScreen(e.movementX, e.movementY, canvas.clientHeight);
        this.rig.clampToMap(this.map);
      }
    });
    this.listen(canvas, "pointerup", (e: PointerEvent) => {
      if (!this.pointerDown) return;
      const wasClick = !this.dragging && this.pointerDown.button === 0;
      this.pointerDown = null;
      this.dragging = false;
      if (wasClick) this.onGroundClick(e.clientX, e.clientY);
    });
    this.listen(canvas, "wheel", (e: WheelEvent) => {
      e.preventDefault();
      this.rig.zoomBy(Math.pow(1.1, e.deltaY / 100));
    });
    this.listen(window, "keydown", (e: KeyboardEvent) => {
      if (e.repeat) return;
      const k = e.key.toLowerCase();
      if (k === "q") this.thetaGoal += SNAP;
      else if (k === "e") this.thetaGoal -= SNAP;
      else this.keys.add(k);
    });
    this.listen(window, "keyup", (e: KeyboardEvent) => {
      this.keys.delete(e.key.toLowerCase());
    });
  }

  /** Advance tweens and held-key panning. dt in seconds. */
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
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
  }

  private listen<K extends keyof HTMLElementEventMap>(t: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void): void;
  private listen<K extends keyof WindowEventMap>(t: Window, type: K, fn: (e: WindowEventMap[K]) => void): void;
  private listen(t: HTMLElement | Window, type: string, fn: (e: never) => void): void {
    t.addEventListener(type, fn as EventListener, { passive: false });
    this.disposers.push(() => t.removeEventListener(type, fn as EventListener));
  }
}
