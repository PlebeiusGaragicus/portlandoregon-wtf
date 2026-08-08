// Towers, arches, trusses and cables — what makes a crossing recognisable.
//
// A deck on piers is a bridge; it is not the St. Johns. Everything here is
// built from one primitive, a square-section beam between two points, because
// at city scale that is all a cable, a chord and a tower leg need to be. The
// forms are driven by a hand-authored table (shared/src/bridges.ts) since the
// city publishes no structural type for its river crossings.
//
// All of it hangs off the same deck line as the slab and the collision
// surface, so a tower always stands on the deck it belongs to.

import type { CrossingSpec } from "@portlandoregon/shared";
import type { DeckStations } from "./deck.js";

/** World-space point: x east, y north, z up. */
export type P3 = readonly [number, number, number];

export interface BeamSoup {
  pos: number[];
  nrm: number[];
}

function quad(soup: BeamSoup, a: P3, b: P3, c: P3, d: P3): void {
  const ux = b[0] - a[0], uy = b[2] - a[2], uz = -(b[1] - a[1]);
  const vx = c[0] - a[0], vy = c[2] - a[2], vz = -(c[1] - a[1]);
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len; ny /= len; nz /= len;
  const p = (v: P3): void => {
    soup.pos.push(v[0], v[2], -v[1]);
    soup.nrm.push(nx, ny, nz);
  };
  p(a); p(b); p(c);
  p(a); p(c); p(d);
}

/**
 * Square-section beam from `a` to `b`. The only primitive here: towers, arch
 * ribs, truss chords and cables are all this at different thicknesses.
 */
export function pushBeam(soup: BeamSoup, a: P3, b: P3, radius: number): void {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return;
  const ux = dx / len, uy = dy / len, uz = dz / len;
  // Any vector not parallel to the beam gives a stable cross-section.
  const ref: P3 = Math.abs(uz) > 0.9 ? [1, 0, 0] : [0, 0, 1];
  let px = uy * ref[2] - uz * ref[1];
  let py = uz * ref[0] - ux * ref[2];
  let pz = ux * ref[1] - uy * ref[0];
  const pl = Math.hypot(px, py, pz) || 1;
  px /= pl; py /= pl; pz /= pl;
  const qx = uy * pz - uz * py;
  const qy = uz * px - ux * pz;
  const qz = ux * py - uy * px;
  const corner = (base: P3, s: number, t: number): P3 => [
    base[0] + (px * s + qx * t) * radius,
    base[1] + (py * s + qy * t) * radius,
    base[2] + (pz * s + qz * t) * radius,
  ];
  const signs: [number, number][] = [[1, 1], [1, -1], [-1, -1], [-1, 1]];
  for (let i = 0; i < 4; i++) {
    const s0 = signs[i]!;
    const s1 = signs[(i + 1) % 4]!;
    quad(
      soup,
      corner(a, s0[0], s0[1]), corner(a, s1[0], s1[1]),
      corner(b, s1[0], s1[1]), corner(b, s0[0], s0[1]),
    );
  }
}

/** A frame of reference at the middle of the main span. */
interface Span {
  /** Station index at the centre of the span. */
  mid: number;
  /** Along-deck unit direction. */
  ux: number;
  uy: number;
  /** Across-deck unit direction (toward the left edge). */
  vx: number;
  vy: number;
  /** Deck height at the centre. */
  z: number;
  /** Half the deck width. */
  half: number;
  /** Point on the deck centre line, `t` metres along from the centre. */
  at(t: number): P3;
  /** Deck edge point, `t` along and on side `s` (+1 left, -1 right). */
  edge(t: number, s: number): P3;
}

