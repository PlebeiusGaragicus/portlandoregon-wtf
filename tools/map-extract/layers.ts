// Layer roster. Layer IDs are seeds only — DISCOVER re-resolves them by name
// match against the service's live layer list on every run (IDs drift).

const TRANSPORT = "https://www.portlandmaps.com/od/rest/services/COP_OpenData_Transportation/MapServer";
const PROPERTY = "https://www.portlandmaps.com/od/rest/services/COP_OpenData_Property/MapServer";

export type LayerKey = "streets" | "buildings" | "signs" | "signals" | "trees" | "water";

export interface LayerSpec {
  key: LayerKey;
  service: string;
  idSeed: number | null; // null = endpoint must come from DCAT discovery (trees)
  namePattern: RegExp;
  fields: string[];
  /** Field whose population rate must be checked before the game depends on it. */
  populationChecks: string[];
  /** Optional server-side filter applied at extraction (signs whitelist). */
  where?: () => string | null;
}

export const LAYERS: LayerSpec[] = [
  {
    key: "streets",
    service: TRANSPORT,
    idSeed: 68,
    namePattern: /^streets?$/i,
    fields: [
      "PDX_F_NODE",
      "PDX_T_NODE",
      "F_ZLEV",
      "T_ZLEV",
      "FULL_NAME",
      "TYPE",
      "CFCC",
      "STRUC_TYPE",
    ],
    populationChecks: ["PDX_F_NODE", "PDX_T_NODE"],
  },
  {
    key: "buildings",
    service: PROPERTY,
    idSeed: 184,
    // NB: the service also has /48 "Building Footprints" (3x the records —
    // likely every outbuilding); /184 "Buildings" is the doc-verified layer.
    namePattern: /^buildings$/i,
    fields: ["NUM_STORY", "MAX_HEIGHT", "AVG_HEIGHT", "BLDG_USE", "YEAR_BUILT"],
    populationChecks: ["MAX_HEIGHT", "NUM_STORY"],
  },
  {
    key: "signs",
    service: TRANSPORT,
    idSeed: 223,
    namePattern: /^signs$/i,
    fields: ["SignType", "SignCode", "Rotation"],
    populationChecks: ["SignCode"],
  },
  {
    key: "signals",
    service: TRANSPORT,
    idSeed: 54,
    namePattern: /^traffic\s*signals?$/i,
    fields: ["SignalNum"],
    populationChecks: [],
  },
  {
    key: "trees",
    // Resolved from the DCAT catalog by DISCOVER: "Street Tree Inventory -
    // Active Records" on COP_OpenData_Environment (point layer).
    service: "https://www.portlandmaps.com/od/rest/services/COP_OpenData_Environment/MapServer",
    idSeed: 1415,
    namePattern: /^street\s*tree\s*inventory/i,
    fields: ["SPECIES", "DIAMETER", "MATURE_SIZE"],
    populationChecks: ["DIAMETER"],
  },
  {
    key: "water",
    // Found via DCAT sweep: river surface polygons (render-only).
    service: "https://www.portlandmaps.com/od/rest/services/COP_OpenData_PublicSafetyHazards/MapServer",
    idSeed: 95,
    namePattern: /ordinary high water/i,
    fields: [],
    populationChecks: [],
  },
];

export function layer(key: LayerKey): LayerSpec {
  const spec = LAYERS.find((l) => l.key === key);
  if (!spec) throw new Error(`unknown layer ${key}`);
  return spec;
}
