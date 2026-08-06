import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import {
  encodeBuildings,
  encodeCityLod,
  encodeLayers,
  encodeProps,
  encodeStreets,
  layerInputs,
  type GameMap,
} from "@battle-juice/shared";
import { verifyStagedMap } from "./verify-staged-map.js";

let failed = 0;
function check(name: string, condition: boolean): void {
  if (!condition) failed++;
  console.log(`${condition ? "ok  " : "FAIL"} ${name}`);
}

const map: GameMap = {
  meta: {
    name: "release-gate-fixture",
    sourceDate: "synthetic",
    origin: { lat: 0, lon: 0 },
    width: 100,
    height: 100,
  },
  nodes: [
    { id: 1, x: 10, y: 10 },
    { id: 2, x: 90, y: 90 },
  ],
  edges: [
    {
      id: 1,
      a: 1,
      b: 2,
      polyline: [[10, 10], [90, 90]],
      width: 8,
      name: "Fixture Street",
      class: "local",
    },
  ],
  buildings: [
    {
      id: 1,
      footprint: [[20, 20], [30, 20], [30, 30], [20, 30]],
      height: 6,
      use: "sfr",
    },
  ],
  entries: { north: [2], south: [1] },
  props: [{ kind: "tree", x: 40, y: 40, size: 2 }],
  sidewalks: [{ id: 1, rings: [[[5, 5], [15, 5], [15, 15], [5, 15]]] }],
};

function gz(bytes: Uint8Array | string): Buffer {
  return gzipSync(bytes);
}

function heightfieldFixture(): Buffer {
  const bytes = Buffer.alloc(28);
  bytes.write("BJH1", 0, "ascii");
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(2, 8);
  bytes.writeFloatLE(30, 12);
  bytes.writeFloatLE(0.1, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(2, 22);
  bytes.writeUInt16LE(3, 24);
  bytes.writeUInt16LE(4, 26);
  return bytes;
}

const dir = mkdtempSync(join(tmpdir(), "battle-juice-map-gate-"));
try {
  writeFileSync(join(dir, "buildings.bin.gz"), gz(encodeBuildings(map)));
  writeFileSync(join(dir, "props.bin.gz"), gz(encodeProps(map.props)));
  writeFileSync(join(dir, "streets.bin.gz"), gz(encodeStreets(map)));
  writeFileSync(join(dir, "layers.bin.gz"), gz(encodeLayers(layerInputs(map))));
  writeFileSync(join(dir, "city-lod.bin.gz"), gz(encodeCityLod(map)));
  writeFileSync(join(dir, "map-lite.json.gz"), gz(JSON.stringify({ meta: map.meta, entries: map.entries })));
  writeFileSync(join(dir, "heightmap.bin.gz"), gz(heightfieldFixture()));

  let results = verifyStagedMap(dir);
  check("complete staged map passes", results.every((result) => result.status === "ok"));

  rmSync(join(dir, "heightmap.bin.gz"));
  results = verifyStagedMap(dir);
  check(
    "missing optional heightmap passes",
    results.find((result) => result.name === "heightmap.bin.gz")?.status === "missing-optional" &&
      results.every((result) => result.status !== "failed"),
  );

  rmSync(join(dir, "props.bin.gz"));
  results = verifyStagedMap(dir);
  check("missing required artifact fails", results.find((result) => result.name === "props.bin.gz")?.status === "failed");

  writeFileSync(join(dir, "props.bin.gz"), gz("not a prop store"));
  results = verifyStagedMap(dir);
  check("undecodable required artifact fails", results.find((result) => result.name === "props.bin.gz")?.status === "failed");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exitCode = failed ? 1 : 0;
