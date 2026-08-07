// Boot console: a dmesg-style log of every step of the cold load.
//
// The city is heavy enough to kill a phone mid-build, and iOS Safari's
// response to an out-of-memory kill is to silently reload the tab — which
// from the outside looks like a hang that restarts itself. So the log
// survives the reload (sessionStorage): the last line the *previous* boot
// reached is the failure point, printed at the top of the next one.
//
// There is no devtools on a phone, so the log is also the bug report — hence
// the copy button.

export type Level = "info" | "ok" | "warn" | "fail";

const STORE_KEY = "pdx:bootlog";

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

/** Zero-padded seconds since page start, dmesg style: `[   12.345]`. */
function stamp(ms: number): string {
  return `[${(ms / 1000).toFixed(3).padStart(9)}]`;
}

interface Stored {
  lines: string[];
  finished: boolean;
}

function readStored(): Stored | null {
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as Stored) : null;
  } catch {
    return null; // private mode, or a corrupt record — not worth a failure
  }
}

export class BootLog {
  private lines: string[] = [];
  private readonly t0 = performance.now();
  /** Last line of the previous boot, when that boot never finished. */
  readonly diedAt: string | null;

  constructor(private el: HTMLElement) {
    const prev = readStored();
    const crashed = prev !== null && !prev.finished && prev.lines.length > 0;
    this.diedAt = crashed ? (prev.lines[prev.lines.length - 1] ?? null) : null;

    this.el.textContent = "";
    this.persist();
  }

  /** Set once finish() has run. Lines still get logged after it — the world
   * keeps filling in behind the renderer — but they must not re-mark the boot
   * as unfinished, or a boot that reached the game would be reported as a
   * crash by the next one. */
  private finished = false;

  private persist(): void {
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify({ lines: this.lines, finished: this.finished }));
    } catch {
      /* over quota or unavailable — the on-screen log still works */
    }
  }

  /** Mark this boot as having reached the end, so the next one doesn't
   * report it as a crash. */
  finish(): void {
    this.finished = true;
    this.persist();
  }

  line(text: string, level: Level = "info"): void {
    const s = `${stamp(performance.now() - this.t0)} ${text}`;
    this.lines.push(s);

    const div = document.createElement("div");
    div.className = `l-${level}`;
    div.textContent = s;
    this.el.appendChild(div);
    // Newest line stays visible; the log outgrows the box within a second.
    this.el.scrollTop = this.el.scrollHeight;

    this.persist();
    // Mirror to the real console too, for anyone who does have devtools.
    if (level === "fail") console.error(s);
    else if (level === "warn") console.warn(s);
    else console.log(s);
  }

  /** Log a step's start; the returned function logs its completion + elapsed.
   * Steps read as a matched pair so a truncated log shows which one ate it. */
  step(label: string): (detail?: string) => void {
    this.line(`${label} ...`);
    const started = performance.now();
    return (detail?: string): void => {
      const secs = ((performance.now() - started) / 1000).toFixed(2);
      this.line(`${label} — ok in ${secs}s${detail ? ` (${detail})` : ""}`, "ok");
    };
  }

  /** The whole log as text, for the copy button. */
  text(): string {
    return this.lines.join("\n");
  }
}

/**
 * Everything about the device that could plausibly explain a failed boot,
 * printed before we touch the network. On a phone this is the only way to
 * learn what we are actually running on.
 */
/**
 * Can anything render at all?
 *
 * iOS Lockdown Mode switches WebGL off entirely, and a browser with no WebGL
 * cannot show this game in any form — no amount of streaming or memory work
 * changes that. Worth knowing BEFORE downloading a map and spending half a
 * minute building a city that will never reach a screen.
 */
export function webglAvailable(): boolean {
  try {
    const cv = document.createElement("canvas");
    return (cv.getContext("webgl2") ?? cv.getContext("webgl")) !== null;
  } catch {
    return false;
  }
}

export function probeDevice(log: BootLog): void {
  const nav = navigator as Navigator & { deviceMemory?: number };
  log.line(`ua: ${navigator.userAgent}`);
  log.line(
    `cpu: ${navigator.hardwareConcurrency ?? "?"} threads · ` +
      `ram hint: ${nav.deviceMemory ? `${nav.deviceMemory} GB` : "not reported"}`,
  );
  log.line(
    `screen: ${screen.width}x${screen.height} @${devicePixelRatio}x · ` +
      `viewport ${innerWidth}x${innerHeight}`,
  );

  // WebAssembly is disabled by iOS Lockdown Mode and by very little else, so
  // its absence on Safari is a strong signal. The game does not use wasm —
  // but Lockdown also drops the optimizing JIT, which is what makes a heavy
  // build crawl. Worth naming explicitly.
  const wasm = typeof WebAssembly !== "undefined";
  log.line(`WebAssembly: ${wasm ? "available" : "MISSING"}`, wasm ? "info" : "warn");
  if (!wasm) {
    log.line("→ iOS Lockdown Mode is likely ON: JIT disabled, so JS runs several times slower", "warn");
  }

  const ds = typeof DecompressionStream !== "undefined";
  log.line(`DecompressionStream: ${ds ? "available" : "MISSING"}`, ds ? "info" : "fail");

  try {
    const cv = document.createElement("canvas");
    const gl = (cv.getContext("webgl2") ?? cv.getContext("webgl")) as WebGLRenderingContext | null;
    if (!gl) {
      log.line("WebGL: UNAVAILABLE — nothing can render", "fail");
    } else {
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : "masked";
      log.line(`WebGL: ${gl instanceof WebGL2RenderingContext ? "2.0" : "1.0"} · ${renderer}`);
      log.line(
        `  max texture ${gl.getParameter(gl.MAX_TEXTURE_SIZE)}px · ` +
          `max verts/attr ${gl.getParameter(gl.MAX_VERTEX_ATTRIBS)}`,
      );
    }
  } catch (err) {
    log.line(`WebGL probe failed: ${String(err)}`, "warn");
  }

  void navigator.storage?.estimate?.().then((est) => {
    if (est.quota) log.line(`storage quota: ${fmtBytes(est.quota)}`);
  });
}

export { fmtBytes };
