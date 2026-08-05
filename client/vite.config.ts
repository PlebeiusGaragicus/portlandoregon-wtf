import { defineConfig } from "vite";

// GAME_PORT lets a second, isolated stack run beside the default one
// (e.g. `npm run play`: game server on 4555, client on 5555).
const gamePort = process.env.GAME_PORT ?? "4000";

export default defineConfig({
  root: "src",
  // src/public holds files copied verbatim into dist — notably CNAME, which
  // GitHub Pages needs on every deploy or the custom domain gets cleared.
  publicDir: "public",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/ws": {
        target: `ws://localhost:${gamePort}`,
        ws: true,
      },
      "/map": {
        target: `http://localhost:${gamePort}`,
      },
      "/heightmap": {
        target: `http://localhost:${gamePort}`,
      },
    },
  },
});
