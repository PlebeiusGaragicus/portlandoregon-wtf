// Geometry invariants for bridge structures.
//
// The structure hangs off deckStations, so that is what is worth testing: if
// the deck line disagrees with the road ribbon the whole span z-fights, and
// if it sags the piers point at the riverbed instead of holding the deck up.
//
//   npm run test:bridges
import { deckStations } from "../client/src/render/world.js";

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

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
