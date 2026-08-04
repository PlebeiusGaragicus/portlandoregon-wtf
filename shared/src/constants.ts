export const TICK_RATE = 12; // sim ticks per second
export const TICK_MS = 1000 / TICK_RATE;

// World units are meters (map bounds come from the active map's meta).
// Both values below are gameplay tuning knobs, not physical truth.
export const MOVE_SPEED = 60; // m/s
export const ENTITY_RADIUS = 4; // m

export const SQUADS_PER_PLAYER = 3;

// Combat tuning knobs (Firefight phase).
export const SQUAD_STRENGTH = 100;
export const SQUAD_AMMO = 240; // ticks of fire (~20 s)
export const FIRE_RANGE = 80; // m
export const FIRE_DAMAGE = 1; // strength per tick per attacker
export const LOW_AMMO_FACTOR = 0.25; // damage multiplier when ammo is out
