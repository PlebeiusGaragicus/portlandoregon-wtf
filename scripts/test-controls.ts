// Checks client/src/render/controls.ts against a stub DOM by replaying
// synthetic pointer events.
//
//   npx tsx scripts/test-controls.ts
//
// Touch gestures are the part of the input layer that is most tedious to
// verify by hand — a pinch-twist has to be tried on a real phone, and the
// sign errors it hides (map rotating away from your fingers, tilt inverted)
// are exactly the ones you cannot spot from reading the code. This drives the
// gesture recogniser directly so the arbitration thresholds and every
// direction stay pinned.
import type { GameMap } from "@battle-juice/shared";
import { CameraRig } from "../client/src/render/camera.js";
import { Controls, type ControlDelegate } from "../client/src/render/controls.js";

const map = {
  meta: { name: "portland", sourceDate: "test", origin: { lat: 45.33, lon: -122.86 }, width: 43573, height: 35780 },
} as GameMap;

type Handler = (e: unknown) => void;
const handlers = new Map<string, Handler[]>();
const on = (type: string, fn: Handler): void => void handlers.set(type, [...(handlers.get(type) ?? []), fn]);
const fire = (type: string, e: Record<string, unknown>): void => {
  for (const fn of handlers.get(type) ?? []) fn({ type, preventDefault() {}, ...e });
};

const stubEl = (): unknown => ({
  id: "",
  style: {} as Record<string, string>,
  appendChild() {},
  remove() {},
  addEventListener() {},
  removeEventListener() {},
});
(globalThis as unknown as { document: Document }).document = {
  createElement: stubEl,
} as unknown as Document;

const canvas = {
  clientHeight: 800,
  clientWidth: 1200,
  parentElement: stubEl(),
  setPointerCapture() {},
  addEventListener: on,
  removeEventListener() {},
} as unknown as HTMLCanvasElement;
// Fake timers, so the long-press delay costs nothing and cannot flake.
const timers = new Map<number, () => void>();
let nextTimer = 1;
const runTimers = (): void => {
  const due = [...timers.values()];
  timers.clear();
  for (const fn of due) fn();
};
(globalThis as unknown as { window: Window }).window = {
  addEventListener: on,
  removeEventListener() {},
  setTimeout: (fn: () => void) => {
    timers.set(nextTimer, fn);
    return nextTimer++;
  },
  clearTimeout: (id: number) => void timers.delete(id),
} as unknown as Window;

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const calls: string[] = [];
let rig = new CameraRig(map);
let strategic = false;
const worldAt = (clientX: number, clientY: number): { x: number; y: number } => {
  const mpp = rig.viewHeight / canvas.clientHeight;
  const right = rig.right();
  const forward = rig.forward();
  const sx = clientX - canvas.clientWidth / 2;
  const sy = clientY - canvas.clientHeight / 2;
  const fwd = (-sy * mpp) / Math.sin(rig.metrics().effectiveTilt);
  return {
    x: rig.target.x + sx * mpp * right.x + fwd * forward.x,
    y: rig.target.y + sx * mpp * right.y + fwd * forward.y,
  };
};
const delegate: ControlDelegate = {
  isStrategic: () => strategic,
  selectAt: (x, y) => void calls.push(`select ${x},${y}`),
  marqueeSelect: () => void calls.push("marquee"),
  dispatchAt: (x, y) => void calls.push(`dispatch ${x},${y}`),
  deselect: () => void calls.push("deselect"),
  zoomAt: (x, y, f) => {
    calls.push(`zoom ${f.toFixed(3)} @${x},${y}`);
    const before = worldAt(x, y);
    rig.zoomBy(f);
    rig.alignWorldPoint(before, worldAt(x, y));
  },
  transformAt: (fromX, fromY, toX, toY, factor, rotation) => {
    calls.push(`transform ${factor.toFixed(3)},${rotation.toFixed(3)} @${fromX},${fromY}->${toX},${toY}`);
    const before = worldAt(fromX, fromY);
    rig.theta += rotation;
    rig.zoomBy(factor);
    rig.alignWorldPoint(before, worldAt(toX, toY));
  },
  tiltAt: (x, y, delta) => {
    calls.push(`tilt ${delta.toFixed(3)} @${x},${y}`);
    const before = worldAt(x, y);
    rig.tiltBy(delta);
    rig.alignWorldPoint(before, worldAt(x, y));
  },
  fireballAt: (x, y) => void calls.push(`fireball ${x},${y}`),
};

