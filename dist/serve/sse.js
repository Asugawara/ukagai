const HEARTBEAT_MS = 15000;
/** SSE connection management and broadcast */
export class SseHub {
    clients = new Set();
    encoder = new TextEncoder();
    heartbeat;
    get size() {
        return this.clients.size;
    }
    /** Clients that identified as a browser GUI (cookie), not the TUI (bearer) */
    get browsers() {
        let n = 0;
        for (const c of this.clients)
            if (c.browser)
                n++;
        return n;
    }
    /** Return a Response for a new connection. `browser` marks a GUI tab (counted by `browsers`) */
    connect(signal, browser = false) {
        let client;
        const remove = () => {
            if (client)
                this.clients.delete(client);
            if (this.clients.size === 0 && this.heartbeat) {
                clearInterval(this.heartbeat);
                this.heartbeat = undefined;
            }
        };
        const stream = new ReadableStream({
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
    broadcast(event, data) {
        this.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
    write(chunk) {
        const bytes = this.encoder.encode(chunk);
        for (const c of this.clients) {
            try {
                c.controller.enqueue(bytes);
            }
            catch {
                this.clients.delete(c);
            }
        }
    }
    closeAll() {
        if (this.heartbeat)
            clearInterval(this.heartbeat);
        this.heartbeat = undefined;
        for (const c of this.clients) {
            try {
                c.controller.close();
            }
            catch {
                // Already closed
            }
        }
        this.clients.clear();
    }
}
//# sourceMappingURL=sse.js.map