// Keeping the city on the device between visits.
//
// The map is ~46 MB across eleven files. GitHub Pages serves them with
// `cache-control: max-age=600`, which cannot be configured, so ten minutes
// after a visit the browser revalidates everything — and it only skips the
// bodies if the HTTP cache still happens to be holding 46 MB, which on a
// phone it usually is not. The result is a full cold load most visits.
//
// So the city is stored in Cache Storage instead, which is quota-backed
// rather than best-effort-evictable, and which we invalidate ourselves.
//
// Why Cache Storage and not IndexedDB: entries are `Response` objects, so a
// cache hit is still a stream. The download path in mapdata.ts inflates
// gzip through a DecompressionStream precisely to avoid holding the map in
// memory twice, and IndexedDB would force each artifact to be materialised
// as a Blob first. Cache Storage keeps that pipeline intact — hit and miss
// differ only in where the bytes come from.
//
// Freshness comes from map/assets.json (scripts/write-asset-manifest.ts): a
// small file fetched with no-store on every boot, listing every artifact's
// SHA-256. A digest that differs from the one we cached against evicts that
// one entry. Re-baking a single artifact therefore costs one re-download.
//
// Everything here is best-effort. No cache, a denied quota, a Safari private
// window, a failed write: all fall through to a plain fetch, and the game
// loads exactly as it did before any of this existed.

const CACHE_NAME = "pdx-city-v1";
/** Where the cached copy of the manifest lives. Not a real URL — a key, kept
 * distinct from the network URL so the two can never be confused. */
const STORED_MANIFEST_KEY = "https://city-cache.invalid/assets.json";

export interface AssetEntry {
  bytes: number;
  sha256: string;
}

export interface AssetManifest {
  version: number;
  generator: string;
  map: { name: string; sourceDate: string };
  files: Record<string, AssetEntry>;
}

function isManifest(value: unknown): value is AssetManifest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AssetManifest>;
  if (candidate.generator !== "portlandoregon-city-assets") return false;
  return Boolean(candidate.files) && typeof candidate.files === "object";
}

/** What happened during setup, for the boot log. Purely informational. */
export interface CityCacheReport {
  /** False when Cache Storage is unavailable or setup failed outright. */
  enabled: boolean;
  /** Artifacts already held that are still current. */
  fresh: number;
  /** Artifacts the published map consists of. `fresh` reaching this is not
   * the goal: only one overview atlas level is ever fetched, so a fully warm
   * cache still sits two short. */
  total: number;
  /** Bytes those artifacts account for, per the manifest. */
  freshBytes: number;
  /** Artifacts dropped because their digest moved (or they left the map). */
  evicted: string[];
  /** Granted persistent-mode storage, so eviction heuristics leave us alone. */
  persisted: boolean;
  /** Serving the stored city without having checked it against the network —
   * the manifest was unreachable. Offline, in other words. */
  stale: boolean;
  /** Why the cache is off, when it is. */
  detail: string;
}

export class CityCache {
  private constructor(
    private readonly cache: Cache | null,
    readonly report: CityCacheReport,
  ) {}

  /**
   * A cache that does nothing: every fetch goes to the network. Returned
   * whenever anything at all goes wrong, so callers never branch on it.
   */
  private static disabled(detail: string): CityCache {
    return new CityCache(null, {
      enabled: false,
      fresh: 0,
      total: 0,
      freshBytes: 0,
      evicted: [],
      persisted: false,
      stale: false,
      detail,
    });
  }

