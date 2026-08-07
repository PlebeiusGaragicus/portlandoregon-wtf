import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Canvas, ImageData, Path2D, createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import {
  BUILDING_USES,
  decodeCityLod,
  encodeCityLod,
  type GameMap,
  type Heightfield,
  type RoadClass,
} from "@battle-juice/shared";
import {
  OVERVIEW_ATLAS_MANIFEST,
  OVERVIEW_ATLAS_VERSION,
  OVERVIEW_ATLAS_WIDTHS,
  overviewAtlasFile,
  overviewAtlasHeight,
  type OverviewAtlasManifest,
  type OverviewAtlasWidth,
} from "./overview-atlas-manifest.js";

const ROAD_CLASSES: RoadClass[] = ["path", "alley", "local", "collector", "arterial"];
const ROAD_STYLE: Record<RoadClass, { color: string; minPx: number }> = {
  arterial: { color: "#d8d1bf", minPx: 2.4 },
  collector: { color: "#cec7b7", minPx: 1.9 },
  local: { color: "#c3bdaf", minPx: 1.25 },
  alley: { color: "#b8b2a6", minPx: 0.9 },
  path: { color: "#aeb7a1", minPx: 0.7 },
};
const USE_COLORS: Record<(typeof BUILDING_USES)[number], string> = {
  sfr: "#c8a97e",
  mfr: "#bc8c72",
  com: "#d0ad65",
  off: "#8ea8b3",
  ind: "#948f86",
  inst: "#9d8daf",
  other: "#aaa197",
};
const HEIGHT_BUCKETS = 4;

interface AtlasPaths {
  water: Path2D;
  parks: Path2D;
  railYards: Path2D;
  trails: Path2D;
  rails: Path2D;
  roads: Record<RoadClass, Path2D>;
  bridges: Record<RoadClass, Path2D>;
  buildings: Path2D[][];
}

function addPolyline(path: Path2D, points: [number, number][], close = false): void {
  const first = points[0];
  if (!first) return;
  path.moveTo(first[0], first[1]);
  for (let i = 1; i < points.length; i++) path.lineTo(points[i]![0], points[i]![1]);
  if (close) path.closePath();
}

function polygonPath(features: { rings: [number, number][][] }[]): Path2D {
  const path = new Path2D();
  for (const feature of features) {
    for (const ring of feature.rings) addPolyline(path, ring, true);
  }
  return path;
}

function heightBucket(height: number): number {
  if (height < 8) return 0;
  if (height < 20) return 1;
  if (height < 50) return 2;
  return 3;
}

function buildPaths(map: GameMap): AtlasPaths {
  const roads = Object.fromEntries(ROAD_CLASSES.map((kind) => [kind, new Path2D()])) as Record<RoadClass, Path2D>;
  const bridges = Object.fromEntries(ROAD_CLASSES.map((kind) => [kind, new Path2D()])) as Record<RoadClass, Path2D>;
  for (const edge of map.edges) {
    if (edge.struct === "tunnel") continue;
    addPolyline(edge.struct === "bridge" ? bridges[edge.class] : roads[edge.class], edge.polyline);
  }

  const trails = new Path2D();
  for (const trail of map.trails ?? []) addPolyline(trails, trail.polyline);
  const rails = new Path2D();
  for (const rail of map.rails ?? []) addPolyline(rails, rail.polyline);

  const buildings = Array.from({ length: BUILDING_USES.length }, () =>
    Array.from({ length: HEIGHT_BUCKETS }, () => new Path2D()),
  );
  for (const building of map.buildings) {
    const useIndex = (BUILDING_USES as readonly string[]).indexOf(building.use ?? "other");
    const use = useIndex >= 0 ? useIndex : BUILDING_USES.indexOf("other");
    const path = buildings[use]![heightBucket(building.height)]!;
    addPolyline(path, building.footprint, true);
    for (const hole of building.holes ?? []) addPolyline(path, hole, true);
  }

  return {
    water: polygonPath(map.water ?? []),
    parks: polygonPath(map.parks ?? []),
    railYards: polygonPath(map.railYards ?? []),
    trails,
    rails,
    roads,
    bridges,
    buildings,
  };
}

