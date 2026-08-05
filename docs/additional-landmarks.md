# Additional GIS layers — survey & extraction backlog

Surveyed 2026-08-05 by enumerating every ArcGIS service on our three known
hosts (`?f=json` layer listings + `returnCountOnly` counts inside the map
bounds). This file is the standing menu for future extraction work: what
exists, where it lives, what's already in the game, and exactly how to add
more.

**In-bounds envelope used for all counts:** `-122.86, 45.33, -122.3016, 45.6536`
(the whole-metro `portland` profile — see `tools/map-extract/config.ts`).

## Hosts we use (all public, no keys)

| Host | What it is | Query style |
|---|---|---|
| `https://www.portlandmaps.com/od/rest/services/` | City of Portland open-data MapServers (`COP_OpenData_*`) | classic MapServer, envelope pagination |
| `https://www.portlandmaps.com/arcgis/rest/services/Public/` | City "Public" services (Public_Safety_Places, Transit, Crime, …) | classic MapServer |
| `https://gis.oregonmetro.gov/arcgis/rest/services/` | Metro regional GIS (RLIS-derived OpenData) | classic MapServer |
| `https://services2.arcgis.com/McQ0OlIABe29rJJy/…` | Metro RLIS on ArcGIS Online (buildings2/parks/trails already use it) | FeatureServer, keyset pagination |

### Etiquette (non-negotiable, already encoded in `lib/arcgis.ts`)

- Honest User-Agent with contact email (`config.ts` `USER_AGENT`).
- Sequential requests, ≥350 ms apart (`RATE.minDelayMs`).
- Extract **once**, cache in `data/raw/{date}-{profile}/` (gitignored), work
  offline from there. The game server never calls these hosts at runtime.
- OSM Overpass is used only as an advisory cross-check for scraped landmark
  points; failures degrade to warnings.

## Already implemented

| Layer | Source | Baked as | Count (2026-08-04 bake) |
|---|---|---|---|
| Streets, buildings, signs, signals, trees, water, lights | COP layers (see `layers.ts`) | core map | — |
| Regional buildings/parks/trails | RLIS AGOL | core map | — |
| **Railroads (freight)** | Metro `TransitDataWebMerc/9` | `map.rails` kind `rail` | 3,041 segments |
| **Railroad yards** | Metro `TransitDataWebMerc/10` | `map.railYards` | 22 polygons |
| **MAX / streetcar / WES lines** | Metro `TransitDataWebMerc/6` (`STATUS='Existing'`) | `map.rails` kinds `max`/`streetcar`/`wes` | 140 segments |
| **MAX / streetcar / WES stops** | Metro `TransitDataWebMerc/5` (`STATUS='Existing'`) | `map.railStops` | 159 stops |
| **Fire stations** | `Public_Safety_Places/0`, district `PORTLAND%` | `map.landmarks` kind `fire-station` | 31 scraped |
| **Police facilities** | `Public_Safety_Places/1` | kind `police` | 10 scraped |
| **Hospitals** | `Public_Safety_Places/2` | kind `hospital` | 19 scraped |
| **City halls** | Metro `PlacesDataWebMerc/0` (label derived from CITY — layer has no name field) | kind `city-hall` | 30 scraped |

76 landmarks land in the play area after clipping; 75 match a building
footprint (unmatched: PeaceHealth Southwest — it's in Vancouver WA, outside
both footprint databases).

## How to add more (the two patterns)

**Pattern A — pipeline layer** (lines/polygons/bulk points → baked into the
map): add a spec to `tools/map-extract/layers.ts` (service, `idSeed`,
`namePattern`, fields, optional `where`), a transform function in
`transform.ts` (copy `transformRails` / `transformPolys` /
`transformRailStops`), a type in `shared/src/map.ts`, rendering in
`client/src/render/world.ts`. Then:

```sh
npm run discover -w tools/map-extract                      # resolves ids, writes endpoints.json
EXTRACT_DATE=<raw-dir-date> npm run extract -w tools/map-extract <keys…>
EXTRACT_DATE=<raw-dir-date> NODE_OPTIONS=--max-old-space-size=8192 npm run transform -w tools/map-extract
EXTRACT_DATE=<raw-dir-date> NODE_OPTIONS=--max-old-space-size=8192 npm run build-map -w tools/map-extract
```

`EXTRACT_DATE` pins the `data/raw/{date}-portland/` directory so new layers
join the cached streets/buildings extraction instead of re-pulling them.

