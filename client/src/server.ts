// Where the game server lives.
//
// Empty (the default) means same-origin: in dev that's Vite proxying /ws, /map
// and /heightmap to localhost, and in the deployment-served build it's the game
// server hosting client/dist itself. The GitHub Pages build is the odd one out
// — it is served from play.internal.invalid but must talk to game.internal.invalid —
// so CI bakes VITE_SERVER_ORIGIN in at build time.
const ORIGIN = (import.meta.env.VITE_SERVER_ORIGIN ?? "").trim().replace(/\/+$/, "");

/** Absolute URL for an HTTP endpoint (`/map`, `/heightmap`). */
export function apiUrl(path: string): string {
  return `${ORIGIN}${path}`;
}

/** Absolute URL for a WebSocket endpoint, https→wss and http→ws. */
export function wsUrl(path: string): string {
  return `${ORIGIN || location.origin}`.replace(/^http/, "ws") + path;
}
