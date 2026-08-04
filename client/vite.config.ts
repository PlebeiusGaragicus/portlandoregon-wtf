import { defineConfig } from "vite";

// GAME_PORT lets a second, isolated stack run beside the default one
// (e.g. `npm run play`: game server on 4555, client on 5555).
const gamePort = process.env.GAME_PORT ?? "4000";

export default defineConfig({
  root: "src",
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
    },
  },
});
