# Future CI proposal

This document is intentionally not wired into `.github/workflows/` yet.

## Fast pull-request gate

Run on every pull request:

1. `npm ci`
2. `npm run typecheck`
3. `npm run build`
4. Correctness scripts that use synthetic data or checked-in compact assets:
   `test-city`, `test-controls`, `test-grid`, `test-mapbin`, `test-pack`,
   `test-props-evict`, `test-scars`, `test-seal`, `test-tilekeys`, and
   `test-view`.

Keep this gate deterministic. Geometry hashes and quantisation tolerances are
correctness checks; wall-clock timings are not.

## Map-backed integration gate

Run when map codecs, baking, or rendering change:

- Bake all versioned stores from the staged source map.
- Decode each artifact and assert count, tile partition, coordinate tolerance,
  and encode/decode equivalence.
- Build/evict/revisit representative building, dressing, and prop windows.
- Verify far-box/prism exclusivity, retained scar/collapse appearance, glow
  coverage, and stable Three.js resource counts.
- Reject generated artifacts whose format version does not match the reader.

The large source extract should come from a versioned CI artifact or cache,
not Git history.

## Browser lifecycle gate

Serve the production build and drive Chrome through the existing DevTools
benchmark runner. Add focused assertions for:

- exactly one animation loop after `visibilitychange`, `pagehide`, and
  `pageshow`;
- prop and tile resource counts returning to their prior plateau after repeat
  churn;
- WebGL context loss preventing default and restoration rebuilding/reloading
  the compact stores;
- zoom-only changes refreshing independent building/dressing/prop windows;
- worker results with stale generation IDs being rejected.

Collect the JSON benchmark artifact on every run for trend analysis.

## Optional performance gate

Performance thresholds should run on a pinned runner and initially report
without blocking:

- cold full-fill under 3,000 ms;
- desktop p95 frame interval under 20 ms and mobile-tier p95 at or below 35 ms
  in idle, night-wide, active-fire, and FPV;
- no more than 10 long tasks and no long task above 500 ms after boot;
- final JS-heap signal no more than 10% above the pre-pan sample;
- resource counts stable after a second identical pan/revisit loop.

Promote a metric to blocking only after its variance is known. Browser JS heap
is not total tab memory; periodically validate the budget with Chrome process
metrics and physical iPhone-class hardware outside CI.
