// Landmarks: reproject the fetched landmark list (data/landmarks.json) into
// the map's local meter frame and clip it to the play area. Applied at BUILD
// time rather than TRANSFORM — landmarks come from a different source than
// the ArcGIS core layers and are cheap enough to re-attach on every bake.
import { existsSync, readFileSync } from "node:fs";
import type { Building, Landmark } from "@battle-juice/shared";
import { LANDMARKS_FILE } from "./config.js";
import { toLocal } from "./lib/proj.js";

export interface LandmarkSource {
  kind: Landmark["kind"];
  /** Source-side identifier, e.g. the station number. */
  ref: string;
  label: string;
  name: string;
  address: string;
  lat: number;
  lon: number;
  source: string;
}

interface LandmarkFile {
  source: string;
  scrapedAt: string;
  landmarks: LandmarkSource[];
}

export interface LandmarkBake {
  landmarks: Landmark[];
  /** Rows dropped because they fell outside the play area. */
  outside: number;
  /** Rows with no building match — rendered as a bare marker. */
  unmatched: string[];
  /** Rows whose matched cluster is implausibly small for a civic building. */
  suspicious: string[];
  source: string | null;
  scrapedAt: string | null;
}

/** Even official pins can sit in the apron of a campus-style station, so
 * accept a footprint this far from the pin. */
const MATCH_RADIUS_M = 80;
/** Sheds/outbuildings — never seed a match on one if anything larger is in
 * range (the fallback pool keeps them when they're all there is). */
const MIN_SEED_AREA_M2 = 120;
/** Bigger nearby footprints beat marginally closer small ones: the score is
 * distance minus this many meters per sqrt(m²) of area. */
const AREA_BONUS = 0.5;
/** Footprint-DB fragments of one physical building sit within this gap. */
const CLUSTER_GAP_M = 1.5;
/** A matched cluster smaller than this is flagged for review — real fire
 * halls, schools etc. are bigger. */
const PLAUSIBLE_AREA_M2 = 250;
const CLUSTER_MAX = 16; // runaway guard

export function bakeLandmarks(width: number, height: number, buildings: Building[]): LandmarkBake {
  if (!existsSync(LANDMARKS_FILE)) {
    return { landmarks: [], outside: 0, unmatched: [], suspicious: [], source: null, scrapedAt: null };
  }
  const file = JSON.parse(readFileSync(LANDMARKS_FILE, "utf8")) as LandmarkFile;

  const index = new BuildingIndex(buildings);
  const landmarks: Landmark[] = [];
  const unmatched: string[] = [];
  const suspicious: string[] = [];
  let outside = 0;
  for (const row of file.landmarks) {
    const [x, y] = toLocal(row.lon, row.lat);
    if (x < 0 || y < 0 || x > width || y > height) {
      outside++;
      continue;
    }
    const cluster = index.match(x, y);
    if (cluster.length === 0) unmatched.push(row.label);
    else if (cluster.reduce((a, b) => a + ringArea(b.footprint), 0) < PLAUSIBLE_AREA_M2) {
      suspicious.push(row.label);
    }
    landmarks.push({
      id: landmarks.length,
      kind: row.kind,
      label: row.label,
      name: row.name,
      address: row.address,
      x: Math.round(x * 10) / 10,
      y: Math.round(y * 10) / 10,
      ...(cluster.length === 0 ? {} : { buildingIds: cluster.map((b) => b.id) }),
    });
  }
  return { landmarks, outside, unmatched, suspicious, source: file.source, scrapedAt: file.scrapedAt };
}

/**
 * Grid-bucketed building lookup. A landmark seeds on the footprint containing
 * its pin (largest wins when fragments nest), else the best-scoring footprint
 * within MATCH_RADIUS_M — closer is better, bigger is better, so the station
 * hall beats the marginally closer shed. The seed then absorbs contiguous
 * same-use fragments (the footprint DB splits one physical building into
 * several prisms) so the whole hall gets painted.
 */
