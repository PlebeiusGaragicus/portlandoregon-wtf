// Spectator-first boot: the map loads and renders immediately — no login, and
// no server. The city ships with the site as a static asset, so the game runs
// standalone on GitHub Pages. (Units and the multiplayer join flow return in a
// later phase; net.ts and the server's join path are kept for that.)
import * as THREE from "three";
import type { BuildingStore, CityLod, Heightfield, LayerStores, PropStore, StreetStore } from "@portlandoregon/shared";
import { BootLog, CRASH_LIMIT, fmtBytes, probeDevice, webglAvailable } from "./bootlog.js";
import { buildCityModel } from "./city.js";
import { loadBuildings, loadCityLod, loadHeightfield, loadLayers, loadMap, loadOverviewAtlas, loadProps, loadStreets, MapUnavailableError } from "./mapdata.js";
import { Renderer } from "./render/index.js";
import { buildLandmarks } from "./render/landmarks.js";
import { buildProps } from "./render/props.js";
import { beginWorld, packError } from "./render/world.js";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const loadingEl = document.getElementById("loading") as HTMLDivElement;
const statusEl = document.getElementById("loading-status") as HTMLParagraphElement;
const bootlogEl = document.getElementById("bootlog") as HTMLDivElement;
const crashEl = document.getElementById("bootcrash") as HTMLDivElement;
const crashTitleEl = document.getElementById("bootcrash-title") as HTMLElement;
const crashDetailEl = document.getElementById("bootcrash-detail") as HTMLElement;
const crashLineEl = document.getElementById("bootcrash-line") as HTMLElement;
const copyBtn = document.getElementById("copylog") as HTMLButtonElement;

const log = new BootLog(bootlogEl);

/** Thrown when the browser cannot render at all — handled separately from a
 * failed download, because retrying will not help. */
class NoWebGLError extends Error {}

/** Paint a status line, then yield two frames so it actually shows before
 * the next main-thread-blocking build step.
 *
 * Raced against a timer because background tabs throttle requestAnimationFrame
 * to a stop: without the race, loading a backgrounded tab hangs on whatever
 * status line it reached and never even issues the map request. */
