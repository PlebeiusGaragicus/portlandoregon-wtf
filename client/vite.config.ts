import { defineConfig } from "vite";

// GAME_PORT lets a second, isolated stack run beside the default one
// (e.g. `npm run play`: game server on 4555, client on 5555).
const gamePort = process.env.GAME_PORT ?? "4000";

export default defineConfig({
  root: "src",
  // Relative asset URLs, so the build works wherever it is mounted: at the root
  // of play.internal.invalid, and at internal.invalid/battle-juice/ when the fork has
  // no custom domain yet. An absolute base silently 404s on the sub-path — the
  // deploy goes green and the page hangs on its own loading screen.
  base: "./",
  // src/public holds files copied verbatim into dist — notably CNAME, which
  // GitHub Pages needs on every deploy or the custom domain gets cleared.
  publicDir: "public",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      // The map is a static asset now (src/public/map, staged by
      // scripts/stage-map.sh), so only live game traffic needs proxying.
      "/ws": {
        target: `ws://localhost:${gamePort}`,
        ws: true,
      },
    },
  },
});
