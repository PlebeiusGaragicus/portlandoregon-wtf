// Geometry invariants for bridge structures.
//
// The structure hangs off deckStations, so that is what is worth testing: if
// the deck line disagrees with the road ribbon the whole span z-fights, and
// if it sags the piers point at the riverbed instead of holding the deck up.
//
//   npm run test:bridges
import { existsSync, readFileSync } from "node:fs";
import {
  deckLift,
  deckStations,
  DECK_SURFACE_Y,
  PARAPET_HEIGHT,
  RENDER_WIDTH,
} from "../client/src/render/deck.js";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** A river: high banks, a deep channel between them. */
const gorge = (x: number): number => (x > 100 && x < 400 ? -8 : 12);

console.log("\ndeck line");
{
  const line: [number, number][] = [[0, 0], [500, 0]];
  const s = deckStations(line, 17, (x) => gorge(x), 30)!;
  check("stations are produced", s !== null && s.h.length >= 2, `${s.h.length} stations`);

  const n = s.h.length;
  let wrongWidth = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.hypot(s.lx[i]! - s.rx[i]!, s.ly[i]! - s.ry[i]!);
    if (Math.abs(w - 17) > 1e-6) wrongWidth++;
  }
  check("the deck keeps its full width at every station", wrongWidth === 0, `${wrongWidth} bad`);

  // The whole point of the span rule: the deck must not follow the channel
  // down. Both banks are at 12, so nothing may dip below it.
  let sagged = 0;
  for (let i = 0; i < n; i++) if (s.h[i]! < 12 - 1e-9) sagged++;
  check("the deck never sags into the channel", sagged === 0, `${sagged} stations below the banks`);

  check("the deck clears the water", Math.min(...s.h) - -8 > 15, `${(Math.min(...s.h) + 8).toFixed(1)} m of air`);
}

console.log("\nfollowing the ground where it should");
{
  // A climbing approach with no channel: the deck is the terrain, so a
  // structure here is all slab and no pier.
  const ramp: [number, number][] = [[0, 0], [300, 0]];
  const s = deckStations(ramp, 11, (x) => x / 10, 30)!;
  const n = s.h.length;
  let off = 0;
  for (let i = 0; i < n; i++) if (Math.abs(s.h[i]! - s.cx[i]! / 10) > 0.51) off++;
  check("a deck over rising ground tracks the ground", off === 0, `${off} stations adrift`);
}

console.log("\ndegenerate input");
{
  check("a single point makes no deck", deckStations([[0, 0]], 11, () => 0, 30) === null);
  check("an empty line makes no deck", deckStations([], 11, () => 0, 30) === null);
}

// Collision must agree with what is drawn. The renderer and the FPV solid
// index both consume deckStations, so this pins the contract between them:
// the walkable surface is the deck line plus the decal offset, the barrier
// stands a person's height above it, and neither has volume below the slab
// (or every overpass walls off the road beneath it).
console.log("\nwalkable surface");
{
  const s = deckStations([[0, 0], [400, 0]], RENDER_WIDTH.arterial, (x) => (x > 80 && x < 320 ? -6 : 10), 30)!;
  const n = s.h.length;

  let below = 0;
  for (let i = 0; i < n; i++) if (s.h[i]! + DECK_SURFACE_Y <= s.h[i]!) below++;
  check("the walkable surface sits on the deck line", below === 0);

  // Standing on the deck, the barrier must be above head height relative to
  // the surface you are standing on.
  const surface = s.h[Math.floor(n / 2)]! + DECK_SURFACE_Y;
  const barrier = s.h[Math.floor(n / 2)]! + PARAPET_HEIGHT;
  check("the barrier stands above the walking surface", barrier > surface + 0.9, `${(barrier - surface).toFixed(2)} m`);

  // Mid-span the deck is well clear of the terrain, which is what makes the
  // deck a platform rather than a slab lying on the ground.
  const mid = Math.floor(n / 2);
  check("mid-span deck is clear of the ground", s.h[mid]! - -6 > 10, `${(s.h[mid]! + 6).toFixed(1)} m of air`);

  // Deck width is what collision uses for the walkable quad, so an edge that
  // renders wide must collide wide.
  const w = Math.hypot(s.lx[0]! - s.rx[0]!, s.ly[0]! - s.ry[0]!);
  check("collision width matches render width", Math.abs(w - RENDER_WIDTH.arterial) < 1e-6, `${w.toFixed(2)} m`);
}

console.log("\nlift");
{
  check("a non-bridge never lifts", deckLift({ struct: undefined, zlev: [3, 3] }).every((v) => v === 0));
  check("a level-1 bridge does not lift", deckLift({ struct: "bridge", zlev: [1, 1] }).every((v) => v === 0));
  const two = deckLift({ struct: "bridge", zlev: [2, 2] });
  check("a level-2 bridge clears a road below", two[0] > 5 && two[0] === two[1], `${two[0]} m`);
  const ramp = deckLift({ struct: "bridge", zlev: [2, 1] });
  check("a ramp lifts only its upper end", ramp[0] > 0 && ramp[1] === 0, `${ramp[0]} -> ${ramp[1]}`);
}

// Against the real extract, if one is present. This is the check that would
// have caught the first attempt: the structure was correct but hung on a rule
// that lifted almost nothing, so 98% of bridges rendered as a slab buried in
// the terrain and it looked exactly like the flat decks it replaced.
console.log("\nreal extract");
{
  const core = "data/processed/2026-08-04-portland/portland-core.json";
  if (!existsSync(core)) {
    console.log("  --  skipped (no local extract; run the transform stage first)");
  } else {
    const map = JSON.parse(readFileSync(core, "utf8")) as {
      edges: { polyline: [number, number][]; struct?: string; zlev?: [number, number] }[];
    };
    const spans = map.edges.filter((e) => e.struct === "bridge");
    const elevated = spans.filter((e) => (e.zlev?.[0] ?? 1) > 1 || (e.zlev?.[1] ?? 1) > 1);
    check("the extract carries bridges", spans.length > 1000, `${spans.length} legs`);
    check(
      "a real share of them sit above grade",
      elevated.length / spans.length > 0.7,
      `${elevated.length}/${spans.length} (${((elevated.length / spans.length) * 100).toFixed(0)}%)`,
    );
    // Terrain alone lifts almost nothing, so without ZLEV this collapses.
    check("grade levels survived the bake", map.edges.some((e) => (e.zlev?.[0] ?? 1) > 1), "found level 2+");
  }
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
