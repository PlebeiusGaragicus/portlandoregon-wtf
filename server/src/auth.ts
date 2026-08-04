import { randomBytes, timingSafeEqual } from "node:crypto";

function password(): string {
  return process.env.GAME_PASSWORD ?? "";
}

export function passwordConfigured(): boolean {
  return password().length > 0;
}

export function checkPassword(attempt: string): boolean {
  if (!passwordConfigured()) return false;
  const a = Buffer.from(attempt);
  const b = Buffer.from(password());
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function issueToken(): string {
  return randomBytes(16).toString("hex");
}