function spanFrame(s: DeckStations, spec: CrossingSpec): Span | null {
  const n = s.h.length;
  if (n < 2) return null;
  const mid = Math.floor(n / 2);
  // Direction from the deck itself, so structure aligns with a curving span.
  const a = Math.max(0, mid - 2);
  const b = Math.min(n - 1, mid + 2);
  const dx = s.cx[b]! - s.cx[a]!;
  const dy = s.cy[b]! - s.cy[a]!;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;
  const ux = dx / len, uy = dy / len;
  const vx = -uy, vy = ux;
  const half = Math.hypot(s.lx[mid]! - s.rx[mid]!, s.ly[mid]! - s.ry[mid]!) / 2;
  const cx = s.cx[mid]!, cy = s.cy[mid]!, z = s.h[mid]!;
  void spec;
  return {
    mid, ux, uy, vx, vy, z, half,
    at: (t) => [cx + ux * t, cy + uy * t, z],
    edge: (t, sign) => [cx + ux * t + vx * half * sign, cy + uy * t + vy * half * sign, z],
  };
}

const CABLE_R = 0.35;
const HANGER_R = 0.18;
const CHORD_R = 0.6;
const TOWER_R = 1.5;

/** Two towers, a sagging main cable over each side, and vertical hangers. */
function suspension(soup: BeamSoup, f: Span, spec: CrossingSpec): void {
  const halfSpan = spec.mainSpan / 2;
  const topZ = f.z + spec.rise;
  for (const side of [1, -1]) {
    const towerA = f.edge(-halfSpan, side);
    const towerB = f.edge(halfSpan, side);
    const topA: P3 = [towerA[0], towerA[1], topZ];
    const topB: P3 = [towerB[0], towerB[1], topZ];
    // Legs, and the Gothic crossbeam that makes the silhouette.
    pushBeam(soup, [towerA[0], towerA[1], f.z - 6], topA, TOWER_R);
    pushBeam(soup, [towerB[0], towerB[1], f.z - 6], topB, TOWER_R);
    // Main cable: a parabola between tower tops, sagging toward the deck.
    const sag = spec.rise * 0.72;
    const steps = 16;
    let prev: P3 = topA;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = -halfSpan + spec.mainSpan * t;
      const k = 2 * t - 1; // -1..1
      const z = topZ - sag * (1 - k * k);
      const pt = f.edge(x, side);
      const here: P3 = [pt[0], pt[1], z];
      pushBeam(soup, prev, here, CABLE_R);
      // Hangers down to the deck.
      if (i < steps) pushBeam(soup, here, [pt[0], pt[1], f.z], HANGER_R);
      prev = here;
    }
    // Back-stays running down to the deck at the span ends.
    pushBeam(soup, topA, f.edge(-halfSpan - 60, side), CABLE_R);
    pushBeam(soup, topB, f.edge(halfSpan + 60, side), CABLE_R);
  }
  // Tower crossbeams.
  for (const t of [-halfSpan, halfSpan]) {
    const l = f.edge(t, 1);
    const r = f.edge(t, -1);
    pushBeam(soup, [l[0], l[1], topZ], [r[0], r[1], topZ], TOWER_R * 0.8);
    pushBeam(soup, [l[0], l[1], topZ - spec.rise * 0.35], [r[0], r[1], topZ - spec.rise * 0.35], TOWER_R * 0.7);
  }
}

/** A parabolic rib each side, above the deck, with hangers. */
function throughArch(soup: BeamSoup, f: Span, spec: CrossingSpec): void {
  const halfSpan = spec.mainSpan / 2;
  const steps = 20;
  for (const side of [1, -1]) {
    let prev: P3 | null = null;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = -halfSpan + spec.mainSpan * t;
      const k = 2 * t - 1;
      const z = f.z + spec.rise * (1 - k * k);
      const pt = f.edge(x, side);
      const here: P3 = [pt[0], pt[1], z];
      if (prev) pushBeam(soup, prev, here, CHORD_R);
      if (i > 0 && i < steps && i % 2 === 0) pushBeam(soup, here, [pt[0], pt[1], f.z], HANGER_R);
      prev = here;
    }
  }
  // Cross-bracing over the crown.
  for (const t of [-halfSpan * 0.45, 0, halfSpan * 0.45]) {
    const k = t / halfSpan;
    const z = f.z + spec.rise * (1 - k * k);
    const l = f.edge(t, 1);
    const r = f.edge(t, -1);
    pushBeam(soup, [l[0], l[1], z], [r[0], r[1], z], CHORD_R * 0.7);
  }
}

