// Spectator-first boot: the map loads and renders immediately — no login.
// (Units and the multiplayer join flow return in a later phase; net.ts and
// the server's join path are kept for that.)
import * as THREE from "three";
import { decodeHeightfield, type GameMap, type Heightfield } from "@battle-juice/shared";
import { Renderer } from "./render/index.js";
import { buildLandmarks } from "./render/landmarks.js";
import { buildProps } from "./render/props.js";
import { buildWorld } from "./render/world.js";
import { apiUrl } from "./server.js";

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

/** The server is reachable-but-down, or not reachable at all. Distinguished
 * from a genuine bug so the UI can say something the player can act on. */
class ServerDownError extends Error {
  constructor(readonly detail: string) {
    super(detail);
  }
}

/** The city lives on the game server, so there is nothing to render without it.
 * Translate the ways that fetch can fail into one actionable message. */
async function fetchMap(): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(apiUrl("/map"));
  } catch {
    // DNS failure, refused connection, TLS failure, offline browser.
    throw new ServerDownError(
      "The game server can't be reached. It may be offline, or your connection may be down.",
    );
  }
  // reverse proxy is up and proxying, but nothing is listening behind it.
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    throw new ServerDownError(
      "The game server isn't running right now. It should come back on its own — this page will keep checking.",
    );
  }
  if (!res.ok) throw new Error(`map fetch failed: ${res.status}`);
  return res;
}

async function boot(): Promise<void> {
  await status("downloading Portland…");
  const heightPromise: Promise<Heightfield | null> = fetch(apiUrl("/heightmap"))
    .then(async (r) => (r.ok ? decodeHeightfield(await r.arrayBuffer()) : null))
    .catch(() => null);
  const res = await fetchMap();
  await status("unpacking the city…");
  const map = (await res.json()) as GameMap;
  const hf = await heightPromise;

  await status("raising terrain, streets and 538k buildings…");
  const world = buildWorld(map, hf);
  await status("planting trees and street lights…");
  const props = buildProps(map, hf);
  await status("labeling landmarks…");
  const landmarks = buildLandmarks(map, hf);

  await status("ready");
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
/** Back off 5s, 10s, 20s, 40s, capped at a minute — a server that is being
 * restarted comes back fast; one that is off for the evening shouldn't be
 * hammered. */
let retryDelayMs = 5_000;

function showOffline(detail: string): void {
  loadingEl.classList.add("offline");
  statusEl.textContent = "can't reach the game";
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
  statusEl.textContent = "contacting server…";

  boot().catch((err) => {
    if (err instanceof ServerDownError) {
      showOffline(err.detail);
      return;
    }
    // A real bug — surface it rather than pretending the server is down.
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
