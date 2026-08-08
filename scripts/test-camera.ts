// Focused invariants for the tactical -> full-city camera transition.
//
//   npm run test:camera
import * as THREE from "three";
import type { GameMap } from "@portlandoregon/shared";
import {
  CameraRig,
  CITY_FIT_PADDING,
  OVERVIEW_ORTHO_START,
  OVERVIEW_TRANSITION_START,
  toScene,
} from "../client/src/render/camera.js";

const map = {
  meta: {
    name: "portland",
    sourceDate: "test",
    origin: { lat: 45.33, lon: -122.86 },
    width: 43573,
    height: 35780,
  },
} as GameMap;

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const near = (a: number, b: number, tolerance = 1e-6): boolean =>
  Math.abs(a - b) <= tolerance;

console.log("\nrotated fit span");
{
  const rig = new CameraRig(map);
  const aspect = 16 / 9;
  let metrics = rig.metrics(aspect);
  const northFit =
    CITY_FIT_PADDING *
    Math.max(map.meta.height, map.meta.width / aspect);
  check("north-up fit is aspect-aware", near(metrics.fitSpan, northFit));
  check("north-up rotated bounds are exact", metrics.rotatedWidth === map.meta.width && metrics.rotatedHeight === map.meta.height);

  rig.theta = Math.PI / 4;
  metrics = rig.metrics(aspect);
  const diagonal = (map.meta.width + map.meta.height) / Math.sqrt(2);
  check("45° fit uses rotated bounds", near(metrics.rotatedWidth, diagonal) && near(metrics.rotatedHeight, diagonal));
  check("fit includes padding", near(metrics.fitSpan, diagonal * CITY_FIT_PADDING));
}

console.log("\ncontinuous transition");
{
  const rig = new CameraRig(map);
  const aspect = 16 / 9;
  const fit = rig.metrics(aspect).fitSpan;
  rig.viewHeight = fit * OVERVIEW_TRANSITION_START;
  let metrics = rig.metrics(aspect);
  check("transition starts at configured coverage", near(metrics.transition, 0));
  check("transition starts in perspective", !metrics.orthographic);

  rig.viewHeight = fit * ((OVERVIEW_TRANSITION_START + OVERVIEW_ORTHO_START) / 2);
  metrics = rig.metrics(aspect);
  check("mid-transition is smooth and top-down-bound", near(metrics.transition, 0.5) && metrics.effectiveTilt > rig.tilt);

  rig.viewHeight = fit * OVERVIEW_ORTHO_START;
  metrics = rig.metrics(aspect);
  check("ortho starts only after reaching 90°", metrics.orthographic && near(metrics.effectiveTilt, Math.PI / 2));
}

console.log("\nfit clamp and recenter");
{
  const rig = new CameraRig(map);
  const aspect = 16 / 9;
  const perspective = new THREE.PerspectiveCamera();
  rig.target = { x: 18000, y: 15000 };
  rig.viewHeight = 500;
  rig.apply(perspective, aspect);
  check("legal tactical target is not recentered", near(rig.target.x, 18000) && near(rig.target.y, 15000));

  rig.zoomBy(1e6);
  rig.apply(perspective, aspect);
  const metrics = rig.metrics(aspect);
  check("zoom-out exceeds the former 12 km cap", rig.viewHeight > 12000, `${rig.viewHeight.toFixed(0)} m`);
  check("zoom-out stops at dynamic fit", near(rig.viewHeight, metrics.fitSpan, 1e-5));
  check("fit view recenters only when required", near(rig.target.x, map.meta.width / 2) && near(rig.target.y, map.meta.height / 2));

  const oldFit = rig.viewHeight;
  rig.theta = Math.PI / 4;
  rig.clampToMap();
  check("rotation while fitted tracks the new fit", !near(rig.viewHeight, oldFit) && near(rig.viewHeight, rig.metrics().fitSpan, 1e-5));

  const orthographic = new THREE.OrthographicCamera();
  rig.apply(orthographic, aspect);
  orthographic.updateMatrixWorld();
  let maxNdc = 0;
  for (const [x, y] of [
    [0, 0],
    [map.meta.width, 0],
    [map.meta.width, map.meta.height],
    [0, map.meta.height],
  ]) {
    const projected = toScene(x, y).project(orthographic);
    maxNdc = Math.max(maxNdc, Math.abs(projected.x), Math.abs(projected.y));
  }
  check("padded fit contains every rotated map corner", maxNdc <= 1 / CITY_FIT_PADDING + 1e-6, `max NDC ${maxNdc.toFixed(4)}`);
}

console.log("\nmatched projection handoff");
{
  const rig = new CameraRig(map);
  const aspect = 1.5;
  rig.theta = 0.63;
  rig.viewHeight = rig.metrics(aspect).fitSpan * OVERVIEW_ORTHO_START;
  const perspective = new THREE.PerspectiveCamera();
  const orthographic = new THREE.OrthographicCamera();
  rig.apply(perspective, aspect);
  rig.apply(orthographic, aspect);
  perspective.updateMatrixWorld();
  orthographic.updateMatrixWorld();

  let maxDelta = 0;
  for (const [x, y] of [
    [rig.target.x, rig.target.y],
    [rig.target.x + 2500, rig.target.y - 1800],
    [rig.target.x - 3200, rig.target.y + 2100],
  ]) {
    const p = toScene(x, y).project(perspective);
    const o = toScene(x, y).project(orthographic);
    maxDelta = Math.max(maxDelta, Math.abs(p.x - o.x), Math.abs(p.y - o.y));
  }
  check("perspective and ortho match on the ground plane", maxDelta < 1e-6, `max NDC delta ${maxDelta.toExponential(2)}`);
  check("position and orientation match at handoff", perspective.position.distanceTo(orthographic.position) < 1e-6 && perspective.quaternion.angleTo(orthographic.quaternion) < 1e-6);
}

