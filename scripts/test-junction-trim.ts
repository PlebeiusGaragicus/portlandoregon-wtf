// Invariants for clearing painted centrelines out of intersections.
//
//   npm run test:junction-trim
import {
  junctionsOf,
  trimMarkingsAtJunctions,
  MIN_RUN_M,
  TRIM_MARGIN,
} from "../tools/map-extract/lib/junction-trim.js";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const near = (a: number, b: number, tolerance = 0.15): boolean => Math.abs(a - b) <= tolerance;

const line = (id: number, polyline: [number, number][]) => ({ id, polyline, style: "yellow" as const });
const lengthOf = (pts: [number, number][]): number => {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
  }
  return total;
};

// A plus-shaped crossing at (100, 100): four legs into one node, so the node
// has degree 4 and is a real junction.
const crossNodes = [
  { id: 0, x: 100, y: 100 },
  { id: 1, x: 0, y: 100 },
  { id: 2, x: 200, y: 100 },
  { id: 3, x: 100, y: 0 },
  { id: 4, x: 100, y: 200 },
];
const localEdges = [
  { a: 0, b: 1, width: 8 },
  { a: 0, b: 2, width: 8 },
  { a: 0, b: 3, width: 8 },
  { a: 0, b: 4, width: 8 },
];

console.log("\njunction selection");
{
  const junctions = junctionsOf(crossNodes, localEdges);
  check("only the crossing is a junction", junctions.length === 1, `${junctions.length} found`);
  check(
    "radius follows the incident street width",
    near(junctions[0]!.r, (8 / 2) * TRIM_MARGIN, 1e-9),
    `r=${junctions[0]!.r.toFixed(2)} m`,
  );

  // A street split mid-block: degree 2, not a junction. Trimming here would
  // punch a gap into the middle of a straight road.
  const midblock = junctionsOf(
    [
      { id: 0, x: 50, y: 0 },
      { id: 1, x: 100, y: 0 },
      { id: 2, x: 150, y: 0 },
    ],
    [
      { a: 0, b: 1, width: 8 },
      { a: 1, b: 2, width: 8 },
    ],
  );
  check("mid-block splits are not junctions", midblock.length === 0, `${midblock.length} found`);

  // A dead end: degree 1.
  const deadEnd = junctionsOf(
    [
      { id: 0, x: 0, y: 0 },
      { id: 1, x: 60, y: 0 },
    ],
    [{ a: 0, b: 1, width: 8 }],
  );
  check("dead ends are not junctions", deadEnd.length === 0, `${deadEnd.length} found`);

  // An arterial crossing a local street: the paved box is set by the arterial,
  // so a radius taken from the local street would leave stubs inside it.
  const mixed = junctionsOf(crossNodes, [
    { a: 0, b: 1, width: 14 },
    { a: 0, b: 2, width: 14 },
    { a: 0, b: 3, width: 8 },
    { a: 0, b: 4, width: 8 },
  ]);
  check(
    "radius follows the widest incident street",
    near(mixed[0]!.r, (14 / 2) * TRIM_MARGIN, 1e-9),
    `r=${mixed[0]!.r.toFixed(2)} m`,
  );
}

console.log("\nclearing the crossing");
{
  const junctions = junctionsOf(crossNodes, localEdges);
  const r = junctions[0]!.r;

  // Striping running the full length of the east-west street.
  const result = trimMarkingsAtJunctions([line(0, [[0, 100], [200, 100]])], junctions);
  check("a line through the crossing is split in two", result.lines.length === 2, `${result.lines.length} runs`);
  check("the split is counted", result.split === 1 && result.touched === 1 && result.dropped === 0);

  const [west, east] = result.lines;
  check("the west run stops short of the crossing", near(west!.polyline[1]![0], 100 - r), `ends at x=${west!.polyline[1]![0]}`);
  check("the east run starts past the crossing", near(east!.polyline[0]![0], 100 + r), `starts at x=${east!.polyline[0]![0]}`);
  check(
    "the gap is the full junction diameter",
    near(east!.polyline[0]![0] - west!.polyline[1]![0], 2 * r),
    `${(east!.polyline[0]![0] - west!.polyline[1]![0]).toFixed(2)} m`,
  );
  check("both runs keep the source style", result.lines.every((l) => l.style === "yellow"));
  check("ids are reassigned contiguously", result.lines.every((l, i) => l.id === i));

  // Both streets' striping gets cleared, which is what removes the painted
  // "+" from the middle of the box.
  const both = trimMarkingsAtJunctions(
    [line(0, [[0, 100], [200, 100]]), line(1, [[100, 0], [100, 200]])],
    junctions,
  );
  check("both crossing streets are cleared", both.lines.length === 4, `${both.lines.length} runs`);
  const insideBox = both.lines.some((l) =>
    l.polyline.some(([x, y]) => Math.hypot(x - 100, y - 100) < r - 1e-6),
  );
  check("no painted geometry survives inside the junction", !insideBox);
}

console.log("\nwhat must not change");
{
  const junctions = junctionsOf(crossNodes, localEdges);

  // Mid-block striping nowhere near a junction must come back byte-identical.
  const away = line(0, [[0, 500], [60, 500], [120, 505]]);
  const result = trimMarkingsAtJunctions([away], junctions);
  check("striping away from junctions is untouched", result.touched === 0 && result.lines.length === 1);
  check(
    "its geometry is unchanged",
    JSON.stringify(result.lines[0]!.polyline) === JSON.stringify(away.polyline),
    JSON.stringify(result.lines[0]!.polyline),
  );

  // A line that would leave only a sliver behind is dropped rather than
  // rendered as a stub on the asphalt.
  const r = junctions[0]!.r;
  const stub = trimMarkingsAtJunctions([line(0, [[100 - r - 1, 100], [200, 100]])], junctions);
  check("sub-minimum stubs are dropped", stub.lines.length === 1, `${stub.lines.length} runs`);
  check("every surviving run clears the minimum length", stub.lines.every((l) => lengthOf(l.polyline) >= MIN_RUN_M - 0.05));

  // A line entirely inside a junction disappears completely.
  const swallowed = trimMarkingsAtJunctions([line(0, [[98, 100], [102, 100]])], junctions);
  check("a line inside the junction is dropped", swallowed.lines.length === 0 && swallowed.dropped === 1);
}

console.log("\ngeometry preserved outside the cuts");
{
  const junctions = junctionsOf(crossNodes, localEdges);
  // A multi-vertex line whose bend sits well away from the crossing: the bend
  // must survive intact, only the crossing itself is removed.
  const bendy = line(0, [[0, 100], [40, 100], [60, 130], [140, 130], [160, 100], [200, 100]]);
  const result = trimMarkingsAtJunctions([bendy], junctions);
  check("a line detouring around the junction is untouched", result.touched === 0, `touched=${result.touched}`);
  check("its vertices all survive", result.lines[0]!.polyline.length === bendy.polyline.length);
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