**Pattern B — landmark scrape** (small named point sets → committed
`data/landmarks.json`): add a fetcher in
`tools/map-extract/scrape-landmarks.ts`, extend the `Landmark["kind"]` union
in `shared/src/map.ts`, add a theme in `client/src/render/world.ts`
`LANDMARK_THEMES` and a minimap color. Building-footprint matching, plates,
pads and tinting all come free. Run `npm run scrape-landmarks -w
tools/map-extract`, then re-run build-map.

## Backlog (verified layers, in-bounds counts)

### High game value

| Layer | Endpoint | Count | Notes / game idea |
|---|---|---|---|
| Schools | `Public/Public_Safety_Places/MapServer/3` | 831 | Too many for name plates — bake as a building-use overlay or rally points. Metro `PlacesDataWebMerc/5` is the regional alternative. |
| Bridges / River bridges | `COP_OpenData_Transportation/MapServer/79` + `/80` | 520 / 13 | Decks already render via streets; this adds *identity* — name the 13 Willamette crossings, make them targetable chokepoints. |
| Transit centers | Metro `TransitDataWebMerc/3` | 13 | Hubs if MAX becomes troop fast-travel. |
| Aerial tram | Metro `TransitDataWebMerc/4` | 1 | OHSU tram. Pattern A, kind `tram`. |
| Tier One Critical Facilities | `COP_OpenData_ImportantPlaces/MapServer/39` | 121 | The city's own disaster-priority list — a pre-made objective set. |
| Grocery stores | `COP_OpenData_ImportantPlaces/MapServer/40` | 158 | Breadline phase supply caches. |
| Libraries / community centers | Metro `PlacesDataWebMerc/4` / `/1` | 42 / 62 | More civic landmarks, same Pattern B. |
| Airports | Metro `PlacesDataWebMerc/6` | 6 polygons | PDX + Troutdale etc — reinforcement arrival zones. |
| Regional police stations | `COP_OpenData_ImportantPlaces/MapServer/41` | 17 | Regional complement to PPB's 10 (Gresham, Milwaukie…). Dedup vs kind `police` by proximity. |

### Terrain / hazard (bigger lifts)

| Layer | Endpoint | Count | Notes |
|---|---|---|---|
| Elevation | **DONE** — USGS 3DEP 1/3" DEM (`fetch-dem.ts`), not the city contours | 1453×1193 @ 30 m | Baked to `data/maps/portland-heightmap.bin.gz`; terrain mesh with water/park/yard vertex tinting; streets/rails draped; STRUC_TYPE 21/23 span as bridges, 32 hidden as tunnels. Contours/LiDAR remain if we ever want finer than 10 m. |
| FEMA flood areas / 1996 flood extent | `COP_OpenData_PublicSafetyHazards/MapServer/116` / `/93` | — | Scenario material: river floods, low ground impassable. |
| Landslide hazard | `…PublicSafetyHazards/MapServer/1422` | — | West Hills terrain flavor. |
| Police districts (PPB) | `…PublicSafetyHazards/MapServer/254` | — | Territory-control boundaries. |
| Neighborhood boundaries | `COP_OpenData_Boundary/MapServer/3` | — | Capture-zone territory names. |

### Street-level dressing (cheap Pattern A adds)

Sidewalks (`/77`), curbs (`/74`), bike network (`/75`), speed limits
(`/225`), parking meters (`/58`), street furniture (`/1398`), drinking
fountains (`COP_OpenData_Utilities/84`), heritage trees
(`COP_OpenData_Environment/26`, 463) — all on the COP Transportation /
Environment / Utilities services.

### Curiosities (no gameplay use, worth knowing)

- Historic aerial photos 1925–2025 (`Public/Aerial_Photos_*`, tile services).
- Willamette bathymetry 1888/2001/2003/2005 (`COP_OpenData_Environment`).
- Historic trolley routes (`COP_OpenData_Transportation/272`).
- Live MAX/bus vehicle positions (`Public/Transit/MapServer/11`, `/10`) —
  real-time, so not extractable, but fun.

## Full service directory (for future sweeps)

- `COP_OpenData_*` services: ARPA, Boundary, CityProjects, Environment,
  ImportantPlaces, Miscellaneous, PlanningDevelopment, Property,
  PublicSafetyHazards, Transportation, Utilities, ZoningCode.
- `Public/*`: ~200 services — notable: `Public_Safety_Places`, `Transit`,
  `Crime`, `Parks_*` (20+ amenity layers: sports courts, skate parks, docks,
  community gardens), `Natural_Hazards`, `Zoning`.
- Metro `OpenData/*`: BoundaryDataWebMerc, MajorRiversData,
  PlacesDataWebMerc, TransitDataWebMerc.
- DCAT catalog for keyword sweeps: `https://gis-pdx.opendata.arcgis.com/api/feed/dcat-us/1.1.json`.