function setWorldTransform(ctx: SKRSContext2D, width: number, height: number, map: GameMap, dx = 0, dy = 0): void {
  ctx.setTransform(width / map.meta.width, 0, 0, -height / map.meta.height, dx, height + dy);
}

function fillWorld(
  ctx: SKRSContext2D,
  path: Path2D,
  color: string,
  width: number,
  height: number,
  map: GameMap,
): void {
  ctx.save();
  setWorldTransform(ctx, width, height, map);
  ctx.fillStyle = color;
  ctx.fill(path, "evenodd");
  ctx.restore();
}

function strokeWorld(
  ctx: SKRSContext2D,
  path: Path2D,
  color: string,
  lineWidthPx: number,
  width: number,
  height: number,
  map: GameMap,
): void {
  ctx.save();
  setWorldTransform(ctx, width, height, map);
  ctx.strokeStyle = color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  // World transform also scales the stroke. Convert the requested cartographic
  // width back to meters so every level gets the same minimum pixel weight.
  ctx.lineWidth = lineWidthPx / (width / map.meta.width);
  ctx.stroke(path);
  ctx.restore();
}

function hillshadeCanvas(hf: Heightfield): Canvas {
  const canvas = createCanvas(hf.cols, hf.rows);
  const rgba = new Uint8ClampedArray(hf.cols * hf.rows * 4);
  const light = [-0.5, 0.5, Math.SQRT1_2] as const;
  for (let py = 0; py < hf.rows; py++) {
    const row = hf.rows - 1 - py;
    const north = Math.min(hf.rows - 1, row + 1);
    const south = Math.max(0, row - 1);
    for (let col = 0; col < hf.cols; col++) {
      const east = Math.min(hf.cols - 1, col + 1);
      const west = Math.max(0, col - 1);
      const dzdx =
        ((hf.data[row * hf.cols + east]! - hf.data[row * hf.cols + west]!) * hf.scale) /
        (Math.max(1, east - west) * hf.cellSize);
      const dzdy =
        ((hf.data[north * hf.cols + col]! - hf.data[south * hf.cols + col]!) * hf.scale) /
        (Math.max(1, north - south) * hf.cellSize);
      const invLength = 1 / Math.hypot(dzdx, dzdy, 1);
      const illumination = (-dzdx * light[0] - dzdy * light[1] + light[2]) * invLength;
      const delta = Math.max(-1, Math.min(1, (illumination - light[2]) * 2.2));
      const at = (py * hf.cols + col) * 4;
      const highlight = delta >= 0;
      rgba[at] = highlight ? 255 : 45;
      rgba[at + 1] = highlight ? 255 : 43;
      rgba[at + 2] = highlight ? 245 : 39;
      rgba[at + 3] = Math.round(Math.abs(delta) * (highlight ? 75 : 105));
    }
  }
  canvas.getContext("2d").putImageData(new ImageData(rgba, hf.cols, hf.rows), 0, 0);
  return canvas;
}

function densityCanvas(map: GameMap): Canvas {
  // Reuse the existing city-LOD bake: it already captures subpixel building
  // count and maximum height in stable, map-wide cells.
  const lod = decodeCityLod(encodeCityLod(map));
  const canvas = createCanvas(lod.cols, lod.rows);
  const rgba = new Uint8ClampedArray(lod.data.length);
  for (let py = 0; py < lod.rows; py++) {
    const sourceRow = lod.rows - 1 - py;
    rgba.set(lod.data.subarray(sourceRow * lod.cols * 4, (sourceRow + 1) * lod.cols * 4), py * lod.cols * 4);
  }
  canvas.getContext("2d").putImageData(new ImageData(rgba, lod.cols, lod.rows), 0, 0);
  return canvas;
}

