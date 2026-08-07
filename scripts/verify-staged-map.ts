// Release gate for the map files that Vite will publish.
//
//   npm run verify:staged-map
//   npx tsx scripts/verify-staged-map.ts /path/to/map-directory
//
// The bake validates its in-memory outputs. This script deliberately reads the
// staged files back from disk so a missing, stale, truncated, or incompatible
// artifact stops the release before the client build.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  decodeBuildings,
  decodeCityLod,
  decodeHeightfield,
  decodeLayers,
  decodeProps,
  decodeStreets,
  LAYER_NAMES,
} from "@battle-juice/shared";
import {
  OVERVIEW_ATLAS_MANIFEST,
  OVERVIEW_ATLAS_VERSION,
  OVERVIEW_ATLAS_WIDTHS,
  overviewAtlasFile,
  overviewAtlasHeight,
} from "./overview-atlas-manifest.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const DEFAULT_MAP_DIR = resolve(REPO_ROOT, "client/src/public/map");

export interface ArtifactResult {
  name: string;
  status: "ok" | "missing-optional" | "failed";
  detail: string;
}

interface Artifact {
  name: string;
  optional?: boolean;
  compressed?: boolean;
  decode: (bytes: Uint8Array, mapDir: string) => string;
}

function object(value: unknown, description: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${description} is not an object`);
  return value as Record<string, unknown>;
}

function finite(value: unknown, description: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${description} is not a finite number`);
  return value;
}

function pngDimensions(bytes: Buffer, file: string): { width: number; height: number } {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature) || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error(`${file} is not a PNG with an IHDR`);
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function verifyOverviewAtlas(bytes: Uint8Array, mapDir: string): string {
  const manifest = object(JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown, "overview manifest");
  if (manifest.version !== OVERVIEW_ATLAS_VERSION) {
    throw new Error(`manifest version is ${String(manifest.version)}, expected ${OVERVIEW_ATLAS_VERSION}`);
  }
  if (manifest.generator !== "battle-juice-overview-atlas") throw new Error("manifest generator is missing or unknown");

  const mapLite = object(
    JSON.parse(gunzipSync(readFileSync(resolve(mapDir, "map-lite.json.gz"))).toString("utf8")) as unknown,
    "map-lite",
  );
  const meta = object(mapLite.meta, "map-lite metadata");
  const mapWidth = finite(meta.width, "map width");
  const mapHeight = finite(meta.height, "map height");
  const mapName = typeof meta.name === "string" ? meta.name : "";
  const sourceDate = typeof meta.sourceDate === "string" ? meta.sourceDate : "";

  const manifestMap = object(manifest.map, "manifest map");
  if (manifestMap.name !== mapName || manifestMap.sourceDate !== sourceDate) {
    throw new Error("manifest map identity does not match map-lite");
  }
  const extent = object(manifest.extent, "manifest extent");
  const expectedExtent: Record<string, number | string> = {
    minX: 0,
    minY: 0,
    maxX: mapWidth,
    maxY: mapHeight,
    width: mapWidth,
    height: mapHeight,
    units: "meters",
  };
  for (const [key, expected] of Object.entries(expectedExtent)) {
    if (extent[key] !== expected) throw new Error(`manifest extent ${key} is ${String(extent[key])}, expected ${expected}`);
  }

  if (!Array.isArray(manifest.levels) || manifest.levels.length !== OVERVIEW_ATLAS_WIDTHS.length) {
    throw new Error(`manifest must contain exactly ${OVERVIEW_ATLAS_WIDTHS.length} levels`);
  }
  const seen = new Set<number>();
  let totalBytes = 0;
  for (const width of OVERVIEW_ATLAS_WIDTHS) {
    const rawLevel = manifest.levels.find((candidate) => object(candidate, "atlas level").width === width);
    const level = object(rawLevel, `${width}-wide atlas level`);
    if (seen.has(width)) throw new Error(`duplicate ${width}-wide atlas level`);
    seen.add(width);
    const expectedHeight = overviewAtlasHeight(width, mapWidth, mapHeight);
    if (level.height !== expectedHeight) {
      throw new Error(`${width}-wide atlas height is ${String(level.height)}, expected ${expectedHeight}`);
    }
    const image = object(level.image, `${width}-wide city image`);
    const expectedFile = overviewAtlasFile(width);
    if (image.file !== expectedFile) throw new Error(`${width}-wide city filename must be ${expectedFile}`);
    if (typeof image.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(image.sha256)) {
      throw new Error(`${expectedFile} has an invalid SHA-256`);
    }
    const imagePath = resolve(mapDir, expectedFile);
    if (!existsSync(imagePath)) throw new Error(`${expectedFile} is missing`);
    const png = readFileSync(imagePath);
    const dimensions = pngDimensions(png, expectedFile);
    if (dimensions.width !== width || dimensions.height !== expectedHeight) {
      throw new Error(
        `${expectedFile} is ${dimensions.width}x${dimensions.height}, expected ${width}x${expectedHeight}`,
      );
    }
    const digest = createHash("sha256").update(png).digest("hex");
    if (digest !== image.sha256) throw new Error(`${expectedFile} SHA-256 does not match the manifest`);
    totalBytes += png.length;
  }
  return `${OVERVIEW_ATLAS_WIDTHS.length} composite levels, ${mb(totalBytes)} PNG`;
}

