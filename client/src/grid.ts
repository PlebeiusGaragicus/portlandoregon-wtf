/**
 * A uniform spatial grid over the map, in compressed sparse row form.
 *
 * The sim's neighbour queries used `Map<number, number[]>` — one JS array per
 * occupied cell, one boxed number per member. For 538k building centroids and
 * 400k trees that is ~79 MB of object graph rebuilt on every boot, which is
 * precisely the shape the binary stores exist to delete; it just happened to
 * live in the fire sim rather than in the map.
 *
 * Two typed arrays instead: `start`, indexed by cell, holding where that
 * cell's members begin in `items`, and `items`, holding member indices grouped
 * by cell. Built by counting sort in two passes, so there is no allocation per
 * cell and no allocation per member.
 *
 * The grid is dense over the map: `start` is one Int32 per cell whether the
 * cell holds anything or not. That costs a few MB of mostly-zeros and buys an
 * array index where a hash lookup used to be — worth it for a structure
 * queried in 3x3 neighbourhoods every frame a fire is burning.
 */
export class CellGrid {
  readonly cols: number;
  readonly rows: number;
  private start: Int32Array;
  private items: Int32Array;

  /**
   * @param cell    cell size in world meters
   * @param width   map width in meters
   * @param height  map height in meters
   * @param count   number of candidate members, indexed 0..count-1
   * @param x       member x, by index
   * @param y       member y, by index
   * @param keep    optional filter; members it rejects are left out entirely
   */
  constructor(
    private cell: number,
    width: number,
    height: number,
    count: number,
    x: (i: number) => number,
    y: (i: number) => number,
    keep?: (i: number) => boolean,
  ) {
    this.cols = Math.max(1, Math.ceil(width / cell));
    this.rows = Math.max(1, Math.ceil(height / cell));
    const cells = this.cols * this.rows;
    this.start = new Int32Array(cells + 1);

    // Pass 1: how many land in each cell. Out-of-map members are CLAMPED into
    // the edge cell rather than dropped — the extract has footprints a few
    // metres outside the declared bounds, and dropping them would quietly make
    // those buildings unburnable. Clamping stays exact because queries clamp
    // the same way and every caller filters on the true distance afterwards.
    const at = new Int32Array(count).fill(-1);
    const lastC = this.cols - 1;
    const lastR = this.rows - 1;
    let total = 0;
    for (let i = 0; i < count; i++) {
      if (keep && !keep(i)) continue;
      let c = Math.floor(x(i) / cell);
      let r = Math.floor(y(i) / cell);
      c = c < 0 ? 0 : c > lastC ? lastC : c;
      r = r < 0 ? 0 : r > lastR ? lastR : r;
      const k = r * this.cols + c;
      at[i] = k;
      this.start[k + 1]!++;
      total++;
    }
    for (let k = 0; k < cells; k++) this.start[k + 1]! += this.start[k]!;

    // Pass 2: place. `fill` walks each cell's cursor forward; `start` is left
    // holding the true beginnings because the cursor is a separate copy.
    this.items = new Int32Array(total);
    const cursor = this.start.slice(0, cells);
    for (let i = 0; i < count; i++) {
      const k = at[i]!;
      if (k < 0) continue;
      this.items[cursor[k]!++] = i;
    }
  }

  /** Every member within `r` meters of (x, y) — by cell, so the callback sees
   * some members outside the radius. Callers filter on the real distance. */
  forEachNear(x: number, y: number, r: number, fn: (i: number) => void): void {
    // BOTH ends of each span clamp into the grid, not just the near one: a
    // query entirely off the west edge has c0 = 0 and c1 = -1, which iterates
    // nothing and misses the members clamped into column 0. Footprints do sit
    // outside the declared bounds, so that case is real.
    const lastC = this.cols - 1;
    const lastR = this.rows - 1;
    const clampC = (v: number): number => (v < 0 ? 0 : v > lastC ? lastC : v);
    const clampR = (v: number): number => (v < 0 ? 0 : v > lastR ? lastR : v);
    const c0 = clampC(Math.floor((x - r) / this.cell));
    const c1 = clampC(Math.floor((x + r) / this.cell));
    const r0 = clampR(Math.floor((y - r) / this.cell));
    const r1 = clampR(Math.floor((y + r) / this.cell));
    for (let ry = r0; ry <= r1; ry++) {
      const row = ry * this.cols;
      for (let cx = c0; cx <= c1; cx++) {
        const k = row + cx;
        const to = this.start[k + 1]!;
        for (let j = this.start[k]!; j < to; j++) fn(this.items[j]!);
      }
    }
  }

  /** Resident bytes, for the boot log. */
  get bytes(): number {
    return this.start.byteLength + this.items.byteLength;
  }
}
