// Landmark fetch — civic point layers, combined into data/landmarks.json.
//
//   fire-station  PF&R stations      portlandmaps Public_Safety_Places/0
//   police        PPB facilities     portlandmaps Public_Safety_Places/1
//   hospital      hospitals          portlandmaps Public_Safety_Places/2
//   city-hall     metro city halls   Metro OpenData/PlacesDataWebMerc/0
//
// Each kind is cross-checked against the matching OSM amenity via Overpass —
// a disagreement over 60 m is a warning, not a failure: OSM is the
// independent second opinion, not the source. The full survey of further
// candidate layers lives in docs/additional-landmarks.md.
//
// Run: npm run scrape-landmarks -w tools/map-extract
import { writeFileSync } from "node:fs";
import { LANDMARKS_FILE, PORTLAND_ENVELOPE, USER_AGENT } from "./config.js";
import type { LandmarkSource } from "./landmarks.js";

const SAFETY = "https://www.portlandmaps.com/arcgis/rest/services/Public/Public_Safety_Places/MapServer";
const METRO_PLACES = "https://gis.oregonmetro.gov/arcgis/rest/services/OpenData/PlacesDataWebMerc/MapServer";

/** Prefix, not exact: Station 31 is districted "PORTLAND/GRESHAM - SHARED".
 * Still excludes non-PF&R rows like the Port of Portland's station. */
const FIRE_DISTRICT_PREFIX = "PORTLAND";
const STATION_URL = (n: number): string => `https://www.portland.gov/fire/station-${n}`;

const OVERPASS = "https://overpass-api.de/api/interpreter";
/** Scraped-vs-OSM disagreement that earns a warning. */
const OSM_WARN_M = 60;
const RATE_MS = 350;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface ArcGisPointQuery {
  features: { attributes: Record<string, string | null>; geometry: { x: number; y: number } }[];
}

