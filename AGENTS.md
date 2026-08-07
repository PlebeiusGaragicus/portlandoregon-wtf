# Agent Guide — portlandoregon.wtf

portlandoregon.wtf is a multiplayer real-time strategy game about urban combat.
The published site is spectator-only and served entirely by GitHub Pages; live
multiplayer, when it returns, talks to a game server hosted separately.
Gameplay, netcode, and stack decisions live in `docs/design.md` — read it before
touching game logic. Hosting and publishing live in `docs/hosting.md`.

## Hosting plan

- Public URL: `portlandoregon.wtf` (GitHub Pages — see `docs/hosting.md`).
- The game server is deployed privately. Its address is supplied at build time
  via the `VITE_SERVER_ORIGIN` repo variable; nothing about the deployment
  target is recorded in this repo.
- Auth model: shared password. Clients present a password to join; no per-user
  accounts. TLS is terminated at the reverse proxy, so the password is never
  sent in the clear.

## Working principles

- Deployment and infrastructure configuration lives in a separate private repo,
  following its conventions; game code lives here. Do not record hostnames,
  addresses, or infrastructure topology in this repo.
- Never commit secrets: the game password, `.env` files, keys. Keep sanitized
  `.env.sample` files instead.
- Do not run remote deploy commands against live infrastructure unless
  explicitly asked.
- `CLAUDE.md` is a symlink to this file — edit `AGENTS.md` only.
