// Landmark fetch — Portland Fire & Rescue stations.
//
// Coordinates come from the city's official Fire Stations point layer
// (portlandmaps.com ArcGIS, the same host as the core extraction). The layer
// is regional, so we filter to the PF&R district. Each row is cross-checked
// against OSM amenity=fire_station (Overpass) — a disagreement over 60 m is
// a warning, not a failure: OSM is the independent second opinion, not the
// source. Writes data/landmarks.json (committed, ~31 rows).
//
// Run: npm run scrape-landmarks -w tools/map-extract
import { writeFileSync } from "node:fs";
import { LANDMARKS_FILE, USER_AGENT } from "./config.js";
import type { LandmarkSource } from "./landmarks.js";

const FIRE_LAYER =
  "https://www.portlandmaps.com/arcgis/rest/services/Public/Public_Safety_Places/MapServer/0/query";
/** Prefix, not exact: Station 31 is districted "PORTLAND/GRESHAM - SHARED".
 * Still excludes non-PF&R rows like the Port of Portland's station. */
const FIRE_DISTRICT_PREFIX = "PORTLAND";
const STATION_URL = (n: number): string => `https://www.portland.gov/fire/station-${n}`;

const OVERPASS = "https://overpass-api.de/api/interpreter";
/** Scraped-vs-OSM disagreement that earns a warning. */
const OSM_WARN_M = 60;

interface ArcGisPointQuery {
  features: { attributes: Record<string, string | null>; geometry: { x: number; y: number } }[];
}

async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, { ...init, headers: { "user-agent": USER_AGENT, ...init?.headers } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function fetchStations(): Promise<LandmarkSource[]> {
  const params = new URLSearchParams({
    where: `DISTRICT LIKE '${FIRE_DISTRICT_PREFIX}%'`,
    outFields: "STATION,ADDRESS,CITY",
    returnGeometry: "true",
    outSR: "4326",
    f: "json",
  });
  const data = (await getJson(`${FIRE_LAYER}?${params}`)) as ArcGisPointQuery;
  const out = new Map<number, LandmarkSource>();
  for (const f of data.features) {
    const digits = /\d+/.exec(f.attributes["STATION"] ?? "");
    if (!digits) {
      console.warn(`  skipped row with unparseable STATION: ${JSON.stringify(f.attributes)}`);
      continue;
    }
    const n = Number(digits[0]);
    if (out.has(n)) {
      console.warn(`  duplicate station ${n} in layer, keeping first`);
      continue;
    }
    out.set(n, {
      kind: "fire-station",
      ref: String(n),
      label: `Station ${n}`,
      name: `Portland Fire Station ${n}`,
      address: `${titleCase(f.attributes["ADDRESS"] ?? "")}, ${titleCase(f.attributes["CITY"] ?? "Portland")}, OR`,
      lat: f.geometry.y,
      lon: f.geometry.x,
      source: STATION_URL(n),
    });
  }
  return [...out.values()].sort((a, b) => Number(a.ref) - Number(b.ref));
}

/** "55 SW ASH ST" -> "55 SW Ash St" (directionals stay upper, 122ND -> 122nd). */
function titleCase(s: string): string {
  return s
    .trim()
    .split(/\s+/)
    .map((w) => {
      if (/^[NSEW]{1,2}$/.test(w) || /\d/.test(w[0] ?? "")) {
        return /^\d+(ST|ND|RD|TH)$/.test(w) ? w.toLowerCase() : w;
      }
      return w[0]! + w.slice(1).toLowerCase();
    })
    .join(" ");
}

/** Independent second opinion: distance from each station to the nearest OSM
 * fire station. Network trouble degrades to a notice — the check is advisory. */
async function crossCheckOsm(stations: LandmarkSource[]): Promise<void> {
  interface OverpassResult {
    elements: { type: string; lat?: number; lon?: number; center?: { lat: number; lon: number } }[];
  }
  let osm: OverpassResult;
  try {
    const query =
      "[out:json][timeout:60];(" +
      'way["amenity"="fire_station"](45.33,-122.86,45.65,-122.3);' +
      'relation["amenity"="fire_station"](45.33,-122.86,45.65,-122.3);' +
      'node["amenity"="fire_station"](45.33,-122.86,45.65,-122.3);' +
      ");out center;";
    osm = (await getJson(OVERPASS, {
      method: "POST",
      body: new URLSearchParams({ data: query }),
    })) as OverpassResult;
  } catch (err) {
    console.warn(`OSM cross-check skipped (${err instanceof Error ? err.message : err})`);
    return;
  }
  const points = osm.elements
    .map((e) => e.center ?? (e.lat !== undefined ? { lat: e.lat, lon: e.lon! } : undefined))
    .filter((p): p is { lat: number; lon: number } => p !== undefined);
  let warned = 0;
  for (const s of stations) {
    let best = Infinity;
    for (const p of points) {
      const dx = (s.lon - p.lon) * Math.cos((s.lat * Math.PI) / 180) * 111320;
      const dy = (s.lat - p.lat) * 111320;
      best = Math.min(best, Math.hypot(dx, dy));
    }
    if (best > OSM_WARN_M) {
      warned++;
      console.warn(`  ${s.label}: ${Math.round(best)} m from nearest OSM fire station — verify`);
    }
  }
  console.log(`OSM cross-check: ${points.length} OSM stations, ${warned} warnings`);
}

const stations = await fetchStations();
console.log(`official layer: ${stations.length} PF&R stations`);
await crossCheckOsm(stations);

writeFileSync(
  LANDMARKS_FILE,
  JSON.stringify(
    { source: FIRE_LAYER, scrapedAt: new Date().toISOString().slice(0, 10), landmarks: stations },
    null,
    2,
  ) + "\n",
);
console.log(`wrote ${LANDMARKS_FILE} (${stations.length} landmarks)`);
