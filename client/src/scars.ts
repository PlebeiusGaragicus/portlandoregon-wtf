/**
 * Where each building has been burned or blasted — sim state, not geometry.
 *
 * `BuildingShells.charLocal` rebuilds a building's pristine vertex colours and
 * lerps them toward char black by proximity to a list of sources. It keeps
 * nothing: the scar you see is the *result* of the last call, living in a GPU
 * colour buffer. That works only while every mesh is resident forever. Once
 * geometry becomes a disposable view onto the city, an evicted-and-rebuilt
 * tile comes back pristine and the city heals behind the camera.
 *
 * So the sources move here, keyed by building index and outliving any mesh.
 * Two kinds, because they scar differently:
 *
 * - **Fire cells** — the sampled points a fire creeps between. Their positions
 *   are fixed at ignition and their damage only ever increases, so one byte of
 *   char per cell is the whole record. A building that burns twice reuses its
 *   cells and keeps accumulating.
 * - **Blasts** — one-off impacts with their own radius, each landing wherever
 *   it landed.
 *
 * This also fixes an existing bug. Because `charLocal` rebuilds from pristine
 * every time, painting a *new* fire's cells erased the scars of an old one —
 * a building that burned, was saved, and caught again came back clean, and a
 * blast on a previously-burnt building wiped its soot. Accumulating every
 * source in one place means later paints compose with earlier damage instead
 * of replacing it.
 */

/** A char source in world space, as `BuildingShells.charLocal` wants it. */
export interface ScarSource {
  x: number;
  y: number;
  /** Char strength 0..1. */
  f: number;
  /** Falloff radius, meters. */
  r: number;
}

/** Char below this is invisible against the building's own tint — not worth
 * a source, and not worth the per-vertex distance test it costs. */
const MIN_CHAR = 0.02;

/**
 * Distinct impacts on one building. Repeated shelling of the same wall merges;
 * past that, the weakest scar is displaced. Eight is well clear of what a
 * building survives (hp gives out after a handful of hits), and it bounds the
 * inner loop `charLocal` runs per vertex.
 */
const MAX_BLASTS = 8;
const MERGE_DIST = 3; // m — hits this close are the same crater

interface Scar {
  /** Fire cell positions, fixed at first ignition. */
  cellX: Float32Array;
  cellY: Float32Array;
  /** Per-cell burn damage, 0..255. Monotonic. */
  cellChar: Uint8Array;
  /** Shared falloff radius for the cells (derived from the footprint). */
  cellR: number;
  /** Blast impacts, flat (x, y, f, r) quadruples. */
  blasts: number[];
  /** Burned out entirely — a uniformly charred shell, not a pattern. */
  whole: boolean;
}

export class ScarField {
  /** Sparse: only buildings that have actually been damaged. */
  private scars = new Map<number, Scar>();

  /** Has this building ever been marked? A rebuilt tile can skip repainting
   * everything else. */
  has(bi: number): boolean {
    return this.scars.has(bi);
  }

  /** Charred through — the building is a black shell rather than a pattern. */
  isWhole(bi: number): boolean {
    return this.scars.get(bi)?.whole ?? false;
  }

  setWhole(bi: number): void {
    this.entry(bi).whole = true;
  }

  /**
   * A fire starts on this building. Cell layout is derived from the footprint,
   * so a re-ignition produces the same cells as the first fire — when the
   * count matches, keep the existing damage and let it keep climbing.
   */
  beginBurn(bi: number, cells: { x: number; y: number }[], cellR: number): void {
    const s = this.entry(bi);
    s.cellR = cellR;
    if (s.cellChar.length === cells.length) return; // same layout: keep the damage
    s.cellX = new Float32Array(cells.length);
    s.cellY = new Float32Array(cells.length);
    s.cellChar = new Uint8Array(cells.length);
    for (let i = 0; i < cells.length; i++) {
      s.cellX[i] = cells[i]!.x;
      s.cellY[i] = cells[i]!.y;
    }
  }

  /** Fold the live burn's per-cell damage in. Monotonic: hosing a fire down
   * stops the char climbing, it never un-chars what already burned. */
  recordBurn(bi: number, cells: { char: number }[]): void {
    const s = this.scars.get(bi);
    if (!s || s.cellChar.length !== cells.length) return;
    for (let i = 0; i < cells.length; i++) {
      const q = Math.max(0, Math.min(255, Math.round(cells[i]!.char * 255)));
      if (q > s.cellChar[i]!) s.cellChar[i] = q;
    }
  }

  /** A blast, punch or shell impact at (x, y). */
  addBlast(bi: number, x: number, y: number, f: number, r: number): void {
    const s = this.entry(bi);
    const b = s.blasts;
    for (let i = 0; i < b.length; i += 4) {
      if (Math.hypot(b[i]! - x, b[i + 1]! - y) > MERGE_DIST) continue;
      b[i + 2] = Math.max(b[i + 2]!, f);
      b[i + 3] = Math.max(b[i + 3]!, r);
      return;
    }
    if (b.length < MAX_BLASTS * 4) {
      b.push(x, y, f, r);
      return;
    }
    let weakest = 0;
    for (let i = 4; i < b.length; i += 4) if (b[i + 2]! < b[weakest + 2]!) weakest = i;
    if (f <= b[weakest + 2]!) return;
    b[weakest] = x;
    b[weakest + 1] = y;
    b[weakest + 2] = f;
    b[weakest + 3] = r;
  }

  /**
   * Everything that has ever marked this building, ready for `charLocal`.
   *
   * This is the seam tile streaming needs: a rebuilt mesh repaints from here
   * and comes back exactly as scarred as the one it replaced, with no
   * knowledge of what the old mesh looked like.
   */
  sources(bi: number): ScarSource[] {
    const s = this.scars.get(bi);
    if (!s) return [];
    const out: ScarSource[] = [];
    for (let i = 0; i < s.cellChar.length; i++) {
      const f = s.cellChar[i]! / 255;
      if (f > MIN_CHAR) out.push({ x: s.cellX[i]!, y: s.cellY[i]!, f, r: s.cellR });
    }
    for (let i = 0; i < s.blasts.length; i += 4) {
      out.push({ x: s.blasts[i]!, y: s.blasts[i + 1]!, f: s.blasts[i + 2]!, r: s.blasts[i + 3]! });
    }
    return out;
  }

  /** Empty record — no cells until a fire actually samples some. */
  private entry(bi: number): Scar {
    let s = this.scars.get(bi);
    if (!s) {
      s = {
        cellX: new Float32Array(0),
        cellY: new Float32Array(0),
        cellChar: new Uint8Array(0),
        cellR: 0,
        blasts: [],
        whole: false,
      };
      this.scars.set(bi, s);
    }
    return s;
  }
}
