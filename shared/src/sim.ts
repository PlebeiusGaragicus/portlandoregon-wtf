// Pure deterministic simulation. No I/O, no DOM, no network imports.
import {
  FIRE_DAMAGE,
  FIRE_RANGE,
  LOW_AMMO_FACTOR,
  MOVE_SPEED,
  OFFROAD_RANGE,
  SQUAD_AMMO,
  SQUAD_POP,
  TICK_MS,
} from "./constants.js";
import { buildLosIndex, hasLineOfSight, type LosIndex } from "./los.js";
import type { GameMap } from "./map.js";
import { buildPathGraph, findPath, nearestOnStreets, type PathGraph } from "./path.js";

export interface Entity {
  id: string;
  ownerId: string;
  name: string;
  x: number;
  y: number;
  /** Final destination (clicked point, or nearest street reach), for UI. */
  target: { x: number; y: number } | null;
  /** Remaining waypoints toward target (street legs + overland cut legs). */
  path: { x: number; y: number }[] | null;
  /** Head count: the squad is `ceil(strength)` living people (max SQUAD_POP). */
  strength: number;
  ammo: number;
  /** Entity id this squad is currently firing at (for tracers). */
  firingAt: string | null;
}

export interface World {
  tick: number;
  map: GameMap;
  graph: PathGraph;
  los: LosIndex;
  entities: Entity[];
  /** Every ownerId that has ever fielded squads (for the win check). */
  everOwners: Set<string>;
  /** Set once: the surviving owner after a contested match. */
  winner: string | null;
}

export interface Snapshot {
  tick: number;
  entities: Entity[];
  winner: string | null;
}

export interface PlayerInput {
  ownerId: string;
  entityId: string;
  target: { x: number; y: number };
}

export function createWorld(map: GameMap): World {
  return {
    tick: 0,
    map,
    graph: buildPathGraph(map),
    los: buildLosIndex(map),
    entities: [],
    everOwners: new Set(),
    winner: null,
  };
}

// Matches muster downtown: Pioneer Courthouse Square, converted to the map's
// local meters frame from its WGS84 origin. Equirectangular is a few meters
// off the pipeline's UTM projection — irrelevant, spawns snap to streets.
const MUSTER = { lat: 45.519, lon: -122.6794 };

function musterXY(map: GameMap): { x: number; y: number } {
  const x = (MUSTER.lon - map.meta.origin.lon) * 111320 * Math.cos((MUSTER.lat * Math.PI) / 180);
  const y = (MUSTER.lat - map.meta.origin.lat) * 110574;
  if (x < 0 || y < 0 || x > map.meta.width || y > map.meta.height) {
    return { x: map.meta.width / 2, y: map.meta.height / 2 };
  }
  return { x, y };
}

/**
 * Spawn a player's squads downtown. Players muster on a ring around the
 * square — spaced beyond FIRE_RANGE so joining is never an instant firefight
 * — with each squad snapped to the nearest street.
 */
export function spawnSquads(world: World, ownerId: string, baseName: string, playerNum: number, count: number): Entity[] {
  const c = musterXY(world.map);
  const ang = playerNum * 2.4; // golden-angle spacing around the ring
  const px = c.x + Math.cos(ang) * 420;
  const py = c.y + Math.sin(ang) * 420;
  const spawned: Entity[] = [];
  for (let i = 0; i < count; i++) {
    const sa = ang + (i - (count - 1) / 2) * 0.9;
    const raw = { x: px + Math.cos(sa) * 70, y: py + Math.sin(sa) * 70 };
    const snap = nearestOnStreets(world.graph, raw);
    const entity: Entity = {
      id: `e${world.tick}-${ownerId}-${i}`,
      ownerId,
      name: count > 1 ? `${baseName} ${i + 1}` : baseName,
      x: snap ? snap.x : raw.x,
      y: snap ? snap.y : raw.y,
      target: null,
      path: null,
      strength: SQUAD_POP,
      ammo: SQUAD_AMMO,
      firingAt: null,
    };
    world.entities.push(entity);
    spawned.push(entity);
  }
  world.everOwners.add(ownerId);
  return spawned;
}

export function removeEntitiesOwnedBy(world: World, ownerId: string): void {
  world.entities = world.entities.filter((e) => e.ownerId !== ownerId);
}

