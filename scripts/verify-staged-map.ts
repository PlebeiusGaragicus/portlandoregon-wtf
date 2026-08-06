// Release gate for the map files that Vite will publish.
//
//   npm run verify:staged-map
//   npx tsx scripts/verify-staged-map.ts /path/to/map-directory
//
// The bake validates its in-memory outputs. This script deliberately reads the
// staged files back from disk so a missing, stale, truncated, or incompatible
// artifact stops the release before the client build.
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
  decode: (bytes: Uint8Array) => string;
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
      const decoded = gunzipSync(readFileSync(path));
      const detail = artifact.decode(decoded);
      return { name: artifact.name, status: "ok", detail: `${mb(size)} gzipped; ${detail}` };
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
