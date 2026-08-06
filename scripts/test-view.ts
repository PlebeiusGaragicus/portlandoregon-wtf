// Checks client/src/view.ts against a stub localStorage and a minimal map.
//
//   npx tsx scripts/test-view.ts
//
// Runs in about a second. The point is to never have to verify camera
// persistence by hand in a browser: a real page load costs a 30 MB download
// and half a minute of geometry building before anything is visible, and the
// interesting cases here (corrupt records, a view saved for another map) are
// awkward to even set up by clicking.
import { latLonToWorld, worldToLatLon, type GameMap } from "@battle-juice/shared";
import { CameraRig, MIN_VIEW_HEIGHT } from "../client/src/render/camera.js";
import { createViewSaver, restoreView } from "../client/src/view.js";

const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as Storage;

// Same shape as the real Portland extract, without the 538k buildings.
const map = {
  meta: { name: "portland", sourceDate: "test", origin: { lat: 45.33, lon: -122.86 }, width: 43573, height: 35780 },
} as GameMap;
const other = { meta: { ...map.meta, name: "elsewhere" } } as GameMap;

const KEY = "bj.view.v1";
let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol;

// 1. First visit: the requested place, fully zoomed in.
{
  store.clear();
  const rig = new CameraRig(map);
  const restored = restoreView(rig, map);
  const want = latLonToWorld(map.meta, { lat: 45.50666, lon: -122.60496 });
  const at = worldToLatLon(map.meta, rig.target.x, rig.target.y);
  check("new visitor: reports no saved view", restored === false);
  check(
    "new visitor: opens at 45.50666, -122.60496",
    near(rig.target.x, want.x, 0.5) && near(rig.target.y, want.y, 0.5),
    `${at.lat.toFixed(5)}, ${at.lon.toFixed(5)}`,
  );
  check("new visitor: max zoom", rig.viewHeight === MIN_VIEW_HEIGHT, `viewHeight=${rig.viewHeight}`);
}

// 2. Move, save, reload: comes back where it was.
{
  store.clear();
  const rig = new CameraRig(map);
  restoreView(rig, map);
  const save = createViewSaver(rig, map);
  rig.target = { x: 19935, y: 19671 };
  rig.viewHeight = 900;
  rig.theta = 1.2345;
  rig.tilt = 1.0;
  save();

  const rig2 = new CameraRig(map);
  const restored = restoreView(rig2, map);
  check("return visit: reports a saved view", restored === true);
  check(
    "return visit: same position (~1 m)",
    near(rig2.target.x, 19935, 1.5) && near(rig2.target.y, 19671, 1.5),
    `x=${rig2.target.x.toFixed(1)} y=${rig2.target.y.toFixed(1)}`,
  );
  check("return visit: same zoom", near(rig2.viewHeight, 900, 0.1), `${rig2.viewHeight}`);
  check("return visit: same heading", near(rig2.theta, 1.2345, 1e-3) && near(rig2.tilt, 1.0, 1e-3));
}

// 3. Junk and hostile records fall back to the default instead of wedging.
{
  const want = latLonToWorld(map.meta, { lat: 45.50666, lon: -122.60496 });
  const fallsBack = (label: string, raw: string, m: GameMap = map): void => {
    store.clear();
    store.set(KEY, raw);
    const rig = new CameraRig(m);
    const restored = restoreView(rig, m);
    const atDefault = near(rig.target.x, want.x, 1) && near(rig.target.y, want.y, 1);
    check(label, restored === false && (m === map ? atDefault : true));
  };
  fallsBack("rejects malformed JSON", "{not json");
  fallsBack("rejects a non-object", '"hello"');
  fallsBack("rejects missing fields", '{"map":"portland","lat":45.5}');
  fallsBack("rejects NaN", '{"map":"portland","lat":null,"lon":-122.6,"viewHeight":90,"theta":0,"tilt":1}');
  fallsBack(
    "rejects a position outside the map",
    '{"map":"portland","lat":10,"lon":10,"viewHeight":90,"theta":0,"tilt":1}',
  );
  fallsBack(
    "rejects a view saved for a different map",
    '{"map":"portland","lat":45.5,"lon":-122.6,"viewHeight":90,"theta":0,"tilt":1}',
    other,
  );
}

// 4. Absurd zoom is clamped rather than trusted.
{
  store.clear();
  store.set(KEY, '{"map":"portland","lat":45.5,"lon":-122.6,"viewHeight":1e9,"theta":0,"tilt":1}');
  const rig = new CameraRig(map);
  restoreView(rig, map);
  check("clamps an out-of-range zoom", rig.viewHeight <= 12000, `viewHeight=${rig.viewHeight}`);
}

// 5. Unchanged view doesn't rewrite storage.
{
  store.clear();
  const rig = new CameraRig(map);
  restoreView(rig, map);
  const save = createViewSaver(rig, map);
  save();
  const first = store.get(KEY);
  store.delete(KEY);
  save();
  check("skips the write when nothing moved", store.get(KEY) === undefined, first ? "" : "no first write");
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
