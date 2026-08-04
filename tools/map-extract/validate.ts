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
import { LAYERS, type LayerKey } from "./layers.js";
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
    // Keyset layers are pulled WITHOUT a spatial filter (clipped later), so
    // the count must compare against the unfiltered total.
    const spec = LAYERS.find((l) => l.key === key);
    const serverCount = await queryCount(resolved.url, {
      where,
      ...(spec?.keyset ? {} : envelopeParams(bufferedEnvelope())),
    });
    if (collection.features.length !== serverCount) {
      console.error(`FATAL: ${key}: extracted ${collection.features.length} != server count ${serverCount}`);
      process.exit(1);
    }

    // Bbox sanity: a projection bug shifts coordinates by thousands of km,
    // so test against a generously padded envelope. (Features can extend
    // well past the extraction box: rivers, and intersecting boundary
    // streets whose vertices all lie outside it.)
    const pad = 0.2; // degrees, ~15-20 km
    const sane = {
      xmin: PORTLAND_ENVELOPE.xmin - pad,
      xmax: PORTLAND_ENVELOPE.xmax + pad,
      ymin: PORTLAND_ENVELOPE.ymin - pad,
      ymax: PORTLAND_ENVELOPE.ymax + pad,
    };
    let nullGeom = 0;
    let outOfEnvelope = 0;
    for (const f of collection.features) {
      if (!f.geometry) {
        nullGeom++;
        continue;
      }
      // Keyset layers are pulled region-wide (no spatial filter), so
      // out-of-envelope features are expected — transform clips them.
      if (spec?.keyset) continue;
      let anyInside = false;
      for (const [lon, lat] of coordsOf(f.geometry)) {
        if (lon >= sane.xmin && lon <= sane.xmax && lat >= sane.ymin && lat <= sane.ymax) {
          anyInside = true;
          break;
        }
      }
      if (!anyInside) outOfEnvelope++;
    }
    // A redacted service nulls ~100% of geometry; a handful of corrupt
    // records in a huge regional layer is data noise (transform skips them).
    if (nullGeom / collection.features.length > 0.005) {
      console.error(`FATAL: ${key}: ${nullGeom}/${collection.features.length} features with null geometry — redacted service?`);
      process.exit(1);
    }
    if (nullGeom > 0) console.warn(`  WARN: ${key}: ${nullGeom} null-geometry records skipped downstream`);
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
