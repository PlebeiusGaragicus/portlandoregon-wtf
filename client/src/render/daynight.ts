import * as THREE from "three";

// Accelerated day/night driven by the real clock: CYCLES_PER_DAY full
// day-night cycles per real day, phase-locked to local midnight (so 12:00AM
// real time is always in-game midnight). Within a cycle the sun follows real
// solar geometry for Portland's latitude on today's real date — August days
// run long, December days short, and the noon sun sits where it should.

export const CYCLES_PER_DAY = 12;

const LAT = (45.5152 * Math.PI) / 180; // Portland

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
  /** User-applied time skip (cycle fraction) — the clock button adds 3h. */
  offsetT = 0;
  /** In-game time of day, 0 = midnight .. 1. */
  t = 0;
  clock = "00:00";
  /** True when the sun is up (the moon is modeled anti-solar, so exactly one
   * body is above the horizon at any moment). */
  day = false;
  /** 0 in daylight .. 1 deep night: lamp glow, window of "lights on". */
  night = 1;
  /** Direction TO the active body (sun or moon), scene frame (y up). */
  lightDir = new THREE.Vector3(0, 1, 0);
  lightColor = new THREE.Color();
  lightIntensity = 1;
  hemiIntensity = 0.9;
  zenith = new THREE.Color();
  horizon = new THREE.Color();
  fog = new THREE.Color();

  private a = new THREE.Color();

  update(nowMs: number): void {
    const d = new Date(nowMs);
    const midnight = new Date(nowMs).setHours(0, 0, 0, 0);
    const cycleMs = 86_400_000 / CYCLES_PER_DAY;
    this.t = this.overrideT ?? (((nowMs - midnight) % cycleMs) / cycleMs + this.offsetT) % 1;

    const mins = Math.floor(this.t * 24 * 60);
    this.clock = `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;

    // Solar declination for today's real date (drives season length).
    const yearStart = new Date(d.getFullYear(), 0, 0).getTime();
    const doy = Math.floor((nowMs - yearStart) / 86_400_000);
    const decl = ((-23.44 * Math.PI) / 180) * Math.cos((2 * Math.PI * (doy + 10)) / 365);

    // Hour angle: 0 at virtual solar noon. Sun elevation from the standard
    // spherical formula; the (full) moon is modeled exactly anti-solar.
    const H = (this.t - 0.5) * 2 * Math.PI;
    const sunElev = Math.asin(
      Math.sin(LAT) * Math.sin(decl) + Math.cos(LAT) * Math.cos(decl) * Math.cos(H),
    );
    this.day = sunElev > 0;
    const e = this.day ? sunElev : -sunElev; // active body's elevation
    const bDecl = this.day ? decl : -decl;
    const bH = this.day ? H : H + Math.PI;

    // Azimuth from north, clockwise (east = morning side).
    const cosA =
      (Math.sin(bDecl) - Math.sin(e) * Math.sin(LAT)) / (Math.cos(e) * Math.cos(LAT) || 1e-9);
    let az = Math.acos(Math.min(1, Math.max(-1, cosA)));
    if (Math.sin(bH) > 0) az = 2 * Math.PI - az; // past culmination: west side
    const ce = Math.cos(e);
    // World (x east, y north, z up) -> scene (x, z, -y).
    this.lightDir.set(Math.sin(az) * ce, Math.sin(e), -Math.cos(az) * ce);

    const horizonFade = Math.min(1, e / 0.3); // 0 at the horizon, 1 high up
    if (this.day) {
      this.lightColor.copy(SUN_LOW).lerp(SUN_WARM, horizonFade);
      this.lightIntensity = 0.25 + 1.45 * horizonFade;
      this.hemiIntensity = 0.45 + 0.5 * horizonFade;
      this.night = Math.max(0, Math.min(1, (0.08 - sunElev) / 0.2));
    } else {
      // Bright moonlight: cool, hard, plenty to see (and cast shadows) by.
      this.lightColor.copy(MOON);
      this.lightIntensity = 0.35 + 0.85 * horizonFade;
      this.hemiIntensity = 0.38;
      this.night = 1;
    }

    // Sky/fog palettes: dusk near the horizon crossings, else day/night.
    const toward = Math.min(1, Math.abs(sunElev) / 0.35);
    const p = this.day ? DAY : NIGHT;
    this.mix(this.zenith, DUSK.zenith, p.zenith, toward);
    this.mix(this.horizon, DUSK.horizon, p.horizon, toward);
    this.mix(this.fog, DUSK.fog, p.fog, toward);
  }

  private mix(out: THREE.Color, from: number, to: number, f: number): void {
    out.setHex(from).lerp(this.a.setHex(to), f);
  }
}
