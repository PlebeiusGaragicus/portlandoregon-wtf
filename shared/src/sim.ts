// Pure deterministic simulation. No I/O, no DOM, no network imports.
import { MOVE_SPEED, TICK_MS } from "./constants.js";
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
}

export interface World {
  tick: number;
  map: GameMap;
  graph: PathGraph;
  entities: Entity[];
}

export interface Snapshot {
  tick: number;
  entities: Entity[];
}

export interface PlayerInput {
  ownerId: string;
  entityId: string;
  target: { x: number; y: number };
}

export type Side = "north" | "south";

export function createWorld(map: GameMap): World {
  return { tick: 0, map, graph: buildPathGraph(map), entities: [] };
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
    };
    world.entities.push(entity);
    spawned.push(entity);
  }
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

  world.tick += 1;
}

export function snapshot(world: World): Snapshot {
  return {
    tick: world.tick,
    entities: world.entities.map((e) => ({
      ...e,
      target: e.target ? { ...e.target } : null,
      path: e.path ? e.path.map((p) => ({ ...p })) : null,
    })),
  };
}
