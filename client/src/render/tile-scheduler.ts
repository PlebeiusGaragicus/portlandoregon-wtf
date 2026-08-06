export type TileWorkKind = "buildings" | "dressing" | "terrain" | "props";

export interface TileTicket {
  kind: TileWorkKind;
  key: number;
  generation: number;
  priority: number;
}

export interface TileSchedulerStats {
  wanted: number;
  pending: number;
  inFlight: number;
  completed: number;
  stale: number;
  cancelled: number;
  pendingBytes: number;
  completedBytes: number;
}

interface Entry extends TileTicket {
  state: "pending" | "inFlight" | "completed" | "resident";
  bytes: number;
  wanted: boolean;
}

const idOf = (kind: TileWorkKind, key: number): string => `${kind}:${key}`;

/**
 * Shared nearest-first admission queue for every streamed render layer.
 *
 * Call updateWanted once per layer and frame, then claim from the one global
 * queue. Generations make cancellation deterministic even when a worker
 * result arrives after its tile left and re-entered the wanted window.
 */
export class TileScheduler {
  private entries = new Map<string, Entry>();
  private generations = new Map<string, number>();
  private turn = 0;
  private stale = 0;
  private cancelled = 0;
  private readonly kinds: TileWorkKind[] = ["buildings", "dressing", "terrain", "props"];

  updateWanted(kind: TileWorkKind, orderedKeys: readonly number[]): void {
    for (const entry of this.entries.values()) {
      if (entry.kind === kind) entry.wanted = false;
    }
    for (let priority = 0; priority < orderedKeys.length; priority++) {
      const key = orderedKeys[priority]!;
      const id = idOf(kind, key);
      const current = this.entries.get(id);
      if (current) {
        current.priority = priority;
        current.wanted = true;
        continue;
      }
      const generation = (this.generations.get(id) ?? 0) + 1;
      this.generations.set(id, generation);
      this.entries.set(id, { kind, key, generation, priority, bytes: 0, wanted: true, state: "pending" });
    }
    for (const [id, entry] of this.entries) {
      if (entry.kind !== kind || entry.wanted) continue;
      this.generations.set(id, entry.generation + 1);
      this.cancelled++;
      this.entries.delete(id);
    }
  }

  /** Fair across layers; nearest-first within each layer. */
  claim(limit: number): TileTicket[] {
    const out: TileTicket[] = [];
    if (limit <= 0) return out;
    const byKind = new Map<TileWorkKind, Entry[]>();
    for (const kind of this.kinds) byKind.set(kind, []);
    for (const entry of this.entries.values()) {
      if (entry.state === "pending" && entry.wanted) byKind.get(entry.kind)!.push(entry);
    }
    for (const queue of byKind.values()) queue.sort((a, b) => a.priority - b.priority || a.key - b.key);

    let emptyTurns = 0;
    while (out.length < limit && emptyTurns < this.kinds.length) {
      const kind = this.kinds[this.turn++ % this.kinds.length]!;
      const entry = byKind.get(kind)!.shift();
      if (!entry) {
        emptyTurns++;
        continue;
      }
      emptyTurns = 0;
      entry.state = "inFlight";
      out.push({ kind: entry.kind, key: entry.key, generation: entry.generation, priority: entry.priority });
    }
    return out;
  }

  complete(ticket: TileTicket, bytes: number): boolean {
    const entry = this.current(ticket);
    if (!entry || entry.state !== "inFlight") {
      this.stale++;
      return false;
    }
    entry.state = "completed";
    entry.bytes = Math.max(0, bytes);
    return true;
  }

  /** Mark accepted work resident so unchanged windows do not admit it again. */
  accept(ticket: TileTicket): boolean {
    const entry = this.current(ticket);
    if (!entry || entry.state !== "completed") {
      this.stale++;
      return false;
    }
    entry.state = "resident";
    entry.bytes = 0;
    return true;
  }

  retry(ticket: TileTicket): void {
    const entry = this.current(ticket);
    if (entry) {
      entry.state = "pending";
      entry.bytes = 0;
    }
  }

  reset(): void {
    this.entries.clear();
    this.generations.clear();
    this.turn = 0;
    this.stale = 0;
    this.cancelled = 0;
  }

  stats(): TileSchedulerStats {
    let wanted = 0;
    let pending = 0;
    let inFlight = 0;
    let completed = 0;
    let pendingBytes = 0;
    let completedBytes = 0;
    for (const entry of this.entries.values()) {
      if (entry.wanted) wanted++;
      if (entry.state === "pending") {
        pending++;
        pendingBytes += entry.bytes;
      } else if (entry.state === "inFlight") {
        inFlight++;
        pendingBytes += entry.bytes;
      } else if (entry.state === "completed") {
        completed++;
        completedBytes += entry.bytes;
      }
    }
    return {
      wanted, pending, inFlight, completed, stale: this.stale, cancelled: this.cancelled,
      pendingBytes, completedBytes,
    };
  }

  private current(ticket: TileTicket): Entry | undefined {
    const entry = this.entries.get(idOf(ticket.kind, ticket.key));
    return entry?.generation === ticket.generation ? entry : undefined;
  }
}