function drawGround(
  map: GameMap,
  paths: AtlasPaths,
  width: OverviewAtlasWidth,
  hfShade: Canvas | null,
): Canvas {
  const height = overviewAtlasHeight(width, map.meta.width, map.meta.height);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.fillStyle = "#aaa99a";
  ctx.fillRect(0, 0, width, height);
  if (hfShade) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(hfShade, 0, 0, width, height);
  }

  fillWorld(ctx, paths.water, "#5c8391", width, height, map);
  fillWorld(ctx, paths.parks, "#78866c", width, height, map);
  fillWorld(ctx, paths.railYards, "#817c72", width, height, map);

  const pxPerMeter = width / map.meta.width;
  for (const kind of ROAD_CLASSES) {
    const physicalPx = ({ arterial: 14, collector: 10, local: 8, alley: 4, path: 2 } as const)[kind] * pxPerMeter;
    strokeWorld(ctx, paths.roads[kind], ROAD_STYLE[kind].color, Math.max(ROAD_STYLE[kind].minPx, physicalPx), width, height, map);
  }
  strokeWorld(ctx, paths.trails, "#66735e", 0.9, width, height, map);
  strokeWorld(ctx, paths.rails, "#4b4b49", 1.35, width, height, map);

  // Bridges get a dark casing and a brighter deck after all other transport
  // layers, keeping river crossings legible even at the 1024-wide level.
  for (const kind of ROAD_CLASSES) {
    const physicalPx = ({ arterial: 14, collector: 10, local: 8, alley: 4, path: 2 } as const)[kind] * pxPerMeter;
    const deck = Math.max(ROAD_STYLE[kind].minPx + 0.35, physicalPx);
    strokeWorld(ctx, paths.bridges[kind], "#4f5a5d", deck + 2.6, width, height, map);
    strokeWorld(ctx, paths.bridges[kind], "#e5d9be", deck, width, height, map);
  }
  return canvas;
}

function drawUrban(map: GameMap, paths: AtlasPaths, width: OverviewAtlasWidth, density: Canvas): Canvas {
  const height = overviewAtlasHeight(width, map.meta.width, map.meta.height);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.globalAlpha = 0.36;
  ctx.drawImage(density, 0, 0, width, height);
  ctx.globalAlpha = 1;

  for (let bucket = 0; bucket < HEIGHT_BUCKETS; bucket++) {
    const offset = 0.8 + bucket * 1.15;
    ctx.save();
    setWorldTransform(ctx, width, height, map, offset, offset);
    ctx.fillStyle = `rgba(28, 31, 36, ${0.2 + bucket * 0.08})`;
    for (const usePaths of paths.buildings) ctx.fill(usePaths[bucket]!, "evenodd");
    ctx.restore();
  }

  for (let use = 0; use < BUILDING_USES.length; use++) {
    for (let bucket = 0; bucket < HEIGHT_BUCKETS; bucket++) {
      ctx.save();
      setWorldTransform(ctx, width, height, map);
      ctx.fillStyle = USE_COLORS[BUILDING_USES[use]!];
      ctx.globalAlpha = 0.7 + bucket * 0.07;
      ctx.fill(paths.buildings[use]![bucket]!, "evenodd");
      ctx.strokeStyle = "rgba(48, 46, 44, 0.7)";
      ctx.lineJoin = "round";
      ctx.lineWidth = 0.45 / (width / map.meta.width);
      ctx.stroke(paths.buildings[use]![bucket]!);
      ctx.restore();
    }
  }
  return canvas;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function bakeOverviewAtlas(map: GameMap, mapDir: string, hf: Heightfield | null): OverviewAtlasManifest {
  const paths = buildPaths(map);
  const hfShade = hf ? hillshadeCanvas(hf) : null;
  const density = densityCanvas(map);
  const levels: OverviewAtlasManifest["levels"] = [];

  for (const width of OVERVIEW_ATLAS_WIDTHS) {
    const height = overviewAtlasHeight(width, map.meta.width, map.meta.height);
    const file = overviewAtlasFile(width);
    const city = drawGround(map, paths, width, hfShade);
    city.getContext("2d").drawImage(drawUrban(map, paths, width, density), 0, 0);
    const image = city.encodeSync("png");
    writeFileSync(join(mapDir, file), image);
    levels.push({
      width,
      height,
      image: { file, sha256: sha256(image) },
    });
  }

  const manifest: OverviewAtlasManifest = {
    version: OVERVIEW_ATLAS_VERSION,
    generator: "battle-juice-overview-atlas",
    map: { name: map.meta.name, sourceDate: map.meta.sourceDate },
    extent: {
      minX: 0,
      minY: 0,
      maxX: map.meta.width,
      maxY: map.meta.height,
      width: map.meta.width,
      height: map.meta.height,
      units: "meters",
    },
    hillshade: hf !== null,
    levels,
  };
  writeFileSync(join(mapDir, OVERVIEW_ATLAS_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
