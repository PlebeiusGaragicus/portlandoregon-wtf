import type { GameMap } from "@battle-juice/shared";
import type { DebugFireScenario, Renderer, RendererDebugStats } from "./render/index.js";

interface MemorySample {
  bytes: number | null;
  source: "measureUserAgentSpecificMemory" | "performance.memory" | "unavailable";
}

interface FrameSample {
  count: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  renderer: {
    renderedFrames: number;
    totalMs: number;
    bootMs: number;
    tileSyncMs: number;
    actorsMs: number;
    fireMs: number;
    drawMs: number;
    cache: RendererDebugStats["cache"];
    scheduler: {
      before: RendererDebugStats["scheduler"];
      after: RendererDebugStats["scheduler"];
    };
  };
}

interface SettledScenarioSample {
  memory: MemorySample;
  resources: RendererDebugStats;
  settle: { renderedFrames: number; stable: boolean; queuesIdle: boolean };
}

export interface BrowserBenchmarkResult {
  startedAt: string;
  userAgent: string;
  devicePixelRatio: number;
  viewport: { width: number; height: number };
  timeToFullFillMs: number;
  frames: {
    idle: FrameSample;
    nightWide: FrameSample;
    fpv: FrameSample;
    activeFire: FrameSample;
  };
  activeFire: DebugFireScenario;
  longTasks: { count: number; totalMs: number; maxMs: number };
  lifecycle: {
    pageHidePaused: boolean;
    pageShowResumedOnce: boolean;
    contextLossPrevented: boolean;
    contextLossPaused: boolean;
  };
  memory: { before: MemorySample; afterPan: MemorySample; afterRevisit: MemorySample; final: MemorySample };
  resources: {
    before: RendererDebugStats;
    afterPan: RendererDebugStats;
    afterRevisit: RendererDebugStats;
    final: RendererDebugStats;
  };
  settled: {
    coldBoot: SettledScenarioSample;
    idle: SettledScenarioSample;
    pan: SettledScenarioSample;
    revisit: SettledScenarioSample;
    nightWide: SettledScenarioSample;
    fpv: SettledScenarioSample;
    activeFire: SettledScenarioSample;
    lifecycle: SettledScenarioSample;
  };
}

declare global {
  interface Window {
    __bjBenchmark?: BrowserBenchmarkResult | { running: true };
    __bjBenchmarkError?: string;
    __bjBenchmarkStage?: string;
  }
}

const nextFrame = (): Promise<number> => new Promise((resolve) => requestAnimationFrame(resolve));

async function waitFrames(count: number): Promise<void> {
  for (let i = 0; i < count; i++) await nextFrame();
}

async function waitForFill(renderer: Renderer, timeoutMs = 120_000): Promise<number> {
  const started = performance.now();
  while (renderer.debugStats().booting) {
    if (performance.now() - started > timeoutMs) throw new Error("benchmark timed out waiting for world fill");
    await waitFrames(2);
  }
  return performance.now() - started;
}

export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]!;
}

function subtractCacheCounters(
  after: RendererDebugStats["cache"],
  before: RendererDebugStats["cache"],
): RendererDebugStats["cache"] {
  return {
    syncs: after.syncs - before.syncs,
    windowChanges: after.windowChanges - before.windowChanges,
    buildingTilesBuilt: after.buildingTilesBuilt - before.buildingTilesBuilt,
    buildingTilesEvicted: after.buildingTilesEvicted - before.buildingTilesEvicted,
    propChanges: after.propChanges - before.propChanges,
    impostorBakes: after.impostorBakes - before.impostorBakes,
  };
}

async function sampleFrames(renderer: Renderer, count: number): Promise<FrameSample> {
  const times: number[] = [];
  let last = await nextFrame();
  const before = renderer.debugStats();
  let renderFrame = before.render.frame;
  while (times.length < count) {
    const now = await nextFrame();
    const nextRenderFrame = renderer.debugStats().render.frame;
    if (nextRenderFrame === renderFrame) continue;
    times.push(now - last);
    last = now;
    renderFrame = nextRenderFrame;
  }
  const after = renderer.debugStats();
  times.sort((a, b) => a - b);
  const timing = after.timing;
  const priorTiming = before.timing;
  return {
    count,
    p50Ms: percentile(times, 0.5),
    p95Ms: percentile(times, 0.95),
    p99Ms: percentile(times, 0.99),
    maxMs: times[times.length - 1] ?? 0,
    renderer: {
      renderedFrames: timing.frames - priorTiming.frames,
      totalMs: timing.totalMs - priorTiming.totalMs,
      bootMs: timing.bootMs - priorTiming.bootMs,
      tileSyncMs: timing.tileSyncMs - priorTiming.tileSyncMs,
      actorsMs: timing.actorsMs - priorTiming.actorsMs,
      fireMs: timing.fireMs - priorTiming.fireMs,
      drawMs: timing.drawMs - priorTiming.drawMs,
      cache: subtractCacheCounters(after.cache, before.cache),
      scheduler: { before: before.scheduler, after: after.scheduler },
    },
  };
}

