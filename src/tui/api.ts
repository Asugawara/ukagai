import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Decision } from "../contract.js";

// server への薄い fetch。認可は <data-dir>/token の Bearer(hook の Client と同じ)。

export class ApiError extends Error {}

export interface StreamEvent {
  event: string;
  decision: Decision;
}

export class TuiApi {
  private token: string | null | undefined;

  constructor(
    readonly server: string,
    private readonly dataDir: string,
  ) {}

  private async getToken(): Promise<string | null> {
    if (this.token !== undefined) return this.token;
    try {
      const t = (await readFile(join(this.dataDir, "token"), "utf8")).trim();
      this.token = t === "" ? null : t;
    } catch {
      this.token = null;
    }
    return this.token;
  }

  private async fetch(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<Response> {
    const token = await this.getToken();
    if (!token) throw new ApiError(`token が読めません(${join(this.dataDir, "token")})`);
    const method = init.method ?? "GET";
    return fetch(this.server + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      body: method === "POST" ? JSON.stringify(init.body ?? {}) : undefined,
      ...(init.signal ? { signal: init.signal } : {}),
    });
  }

  async listPending(): Promise<Decision[]> {
    const res = await this.fetch("/api/decisions?status=pending", { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new ApiError(`HTTP ${res.status}`);
    const j: unknown = await res.json();
    const list = Array.isArray(j) ? j : (j as { decisions?: unknown }).decisions;
    if (!Array.isArray(list)) throw new ApiError("unexpected response");
    return list.flatMap((x) => {
      const r = Decision.safeParse(x);
      return r.success ? [r.data] : [];
    });
  }

  async get(id: string): Promise<Decision> {
    const res = await this.fetch(`/api/decisions/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new ApiError(`HTTP ${res.status}`);
    return Decision.parse(await res.json());
  }

  async answer(id: string, body: Record<string, unknown>): Promise<Decision> {
    const res = await this.fetch(`/api/decisions/${encodeURIComponent(id)}/answer`, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(j.error ?? `HTTP ${res.status}`);
    }
    return Decision.parse(await res.json());
  }

  /** SSE を購読する。切れたら(正常終了も含め)返る。例外は接続失敗 */
  async stream(onEvent: (e: StreamEvent) => void, signal: AbortSignal): Promise<void> {
    const res = await this.fetch("/api/stream", { signal });
    if (!res.ok || !res.body) throw new ApiError(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const ev = parseSse(buf.slice(0, i));
        buf = buf.slice(i + 2);
        if (ev) onEvent(ev);
      }
    }
  }
}

/** 1 イベント分のテキスト → decision.created / decision.updated のみ */
export function parseSse(block: string): StreamEvent | null {
  let event = "";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (event !== "decision.created" && event !== "decision.updated") return null;
  try {
    const r = Decision.safeParse(JSON.parse(data.join("\n")));
    return r.success ? { event, decision: r.data } : null;
  } catch {
    return null;
  }
}
