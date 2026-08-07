// Loads the active game map. Large maps live as gzipped JSON assets in
// data/maps/ (built by tools/map-extract); if the requested one is missing,
// falls back to the bundled central map so a fresh clone still runs.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { activeMap, type GameMap } from "@portlandoregon/shared";

const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../..");

export interface LoadedMap {
  map: GameMap;
  /** Pre-gzipped JSON, served to clients at /map with Content-Encoding: gzip. */
  gz: Buffer;
}

export function loadActiveMap(): LoadedMap {
  const name = process.env.GAME_MAP ?? "portland";
  const file = join(REPO_ROOT, "data", "maps", `${name}.json.gz`);
  if (existsSync(file)) {
    const gz = readFileSync(file);
    const map = JSON.parse(gunzipSync(gz).toString("utf8")) as GameMap;
    console.log(`map: ${map.meta.name} (${map.meta.width}x${map.meta.height} m) from ${file}`);
    return { map, gz };
  }
  console.log(`map: ${activeMap.meta.name} (bundled fallback — data/maps/${name}.json.gz not found)`);
  return { map: activeMap, gz: gzipSync(JSON.stringify(activeMap)) };
}
