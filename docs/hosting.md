# Hosting: GitHub Pages frontend + deployment game server

The game is split across two origins:

| Origin                        | Serves                                            | Who hosts it |
| ----------------------------- | ------------------------------------------------- | ------------ |
| `https://play.internal.invalid`  | the client bundle (static)                        | GitHub Pages |
| `https://game.internal.invalid`  | `/ws`, `/map`, `/heightmap` (+ a fallback client)  | deployment, via reverse proxy on the VPS |

The game server still serves `client/dist` itself, so `game.internal.invalid` alone
remains playable if Pages or DNS breaks, and `npm run build && npm start` stays
a complete local test of a production build.

## Branch flow

- Day-to-day work happens on `dev`.
- `dev` pushes and PRs into `main` run `.github/workflows/ci.yml` — typecheck
  every workspace, then build the client with the production server origin.
  Nothing is published.
- A merge into `main` runs `.github/workflows/deploy-pages.yml`, which builds
  `client/dist` and publishes it to Pages. `workflow_dispatch` re-deploys by
  hand without a new commit.

## How the client finds the server

`client/src/server.ts` reads `VITE_SERVER_ORIGIN` at build time.

- **Unset** (local dev, deployment-served build): same-origin. Vite's dev proxy
  forwards `/ws`, `/map` and `/heightmap` to the local game server; the
  deployment build is served by that same server. Unchanged from before Pages.
- **Set** (the Pages build): absolute URLs against that origin, with
  `https:` → `wss:` for the socket. CI sets it to `https://game.internal.invalid`;
  a `VITE_SERVER_ORIGIN` repo variable overrides it if the deployment moves.

Because Pages is HTTPS-only, the client always speaks `wss://` and
cross-origin `https://` — so `game.internal.invalid` must be live behind reverse proxy
with a valid cert and WebSocket upgrade proxying before the Pages site can get
past "contacting server…".

## Cross-origin access

`server/src/index.ts` keeps an origin allowlist (`play.internal.invalid`,
`game.internal.invalid`, any localhost, plus a comma-separated `ALLOWED_ORIGINS`
env var):

- `/map` and `/heightmap` echo the caller's origin in
  `Access-Control-Allow-Origin` when it's trusted — never `*`, since the game
  is password-gated. Untrusted origins get the response with no CORS header,
  which the browser refuses to hand to the page.
- The WebSocket upgrade is checked separately (`verifyClient`) and answers 401
  to unknown origins. WebSockets are exempt from CORS, so without this a page
  on any domain could open a socket; the shared password is still the real
  gate, this just closes the door earlier.

Requests with no `Origin` header (same-origin fetches, curl, non-browser
clients) are allowed through.

## One-time setup

On github.com (repo settings):

1. **Pages → Source: GitHub Actions.**
2. **Pages → Custom domain:** `play.internal.invalid`, then enable **Enforce
   HTTPS** once the cert is issued.
3. Create the `dev` branch; leave `main` as the default so PRs base against it.
4. Protect `main`: require a pull request, and require the `ci / check` status.

DNS (belongs in the `infra` repo, following its conventions):

```
CNAME  play.internal.invalid.  →  plebeiusgaragicus.github.io.
```

`client/src/public/CNAME` is copied into `dist` on every build — Pages clears
the custom domain on any deploy that lacks it, so don't delete that file.