let controls: Controls;
function reset(theta = 0): void {
  controls?.dispose();
  handlers.clear();
  calls.length = 0;
  strategic = false;
  rig = new CameraRig(map);
  rig.viewHeight = 2000;
  rig.theta = theta;
  controls = new Controls(canvas, rig, map, delegate);
}

// Touch helpers. A gesture is a series of absolute finger positions.
const down = (id: number, x: number, y: number): void => fire("pointerdown", { pointerId: id, pointerType: "touch", clientX: x, clientY: y, button: 0 });
const move = (id: number, x: number, y: number): void => fire("pointermove", { pointerId: id, pointerType: "touch", clientX: x, clientY: y });
const up = (id: number, x: number, y: number): void => fire("pointerup", { pointerId: id, pointerType: "touch", clientX: x, clientY: y, button: 0 });
const cancel = (id: number, x: number, y: number): void => fire("pointercancel", { pointerId: id, pointerType: "touch", clientX: x, clientY: y, button: 0 });
/** Walk two fingers from their current spots to the given ones in N steps. */
function drag2(a0: [number, number], b0: [number, number], a1: [number, number], b1: [number, number], steps = 10): void {
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const a: [number, number] = [a0[0] + (a1[0] - a0[0]) * t, a0[1] + (a1[1] - a0[1]) * t];
    const b: [number, number] = [b0[0] + (b1[0] - b0[0]) * t, b0[1] + (b1[1] - b0[1]) * t];
    // Real browsers do not promise which finger's event arrives first.
    if (i % 2) {
      move(1, a[0], a[1]);
      move(2, b[0], b[1]);
    } else {
      move(2, b[0], b[1]);
      move(1, a[0], a[1]);
    }
    controls.update(1 / 60);
  }
}

console.log("\nsingle touch");
{
  // 1. A tap with no movement selects.
  reset();
  down(1, 600, 400);
  up(1, 601, 401);
  check("tap selects", calls.some((c) => c.startsWith("select")), calls.join("; "));

  // 2. A drag pans the map with the finger and never selects.
  reset();
  const t0 = { ...rig.target };
  down(1, 600, 400);
  for (let i = 1; i <= 10; i++) {
    move(1, 600 + i * 10, 400);
    controls.update(1 / 60);
  }
  up(1, 700, 400);
  check("drag pans, no select", !calls.length && rig.target.x !== t0.x, `dx=${(rig.target.x - t0.x).toFixed(0)}m`);
  // theta = 0 means screen-right is world +x; dragging right pulls the map
  // right, so the camera target must move to smaller x.
  check("pan follows the finger", rig.target.x < t0.x, `x ${t0.x.toFixed(0)} -> ${rig.target.x.toFixed(0)}`);

  // 3. Holding still past the long-press delay drops a fireball even when
  // tactical selection/dispatch is disabled at strategic zoom.
  reset();
  strategic = true;
  down(1, 600, 400);
  runTimers();
  check("long press creates a fireball", calls.some((c) => c.startsWith("fireball")), calls.join("; "));
  up(1, 600, 400);
  check("long press then lift does not also select", !calls.some((c) => c.startsWith("select")), calls.join("; "));

  reset();
  down(1, 600, 400);
  move(1, 620, 400);
  runTimers();
  check("moving beyond tap slop cancels fireball", !calls.some((c) => c.startsWith("fireball")), calls.join("; "));

  reset();
  down(1, 500, 400);
  down(2, 700, 400);
  runTimers();
  check("second finger cancels fireball", !calls.some((c) => c.startsWith("fireball")), calls.join("; "));

  reset();
  down(1, 600, 400);
  cancel(1, 600, 400);
  runTimers();
  check("pointer cancellation cannot fire or select", calls.length === 0, calls.join("; "));
}

