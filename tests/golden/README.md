# Full-city overview golden images

These fixtures are captured by `scripts/run-browser-benchmark.ts` after it
enters the fully revealed orthographic overview. Compare a fresh capture with
`scripts/compare-overview-screenshot.ts`; the comparator permits small
cross-GPU antialiasing differences but rejects missing layers, framing changes,
and large color regressions.
