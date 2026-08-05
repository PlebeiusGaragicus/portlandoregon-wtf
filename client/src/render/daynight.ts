import * as THREE from "three";

// Accelerated day/night driven by the real clock: CYCLES_PER_DAY full
// day-night cycles per real day, phase-locked to local midnight (so 12:00AM
// real time is always in-game midnight). One cycle = 3 real hours.

export const CYCLES_PER_DAY = 8;

interface Palette {
  zenith: number;
  horizon: number;
  fog: number;
}

const NIGHT: Palette = { zenith: 0x070b14, horizon: 0x18222f, fog: 0x141d2b };
const DUSK: Palette = { zenith: 0x1b2340, horizon: 0xb06a3e, fog: 0x4e4038 };
const DAY: Palette = { zenith: 0x2f5187, horizon: 0x93abc7, fog: 0x8298b4 };

const SUN_WARM = new THREE.Color(0xfff2dd);
const SUN_LOW = new THREE.Color(0xff9a55); // sunrise/sunset
const MOON = new THREE.Color(0xa8bfe8);

/** Per-frame lighting state — one instance, mutated in place (no allocs). */
export class DayNight {
  /** Debug: pin the cycle time (0..1); null follows the real clock. */
  overrideT: number | null = null;
  /** In-game time of day, 0 = midnight .. 1. */
  t = 0;
  clock = "00:00";
  day = false;
  /** 0 in daylight .. 1 deep night: lamp glow, window of "lights on". */
  night = 1;
  /** Direction TO the light source (sun or moon), scene frame (y up). */
  lightDir = new THREE.Vector3(0, 1, 0);
  lightColor = new THREE.Color();
  lightIntensity = 1;
  hemiIntensity = 0.9;
  zenith = new THREE.Color();
  horizon = new THREE.Color();
  fog = new THREE.Color();

  private a = new THREE.Color();

  update(nowMs: number): void {
    const midnight = new Date(nowMs).setHours(0, 0, 0, 0);
    const cycleMs = 86_400_000 / CYCLES_PER_DAY;
    this.t = this.overrideT ?? ((nowMs - midnight) % cycleMs) / cycleMs;

    const mins = Math.floor(this.t * 24 * 60);
    this.clock = `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;

    // Sun above the horizon 06:00-18:00; the moon works the other shift.
    // Both sweep east -> south -> west (northern-hemisphere city).
    const phase = (this.t + 0.75) % 1; // 0 at 06:00
    this.day = phase < 0.5;
    const prog = (this.day ? phase : phase - 0.5) / 0.5; // 0..1 across the sky
    const az = prog * Math.PI;
    const maxElev = this.day ? 1.05 : 0.85; // radians at culmination
    const elev = Math.sin(prog * Math.PI) * maxElev;
    // World frame: morning east (+x), culmination south (-y), evening west.
    const ce = Math.cos(elev);
    this.lightDir.set(Math.cos(az) * ce, Math.sin(elev), Math.sin(az) * ce);

    const horizonFade = Math.min(1, elev / 0.3); // 0 at the horizon, 1 high up
    if (this.day) {
      this.lightColor.copy(SUN_LOW).lerp(SUN_WARM, horizonFade);
      this.lightIntensity = 0.25 + 1.45 * horizonFade;
      this.hemiIntensity = 0.45 + 0.5 * horizonFade;
      this.night = Math.max(0, Math.min(1, 1 - elev / 0.2));
    } else {
      // Bright moonlight: cool, hard, plenty to see (and cast shadows) by.
      this.lightColor.copy(MOON);
      this.lightIntensity = 0.2 + 0.6 * horizonFade;
      this.hemiIntensity = 0.3;
      this.night = 1;
    }

    // Sky/fog palettes: dusk near the horizon crossings, else day/night.
    const toward = Math.min(1, Math.abs(elev) / 0.35);
    const p = this.day ? DAY : NIGHT;
    this.mix(this.zenith, DUSK.zenith, p.zenith, toward);
    this.mix(this.horizon, DUSK.horizon, p.horizon, toward);
    this.mix(this.fog, DUSK.fog, p.fog, toward);
  }

  private mix(out: THREE.Color, from: number, to: number, f: number): void {
    out.setHex(from).lerp(this.a.setHex(to), f);
  }
}
