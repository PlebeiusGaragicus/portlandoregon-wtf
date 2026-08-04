# Agent Guide — battle-juice

Battle Juice is a multiplayer real-time strategy game about urban combat,
hosted on a personal deployment. The deployment acts as the game "server"; remote
clients (browsers) connect over the internet through the deployment's public VPS
gateway. Gameplay, netcode, and stack decisions live in `docs/design.md` —
read it before touching game logic.

## Reference infrastructure repo

The deployment that hosts this game is documented in a separate repo:

- Local path: `../infra`
- It is the source of truth for VPS config (reverse proxy, VPN, rate limiting), Mac
  Mini Docker stacks, DNS, and networking. Consult it before making any
  assumptions about hosting, ports, or domains.

Deployment summary (see that repo's `README.md` and `docs/` for detail):

- **VPS** (`gateway`, VPS provider) — reverse proxy reverse proxy, rate limiting, firewall; the only
  public-facing machine. All `*.internal.invalid` traffic enters here.
- **app host** (`app-host`, Linux, VPN `10.0.0.20`) — runs
  self-hosted services via Docker Compose (git service, relay, notifications). The likely
  host for the game server process.
- **inference host** (redacted, VPN `10.0.0.10`) — inference server inference at
  `https://api.internal.invalid`.
- **VPN** — tunnel between VPS and home machines. Game clients do NOT
  join the VPN; they reach the game through the VPS reverse proxy.

## Hosting plan

- Public URL: `game.internal.invalid` (reverse proxy on the VPS proxies to the game server
  on the app host over VPN).
- Auth model: shared password. Clients present a password to join; no per-user
  accounts. TLS is terminated by reverse proxy, so the password is never sent in the
  clear.

## Working principles

- Deployment changes (reverse proxy blocks, DNS, Docker Compose) belong in the
  `infra` repo, following its conventions; game code lives here.
- Never commit secrets: the game password, `.env` files, keys. Keep sanitized
  `.env.sample` files instead.
- Do not run remote deploy commands against the live deployment unless explicitly
  asked.
- `CLAUDE.md` is a symlink to this file — edit `AGENTS.md` only.
