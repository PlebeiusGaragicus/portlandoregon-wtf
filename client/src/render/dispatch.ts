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
  kind: string;
  mode: string;
  x: number;
  y: number;
  home: { x: number; y: number } | null;
  goal: { x: number; y: number } | null;
  respondT: number;
}

export interface Incident {
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

function rollNeeds(kind: IncidentKind): string[] {
  if (kind === "fire") {
    const needs = ["fire", "fire"];
    if (Math.random() < 0.4) needs.push("fire");
    if (Math.random() < 0.6) needs.push("ambulance"); // fire + medical roll together
    if (Math.random() < 0.3) needs.push("police");
    return needs;
  }
  if (kind === "medical") {
    const needs = ["ambulance"];
    if (Math.random() < 0.35) needs.push("police");
    if (Math.random() < 0.2) needs.push("fire"); // engine first-response
    return needs;
  }
  const needs = ["police"];
  if (Math.random() < 0.5) needs.push("police");
  return needs;
}

export class Dispatch {
  incidents: Incident[] = [];
  group = new THREE.Group();
  private glowTex = radialGlowTexture();

  constructor(
    /** Random drivable point within `range` of a focus, or null. */
    private samplePoint: (focus: { x: number; y: number }, range: number) => { x: number; y: number; z: number } | null,
  ) {}

  update(dt: number, timeSec: number, focus: { x: number; y: number }, units: Unit[]): void {
    // New calls come in.
    if (this.incidents.length < MAX_INCIDENTS && Math.random() < dt / SPAWN_MEAN_S) {
      const p = this.samplePoint(focus, INCIDENT_RANGE);
      if (p) {
        const kind: IncidentKind = Math.random() < 0.28 ? "fire" : Math.random() < 0.52 ? "medical" : "crime";
        const inc: Incident = {
          kind,
          x: p.x,
          y: p.y,
          z: p.z,
          needs: rollNeeds(kind),
          assigned: [],
          t: 50 + Math.random() * 70,
          glow: null,
        };
        if (kind === "fire") {
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
      // Fire flicker.
      if (inc.glow) {
        const gm = inc.glow.material as THREE.SpriteMaterial;
        gm.opacity = 0.42 + 0.2 * Math.sin(timeSec * 13) + 0.12 * Math.sin(timeSec * 31 + inc.x);
      }
      // Fill outstanding needs from the nearest idle unit of that service.
      for (let n = inc.needs.length - 1; n >= 0; n--) {
        const need = inc.needs[n]!;
        let best: Unit | null = null;
        let bd = Infinity;
        for (const u of units) {
          if (u.mode !== "roam") continue;
          const isFire = u.kind === "engine" || u.kind === "truck";
          if (need === "fire" ? !isFire : u.kind !== need) continue;
          const d = Math.hypot(u.x - inc.x, u.y - inc.y);
          if (d < bd) {
            bd = d;
            best = u;
          }
        }
        if (best) {
          best.mode = "respond";
          best.goal = { x: inc.x, y: inc.y };
          best.respondT = 110;
          inc.assigned.push(best);
          inc.needs.splice(n, 1);
        }
      }
    }

    // Close finished or abandoned calls.
    this.incidents = this.incidents.filter((inc) => {
      const gone = Math.hypot(inc.x - focus.x, inc.y - focus.y) > FORGET_RANGE;
      if (inc.t > 0 && !gone) return true;
      for (const u of inc.assigned) {
        if (u.mode === "respond") {
          // Never made it: cancel and resume patrol/return per its own logic.
          u.mode = "roam";
          u.goal = null;
        }
      }
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
