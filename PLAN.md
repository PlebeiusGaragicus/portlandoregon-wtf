# Battle Juice — Development Plan

Phases are named, not numbered: they are not strictly linear, and new phases
get added as the project evolves. Each phase is a vertical slice — when it
lands, the game is playable end-to-end with the new capability, not half-wired.

Status legend: `done` · `next` · `planned` · `idea`

| Phase | Theme | Status |
|---|---|---|
| [Skeleton](#skeleton) | Prove the pipeline | done |
| [Streets](#streets) | Street graph + squads | next |
| [Firefight](#firefight) | Combat + win condition | planned |
| [Breadline](#breadline) | Airdrops + supply economy | planned |
| [Kettle](#kettle) | Encirclement mechanic | planned |
| [Keymaster](#keymaster) | Nostr keypair auth (NIP-98) | planned |
| [Go Live](#go-live) | Deploy to the deployment | planned |
| [War Paint](#war-paint) | Visual + UX polish | idea |
| [Fog](#fog) | Fog of war | idea |

---

## Skeleton

**Done.** The walking skeleton: shared-password join, one room, authoritative
12 Hz simulation over WebSockets, full-state snapshots, click-to-move dots
rendered at 60 fps with interpolation between the two most recent snapshots.

What it proved: the whole pipeline works — auth → room → fixed tick →
snapshot broadcast → smooth client rendering — and the architecture rule
holds (the sim in `shared/` is pure and deterministic, no I/O imports, so it
can later power bots, replays, and headless tests).

## Streets

**The map becomes real.** Everything later (combat, supply, encirclement)
operates on the street graph, so this is the foundational gameplay phase.

- ~~One hand-authored city map in `shared/`~~ **Done via `MAP-PLAN.md`:** the
  baked Portland map (`shared/src/maps/pearl.ts`) ships real nodes/edges/
  entries plus buildings and props, rendered in 3D (Three.js). This phase is
  now graph-constrained movement only.
- Movement is constrained to the graph: click a destination and the squad
  A*-pathfinds along streets instead of walking through walls.
- Replace the single dot per player with a handful of **squads**. Design call
  (locked in): a squad is a single unit — one dot, one health/ammo pool, no
  individual soldiers. Keeps APM low and netcode trivial.
- Basic selection UX: click to select, click to dispatch; drag-box later.
- Each side gets an **entry edge** (their map border) where squads deploy —
  this later doubles as the supply source for encirclement tracing.

Exit criteria: two players dispatch squads around the same city and the paths
look sane (no corner-cutting through buildings).

## Firefight

**First genuinely playable version.** Squads that meet an enemy engage
automatically — no micro, positioning is the skill.

- Contact on a street segment starts an exchange of fire, driven by squad
  strength and ammo; damage ticks in the sim, no client-side dice.
- Concentration matters: two squads firing on one should win decisively, so
  flanking via side streets is rewarded (this sets up Kettle).
- Squads at zero strength are destroyed; losing all squads = elimination win.
- Minimal combat feedback in the renderer: tracer lines, strength bars.

Exit criteria: a full 1v1 match can be played and won.

## Breadline

**Supply is the economy** — airdrops replace mineral lines; there is no base
building.

- Combat drains ammo; out of ammo means drastically reduced firepower.
- Airdrops are **telegraphed** a few seconds ahead (marker on the map), land
  on center-weighted street nodes, and are contestable by both sides.
- A squad standing on the drop node collects and **carries** the supply;
  friendlies resupply on contact with a supplied squad.
- Drop cadence and payload are the main balance knobs — keep them in
  `shared/constants.ts`.

Exit criteria: matches are decided by who controls drop zones, not just who
won the first skirmish.

## Kettle

**The signature mechanic**: surround the enemy and their supply dies.

- Every tick (or every N ticks), trace a supply path from each squad back to
  its side's entry edge, pathfinding over the street graph with enemy-held
  segments blocked.
- No path → **encircled**: ammo drains, no resupply, and (later) morale decay
  toward rout.
- Nearly free to implement once Streets/Firefight/Breadline exist — it is the
  same pathfinding over the same graph.
- Clear visual language: encircled squads get an obvious marker; ideally show
  the player the ring that is cutting them off.

Exit criteria: deliberately encircling a squad reliably kills it without a
direct assault, and players can see why.

## Keymaster

**Replace the shared password with Nostr keypair auth (NIP-98).**

- Clients authenticate with a signed NIP-98 HTTP auth event (kind 27235) over
  their Nostr keypair; the server verifies the signature, URL, method, and
  timestamp window. No passwords anywhere.
- **Player whitelist per room**: a room admits only whitelisted npubs.
  Whitelists live in server config (env/JSON to start), managed by admins.
- **Admin whitelist**: a separate set of npubs allowed to create/start
  rooms/sessions and edit room whitelists. Everyone else can only join rooms
  they are whitelisted into.
- Flow: client does an authenticated HTTP handshake (NIP-98 fits HTTP, not
  raw WebSocket) → server returns a short-lived session token → client opens
  the WebSocket with that token. The token plumbing from Skeleton survives;
  only the front door changes.
- Identity comes free: display names/avatars can come from the player's
  Nostr profile (kind 0) instead of a typed name.
- Deployment synergy: relay already runs on the app host
  (`wss://relay.internal.invalid`) — usable for profile lookups.
- Update `AGENTS.md`'s auth model section when this lands; retire
  `GAME_PASSWORD`.

Exit criteria: only whitelisted keys can join, only admin keys can open a
room, and a stranger with the URL gets nothing.

## Go Live

**Deploy to the deployment.** Worth doing right after Firefight — a real match
with a friend over the internet is the best playtest, and the deploy is small.

- Dockerfile here; Docker Compose service on the app host and a reverse proxy block
  for `game.internal.invalid` in the **`infra` repo** (its conventions,
  not this repo's).
- Same pattern as relay: reverse proxy on the VPS → VPN → app host; game
  clients never join the VPN.
- rate limiting jail on the VPS for failed join attempts.
- `/healthz` already exists for monitoring; wire it into whatever the deployment
  uses.
- No remote deploy commands against the live deployment unless explicitly asked.

Exit criteria: two people on different networks play a match at
`https://game.internal.invalid`.

## War Paint

**Idea bucket — polish once the loop is fun.** Building silhouettes, squad
icons by type, sound, a kill feed, spectator mode, mobile-friendly camera.

## Fog

**Idea bucket — deliberately deferred.** Fog of war doubles netcode
complexity (per-player filtered snapshots instead of one broadcast) and hides
the encirclement drama while the core loop is still being tuned. Revisit once
Kettle is proven.
