// Measuring bridge deck widths from the city's deck outlines.
//
//   npm run test:deck-width
import { existsSync, readFileSync } from "node:fs";
import {
  DeckIndex,
  measureDeckWidth,
  pointInPolygon,
  WIDTH_CAP_RATIO,
} from "../tools/map-extract/lib/deck-width.js";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** A 20 m wide deck running east for 200 m. */
const deck = {
  rings: [[[0, -10], [200, -10], [200, 10], [0, 10]]] as [number, number][][],
  kind: "road" as const,
};

console.log("\npolygon containment");
{
  check("a point on the deck is inside", pointInPolygon(100, 0, deck.rings));
  check("a point beside the deck is outside", !pointInPolygon(100, 30, deck.rings));
  // A deck with a hole (an opening between carriageways) must not count.
  const holed = [
    [[0, -10], [200, -10], [200, 10], [0, 10]],
    [[90, -2], [110, -2], [110, 2], [90, 2]],
  ] as [number, number][][];
  check("a point in a hole is outside", !pointInPolygon(100, 0, holed));
}

console.log("\nmeasuring");
{
  const index = new DeckIndex([deck]);
  const centre: [number, number][] = [[20, 0], [180, 0]];
  const w = measureDeckWidth(centre, index, 100);
  check("measures the true deck width", w !== null && Math.abs(w - 20) < 0.2, `${w?.toFixed(2)} m`);

  // Off the deck entirely: no published outline, so no measurement, and the
  // caller falls back to the road class.
  const away: [number, number][] = [[20, 500], [180, 500]];
  check("a span off any deck measures nothing", measureDeckWidth(away, index, 100) === null);

  // A diagonal crossing must still measure the perpendicular width, not the
  // longer slant across the polygon.
  const h = 10 / Math.SQRT2; // half-width projected onto each axis
  const diagonalDeck = {
    rings: [[
      [-h, h], [140 - h, 140 + h], [140 + h, 140 - h], [h, -h],
    ]] as [number, number][][],
    kind: "road" as const,
  };
  const diag = measureDeckWidth([[10, 10], [120, 120]], new DeckIndex([diagonalDeck]), 100);
  check("width is perpendicular, not slanted", diag !== null && Math.abs(diag - 20) < 0.5, `${diag?.toFixed(2)} m`);
}

console.log("\nthe interchange cap");
{
  // The real failure this guards: several carriageways share one deck
  // polygon, so a service road inside it measures the whole structure.
  const wide = {
    rings: [[[0, -30], [200, -30], [200, 30], [0, 30]]] as [number, number][][],
    kind: "road" as const,
  };
  const index = new DeckIndex([wide]);
  const alley = measureDeckWidth([[20, 0], [180, 0]], index, 4);
  check("an alley cannot inherit a 60 m interchange deck", alley !== null && alley <= 4 * WIDTH_CAP_RATIO + 1e-6, `${alley?.toFixed(1)} m`);

  // A genuinely wide road keeps a genuinely wide deck.
  const arterial = measureDeckWidth([[20, 0], [180, 0]], index, 14);
  check("a freeway keeps its wide deck", arterial !== null && arterial > 25, `${arterial?.toFixed(1)} m`);
}

console.log("\nagainst the real crossings");
{
  const file = "data/processed/2026-08-04-portland/portland-core.json";
  if (!existsSync(file)) {
    console.log("  --  skipped (no local extract)");
  } else {
    const map = JSON.parse(readFileSync(file, "utf8")) as {
      edges: { polyline: [number, number][]; struct?: string; deckWidth?: number; class: string }[];
      bridges: { rings: [number, number][][]; name?: string; kind: "river" | "road" }[];
    };
    const spans = map.edges.filter((e) => e.struct === "bridge");
    const measured = spans.filter((e) => e.deckWidth);
    check("most spans on a published deck get a width", measured.length / spans.length > 0.5,
      `${measured.length}/${spans.length}`);

    // Known real dimensions. The Burnside deck is ~24 m and the Tilikum ~24 m;
    // if the measurement drifts far from those it is measuring the wrong thing.
    const named = new Map(map.bridges.filter((b) => b.name).map((b) => [b.name!, b]));
    for (const [name, low, high] of [["Burnside", 18, 30], ["Tilikum Crossing", 18, 30], ["Hawthorne", 14, 28]] as const) {
      const poly = named.get(name);
      if (!poly) { check(`${name} is present`, false); continue; }
      const one = new DeckIndex([poly]);
      // A crossing carries its roadway plus bridgehead ramps and paths, and
      // those are deliberately narrower. The deck width that describes the
      // bridge is the main carriageway's — the widest span on it.
      const on = measured.filter((e) => {
        const m = e.polyline[Math.floor(e.polyline.length / 2)]!;
        return one.at(m[0], m[1]) !== null;
      }).map((e) => e.deckWidth!);
      const roadway = on.length ? Math.max(...on) : NaN;
      check(`${name} roadway is a plausible width`, roadway >= low && roadway <= high, `${roadway.toFixed(1)} m`);
    }
  }
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
