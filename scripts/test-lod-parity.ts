import * as THREE from "three";
import {
  decodeCityLod,
  encodeCityLod,
  layersFromMap,
  storeFromBuildings,
  type GameMap,
} from "@battle-juice/shared";
import { buildWorld } from "../client/src/render/world.js";

let failed = 0;
const check = (name: string, ok: boolean): void => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
};

const map = {
  meta: {
    name: "lod-parity",
    sourceDate: "test",
    origin: { lat: 0, lon: 0 },
    width: 2000,
    height: 1500,
  },
  buildings: [{
    id: 1,
    footprint: [[300, 400], [500, 400], [500, 650], [300, 650]],
    height: 30,
    use: "com",
  }],
  props: [],
  nodes: [],
  edges: [],
} as unknown as GameMap;
const store = storeFromBuildings(map.buildings);
const lod = decodeCityLod(encodeCityLod(map, 100));
const world = buildWorld(map, store, layersFromMap(map), null, undefined, false, undefined, lod);
let lodMesh: THREE.Mesh | null = null;
world.group.traverse((object) => {
  if (object instanceof THREE.Mesh && object.userData["cityLod"]) lodMesh = object;
});

check("LOD2 urban-mass mesh exists", lodMesh !== null);
if (lodMesh) {
  lodMesh.geometry.computeBoundingBox();
  const bounds = lodMesh.geometry.boundingBox!;
  check(
    "LOD2 covers the whole map",
    Math.abs(bounds.min.x) < 0.01 &&
      Math.abs(bounds.max.x - map.meta.width) < 0.01 &&
      Math.abs(bounds.min.z + map.meta.height) < 0.01 &&
      Math.abs(bounds.max.z) < 0.01,
  );
}

// The shipped city-lod texture is a density underlay, not a substitute for
// the city: no zoom may hide the boxes until the renderer installs a runtime
// bake via setFarTexture.
world.setViewHeight(11000, 9000);
check(
  "boxes stay at wide zoom until a baked texture exists",
  world.buildings.far.visible && !lodMesh?.visible,
);

const baked = new THREE.Texture();
world.setFarTexture(baked);
world.setViewHeight(8999, 9000);
check("box tier remains visible below wide threshold", world.buildings.far.visible && !lodMesh?.visible);
world.setViewHeight(9000, 9000);
check("wide tier exclusively replaces boxes once baked", !world.buildings.far.visible && lodMesh?.visible === true);
check(
  "baked texture is installed on the drape",
  ((lodMesh as THREE.Mesh | null)?.material as THREE.MeshBasicMaterial | undefined)?.map === baked,
);
world.setViewHeight(900, 9000);
check("zooming back restores box tier", world.buildings.far.visible && !lodMesh?.visible);

// Damage/boot-fill staleness signal for the renderer's rebake loop.
check("far version advances as far tiles fill", world.buildings.farVersion() > 0);

world.dispose();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exitCode = failed ? 1 : 0;
