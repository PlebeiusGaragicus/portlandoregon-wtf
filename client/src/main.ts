// Spectator-first boot: the map loads and renders immediately — no login.
// (Units and the multiplayer join flow return in a later phase; net.ts and
// the server's join path are kept for that.)
import { decodeHeightfield, type GameMap, type Heightfield } from "@battle-juice/shared";
import { Renderer } from "./render/index.js";
import { buildLandmarks } from "./render/landmarks.js";
import { buildProps } from "./render/props.js";
import { buildWorld } from "./render/world.js";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const loadingEl = document.getElementById("loading") as HTMLDivElement;
const statusEl = document.getElementById("loading-status") as HTMLParagraphElement;

/** Paint a status line, then yield two frames so it actually shows before
 * the next main-thread-blocking build step. */
async function status(text: string): Promise<void> {
  statusEl.textContent = text;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

async function boot(): Promise<void> {
  await status("downloading Portland…");
  const heightPromise: Promise<Heightfield | null> = fetch("/heightmap")
    .then(async (r) => (r.ok ? decodeHeightfield(await r.arrayBuffer()) : null))
    .catch(() => null);
  const res = await fetch("/map");
  if (!res.ok) throw new Error(`map fetch failed: ${res.status}`);
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
  new Renderer(canvas, map, { prebuilt: { world, props, landmarks }, heightfield: hf });
  loadingEl.classList.add("done");
}

boot().catch((err) => {
  statusEl.textContent = String(err);
});