async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, { ...init, headers: { "user-agent": USER_AGENT, ...init?.headers } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function queryPoints(
  layerUrl: string,
  where: string,
  outFields: string,
  inBounds = false,
): Promise<ArcGisPointQuery> {
  const params = new URLSearchParams({
    where,
    outFields,
    returnGeometry: "true",
    outSR: "4326",
    f: "json",
  });
  if (inBounds) {
    const e = PORTLAND_ENVELOPE;
    params.set("geometry", `${e.xmin},${e.ymin},${e.xmax},${e.ymax}`);
    params.set("geometryType", "esriGeometryEnvelope");
    params.set("inSR", "4326");
    params.set("spatialRel", "esriSpatialRelIntersects");
  }
  await sleep(RATE_MS);
  return (await getJson(`${layerUrl}/query?${params}`)) as ArcGisPointQuery;
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

async function fetchFireStations(): Promise<LandmarkSource[]> {
  const data = await queryPoints(`${SAFETY}/0`, `DISTRICT LIKE '${FIRE_DISTRICT_PREFIX}%'`, "STATION,ADDRESS,CITY");
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

async function fetchPolice(): Promise<LandmarkSource[]> {
  const data = await queryPoints(`${SAFETY}/1`, "1=1", "name,address,city,agency");
  return data.features.map((f, i) => ({
    kind: "police" as const,
    ref: String(i + 1),
    label: titleCase(f.attributes["name"] ?? `Police ${i + 1}`),
    name: `Portland Police — ${titleCase(f.attributes["name"] ?? "")}`,
    address: `${titleCase(f.attributes["address"] ?? "")}, ${titleCase(f.attributes["city"] ?? "Portland")}, OR`,
    lat: f.geometry.y,
    lon: f.geometry.x,
    source: `${SAFETY}/1`,
  }));
}

async function fetchHospitals(): Promise<LandmarkSource[]> {
  const data = await queryPoints(`${SAFETY}/2`, "1=1", "NAME,ADDRESS,CITY");
  return data.features.map((f, i) => ({
    kind: "hospital" as const,
    ref: String(i + 1),
    label: titleCase(f.attributes["NAME"] ?? `Hospital ${i + 1}`),
    name: titleCase(f.attributes["NAME"] ?? ""),
    address: `${titleCase(f.attributes["ADDRESS"] ?? "")}, ${titleCase(f.attributes["CITY"] ?? "Portland")}, OR`,
    lat: f.geometry.y,
    lon: f.geometry.x,
    source: `${SAFETY}/2`,
  }));
}

/** Schools — the "lighter tier": hundreds of rows, so in-game they get a
 * muted building tint and close-zoom labels only (no glow, no minimap dot). */
async function fetchSchools(): Promise<LandmarkSource[]> {
  const data = await queryPoints(`${SAFETY}/3`, "1=1", "NAME,ADDRESS,CITY,LEVEL_NAME", true);
  return data.features
    .filter((f) => (f.attributes["NAME"] ?? "").trim().length > 0)
    .map((f, i) => ({
      kind: "school" as const,
      ref: String(i + 1),
      label: titleCase(f.attributes["NAME"] ?? ""),
      name: titleCase(f.attributes["NAME"] ?? ""),
      address: `${titleCase(f.attributes["ADDRESS"] ?? "")}, ${titleCase(f.attributes["CITY"] ?? "Portland")}, OR`,
      lat: f.geometry.y,
      lon: f.geometry.x,
      source: `${SAFETY}/3`,
    }));
}

async function fetchCityHalls(): Promise<LandmarkSource[]> {
  // The layer carries no name field — the label is derived from CITY.
  const data = await queryPoints(`${METRO_PLACES}/0`, "1=1", "ADDRESS,CITY,ZIPCODE");
  return data.features
    .filter((f) => (f.attributes["CITY"] ?? "").trim().length > 0)
    .map((f, i) => {
      const city = titleCase(f.attributes["CITY"] ?? "");
      return {
        kind: "city-hall" as const,
        ref: String(i + 1),
        label: `${city} City Hall`,
        name: `${city} City Hall`,
        address: `${titleCase(f.attributes["ADDRESS"] ?? "")}, ${city}, OR`,
        lat: f.geometry.y,
        lon: f.geometry.x,
        source: `${METRO_PLACES}/0`,
      };
    });
}

/** Independent second opinion per kind: distance from each landmark to the
 * nearest matching OSM amenity. Network trouble degrades to a notice. */
async function crossCheckOsm(kindLabel: string, amenity: string, rows: LandmarkSource[]): Promise<void> {
  if (rows.length === 0) return;
  interface OverpassResult {
    elements: { type: string; lat?: number; lon?: number; center?: { lat: number; lon: number } }[];
  }
  const e = PORTLAND_ENVELOPE;
  const bbox = `(${e.ymin - 0.1},${e.xmin - 0.1},${e.ymax + 0.1},${e.xmax + 0.1})`;
  let osm: OverpassResult;
  try {
    const query =
      `[out:json][timeout:60];(` +
      `way["amenity"="${amenity}"]${bbox};` +
      `relation["amenity"="${amenity}"]${bbox};` +
      `node["amenity"="${amenity}"]${bbox};` +
      `);out center;`;
    await sleep(RATE_MS);
    osm = (await getJson(OVERPASS, {
      method: "POST",
      body: new URLSearchParams({ data: query }),
    })) as OverpassResult;
  } catch (err) {
    console.warn(`OSM cross-check for ${kindLabel} skipped (${err instanceof Error ? err.message : err})`);
    return;
  }
  const points = osm.elements
    .map((el) => el.center ?? (el.lat !== undefined ? { lat: el.lat, lon: el.lon! } : undefined))
    .filter((p): p is { lat: number; lon: number } => p !== undefined);
  let warned = 0;
  for (const s of rows) {
    let best = Infinity;
    for (const p of points) {
      const dx = (s.lon - p.lon) * Math.cos((s.lat * Math.PI) / 180) * 111320;
      const dy = (s.lat - p.lat) * 111320;
      best = Math.min(best, Math.hypot(dx, dy));
    }
    if (best > OSM_WARN_M) {
      warned++;
      console.warn(`  ${s.label}: ${Math.round(best)} m from nearest OSM ${amenity} — verify`);
    }
  }
  console.log(`OSM cross-check (${kindLabel}): ${points.length} OSM features, ${warned} warnings`);
}

const fire = await fetchFireStations();
console.log(`fire stations: ${fire.length}`);
const police = await fetchPolice();
console.log(`police facilities: ${police.length}`);
const hospitals = await fetchHospitals();
console.log(`hospitals: ${hospitals.length}`);
const cityHalls = await fetchCityHalls();
console.log(`city halls: ${cityHalls.length}`);
const schools = await fetchSchools();
console.log(`schools: ${schools.length}`);

await crossCheckOsm("fire", "fire_station", fire);
await crossCheckOsm("police", "police", police);
await crossCheckOsm("hospitals", "hospital", hospitals);
await crossCheckOsm("city halls", "townhall", cityHalls);
// Schools: no OSM pass — 800+ rows would spam warnings for zero decisions.

const landmarks = [...fire, ...police, ...hospitals, ...cityHalls, ...schools];
writeFileSync(
  LANDMARKS_FILE,
  JSON.stringify(
    {
      source: `${SAFETY}/{0,1,2,3} + ${METRO_PLACES}/0`,
      scrapedAt: new Date().toISOString().slice(0, 10),
      landmarks,
    },
    null,
    2,
  ) + "\n",
);
console.log(`wrote ${LANDMARKS_FILE} (${landmarks.length} landmarks)`);