console.log("\ncursor anchor across handoff");
{
  const rig = new CameraRig(map);
  const aspect = 1.5;
  const fit = rig.metrics(aspect).fitSpan;
  rig.viewHeight = fit * (OVERVIEW_ORTHO_START - 0.02);
  const perspective = new THREE.PerspectiveCamera();
  const orthographic = new THREE.OrthographicCamera();
  // Small but non-central offset, inside the narrow legal target interval at
  // this coverage. Larger offsets correctly yield to map-bound recentering.
  const ndc = new THREE.Vector2(0.01, 0);
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const raycaster = new THREE.Raycaster();
  const hit = (camera: THREE.Camera): THREE.Vector3 => {
    camera.updateMatrixWorld();
    raycaster.setFromCamera(ndc, camera);
    return raycaster.ray.intersectPlane(plane, new THREE.Vector3())!;
  };

  rig.apply(perspective, aspect);
  const before = hit(perspective);
  rig.zoomBy((OVERVIEW_ORTHO_START + 0.02) / (OVERVIEW_ORTHO_START - 0.02));
  rig.apply(orthographic, aspect);
  const after = hit(orthographic);
  rig.alignWorldPoint(
    { x: before.x, y: -before.z },
    { x: after.x, y: -after.z },
  );
  rig.apply(orthographic, aspect);
  const anchored = hit(orthographic);
  check("off-center world point survives projection switch", anchored.distanceTo(before) < 1e-5, `drift ${anchored.distanceTo(before).toExponential(2)} m`);
}

console.log("\nmoving midpoint camera anchor");
{
  const rig = new CameraRig(map);
  const aspect = 1.5;
  rig.target = { x: 20000, y: 17000 };
  rig.viewHeight = 1800;
  rig.theta = 0.2;
  const camera = new THREE.PerspectiveCamera();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const raycaster = new THREE.Raycaster();
  const hit = (ndc: THREE.Vector2): THREE.Vector3 => {
    rig.apply(camera, aspect);
    camera.updateMatrixWorld();
    raycaster.setFromCamera(ndc, camera);
    return raycaster.ray.intersectPlane(plane, new THREE.Vector3())!;
  };

  const from = new THREE.Vector2(-0.18, 0.08);
  const to = new THREE.Vector2(0.24, -0.12);
  const before = hit(from);
  rig.theta += 0.48;
  rig.zoomBy(0.72);
  const after = hit(to);
  rig.alignWorldPoint(
    { x: before.x, y: -before.z },
    { x: after.x, y: -after.z },
  );
  const anchored = hit(to);
  check(
    "pan + pinch + rotation preserve the moving midpoint",
    anchored.distanceTo(before) < 1e-5,
    `drift ${anchored.distanceTo(before).toExponential(2)} m`,
  );
}

// The camera target must never leave the city, at any heading, zoom or screen
// shape. It used to: a shallow tilt grows the frustum's forward reach until no
// legal interval survives in `constrain`, and the old fallback centred the
// footprint rather than the map, stranding the target tens of km off the south
// edge — a sliver of city at the top of a phone screen and void everywhere
// else. Portrait aspects are the worst case, so sweep them explicitly.
console.log("\ntarget stays on the map across heading x zoom x aspect");
{
  let worst = 0;
  let worstAt = "";
  for (const aspect of [0.42, 1170 / 2100, 0.75, 1, 16 / 9, 2.2]) {
    for (let ti = 0; ti < 64; ti++) {
      const theta = (ti / 64) * 2 * Math.PI;
      const probe = new CameraRig(map);
      probe.theta = theta;
      const fit = probe.metrics(aspect).fitSpan;
      for (let step = 1; step <= 40; step++) {
        const rig = new CameraRig(map);
        rig.theta = theta;
        rig.updateViewport(aspect);
        rig.viewHeight = fit * (step / 40);
        rig.target = { x: map.meta.width / 2, y: map.meta.height / 2 };
        rig.updateViewport(aspect);
        const excursion = Math.max(
          -rig.target.x,
          rig.target.x - map.meta.width,
          -rig.target.y,
          rig.target.y - map.meta.height,
        );
        if (excursion > worst) {
          worst = excursion;
          worstAt = `aspect=${aspect.toFixed(2)} theta=${((theta * 180) / Math.PI).toFixed(0)}deg vh=${(fit * (step / 40)).toFixed(0)}`;
        }
      }
    }
  }
  check(
    "target never leaves the map",
    worst <= 0,
    worst > 0 ? `${worst.toFixed(0)} m outside at ${worstAt}` : "0 m outside over 15360 poses",
  );
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
