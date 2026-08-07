// Loading the city from static assets, so the game needs no server.
//
// The map ships with the site (staged by scripts/stage-map.sh into
// src/public/map/, which Vite publishes). Paths are relative so they resolve
// whether the site is mounted at a domain root or at a sub-path.

import {
  decodeBuildings,
  decodeCityLod,
  decodeHeightfield,
  decodeLayers,
  decodeProps,
  decodeStreets,
  type BuildingStore,
  type CityLod,
  type GameMap,
  type LayerStores,
  type PropStore,
  type StreetStore,
  type Heightfield,
} from "@portlandoregon/shared";
import { NO_CACHE, type CityCache } from "./mapcache.js";
import {
  OVERVIEW_ATLAS_MANIFEST,
  parseOverviewAtlasManifest,
  type OverviewAtlasSource,
} from "./overview-atlas.js";

/** Where map bytes come from. Module-level because every loader below wants
 * it and none of them is called more than once per boot; main.ts installs the
 * real cache before the first load and it is never swapped again. Left as
 * NO_CACHE, everything here behaves exactly as it did before the cache. */
let cityCache: Pick<CityCache, "fetch"> = NO_CACHE;

export function setCityCache(cache: Pick<CityCache, "fetch">): void {
  cityCache = cache;
}

/** The directory the map artifacts live in — also the base the cache keys on,
 * so both sides agree on the URLs without either one building them twice. */
export const MAP_BASE_URL = new URL("./map/", document.baseURI);

// Baked by scripts/bake-map.ts: buildings split out of the JSON into a binary
// store, everything else left as map-lite.
const MAP_URL = new URL("./map/map-lite.json.gz", document.baseURI).href;
const BUILDINGS_URL = new URL("./map/buildings.bin.gz", document.baseURI).href;
const PROPS_URL = new URL("./map/props.bin.gz", document.baseURI).href;
const STREETS_URL = new URL("./map/streets.bin.gz", document.baseURI).href;
const LAYERS_URL = new URL("./map/layers.bin.gz", document.baseURI).href;
const HEIGHTMAP_URL = new URL("./map/heightmap.bin.gz", document.baseURI).href;
const CITY_LOD_URL = new URL("./map/city-lod.bin.gz", document.baseURI).href;
const OVERVIEW_ATLAS_URL = new URL(`./map/${OVERVIEW_ATLAS_MANIFEST}`, document.baseURI);

/** Thrown when the map asset itself is missing or unreadable — without it
 * there is no city to render, so this is fatal rather than retryable. */
export class MapUnavailableError extends Error {}

/** A response whose body is plain bytes, decompressing on the fly if needed.
 *
 * Who decompresses depends on the host. A static host (GitHub Pages, `python -m
 * http.server`) serves a `.gz` file verbatim, so the bytes arrive still gzipped
 * and we inflate them here. A host that sets `Content-Encoding: gzip` has the
 * browser inflate them first, and the body is already plain. Sniffing the gzip
 * magic number handles both without caring which one we're talking to.
 *
 * Everything stays a stream: the map inflates to hundreds of megabytes, and
 * buffering that as an ArrayBuffer and again as a string — before parsing —
 * pins the main thread and spikes memory on weaker machines. */
/** Download reporter: called with bytes-so-far and the total when the server
 * declared one (0 when it didn't). Lets the boot console show a real transfer
 * rate instead of one frozen "downloading…" line for 32 MB. */
export type Progress = (received: number, total: number) => void;

async function openGzipped(url: string, onProgress?: Progress): Promise<Response> {
  const res = await cityCache.fetch(url);
  if (!res.ok) throw new MapUnavailableError(`${url} → ${res.status}`);
  if (!res.body) throw new MapUnavailableError(`${url} → empty response`);
  const total = Number(res.headers.get("content-length") ?? 0);
  let received = 0;

  // Peek at the first chunk, then re-emit it ahead of the rest. Deliberately
  // NOT body.tee(): a tee whose second branch isn't drained buffers the whole
  // response in memory, which for a 147 MB map means holding it twice and
  // thrashing GC through everything that follows.
  const reader = res.body.getReader();
  const first = await reader.read();
  const head = first.value ?? new Uint8Array();
  const isGzip = head[0] === 0x1f && head[1] === 0x8b;

  const source = new ReadableStream({
    start(controller) {
      if (first.value) {
        received += first.value.byteLength;
        onProgress?.(received, total);
        controller.enqueue(first.value);
      }
      if (first.done) controller.close();
    },
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) {
        controller.close();
      } else {
        received += value.byteLength;
        onProgress?.(received, total);
        controller.enqueue(value);
      }
    },
    cancel(reason) {
      void reader.cancel(reason);
    },
  });

  return new Response(isGzip ? source.pipeThrough(new DecompressionStream("gzip")) : source);
}

