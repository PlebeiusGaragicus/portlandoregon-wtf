# Battle Juice — Game Design

## Concept

Top-down, click-to-dispatch real-time strategy (StarCraft/WarCraft-style
controls) set in urban combat. Two sides deploy troops into a city's streets.
Supply is the core tension: units burn ammo and morale, and the only way to
re-supply is to reliably capture airdrops that fall across the map. Victory
comes from encirclement — cutting the enemy off from their drops and drop
zones, then finishing them with superior movement and firepower.

## Core loop

1. Deploy squads from your entry edge/staging zone into the street grid.
2. Airdrops fall on a cadence at semi-random drop zones (telegraphed a few
   seconds ahead so both sides can race/contest them).
3. Collected drops convert to supply: ammo, reinforcements, upgrades.
4. Maneuver through streets and blocks to surround enemy squads. Surrounded
   units are cut off from supply, lose effectiveness, and can be forced to
   surrender/rout — encirclement is rewarded over raw attrition.
5. Lose condition: all squads eliminated/routed, or supply starved to zero.

## Design pillars

- **Supply is the economy.** No base-building, no workers. Airdrops replace
  the mineral line; map control over drop zones replaces expansion.
- **Streets are the terrain.** The map is a city grid: streets (fast movement,
  exposed), buildings (garrisonable, block line of sight/fire), intersections
  (chokepoints). Movement and firing lanes follow the grid.
- **Encirclement matters mechanically.** Supply is traced as a path from each
  squad back to a friendly-controlled drop cache/staging zone. Cut the path,
  the squad is "encircled": ammo drains, no reinforcement, morale penalty.
- **Low APM, high decision.** Click-to-move, attack-move, garrison. No
  micro-heavy abilities in v1.

## Netcode model (decided)

- **Authoritative server, state sync over WebSockets.** Clients send commands
  (`move squad 3 to (x,y)`), the server simulates the world at a fixed tick
  (target 10–15 Hz sim, interpolated to 60 fps on the client), and broadcasts
  snapshots/deltas. Clients render and predict nothing critical.
- RTS unit counts stay modest (squads, not 200 zerglings) so full-state deltas
  over TCP WebSockets are comfortably within budget.
- Server-authoritative also means the shared-password client can't cheat by
  fabricating state.

## Stack (decided)

- TypeScript everywhere; shared types/sim constants in a common package.
- Server: Node.js + `ws`, fixed-tick simulation, rooms/lobbies.
- Client: browser, Canvas 2D or PixiJS for top-down rendering; plain DOM/HTML
  for lobby and HUD.
- Deploy: Docker Compose on the app host, reverse proxy route for
  `game.internal.invalid` on the VPS (config lives in the `infra` repo).

## Auth (decided)

Shared password → short-lived session token on `/join`; rate limiting rate-limits
bad attempts at the VPS. Invite links: `https://game.internal.invalid/?join=…`.

## MVP scope (v0.1)

- One hardcoded city map (grid of streets/blocks), 1v1.
- Squads: one unit type. Move, attack-move, stop.
- Airdrops on a timer, telegraphed, collectable by walking a squad onto them.
- Supply-path tracing + encircled debuff.
- Win by eliminating all enemy squads.
- Lobby: create/join room with the shared password, pick a side, start.

Deferred: multiple unit types, garrisoning buildings, fog of war, morale/rout,
spectators, >2 players, matchmaking.
