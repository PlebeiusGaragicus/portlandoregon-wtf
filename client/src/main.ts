// Spectator-first boot: the map loads and renders immediately — no login, and
// no server. The city ships with the site as a static asset, so the game runs
// standalone on GitHub Pages. (Units and the multiplayer join flow return in a
// later phase; net.ts and the server's join path are kept for that.)
import * as THREE from "three";
import type { Heightfield } from "@battle-juice/shared";
import { loadHeightfield, loadMap, MapUnavailableError } from "./mapdata.js";
import { Renderer } from "./render/index.js";
import { buildLandmarks } from "./render/landmarks.js";
import { buildProps } from "./render/props.js";
import { buildWorld } from "./render/world.js";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const loadingEl = document.getElementById("loading") as HTMLDivElement;
const statusEl = document.getElementById("loading-status") as HTMLParagraphElement;

/** Paint a status line, then yield two frames so it actually shows before
 * the next main-thread-blocking build step.
 *
 * Raced against a timer because background tabs throttle requestAnimationFrame
 * to a stop: without the race, loading a backgrounded tab hangs on whatever
 * status line it reached and never even issues the map request. */
async function status(text: string): Promise<void> {
  statusEl.textContent = text;
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    requestAnimationFrame(() => requestAnimationFrame(done));
    setTimeout(done, 100);
  });
}

/** Boot is slow enough (tens of seconds on a cold load) that "which phase" is
 * the first question whenever it feels wrong. Timings go to the console so the
 * answer is one refresh away. */
function phase(label: string, startedAt: number): number {
  const now = performance.now();
  console.log(`[boot] ${label}: ${((now - startedAt) / 1000).toFixed(2)}s`);
  return now;
}

async function boot(): Promise<void> {
  const bootStart = performance.now();
  let t = bootStart;

  await status("downloading Portland…");
  const heightPromise: Promise<Heightfield | null> = loadHeightfield();
  const map = await loadMap();
  t = phase("download + decode map", t);
  await status("unpacking the city…");
  const hf = await heightPromise;
  t = phase("heightmap", t);

  await status("raising terrain, streets and 538k buildings…");
  const world = buildWorld(map, hf);
  t = phase("buildWorld", t);
  await status("planting trees and street lights…");
  const props = buildProps(map, hf);
  t = phase("buildProps", t);
  await status("labeling landmarks…");
  const landmarks = buildLandmarks(map, hf);
  t = phase("buildLandmarks", t);

  await status("ready");
  phase("TOTAL", bootStart);
  const renderer = new Renderer(canvas, map, { prebuilt: { world, props, landmarks }, heightfield: hf });
  // Dev/debug handle (headless smoke tests steer the camera through this).
  (window as unknown as Record<string, unknown>)["__bj"] = { renderer, THREE };
  loadingEl.classList.add("done");
}

const offlineDetailEl = document.getElementById("offline-detail") as HTMLParagraphElement;
const retryBtn = document.getElementById("retry") as HTMLButtonElement;
const retryNoteEl = document.getElementById("retry-note") as HTMLParagraphElement;

let retryTimer = 0;
let countdownTimer = 0;
/** Back off 5s, 10s, 20s, 40s, capped at a minute. The map is a static asset,
 * so a failure here is a flaky connection or a CDN hiccup — both worth a few
 * quiet retries rather than one and a dead end. */
let retryDelayMs = 5_000;

function showOffline(detail: string): void {
  loadingEl.classList.add("offline");
  statusEl.textContent = "couldn't load the city";
  offlineDetailEl.textContent = detail;
  retryBtn.disabled = false;

  let secondsLeft = Math.round(retryDelayMs / 1000);
  const tick = (): void => {
    retryNoteEl.textContent = `retrying in ${secondsLeft}s`;
    secondsLeft -= 1;
  };
  tick();
  countdownTimer = window.setInterval(tick, 1000);
  retryTimer = window.setTimeout(attempt, retryDelayMs);
  retryDelayMs = Math.min(retryDelayMs * 2, 60_000);
}

function attempt(): void {
  window.clearTimeout(retryTimer);
  window.clearInterval(countdownTimer);
  loadingEl.classList.remove("offline");
  retryBtn.disabled = true;
  retryNoteEl.textContent = "";
  statusEl.textContent = "loading the city…";

  boot().catch((err) => {
    if (err instanceof MapUnavailableError) {
      showOffline(
        "The map couldn't be downloaded. Check your connection — this page will keep trying.",
      );
      return;
    }
    // A real bug — surface it rather than blaming the network.
    loadingEl.classList.add("offline");
    statusEl.textContent = "something went wrong";
    offlineDetailEl.textContent = String(err);
    retryBtn.disabled = false;
    retryNoteEl.textContent = "";
  });
}

retryBtn.addEventListener("click", () => {
  retryDelayMs = 5_000;
  attempt();
});

attempt();