/** An arch springing below the roadway, carrying it on spandrel posts. */
function deckArch(soup: BeamSoup, f: Span, spec: CrossingSpec): void {
  const halfSpan = spec.mainSpan / 2;
  const drop = spec.drop ?? 16;
  const steps = 18;
  for (const side of [1, -1]) {
    let prev: P3 | null = null;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = -halfSpan + spec.mainSpan * t;
      const k = 2 * t - 1;
      const z = f.z - drop * (1 - k * k) - 2;
      const pt = f.edge(x * 0.92, side);
      const here: P3 = [pt[0], pt[1], z];
      if (prev) pushBeam(soup, prev, here, CHORD_R * 1.4);
      if (i % 3 === 0 && i > 0 && i < steps) pushBeam(soup, here, [pt[0], pt[1], f.z], CHORD_R);
      prev = here;
    }
  }
}

/** Trusswork above the deck: top chord, verticals, diagonals, both sides. */
function throughTruss(soup: BeamSoup, f: Span, spec: CrossingSpec): void {
  const halfSpan = spec.mainSpan / 2;
  const bays = 10;
  const step = spec.mainSpan / bays;
  const topZ = f.z + spec.rise;
  for (const side of [1, -1]) {
    for (let i = 0; i <= bays; i++) {
      const x = -halfSpan + step * i;
      const p = f.edge(x, side);
      pushBeam(soup, [p[0], p[1], f.z], [p[0], p[1], topZ], CHORD_R * 0.8);
      if (i < bays) {
        const q = f.edge(x + step, side);
        pushBeam(soup, [p[0], p[1], topZ], [q[0], q[1], topZ], CHORD_R);
        // Alternating diagonals — a Warren truss reads correctly at distance.
        if (i % 2 === 0) pushBeam(soup, [p[0], p[1], f.z], [q[0], q[1], topZ], CHORD_R * 0.6);
        else pushBeam(soup, [p[0], p[1], topZ], [q[0], q[1], f.z], CHORD_R * 0.6);
      }
    }
  }
  for (let i = 0; i <= bays; i += 2) {
    const x = -halfSpan + step * i;
    const l = f.edge(x, 1);
    const r = f.edge(x, -1);
    pushBeam(soup, [l[0], l[1], topZ], [r[0], r[1], topZ], CHORD_R * 0.6);
  }
}

/** Trusswork hanging below the deck — what a double-deck cantilever reads as. */
function deckTruss(soup: BeamSoup, f: Span, spec: CrossingSpec): void {
  const halfSpan = spec.mainSpan / 2;
  const drop = spec.drop ?? 12;
  const bays = 10;
  const step = spec.mainSpan / bays;
  const lowZ = f.z - drop;
  for (const side of [1, -1]) {
    for (let i = 0; i <= bays; i++) {
      const x = -halfSpan + step * i;
      const p = f.edge(x, side);
      pushBeam(soup, [p[0], p[1], f.z], [p[0], p[1], lowZ], CHORD_R * 0.7);
      if (i < bays) {
        const q = f.edge(x + step, side);
        pushBeam(soup, [p[0], p[1], lowZ], [q[0], q[1], lowZ], CHORD_R);
        if (i % 2 === 0) pushBeam(soup, [p[0], p[1], lowZ], [q[0], q[1], f.z], CHORD_R * 0.55);
        else pushBeam(soup, [p[0], p[1], f.z], [q[0], q[1], lowZ], CHORD_R * 0.55);
      }
    }
  }
}