export async function loadMap(onProgress?: Progress): Promise<GameMap> {
  try {
    // Response.json() parses straight off the stream — no intermediate string.
    const map = (await (await openGzipped(MAP_URL, onProgress)).json()) as GameMap;
    // map-lite carries no buildings — those arrive as a binary store. Keeping
    // the field present but empty means nothing has to null-check it.
    if (!map.buildings) map.buildings = [];
    if (!map.props) map.props = [];
    if (!map.nodes) map.nodes = [];
    if (!map.edges) map.edges = [];
    return map;
  } catch (err) {
    if (err instanceof MapUnavailableError) throw err;
    // Network-level failure: offline, or the asset never got deployed.
    throw new MapUnavailableError(`couldn't download the map (${String(err)})`);
  }
}

/**
 * Optional full-city overview assets. Unlike loadMap, failure is deliberately
 * not promoted to MapUnavailableError: the tactical renderer has its own
 * ground map and building tiers and remains fully usable without this atlas.
 */
export async function loadOverviewAtlas(): Promise<OverviewAtlasSource> {
  const response = await cityCache.fetch(OVERVIEW_ATLAS_URL.href);
  if (!response.ok) throw new Error(`${OVERVIEW_ATLAS_URL.href} → ${response.status}`);
  return {
    manifest: parseOverviewAtlasManifest(await response.json()),
    baseUrl: new URL(".", OVERVIEW_ATLAS_URL).href,
    // The atlas PNG is the single biggest asset in the city (19.8 MB at the
    // 4096 level), so it loads through the cache too. The renderer needs the
    // fetcher rather than the bytes: which level it wants depends on the GPU
    // limits it discovers later.
    fetch: (url: string) => cityCache.fetch(url),
  };
}

/**
 * The 538k building footprints, as a binary store rather than an object graph.
 *
 * This is the whole point of the split: parsing them as JSON cost ~820 MB of
 * heap, decoding them here costs 38 MB of typed arrays.
 */
export async function loadBuildings(onProgress?: Progress): Promise<BuildingStore> {
  try {
    const buf = await (await openGzipped(BUILDINGS_URL, onProgress)).arrayBuffer();
    return decodeBuildings(new Uint8Array(buf));
  } catch (err) {
    if (err instanceof MapUnavailableError) throw err;
    throw new MapUnavailableError(`${BUILDINGS_URL} unreachable`);
  }
}

/** The 405k decorative props, as flat arrays rather than 405k objects. */
export async function loadProps(onProgress?: Progress): Promise<PropStore> {
  try {
    const buf = await (await openGzipped(PROPS_URL, onProgress)).arrayBuffer();
    return decodeProps(new Uint8Array(buf));
  } catch (err) {
    if (err instanceof MapUnavailableError) throw err;
    throw new MapUnavailableError(`${PROPS_URL} unreachable`);
  }
}

/** Street graph and polylines as compact typed arrays. */
export async function loadStreets(onProgress?: Progress): Promise<StreetStore> {
  try {
    const buf = await (await openGzipped(STREETS_URL, onProgress)).arrayBuffer();
    return decodeStreets(new Uint8Array(buf));
  } catch (err) {
    if (err instanceof MapUnavailableError) throw err;
    throw new MapUnavailableError(`${STREETS_URL} unreachable`);
  }
}

export async function loadCityLod(onProgress?: Progress): Promise<CityLod> {
  try {
    const buf = await (await openGzipped(CITY_LOD_URL, onProgress)).arrayBuffer();
    return decodeCityLod(new Uint8Array(buf));
  } catch (err) {
    if (err instanceof MapUnavailableError) throw err;
    throw new MapUnavailableError(`${CITY_LOD_URL} unreachable`);
  }
}

/** Sidewalks, markings, trails, rails, water, parks — every render-only
 * vector layer, in one file so boot does not pay eight round trips. */
export async function loadLayers(onProgress?: Progress): Promise<LayerStores> {
  try {
    const buf = await (await openGzipped(LAYERS_URL, onProgress)).arrayBuffer();
    return decodeLayers(new Uint8Array(buf));
  } catch (err) {
    if (err instanceof MapUnavailableError) throw err;
    throw new MapUnavailableError(`${LAYERS_URL} unreachable`);
  }
}

/** Terrain is optional — a missing heightmap means flat ground, not a failure. */
export async function loadHeightfield(onProgress?: Progress): Promise<Heightfield | null> {
  try {
    return decodeHeightfield(await (await openGzipped(HEIGHTMAP_URL, onProgress)).arrayBuffer());
  } catch {
    return null;
  }
}