async function sampleMemory(): Promise<MemorySample> {
  const perf = performance as Performance & {
    memory?: { usedJSHeapSize: number };
    measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
  };
  if (perf.measureUserAgentSpecificMemory) {
    try {
      const result = await perf.measureUserAgentSpecificMemory();
      return { bytes: result.bytes, source: "measureUserAgentSpecificMemory" };
    } catch {
      // Cross-origin isolation and browser support vary; fall through.
    }
  }
  if (perf.memory) return { bytes: perf.memory.usedJSHeapSize, source: "performance.memory" };
  return { bytes: null, source: "unavailable" };
}

function resourceSignature(stats: RendererDebugStats): string {
  return [
    stats.memory.geometries,
    stats.memory.textures,
    stats.buildings.tiles,
    stats.buildings.verts,
    stats.dressing.tiles,
    stats.dressing.verts,
    stats.props.tiles,
    stats.props.instances,
    stats.props.matrixBytes,
    stats.scheduler.wanted,
    stats.scheduler.pending,
    stats.scheduler.inFlight,
    stats.scheduler.completed,
    stats.scheduler.pendingBytes,
    stats.scheduler.completedBytes,
  ].join(":");
}

function queuesIdle(stats: RendererDebugStats): boolean {
  return (
    stats.scheduler.pending === 0 &&
    stats.scheduler.inFlight === 0 &&
    stats.scheduler.completed === 0 &&
    stats.buildings.pending === 0 &&
    stats.buildings.inFlight === 0 &&
    stats.buildings.completed === 0
  );
}

/**
 * Let streaming work finish before taking a memory snapshot. This waits for
 * twelve unchanged rendered frames (and at least thirty frames total), with a
 * finite ceiling so a broken cache cannot wedge the benchmark forever.
 */
async function sampleSettledScenario(renderer: Renderer): Promise<SettledScenarioSample> {
  let previous = "";
  let stableFrames = 0;
  let renderedFrames = 0;
  let renderFrame = renderer.debugStats().timing.frames;
  let resources = renderer.debugStats();
  let idle = queuesIdle(resources);
  while (renderedFrames < 240 && (renderedFrames < 30 || stableFrames < 12 || !idle)) {
    await nextFrame();
    const stats = renderer.debugStats();
    if (stats.timing.frames === renderFrame) continue;
    renderFrame = stats.timing.frames;
    renderedFrames++;
    const signature = resourceSignature(stats);
    stableFrames = signature === previous ? stableFrames + 1 : 0;
    previous = signature;
    resources = stats;
    idle = queuesIdle(stats);
  }
  return {
    memory: await sampleMemory(),
    resources,
    settle: { renderedFrames, stable: stableFrames >= 12 && idle, queuesIdle: idle },
  };
}

/**
 * Reproducible in-browser performance scenario.
 *
 * Run the normal client with `?benchmark=1`. The final JSON is printed and
 * retained at `window.__bjBenchmark` for copying from desktop or phone
 * remote-devtools. It intentionally uses public renderer debug controls
 * rather than reaching into private state.
 */
