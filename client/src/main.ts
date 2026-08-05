import type { GameMap, Snapshot } from "@battle-juice/shared";
import { Net } from "./net.js";
import { Renderer, type PrebuiltLayers } from "./render/index.js";
import { buildProps } from "./render/props.js";
import { buildWorld } from "./render/world.js";

const joinForm = document.getElementById("join") as HTMLFormElement;
const nameInput = document.getElementById("name") as HTMLInputElement;
const passwordInput = document.getElementById("password") as HTMLInputElement;
const errorEl = document.getElementById("error") as HTMLParagraphElement;
const gameEl = document.getElementById("game") as HTMLDivElement;
const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const bannerEl = document.getElementById("banner") as HTMLDivElement;

// Invite links: https://game.example/?join=<password>
const invited = new URLSearchParams(location.search).get("join");
if (invited) passwordInput.value = invited;

function updateBanner(s: Snapshot, myPlayerId: string): void {
  if (!s.winner) {
    bannerEl.style.display = "none";
    return;
  }
  const survivor = s.entities.find((e) => e.ownerId === s.winner);
  const name = survivor ? survivor.name.replace(/ \d+$/, "") : s.winner;
  bannerEl.textContent = s.winner === myPlayerId ? `Victory — ${name} holds the city` : `${name} wins`;
  bannerEl.style.display = "block";
}

// The map is served by the game server (large maps are not bundled). World
// geometry is built as soon as it arrives — while the player is still at the
// login form — so joining is near-instant.
const mapPromise: Promise<GameMap> = fetch("/map").then((r) => {
  if (!r.ok) throw new Error(`map fetch failed: ${r.status}`);
  return r.json() as Promise<GameMap>;
});
const prebuiltPromise: Promise<{ map: GameMap; layers: PrebuiltLayers }> = mapPromise.then((map) => ({
  map,
  layers: { world: buildWorld(map), props: buildProps(map) },
}));

joinForm.addEventListener("submit", (ev) => {
  ev.preventDefault();
  errorEl.textContent = "";
  let renderer: Renderer | null = null;
  let latest: Snapshot | null = null; // buffered until the map arrives

  const net = new Net({
    onWelcome(msg) {
      joinForm.style.display = "none";
      gameEl.style.display = "block";
      latest = msg.snapshot;
      prebuiltPromise
        .then(({ map, layers }) => {
          renderer = new Renderer(canvas, msg.playerId, map, {
            onCommand: (entityId, target) => net.send({ type: "input", entityId, target }),
            prebuilt: layers,
          });
          if (latest) {
            renderer.pushSnapshot(latest);
            updateBanner(latest, msg.playerId);
          }
        })
        .catch((err) => {
          errorEl.textContent = String(err);
          gameEl.style.display = "none";
          joinForm.style.display = "flex";
        });
    },
    onSnapshot(msg) {
      latest = msg.snapshot;
      renderer?.pushSnapshot(msg.snapshot);
      if (renderer) updateBanner(msg.snapshot, renderer.playerId);
    },
    onError(reason) {
      errorEl.textContent = reason;
    },
    onClose() {
      if (gameEl.style.display === "block") {
        gameEl.style.display = "none";
        joinForm.style.display = "flex";
        errorEl.textContent = "disconnected";
      }
      renderer?.dispose();
      renderer = null;
    },
  });

  net.join(nameInput.value.trim() || "anon", passwordInput.value);
});
