import type { Snapshot } from "./sim.js";

export type ClientMsg =
  | { type: "join"; name: string; password: string }
  | { type: "input"; entityId: string; target: { x: number; y: number } };

export type ServerMsg =
  | { type: "welcome"; playerId: string; token: string; snapshot: Snapshot }
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "error"; reason: string };

export function parseClientMsg(raw: string): ClientMsg | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (m.type === "join" && typeof m.name === "string" && typeof m.password === "string") {
    return { type: "join", name: m.name.slice(0, 24), password: m.password };
  }
  if (
    m.type === "input" &&
    typeof m.entityId === "string" &&
    typeof m.target === "object" &&
    m.target !== null
  ) {
    const t = m.target as Record<string, unknown>;
    if (typeof t.x === "number" && typeof t.y === "number" && isFinite(t.x) && isFinite(t.y)) {
      return { type: "input", entityId: m.entityId.slice(0, 64), target: { x: t.x, y: t.y } };
    }
  }
  return null;
}
