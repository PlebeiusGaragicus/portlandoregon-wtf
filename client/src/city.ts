import type { BuildingStore, Heightfield } from "@battle-juice/shared";

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

/**
 * Derive the city model. ~90 ms for 538k buildings, which is the whole reason
 * this is still computed at boot rather than baked into the format: the baked
 * form measured at +2.7 MB gzipped (+14.6% of the download, and centroids
 * barely compress at all), to save less time than those bytes take to arrive.
 * See scripts/measure-citybake.ts.
 *
 * Written flat against the store's typed arrays rather than through
 * ringLength/forEachRingVertex/heightAt. Those are the right shape everywhere
 * else, but this loop runs over ~4.9M ring vertices on the phone's critical
 * path, and a callback plus a bilinear function call per vertex was half its
 * cost. The bilinear sample is the same piecewise-planar one heightAt does —
 * it has to be, or prisms would not sit where the terrain mesh is.
 */
export function buildCityModel(store: BuildingStore, hf?: Heightfield | null): CityModel {
  const n = store.count;
  const city: CityModel = {
    valid: new Uint8Array(n),
    baseZ: new Float32Array(n),
    cx: new Float32Array(n),
    cy: new Float32Array(n),
  };
  const coords = store.coords;
  const ringStart = store.ringStart;
  const ringOffset = store.ringOffset;
  // Hoisted out of the inner loop: property loads off `hf` were happening
  // millions of times.
  const data = hf?.data;
  const cols = hf ? hf.cols : 0;
  const cell = hf ? hf.cellSize : 1;
  const scale = hf ? hf.scale : 0;
  const maxX = hf ? hf.cols - 1.001 : 0;
  const maxY = hf ? hf.rows - 1.001 : 0;

  for (let bi = 0; bi < n; bi++) {
    const r = ringStart[bi]!;
    const from = ringOffset[r]!;
    const to = ringOffset[r + 1]!;
    let base = Infinity;
    let cx = 0;
    let cy = 0;
    for (let i = from; i < to; i++) {
      const vx = coords[i * 2]!;
      const vy = coords[i * 2 + 1]!;
      cx += vx;
      cy += vy;
      if (!data) {
        base = 0;
        continue;
      }
      const gx = vx / cell;
      const gy = vy / cell;
      const fx = gx < 0 ? 0 : gx > maxX ? maxX : gx;
      const fy = gy < 0 ? 0 : gy > maxY ? maxY : gy;
      const c0 = Math.floor(fx);
      const r0 = Math.floor(fy);
      const tx = fx - c0;
      const ty = fy - r0;
      const j = r0 * cols + c0;
      const v00 = data[j]!;
      const v10 = data[j + 1]!;
      const v01 = data[j + cols]!;
      const v11 = data[j + cols + 1]!;
      const h =
        tx + ty <= 1
          ? v00 + (v10 - v00) * tx + (v01 - v00) * ty
          : v11 + (v01 - v11) * (1 - tx) + (v10 - v11) * (1 - ty);
      if (h < base) base = h;
    }
    city.baseZ[bi] = (Number.isFinite(base) ? base * (data ? scale : 1) : 0) - 1;
    const len = to - from;
    if (len < 3) continue;
    city.valid[bi] = 1;
    city.cx[bi] = cx / len;
    city.cy[bi] = cy / len;
  }
  return city;
}