console.log("\npinch");
{
  reset();
  const vh0 = rig.viewHeight;
  down(1, 500, 400);
  down(2, 700, 400);
  drag2([500, 400], [700, 400], [300, 400], [900, 400]); // spread apart
  check("spread zooms in", rig.viewHeight < vh0, `${vh0} -> ${rig.viewHeight.toFixed(0)}m`);
  check("rotation stays put while pinching", Math.abs(rig.theta) < 1e-6, `theta=${rig.theta.toFixed(4)}`);
  up(1, 300, 400);
  up(2, 900, 400);

  reset();
  const vh1 = rig.viewHeight;
  down(1, 300, 400);
  down(2, 900, 400);
  drag2([300, 400], [900, 400], [500, 400], [700, 400]); // pinch together
  check("pinch zooms out", rig.viewHeight > vh1, `${vh1} -> ${rig.viewHeight.toFixed(0)}m`);
  up(1, 500, 400);
  up(2, 700, 400);
}

console.log("\ncombined two-finger transform");
{
  reset();
  down(1, 500, 400);
  down(2, 700, 400);
  const target0 = { ...rig.target };
  move(1, 512, 400);
  move(2, 712, 400);
  controls.update(1 / 60);
  check(
    "recognition slop is consumed without a camera jump",
    calls.every((c) => !c.startsWith("transform")) &&
      rig.target.x === target0.x &&
      rig.target.y === target0.y,
    calls.join("; "),
  );

  const anchor = worldAt(612, 400);
  drag2([512, 400], [712, 400], [501.4, 350], [778.6, 510], 20);
  const anchored = worldAt(640, 430);
  check(
    "moving midpoint pans while pinching and twisting",
    calls.some((c) => c.startsWith("transform")) &&
      rig.viewHeight !== 2000 &&
      Math.abs(rig.theta) > 0.1,
    `view=${rig.viewHeight.toFixed(1)} theta=${rig.theta.toFixed(3)}`,
  );
  check(
    "combined transform preserves the midpoint world anchor",
    Math.hypot(anchored.x - anchor.x, anchored.y - anchor.y) < 1e-6,
    `drift=${Math.hypot(anchored.x - anchor.x, anchored.y - anchor.y).toExponential(2)}m`,
  );
}

console.log("\ntwist");
{
  // Rotate the finger pair 45 degrees clockwise on screen about (600, 400).
  const R = 200;
  const at = (deg: number): [[number, number], [number, number]] => {
    const r = (deg * Math.PI) / 180;
    return [
      [600 - R * Math.cos(r), 400 - R * Math.sin(r)],
      [600 + R * Math.cos(r), 400 + R * Math.sin(r)],
    ];
  };
  reset();
  const [a0, b0] = at(0);
  down(1, a0[0], a0[1]);
  down(2, b0[0], b0[1]);
  const [a1, b1] = at(45);
  drag2(a0, b0, a1, b1, 20);
  // Screen y is down, so a positive atan2 sweep is clockwise; the map should
  // turn clockwise with the fingers, which is theta increasing.
  check("clockwise twist turns the map clockwise", rig.theta > 0, `theta=${((rig.theta * 180) / Math.PI).toFixed(1)}deg`);
  check("twist follows the fingers after recognition slop", Math.abs((rig.theta * 180) / Math.PI - 45) < 7, `${((rig.theta * 180) / Math.PI).toFixed(1)}deg of 45`);
  up(1, a1[0], a1[1]);
  up(2, b1[0], b1[1]);

  reset();
  const [c0, d0] = at(0);
  down(1, c0[0], c0[1]);
  down(2, d0[0], d0[1]);
  const [c1, d1] = at(-45);
  drag2(c0, d0, c1, d1, 20);
  check("counter-clockwise twist turns the map back", rig.theta < 0, `theta=${((rig.theta * 180) / Math.PI).toFixed(1)}deg`);
  up(1, c1[0], c1[1]);
  up(2, d1[0], d1[1]);
}

