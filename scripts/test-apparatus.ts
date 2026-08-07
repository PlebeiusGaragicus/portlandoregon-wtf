import { readFileSync } from "node:fs";
import { createCanvas } from "@napi-rs/canvas";
import type { GameMap, Landmark, StreetEdge, StreetNode } from "@battle-juice/shared";
import * as THREE from "three";
import { Actors, buildFireRoster } from "../client/src/render/actors.js";
import {
  fillIncident,
  needsForIncident,
  reconcileIncident,
  releaseIncident,
  type Incident,
  type Unit,
} from "../client/src/render/dispatch.js";

// Actors only needs a 2D canvas to build its additive glow texture.
(globalThis as unknown as { document: { createElement: () => unknown } }).document = {
  createElement: () => createCanvas(128, 128),
};

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const source = JSON.parse(
  readFileSync(new URL("../data/landmarks.json", import.meta.url), "utf8"),
) as { landmarks: Array<{ kind: string; ref: string }> };
const productionStations = source.landmarks
  .filter((landmark) => landmark.kind === "fire-station")
  .map((_, id) => ({ id }));
const productionRoster = buildFireRoster(productionStations);
check("production source contains 31 mapped fire stations", productionStations.length === 31);
check("production roster provisions exactly 62 apparatus", productionRoster.length === 62);
check(
  "every station gets stable engine and truck slots",
  productionStations.every((station) => {
    const units = productionRoster.filter((unit) => unit.stationId === station.id);
    return units.length === 2 &&
      units.some((unit) => unit.kind === "engine" && unit.stationSlot === 0) &&
      units.some((unit) => unit.kind === "truck" && unit.stationSlot === 1);
  }),
);

function unit(uid: number, x: number): Unit {
  return {
    uid,
    kind: uid % 2 ? "engine" : "truck",
    mode: "available",
    x,
    y: 0,
    home: { x, y: 10 },
    goal: null,
    respondT: 0,
    incidentId: null,
  };
}

function incident(id: number, x: number, needs = ["fire", "fire", "fire", "fire"]): Incident {
  return { id, kind: "fire", x, y: 0, z: 0, t: 100, needs: [...needs], assigned: [], glow: null };
}

check(
  "fire alarm policy always requests four apparatus",
  needsForIncident("fire", () => 1).filter((need) => need === "fire").length === 4,
);

{
  const units = [unit(1, 100), unit(2, 10), unit(3, 30), unit(4, 20), unit(5, 50), unit(6, 40)];
  const first = incident(1, 0);
  fillIncident(first, units);
  const ids = first.assigned.map((assigned) => assigned.uid);
  check("one fire reserves four unique apparatus", new Set(ids).size === 4 && first.needs.length === 0);
  check(
    "the four individually nearest available apparatus are selected",
    [...ids].sort((a, b) => a - b).join(",") === "2,3,4,6",
    ids.join(","),
  );

  const second = incident(2, 0);
  fillIncident(second, units);
  check(
    "simultaneous fires never double-book apparatus",
    second.assigned.every((assigned) => !ids.includes(assigned.uid)) &&
      second.assigned.length === 2 &&
      second.needs.length === 2,
  );

  releaseIncident(first);
  for (const released of units.filter((candidate) => candidate.mode === "return")) released.mode = "available";
  fillIncident(second, units);
  check("pending fire slots backfill as rigs become available", second.assigned.length === 4 && second.needs.length === 0);
}

{
  const units = [unit(20, 0), unit(21, 20), unit(22, 40), unit(23, 60)];
  const call = incident(3, 10);
  fillIncident(call, units);
  const failed = call.assigned[0]!;
  failed.mode = "return";
  reconcileIncident(call);
  check(
    "failed response restores its unfilled fire slot",
    call.assigned.length === 3 && call.needs.filter((need) => need === "fire").length === 1 &&
      failed.incidentId === null,
  );
}

const nodes: StreetNode[] = Array.from({ length: 7 }, (_, id) => ({ id, x: id * 100, y: 0 }));
const edges: StreetEdge[] = nodes.slice(0, -1).map((node, id) => ({
  id,
  a: node.id,
  b: node.id + 1,
  polyline: [[node.x, node.y], [nodes[id + 1]!.x, nodes[id + 1]!.y]],
  width: 8,
  name: `Test ${id}`,
  class: "local",
}));
const stations: Landmark[] = [
  { id: 100, kind: "fire-station", label: "A", name: "A", address: "", x: 0, y: 20 },
  { id: 101, kind: "fire-station", label: "B", name: "B", address: "", x: 200, y: 30 },
  { id: 102, kind: "fire-station", label: "C", name: "C", address: "", x: 400, y: -25 },
];
const map = {
  meta: {
    name: "apparatus-test",
    sourceDate: "test",
    origin: { lat: 45.5, lon: -122.6 },
    width: 700,
    height: 200,
  },
  nodes,
  edges,
  buildings: [],
  entries: { north: [], south: [] },
  props: [],
  landmarks: stations,
} as GameMap;

