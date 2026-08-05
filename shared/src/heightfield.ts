// Terrain heightfield: decode + sampling. Pure math, no I/O — safe for both
// the renderer and (later phases) the sim. Binary format is written by
// tools/map-extract/fetch-dem.ts:
//   "BJH1" | u32 cols | u32 rows | f32 cellSize | f32 scale | u16[] heights
// Row-major, row 0 at y = 0 (map south edge); heights are meters / scale.

export interface Heightfield {
  cols: number;
  rows: number;
  /** Vertex spacing, meters. */
  cellSize: number;
  /** Meters per stored unit. */
  scale: number;
  data: Uint16Array;
}

export function decodeHeightfield(buf: ArrayBuffer): Heightfield {
  const view = new DataView(buf);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== "BJH1") throw new Error(`heightfield: bad magic "${magic}"`);
  const cols = view.getUint32(4, true);
  const rows = view.getUint32(8, true);
  const cellSize = view.getFloat32(12, true);
  const scale = view.getFloat32(16, true);
  const expected = 20 + cols * rows * 2;
  if (buf.byteLength < expected) {
    throw new Error(`heightfield: truncated (${buf.byteLength} < ${expected})`);
  }
  // Slice: the payload offset (20) is not 2-byte-aligned-safe across all
  // ArrayBuffer sources, so copy into a fresh view.
  const data = new Uint16Array(buf.slice(20, expected));
  return { cols, rows, cellSize, scale, data };
}

/**
 * Terrain height at world meters (clamped to the grid edge). Interpolation
 * is TRIANGLE-exact, matching the renderer's terrain mesh split (each cell
 * is two triangles across the tx+ty=1 diagonal) — so geometry draped with
 * densely-sampled vertices lies exactly on the rendered surface instead of
 * on a slightly different bilinear one.
 */
export function heightAt(hf: Heightfield, x: number, y: number): number {
  const fx = Math.max(0, Math.min(hf.cols - 1.001, x / hf.cellSize));
  const fy = Math.max(0, Math.min(hf.rows - 1.001, y / hf.cellSize));
  const c0 = Math.floor(fx);
  const r0 = Math.floor(fy);
  const tx = fx - c0;
  const ty = fy - r0;
  const i = r0 * hf.cols + c0;
  const v00 = hf.data[i]!;
  const v10 = hf.data[i + 1]!;
  const v01 = hf.data[i + hf.cols]!;
  const v11 = hf.data[i + hf.cols + 1]!;
  const h =
    tx + ty <= 1
      ? v00 + (v10 - v00) * tx + (v01 - v00) * ty
      : v11 + (v01 - v11) * (1 - tx) + (v10 - v11) * (1 - ty);
  return h * hf.scale;
}

/**
 * March a ray against the heightfield: find the nearest point where the ray
 * (world frame: origin/dir with z = up) meets the terrain. Coarse fixed
 * steps, then a binary refine. Returns null when the ray never lands inside
 * the grid. Replaces the flat ground-plane raycast for screen->world picks.
 */
export function raycastHeightfield(
  hf: Heightfield,
  origin: { x: number; y: number; z: number },
  dir: { x: number; y: number; z: number },
  maxDist = 100_000,
): { x: number; y: number; z: number } | null {
  const STEPS = 256;
  const step = maxDist / STEPS;
  let prevT = 0;
  let prevAbove = origin.z - heightAt(hf, origin.x, origin.y) > 0;
  for (let i = 1; i <= STEPS; i++) {
    const t = i * step;
    const x = origin.x + dir.x * t;
    const y = origin.y + dir.y * t;
    const z = origin.z + dir.z * t;
    const above = z - heightAt(hf, x, y) > 0;
    if (prevAbove && !above) {
      // Crossed the surface in (prevT, t] — refine.
      let lo = prevT;
      let hi = t;
      for (let k = 0; k < 24; k++) {
        const mid = (lo + hi) / 2;
        const mx = origin.x + dir.x * mid;
        const my = origin.y + dir.y * mid;
        const mz = origin.z + dir.z * mid;
        if (mz - heightAt(hf, mx, my) > 0) lo = mid;
        else hi = mid;
      }
      const ft = (lo + hi) / 2;
      return { x: origin.x + dir.x * ft, y: origin.y + dir.y * ft, z: origin.z + dir.z * ft };
    }
    prevAbove = above;
    prevT = t;
  }
  return null;
}