console.log("\ntwo-finger tilt");
{
  reset();
  const tilt0 = rig.tilt;
  down(1, 500, 400);
  down(2, 700, 400);
  drag2([500, 400], [700, 400], [500, 250], [700, 250]); // both fingers up
  check("drag up tilts toward the horizon", rig.tilt < tilt0, `${((tilt0 * 180) / Math.PI).toFixed(1)} -> ${((rig.tilt * 180) / Math.PI).toFixed(1)}deg`);
  check("tilt gesture does not transform", !calls.some((c) => c.startsWith("transform")), calls.join("; "));
  check("tilt gesture does not rotate", Math.abs(rig.theta) < 1e-6, `theta=${rig.theta.toFixed(4)}`);
  up(1, 500, 250);
  up(2, 700, 250);

  reset();
  const tilt1 = rig.tilt;
  down(1, 500, 300);
  down(2, 700, 300);
  drag2([500, 300], [700, 300], [500, 450], [700, 450]); // both fingers down
  check("drag down tilts toward top-down", rig.tilt > tilt1, `${((tilt1 * 180) / Math.PI).toFixed(1)} -> ${((rig.tilt * 180) / Math.PI).toFixed(1)}deg`);
  up(1, 500, 450);
  up(2, 700, 450);

  // A tilt drag must survive the fingers not being perfectly parallel.
  reset();
  const tilt2 = rig.tilt;
  down(1, 500, 400);
  down(2, 700, 400);
  drag2([500, 400], [700, 400], [508, 250], [694, 256]);
  check("sloppy tilt drag still tilts", rig.tilt < tilt2 - 0.05 && Math.abs(rig.theta) < 1e-6, `theta=${rig.theta.toFixed(3)} tilt=${((rig.tilt * 180) / Math.PI).toFixed(1)}deg`);
  up(1, 508, 250);
  up(2, 694, 256);
}

console.log("\ntwo fingers to one");
{
  reset();
  down(1, 500, 400);
  down(2, 700, 400);
  drag2([500, 400], [700, 400], [300, 400], [900, 400]);
  up(2, 900, 400);
  calls.length = 0;
  const t0 = { ...rig.target };
  for (let i = 1; i <= 10; i++) {
    move(1, 300 + i * 10, 400);
    controls.update(1 / 60);
  }
  up(1, 400, 400);
  check("lifting one finger resumes panning", rig.target.x !== t0.x, `dx=${(rig.target.x - t0.x).toFixed(0)}m`);
  check("the remaining finger never selects", !calls.length, calls.join("; "));
}

