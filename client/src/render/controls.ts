import type { GameMap } from "@battle-juice/shared";
import { CameraRig } from "./camera.js";

const DRAG_THRESHOLD_PX = 4;
const SNAP = Math.PI / 4; // 8 rotation snap angles
const TWEEN_RATE = 12; // theta easing, higher = snappier
const TILT_SPEED = 1.2; // rad/s while R/F held

// Direct-manipulation rates, shared by touch gestures and mouse orbit.
const TILT_PER_PX = 0.005; // drag up = lower elevation angle = more oblique
const YAW_PER_PX = 0.006;

// Two-finger gesture arbitration. Totals accumulate from the moment the
// second finger lands; the first threshold crossed decides the gesture.
const TILT_TRIGGER_PX = 22; // parallel vertical travel of the midpoint
const SPREAD_TRIGGER_PX = 22; // change in finger separation
const TWIST_TRIGGER_RAD = 0.14; // change in finger-pair angle

const TAP_SLOP_PX = 12;
const LONG_PRESS_MS = 450;

/** Fold an angle difference into (-pi, pi] so it can cross the branch cut. */
function wrapPi(a: number): number {
  return a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
}

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

/** Finger-pair pose: separation, pair angle, and midpoint. */
interface Pose {
  dist: number;
  ang: number;
  mx: number;
  my: number;
}

interface Gesture {
  /** Pose when the second finger landed — the baseline for arbitration. */
  start: Pose;
  /** Pose at the previous move — the baseline for the increment we apply. */
  last: Pose;
  mode: "undecided" | "tilt" | "zoomrotate";
}

/**
 * Two input schemes over one camera rig.
 *
 * Mouse/trackpad (RTS/CAD-flavoured): left click selects (off-click
 * deselects), left drag marquee-selects, right click dispatches, middle drag
 * pans, middle+shift or alt+left drag orbits (horizontal yaws, vertical
 * tilts), WASD pans, Q/E snap-rotate, R/F tilt, N faces north, wheel zooms
 * toward the cursor. In strategic view (far zoom) left drag pans instead and
 * selection is off.
 *
 * Touch (Google Maps-flavoured): one finger drags the map, one tap selects, a
 * long press dispatches; two fingers pinch to zoom and twist to rotate about
 * the gesture midpoint, while a two-finger parallel drag up/down tilts.
 */
