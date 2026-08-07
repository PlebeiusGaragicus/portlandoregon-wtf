# Full-city overview

The strategic overview is a dedicated cartographic rendering tier. It does not
stretch the streamed tactical scene to city scale.

## Runtime architecture

`CameraRig` computes the rotated, aspect-aware span needed to contain the map
with 8% padding. Coverage drives one continuous transition:

- below 28% coverage: perspective tactical rendering;
- 28–72%: tilt eases to top-down while the final composite atlas cross-fades;
- at 72%: perspective and orthographic ground-plane projections match, then
  the orthographic camera owns the view;
- at full reveal: tactical world, props, landmark plates, actors, effects, and
  the now-redundant minimap are retired together.

`resolveZoomTierVisibility()` is the single layer-ownership decision. If the
optional atlas fails to load, the complete tactical city remains visible; an
atlas failure must never produce an empty frame.

The overview scene contains one static plane and a screen-readable symbol
group:

- opaque composite: hillshade, water, parks, rail yards, transport,
  building-use/height color, and sub-pixel density;
- live symbols: active-fire intensity, collapsed-area clusters, and a generic
  unit/objective marker seam.

Fire markers are read-only aggregates from `FireSim`; the overview does not
duplicate simulation authority. Static landmark labels and pins intentionally
remain tactical-only so the full-city atlas stays uncluttered.

## Asset generation and staging

`scripts/bake-overview-atlas.ts` uses `@napi-rs/canvas` during the normal map
bake. It emits one composite PNG at 1024, 2048, and 4096 pixels wide, plus
`overview-atlas-v2.json`. The manifest binds the atlas to map identity, source
date, extent, dimensions, and SHA-256 hashes. The composition details and
version 1 rationale are in `docs/urban-overlay.md`.

Run:

```sh
./scripts/stage-map.sh
npm run verify:staged-map
```

Staging bakes the atlas beside the compact map artifacts and then verifies all
levels, dimensions, extents, and hashes. The client loads the manifest and one
capability-selected image without blocking tactical startup:

- handheld: 1024;
- desktop: 4096;
- either tier steps down when `MAX_TEXTURE_SIZE` requires it.

The atlas is static geography only. Dynamic state remains a compact live
overlay, so fires, collapses, units, and objectives do not trigger texture
rebakes.

## Regression coverage

- `npm run test:overview-atlas` — manifest validation and GPU-tier selection.
- `npm run test:overview-symbols` — plane transform, layer ownership,
  fire aggregation, and fallback behavior.
- `npm run test:camera` — rotated fit, transition thresholds, matched
  perspective/orthographic handoff, controls, and saved views.
- `npm run test:staged-map-gate` — malformed, missing, dimension-mismatched,
  and hash-mismatched atlas fixtures.
- `scripts/run-browser-benchmark.ts` — waits for a fully revealed real atlas
  and measures the actual fit-city orthographic tier.
- `tests/golden/full-city-overview-{desktop,mobile}.png` — desktop and portrait
  benchmark captures. Compare fresh captures with
  `scripts/compare-overview-screenshot.ts`; default tolerances are mean RGB
  delta 12 and at most 15% of pixels changing by more than 32.

## Measured baseline

Measured on 2026-08-06 in headless Chrome on Apple M2, using the staged
Portland map (43,573 × 35,780 m). These are baselines, not universal limits.

- Atlas bake: 27.6 MB for all three PNGs, down from 50.2 MB.
- Selected encoded payload: 1.71 MB handheld (1024), 19.86 MB desktop (4096).
- Selected uncompressed RGBA texture memory: 3.28 MiB handheld, 52.55 MiB
  desktop. Only one image is loaded.
- Empty desktop and portrait overview: 3 draw calls, 2 triangles, 0 points.
  Live fire, collapse, unit, and objective point counts are workload-dependent.
- Clean desktop overview frame sample: p50 16.7 ms, p95 17.1 ms.
- Emulated-mobile overview sample targets the renderer's adaptive 30 fps:
  p50 33.3 ms, p95 35.3 ms. Screenshot capture caused a one-frame outlier and
  is excluded from the steady-state budget.

Re-measure after changing atlas resolution, clustering, camera fit, or layer
ownership. In particular, the 4096 desktop image is the dominant GPU-memory
cost and should be the first tier reconsidered for lower-memory devices.
