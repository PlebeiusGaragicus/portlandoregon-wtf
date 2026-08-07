import * as THREE from "three";
import { toScene } from "./camera.js";
import { radialGlowTexture } from "./props.js";

// Stochastic city mayhem: incidents pop up near the camera, the nearest idle
// units get assigned (fire brings an ambulance along more often than not),
// everyone drives to the scene, works it, then heads home. The dispatcher
// only does bookkeeping — driving stays in actors.ts.

const MAX_INCIDENTS = 5;
const SPAWN_MEAN_S = 13; // average seconds between new incidents
const INCIDENT_RANGE = 2800; // m from the camera focus
const FORGET_RANGE = 7000; // m — focus moved away: quietly close the call

export type IncidentKind = "fire" | "medical" | "crime";

/** What the dispatcher can see of a vehicle (actors.ts owns the rest). */
export interface Unit {
  uid: number;
  kind: string;
  mode: string;
  x: number;
  y: number;
  home: { x: number; y: number } | null;
  goal: { x: number; y: number } | null;
  respondT: number;
  /** Open incident currently reserving this unit. */
  incidentId: number | null;
}

export interface Incident {
  id: number;
  kind: IncidentKind;
  x: number;
  y: number;
  z: number;
  /** Outstanding unit kinds still to assign. */
  needs: string[];
  assigned: Unit[];
  /** Seconds the incident stays open (glow + assignments). */
  t: number;
  glow: THREE.Sprite | null;
}

let nextIncidentId = 1;

/** Fixed alarm policy, exported so station/dispatch invariants stay testable. */
export function needsForIncident(kind: IncidentKind, random = Math.random): string[] {
  if (kind === "fire") {
    const needs = ["fire", "fire", "fire", "fire"];
    if (random() < 0.6) needs.push("ambulance"); // fire + medical roll together
    if (random() < 0.3) needs.push("police");
    return needs;
  }
  if (kind === "medical") {
    const needs = ["ambulance"];
    if (random() < 0.35) needs.push("police");
    if (random() < 0.2) needs.push("fire"); // engine first-response
    return needs;
  }
  const needs = ["police"];
  if (random() < 0.5) needs.push("police");
  return needs;
}

function isFireUnit(unit: Unit): boolean {
  return unit.kind === "engine" || unit.kind === "truck";
}

function needFor(unit: Unit): string {
  return isFireUnit(unit) ? "fire" : unit.kind;
}

/** Drop failed/stale reservations and restore their alarm slots. */
export function reconcileIncident(incident: Incident): void {
  const active: Unit[] = [];
  for (const unit of incident.assigned) {
    const stillAssigned =
      unit.incidentId === incident.id &&
      (unit.mode === "respond" || unit.mode === "onscene");
    if (stillAssigned) {
      active.push(unit);
      continue;
    }
    if (unit.incidentId === incident.id) unit.incidentId = null;
    incident.needs.push(needFor(unit));
  }
  incident.assigned = active;
}

/** Reserve the nearest eligible unit for every currently open alarm slot. */
export function fillIncident(incident: Incident, units: Unit[]): void {
  for (let n = incident.needs.length - 1; n >= 0; n--) {
    const need = incident.needs[n]!;
    let best: Unit | null = null;
    let bd = Infinity;
    for (const unit of units) {
      if (unit.incidentId !== null) continue;
      const fire = isFireUnit(unit);
      if (need === "fire") {
        if (!fire || unit.mode !== "available") continue;
      } else if (fire || unit.kind !== need || unit.mode !== "roam") {
        continue;
      }
      const distance = Math.hypot(unit.x - incident.x, unit.y - incident.y);
      if (distance < bd) {
        bd = distance;
        best = unit;
      }
    }
    if (!best) continue;
    // Reserve before changing mode so a later incident in this update cannot
    // double-book the same apparatus.
    best.incidentId = incident.id;
    best.mode = "respond";
    best.goal = { x: incident.x, y: incident.y };
    best.respondT = 60 + bd / 15;
    incident.assigned.push(best);
    incident.needs.splice(n, 1);
  }
}

/** Release all reservations when a call closes. Fire rigs return home. */
export function releaseIncident(incident: Incident): void {
  for (const unit of incident.assigned) {
    if (unit.incidentId !== incident.id) continue;
    unit.incidentId = null;
    if (isFireUnit(unit)) {
      unit.mode = "return";
      unit.goal = unit.home ? { x: unit.home.x, y: unit.home.y } : null;
    } else if (unit.mode === "respond") {
      unit.mode = "roam";
      unit.goal = null;
    }
  }
  incident.assigned = [];
}