export class Controls {
  /** False while FPV mode owns the input (all handlers become inert). */
  active = true;
  private thetaGoal = 0;
  private keys = new Set<string>();
  private pointer: {
    x: number;
    y: number;
    button: number;
    mode: "idle" | "maybe" | "pan" | "marquee" | "orbit";
  } | null = null;
  private touches = new Map<number, { x: number; y: number }>();
  private tap: { x: number; y: number; moved: boolean; timer: number } | null = null;
  private gesture: Gesture | null = null;
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
      if (!this.active) return;
      if (e.pointerType === "touch") {
        canvas.setPointerCapture(e.pointerId);
        this.touchDown(e);
        return;
      }
      if (e.button === 1) {
        this.pointer = { x: e.clientX, y: e.clientY, button: 1, mode: e.shiftKey ? "orbit" : "pan" };
      } else if (e.button === 0) {
        this.pointer = { x: e.clientX, y: e.clientY, button: 0, mode: e.altKey ? "orbit" : "maybe" };
      } else {
        return;
      }
      canvas.setPointerCapture(e.pointerId);
    });
    this.listen(canvas, "pointermove", (e: PointerEvent) => {
      if (!this.active) return;
      if (e.pointerType === "touch") {
        this.touchMove(e);
        return;
      }
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
      } else if (p.mode === "orbit") {
        this.rotateBy(e.movementX * YAW_PER_PX);
        this.rig.tiltBy(e.movementY * TILT_PER_PX);
      } else if (p.mode === "marquee") {
        this.drawMarquee(p.x, p.y, e.clientX, e.clientY);
      }
    });
    this.listen(canvas, "pointerup", (e: PointerEvent) => {
      if (!this.active) return;
      if (e.pointerType === "touch") {
        this.touchUp(e);
        return;
      }
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
    this.listen(canvas, "pointercancel", (e: PointerEvent) => {
      if (e.pointerType === "touch") {
        this.touchUp(e);
        return;
      }
      this.pointer = null;
      this.marqueeEl.style.display = "none";
    });
    // Right click never drags: dispatch on the raw event.
    this.listen(canvas, "pointerdown", (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      if (e.button === 2 && this.active && !this.delegate.isStrategic()) this.delegate.dispatchAt(e.clientX, e.clientY);
    });
    this.listen(canvas, "wheel", (e: WheelEvent) => {
      e.preventDefault(); // also suppresses trackpad pinch-to-page-zoom
      if (!this.active) return;
      // Trackpad pinch arrives as ctrl+wheel with much smaller deltas.
      const scale = e.ctrlKey ? 0.35 : 1;
      this.delegate.zoomAt(e.clientX, e.clientY, Math.pow(1.1, (e.deltaY * scale) / 100));
    });
    this.listen(window, "keydown", (e: KeyboardEvent) => {
      if (!this.active) return;
      const k = e.key.toLowerCase();
      if (e.repeat) return;
      if (k === "q") this.snapRotate(-1);
      else if (k === "e") this.snapRotate(1);
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
    if (!this.active) return;
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
    this.cancelLongPress();
    this.marqueeEl.remove();
  }

  /**
   * Step to the next snap angle, re-aligning to the 45-degree grid so a free
   * drag-rotate followed by Q/E still lands on a clean bearing. dir +1 swings
   * the camera left, which reads as the map turning clockwise.
   */
  private snapRotate(dir: number): void {
    this.thetaGoal = (Math.round(this.thetaGoal / SNAP) + dir) * SNAP;
  }

  /** Free rotation (drag/twist): move theta now and drop any pending tween. */
  private rotateBy(delta: number): void {
    this.rig.theta += delta;
    this.thetaGoal = this.rig.theta;
  }

  // ---- touch ----------------------------------------------------------

  private touchDown(e: PointerEvent): void {
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.touches.size === 1) {
      this.tap = { x: e.clientX, y: e.clientY, moved: false, timer: 0 };
      if (!this.delegate.isStrategic()) {
        this.tap.timer = window.setTimeout(() => {
          const t = this.tap;
          if (!t || t.moved || this.touches.size !== 1) return;
          this.tap = null;
          this.delegate.dispatchAt(t.x, t.y);
        }, LONG_PRESS_MS);
      }
    } else if (this.touches.size === 2) {
      this.cancelLongPress();
      this.beginGesture();
    } else {
      this.gesture = null; // three or more fingers: ignore until we're back to two
    }
  }

  private touchMove(e: PointerEvent): void {
    const prev = this.touches.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    prev.x = e.clientX;
    prev.y = e.clientY;

    if (this.touches.size === 1) {
      const t = this.tap;
      if (t && !t.moved && Math.hypot(e.clientX - t.x, e.clientY - t.y) > TAP_SLOP_PX) {
        t.moved = true;
        this.cancelLongPress();
      }
      this.rig.panScreen(dx, dy, this.canvas.clientHeight);
      this.rig.clampToMap(this.map);
      return;
    }
    if (this.touches.size === 2) this.updateGesture();
  }

  private touchUp(e: PointerEvent): void {
    const t = this.tap;
    const lifted = this.touches.delete(e.pointerId);
    if (!lifted) return;
    this.gesture = null;
    if (this.touches.size === 0) {
      this.cancelLongPress();
      this.tap = null;
      if (t && !t.moved && e.type === "pointerup" && !this.delegate.isStrategic()) {
        this.delegate.selectAt(e.clientX, e.clientY);
      }
    } else {
      // Dropping from two fingers to one: resume panning, but never as a tap.
      this.tap = null;
    }
  }

  private cancelLongPress(): void {
    if (this.tap?.timer) window.clearTimeout(this.tap.timer);
    if (this.tap) this.tap.timer = 0;
  }

  /** Current pose of the two live fingers, or null if there aren't two. */
  private pose(): Pose | null {
    const [a, b] = [...this.touches.values()];
    if (!a || !b) return null;
    return {
      dist: Math.hypot(b.x - a.x, b.y - a.y),
      ang: Math.atan2(b.y - a.y, b.x - a.x),
      mx: (a.x + b.x) / 2,
      my: (a.y + b.y) / 2,
    };
  }

  /** Snapshot the finger pair so the next move is measured against it. */
  private beginGesture(): void {
    const p = this.pose();
    if (!p) return;
    this.gesture = { start: p, last: { ...p }, mode: "undecided" };
  }

  private updateGesture(): void {
    const g = this.gesture;
    if (!g) {
      this.beginGesture();
      return;
    }
    const cur = this.pose();
    if (!cur) return;

    if (g.mode === "undecided") {
      // Arbitrate on displacement since the gesture began, never on a sum of
      // per-event deltas: touch moves arrive one finger at a time, so a pure
      // tilt drag momentarily spreads and twists the pair on every other
      // event. Summing that noise would let pinch win every time.
      const spread = Math.abs(cur.dist - g.start.dist);
      const twist = Math.abs(wrapPi(cur.ang - g.start.ang));
      const mdx = cur.mx - g.start.mx;
      const mdy = cur.my - g.start.my;
      if (Math.abs(mdy) > TILT_TRIGGER_PX && Math.abs(mdy) > 2 * Math.abs(mdx) && spread < SPREAD_TRIGGER_PX && twist < TWIST_TRIGGER_RAD) {
        g.mode = "tilt";
      } else if (spread > SPREAD_TRIGGER_PX || twist > TWIST_TRIGGER_RAD || Math.hypot(mdx, mdy) > TILT_TRIGGER_PX) {
        g.mode = "zoomrotate";
      } else {
        return; // still ambiguous — hold still rather than drift
      }
      // Recognition costs a threshold's worth of travel. Replay it from the
      // gesture's start so the whole drag ends up tracking the fingers 1:1.
      g.last = g.start;
    }

    const dSpread = cur.dist - g.last.dist;
    const dAng = wrapPi(cur.ang - g.last.ang);
    const dmx = cur.mx - g.last.mx;
    const dmy = cur.my - g.last.my;
    g.last = cur;

    if (g.mode === "tilt") {
      this.rig.tiltBy(dmy * TILT_PER_PX);
      return;
    }
    // Zoom about the midpoint, twist the map with the fingers, and let the
    // midpoint itself drag the map (all three run together, as on a map app).
    if (cur.dist > 1 && cur.dist - dSpread > 1) this.delegate.zoomAt(cur.mx, cur.my, (cur.dist - dSpread) / cur.dist);
    this.rotateBy(dAng);
    this.rig.panScreen(dmx, dmy, this.canvas.clientHeight);
    this.rig.clampToMap(this.map);
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
