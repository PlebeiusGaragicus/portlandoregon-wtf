// Stage 3 — EXTRACT. Paginated, envelope-filtered pulls into data/raw/{date}/.
// Buffered box (clip happens after graph build), requested fields only.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bufferedEnvelope, rawDir, SIGN_KEEP } from "./config.js";
import { LAYERS, type LayerKey } from "./layers.js";
import { extractPaginated, layerInfo } from "./lib/arcgis.js";
import { readEndpoints, requireLayer } from "./lib/endpoints.js";

const requested = process.argv.slice(2) as LayerKey[];
const keys: LayerKey[] = requested.length ? requested : ["streets", "buildings"];

function whereFor(key: LayerKey): string | undefined {
  if (key !== "signs") return undefined;
  const codes = Object.keys(SIGN_KEEP);
  if (codes.length === 0) {
    console.error("FATAL: SIGN_KEEP is empty — run verify, pick sign codes, fill config.ts first.");
    process.exit(1);
  }
  return `SignCode IN (${codes.map((c) => `'${c.replace(/'/g, "''")}'`).join(",")})`;
}

async function main(): Promise<void> {
  const eps = readEndpoints();
  mkdirSync(rawDir(), { recursive: true });

  for (const key of keys) {
    const spec = LAYERS.find((l) => l.key === key);
    if (!spec) {
      console.error(`unknown layer ${key}`);
      process.exit(1);
    }
    const resolved = requireLayer(eps, key);
    console.log(`extracting ${key} from ${resolved.url}${spec.keyset ? " (keyset)" : ""}`);
    const orderField = spec.keyset ? (await layerInfo(resolved.url)).objectIdField : undefined;
    const collection = await extractPaginated(resolved.url, {
      fields: spec.fields,
      envelope: bufferedEnvelope(),
      where: whereFor(key),
      pageSize: resolved.maxRecordCount,
      orderField,
    });
    const outFile = join(rawDir(), `${key}.geojson`);
    writeFileSync(outFile, JSON.stringify(collection));
    console.log(`  wrote ${collection.features.length} features -> ${outFile}`);
  }
}

await main();