{
  const originalRandom = Math.random;
  Math.random = () => 1;
  const actors = new Actors(map, null);
  const internals = actors as unknown as {
    dispatch: { nextIncident: number; incidents: Incident[] };
    respawnCooldown: number;
    body: THREE.InstancedMesh;
  };
  internals.dispatch.nextIncident = Infinity;
  internals.respawnCooldown = Infinity;

  actors.update(0, 0, { x: 500, y: 0 });
  const parked = actors.fireApparatusSnapshot();
  check("tiny map has one engine and truck per station", parked.length === 6);
  check("available apparatus are hidden and do not move", parked.every((rig) => rig.mode === "available") && internals.body.count === 0);

  actors.hasFireNear = () => true;
  actors.reportFire(500, 0, 0);
  actors.update(0, 0, { x: 500, y: 0 });
  const responding = actors.fireApparatusSnapshot().filter((rig) => rig.mode === "respond");
  check(
    "reported fire dispatches exactly four nearest station rigs",
    responding.length === 4 &&
      responding.every((rig) => rig.stationId === 101 || rig.stationId === 102) &&
      new Set(responding.map((rig) => rig.incidentId)).size === 1 &&
      internals.body.count === 4,
  );
  actors.update(0, 0, { x: 20_000, y: 20_000 });
  check(
    "fire roster and reservations survive wide camera moves",
    actors.fireApparatusSnapshot().filter((rig) => rig.mode === "respond").length === 4,
  );

  const connectorRig = responding.find((rig) => rig.stationId === 102)!;
  actors.update(0.5, 0.5, { x: 500, y: 0 });
  const afterPullout = actors.fireApparatusSnapshot().find((rig) => rig.uid === connectorRig.uid)!;
  const pulloutDistance = Math.hypot(afterPullout.x - connectorRig.x, afterPullout.y - connectorRig.y);
  check(
    "outbound bay connector starts continuously without a road teleport",
    pulloutDistance > 0 && pulloutDistance < 5,
    `moved=${pulloutDistance.toFixed(2)}m`,
  );

  for (let step = 0; step < 600 && actors.fireUnitsOnScene().length < 4; step++) {
    actors.update(0.1, 0.6 + step * 0.1, { x: 500, y: 0 });
  }
  check(
    "all four assigned rigs reach and work the scene",
    actors.fireUnitsOnScene().length === 4,
    `${actors.fireApparatusSnapshot().map((rig) => `${rig.uid}:${rig.mode}@${rig.x.toFixed(0)}`).join(" ")} calls=${internals.dispatch.incidents.map((call) => `${call.id}[${call.needs.join(",")}]:${call.assigned.map((rig) => rig.uid).join(",")}`).join(";")}`,
  );

  actors.hasFireNear = () => false;
  actors.update(2.1, 70, { x: 500, y: 0 });
  actors.update(2.1, 72.1, { x: 500, y: 0 });
  let sawInboundConnector = false;
  for (let step = 0; step < 1200; step++) {
    actors.update(0.1, 74.2 + step * 0.1, { x: 500, y: 0 });
    const roster = actors.fireApparatusSnapshot();
    if (roster.some((rig) => rig.mode === "return-bay")) sawInboundConnector = true;
    if (roster.every((rig) => rig.mode === "available")) break;
  }
  const returned = actors.fireApparatusSnapshot();
  check(
    "returning rigs traverse an inbound station connector",
    sawInboundConnector,
    returned.map((rig) => `${rig.uid}:${rig.mode}@${rig.x.toFixed(0)},${rig.y.toFixed(0)}`).join(" "),
  );
  check(
    "return completes at each owning station and restores availability",
    returned.every((rig) => {
      const station = stations.find((candidate) => candidate.id === rig.stationId)!;
      return rig.mode === "available" &&
        rig.incidentId === null &&
        Math.hypot(rig.x - station.x, rig.y - station.y) < 0.01;
    }) && internals.body.count === 0,
  );
  actors.dispose();
  Math.random = originalRandom;
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exitCode = failures ? 1 : 0;
