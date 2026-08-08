// Invariants for rejecting impossible building prisms.
//
//   npm run test:building-shape
import {
  footprintArea,
  isBuildableFootprint,
  plausibleHeight,
  MAX_SLENDERNESS,
  MIN_FOOTPRINT_M2,
} from "../tools/map-extract/lib/building-shape.js";
import type { Pt } from "../tools/map-extract/lib/geo.js";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** Axis-aligned rectangle, counter-clockwise. */
const box = (w: number, h: number): Pt[] => [[0, 0], [w, 0], [w, h], [0, h]];

console.log("\nfootprint area");
{
  check("area of a 10x20 box", footprintArea(box(10, 20)) === 200);
  // Winding must not matter: source rings arrive in both orientations.
  const clockwise: Pt[] = [[0, 0], [0, 20], [10, 20], [10, 0]];
  check("area ignores winding", footprintArea(clockwise) === 200);
  check("a degenerate ring has zero area", footprintArea([[0, 0], [5, 0], [10, 0]]) === 0);
}

console.log("\nrejecting non-structures");
{
  check("a house-sized footprint is buildable", isBuildableFootprint(box(8, 12)));
  check("a garden shed is buildable", isBuildableFootprint(box(2, 3)) === 6 >= MIN_FOOTPRINT_M2);
  check("a 1 m2 sliver is not", !isBuildableFootprint(box(1, 1)));
  check("a zero-area ring is not", !isBuildableFootprint([[0, 0], [5, 0], [10, 0]]));
  check(
    "the threshold is inclusive",
    isBuildableFootprint(box(MIN_FOOTPRINT_M2, 1)) && !isBuildableFootprint(box(MIN_FOOTPRINT_M2 - 0.01, 1)),
  );
}

console.log("\nclamping needles");
{
  // The case this exists for: Wells Fargo Center arrives as one real tower
  // plus 44 slivers, every one of them inheriting the tower's 163.1 m.
  const tower = box(38, 40); // 1520 m2, the genuine footprint
  check(
    "a real tower keeps its height",
    plausibleHeight(tower, 163.1) === 163.1,
    `ceiling ${(MAX_SLENDERNESS * Math.sqrt(footprintArea(tower))).toFixed(0)} m`,
  );

  const sliver = box(1.5, 2); // 3 m2, one of the 44
  const clamped = plausibleHeight(sliver, 163.1);
  check("a sliver does not keep the tower's height", clamped < 163.1, `${clamped.toFixed(1)} m`);
  check(
    "the clamp is the slenderness ceiling",
    Math.abs(clamped - MAX_SLENDERNESS * Math.sqrt(3)) < 1e-9,
    `${clamped.toFixed(2)} m`,
  );

  // The tallest building in the current extract must survive untouched, or
  // the cap is set too low to be safe on real towers.
  check("the extract's tallest building is unaffected", plausibleHeight(box(1124 / 30, 30), 192.5) === 192.5);

  // Ordinary buildings are never touched: a two-storey house is nowhere near
  // its ceiling.
  const house = box(9, 11);
  check("a house is never clamped", plausibleHeight(house, 7) === 7);
  check("clamping never raises a height", plausibleHeight(box(60, 60), 4) === 4);
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
