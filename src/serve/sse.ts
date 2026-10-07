const HEARTBEAT_MS = 15000;

export type SseEventName = "decision.created" | "decision.updated" | "session.updated" | "plan.updated" | "plan.removed" | "settings.updated";

type Client = { controller: ReadableStreamDefaultController<Uint8Array>; browser: boolean };

/** SSE connection management and broadcast */
export class SseHub {
  private clients = new Set<Client>();
  private encoder = new TextEncoder();
  private heartbeat: NodeJS.Timeout | undefined;

  get size(): number {
    return this.clients.size;
  }

  /** Clients that identified as a browser GUI (cookie), not the TUI (bearer) */
  get browsers(): number {
    let n = 0;
    for (const c of this.clients) if (c.browser) n++;
    return n;
  }

  /** Return a Response for a new connection. `browser` marks a GUI tab (counted by `browsers`) */
  connect(signal?: AbortSignal, browser = false): Response {
    let client: Client | undefined;
    const remove = () => {
      if (client) this.clients.delete(client);
      if (this.clients.size === 0 && this.heartbeat) {
        clearInterval(this.heartbeat);
        this.heartbeat = undefined;
      }
    };
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        client = { controller, browser };
        this.clients.add(client);
        controller.enqueue(this.encoder.encode(": connected\n\n"));
        if (!this.heartbeat) {
          this.heartbeat = setInterval(() => this.write(": ping\n\n"), HEARTBEAT_MS);
          this.heartbeat.unref();
        }
      },
      cancel: remove,
    });
    signal?.addEventListener("abort", remove, { once: true });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  broadcast(event: SseEventName, data: unknown): void {
    this.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private write(chunk: string): void {
    const bytes = this.encoder.encode(chunk);
    for (const c of this.clients) {
      try {
        c.controller.enqueue(bytes);
      } catch {
        this.clients.delete(c);
      }
    }
  }

  closeAll(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    for (const c of this.clients) {
      try {
        c.controller.close();
      } catch {
        // Already closed
      }
    }
    this.clients.clear();
  }
}
