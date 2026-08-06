// WGS84 <-> the map's local metres frame.
//
// Equirectangular around the map origin: a few metres off the extraction
// pipeline's UTM projection over a district-sized area, which is fine for
// naming places and restoring a camera position. Don't use it for anything
// that has to agree with the pipeline to the metre.

import type { MapMeta } from "./map.js";

const METRES_PER_DEG_LON_EQUATOR = 111320;

export interface LatLon {
  lat: number;
  lon: number;
}

/** Metres per degree of latitude on WGS84, which grows from ~110.57 km at the
 * equator to ~111.69 km at the poles. Using a single constant (110574, the
 * equatorial value) misplaces a mid-latitude city by ~0.5% — 100 m over a
 * 20 km map, enough to land on the wrong block. */
function metresPerDegLat(latDeg: number): number {
  const p = (latDeg * Math.PI) / 180;
  return 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p) - 0.0023 * Math.cos(6 * p);
}

/** One scale for the whole map, taken at its centre latitude, so the forward
 * and inverse conversions are exact inverses. Across a district-sized map the
 * true value varies by well under a metre per degree. */
function latScale(meta: MapMeta): number {
  const centreLat = meta.origin.lat + meta.height / 2 / 111132;
  return metresPerDegLat(centreLat);
}

/** WGS84 -> world metres (x east, y north, origin at the map's SW corner).
 *
 * Equirectangular about the map origin. The extraction pipeline projects with
 * UTM, so expect metre-scale disagreement — fine for placing a camera or
 * naming a spot, not for anything that must match the pipeline exactly. */
export function latLonToWorld(meta: MapMeta, pos: LatLon): { x: number; y: number } {
  return {
    x: (pos.lon - meta.origin.lon) * METRES_PER_DEG_LON_EQUATOR * Math.cos((pos.lat * Math.PI) / 180),
    y: (pos.lat - meta.origin.lat) * latScale(meta),
  };
}

/** World metres -> WGS84. Exact inverse of {@link latLonToWorld}. */
export function worldToLatLon(meta: MapMeta, x: number, y: number): LatLon {
  const lat = meta.origin.lat + y / latScale(meta);
  return {
    lat,
    lon: meta.origin.lon + x / (METRES_PER_DEG_LON_EQUATOR * Math.cos((lat * Math.PI) / 180)),
  };
}

/** True when a world point lies inside the play area. */
export function withinMap(meta: MapMeta, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x <= meta.width && y <= meta.height;
}
