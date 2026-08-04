# battle-juice

A browser-based multiplayer real-time strategy game about urban combat, hosted
on a deployment (see `AGENTS.md` for infrastructure, `docs/design.md` for the
game design).

Current state: **walking skeleton** — password join, shared world, server-
authoritative 12 Hz simulation over WebSockets, click-to-move dots with
client-side interpolation.

## Requirements

- Node.js 22+

## Setup

```sh
npm install
cp .env.sample .env   # then set a real GAME_PASSWORD
```

## Development

```sh
npm run dev
```

Runs the game server (port 4000) and the Vite dev server together. Open the
Vite URL (printed in the terminal, usually `http://localhost:5173`) in **two
browser windows**, join both with the password from `.env`, and click around —
each window controls its own dot and sees the other's move.

Invite-link form: `http://localhost:5173/?join=<password>` pre-fills the
password field.

## Production

```sh
npm run build
npm start
```

Single Node process on `PORT` (default 4000): serves the built client and the
`/ws` WebSocket endpoint. Deployed behind reverse proxy at `game.internal.invalid`
(reverse-proxy config lives in the `infra` repo). `GET /healthz` for
monitoring.

## Layout

```
shared/   protocol types + pure deterministic simulation (no I/O)
server/   Node + ws: auth, room, tick loop, static client serving
client/   Vite + Canvas 2D: join form, net layer, interpolated renderer
docs/     game design
```
