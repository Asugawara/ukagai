import { realpathSync, statSync } from "node:fs";
import { WebSocket } from "ws";

export type Notification = { method: string; params: Record<string, any> };

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

const REQUEST_TIMEOUT_MS = 15000;

/** Minimal JSON-RPC client for the Codex app-server (WebSocket over the daemon's unix socket) */
export class RpcClient {
  private ws: WebSocket | undefined;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;

  onNotification: (n: Notification) => void = () => {};
  /** A message with both `id` and `method` (a server request). The bridge only logs these */
  onServerRequest: (n: Notification & { id: number | string }) => void = () => {};
  onClose: (code: number) => void = () => {};

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** `ws+unix://` wants the real path (the control socket is a symlink into a 0700 temp dir) */
  async connect(socketPath: string): Promise<void> {
    const real = realpathSync(socketPath);
    // Checked up front: a too-long path makes node's http client throw and then emit an unhandled 'error' (it would take serve down)
    if (Buffer.byteLength(real) >= 104) throw new Error("socket path too long");
    if (!statSync(real).isSocket()) throw new Error("not a socket");
    const ws = new WebSocket(`ws+unix://${real}`, { handshakeTimeout: 5000 });
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
      ws.once("unexpected-response", (_q, r) => reject(new Error(`unexpected response ${r.statusCode}`)));
    });
    ws.on("message", (data) => this.handle(String(data)));
    ws.on("error", () => {});
    ws.on("close", (code) => {
      this.closed = true;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(`socket closed (${code})`));
      }
      this.pending.clear();
      this.onClose(code);
    });
    await this.request("initialize", {
      clientInfo: { name: "ukagai", title: "ukagai bridge", version: "0" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized");
  }

  private handle(raw: string): void {
    let m: any;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m === null || typeof m !== "object") return;
    if (typeof m.method === "string") {
      if (m.id !== undefined) this.onServerRequest({ id: m.id, method: m.method, params: m.params ?? {} });
      else this.onNotification({ method: m.method, params: m.params ?? {} });
      return;
    }
    const p = typeof m.id === "number" ? this.pending.get(m.id) : undefined;
    if (!p) return;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error) p.reject(new Error(String(m.error.message ?? "rpc error")));
    else p.resolve(m.result);
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const ws = this.ws;
    if (!ws || this.closed || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("not connected"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }), (err) => {
        if (!err) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    if (this.open) this.ws!.send(JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }));
  }

  close(): void {
    this.closed = true;
    this.ws?.terminate();
  }
}