export class Dispatch {
  incidents: Incident[] = [];
  group = new THREE.Group();
  private glowTex = radialGlowTexture();
  /** Burn-sim probe: is a real fire still active near (x, y)? Fire calls
   * stay open (and crews keep working) until this says no. */
  hasFireNear: ((x: number, y: number, r: number) => boolean) | null = null;

  constructor(
    /** Random drivable point within `range` of a focus, or null. */
    private samplePoint: (focus: { x: number; y: number }, range: number) => { x: number; y: number; z: number } | null,
    /** Fire-kind incidents ignite a REAL building here (fire sim hook). */
    private onFire: ((x: number, y: number) => void) | null = null,
  ) {}

  /** A real fire reported from the burn sim: open a call unless a fire
   * incident already covers that area. Real fires burn long — so does the
   * incident (units keep cycling in until the fire dies or spreads away). */
  report(x: number, y: number, z: number): void {
    for (const inc of this.incidents) {
      if (inc.kind === "fire" && Math.hypot(inc.x - x, inc.y - y) < 260) return;
    }
    if (this.incidents.length >= MAX_INCIDENTS + 3) return;
    this.incidents.push({
      id: nextIncidentId++,
      kind: "fire",
      x,
      y,
      z,
      needs: needsForIncident("fire"),
      assigned: [],
      t: 150 + Math.random() * 90,
      glow: null, // the fire sim renders the flames themselves
    });
  }

  update(dt: number, timeSec: number, focus: { x: number; y: number }, units: Unit[]): void {
    // New calls come in.
    if (this.incidents.length < MAX_INCIDENTS && Math.random() < dt / SPAWN_MEAN_S) {
      const p = this.samplePoint(focus, INCIDENT_RANGE);
      if (p) {
        const kind: IncidentKind = Math.random() < 0.28 ? "fire" : Math.random() < 0.52 ? "medical" : "crime";
        const inc: Incident = {
          id: nextIncidentId++,
          kind,
          x: p.x,
          y: p.y,
          z: p.z,
          needs: needsForIncident(kind),
          assigned: [],
          t: 50 + Math.random() * 70,
          glow: null,
        };
        if (kind === "fire" && this.onFire) {
          // A real building catches fire; the burn sim owns the visuals.
          this.onFire(p.x, p.y);
        } else if (kind === "fire") {
          inc.glow = new THREE.Sprite(
            new THREE.SpriteMaterial({
              map: this.glowTex,
              color: 0xff7a26,
              transparent: true,
              opacity: 0.5,
              blending: THREE.AdditiveBlending,
              depthWrite: false,
            }),
          );
          inc.glow.scale.set(18, 18, 1);
          inc.glow.position.copy(toScene(p.x, p.y, p.z + 5));
          this.group.add(inc.glow);
        }
        this.incidents.push(inc);
      }
    }

    for (const inc of this.incidents) {
      inc.t -= dt;
      // A fire call is not over until the fire is: top the clock up while
      // buildings still burn near the scene.
      if (inc.kind === "fire") {
        if (this.hasFireNear?.(inc.x, inc.y, 300)) inc.t = Math.max(inc.t, 30);
        else inc.t = Math.min(inc.t, 2);
      }
      // Fire flicker.
      if (inc.glow) {
        const gm = inc.glow.material as THREE.SpriteMaterial;
        gm.opacity = 0.42 + 0.2 * Math.sin(timeSec * 13) + 0.12 * Math.sin(timeSec * 31 + inc.x);
      }
      if (inc.t <= 0) continue;
      reconcileIncident(inc);
      fillIncident(inc, units);
    }

    // Close finished or abandoned calls.
    this.incidents = this.incidents.filter((inc) => {
      // Fire calls are authoritative city incidents, not camera-local flavor.
      // They remain assigned even when the player pans across Portland.
      const gone =
        inc.kind !== "fire" &&
        Math.hypot(inc.x - focus.x, inc.y - focus.y) > FORGET_RANGE;
      if (inc.t > 0 && !gone) return true;
      releaseIncident(inc);
      if (inc.glow) {
        inc.glow.removeFromParent();
        (inc.glow.material as THREE.SpriteMaterial).dispose();
      }
      return false;
    });
  }

  dispose(): void {
    for (const inc of this.incidents) {
      if (inc.glow) {
        inc.glow.removeFromParent();
        (inc.glow.material as THREE.SpriteMaterial).dispose();
      }
    }
    this.incidents = [];
  }
}
