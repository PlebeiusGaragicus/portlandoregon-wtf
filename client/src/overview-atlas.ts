export const OVERVIEW_ATLAS_VERSION = 2;
export const OVERVIEW_ATLAS_WIDTHS = [1024, 2048, 4096] as const;
export const OVERVIEW_ATLAS_MANIFEST = "overview-atlas-v2.json";

export type OverviewAtlasWidth = (typeof OVERVIEW_ATLAS_WIDTHS)[number];

export interface OverviewAtlasImage {
  file: string;
  sha256: string;
}

export interface OverviewAtlasLevel {
  width: OverviewAtlasWidth;
  height: number;
  image: OverviewAtlasImage;
}

export interface OverviewAtlasManifest {
  version: typeof OVERVIEW_ATLAS_VERSION;
  generator: "battle-juice-overview-atlas";
  map: {
    name: string;
    sourceDate: string;
  };
  extent: {
    minX: 0;
    minY: 0;
    maxX: number;
    maxY: number;
    width: number;
    height: number;
    units: "meters";
  };
  hillshade: boolean;
  levels: OverviewAtlasLevel[];
}

export interface OverviewAtlasSource {
  manifest: OverviewAtlasManifest;
  /** Absolute directory URL ending in a slash. */
  baseUrl: string;
}

export interface OverviewAtlasLevelCaps {
  handheld: boolean;
  maxTextureSize: number;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`overview atlas: ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`overview atlas: ${label} must be finite`);
  }
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`overview atlas: ${label} must be a non-empty string`);
  }
  return value;
}

function expectedHeight(width: number, mapWidth: number, mapHeight: number): number {
  return Math.max(1, Math.round((width * mapHeight) / mapWidth));
}

function image(value: unknown, width: OverviewAtlasWidth): OverviewAtlasImage {
  const raw = record(value, `${width} city image`);
  const file = string(raw["file"], `${width} city filename`);
  const expected = `overview-city-v${OVERVIEW_ATLAS_VERSION}-${width}.png`;
  if (file !== expected) throw new Error(`overview atlas: ${width} city filename must be ${expected}`);
  const sha256 = string(raw["sha256"], `${width} city SHA-256`);
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(`overview atlas: ${width} city SHA-256 is invalid`);
  }
  return { file, sha256 };
}

/**
 * Parse the network payload instead of trusting a type assertion. A bad or
 * stale optional atlas must fall back to the tactical renderer, not stretch
 * an unrelated image across the city.
 */
export function parseOverviewAtlasManifest(value: unknown): OverviewAtlasManifest {
  const raw = record(value, "manifest");
  if (raw["version"] !== OVERVIEW_ATLAS_VERSION) {
    throw new Error(`overview atlas: unsupported version ${String(raw["version"])}`);
  }
  if (raw["generator"] !== "battle-juice-overview-atlas") {
    throw new Error("overview atlas: unknown generator");
  }

  const map = record(raw["map"], "map identity");
  const name = string(map["name"], "map name");
  const sourceDate = string(map["sourceDate"], "map source date");
  const extent = record(raw["extent"], "extent");
  const minX = finite(extent["minX"], "extent minX");
  const minY = finite(extent["minY"], "extent minY");
  const maxX = finite(extent["maxX"], "extent maxX");
  const maxY = finite(extent["maxY"], "extent maxY");
  const width = finite(extent["width"], "extent width");
  const height = finite(extent["height"], "extent height");
  if (
    minX !== 0 ||
    minY !== 0 ||
    maxX !== width ||
    maxY !== height ||
    width <= 0 ||
    height <= 0 ||
    extent["units"] !== "meters"
  ) {
    throw new Error("overview atlas: extent must be a positive zero-origin meter rectangle");
  }
  if (typeof raw["hillshade"] !== "boolean") {
    throw new Error("overview atlas: hillshade flag must be boolean");
  }
  if (!Array.isArray(raw["levels"]) || raw["levels"].length !== OVERVIEW_ATLAS_WIDTHS.length) {
    throw new Error(`overview atlas: expected ${OVERVIEW_ATLAS_WIDTHS.length} levels`);
  }

  const levels: OverviewAtlasLevel[] = [];
  const seen = new Set<number>();
  for (const candidate of raw["levels"]) {
    const level = record(candidate, "level");
    const levelWidth = finite(level["width"], "level width");
    if (!OVERVIEW_ATLAS_WIDTHS.includes(levelWidth as OverviewAtlasWidth)) {
      throw new Error(`overview atlas: unsupported level width ${levelWidth}`);
    }
    const atlasWidth = levelWidth as OverviewAtlasWidth;
    if (seen.has(atlasWidth)) throw new Error(`overview atlas: duplicate ${atlasWidth} level`);
    seen.add(atlasWidth);
    const levelHeight = finite(level["height"], `${atlasWidth} level height`);
    const expected = expectedHeight(atlasWidth, width, height);
    if (levelHeight !== expected) {
      throw new Error(`overview atlas: ${atlasWidth} level height is ${levelHeight}, expected ${expected}`);
    }
    levels.push({
      width: atlasWidth,
      height: levelHeight,
      image: image(level["image"], atlasWidth),
    });
  }
  levels.sort((a, b) => a.width - b.width);

  return {
    version: OVERVIEW_ATLAS_VERSION,
    generator: "battle-juice-overview-atlas",
    map: { name, sourceDate },
    extent: { minX: 0, minY: 0, maxX, maxY, width, height, units: "meters" },
    hillshade: raw["hillshade"],
    levels,
  };
}

/**
 * Phones use the 1024 image (roughly 3.5 MB of RGBA GPU memory); larger devices
 * prefer 4096. The WebGL texture limit can step either class down to the
 * largest complete level the GPU can accept.
 */
export function selectOverviewAtlasLevel(
  manifest: OverviewAtlasManifest,
  caps: OverviewAtlasLevelCaps,
): OverviewAtlasLevel {
  const preferred = caps.handheld ? 1024 : 4096;
  const ceiling = Math.min(preferred, Math.floor(caps.maxTextureSize));
  const level = [...manifest.levels]
    .sort((a, b) => b.width - a.width)
    .find((candidate) => candidate.width <= ceiling && candidate.height <= caps.maxTextureSize);
  if (!level) throw new Error(`overview atlas: no level fits max texture size ${caps.maxTextureSize}`);
  return level;
}
