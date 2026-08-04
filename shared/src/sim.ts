// Pure deterministic simulation. No I/O, no DOM, no network imports.
import {
  FIRE_DAMAGE,
  FIRE_RANGE,
  LOW_AMMO_FACTOR,
  MOVE_SPEED,
  SQUAD_AMMO,
  SQUAD_STRENGTH,
  TICK_MS,
} from "./constants.js";
import { buildLosIndex, hasLineOfSight, type LosIndex } from "./los.js";
import type { GameMap } from "./map.js";
import { buildPathGraph, findPath, type PathGraph } from "./path.js";

export interface Entity {
  id: string;
  ownerId: string;
  name: string;
  x: number;
  y: number;
  /** Final destination (snapped to the street network), for UI. */
  target: { x: number; y: number } | null;
  /** Remaining street waypoints toward target. */
  path: { x: number; y: number }[] | null;
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

export type Side = "north" | "south";

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

/**
 * Spawn a player's squads on their entry nodes (map border), spread across
 * the available entries. Falls back to the map center if a side has none.
 */
export function spawnSquads(world: World, ownerId: string, baseName: string, side: Side, count: number): Entity[] {
  const entries = world.map.entries[side];
  const spawned: Entity[] = [];
  for (let i = 0; i < count; i++) {
    const entryId = entries.length ? entries[Math.floor((i * entries.length) / count)]! : null;
    const node = entryId !== null ? world.map.nodes[entryId] : undefined;
    const entity: Entity = {
      id: `e${world.tick}-${ownerId}-${i}`,
      ownerId,
      name: count > 1 ? `${baseName} ${i + 1}` : baseName,
      x: node ? node.x : world.map.meta.width / 2,
      y: node ? node.y : world.map.meta.height / 2,
      target: null,
      path: null,
      strength: SQUAD_STRENGTH,
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

export function tick(world: World, inputs: PlayerInput[]): void {
  for (const input of inputs) {
    const entity = world.entities.find((e) => e.id === input.entityId && e.ownerId === input.ownerId);
    if (!entity) continue;
    const path = findPath(world.graph, { x: entity.x, y: entity.y }, input.target);
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