async function paint(text?: string): Promise<void> {
  if (text !== undefined) statusEl.textContent = text;
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

/** Log + show a step label, then hand the main thread back long enough to
 * repaint before the step blocks it again. */
async function announce(text: string): Promise<void> {
  log.line(`${text} ...`);
  await paint(text);
}

/**
 * Largest single tile job the worker may stage, derived from the map itself.
 *
 * Every building ring edge becomes 6 wall vertices and the roof earcuts to
 * roughly (ringVerts - 2) triangles. Each vertex is buffered first as 9
 * JS array numbers and then copied into transferable Float32Arrays. This work
 * now happens one tile at a time in the module worker; reporting the old
 * whole-city hypothetical as a boot estimate was misleading.
 */
function estimatePeakTileBytes(store: BuildingStore): { verts: number; bytes: number } {
  let verts = 0;
  for (let tile = 0; tile < store.tileKey.length; tile++) {
    const from = store.tileStart[tile]!;
    const to = store.tileStart[tile + 1]!;
    const ringFrom = store.ringStart[from]!;
    const ringTo = store.ringStart[to]!;
    const ringVerts = store.ringOffset[ringTo]! - store.ringOffset[ringFrom]!;
    const buildings = to - from;
    const tileVerts = ringVerts * 6 + Math.max(0, ringVerts - 2 * buildings) * 3;
    if (tileVerts > verts) verts = tileVerts;
  }
  return { verts, bytes: verts * 108 };
}

async function boot(): Promise<void> {
  const bootStart = performance.now();

  log.line("boot console online");
  probeDevice(log);

  // Nothing below this point can produce a frame without WebGL, and a device
  // without it took 29 seconds to reach the renderer and fail. Stop here
  // instead, with something the player can act on.
  if (!webglAvailable()) {
    log.line("stopping: WebGL is required and this browser has none", "fail");
    log.finish();
    throw new NoWebGLError();
  }

  let done = log.step("download map-lite.json.gz");
  let lastLogged = 0;
  const heightPromise: Promise<Heightfield | null> = loadHeightfield();
  const buildingPromise: Promise<BuildingStore> = loadBuildings();
  const propPromise: Promise<PropStore> = loadProps();
  const streetPromise: Promise<StreetStore> = loadStreets();
  const cityLodPromise: Promise<CityLod> = loadCityLod();
  const layerPromise: Promise<LayerStores> = loadLayers();
  // Optional and never awaited by tactical boot. The overview object receives
  // this promise after the first frame is already free to become interactive.
  const overviewPromise = loadOverviewAtlas().catch((err: unknown) => {
    log.line(`overview atlas unavailable — tactical fallback retained (${String(err)})`, "warn");
    return null;
  });
  const map = await loadMap((received, total) => {
    // One line per ~4 MB: enough to see the transfer move, not so much that
    // the log becomes a progress bar made of text.
    if (received - lastLogged < 4 * 1024 * 1024 && received !== total) return;
    lastLogged = received;
    const pct = total ? ` (${((received / total) * 100).toFixed(0)}%)` : "";
    log.line(`  ${fmtBytes(received)}${total ? ` / ${fmtBytes(total)}` : ""}${pct}`);
  });
  done("metadata");

  done = log.step("decode buildings.bin.gz");
  const buildings = await buildingPromise;
  done(`${buildings.count} footprints, ${(buildings.coords.length / 2 / 1e6).toFixed(2)}M vertices`);

  done = log.step("decode props.bin.gz");
  const props = await propPromise;
  done(`${props.count} props`);

  done = log.step("decode streets.bin.gz");
  const streets = await streetPromise;
  done(`${streets.edgeCount} street edges, ${streets.nodeCount} nodes`);

  done = log.step("decode layers.bin.gz");
  const layers = await layerPromise;
  done(`${layers.sidewalks.count} sidewalks, ${layers.markingLines.count} lane lines`);

  done = log.step("decode heightmap");
  const hf = await heightPromise;
  done(hf ? `${hf.cols}x${hf.rows} cells` : "absent — flat ground");

  done = log.step("decode far city texture");
  const cityLod = await cityLodPromise;
  done(`${cityLod.cols}x${cityLod.rows} urban mass`);

  // What we actually got, and what it is going to cost.
  log.line(
    `map: ${buildings.count} buildings · ${streets.edgeCount} edges · ` +
      `${props.count} props · ${layers.sidewalks.count} sidewalks · ` +
      `${layers.markingLines.count} lane lines`,
  );
  const est = estimatePeakTileBytes(buildings);
  log.line(
    `buildings: ${buildings.tileKey.length} culled box chunks plus baked far texture; ` +
      `full prisms stream near the camera (largest worker tile ` +
      `~${(est.verts / 1e6).toFixed(2)}M vertices / ${fmtBytes(est.bytes)} staged)`,
  );

  done = log.step("city model");
  const city = buildCityModel(buildings, hf);
  done(`${city.valid.reduce((a, v) => a + v, 0)} buildings with usable footprints`);
  await paint();

  done = log.step("preparing the world");
  // Nothing here builds geometry — groups, materials and the two tile managers
  // only. Terrain, streets, rails and trails come back as `steps`, which the
  // renderer drains a few milliseconds at a time from its own frame loop: the
  // page is interactive from the first frame and the city arrives around the
  // camera over the next few seconds, instead of after twenty of them.
  const { world, steps } = beginWorld(map, buildings, layers, hf, city, true, streets, cityLod);
  done(`${buildings.tileKey.length} building tiles ready to stream`);
  await paint();

  done = log.step("indexing trees and street lights");
  const propLayers = buildProps(map, props, hf);
  done(`${props.count} indexed — tiles stream with the camera`);
  await paint();

  done = log.step("labeling landmarks");
  const landmarks = buildLandmarks(map, buildings, hf);
  done(`${(map.landmarks ?? []).length} landmarks`);
  await paint();

  done = log.step("starting renderer");
  const worldStart = performance.now();
  const renderer = new Renderer(canvas, map, buildings, props, layers, streets, cityLod, {
    prebuilt: { world, props: propLayers, landmarks },
    boot: steps,
    onBootProgress: (phase) => {
      if (phase) {
        log.line(`  ${phase} ...`);
        return;
      }
      // Positions on the flat layers are Int16 with the scale in the mesh
      // transform. Worth printing: if a decal ever looks like it is sinking
      // into a hillside, this is the first number to rule out.
      log.line(
        `city filled in ${((performance.now() - worldStart) / 1000).toFixed(2)}s ` +
          `(packed positions within ${(packError.v * 1000).toFixed(1)}mm vertical, ` +
          `${(packError.h * 100).toFixed(1)}cm horizontal)`,
        "ok",
      );
    },
    heightfield: hf,
    city,
    overview: overviewPromise,
  });
  done();

  log.line(`interactive — total ${((performance.now() - bootStart) / 1000).toFixed(2)}s`, "ok");
  log.finish();
  // Dev/debug handle (headless smoke tests steer the camera through this).
  (window as unknown as Record<string, unknown>)["__pdx"] = { renderer, THREE };
  loadingEl.classList.add("done");
  if (new URLSearchParams(window.location.search).has("benchmark")) {
    log.line("browser benchmark scheduled");
    void import("./benchmark.js")
      .then(({ runBrowserBenchmark }) => runBrowserBenchmark(renderer, map))
      .then(() => log.line("browser benchmark complete — see window.__pdxBenchmark", "ok"))
      .catch((err) => {
        const message = String(err);
        window.__pdxBenchmarkError = message;
        log.line(`browser benchmark failed: ${message}`, "fail");
      });
  }
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
    if (err instanceof NoWebGLError) {
      statusEl.textContent = "this browser can't draw 3D";
      loadingEl.classList.add("offline");
      offlineDetailEl.innerHTML =
        "This city needs WebGL, and this browser has it switched off.<br><br>" +
        "On iPhone and iPad this is usually <strong>Lockdown Mode</strong>: " +
        "Settings &rsaquo; Privacy &amp; Security &rsaquo; Lockdown Mode. You can leave it on " +
        "everywhere else and add an exception for this site.";
      retryBtn.textContent = "Try again";
      return;
    }
    log.line(String(err), "fail");
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

copyBtn.addEventListener("click", () => {
  void navigator.clipboard?.writeText(log.text()).then(
    () => (copyBtn.textContent = "Copied"),
    () => (copyBtn.textContent = "Copy failed"),
  );
  setTimeout(() => (copyBtn.textContent = "Copy log"), 2000);
});

// An uncaught error during a blocking build never reaches boot()'s catch —
// it lands here, and on a phone this is the only place it will ever be seen.
addEventListener("error", (e) => log.line(`uncaught: ${e.message} @ ${e.filename}:${e.lineno}`, "fail"));
addEventListener("unhandledrejection", (e) => log.line(`unhandled rejection: ${String(e.reason)}`, "fail"));

/**
 * An out-of-memory kill on iOS is not an error — Safari discards the tab and
 * silently reloads it, so the page appears to restart its own loading screen
 * forever. The log survives in sessionStorage, so a boot that never reached
 * `finish()` is visible from here: report where it died, and after two of
 * them stop feeding the loop and let the user decide.
 */
if (log.diedAt) {
  crashEl.classList.add("show");
  crashTitleEl.textContent = `Previous boot died (attempt ${log.crashes}). `;
  crashDetailEl.textContent =
    "The tab was killed mid-load — on iOS that means it ran out of memory, and Safari reloaded it. Last step reached:";
  crashLineEl.textContent = log.diedAt;
}

if (log.crashes >= CRASH_LIMIT) {
  statusEl.textContent = "stopped after repeated crashes";
  crashDetailEl.textContent =
    `This device has failed to load the city ${log.crashes} times in a row, so the retry loop is ` +
    "stopped. This device still exceeded its browser memory limit while streaming the compact city. " +
    "Last step reached:";
  retryBtn.disabled = false;
  loadingEl.classList.add("offline");
  offlineDetailEl.textContent = "Press Try again to attempt the load anyway.";
  log.line(`auto-retry stopped after ${log.crashes} consecutive crashes`, "fail");
} else {
  attempt();
}
