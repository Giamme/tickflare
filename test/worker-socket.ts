import { exports } from "cloudflare:workers";

/** A WebSocket to the worker under test, for the real client to connect with. */
export class WorkerSocket {
  static all: WorkerSocket[] = [];
  readyState = 0;
  /** As a browser's: how binary messages are handed over. The client sets it to "arraybuffer". */
  binaryType = "blob";
  /** How many binary messages the room has sent. */
  binaryMessages = 0;
  /** Set to lose what the room sends on its way to the client. */
  deaf = false;
  #ws: WebSocket | undefined;
  #listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor(readonly url: string) {
    WorkerSocket.all.push(this);
    void exports.default
      .fetch(url.replace(/^ws/, "http"), { headers: { Upgrade: "websocket" } })
      .then((response) => {
        const ws = response.webSocket;
        if (!ws) return this.drop();
        ws.binaryType = "arraybuffer";
        ws.accept();
        if (this.readyState >= 2) return ws.close(1000, "gone");
        this.#ws = ws;
        ws.addEventListener("message", (event) => {
          if (this.deaf) return;
          if (typeof event.data !== "string") this.binaryMessages += 1;
          // A client that did not ask for array buffers would be handed a blob, which it does not read.
          const data = typeof event.data === "string" || this.binaryType === "arraybuffer" ? event.data : new Blob([event.data as ArrayBuffer]);
          this.#emit("message", { data });
        });
        ws.addEventListener("close", (event) => this.#ended(event.code, event.reason));
        this.readyState = 1;
      });
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    this.#ws?.send(data);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    try {
      this.#ws?.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  /** Hands the client a message, as if the room had sent it. */
  deliver(data: string | ArrayBuffer): void {
    this.#emit("message", { data });
  }

  /** The network goes away under the client. */
  drop(): void {
    try {
      this.#ws?.close(1000, "dropped");
    } catch {
      // Already closed.
    }
    this.#ended(1006, "");
  }

  #ended(code: number, reason: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.#emit("close", { code, reason });
  }

  #emit(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}