console.log("\nkeyboard");
{
  const key = (k: string): void => fire("keydown", { key: k, repeat: false });
  reset(0.63);
  for (let i = 0; i < 30; i++) controls.update(1 / 60);
  check("restored heading is not tweened to north", Math.abs(rig.theta - 0.63) < 1e-6, `theta=${rig.theta.toFixed(3)}`);

  reset();
  key("q");
  for (let i = 0; i < 200; i++) controls.update(1 / 60);
  const q = rig.theta;
  check("Q rotates", Math.abs(q) > 1e-3, `theta=${((q * 180) / Math.PI).toFixed(1)}deg`);
  check("Q steps one snap angle", Math.abs(Math.abs(q) - Math.PI / 4) < 1e-3, `${((Math.abs(q) * 180) / Math.PI).toFixed(1)}deg`);
  // Q and E must be mirror images. Increasing theta is a clockwise turn (see
  // the twist tests above), so Q — which decreases it — turns the map
  // counter-clockwise, matching a twist to the left.
  reset();
  key("e");
  for (let i = 0; i < 200; i++) controls.update(1 / 60);
  check("E rotates opposite Q", Math.sign(rig.theta) === -Math.sign(q), `Q=${q.toFixed(3)} E=${rig.theta.toFixed(3)}`);
  check("Q turns the map counter-clockwise", q < 0, `Q theta=${q.toFixed(3)}`);

  // After a free twist, Q/E must re-align to the 45-degree grid.
  reset();
  down(1, 500, 400);
  down(2, 700, 400);
  drag2([500, 400], [700, 400], [520, 330], [680, 470], 20); // arbitrary twist
  up(1, 520, 330);
  up(2, 680, 470);
  const free = rig.theta;
  check("free twist leaves an off-grid angle", Math.abs(free % (Math.PI / 4)) > 1e-3, `${((free * 180) / Math.PI).toFixed(1)}deg`);
  key("q");
  for (let i = 0; i < 200; i++) controls.update(1 / 60);
  const snapped = (rig.theta / (Math.PI / 4)) % 1;
  check("Q after a twist lands on the grid", Math.abs(snapped) < 1e-3, `${((rig.theta * 180) / Math.PI).toFixed(1)}deg`);
}

console.log("\nmouse (unchanged paths)");
{
  const mdown = (button: number, x: number, y: number, mod: Record<string, boolean> = {}): void =>
    fire("pointerdown", { pointerId: 9, pointerType: "mouse", button, clientX: x, clientY: y, shiftKey: false, altKey: false, ...mod });
  const mmove = (x: number, y: number, dx: number, dy: number): void =>
    fire("pointermove", { pointerId: 9, pointerType: "mouse", clientX: x, clientY: y, movementX: dx, movementY: dy });
  const mup = (button: number, x: number, y: number): void => fire("pointerup", { pointerId: 9, pointerType: "mouse", button, clientX: x, clientY: y });

  reset();
  mdown(0, 600, 400);
  mup(0, 600, 400);
  check("left click selects", calls.some((c) => c.startsWith("select")), calls.join("; "));

  reset();
  mdown(2, 600, 400);
  check("right click dispatches", calls.some((c) => c.startsWith("dispatch")), calls.join("; "));

  reset();
  mdown(0, 600, 400);
  mmove(650, 400, 50, 0);
  mup(0, 650, 400);
  check("left drag marquees", calls.includes("marquee"), calls.join("; "));

  reset();
  const t0 = { ...rig.target };
  mdown(1, 600, 400);
  mmove(650, 400, 50, 0);
  check("middle drag pans", rig.target.x !== t0.x, `dx=${(rig.target.x - t0.x).toFixed(0)}m`);
  mup(1, 650, 400);

  reset();
  const tilt0 = rig.tilt;
  mdown(0, 600, 400, { altKey: true });
  mmove(700, 300, 100, -100);
  check("alt+drag orbits", rig.theta > 0 && rig.tilt < tilt0, `theta=${rig.theta.toFixed(3)} tilt=${((rig.tilt * 180) / Math.PI).toFixed(1)}deg`);
  mup(0, 700, 300);

  reset();
  const vh0 = rig.viewHeight;
  fire("wheel", { deltaY: -100, clientX: 600, clientY: 400, ctrlKey: false });
  check("wheel up zooms in", rig.viewHeight < vh0, `${vh0} -> ${rig.viewHeight.toFixed(0)}m`);
}

controls.dispose();
console.log(failures ? `\n${failures} failing check(s)` : "\nall checks passed");
process.exit(failures ? 1 : 0);
