import type { GameMap } from "@battle-juice/shared";

// Translucent minimap overlay: prerendered streets + water base, live view
// quad and unit dots. Click or drag jumps the camera.

// Backing resolution matches the hover-expanded size; CSS scales it down
// to its resting size (and back up on hover).
const WIDTH_PX = 520;

export class Minimap {
  readonly el: HTMLCanvasElement;
  private base: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private heightPx: number;
  private scale: number; // px per meter
  private dragging = false;
  private disposers: (() => void)[] = [];

  constructor(
    private map: GameMap,
    parent: HTMLElement,
    private onJump: (x: number, y: number) => void,
  ) {
    this.scale = WIDTH_PX / map.meta.width;
    this.heightPx = Math.round(map.meta.height * this.scale);

    this.el = document.createElement("canvas");
    this.el.id = "minimap";
    this.el.width = WIDTH_PX;
    this.el.height = this.heightPx;
    // Explicit CSS size — #game canvas { width:100vw } must not stretch it.
    this.el.style.width = `${WIDTH_PX}px`;
    this.el.style.height = `${this.heightPx}px`;
    parent.appendChild(this.el);
    this.ctx = this.el.getContext("2d")!;

    this.base = document.createElement("canvas");
    this.base.width = WIDTH_PX;
    this.base.height = this.heightPx;
    this.renderBase();

    const jump = (e: PointerEvent): void => {
      const rect = this.el.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * this.map.meta.width;
      const y = (1 - (e.clientY - rect.top) / rect.height) * this.map.meta.height;
      this.onJump(x, y);
    };
    const down = (e: PointerEvent): void => {
      this.dragging = true;
      this.el.setPointerCapture(e.pointerId);
      jump(e);
    };
    const move = (e: PointerEvent): void => {
      if (this.dragging) jump(e);
    };
    const up = (): void => {
      this.dragging = false;
    };
    this.el.addEventListener("pointerdown", down);
    this.el.addEventListener("pointermove", move);
    this.el.addEventListener("pointerup", up);
    this.disposers.push(
      () => this.el.removeEventListener("pointerdown", down),
      () => this.el.removeEventListener("pointermove", move),
      () => this.el.removeEventListener("pointerup", up),
    );
  }

  /** world meters -> minimap px (y flipped: world north = up). */
  private px(x: number, y: number): [number, number] {
    return [x * this.scale, this.heightPx - y * this.scale];
  }

  private renderBase(): void {
    const ctx = this.base.getContext("2d")!;
    ctx.fillStyle = "#171b22";
    ctx.fillRect(0, 0, WIDTH_PX, this.heightPx);

    const fillBodies = (bodies: { rings: [number, number][][] }[], fill: string): void => {
      for (const body of bodies) {
        const outer = body.rings[0];
        if (!outer || outer.length < 3) continue;
        ctx.beginPath();
        outer.forEach(([x, y], i) => {
          const [px, py] = this.px(x, y);
          i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        });
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.fill();
      }
    };
    fillBodies(this.map.parks ?? [], "#24382c");
    fillBodies(this.map.water ?? [], "#1d3752");

    ctx.strokeStyle = "#3d4453";
    for (const edge of this.map.edges) {
      if (edge.class === "alley" || edge.class === "path") continue;
      ctx.lineWidth = edge.class === "arterial" ? 1.2 : 0.4;
      ctx.globalAlpha = edge.class === "arterial" ? 0.9 : 0.45;
      ctx.beginPath();
      edge.polyline.forEach(([x, y], i) => {
        const [px, py] = this.px(x, y);
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      });
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Rail lines: freight in dark umber, transit in its line color.
    const railColor: Record<string, string> = {
      rail: "rgba(122, 108, 90, 0.75)",
      max: "rgba(78, 133, 224, 0.9)",
      streetcar: "rgba(82, 178, 152, 0.9)",
      wes: "rgba(148, 108, 224, 0.9)",
    };
    for (const r of this.map.rails ?? []) {
      ctx.strokeStyle = railColor[r.kind] ?? railColor["rail"]!;
      ctx.lineWidth = r.kind === "rail" ? 0.5 : 0.9;
      ctx.beginPath();
      r.polyline.forEach(([x, y], i) => {
        const [px, py] = this.px(x, y);
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      });
      ctx.stroke();
    }

    // Landmarks: small squares in their civic color, baked into the base.
    const landmarkColor: Record<string, string> = {
      "fire-station": "#e02b1d",
      police: "#3465e0",
      hospital: "#e8edf2",
      "city-hall": "#e0ab41",
    };
    for (const m of this.map.landmarks ?? []) {
      if (m.kind === "school") continue; // lighter tier: no minimap dot
      const [px, py] = this.px(m.x, m.y);
      ctx.fillStyle = landmarkColor[m.kind] ?? "#e02b1d";
      ctx.fillRect(px - 1.8, py - 1.8, 3.6, 3.6);
      ctx.strokeStyle = "rgba(20, 23, 28, 0.8)";
      ctx.lineWidth = 0.6;
      ctx.strokeRect(px - 1.8, py - 1.8, 3.6, 3.6);
    }
  }

  /**
   * Redraw overlay: the camera's view quad (ground corners) + unit dots.
   */
  update(
    viewCorners: ({ x: number; y: number } | null)[],
    units: { own: boolean; x: number; y: number }[],
  ): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, WIDTH_PX, this.heightPx);
    ctx.drawImage(this.base, 0, 0);

    if (viewCorners.every((c) => c !== null)) {
      ctx.beginPath();
      viewCorners.forEach((c, i) => {
        const [px, py] = this.px(c!.x, c!.y);
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      });
      ctx.closePath();
      ctx.strokeStyle = "rgba(240, 244, 255, 0.85)";
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.fillStyle = "rgba(240, 244, 255, 0.07)";
      ctx.fill();
    }

    for (const u of units) {
      const [px, py] = this.px(u.x, u.y);
      ctx.beginPath();
      ctx.arc(px, py, 2.4, 0, Math.PI * 2);
      ctx.fillStyle = u.own ? "#6f96ff" : "#ff7a6d";
      ctx.fill();
    }
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.el.remove();
  }
}
