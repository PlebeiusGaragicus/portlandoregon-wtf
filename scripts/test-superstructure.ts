// Superstructure geometry for the named river crossings.
//
//   npm run test:superstructure
import { existsSync, readFileSync } from "node:fs";
import { CROSSINGS, crossingByKey, crossingKey } from "../shared/src/bridges.js";
import { deckStations } from "../client/src/render/deck.js";
import { pushBeam, pushSuperstructure, type BeamSoup } from "../client/src/render/superstructure.js";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const soup = (): BeamSoup => ({ pos: [], nrm: [] });
const tris = (s: BeamSoup): number => s.pos.length / 9;

console.log("\nthe beam primitive");
{
  const s = soup();
  pushBeam(s, [0, 0, 0], [0, 0, 10], 1);
  check("a beam is a closed four-sided prism", tris(s) === 8, `${tris(s)} triangles`);
  check("normals accompany every vertex", s.nrm.length === s.pos.length);

  const zero = soup();
  pushBeam(zero, [5, 5, 5], [5, 5, 5], 1);
  check("a zero-length beam makes nothing", tris(zero) === 0);

  // A vertical beam is the degenerate case for choosing a cross-section
  // reference vector; it must not collapse.
  const vertical = soup();
  pushBeam(vertical, [0, 0, 0], [0, 0, 20], 1.5);
  let finite = true;
  for (const v of [...vertical.pos, ...vertical.nrm]) if (!Number.isFinite(v)) finite = false;
  check("a vertical beam has finite geometry", finite && tris(vertical) === 8);
}

console.log("\nevery form builds");
{
  // A long, straight, level deck 20 m above the water — a river crossing.
  const stations = deckStations([[0, 0], [600, 0]], 20, () => 20, 30)!;
  for (const spec of CROSSINGS) {
    const s = soup();
    const piers = pushSuperstructure(s, stations, spec);
    const wanted = spec.form !== "girder";
    check(
      `${spec.name} (${spec.form})`,
      wanted ? tris(s) > 40 : tris(s) === 0,
      `${tris(s)} triangles, piers at ${piers.map((p) => p.toFixed(0)).join(" / ")} m`,
    );
    let finite = true;
    for (const v of s.pos) if (!Number.isFinite(v)) finite = false;
    if (!finite) check(`${spec.name} geometry is finite`, false);
  }
}

console.log("\nsupports stand clear of the channel");
{
  const stations = deckStations([[0, 0], [600, 0]], 20, () => 20, 30)!;
  for (const spec of CROSSINGS) {
    const piers = pushSuperstructure(soup(), stations, spec);
    const inside = piers.some((p) => Math.abs(p) < spec.mainSpan / 2 - 1e-6);
    check(`${spec.name}: nothing stands inside the main span`, !inside, `span ${spec.mainSpan} m`);
  }
}

console.log("\nthe table itself");
{
  check("names are unique", new Set(CROSSINGS.map((c) => c.name)).size === CROSSINGS.length);
  check("keys round-trip", CROSSINGS.every((c) => crossingByKey(crossingKey(c.name))?.name === c.name));
  check("an unknown name has no key", crossingKey("Not A Bridge") === 0);
  check("key 0 is nothing", crossingByKey(0) === null);
  check("every span is plausible", CROSSINGS.every((c) => c.mainSpan > 40 && c.mainSpan < 500));
  check("forms that rise actually rise", CROSSINGS.every((c) =>
    ["suspension", "through-arch", "through-truss", "cable-stayed", "lift", "bascule"].includes(c.form)
      ? c.rise > 5 : true));
}

console.log("\nthe extract agrees");
{
  const file = "data/processed/2026-08-04-portland/portland-core.json";
  if (!existsSync(file)) {
    console.log("  --  skipped (no local extract)");
  } else {
    const map = JSON.parse(readFileSync(file, "utf8")) as {
      edges: { struct?: string; crossing?: number; polyline: [number, number][] }[];
    };
    const tagged = map.edges.filter((e) => e.crossing);
    check("all thirteen crossings are tagged", tagged.length === CROSSINGS.length, `${tagged.length} tagged`);
    check("each crossing is tagged exactly once",
      new Set(tagged.map((e) => e.crossing)).size === tagged.length);
    check("every tagged edge is a bridge", tagged.every((e) => e.struct === "bridge"));
  }
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