/**
 * Waypoints from a unit to a clicked target. People, not vehicles: short
 * legs cut straight across open ground when no building wall is in the way;
 * longer trips route on the street network, with a final overland leg to the
 * actual click point when that leg is clear. A click inside a building always
 * fails the wall-crossing check, so units stop at the wall, never clip in.
 */
function planRoute(
  world: World,
  from: { x: number; y: number },
  to: { x: number; y: number },
): { x: number; y: number }[] | null {
  const direct = Math.hypot(to.x - from.x, to.y - from.y) <= OFFROAD_RANGE && hasLineOfSight(world.los, from, to);
  if (direct) return [{ x: to.x, y: to.y }];
  const path = findPath(world.graph, from, to);
  if (!path || path.length === 0) return null;
  const last = path[path.length - 1]!;
  if (Math.hypot(to.x - last.x, to.y - last.y) <= OFFROAD_RANGE && hasLineOfSight(world.los, last, to)) {
    path.push({ x: to.x, y: to.y });
  }
  return path;
}

export function tick(world: World, inputs: PlayerInput[]): void {
  for (const input of inputs) {
    const entity = world.entities.find((e) => e.id === input.entityId && e.ownerId === input.ownerId);
    if (!entity) continue;
    const path = planRoute(world, { x: entity.x, y: entity.y }, input.target);
    if (path && path.length > 0) {
      entity.path = path;
      const dest = path[path.length - 1]!;
      entity.target = { x: dest.x, y: dest.y };
    }
  }

  // Movement along street waypoints.
  const step = (MOVE_SPEED * TICK_MS) / 1000;
  for (const entity of world.entities) {
    if (!entity.path) continue;
    let budget = step;
    while (budget > 0 && entity.path.length > 0) {
      const next = entity.path[0]!;
      const dx = next.x - entity.x;
      const dy = next.y - entity.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= budget) {
        entity.x = next.x;
        entity.y = next.y;
        budget -= dist;
        entity.path.shift();
      } else {
        entity.x += (dx / dist) * budget;
        entity.y += (dy / dist) * budget;
        budget = 0;
      }
    }
    if (entity.path.length === 0) {
      entity.path = null;
      entity.target = null;
    }
  }

  // Combat: each squad fires at its nearest visible enemy in range. Damage
  // accumulates before applying so tick order carries no bias; concentration
  // wins decisively by plain Lanchester arithmetic. A declared winner pauses
  // combat until a new challenger joins (rematch semantics).
  for (const e of world.entities) e.firingAt = null;
  if (!world.winner) {
    const damage = new Map<string, number>();
    for (const e of world.entities) {
      let best: Entity | null = null;
      let bestDist = FIRE_RANGE;
      for (const other of world.entities) {
        if (other.ownerId === e.ownerId) continue;
        const d = Math.hypot(other.x - e.x, other.y - e.y);
        if (d <= bestDist && hasLineOfSight(world.los, e, other)) {
          bestDist = d;
          best = other;
        }
      }
      if (best) {
        e.firingAt = best.id;
        const dmg = e.ammo > 0 ? FIRE_DAMAGE : FIRE_DAMAGE * LOW_AMMO_FACTOR;
        damage.set(best.id, (damage.get(best.id) ?? 0) + dmg);
        if (e.ammo > 0) e.ammo -= 1;
      }
    }
    if (damage.size > 0) {
      for (const e of world.entities) {
        const d = damage.get(e.id);
        if (d) e.strength -= d;
      }
      world.entities = world.entities.filter((e) => e.strength > 0);
    }
  }

  // Elimination: once a second player has ever fielded squads, the last owner
  // with survivors wins. Recomputed every tick, so a new challenger joining
  // clears the banner and resumes play.
  if (world.everOwners.size >= 2) {
    const alive = new Set(world.entities.map((e) => e.ownerId));
    world.winner = alive.size === 1 ? [...alive][0]! : null;
  }

  world.tick += 1;
}

export function snapshot(world: World): Snapshot {
  return {
    tick: world.tick,
    winner: world.winner,
    entities: world.entities.map((e) => ({
      ...e,
      target: e.target ? { ...e.target } : null,
      path: e.path ? e.path.map((p) => ({ ...p })) : null,
    })),
  };
}
