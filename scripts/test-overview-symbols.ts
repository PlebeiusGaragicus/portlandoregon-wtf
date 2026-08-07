import { FireSim } from "../client/src/render/fire.js";
import {
  overviewPlaneTransform,
  resolveZoomTierVisibility,
} from "../client/src/render/overview.js";

let failures = 0;
function check(name: string, ok: boolean): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failures++;
}

const transform = overviewPlaneTransform({ minX: 10, minY: 20, width: 400, height: 300 }, 1);
check("overview plane maps height onto local Z", transform.scale[0] === 400 && transform.scale[1] === 1 && transform.scale[2] === 300);
check("overview plane centers in scene coordinates", transform.position[0] === 210 && transform.position[2] === -170);

const transition = resolveZoomTierVisibility({
  transition: 0.5,
  atlasReady: true,
  groundOpacity: 1,
  urbanOpacity: 0.5,
});
check("transition owns one shared set of layer gates", transition.owner === "transition" && transition.atlas && transition.tacticalWorld && transition.symbols);
const strategic = resolveZoomTierVisibility({
  transition: 1,
  atlasReady: true,
  groundOpacity: 1,
  urbanOpacity: 1,
});
check("complete overview retires tactical layers", strategic.owner === "overview" && !strategic.tacticalWorld && !strategic.tacticalEffects);
const fallback = resolveZoomTierVisibility({
  transition: 1,
  atlasReady: false,
  groundOpacity: 0,
  urbanOpacity: 0,
});
check("atlas failure keeps a complete city fallback", fallback.tacticalWorld && !fallback.atlas);

// FireSim's overview read model is intentionally testable without constructing
// its WebGL particle pools: it reads only authoritative city/sim arrays.
const sim = Object.create(FireSim.prototype) as FireSim;
Object.assign(sim as unknown as Record<string, unknown>, {
  map: { meta: { width: 5000, height: 4000 } },
  burns: new Map([
    [1, { x: 100, y: 100, intensity: 0.4 }],
    [2, { x: 300, y: 200, intensity: 0.8 }],
    [3, { x: 1800, y: 100, intensity: 0.5 }],
  ]),
  collapsed: [0, 1, 2],
  cx: Float32Array.from([100, 300, 2200]),
  cy: Float32Array.from([100, 200, 100]),
  overviewCollapsedVersion: -1,
  overviewCollapsed: [],
});

const first = sim.overviewSnapshot();
check("nearby fires aggregate into strategic cells", first.active.length === 2);
check("aggregate intensity preserves the hottest fire", first.active.some((marker) => marker.intensity >= 0.8));
check("collapsed buildings aggregate by area", first.collapsed.length === 2 && first.collapsed.some((marker) => marker.count === 2));
const second = sim.overviewSnapshot();
check("unchanged collapsed aggregates are cached", second.collapsed === first.collapsed);

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exitCode = failures ? 1 : 0;
