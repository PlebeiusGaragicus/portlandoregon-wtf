import { fileURLToPath } from "node:url";
import { join } from "node:path";

// Play area, WGS84 (Pearl District / downtown core, per MAP-PLAN §2).
export const DISTRICT = { xmin: -122.685, ymin: 45.515, xmax: -122.665, ymax: 45.527 };

// Extract from a slightly larger box, build the graph, then clip — clipping
// first severs edges and fragments the graph (catalogued failure mode).
export const BUFFER_DEG = 0.002; // ≈ 160–220 m

// Every extracted coordinate must fall inside Portland's real envelope —
// catches projection mistakes instantly.
export const PORTLAND_ENVELOPE = { xmin: -122.86, ymin: 45.43, xmax: -122.47, ymax: 45.65 };

// Etiquette (MAP-PLAN §3): sequential requests, ~3 req/s, honest UA.
export const RATE = { minDelayMs: 350 };
export const USER_AGENT =
  "battle-juice-map-extract/0.1 (personal game project; mayor@portlandoregon.wtf)";

// Sign codes to keep, mapped to game sign kinds — the deliberate human step
// after VERIFY prints the histograms (recorded in the manifest). Portland's
// SignCode is MUTCD without the dash: R1010 = R1-1 (STOP, SignType 1250
// regulatory, ~16k citywide); G5500/G5501 = street-name blades (SignType 1220
// guide, the most numerous sign in the city). Empty = signs extraction
// refuses to run.
export const SIGN_KEEP: Record<string, "stop" | "street-name" | "other"> = {
  R1010: "stop",
  G5500: "street-name",
  G5501: "street-name",
};

export const HEIGHT_PER_STORY_M = 3.5; // fallback when MAX_HEIGHT is null

export const DCAT_CATALOG = "https://gis-pdx.opendata.arcgis.com/api/feed/dcat-us/1.1.json";

// Paths (repo-root-relative, resolved from this file).
const HERE = fileURLToPath(new URL(".", import.meta.url));
export const REPO_ROOT = join(HERE, "..", "..");
export const DATA_DIR = join(REPO_ROOT, "data");
export const ENDPOINTS_FILE = join(DATA_DIR, "endpoints.json");
export const MANIFEST_FILE = join(DATA_DIR, "MANIFEST.json");
export const MAP_OUT_FILE = join(REPO_ROOT, "shared", "src", "maps", "pearl.ts");

/** Extraction date used for data/raw/{date} and data/processed/{date}. */
export function extractDate(): string {
  return process.env.EXTRACT_DATE ?? new Date().toISOString().slice(0, 10);
}

export function rawDir(): string {
  return join(DATA_DIR, "raw", extractDate());
}

export function processedDir(): string {
  return join(DATA_DIR, "processed", extractDate());
}

export function bufferedEnvelope() {
  return {
    xmin: DISTRICT.xmin - BUFFER_DEG,
    ymin: DISTRICT.ymin - BUFFER_DEG,
    xmax: DISTRICT.xmax + BUFFER_DEG,
    ymax: DISTRICT.ymax + BUFFER_DEG,
  };
}