/** Two towers with fanned stays. */
function cableStayed(soup: BeamSoup, f: Span, spec: CrossingSpec): void {
  const halfSpan = spec.mainSpan / 2;
  const topZ = f.z + spec.rise;
  for (const t of [-halfSpan, halfSpan]) {
    const c = f.at(t);
    // An A-frame tower: legs from the deck edges meeting above the centre.
    const apex: P3 = [c[0], c[1], topZ];
    for (const side of [1, -1]) {
      const foot = f.edge(t, side);
      pushBeam(soup, [foot[0], foot[1], f.z - 4], apex, TOWER_R * 0.9);
    }
    // Stays, fanned along the deck both ways.
    for (let i = 1; i <= 7; i++) {
      const reach = (halfSpan * 0.9 * i) / 7;
      for (const dir of [1, -1]) {
        for (const side of [1, -1]) {
          const anchor = f.edge(t + reach * dir, side);
          pushBeam(soup, apex, [anchor[0], anchor[1], f.z], CABLE_R * 0.7);
        }
      }
    }
  }
}

/** Lift towers flanking the movable span. */
function lift(soup: BeamSoup, f: Span, spec: CrossingSpec): void {
  const halfSpan = spec.mainSpan / 2;
  const topZ = f.z + spec.rise;
  for (const t of [-halfSpan, halfSpan]) {
    for (const side of [1, -1]) {
      const foot = f.edge(t, side);
      pushBeam(soup, [foot[0], foot[1], f.z - 5], [foot[0], foot[1], topZ], TOWER_R);
      // Sheave housing at the top.
      pushBeam(
        soup,
        [foot[0], foot[1], topZ],
        [foot[0] + f.ux * 5, foot[1] + f.uy * 5, topZ],
        TOWER_R * 0.9,
      );
    }
    const l = f.edge(t, 1);
    const r = f.edge(t, -1);
    pushBeam(soup, [l[0], l[1], topZ], [r[0], r[1], topZ], TOWER_R * 0.8);
    pushBeam(soup, [l[0], l[1], topZ - spec.rise * 0.28], [r[0], r[1], topZ - spec.rise * 0.28], TOWER_R * 0.6);
  }
}

/** Counterweight housings flanking the channel. */
function bascule(soup: BeamSoup, f: Span, spec: CrossingSpec): void {
  const halfSpan = spec.mainSpan / 2;
  const topZ = f.z + spec.rise;
  for (const t of [-halfSpan, halfSpan]) {
    for (const side of [1, -1]) {
      const foot = f.edge(t, side);
      pushBeam(soup, [foot[0], foot[1], f.z - 3], [foot[0], foot[1], topZ], TOWER_R * 1.1);
    }
    const l = f.edge(t, 1);
    const r = f.edge(t, -1);
    pushBeam(soup, [l[0], l[1], topZ], [r[0], r[1], topZ], TOWER_R * 0.9);
  }
}

/**
 * Build a crossing's superstructure onto `soup`. Returns the along-deck
 * offsets, from the span centre, where main piers belong — a suspension
 * bridge has none between its towers, and neither does an arch.
 */
export function pushSuperstructure(
  soup: BeamSoup,
  stations: DeckStations,
  spec: CrossingSpec,
): number[] {
  const f = spanFrame(stations, spec);
  if (!f) return [];
  switch (spec.form) {
    case "suspension": suspension(soup, f, spec); break;
    case "through-arch": throughArch(soup, f, spec); break;
    case "deck-arch": deckArch(soup, f, spec); break;
    case "through-truss": throughTruss(soup, f, spec); break;
    case "deck-truss": deckTruss(soup, f, spec); break;
    case "cable-stayed": cableStayed(soup, f, spec); break;
    case "lift": lift(soup, f, spec); break;
    case "bascule": bascule(soup, f, spec); break;
    case "girder": break;
  }
  // Main supports stand at the ends of the clear span, and nowhere inside it.
  return [-spec.mainSpan / 2, spec.mainSpan / 2];
}
