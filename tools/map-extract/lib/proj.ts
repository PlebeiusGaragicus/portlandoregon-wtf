// WGS84 -> UTM zone 10N -> local meters frame (origin at the district's SW
// corner, x east, y north). The sim wants meters; degrees distort distance.
import proj4 from "proj4";
import { DISTRICT } from "../config.js";

const UTM10N = "+proj=utm +zone=10 +datum=WGS84 +units=m +no_defs";

export function toUtm(lon: number, lat: number): [number, number] {
  return proj4("WGS84", UTM10N, [lon, lat]) as [number, number];
}

const originUtm = toUtm(DISTRICT.xmin, DISTRICT.ymin);

/** WGS84 lon/lat -> local meters. */
export function toLocal(lon: number, lat: number): [number, number] {
  const [x, y] = toUtm(lon, lat);
  return [x - originUtm[0], y - originUtm[1]];
}

/** Play-area size in local meters (UTM is metric, so corners suffice). */
export function playArea(): { width: number; height: number } {
  const ne = toLocal(DISTRICT.xmax, DISTRICT.ymax);
  return { width: ne[0], height: ne[1] };
}

export function origin(): { lat: number; lon: number } {
  return { lat: DISTRICT.ymin, lon: DISTRICT.xmin };
}
