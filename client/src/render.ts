import {
  ENTITY_RADIUS,
  MAP_HEIGHT,
  MAP_WIDTH,
  TICK_MS,
  type Snapshot,
} from "@battle-juice/shared";

const PLAYER_COLORS = ["#4f7cff", "#ff5f4f", "#3ecf6a", "#e6b93e", "#b45fff", "#3ec9cf"];

function colorFor(ownerId: string): string {
  const n = Number(ownerId.replace(/\D/g, "")) || 0;
  return PLAYER_COLORS[n % PLAYER_COLORS.length]!;
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private prev: Snapshot | null = null;
  private curr: Snapshot | null = null;
  private currAt = 0;

  constructor(private canvas: HTMLCanvasElement, private myPlayerId: string) {
    canvas.width = MAP_WIDTH;
    canvas.height = MAP_HEIGHT;
    this.ctx = canvas.getContext("2d")!;
    requestAnimationFrame(() => this.frame());
  }

  pushSnapshot(s: Snapshot): void {
    this.prev = this.curr;
    this.curr = s;
    this.currAt = performance.now();
  }

  // Convert a client (CSS-pixel) click position to world coordinates.
  toWorld(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * MAP_WIDTH,
      y: ((clientY - rect.top) / rect.height) * MAP_HEIGHT,
    };
  }

  private frame(): void {
    const { ctx } = this;
    ctx.clearRect(0, 0, MAP_WIDTH, MAP_HEIGHT);

    ctx.strokeStyle = "#3a4150";
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, MAP_WIDTH - 2, MAP_HEIGHT - 2);

    if (this.curr) {
      // Interpolate from prev→curr across one tick interval.
      const t = this.prev ? Math.min(1, (performance.now() - this.currAt) / TICK_MS) : 1;
      for (const e of this.curr.entities) {
        const before = this.prev?.entities.find((p) => p.id === e.id);
        const x = before ? before.x + (e.x - before.x) * t : e.x;
        const y = before ? before.y + (e.y - before.y) * t : e.y;

        if (e.target && e.ownerId === this.myPlayerId) {
          ctx.strokeStyle = "#4f7cff55";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(e.target.x, e.target.y);
          ctx.stroke();
        }

        ctx.fillStyle = colorFor(e.ownerId);
        ctx.beginPath();
        ctx.arc(x, y, ENTITY_RADIUS, 0, Math.PI * 2);
        ctx.fill();
        if (e.ownerId === this.myPlayerId) {
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        ctx.fillStyle = "#e6e6e6";
        ctx.font = "13px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(e.name, x, y - ENTITY_RADIUS - 6);
      }
    }

    requestAnimationFrame(() => this.frame());
  }
}
