// Pure deterministic simulation. No I/O, no DOM, no network imports.
import { MOVE_SPEED, TICK_MS } from "./constants.js";

export interface Entity {
  id: string;
  ownerId: string;
  name: string;
  x: number;
  y: number;
  target: { x: number; y: number } | null;
}

export interface WorldBounds {
  width: number;
  height: number;
}

export interface World {
  tick: number;
  bounds: WorldBounds;
  entities: Entity[];
}

export interface Snapshot {
  tick: number;
  entities: Entity[];
}

export interface PlayerInput {
  ownerId: string;
  target: { x: number; y: number };
}

export function createWorld(bounds: WorldBounds): World {
  return { tick: 0, bounds, entities: [] };
}

export function spawnEntity(world: World, ownerId: string, name: string): Entity {
  const entity: Entity = {
    id: `e${world.tick}-${ownerId}`,
    ownerId,
    name,
    x: world.bounds.width * (0.25 + 0.5 * (world.entities.length % 2)),
    y: world.bounds.height / 2,
    target: null,
  };
  world.entities.push(entity);
  return entity;
}

export function removeEntitiesOwnedBy(world: World, ownerId: string): void {
  world.entities = world.entities.filter((e) => e.ownerId !== ownerId);
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function tick(world: World, inputs: PlayerInput[]): void {
  for (const input of inputs) {
    for (const entity of world.entities) {
      if (entity.ownerId === input.ownerId) {
        entity.target = {
          x: clamp(input.target.x, 0, world.bounds.width),
          y: clamp(input.target.y, 0, world.bounds.height),
        };
      }
    }
  }

  const step = (MOVE_SPEED * TICK_MS) / 1000;
  for (const entity of world.entities) {
    if (!entity.target) continue;
    const dx = entity.target.x - entity.x;
    const dy = entity.target.y - entity.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= step) {
      entity.x = entity.target.x;
      entity.y = entity.target.y;
      entity.target = null;
    } else {
      entity.x += (dx / dist) * step;
      entity.y += (dy / dist) * step;
    }
  }

  world.tick += 1;
}

export function snapshot(world: World): Snapshot {
  return {
    tick: world.tick,
    entities: world.entities.map((e) => ({ ...e, target: e.target ? { ...e.target } : null })),
  };
}
