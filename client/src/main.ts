// Spectator-first boot: the map loads and renders immediately — no login, and
// no server. The city ships with the site as a static asset, so the game runs
// standalone on GitHub Pages. (Units and the multiplayer join flow return in a
// later phase; net.ts and the server's join path are kept for that.)
import * as THREE from "three";
import type { BuildingStore, CityLod, Heightfield, LayerStores, PropStore, StreetStore } from "@portlandoregon/shared";
import { BootLog, fmtBytes, probeDevice, webglAvailable } from "./bootlog.js";
import { buildCityModel } from "./city.js";
import { CityCache } from "./mapcache.js";
import { loadBuildings, loadCityLod, loadHeightfield, loadLayers, loadMap, loadOverviewAtlas, loadProps, loadStreets, MAP_BASE_URL, setCityCache, MapUnavailableError } from "./mapdata.js";
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

/** WebGL is missing *and* so is WebAssembly. Lockdown Mode turns both off
 * together (along with the JIT, Web Audio, and the Gamepad API); nothing else
 * plausibly removes exactly that pair. Worth separating from a plain missing
 * WebGL, because it has a fix the user can actually apply. */
class LockdownError extends NoWebGLError {}

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
    const lockdown = typeof WebAssembly === "undefined";
    log.line(
      lockdown
        ? "stopping: no WebGL and no WebAssembly — Lockdown Mode is on"
        : "stopping: WebGL is required and this browser has none",
      "fail",
    );
    log.finish();
    throw lockdown ? new LockdownError() : new NoWebGLError();
  }

  // Reconcile the stored city against what is published before anything is
  // requested, so each load below is a hit or a miss rather than a race. It
  // costs one small no-store fetch; on a warm boot it saves tens of MB.
  let done = log.step("checking the stored city");
  const cache = await CityCache.open(MAP_BASE_URL);
  setCityCache(cache);
  const { report } = cache;
  if (report.enabled) {
    done(
      `${report.fresh}/${report.total} artifacts already stored ` +
        `(${fmtBytes(report.freshBytes)})${report.persisted ? ", storage persisted" : ""}` +
        `${report.stale ? " — offline, serving the stored city" : ""}`,
    );
    for (const name of report.evicted) log.line(`  ${name} changed — will re-download`);
  } else {
    done(`not caching: ${report.detail}`);
  }

  done = log.step("download map-lite.json.gz");
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
  maybeOfferInstall();
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

/**
 * Stop, and say why.
 *
 * A failed boot used to schedule its own retry on a 5s/10s/20s/40s backoff.
 * That made every failure look like a page that loads forever: the same
 * screen, the same spinner, over and over, with no way to tell "still working"
 * from "never going to work". Retrying is the user's call now — that is what
 * the button is for.
 */
function fail(status: string, detail: string, html = false): void {
  loadingEl.classList.add("offline");
  statusEl.textContent = status;
  if (html) offlineDetailEl.innerHTML = detail;
  else offlineDetailEl.textContent = detail;
  retryBtn.disabled = false;
}

function attempt(): void {
  loadingEl.classList.remove("offline");
  retryBtn.disabled = true;
  statusEl.textContent = "loading the city…";

  boot().catch((err) => {
    if (err instanceof LockdownError) {
      // Lockdown Mode switches off WebGL and WebAssembly together, so there is
      // no partial version of this page to offer — naming the setting is the
      // only useful thing we can do.
      fail(
        "Lockdown Mode is blocking this page",
        "iOS <strong>Lockdown Mode</strong> switches off WebGL, and without it there is " +
          "no way to draw the city.<br><br>You can leave Lockdown Mode on everywhere else " +
          "and allow it just here: in Safari, tap the page settings button at the left of " +
          "the address bar, choose <strong>Website Settings</strong>, and turn Lockdown Mode " +
          "off for this site.",
        true,
      );
      return;
    }
    if (err instanceof NoWebGLError) {
      fail(
        "this browser can't draw 3D",
        "This city needs WebGL, and this browser has it switched off or unavailable.",
      );
      return;
    }
    log.line(String(err), "fail");
    if (err instanceof MapUnavailableError) {
      fail("couldn't load the city", "The map couldn't be downloaded. Check your connection and try again.");
      return;
    }
    // A real bug — surface it rather than blaming the network.
    fail("something went wrong", String(err));
  });
}