const artifacts: Artifact[] = [
  {
    name: "buildings.bin.gz",
    decode: (bytes) => {
      const store = decodeBuildings(bytes);
      return `${store.count.toLocaleString()} buildings`;
    },
  },
  {
    name: "props.bin.gz",
    decode: (bytes) => {
      const store = decodeProps(bytes);
      return `${store.count.toLocaleString()} props`;
    },
  },
  {
    name: "streets.bin.gz",
    decode: (bytes) => {
      const store = decodeStreets(bytes);
      return `${store.edgeCount.toLocaleString()} edges, ${store.nodeCount.toLocaleString()} nodes`;
    },
  },
  {
    name: "layers.bin.gz",
    decode: (bytes) => {
      const stores = decodeLayers(bytes);
      const count = LAYER_NAMES.reduce((sum, name) => sum + stores[name].count, 0);
      return `${count.toLocaleString()} features across ${LAYER_NAMES.length} layers`;
    },
  },
  {
    name: "city-lod.bin.gz",
    decode: (bytes) => {
      const lod = decodeCityLod(bytes);
      return `${lod.cols}x${lod.rows} texels`;
    },
  },
  {
    name: "map-lite.json.gz",
    decode: (bytes) => {
      const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("decoded JSON is not an object");
      }
      const meta = (value as Record<string, unknown>).meta;
      if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
        throw new Error("decoded map has no metadata object");
      }
      const name = (meta as Record<string, unknown>).name;
      return typeof name === "string" && name ? `map "${name}"` : "map metadata";
    },
  },
  {
    name: "heightmap.bin.gz",
    optional: true,
    decode: (bytes) => {
      // Buffer views can start partway through a pooled ArrayBuffer. Copy so
      // the heightfield decoder sees exactly the decompressed payload.
      const heightfield = decodeHeightfield(Uint8Array.from(bytes).buffer);
      return `${heightfield.cols}x${heightfield.rows} samples`;
    },
  },
  {
    name: OVERVIEW_ATLAS_MANIFEST,
    compressed: false,
    decode: verifyOverviewAtlas,
  },
];

const mb = (bytes: number): string => `${(bytes / 1e6).toFixed(1)} MB`;

export function verifyStagedMap(mapDir = DEFAULT_MAP_DIR): ArtifactResult[] {
  return artifacts.map((artifact) => {
    const path = resolve(mapDir, artifact.name);
    if (!existsSync(path)) {
      return artifact.optional
        ? { name: artifact.name, status: "missing-optional", detail: "absent; client uses flat terrain" }
        : { name: artifact.name, status: "failed", detail: "required artifact is missing" };
    }

    try {
      const size = statSync(path).size;
      if (size === 0) throw new Error("file is empty");
      const file = readFileSync(path);
      const decoded = artifact.compressed === false ? file : gunzipSync(file);
      const detail = artifact.decode(decoded, mapDir);
      const storage = artifact.compressed === false ? mb(size) : `${mb(size)} gzipped`;
      return { name: artifact.name, status: "ok", detail: `${storage}; ${detail}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { name: artifact.name, status: "failed", detail: message };
    }
  });
}

export function reportStagedMap(results: ArtifactResult[]): boolean {
  for (const result of results) {
    const marker = result.status === "ok" ? "ok  " : result.status === "missing-optional" ? "skip" : "FAIL";
    const output = `${marker} ${result.name} — ${result.detail}`;
    if (result.status === "failed") console.error(output);
    else console.log(output);
  }
  return results.every((result) => result.status !== "failed");
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3) {
    console.error("usage: npx tsx scripts/verify-staged-map.ts [map-directory]");
    process.exitCode = 2;
  } else {
    const mapDir = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_MAP_DIR;
    console.log(`Verifying staged map in ${mapDir}`);
    if (!reportStagedMap(verifyStagedMap(mapDir))) process.exitCode = 1;
  }
}
