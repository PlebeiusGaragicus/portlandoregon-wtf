# Hosting: the game on GitHub Pages

**<https://portlandoregon.wtf/>** — served entirely by GitHub Pages, with no
server involved. The city is a static asset (see `scripts/stage-map.sh`), so
nothing is fetched from a backend at runtime.

The game owns that domain outright: its apex `A`/`AAAA` records point at GitHub
Pages' IPs, and the publishing fork claims it as its custom domain. GitHub
doesn't own the domain; the DNS records delegate it.

The claim lives in the fork's Pages settings — server-side, not in the build.
`gh api repos/abvstudio-net/battle-juice/pages` reports it as `cname`, and that
setting is what the Pages edge resolves an incoming `Host` header against.
**There is deliberately no `CNAME` file in the build.** Under Actions-based
publishing GitHub ignores one outright ("no `CNAME` file is created, and any
existing `CNAME` file is ignored and is not required" — *Managing a custom
domain for your GitHub Pages site*). The widespread advice to commit one is
about *branch*-based publishing, where the domain really is stored as a file at
the root of the publishing branch, which is why deploy tools that rewrite
`gh-pages` keep clobbering people's domains. That failure mode cannot happen
here. If publishing ever moves to a branch source, the file becomes mandatory.

The client builds with `base: './'` (relative asset URLs), which works at a
domain root and at a sub-path alike. An absolute base deploys green and then
404s on its own JavaScript.

### Previously: the inherited internal.invalid URL

Before the domain, the game published at `internal.invalid/battle-juice/`, inherited
rather than configured: `internal.invalid`'s apex records point at Pages, the
`abvstudio-net` account's *user-site* repo claims it, and every project site on
that account with no custom domain of its own is published beneath it. Setting
one here opted this repo out of that inheritance — and only this repo; sibling
project sites on the account still publish under `internal.invalid/<repo>/`. The
old URL still resolves: GitHub 301s `internal.invalid/battle-juice/` to the new
domain rather than 404ing it.

A dedicated subdomain (`play.internal.invalid`) was tried before that and dropped:
it needed its own DNS record to beat the wildcard, to end up at a URL no better
than the inherited one.

## Two repos: develop here, publish from the fork

This repo (`PlebeiusGaragicus/battle-juice`) is where the game is developed and
has **GitHub Pages disabled**. `abvstudio-net/battle-juice` is a fork with Pages
enabled; it is the copy that serves `portlandoregon.wtf`. The fork is only ever
fast-forwarded — never commit to it directly.

Why: a GitHub project site with no custom domain inherits its account's
user-site domain, and this account's is `internal.invalid`. Publishing from the
abvstudio fork kept the game off the the other project domain without a per-repo
workaround. The custom domain now settles the URL either way, but the split
stays: Pages is off here, so development pushes never publish. Full rationale in
the deployment repo's `docs/github-publishing.md`.

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
comma-separated `ALLOWED_ORIGINS` env var). **`portlandoregon.wtf` is not in it
yet** — add it there, or via `ALLOWED_ORIGINS`, before the first multiplayer
build, or every socket from the published game gets a 401:

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
4. On the **fork**: Pages → Custom domain → `portlandoregon.wtf`, then tick
   *Enforce HTTPS* once the certificate issues (minutes to an hour after DNS
   resolves).

## DNS: portlandoregon.wtf

Registered at Namecheap, on Namecheap BasicDNS. Under *Domain → Advanced DNS*,
the parking records it ships with (`CNAME www → parkingpage`, the URL-redirect
record) are deleted and replaced with:

| Type  | Host | Value                       |
| ----- | ---- | --------------------------- |
| A     | `@`  | `185.199.108.153`           |
| A     | `@`  | `185.199.109.153`           |
| A     | `@`  | `185.199.110.153`           |
| A     | `@`  | `185.199.111.153`           |
| AAAA  | `@`  | `2606:50c0:8000::153`       |
| AAAA  | `@`  | `2606:50c0:8001::153`       |
| AAAA  | `@`  | `2606:50c0:8002::153`       |
| AAAA  | `@`  | `2606:50c0:8003::153`       |
| CNAME | `www`| `abvstudio-net.github.io.`  |

The four `A` records are GitHub's anycast Pages IPs; all four are listed so the
apex survives one going away. The `AAAA` set is the IPv6 equivalent and is
optional. The `www` `CNAME` points at the *account*, not the repo — Pages routes
by the `CNAME` file in the artifact, and `www.portlandoregon.wtf` then redirects
to the apex.

Changing the domain means editing these records and the Pages custom domain on
the fork together; either alone breaks the site.
