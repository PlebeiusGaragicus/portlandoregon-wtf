import { defineConfig } from "vite";

export default defineConfig({
  root: "src",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/ws": {
        target: "ws://localhost:4000",
        ws: true,
      },
    },
  },
});
