import { Net } from "./net.js";
import { Renderer } from "./render.js";

const joinForm = document.getElementById("join") as HTMLFormElement;
const nameInput = document.getElementById("name") as HTMLInputElement;
const passwordInput = document.getElementById("password") as HTMLInputElement;
const errorEl = document.getElementById("error") as HTMLParagraphElement;
const gameEl = document.getElementById("game") as HTMLDivElement;
const canvas = document.getElementById("canvas") as HTMLCanvasElement;

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
      renderer = new Renderer(canvas, msg.playerId);
      renderer.pushSnapshot(msg.snapshot);

      canvas.addEventListener("click", (e) => {
        net.send({ type: "input", target: renderer!.toWorld(e.clientX, e.clientY) });
      });
    },
    onSnapshot(msg) {
      renderer?.pushSnapshot(msg.snapshot);
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
    },
  });

  net.join(nameInput.value.trim() || "anon", passwordInput.value);
});
