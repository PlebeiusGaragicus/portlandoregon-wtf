import type { GameMap } from "@battle-juice/shared";
import type { Renderer, RendererDebugStats } from "./render/index.js";

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
  };
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
}

declare global {
  interface Window {
    __bjBenchmark?: BrowserBenchmarkResult | { running: true };
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

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]!;
}

async function sampleFrames(renderer: Renderer, count: number): Promise<FrameSample> {
  const times: number[] = [];
  let last = await nextFrame();
  let renderFrame = renderer.debugStats().render.frame;
  while (times.length < count) {
    const now = await nextFrame();
    const nextRenderFrame = renderer.debugStats().render.frame;
    if (nextRenderFrame === renderFrame) continue;
    times.push(now - last);
    last = now;
    renderFrame = nextRenderFrame;
  }
  times.sort((a, b) => a - b);
  return {
    count,
    p50Ms: percentile(times, 0.5),
    p95Ms: percentile(times, 0.95),
    p99Ms: percentile(times, 0.99),
    maxMs: times[times.length - 1] ?? 0,
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
  renderer.debugSetNight(false);
  renderer.debugSetView(map.meta.width / 2, map.meta.height / 2, 900);
  await waitFrames(12);

  const before = renderer.debugStats();
  const memoryBefore = await sampleMemory();
  const idle = await sampleFrames(renderer, 120);

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
  await waitFrames(12);
  const afterPan = renderer.debugStats();
  const memoryAfterPan = await sampleMemory();
  await panRevisit();
  await waitFrames(12);
  const afterRevisit = renderer.debugStats();
  const memoryAfterRevisit = await sampleMemory();

  renderer.debugSetNight(true);
  renderer.debugSetView(cx, cy, 8000);
  await waitFrames(20);
  const nightWide = await sampleFrames(renderer, 120);

  renderer.debugSetView(cx, cy, 450);
  renderer.debugSetFpv(true);
  await waitFrames(20);
  const fpv = await sampleFrames(renderer, 120);
  renderer.debugSetFpv(false);
  const frameBeforeHide = renderer.debugStats().render.frame;
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
  const final = renderer.debugStats();
  const memoryFinal = await sampleMemory();
  observer?.disconnect();

  const result: BrowserBenchmarkResult = {
    startedAt,
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    timeToFullFillMs,
    frames: { idle, nightWide, fpv },
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
  };
  window.__bjBenchmark = result;
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
