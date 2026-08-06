/**
 * Device class heuristic, shared by every module that trades fidelity for
 * heat: a touch device with a phone-sized screen and either a coarse
 * pointer, low memory, or few cores. Tablets with big screens and desktops
 * take the full-detail path; the point is to catch things that will
 * physically get hot in a hand.
 */
const navCaps =
  (typeof navigator === "undefined" ? { maxTouchPoints: 0, hardwareConcurrency: 8 } : navigator) as
    Navigator & { deviceMemory?: number };

export const HANDHELD =
  (typeof screen === "undefined" ? Infinity : Math.min(screen.width, screen.height)) < 900 &&
  navCaps.maxTouchPoints > 0 &&
  (
    (typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches) ||
    (navCaps.deviceMemory !== undefined && navCaps.deviceMemory <= 6) ||
    navCaps.hardwareConcurrency <= 6
  );
