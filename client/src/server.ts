// Where the game server lives.
//
// Only live game traffic (the WebSocket) uses this — the map is a static asset
// now, so the published spectator build talks to no server at all.
//
// Empty (the default) means same-origin: in dev that's Vite proxying /ws to
// localhost. The Pages build is the odd one out — it is served from
// internal.invalid but any game server lives elsewhere — so CI bakes
// VITE_SERVER_ORIGIN in at build time.
const ORIGIN = (import.meta.env.VITE_SERVER_ORIGIN ?? "").trim().replace(/\/+$/, "");

/** Absolute URL for an HTTP endpoint (`/map`, `/heightmap`). */
export function apiUrl(path: string): string {
  return `${ORIGIN}${path}`;
}

/** Absolute URL for a WebSocket endpoint, https→wss and http→ws. */
export function wsUrl(path: string): string {
  return `${ORIGIN || location.origin}`.replace(/^http/, "ws") + path;
}
