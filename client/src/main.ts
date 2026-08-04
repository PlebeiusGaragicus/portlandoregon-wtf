import { activeMap, type Snapshot } from "@battle-juice/shared";
import { Net } from "./net.js";
import { Renderer } from "./render/index.js";

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

joinForm.addEventListener("submit", (ev) => {
  ev.preventDefault();
  errorEl.textContent = "";
  let renderer: Renderer | null = null;

  const net = new Net({
    onWelcome(msg) {
      joinForm.style.display = "none";
      gameEl.style.display = "block";
      renderer = new Renderer(canvas, msg.playerId, activeMap, {
        onCommand: (entityId, target) => net.send({ type: "input", entityId, target }),
      });
      renderer.pushSnapshot(msg.snapshot);
      updateBanner(msg.snapshot, msg.playerId);
    },
    onSnapshot(msg) {
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
