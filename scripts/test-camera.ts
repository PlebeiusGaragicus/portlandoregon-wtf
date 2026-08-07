// Focused invariants for the tactical -> full-city camera transition.
//
//   npm run test:camera
import * as THREE from "three";
import type { GameMap } from "@battle-juice/shared";
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
  rig.target.x += before.x - after.x;
  rig.target.y += after.z - before.z;
  rig.updateViewport(aspect);
  rig.apply(orthographic, aspect);
  const anchored = hit(orthographic);
  check("off-center world point survives projection switch", anchored.distanceTo(before) < 1e-5, `drift ${anchored.distanceTo(before).toExponential(2)} m`);
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
