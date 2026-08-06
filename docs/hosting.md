# Hosting: the game on GitHub Pages

**<https://internal.invalid/battle-juice/>** — served entirely by GitHub Pages,
with no server involved. The city is a static asset (see `scripts/stage-map.sh`),
so nothing is fetched from a backend at runtime.

How that URL works, since it surprises people: `internal.invalid`'s apex `A`
records point at GitHub Pages' IPs, and the `abvstudio-net` account's user-site
repo claims `internal.invalid` as its custom domain. Every *project* site on that
account is then published beneath it, so `abvstudio-net.github.io/battle-juice/`
301-redirects to `internal.invalid/battle-juice/`. GitHub doesn't own the domain —
the DNS records delegate it.

Because the site lives at a sub-path, the client builds with `base: './'`
(relative asset URLs). An absolute base deploys green and then 404s on its own
JavaScript.

There is deliberately no dedicated subdomain. `play.internal.invalid` was tried and
dropped: it needed its own DNS record to beat the wildcard, plus a `CNAME` file
in the build, to end up at a URL no better than the inherited one.

## Two repos: develop here, publish from the fork

This repo (`PlebeiusGaragicus/battle-juice`) is where the game is developed and
has **GitHub Pages disabled**. `abvstudio-net/battle-juice` is a fork with Pages
enabled; it is the copy that serves `internal.invalid/battle-juice/`. The fork is
only ever fast-forwarded — never commit to it directly.

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
cross-origin `https://`, so the server must be behind a valid cert with
WebSocket upgrade proxying. None of this is exercised yet — the published game
is spectator-only and talks to no server at all.

## Cross-origin access

Only relevant once multiplayer returns. `server/src/index.ts` keeps an origin
allowlist (`internal.invalid`, `game.internal.invalid`, any localhost, plus a
comma-separated `ALLOWED_ORIGINS` env var):

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

**No DNS record is needed.** The fork inherits `internal.invalid` from its
account's user site and publishes at `internal.invalid/battle-juice/`. There is
deliberately no `CNAME` file in the build: adding one would claim a custom
domain for this repo alone and break the inherited URL.
