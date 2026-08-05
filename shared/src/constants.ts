export const TICK_RATE = 12; // sim ticks per second
export const TICK_MS = 1000 / TICK_RATE;

// World units are meters (map bounds come from the active map's meta).
// Both values below are gameplay tuning knobs, not physical truth.
export const MOVE_SPEED = 60; // m/s
export const ENTITY_RADIUS = 6; // m — ground footprint of a full crowd

export const SQUADS_PER_PLAYER = 3;

// A squad is a group of people led by one leader; strength IS the head
// count. ~30 is the span-of-control cap for a single leader.
export const SQUAD_POP = 30;

// Off-street movement: units may cut straight across open ground (never
// through buildings) for legs up to this long; anything farther routes on
// the street network.
export const OFFROAD_RANGE = 250; // m

// Squads shoulder past each other instead of stacking: closer than this and
// they gently shove apart (crowd spacing between whole squads).
export const SQUAD_SPACING = 16; // m

// Combat tuning knobs (Firefight phase). Damage is people per tick per
// attacking squad — fractional damage accumulates until someone drops.
export const SQUAD_AMMO = 240; // ticks of fire (~20 s)
export const FIRE_RANGE = 80; // m
export const FIRE_DAMAGE = 0.3;
export const LOW_AMMO_FACTOR = 0.25; // damage multiplier when ammo is out
