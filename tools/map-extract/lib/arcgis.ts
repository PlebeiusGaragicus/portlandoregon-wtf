// Rate-limited ArcGIS REST helpers. Every request in the pipeline goes through
// throttledGet — sequential, delayed, honest User-Agent (MAP-PLAN §3).
import { RATE, USER_AGENT } from "../config.js";

let lastRequestAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function throttledGet(url: string): Promise<unknown> {
  // Transient server hiccups (empty ArcGIS errors, 5xx) get retried with
  // backoff — one flaky response must not kill a multi-hundred-page pull.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await sleep(2000 * 2 ** (attempt - 1));
    const wait = lastRequestAt + RATE.minDelayMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      const json = (await res.json()) as { error?: { message?: string } };
      if (json && typeof json === "object" && json.error) {
        throw new Error(`ArcGIS error from ${url}: ${json.error.message ?? JSON.stringify(json.error)}`);
      }
      return json;
    } catch (err) {
      lastErr = err;
      process.stderr.write(`\n  retrying (${attempt + 1}/5): ${String(err).slice(0, 120)}\n`);
    }
  }
  throw lastErr;
}

export function qs(params: Record<string, string | number>): string {
  return Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
}

export interface Envelope {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}

export function envelopeParams(env: Envelope): Record<string, string> {
  return {
    geometry: JSON.stringify({ ...env, spatialReference: { wkid: 4326 } }),
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
  };
}

export async function queryCount(layerUrl: string, extra: Record<string, string> = {}): Promise<number> {
  const json = (await throttledGet(
    `${layerUrl}/query?${qs({ where: "1=1", returnCountOnly: "true", f: "json", ...extra })}`,
  )) as { count?: number };
  if (typeof json.count !== "number") throw new Error(`no count from ${layerUrl}`);
  return json.count;
}

/** Value histogram of a field via groupByFieldsForStatistics. */
export async function queryStats(
  layerUrl: string,
  groupBy: string,
): Promise<{ value: string | number | null; count: number }[]> {
  const json = (await throttledGet(
    `${layerUrl}/query?${qs({
      where: "1=1",
      groupByFieldsForStatistics: groupBy,
      outStatistics: JSON.stringify([
        { statisticType: "count", onStatisticField: "OBJECTID", outStatisticFieldName: "n" },
      ]),
      f: "json",
    })}`,
  )) as { features?: { attributes: Record<string, string | number | null> }[] };
  return (json.features ?? []).map((f) => ({
    value: f.attributes[groupBy] ?? null,
    count: Number(f.attributes["n"] ?? 0),
  }));
}

export interface LayerInfo {
  id: number;
  name: string;
  maxRecordCount: number;
  fields: { name: string; type: string }[];
  geometryType: string;
  objectIdField: string;
}

export async function layerInfo(layerUrl: string): Promise<LayerInfo> {
  const json = (await throttledGet(`${layerUrl}?f=json`)) as {
    id?: number;
    name?: string;
    maxRecordCount?: number;
    fields?: { name: string; type: string }[];
    geometryType?: string;
  };
  return {
    id: json.id ?? -1,
    name: json.name ?? "?",
    maxRecordCount: json.maxRecordCount ?? 200,
    fields: json.fields ?? [],
    geometryType: json.geometryType ?? "?",
    objectIdField: (json as { objectIdField?: string }).objectIdField ?? "OBJECTID",
  };
}

export interface GeoJsonFeature {
  type: "Feature";
  geometry: { type: string; coordinates: unknown } | null;
  properties: Record<string, unknown>;
}

export interface GeoJsonCollection {
  type: "FeatureCollection";
  features: GeoJsonFeature[];
}

/**
 * Paginated extraction. Two modes:
 * - offset (default): resultOffset pages with a server-side envelope filter.
 * - keyset (orderField set): cursor on the object-id field with NO spatial
 *   filter — AGOL hosted layers answer id-range scans ~50x faster than
 *   spatially filtered deep pages (which also 400 at deep offsets). The
 *   transform stage clips to the play area anyway.
 * Termination requires BOTH signals: an empty/short batch AND no
 * exceededTransferLimit flag — either alone is unreliable.
 */
export async function extractPaginated(
  layerUrl: string,
  opts: { fields: string[]; envelope: Envelope; where?: string; pageSize: number; orderField?: string },
): Promise<GeoJsonCollection> {
  const all: GeoJsonFeature[] = [];
  let offset = 0;
  let cursor = -Infinity;
  for (;;) {
    const outFields = opts.fields.length
      ? [...new Set([...(opts.orderField ? [opts.orderField] : []), ...opts.fields])].join(",")
      : "*";
    const params: Record<string, string | number> = {
      outFields,
      outSR: "4326",
      f: "geojson",
      resultRecordCount: opts.pageSize,
    };
    if (opts.orderField) {
      const rangeWhere = cursor === -Infinity ? "1=1" : `${opts.orderField}>${cursor}`;
      params["where"] = opts.where ? `(${opts.where}) AND ${rangeWhere}` : rangeWhere;
      params["orderByFields"] = opts.orderField;
    } else {
      params["where"] = opts.where ?? "1=1";
      params["resultOffset"] = offset;
      Object.assign(params, envelopeParams(opts.envelope));
    }
    const json = (await throttledGet(`${layerUrl}/query?${qs(params)}`)) as GeoJsonCollection & {
      exceededTransferLimit?: boolean;
      properties?: { exceededTransferLimit?: boolean };
    };
    const batch = json.features ?? [];
    all.push(...batch);
    const exceeded = json.exceededTransferLimit === true || json.properties?.exceededTransferLimit === true;
    process.stdout.write(`\r  ${layerUrl.split("/").slice(-1)[0]}: ${all.length} features…`);
    if (opts.orderField && batch.length > 0) {
      const last = batch[batch.length - 1]!.properties[opts.orderField];
      if (typeof last !== "number") throw new Error(`keyset cursor field ${opts.orderField} missing from results`);
      cursor = last;
    }
    if (batch.length === 0 && !exceeded) break;
    if (batch.length < opts.pageSize && !exceeded) break;
    offset += batch.length;
  }
  process.stdout.write("\n");
  return { type: "FeatureCollection", features: all };
}