class BuildingIndex {
  private static readonly CELL = 100; // m
  private cells = new Map<number, Building[]>();

  constructor(buildings: Building[]) {
    for (const b of buildings) {
      if (b.footprint.length < 3) continue;
      const [x, y] = centroid(b.footprint);
      const key = this.key(x, y);
      const cell = this.cells.get(key);
      cell ? cell.push(b) : this.cells.set(key, [b]);
    }
  }

  private key(x: number, y: number): number {
    return Math.floor(y / BuildingIndex.CELL) * 8192 + Math.floor(x / BuildingIndex.CELL);
  }

  /** Buildings bucketed within one cell ring of (x, y) — covers ≥100 m. */
  private near(x: number, y: number): Building[] {
    const cx = Math.floor(x / BuildingIndex.CELL);
    const cy = Math.floor(y / BuildingIndex.CELL);
    const near: Building[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cell = this.cells.get((cy + dy) * 8192 + (cx + dx));
        if (cell) near.push(...cell);
      }
    }
    return near;
  }

  match(x: number, y: number): Building[] {
    const near = this.near(x, y);
    const seed = this.seed(x, y, near);
    return seed ? this.cluster(seed, near) : [];
  }

  private seed(x: number, y: number, near: Building[]): Building | undefined {
    const containing = near.filter((b) => pointInRing(x, y, b.footprint));
    if (containing.length) {
      return containing.sort((a, b) => ringArea(b.footprint) - ringArea(a.footprint))[0];
    }
    const inRange = near
      .map((b) => ({ b, d: distToRing(x, y, b.footprint), area: ringArea(b.footprint) }))
      .filter((c) => c.d <= MATCH_RADIUS_M);
    const plausible = inRange.filter((c) => c.area >= MIN_SEED_AREA_M2);
    const pool = plausible.length ? plausible : inRange;
    let best: (typeof pool)[number] | undefined;
    for (const c of pool) {
      const score = c.d - AREA_BONUS * Math.sqrt(c.area);
      if (!best || score < best.d - AREA_BONUS * Math.sqrt(best.area)) best = c;
    }
    return best?.b;
  }

  /** Flood-fill fragments: same use, compatible height, near-touching. */
  private cluster(seed: Building, near: Building[]): Building[] {
    const members = [seed];
    const taken = new Set([seed.id]);
    for (let i = 0; i < members.length && members.length < CLUSTER_MAX; i++) {
      const m = members[i]!;
      for (const b of near) {
        if (taken.has(b.id)) continue;
        if ((b.use ?? "other") !== (m.use ?? "other")) continue;
        if (!heightsCompatible(m.height, b.height)) continue;
        if (ringToRingDist(m.footprint, b.footprint) > CLUSTER_GAP_M) continue;
        taken.add(b.id);
        members.push(b);
      }
    }
    return members;
  }
}

function heightsCompatible(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1 + 0.15 * Math.max(a, b);
}

function centroid(ring: [number, number][]): [number, number] {
  let x = 0;
  let y = 0;
  for (const [px, py] of ring) {
    x += px;
    y += py;
  }
  return [x / ring.length, y / ring.length];
}

function ringArea(ring: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i]!;
    const [x2, y2] = ring[(i + 1) % ring.length]!;
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

function distToRing(x: number, y: number, ring: [number, number][]): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i]!;
    const [bx, by] = ring[(i + 1) % ring.length]!;
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lenSq));
    best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
  }
  return best;
}

/** Min vertex-to-edge distance between two rings (either direction). 0 when
 * they touch or overlap enough to share vertices — good enough for a 1.5 m
 * contiguity gate on simplified footprints. */
function ringToRingDist(a: [number, number][], b: [number, number][]): number {
  let best = Infinity;
  for (const [x, y] of a) best = Math.min(best, distToRing(x, y, b));
  for (const [x, y] of b) best = Math.min(best, distToRing(x, y, a));
  return best;
}

function pointInRing(x: number, y: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