  /**
   * Open the cache and reconcile it with what is published now.
   *
   * `mapBaseUrl` is the directory the artifacts live in, so entries are keyed
   * by the same absolute URLs mapdata.ts fetches.
   */
  static async open(mapBaseUrl: URL): Promise<CityCache> {
    if (typeof caches === "undefined") {
      // Safari private browsing, and any insecure origin that is not
      // localhost. Nothing to do but download.
      return CityCache.disabled("Cache Storage unavailable");
    }

    // Persistent mode exempts the origin from eviction heuristics; WebKit
    // grants it to Home Screen web apps, Chromium to sites with engagement.
    // A denial costs nothing, so ask unconditionally and carry on.
    let persisted = false;
    try {
      persisted = (await navigator.storage?.persisted?.()) ?? false;
      if (!persisted) persisted = (await navigator.storage?.persist?.()) ?? false;
    } catch {
      /* unsupported, or a denial that threw — neither is actionable */
    }

    let cache: Cache;
    try {
      cache = await caches.open(CACHE_NAME);
    } catch (err) {
      return CityCache.disabled(`could not open the cache (${String(err)})`);
    }

    const stored = await CityCache.readStoredManifest(cache);

    // Published truth. Deliberately no-store: a cached manifest would be a
    // cache that can never notice it is stale.
    let published: AssetManifest;
    try {
      const res = await fetch(new URL("assets.json", mapBaseUrl), { cache: "no-store" });
      if (!res.ok) throw new Error(`assets.json → ${res.status}`);
      const parsed: unknown = await res.json();
      if (!isManifest(parsed)) throw new Error("assets.json is not a city manifest");
      published = parsed;
    } catch (err) {
      // Unreachable manifest usually means unreachable everything — this is
      // what being offline looks like from in here. Refusing to serve the
      // stored city because we could not confirm it is current would fail
      // precisely when the cache is the only thing that can help, and there
      // is nothing fresher to fall back to anyway. So serve it, reconcile
      // nothing, and say so.
      if (!stored) return CityCache.disabled(`no asset manifest (${String(err)})`);
      return CityCache.offline(cache, stored, mapBaseUrl, persisted);
    }

    const evicted: string[] = [];
    let fresh = 0;
    let freshBytes = 0;

    // Drop what moved BEFORE recording the new manifest: an interrupted
    // reconcile then leaves entries missing, which is a re-download, rather
    // than entries that lie about being current.
    for (const [name, entry] of Object.entries(published.files)) {
      const previous = stored?.files[name];
      const url = new URL(name, mapBaseUrl).href;
      if (previous?.sha256 === entry.sha256) {
        if (await cache.match(url)) {
          fresh += 1;
          freshBytes += entry.bytes;
          continue;
        }
        // Manifest says we have it, cache says otherwise — quota eviction
        // takes individual entries. Not an error, just a miss.
        continue;
      }
      if (previous || (await cache.match(url))) evicted.push(name);
      await cache.delete(url);
    }

    // Artifacts that left the map entirely (a renamed atlas level, say) would
    // otherwise sit in the quota forever.
    for (const request of await cache.keys()) {
      if (request.url === STORED_MANIFEST_KEY) continue;
      const name = decodeURIComponent(request.url.split("/").pop() ?? "");
      if (!(name in published.files)) {
        evicted.push(name);
        await cache.delete(request);
      }
    }

    try {
      await cache.put(STORED_MANIFEST_KEY, new Response(JSON.stringify(published)));
    } catch {
      /* the manifest write is an optimisation; a miss just re-downloads */
    }

    return new CityCache(cache, {
      enabled: true,
      fresh,
      total: Object.keys(published.files).length,
      freshBytes,
      evicted,
      persisted,
      stale: false,
      detail: `map "${published.map.name}" (${published.map.sourceDate})`,
    });
  }

  /** Offline: everything already stored, taken on trust. */
  private static async offline(
    cache: Cache,
    stored: AssetManifest,
    mapBaseUrl: URL,
    persisted: boolean,
  ): Promise<CityCache> {
    let fresh = 0;
    let freshBytes = 0;
    for (const [name, entry] of Object.entries(stored.files)) {
      if (await cache.match(new URL(name, mapBaseUrl).href)) {
        fresh += 1;
        freshBytes += entry.bytes;
      }
    }
    return new CityCache(cache, {
      enabled: true,
      fresh,
      total: Object.keys(stored.files).length,
      freshBytes,
      evicted: [],
      persisted,
      stale: true,
      detail: `map "${stored.map.name}" (${stored.map.sourceDate}), not checked for updates`,
    });
  }

  private static async readStoredManifest(cache: Cache): Promise<AssetManifest | null> {
    try {
      const res = await cache.match(STORED_MANIFEST_KEY);
      if (!res) return null;
      const parsed: unknown = await res.json();
      return isManifest(parsed) ? parsed : null;
    } catch {
      return null; // corrupt record — treat the cache as empty
    }
  }

  /**
   * Fetch, preferring the stored copy.
   *
   * The returned `Response` is unread either way, so callers stream it
   * exactly as they would a network response — including `content-length`,
   * which Cache Storage preserves, so download progress still reports a
   * total on a partial hit.
   */
  async fetch(url: string): Promise<Response> {
    if (!this.cache) return fetch(url);

    try {
      const hit = await this.cache.match(url);
      if (hit) return hit;
    } catch {
      /* fall through to the network */
    }

    const res = await fetch(url);
    // A 404 for the optional heightmap must not be stored as though it were
    // the artifact; only success is worth keeping.
    if (res.ok && this.cache) {
      // Not awaited: the caller wants to start inflating now, and the clone
      // drains in the background. An interrupted write is a miss next boot,
      // which is the same as not having written it.
      void this.cache.put(url, res.clone()).catch(() => {
        /* over quota, or evicted mid-write */
      });
    }
    return res;
  }
}

/** A cache that is always a miss, for callers that run before setup finishes
 * or when the caller has no cache to hand. */
export const NO_CACHE: Pick<CityCache, "fetch"> = { fetch: (url: string) => fetch(url) };
