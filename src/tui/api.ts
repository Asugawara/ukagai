import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Decision, SessionHistory } from "../contract.js";

// Thin fetch wrapper for the server. Auth is the Bearer token in <data-dir>/token (same as the hook client).

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface StreamEvent {
  event: string;
  decision: Decision;
}

export interface PlanSummary {
  name: string;
  title: string;
  mtime: string;
  bytes: number;
  sections: number;
  lines: number;
}

export interface PlanFile {
  name: string;
  title: string;
  mtime: string;
  markdown: string;
}

export class TuiApi {
  private token: string | null = null;

  constructor(
    readonly server: string,
    private readonly dataDir: string,
  ) {}

  private async getToken(): Promise<string | null> {
    if (this.token) return this.token;
    try {
      const t = (await readFile(join(this.dataDir, "token"), "utf8")).trim();
      this.token = t === "" ? null : t;
    } catch {
      this.token = null;
    }
    return this.token;
  }

  private async fetch(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<Response> {
    const method = init.method ?? "GET";
    // Restarting the server regenerates the token. On 401, re-read the token and retry once
    for (let retried = false; ; retried = true) {
      const token = await this.getToken();
      if (!token) throw new ApiError(`cannot read the token (${join(this.dataDir, "token")})`);
      const res = await fetch(this.server + path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        },
        body: method === "POST" ? JSON.stringify(init.body ?? {}) : undefined,
        ...(init.signal ? { signal: init.signal } : {}),
      });
      if (res.status !== 401 || retried) return res;
      this.token = null;
    }
  }

  async listPending(): Promise<Decision[]> {
    const res = await this.fetch("/api/decisions?status=pending", { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status);
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
    if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status);
    return Decision.parse(await res.json());
  }

  /** The human instructions of the decision's session (first + the last 20). Throws on any failure; callers ignore it */
  async history(id: string): Promise<SessionHistory> {
    const res = await this.fetch(`/api/decisions/${encodeURIComponent(id)}/history`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status);
    return SessionHistory.parse(await res.json());
  }

  /** The plan files Claude Code wrote (newest first). Throws on any failure */
  async plans(): Promise<PlanSummary[]> {
    const res = await this.fetch("/api/plans", { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status);
    const j = (await res.json()) as { plans?: unknown };
    if (!Array.isArray(j.plans)) throw new ApiError("unexpected response");
    return j.plans as PlanSummary[];
  }

  /** One plan file; null when `since` equals its current mtime (304) */
  async plan(name: string, since?: string): Promise<PlanFile | null> {
    const q = since ? `?since=${encodeURIComponent(since)}` : "";
    const res = await this.fetch(`/api/plans/${encodeURIComponent(name)}${q}`, { signal: AbortSignal.timeout(5000) });
    if (res.status === 304) return null;
    if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status);
    return (await res.json()) as PlanFile;
  }

  async answer(id: string, body: Record<string, unknown>): Promise<Decision> {
    const res = await this.fetch(`/api/decisions/${encodeURIComponent(id)}/answer`, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(j.error ?? `HTTP ${res.status}`, res.status);
    }
    return Decision.parse(await res.json());
  }

  /** Subscribe to SSE. Calls onOpen once connected and returns when the stream ends (including a clean end). Throws on connection failure */
  async stream(onEvent: (e: StreamEvent) => void, signal: AbortSignal, onOpen?: () => void): Promise<void> {
    const res = await this.fetch("/api/stream", { signal });
    if (!res.ok || !res.body) throw new ApiError(`HTTP ${res.status}`, res.status);
    onOpen?.();
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

/** Text of one event, keeping only decision.created / decision.updated */
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