export async function runBrowserBenchmark(renderer: Renderer, map: GameMap): Promise<BrowserBenchmarkResult> {
  if (window.__bjBenchmark) throw new Error("benchmark already started");
  window.__bjBenchmark = { running: true };
  window.__bjBenchmarkStage = "boot";
  renderer.debugPrepareBenchmark();

  const longTasks: number[] = [];
  const observer =
    typeof PerformanceObserver !== "undefined" &&
    PerformanceObserver.supportedEntryTypes.includes("longtask")
      ? new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) longTasks.push(entry.duration);
        })
      : null;
  observer?.observe({ entryTypes: ["longtask"] });

  const startedAt = new Date().toISOString();
  const timeToFullFillMs = await waitForFill(renderer);
  window.__bjBenchmarkStage = "cold-boot-settle";
  renderer.debugSetNight(false);
  renderer.debugSetView(map.meta.width / 2, map.meta.height / 2, 900);
  const coldBoot = await sampleSettledScenario(renderer);

  const before = coldBoot.resources;
  const memoryBefore = coldBoot.memory;
  const idle = await sampleFrames(renderer, 120);
  window.__bjBenchmarkStage = "idle-settle";
  const idleSettled = await sampleSettledScenario(renderer);

  // Cross and revisit 100 tile boundaries. Revisit is what exposes cache
  // lifecycle leaks that one-way panning misses.
  const cx = map.meta.width / 2;
  const cy = map.meta.height / 2;
  const panRevisit = async (): Promise<void> => {
    for (let i = 0; i < 100; i++) {
      const step = i < 50 ? i : 99 - i;
      renderer.debugSetView(cx + (step - 25) * 750, cy + ((step % 7) - 3) * 500, 900);
      await waitFrames(3);
    }
  };
  await panRevisit();
  window.__bjBenchmarkStage = "pan-settle";
  const panSettled = await sampleSettledScenario(renderer);
  const afterPan = panSettled.resources;
  const memoryAfterPan = panSettled.memory;
  await panRevisit();
  window.__bjBenchmarkStage = "revisit-settle";
  const revisitSettled = await sampleSettledScenario(renderer);
  const afterRevisit = revisitSettled.resources;
  const memoryAfterRevisit = revisitSettled.memory;

  renderer.debugSetNight(true);
  window.__bjBenchmarkStage = "night-wide";
  renderer.debugSetView(cx, cy, 8000);
  await waitFrames(20);
  const nightWide = await sampleFrames(renderer, 120);
  const nightWideSettled = await sampleSettledScenario(renderer);

  renderer.debugSetView(cx, cy, 450);
  window.__bjBenchmarkStage = "fpv";
  renderer.debugSetFpv(true);
  await waitFrames(20);
  const fpv = await sampleFrames(renderer, 120);
  const fpvSettled = await sampleSettledScenario(renderer);
  renderer.debugSetFpv(false);

  renderer.debugSetNight(false);
  renderer.debugSetView(cx, cy, 900);
  await sampleSettledScenario(renderer);
  const activeFireSetup = renderer.debugStartActiveFireScenario();
  window.__bjBenchmarkStage = "active-fire";
  await waitFrames(20);
  const activeFire = await sampleFrames(renderer, 120);
  const activeFireSettled = await sampleSettledScenario(renderer);

  const frameBeforeHide = renderer.debugStats().render.frame;
  window.__bjBenchmarkStage = "lifecycle";
  window.dispatchEvent(new PageTransitionEvent("pagehide"));
  await new Promise((resolve) => setTimeout(resolve, 25));
  const pageHidePaused = renderer.debugStats().paused;
  window.dispatchEvent(new PageTransitionEvent("pageshow"));
  await waitFrames(3);
  const resumed = renderer.debugStats();
  const pageShowResumedOnce = !resumed.paused && resumed.render.frame > frameBeforeHide;

  const canvas = document.querySelector("canvas");
  const contextLoss = new Event("webglcontextlost", { cancelable: true });
  canvas?.dispatchEvent(contextLoss);
  const contextLossPrevented = contextLoss.defaultPrevented;
  const contextLossPaused = renderer.debugStats().paused;
  // Do not synthesize restoration: production intentionally reloads compact
  // stores because sealed attributes cannot be re-uploaded. Resume so the
  // benchmark can finish sampling the post-condition.
  renderer.debugPauseResume();
  await waitFrames(120);

  renderer.debugSetNight(false);
  const lifecycleSettled = await sampleSettledScenario(renderer);
  const final = lifecycleSettled.resources;
  const memoryFinal = lifecycleSettled.memory;
  observer?.disconnect();

  const result: BrowserBenchmarkResult = {
    startedAt,
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    timeToFullFillMs,
    frames: { idle, nightWide, fpv, activeFire },
    activeFire: activeFireSetup,
    longTasks: {
      count: longTasks.length,
      totalMs: longTasks.reduce((a, b) => a + b, 0),
      maxMs: longTasks.length ? Math.max(...longTasks) : 0,
    },
    lifecycle: { pageHidePaused, pageShowResumedOnce, contextLossPrevented, contextLossPaused },
    memory: {
      before: memoryBefore,
      afterPan: memoryAfterPan,
      afterRevisit: memoryAfterRevisit,
      final: memoryFinal,
    },
    resources: { before, afterPan, afterRevisit, final },
    settled: {
      coldBoot,
      idle: idleSettled,
      pan: panSettled,
      revisit: revisitSettled,
      nightWide: nightWideSettled,
      fpv: fpvSettled,
      activeFire: activeFireSettled,
      lifecycle: lifecycleSettled,
    },
  };
  window.__bjBenchmark = result;
  window.__bjBenchmarkStage = "complete";
  const json = JSON.stringify(result, null, 2);
  console.info("Battle Juice browser benchmark\n" + json);
  // Physical phones often have no attached devtools. Leave a selectable
  // on-screen report so the result can be copied directly from the device.
  const report = document.createElement("pre");
  report.id = "benchmark-result";
  report.textContent = json;
  report.style.cssText =
    "position:fixed;inset:1rem;z-index:100;background:#0d1014;color:#d7dfeb;" +
    "padding:1rem;overflow:auto;white-space:pre-wrap;font:12px/1.45 ui-monospace,monospace;" +
    "border:1px solid #596579;border-radius:8px;user-select:text;-webkit-user-select:text";
  document.body.appendChild(report);
  return result;
}
