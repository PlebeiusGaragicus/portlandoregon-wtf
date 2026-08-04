// Stage 4 — VALIDATE. Fail loudly: extracted count == server count for the
// same envelope+where, 100% non-null geometry, every coordinate inside
// Portland's real envelope (catches projection mistakes instantly).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  bufferedEnvelope,
  DISTRICT,
  extractDate,
  MANIFEST_FILE,
  PORTLAND_ENVELOPE,
  SIGN_KEEP,
} from "./config.js";
import { type LayerKey } from "./layers.js";
import { envelopeParams, queryCount, type GeoJsonCollection } from "./lib/arcgis.js";
import { readEndpoints, requireLayer } from "./lib/endpoints.js";
import { rawDir } from "./config.js";

const requested = process.argv.slice(2) as LayerKey[];
const keys: LayerKey[] = requested.length ? requested : ["streets", "buildings"];

function* coordsOf(geometry: { type: string; coordinates: unknown }): Generator<[number, number]> {
  const walk = function* (c: unknown): Generator<[number, number]> {
    if (Array.isArray(c) && typeof c[0] === "number") {
      yield [c[0] as number, c[1] as number];
    } else if (Array.isArray(c)) {
      for (const child of c) yield* walk(child);
    }
  };
  yield* walk(geometry.coordinates);
}

async function main(): Promise<void> {
  const eps = readEndpoints();
  const manifest: Record<string, unknown> = existsSync(MANIFEST_FILE)
    ? (JSON.parse(readFileSync(MANIFEST_FILE, "utf8")) as Record<string, unknown>)
    : {};
  const layersOut = (manifest["layers"] as Record<string, unknown>) ?? {};

  for (const key of keys) {
    const resolved = requireLayer(eps, key);
    const file = join(rawDir(), `${key}.geojson`);
    if (!existsSync(file)) {
      console.error(`FATAL: ${file} missing — run extract first.`);
      process.exit(1);
    }
    const raw = readFileSync(file, "utf8");
    const collection = JSON.parse(raw) as GeoJsonCollection;

    const where =
      key === "signs" && Object.keys(SIGN_KEEP).length
        ? `SignCode IN (${Object.keys(SIGN_KEEP).map((c) => `'${c.replace(/'/g, "''")}'`).join(",")})`
        : "1=1";
    const serverCount = await queryCount(resolved.url, {
      where,
      ...envelopeParams(bufferedEnvelope()),
    });
    if (collection.features.length !== serverCount) {
      console.error(`FATAL: ${key}: extracted ${collection.features.length} != server count ${serverCount}`);
      process.exit(1);
    }

    let nullGeom = 0;
    let outOfEnvelope = 0;
    for (const f of collection.features) {
      if (!f.geometry) {
        nullGeom++;
        continue;
      }
      for (const [lon, lat] of coordsOf(f.geometry)) {
        if (
          lon < PORTLAND_ENVELOPE.xmin ||
          lon > PORTLAND_ENVELOPE.xmax ||
          lat < PORTLAND_ENVELOPE.ymin ||
          lat > PORTLAND_ENVELOPE.ymax
        ) {
          outOfEnvelope++;
          break;
        }
      }
    }
    if (nullGeom > 0) {
      console.error(`FATAL: ${key}: ${nullGeom} features with null geometry`);
      process.exit(1);
    }
    if (outOfEnvelope > 0) {
      console.error(`FATAL: ${key}: ${outOfEnvelope} features outside Portland's envelope — projection bug?`);
      process.exit(1);
    }

    console.log(`${key}: OK — ${collection.features.length} features, count matches server, geometry 100%, bbox sane`);
    layersOut[key] = {
      endpoint: resolved.url,
      layerName: resolved.name,
      features: collection.features.length,
      sha256: createHash("sha256").update(raw).digest("hex"),
    };
  }

  manifest["extractDate"] = extractDate();
  manifest["district"] = DISTRICT;
  manifest["bufferedEnvelope"] = bufferedEnvelope();
  manifest["layers"] = layersOut;
  if (Object.keys(SIGN_KEEP).length) manifest["signKeep"] = SIGN_KEEP;
  writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`updated ${MANIFEST_FILE}`);
}

await main();
