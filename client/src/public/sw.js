// Service worker: enough to make this installable and to survive a cold
// start with no network. Not a caching framework.
//
// It deliberately does NOT touch /map/. The city is cached by mapcache.ts,
// which invalidates against assets.json digests; a second, dumber cache-first
// layer underneath that would happily serve geometry the page has already
// decided is stale. One owner per asset class.
//
// Scope note: this file is served from the site root, so its scope is the
// whole origin. It only ever answers for same-origin GETs it recognises.

const SHELL = "pdx-shell-v1";

/** Enough to boot to a loading screen offline. The hashed JS bundle is not
 * listed — its filename changes every build — so it is cached on first use
 * instead, below. */
const SHELL_URLS = ["./", "./index.html", "./loading-city-v1.webp", "./manifest.webmanifest"];

/** Hashed build assets to keep. Filenames are content-addressed, so old ones
 * are dead weight the moment a deploy lands; a cap sheds them without having
 * to know which build is current. Cache.keys() returns insertion order, so
 * the oldest is simply the first. */
const MAX_BUILD_ASSETS = 24;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      // Individually, so one 404 does not fail the whole install.
      .then((cache) => Promise.allSettled(SHELL_URLS.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      // Leave the city cache alone — it is not ours and it is 40 MB the user
      // would otherwise re-download because a shell version changed.
      .then((names) => Promise.all(names.filter((n) => n.startsWith("pdx-shell-") && n !== SHELL).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

async function trimBuildAssets(cache) {
  const keys = await cache.keys();
  const builds = keys.filter((request) => request.url.includes("/assets/"));
  for (const request of builds.slice(0, Math.max(0, builds.length - MAX_BUILD_ASSETS))) {
    await cache.delete(request);
  }
}

/** Cache first: only for content-addressed URLs, where a hit can never be
 * stale because a change would have changed the filename. */
async function fromCacheFirst(request) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
    await trimBuildAssets(cache);
  }
  return response;
}

/** Network first: for the document, which is NOT content-addressed. Serving a
 * cached index.html by preference would pin visitors to whichever build they
 * first saw, forever. */
async function fromNetworkFirst(request) {
  const cache = await caches.open(SHELL);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put("./index.html", response.clone());
    return response;
  } catch (err) {
    const hit = (await cache.match(request)) ?? (await cache.match("./index.html"));
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // The city belongs to mapcache.ts. Not ours to answer.
  if (url.pathname.includes("/map/")) return;

  if (request.mode === "navigate") {
    event.respondWith(fromNetworkFirst(request));
    return;
  }
  if (url.pathname.includes("/assets/") || /\.(?:webp|png|webmanifest|ico|svg)$/.test(url.pathname)) {
    event.respondWith(fromCacheFirst(request));
  }
});
