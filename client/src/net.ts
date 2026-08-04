import type { ClientMsg, ServerMsg } from "@battle-juice/shared";

export interface NetHandlers {
  onWelcome: (msg: Extract<ServerMsg, { type: "welcome" }>) => void;
  onSnapshot: (msg: Extract<ServerMsg, { type: "snapshot" }>) => void;
  onError: (reason: string) => void;
  onClose: () => void;
}

export class Net {
  private socket: WebSocket;

  constructor(handlers: NetHandlers) {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.socket = new WebSocket(`${proto}://${location.host}/ws`);
    this.socket.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string) as ServerMsg;
      if (msg.type === "welcome") handlers.onWelcome(msg);
      else if (msg.type === "snapshot") handlers.onSnapshot(msg);
      else if (msg.type === "error") handlers.onError(msg.reason);
    };
    this.socket.onclose = () => handlers.onClose();
  }

  send(msg: ClientMsg): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(msg));
    }
  }

  join(name: string, password: string): void {
    this.socket.addEventListener("open", () => {
      this.send({ type: "join", name, password });
    });
  }
}
