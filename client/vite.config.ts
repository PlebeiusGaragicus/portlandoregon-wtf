import { defineConfig } from "vite";

// GAME_PORT lets a second, isolated stack run beside the default one
// (e.g. `npm run play`: game server on 4555, client on 5555).
const gamePort = process.env.GAME_PORT ?? "4000";

export default defineConfig({
  root: "src",
  // Relative asset URLs, so the build works wherever it is mounted: at the root
  // of portlandoregon.wtf, where the fork publishes, and at a sub-path if that
  // ever changes back. An absolute base silently 404s on a sub-path — the
  // deploy goes green and the page hangs on its own loading screen.
  base: "./",
  // src/public holds files copied verbatim into dist — the staged map assets
  // (scripts/stage-map.sh), which is how the game runs without a server.
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
