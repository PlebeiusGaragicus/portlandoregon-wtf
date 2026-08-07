# portlandoregon.wtf

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
cp .env.sample .env      # then set a real GAME_PASSWORD
./scripts/stage-map.sh   # put the city where the client can load it
```

`stage-map.sh` is required before the client will show anything. The map is
~30 MB gzipped and deliberately not in git, so it is staged into
`client/src/public/map/` from `data/maps/` — or downloaded from the map release
if you don't have the extracts locally. Without it the client loads and then
reports that it couldn't download the map.

Staging bakes and verifies the complete client payload: `buildings.bin.gz`,
`props.bin.gz`, `streets.bin.gz`, `layers.bin.gz`, `city-lod.bin.gz`, and
`map-lite.json.gz`, plus `heightmap.bin.gz` when terrain data is available.
Every present file is gunzipped and decoded with the shared runtime decoder
before staging succeeds. To rerun only that local release gate:

```sh
npm run verify:staged-map
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

The city itself needs no server — it is a static asset (see Setup). A cold load
is ~30 s, almost all of it `buildWorld` turning 538k buildings into geometry.
To measure that without a browser in the way:

```sh
npx tsx scripts/profile-world.ts
```

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
