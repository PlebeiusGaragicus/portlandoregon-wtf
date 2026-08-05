# Hosting: GitHub Pages frontend + deployment game server

The game is split across two origins:

| Origin                        | Serves                                            | Who hosts it |
| ----------------------------- | ------------------------------------------------- | ------------ |
| `https://play.internal.invalid`  | the client bundle (static)                        | GitHub Pages |
| `https://game.internal.invalid`  | `/ws`, `/map`, `/heightmap` (+ a fallback client)  | deployment, via reverse proxy on the VPS |

The game server still serves `client/dist` itself, so `game.internal.invalid` alone
remains playable if Pages or DNS breaks, and `npm run build && npm start` stays
a complete local test of a production build.

## Two repos: develop here, publish from the fork

This repo (`PlebeiusGaragicus/battle-juice`) is where the game is developed and
has **GitHub Pages disabled**. `abvstudio-net/battle-juice` is a fork with Pages
enabled; it is the copy that serves `play.internal.invalid`. The fork is only ever
fast-forwarded — never commit to it directly.

Why: a GitHub project site inherits its account's user-site domain, and this
account's is `internal.invalid`. Publishing from the abvstudio fork keeps the game
off the the other project domain without a per-repo workaround. Full rationale in the
deployment repo's `docs/github-publishing.md`.

## Branch flow

- Day-to-day work happens on `dev`.
- `dev` pushes and PRs into `main` run `.github/workflows/ci.yml` — typecheck
  every workspace, then build the client with the production server origin.
  Nothing is published.
- `main` is the release branch. Publishing is a separate, deliberate step:

  ```sh
  ./scripts/release.sh --dry-run   # what would publish
  ./scripts/release.sh --watch     # publish and follow the deploy
  ```

  which fast-forwards the fork and triggers `deploy-pages.yml` **there**. That
  workflow is guarded with `if: github.repository == 'abvstudio-net/battle-juice'`
  so it never runs in this repo, where Pages is off.

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

On github.com:

1. On **this** repo: Pages disabled (done), `dev` branch created, `main` left as
   default. Protect `main`: require a pull request and the `ci / check` status.
2. On the **fork** (`abvstudio-net/battle-juice`): enable Actions — forks have
   them off by default and nothing deploys until you do — and set Pages →
   Source: **GitHub Actions**.
3. Give whoever runs `release.sh` push access to the fork; the development
   account has read-only access by default.

DNS (belongs in the `infra` repo, following its conventions):

```
CNAME  play.internal.invalid.  →  abvstudio-net.github.io.
```

The target is the **fork's** account. Without this record the fork publishes at
`internal.invalid/battle-juice/`, a sub-path, which breaks the `base: '/'` build.

`client/src/public/CNAME` is copied into `dist` on every build — Pages clears
the custom domain on any deploy that lacks it, so don't delete that file.
