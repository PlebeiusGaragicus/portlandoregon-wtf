import "./env.js";
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { parseClientMsg, type ServerMsg } from "@battle-juice/shared";
import { checkPassword, issueToken, passwordConfigured } from "./auth.js";
import { loadActiveMap } from "./map.js";
import { Room } from "./room.js";

const loadedMap = loadActiveMap();

const PORT = Number(process.env.PORT ?? 4000);
const REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../..");
const clientDist = join(fileURLToPath(new URL(".", import.meta.url)), "../../client/dist");

// The frontend is hosted on GitHub Pages (internal.invalid/battle-juice/), a
// different origin from this server — so /map and /heightmap need CORS headers,
// and the WebSocket upgrade needs its own Origin check (WS is exempt from CORS,
// so the browser will happily let a foreign page connect; we say no here
// instead). ALLOWED_ORIGINS (comma-separated) extends the list without a code
// change — which is how a future game host gets added.
const ALLOWED_ORIGINS = new Set(
  [
    "https://internal.invalid",
    "https://game.internal.invalid",
    ...(process.env.ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim()),
  ].filter(Boolean),
);

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/** No Origin header at all = same-origin fetch or a non-browser client. */
function allowedOrigin(origin: string | undefined): boolean {
  return !origin || ALLOWED_ORIGINS.has(origin) || LOCAL_ORIGIN.test(origin);
}

/** Echo the caller's origin when we trust it (never `*` — the map is gated). */
function corsHeaders(origin: string | undefined): Record<string, string> {
  if (!origin || !allowedOrigin(origin)) return {};
  return { "access-control-allow-origin": origin, vary: "Origin" };
}

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const httpServer = createServer((req, res) => {
  const url = (req.url ?? "/").split("?")[0] ?? "/";
  const cors = corsHeaders(req.headers.origin);
  // Plain GETs don't preflight today, but answer OPTIONS anyway so adding a
  // header to a client fetch later doesn't silently break the Pages build.
  if (req.method === "OPTIONS") {
    res
      .writeHead(204, { ...cors, "access-control-allow-methods": "GET, OPTIONS", "access-control-max-age": "86400" })
      .end();
    return;
  }
  if (url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }
  // The active map as pre-gzipped JSON; browsers decompress transparently.
  if (url === "/map") {
    res.writeHead(200, {
      ...cors,
      "content-type": "application/json",
      "content-encoding": "gzip",
      "cache-control": "no-cache",
    });
    res.end(loadedMap.gz);
    return;
  }
  // Terrain heightfield (binary, pre-gzipped). 404 = flat-ground fallback.
  if (url === "/heightmap") {
    const file = join(REPO_ROOT, "data", "maps", `${loadedMap.map.meta.name}-heightmap.bin.gz`);
    if (!existsSync(file)) {
      res.writeHead(404).end("no heightmap");
      return;
    }
    res.writeHead(200, {
      ...cors,
      "content-type": "application/octet-stream",
      "content-encoding": "gzip",
      "cache-control": "no-cache",
    });
    createReadStream(file).pipe(res);
    return;
  }
  // Static client (production). In dev, Vite serves the client instead.
  const rel = normalize(url === "/" ? "/index.html" : url).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(clientDist, rel);
  if (filePath.startsWith(clientDist) && existsSync(filePath) && statSync(filePath).isFile()) {
    res.writeHead(200, { "content-type": MIME[extname(filePath)] ?? "application/octet-stream" });
    createReadStream(filePath).pipe(res);
    return;
  }
  if (existsSync(join(clientDist, "index.html"))) {
    res.writeHead(200, { "content-type": "text/html" });
    createReadStream(join(clientDist, "index.html")).pipe(res);
    return;
  }
  res.writeHead(404).end("not found (client not built — run `npm run build -w client`)");
});

const room = new Room(loadedMap.map);
const wss = new WebSocketServer({
  server: httpServer,
  path: "/ws",
  verifyClient: (info: { origin?: string }) => allowedOrigin(info.origin),
});

function send(socket: WebSocket, msg: ServerMsg): void {
  socket.send(JSON.stringify(msg));
}

wss.on("connection", (socket) => {
  let playerId: string | null = null;

  socket.on("message", (raw) => {
    const msg = parseClientMsg(raw.toString());
    if (!msg) return;

    if (msg.type === "join") {
      if (playerId) return; // already joined
      if (!checkPassword(msg.password)) {
        send(socket, { type: "error", reason: "wrong password" });
        socket.close(4001, "unauthorized");
        return;
      }
      const token = issueToken();
      const joined = room.addPlayer(msg.name || "anon", token, socket);
      playerId = joined.playerId;
      send(socket, { type: "welcome", playerId, token, snapshot: room.currentSnapshot() });
      console.log(`player ${playerId} (${msg.name}) joined`);
      return;
    }

    if (msg.type === "input" && playerId) {
      room.queueInput(playerId, msg.entityId, msg.target);
    }
  });

  socket.on("close", () => {
    if (playerId) {
      room.removePlayer(playerId);
      console.log(`player ${playerId} left`);
    }
  });
});

if (!passwordConfigured()) {
  console.error("GAME_PASSWORD is not set — refusing to start. Copy .env.sample to .env.");
  process.exit(1);
}

httpServer.listen(PORT, () => {
  console.log(`battle-juice server on http://localhost:${PORT} (ws at /ws)`);
});
