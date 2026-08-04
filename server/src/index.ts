import "./env.js";
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { parseClientMsg, type ServerMsg } from "@battle-juice/shared";
import { checkPassword, issueToken, passwordConfigured } from "./auth.js";
import { Room } from "./room.js";

const PORT = Number(process.env.PORT ?? 4000);
const clientDist = join(fileURLToPath(new URL(".", import.meta.url)), "../../client/dist");

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
  if (url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
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

const room = new Room();
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

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
