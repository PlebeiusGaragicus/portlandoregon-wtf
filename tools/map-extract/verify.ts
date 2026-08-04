// Stage 2 — VERIFY. The single most important check: confirm geometry is
// real. A layer can report healthy counts and still return null geometry on
// every feature (redacted services). Also: field-population stats before the
// renderer depends on a field, and the SignType histogram for SIGN_KEEP.
import { bufferedEnvelope } from "./config.js";
import { LAYERS, type LayerKey } from "./layers.js";
import { envelopeParams, qs, queryCount, queryStats, throttledGet, type GeoJsonCollection } from "./lib/arcgis.js";
import { readEndpoints } from "./lib/endpoints.js";

const only = process.argv[2] as LayerKey | undefined;

async function main(): Promise<void> {
  const eps = readEndpoints();

  for (const spec of LAYERS) {
    if (only && spec.key !== only) continue;
    const resolved = eps.layers[spec.key];
    if (!resolved) {
      if (spec.key === "trees") {
        console.log(`trees: unresolved — skipping (pick a DCAT candidate in endpoints.json)`);
        continue;
      }
      console.error(`FATAL: ${spec.key} not in endpoints.json — run discover.`);
      process.exit(1);
    }

    // Geometry check: pull 3 features WITH geometry, assert 100% present.
    const sample = (await throttledGet(
      `${resolved.url}/query?${qs({
        where: "1=1",
        outFields: "*",
        f: "geojson",
        resultRecordCount: 3,
        outSR: "4326",
        ...envelopeParams(bufferedEnvelope()),
      })}`,
    )) as GeoJsonCollection;
    const total = sample.features.length;
    const withGeom = sample.features.filter((f) => f.geometry != null).length;
    if (total === 0) {
      console.error(`FATAL: ${spec.key}: zero features in the district envelope`);
      process.exit(1);
    }
    if (withGeom !== total) {
      console.error(`FATAL: ${spec.key}: ${total - withGeom}/${total} sampled features have NULL geometry — redacted service?`);
      process.exit(1);
    }
    console.log(`${spec.key}: geometry OK (${withGeom}/${total} sampled)`);

    // Field population rates (citywide — that is what the stats reflect).
    for (const field of spec.populationChecks) {
      const nonNull = await queryCount(resolved.url, { where: `${field} IS NOT NULL` });
      const rate = ((nonNull / resolved.citywideCount) * 100).toFixed(1);
      console.log(`  ${field}: ${rate}% populated (${nonNull}/${resolved.citywideCount})`);
    }

    // Sign-type histogram: the input for the human SIGN_KEEP decision.
    if (spec.key === "signs") {
      console.log("  SignType histogram (top 30, citywide):");
      const stats = await queryStats(resolved.url, "SignType");
      stats.sort((a, b) => b.count - a.count);
      for (const s of stats.slice(0, 30)) console.log(`    ${String(s.value).padEnd(24)} ${s.count}`);
      console.log("  -> fill SIGN_KEEP in config.ts with the types to keep.");
    }
  }
}

await main();