retryBtn.addEventListener("click", attempt);

copyBtn.addEventListener("click", () => {
  void navigator.clipboard?.writeText(log.text()).then(
    () => (copyBtn.textContent = "Copied"),
    () => (copyBtn.textContent = "Copy failed"),
  );
  setTimeout(() => (copyBtn.textContent = "Copy log"), 2000);
});

/**
 * Offer "Add to Home Screen", once, to people who keep coming back.
 *
 * Only on iOS, and only because iOS is where it matters: WebKit deletes
 * script-writable storage after seven days of no interaction, and a Home
 * Screen web app is outside Safari and exempt. Everywhere else the cache
 * already survives on its own, so there is nothing to nag about.
 *
 * There is no install prompt API on iOS — no beforeinstallprompt, no button
 * we can wire up — so telling the user where the control lives is the whole
 * of what we can do.
 */
function maybeOfferInstall(): void {
  const el = document.getElementById("install");
  const dismiss = document.getElementById("install-dismiss");
  if (!el || !dismiss) return;

  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac; the touch points give it away.
  const iOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const installed =
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    matchMedia("(display-mode: standalone)").matches;
  if (!iOS || installed) return;

  let visits = 0;
  try {
    if (localStorage.getItem("pdx:installhint") === "dismissed") return;
    visits = Number(localStorage.getItem("pdx:visits") ?? "0") + 1;
    localStorage.setItem("pdx:visits", String(visits));
  } catch {
    return; // no storage means no way to show this once rather than always
  }
  // First-time visitors have not yet decided they care. Second visit is the
  // earliest point at which "keep this" is a useful offer rather than noise.
  if (visits < 2) return;

  const hide = (): void => {
    el.classList.remove("show");
    try {
      localStorage.setItem("pdx:installhint", "dismissed");
    } catch {
      /* nothing to do */
    }
  };
  dismiss.addEventListener("click", hide);
  // Let the city arrive first; a hint over a loading screen is an interruption.
  setTimeout(() => el.classList.add("show"), 4000);
  setTimeout(hide, 20000);
}

// Installability, and an app shell that starts with no network. Production
// only: in dev a service worker sits between Vite and the page and serves
// yesterday's bundle back at you.
//
// Registered after boot rather than before it, so the install fetches never
// compete with the map for connections on a cold load.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  addEventListener("load", () => {
    void navigator.serviceWorker.register("./sw.js").catch((err) => {
      log.line(`service worker not registered: ${String(err)}`, "warn");
    });
  });
}

// An uncaught error during a blocking build never reaches boot()'s catch —
// it lands here, and on a phone this is the only place it will ever be seen.
addEventListener("error", (e) => log.line(`uncaught: ${e.message} @ ${e.filename}:${e.lineno}`, "fail"));
addEventListener("unhandledrejection", (e) => log.line(`unhandled rejection: ${String(e.reason)}`, "fail"));

/**
 * An out-of-memory kill on iOS is not an error we ever see — Safari discards
 * the tab and silently reloads it. The log survives in sessionStorage, so a
 * boot that never reached `finish()` is visible from the next one: report
 * where it died, and offer the log.
 *
 * There used to be a consecutive-crash counter here that stopped the retry
 * loop after two. There is no retry loop any more, so there is nothing for it
 * to stop — a boot that dies now simply stays dead until someone reloads.
 */
if (log.diedAt) {
  loadingEl.classList.add("crashed");
  crashEl.classList.add("show");
  crashTitleEl.textContent = "The previous attempt didn't finish. ";
  crashDetailEl.textContent =
    "The tab was killed mid-load — on iOS that usually means it ran out of memory, and Safari reloaded it. Last step reached:";
  crashLineEl.textContent = log.diedAt;
}

attempt();
