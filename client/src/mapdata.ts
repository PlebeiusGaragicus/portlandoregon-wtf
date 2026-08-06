// Loading the city from static assets, so the game needs no server.
//
// The map ships with the site (staged by scripts/stage-map.sh into
// src/public/map/, which Vite publishes). Paths are relative so they resolve
// whether the site is mounted at a domain root or at /battle-juice/.

import {
  decodeBuildings,
  decodeHeightfield,
  decodeProps,
  type BuildingStore,
  type GameMap,
  type PropStore,
  type Heightfield,
} from "@battle-juice/shared";

// Baked by scripts/bake-map.ts: buildings split out of the JSON into a binary
// store, everything else left as map-lite.
const MAP_URL = new URL("./map/map-lite.json.gz", document.baseURI).href;
const BUILDINGS_URL = new URL("./map/buildings.bin.gz", document.baseURI).href;
const PROPS_URL = new URL("./map/props.bin.gz", document.baseURI).href;
const HEIGHTMAP_URL = new URL("./map/heightmap.bin.gz", document.baseURI).href;

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
  const res = await fetch(url);
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
    return map;
  } catch (err) {
    if (err instanceof MapUnavailableError) throw err;
    // Network-level failure: offline, or the asset never got deployed.
    throw new MapUnavailableError(`couldn't download the map (${String(err)})`);
  }
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

/** Terrain is optional — a missing heightmap means flat ground, not a failure. */
export async function loadHeightfield(onProgress?: Progress): Promise<Heightfield | null> {
  try {
    return decodeHeightfield(await (await openGzipped(HEIGHTMAP_URL, onProgress)).arrayBuffer());
  } catch {
    return null;
  }
}
