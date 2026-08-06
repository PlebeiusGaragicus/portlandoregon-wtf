import {
  forEachRingVertex,
  heightAt,
  ringLength,
  type BuildingStore,
  type Heightfield,
} from "@battle-juice/shared";

/**
 * The city model: compact, whole-city, always resident.
 *
 * Per-building facts that several subsystems need and that used to be derived
 * three separate times — once in `buildWorld` for the prisms, once in
 * `FireSim`'s constructor for centroids, once in FPV's `SolidIndex` for
 * collision. Worse, the renderer's copy had become the *source*: the fire sim
 * asked `BuildingShells` for a building's ground height and whether it
 * existed at all.
 *
 * That only works while every building's geometry is resident forever. The
 * moment geometry becomes a disposable view onto the city (tile streaming),
 * "does this building have a mesh" stops meaning "does this building exist" —
 * and a fire two tiles away would find nothing to burn. Keeping these arrays
 * here, in one pass, is what lets the sim stop asking the renderer anything.
 *
 * Everything in here is a pure function of the map and the heightfield, so it
 * is also the natural first payload for a binary map format.
 */
export interface CityModel {
  /** 1 when the footprint is a real ring. A degenerate building has no
   * geometry and no presence in any spatial index — but it still occupies an
   * index in the building store, so the sim needs to be able to ask. */
  valid: Uint8Array;
  /** Prism base elevation: the lowest ground height under the footprint, sunk
   * 1 m so a slope never shows a gap under the uphill wall. */
  baseZ: Float32Array;
  /** Footprint centroid (0, 0) for degenerate buildings. */
  cx: Float32Array;
  cy: Float32Array;
}

export function buildCityModel(store: BuildingStore, hf?: Heightfield | null): CityModel {
  const ground = hf ? (x: number, y: number): number => heightAt(hf, x, y) : (): number => 0;
  const n = store.count;
  const city: CityModel = {
    valid: new Uint8Array(n),
    baseZ: new Float32Array(n),
    cx: new Float32Array(n),
    cy: new Float32Array(n),
  };
  for (let bi = 0; bi < n; bi++) {
    const len = ringLength(store, bi, 0);
    let base = Infinity;
    let cx = 0;
    let cy = 0;
    forEachRingVertex(store, bi, 0, (vx, vy) => {
      base = Math.min(base, ground(vx, vy));
      cx += vx;
      cy += vy;
    });
    city.baseZ[bi] = (Number.isFinite(base) ? base : 0) - 1;
    if (len < 3) continue;
    city.valid[bi] = 1;
    city.cx[bi] = cx / len;
    city.cy[bi] = cy / len;
  }
  return city;
}
