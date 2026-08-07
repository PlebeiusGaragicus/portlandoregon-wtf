export const OVERVIEW_ATLAS_VERSION = 1;
export const OVERVIEW_ATLAS_WIDTHS = [1024, 2048, 4096] as const;
export const OVERVIEW_ATLAS_MANIFEST = "overview-atlas-v1.json";

export type OverviewAtlasWidth = (typeof OVERVIEW_ATLAS_WIDTHS)[number];

export interface OverviewAtlasImage {
  file: string;
  sha256: string;
}

export interface OverviewAtlasLevel {
  width: OverviewAtlasWidth;
  height: number;
  ground: OverviewAtlasImage;
  urban: OverviewAtlasImage;
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

export function overviewAtlasHeight(width: number, mapWidth: number, mapHeight: number): number {
  if (!(mapWidth > 0) || !(mapHeight > 0)) throw new Error("overview atlas: map dimensions must be positive");
  return Math.max(1, Math.round((width * mapHeight) / mapWidth));
}

export function overviewAtlasFile(kind: "ground" | "urban", width: OverviewAtlasWidth): string {
  return `overview-${kind}-v${OVERVIEW_ATLAS_VERSION}-${width}.png`;
}
