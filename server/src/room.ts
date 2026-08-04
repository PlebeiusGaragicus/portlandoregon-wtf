import type { WebSocket } from "ws";
import {
  activeMap,
  createWorld,
  removeEntitiesOwnedBy,
  snapshot,
  spawnEntity,
  tick,
  TICK_MS,
  type PlayerInput,
  type ServerMsg,
} from "@battle-juice/shared";

interface Player {
  id: string;
  name: string;
  token: string;
  socket: WebSocket;
}

export class Room {
  private world = createWorld({ width: activeMap.meta.width, height: activeMap.meta.height });
  private players = new Map<string, Player>();
  private pendingInputs: PlayerInput[] = [];
  private nextPlayerNum = 1;
  private timer: NodeJS.Timeout | null = null;

  addPlayer(name: string, token: string, socket: WebSocket): { playerId: string } {
    const id = `p${this.nextPlayerNum++}`;
    this.players.set(id, { id, name, token, socket });
    spawnEntity(this.world, id, name);
    this.ensureTicking();
    return { playerId: id };
  }

  removePlayer(playerId: string): void {
    if (!this.players.delete(playerId)) return;
    removeEntitiesOwnedBy(this.world, playerId);
    if (this.players.size === 0) this.stopTicking();
  }

  queueInput(playerId: string, target: { x: number; y: number }): void {
    if (!this.players.has(playerId)) return;
    this.pendingInputs.push({ ownerId: playerId, target });
  }

  currentSnapshot() {
    return snapshot(this.world);
  }

  private ensureTicking(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.step(), TICK_MS);
  }

  private stopTicking(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private step(): void {
    const inputs = this.pendingInputs;
    this.pendingInputs = [];
    tick(this.world, inputs);
    this.broadcast({ type: "snapshot", snapshot: snapshot(this.world) });
  }

  private broadcast(msg: ServerMsg): void {
    const data = JSON.stringify(msg);
    for (const player of this.players.values()) {
      if (player.socket.readyState === player.socket.OPEN) {
        player.socket.send(data);
      }
    }
  }
}
