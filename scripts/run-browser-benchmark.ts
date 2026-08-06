// Drive the in-client `?benchmark=1` harness through Chrome DevTools without
// Playwright/Puppeteer. Start the client first, then:
//
//   npm run dev -w client -- --port 5555
//   node --import tsx scripts/run-browser-benchmark.ts
//
// Override BJ_BENCHMARK_URL or CHROME_BIN when needed.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = process.env["BJ_BENCHMARK_URL"] ?? "http://127.0.0.1:5555/?benchmark=1";
const port = Number(process.env["BJ_BENCHMARK_PORT"] ?? 9223);
const emulateMobile = process.env["BJ_BENCHMARK_MOBILE"] === "1";
const chrome =
  process.env["CHROME_BIN"] ??
  (process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "google-chrome");
const profile = mkdtempSync(join(tmpdir(), "battle-juice-benchmark-"));

let browser: ChildProcess | null = null;
let socket: WebSocket | null = null;

async function retry<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  const until = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < until) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

async function openTarget(): Promise<{ webSocketDebuggerUrl: string }> {
  return retry(async () => {
    const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" });
    if (!res.ok) throw new Error(`Chrome target endpoint returned ${res.status}`);
    return (await res.json()) as { webSocketDebuggerUrl: string };
  }, 15_000);
}

async function main(): Promise<void> {
  browser = spawn(
    chrome,
    [
      "--headless=new",
      "--disable-gpu-sandbox",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );

  const target = await openTarget();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    socket!.addEventListener("open", () => resolve(), { once: true });
    socket!.addEventListener("error", () => reject(new Error("DevTools websocket failed")), { once: true });
  });

  let nextId = 1;
  const pending = new Map<number, (value: unknown) => void>();
  socket.addEventListener("message", (event) => {
    const msg = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: unknown };
    if (msg.id === undefined) return;
    pending.get(msg.id)?.(msg.error ? { error: msg.error } : msg.result);
    pending.delete(msg.id);
  });
  const call = (method: string, params: object): Promise<unknown> =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      socket!.send(JSON.stringify({ id, method, params }));
    });

  await call("Runtime.enable", {});
  await call("Page.enable", {});
  if (emulateMobile) {
    await call("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
    });
    await call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await call("Emulation.setUserAgentOverride", {
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 " +
        "(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      platform: "iPhone",
    });
  }
  await call("Page.navigate", { url });
  const response = (await call("Runtime.evaluate", {
    expression: `new Promise((resolve, reject) => {
      const until = Date.now() + 300000;
      const poll = () => {
        const value = window.__bjBenchmark;
        if (value && value.running !== true) return resolve(value);
        if (Date.now() > until) return reject(new Error("benchmark timed out"));
        setTimeout(poll, 250);
      };
      poll();
    })`,
    awaitPromise: true,
    returnByValue: true,
  })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
  if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
  console.log(JSON.stringify(response.result?.value, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    socket?.close();
    const exited =
      browser && browser.exitCode === null
        ? new Promise<void>((resolve) => browser!.once("exit", () => resolve()))
        : Promise.resolve();
    browser?.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1500))]);
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (err) {
      // Chrome extensions can finish a final write after the browser process
      // receives SIGTERM. A temp cleanup race must not turn valid benchmark
      // output into a failed run.
      console.warn(`benchmark temp cleanup deferred: ${String(err)}`);
    }
  });
