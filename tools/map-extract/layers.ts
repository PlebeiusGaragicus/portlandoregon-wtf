// Layer roster. Layer IDs are seeds only — DISCOVER re-resolves them by name
// match against the service's live layer list on every run (IDs drift).

const TRANSPORT = "https://www.portlandmaps.com/od/rest/services/COP_OpenData_Transportation/MapServer";
const PROPERTY = "https://www.portlandmaps.com/od/rest/services/COP_OpenData_Property/MapServer";

export type LayerKey =
  | "streets"
  | "buildings"
  | "buildings2" // RLIS regional footprints (outside Portland city limits)
  | "signs"
  | "signals"
  | "trees"
  | "water"
  | "parks"
  | "trails"
  | "lights"
  | "rails"
  | "railyards"
  | "maxlines"
  | "maxstops";

const RLIS = "https://services2.arcgis.com/McQ0OlIABe29rJJy/arcgis/rest/services";
// Metro regional GIS (classic MapServer, same query API as portlandmaps).
// Full layer survey: docs/additional-landmarks.md.
const METRO_TRANSIT = "https://gis.oregonmetro.gov/arcgis/rest/services/OpenData/TransitDataWebMerc/MapServer";

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
  /** Cursor pagination on the object-id field, without a spatial filter
   * (fast path for AGOL hosted layers; transform clips to the box). */
  keyset?: boolean;
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
  {
    key: "buildings2",
    keyset: true,
    // Metro RLIS regional footprints — same height schema as Portland's
    // layer; covers Gresham/Clackamas etc. Portland-area duplicates are
    // dropped at transform time (centroid-proximity dedup vs COP).
    service: `${RLIS}/Building_Footprint_Database/FeatureServer`,
    idSeed: 8,
    namePattern: /footprint/i,
    fields: ["BLDG_TYPE", "BLDG_USE", "NUM_STORY", "MAX_HEIGHT", "AVG_HEIGHT"],
    populationChecks: ["MAX_HEIGHT"],
  },
  {
    key: "parks",
    keyset: true,
    // Regional parks/greenspace polygons (ORCA).
    service: `${RLIS}/Outdoor_Recreation_and_Conservation_Areas_ORCA/FeatureServer`,
    idSeed: 5,
    namePattern: /orca|outdoor recreation/i,
    fields: ["SITENAME", "UNITTYPE"],
    populationChecks: [],
  },
  {
    key: "trails",
    keyset: true,
    // Regional trails (Forest Park, Springwater Corridor, ...). Render-only.
    service: `${RLIS}/Trails/FeatureServer`,
    idSeed: 0,
    namePattern: /^trails?$/i,
    fields: ["TRAILNAME", "TRLSURFACE", "STATUS"],
    populationChecks: [],
  },
  {
    key: "lights",
    service: "https://www.portlandmaps.com/od/rest/services/COP_OpenData_Transportation/MapServer",
    idSeed: 258,
    namePattern: /^street ?lights$/i,
    fields: [],
    populationChecks: [],
  },
  {
    key: "rails",
    // Heavy/freight rail centerlines (BNSF, UP, ...). Render-only.
    service: METRO_TRANSIT,
    idSeed: 9,
    namePattern: /^railroads$/i,
    fields: ["OWNER", "OWNER_ABRV"],
    populationChecks: [],
  },
  {
    key: "railyards",
    service: METRO_TRANSIT,
    idSeed: 10,
    namePattern: /^railroad yards$/i,
    fields: ["NAME", "OWNER_ABRV"],
    populationChecks: [],
  },
  {
    key: "maxlines",
    // MAX light rail + Portland Streetcar + WES. STATUS filters out
    // planned/proposed alignments at extraction time.
    service: METRO_TRANSIT,
    idSeed: 6,
    namePattern: /^light rail.*lines$/i,
    fields: ["STATUS", "TYPE", "LINE", "TUNNEL"],
    populationChecks: ["TYPE"],
    where: () => `STATUS = 'Existing'`,
  },
  {
    key: "maxstops",
    service: METRO_TRANSIT,
    idSeed: 5,
    namePattern: /^light rail.*stops$/i,
    fields: ["STATUS", "TYPE", "LINE", "STATION"],
    populationChecks: ["TYPE", "STATION"],
    where: () => `STATUS = 'Existing'`,
  },
];

export function layer(key: LayerKey): LayerSpec {
  const spec = LAYERS.find((l) => l.key === key);
  if (!spec) throw new Error(`unknown layer ${key}`);
  return spec;
}
