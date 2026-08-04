// Stage 1 — DISCOVER. Never trust hardcoded layer IDs (they drift): resolve
// every layer by name against the service's live layer list, sweep the DCAT
// catalog for the street-trees dataset, write data/endpoints.json.
import { mkdirSync, writeFileSync } from "node:fs";
import { DATA_DIR, DCAT_CATALOG, ENDPOINTS_FILE } from "./config.js";
import { LAYERS } from "./layers.js";
import { layerInfo, queryCount, throttledGet } from "./lib/arcgis.js";

interface ResolvedLayer {
  url: string;
  id: number;
  name: string;
  maxRecordCount: number;
  citywideCount: number;
}

interface Endpoints {
  resolvedAt: string;
  layers: Partial<Record<string, ResolvedLayer>>;
  trees: { status: "resolved" | "unresolved"; candidates: { title: string; url: string }[] };
}

async function resolveFromService(
  service: string,
  namePattern: RegExp,
  idSeed: number | null,
): Promise<ResolvedLayer | null> {
  const listing = (await throttledGet(`${service}/layers?f=json`)) as {
    layers?: { id: number; name: string }[];
  };
  const layers = listing.layers ?? [];
  // Prefer the seed if its name still matches; otherwise first name match.
  const seed = layers.find((l) => l.id === idSeed);
  const match = seed && namePattern.test(seed.name) ? seed : layers.find((l) => namePattern.test(l.name));
  if (!match) return null;
  const url = `${service}/${match.id}`;
  const info = await layerInfo(url);
  const citywideCount = await queryCount(url);
  return { url, id: match.id, name: match.name, maxRecordCount: info.maxRecordCount, citywideCount };
}

async function sweepDcatForTrees(): Promise<{ title: string; url: string }[]> {
  const catalog = (await throttledGet(DCAT_CATALOG)) as {
    dataset?: { title?: string; keyword?: string[]; distribution?: { accessURL?: string; format?: string }[] }[];
  };
  const candidates: { title: string; url: string }[] = [];
  for (const ds of catalog.dataset ?? []) {
    const text = `${ds.title ?? ""} ${(ds.keyword ?? []).join(" ")}`;
    if (!/\btrees?\b|\bcanopy\b/i.test(text)) continue;
    const rest = (ds.distribution ?? []).find(
      (d) => d.accessURL && /rest\/services.*(Map|Feature)Server/i.test(d.accessURL),
    );
    if (rest?.accessURL) candidates.push({ title: ds.title ?? "?", url: rest.accessURL });
  }
  return candidates;
}

async function main(): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });
  const out: Endpoints = {
    resolvedAt: new Date().toISOString(),
    layers: {},
    trees: { status: "unresolved", candidates: [] },
  };

  for (const spec of LAYERS) {
    if (spec.key === "trees" && !spec.service) continue; // not yet picked from the DCAT sweep
    process.stdout.write(`resolving ${spec.key}… `);
    const resolved = await resolveFromService(spec.service, spec.namePattern, spec.idSeed);
    if (!resolved) {
      console.error(`FATAL: could not resolve layer "${spec.key}" (${spec.namePattern}) on ${spec.service}`);
      process.exit(1);
    }
    out.layers[spec.key] = resolved;
    if (spec.key === "trees") out.trees.status = "resolved";
    console.log(`-> /${resolved.id} "${resolved.name}" (${resolved.citywideCount} citywide, page ${resolved.maxRecordCount})`);
  }

  console.log("sweeping DCAT catalog for tree datasets…");
  out.trees.candidates = await sweepDcatForTrees();
  console.log(`  ${out.trees.candidates.length} candidate(s):`);
  for (const c of out.trees.candidates) console.log(`  - ${c.title}\n      ${c.url}`);
  console.log(
    "  Pick the street-trees POINT layer, add it to endpoints.json as layers.trees (url/id/name),\n" +
      '  set trees.status = "resolved", then re-run verify.',
  );

  writeFileSync(ENDPOINTS_FILE, JSON.stringify(out, null, 2) + "\n");
  console.log(`wrote ${ENDPOINTS_FILE}`);
}

await main();
