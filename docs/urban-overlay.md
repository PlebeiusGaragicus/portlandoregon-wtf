# Urban overlay

The urban overlay is the single detailed image used by the full-city strategic
view. It is an offline cartographic render of Portland, not a screenshot of the
live Three.js scene.

## Why it is one image

Version 1 shipped two textures:

1. an opaque ground atlas containing terrain and transport;
2. a transparent urban atlas containing building density and footprints.

The ground texture began fading in before the urban texture. That briefly
replaced detailed tactical rendering with a simpler map before detail returned,
which made zooming out feel backward.

Version 2 composites those sources during the offline bake. The browser now
loads one opaque `overview-city-v2-<width>.png` and performs one direct
crossfade:

```text
live tactical city  →  final detailed city overlay
```

There is no ground-only visual phase and no second atlas texture at runtime.

## Offline bake

`scripts/bake-overview-atlas.ts` builds reusable paths from the extracted map,
then renders each 1024, 2048, and 4096 level in this order:

1. neutral terrain base;
2. DEM-derived hillshade;
3. water, parks, and rail yards;
4. class-weighted roads, trails, rails, and cased bridge crossings;
5. sub-pixel building density from the city LOD;
6. height-bucket shadows;
7. individual building footprints colored by use and outlined for separation.

The former transparent urban canvas is drawn over the ground canvas before PNG
encoding. The result is opaque and self-contained.

`overview-atlas-v2.json` records map identity, source date, extent, hillshade
availability, dimensions, filenames, and SHA-256 hashes. A stale or mismatched
atlas is rejected rather than stretched across another map.

Run the production path with:

```sh
./scripts/stage-map.sh
npm run verify:staged-map
```

Staging removes obsolete atlas versions, bakes version 2, rereads every PNG,
checks dimensions and hashes, and only then allows the client build to proceed.

## Runtime

`client/src/mapdata.ts` loads the optional version 2 manifest without blocking
tactical startup. `selectOverviewAtlasLevel()` chooses:

- 1024 on handheld devices;
- 4096 on desktop;
- the largest lower level when the GPU texture limit requires it.

`client/src/render/overview.ts` loads exactly one selected PNG onto one
depth-independent plane covering the map extent. The renderer applies the same
day/night tint to the complete image.

Camera coverage drives its opacity. From 28% to 72% coverage, camera tilt eases
to top-down while this final composite fades in. At full opacity, the tactical
world retires and the orthographic camera owns the view. If loading fails, the
tactical city remains visible, so the transition cannot end on a blank frame.

Live fire, collapse, unit, and objective markers remain separate point
overlays. They represent changing gameplay state and are never baked into the
static image.

## Measured cost

Portland is 43,573 × 35,780 meters. The version 2 bake measured:

- all three encoded PNGs: 27.6 MB, down from 50.2 MB for version 1;
- handheld 1024 image: 1.71 MB encoded, 3.28 MiB uncompressed RGBA;
- 2048 image: 6.02 MB encoded, 13.14 MiB uncompressed RGBA;
- desktop 4096 image: 19.86 MB encoded, 52.55 MiB uncompressed RGBA.

Only one level is downloaded and uploaded. Compared with the two-texture
format, selected GPU texture memory is halved and the six PNGs become three.

## Regression coverage

- `npm run test:overview-atlas` validates version 2 parsing and level choice.
- `npm run test:staged-map-gate` exercises missing, malformed, wrong-size, and
  hash-mismatched composite assets.
- `npm run test:overview-symbols` verifies transition ownership and fallback.
- `scripts/run-browser-benchmark.ts` waits for a fully opaque composite before
  measuring and can capture desktop or portrait golden images.
