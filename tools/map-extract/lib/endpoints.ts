import { readFileSync } from "node:fs";
import { ENDPOINTS_FILE } from "../config.js";
import type { LayerKey } from "../layers.js";

export interface ResolvedLayer {
  url: string;
  id: number;
  name: string;
  maxRecordCount: number;
  citywideCount: number;
}

export interface Endpoints {
  resolvedAt: string;
  layers: Partial<Record<LayerKey, ResolvedLayer>>;
  trees: { status: "resolved" | "unresolved"; candidates: { title: string; url: string }[] };
}

export function readEndpoints(): Endpoints {
  try {
    return JSON.parse(readFileSync(ENDPOINTS_FILE, "utf8")) as Endpoints;
  } catch {
    console.error("FATAL: data/endpoints.json missing or unreadable — run `npm run discover` first.");
    process.exit(1);
  }
}

export function requireLayer(eps: Endpoints, key: LayerKey): ResolvedLayer {
  const l = eps.layers[key];
  if (!l) {
    console.error(`FATAL: layer "${key}" not resolved in endpoints.json — run discover (and for trees, pick a candidate).`);
    process.exit(1);
  }
  return l;
}
