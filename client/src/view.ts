// Where the camera sits, across visits.
//
// A first-time visitor opens on a fixed spot in Portland at full zoom-in.
// After that, wherever they left the camera is where they come back to.
//
// The saved position is WGS84 rather than world metres so it survives a map
// re-extraction moving the origin, and it carries the map name so a genuinely
// different map falls back to the default instead of restoring a position that
// means nothing there.

import { latLonToWorld, withinMap, worldToLatLon, type GameMap, type LatLon } from "@portlandoregon/shared";
import { MIN_VIEW_HEIGHT, type CameraRig } from "./render/camera.js";

const STORAGE_KEY = "bj.view.v1";

/** Where a new visitor starts: fully zoomed in on inner SE Portland. */
const DEFAULT_PLACE: LatLon = { lat: 45.50666, lon: -122.60496 };
const DEFAULT_VIEW_HEIGHT = MIN_VIEW_HEIGHT;

/** Compact WGS84 label shared by the HUD and its regression tests. */
export function formatLatLon(lat: number, lon: number): string {
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

interface SavedView {
  map: string;
  lat: number;
  lon: number;
  viewHeight: number;
  theta: number;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Storage is user-editable and survives code changes, so validate rather than
 * trust: a bad record should drop us at the default, never wedge the camera
 * somewhere off-map or at an impossible zoom. */
function parse(raw: string, map: GameMap): SavedView | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const s = v as Record<string, unknown>;
  if (s["map"] !== map.meta.name) return null;
  if (!isFiniteNumber(s["lat"]) || !isFiniteNumber(s["lon"])) return null;
  // `tilt` was a v1 field back when R/F could change the elevation angle. It
  // is fixed now, so records still carrying one restore fine without it.
  if (!isFiniteNumber(s["viewHeight"]) || !isFiniteNumber(s["theta"])) return null;
  const world = latLonToWorld(map.meta, { lat: s["lat"], lon: s["lon"] });
  if (!withinMap(map.meta, world.x, world.y)) return null;
  return {
    map: map.meta.name,
    lat: s["lat"],
    lon: s["lon"],
    // The upper bound is aspect- and rotation-dependent and belongs to the
    // rig. Keeping the v1 field unversioned preserves old 12 km saves.
    viewHeight: Math.max(MIN_VIEW_HEIGHT, s["viewHeight"]),
    theta: s["theta"],
  };
}

/** Point the rig at the visitor's last position, or at the default place.
 * Returns true when a saved view was restored. */
export function restoreView(rig: CameraRig, map: GameMap): boolean {
  let saved: SavedView | null = null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) saved = parse(raw, map);
  } catch {
    // Private browsing and blocked-storage modes throw on access.
    saved = null;
  }

  const place: LatLon = saved ?? DEFAULT_PLACE;
  const world = latLonToWorld(map.meta, place);
  const inBounds = withinMap(map.meta, world.x, world.y);

  rig.target = inBounds ? { x: world.x, y: world.y } : { x: map.meta.width / 2, y: map.meta.height / 2 };
  rig.viewHeight = saved?.viewHeight ?? DEFAULT_VIEW_HEIGHT;
  if (saved) rig.theta = saved.theta;
  rig.clampToMap(map);
  return saved !== null;
}

/** Persist the rig's position. Cheap enough to call often — it only writes
 * when something actually moved. */
export function createViewSaver(rig: CameraRig, map: GameMap): () => void {
  let lastSerialized = "";

  return function save(): void {
    const { lat, lon } = worldToLatLon(map.meta, rig.target.x, rig.target.y);
    const record: SavedView = {
      map: map.meta.name,
      // ~1e-5 degrees is roughly a metre — plenty, and it keeps the string
      // stable so unchanged views don't churn storage.
      lat: Number(lat.toFixed(5)),
      lon: Number(lon.toFixed(5)),
      viewHeight: Number(rig.viewHeight.toFixed(1)),
      theta: Number(rig.theta.toFixed(4)),
    };
    const serialized = JSON.stringify(record);
    if (serialized === lastSerialized) return;
    lastSerialized = serialized;
    try {
      localStorage.setItem(STORAGE_KEY, serialized);
    } catch {
      // Quota or blocked storage — losing the position is not worth breaking
      // the frame loop over.
    }
  };
}
