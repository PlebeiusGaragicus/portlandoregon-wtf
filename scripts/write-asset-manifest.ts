// Write map/assets.json: what the city consists of, and what each piece
// hashes to.
//
//   npx tsx scripts/write-asset-manifest.ts [map-directory]
//
// The client keeps the map in Cache Storage between visits, so it needs a way
// to tell "the copy I already have" from "the copy that is published now"
// without downloading 44 MB to find out. This manifest is that way: it is
// small, it is fetched with no-store on every boot, and a changed digest is
// what invalidates a cached file. One re-baked artifact therefore costs one
// re-download, not a cold load.
//
// Written after verify-staged-map.ts has passed, so the hashes can only ever
// describe artifacts that already decoded cleanly. It hashes the bytes on
// disk rather than anything the bake held in memory — the whole point is to
// describe what will actually be served.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const DEFAULT_MAP_DIR = resolve(REPO_ROOT, "client/src/public/map");

export const ASSET_MANIFEST = "assets.json";
export const ASSET_MANIFEST_VERSION = 1;

export interface AssetEntry {
  bytes: number;
  sha256: string;
}

export interface AssetManifest {
  version: number;
  generator: "portlandoregon-city-assets";
  map: { name: string; sourceDate: string };
  files: Record<string, AssetEntry>;
}

/** Map identity, so a manifest can be recognised as describing a different
 * city at a glance. Digests alone would invalidate everything anyway; this is
 * for the human reading the file and for the boot log. */
function mapIdentity(mapDir: string): { name: string; sourceDate: string } {
  const raw: unknown = JSON.parse(gunzipSync(readFileSync(resolve(mapDir, "map-lite.json.gz"))).toString("utf8"));
  const meta = (raw as { meta?: Record<string, unknown> }).meta ?? {};
  return {
    name: typeof meta.name === "string" ? meta.name : "",
    sourceDate: typeof meta.sourceDate === "string" ? meta.sourceDate : "",
  };
}

export function buildAssetManifest(mapDir = DEFAULT_MAP_DIR): AssetManifest {
  const files: Record<string, AssetEntry> = {};
  // Sorted so the manifest is byte-stable across machines: an unstable file
  // would churn in git and defeat its own caching on every deploy.
  for (const name of readdirSync(mapDir).sort()) {
    if (name === ASSET_MANIFEST || name.startsWith(".")) continue;
    const path = resolve(mapDir, name);
    if (!statSync(path).isFile()) continue;
    const bytes = readFileSync(path);
    files[name] = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  if (Object.keys(files).length === 0) throw new Error(`no map artifacts found in ${mapDir}`);
  return {
    version: ASSET_MANIFEST_VERSION,
    generator: "portlandoregon-city-assets",
    map: mapIdentity(mapDir),
    files,
  };
}

export function writeAssetManifest(mapDir = DEFAULT_MAP_DIR): AssetManifest {
  const manifest = buildAssetManifest(mapDir);
  writeFileSync(resolve(mapDir, ASSET_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const mapDir = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_MAP_DIR;
  const manifest = writeAssetManifest(mapDir);
  const total = Object.values(manifest.files).reduce((sum, file) => sum + file.bytes, 0);
  console.log(
    `wrote ${ASSET_MANIFEST}: ${Object.keys(manifest.files).length} files, ` +
      `${(total / 1e6).toFixed(1)} MB (map "${manifest.map.name}", ${manifest.map.sourceDate})`,
  );
}
