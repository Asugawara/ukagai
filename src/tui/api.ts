import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Decision, PlanRemovedEvent, PlanSummary, PlanVersionsResponse, SessionHistory, SessionSummary, Settings, type PlanContent } from "../contract.js";

// Thin fetch wrapper for the server. Auth is the Bearer token in <data-dir>/token (same as the hook client).

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export type StreamEvent =
  | { event: "decision.created" | "decision.updated"; decision: Decision }
  | { event: "session.updated"; session: SessionSummary }
  | { event: "plan.updated"; plan: PlanSummary }
  | { event: "plan.removed"; name: string }
  | { event: "settings.updated"; settings: Settings };

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

  /** The state of every session (a checkpoint says whether its agent is idle). Throws on any failure */
  async sessions(): Promise<SessionSummary[]> {
    const res = await this.fetch("/api/sessions", { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status);
    const j: unknown = await res.json();
    if (!Array.isArray(j)) throw new ApiError("unexpected response");
    return j.flatMap((x) => {
      const r = SessionSummary.safeParse(x);
      return r.success ? [r.data] : [];
    });
  }

  /** The settings (language, ...). Throws on any failure */
  async settings(): Promise<Settings> {
    const res = await this.fetch("/api/settings", { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status);
    return Settings.parse(await res.json());
  }

  /** The plan files Claude Code wrote (newest first). Throws on any failure */
  async plans(): Promise<PlanSummary[]> {
    const res = await this.fetch("/api/plans", { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status);
    const j = (await res.json()) as { plans?: unknown };
    if (!Array.isArray(j.plans)) throw new ApiError("unexpected response");
    return j.plans.flatMap((x) => {
      const r = PlanSummary.safeParse(x);
      return r.success ? [r.data] : [];
    });
  }

  /** One plan file. Throws on any failure */
  async plan(name: string): Promise<PlanContent> {
    const res = await this.fetch(`/api/plans/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status);
    return (await res.json()) as PlanContent;
  }

  /** The versions of a session's plan and the diffs between them (`current`: `decision:<id>` or `plan:<name>`). Throws on any failure */
  async planVersions(sessionId: string, current: string): Promise<PlanVersionsResponse> {
    const res = await this.fetch(`/api/sessions/${encodeURIComponent(sessionId)}/plan-versions?current=${encodeURIComponent(current)}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status);
    return PlanVersionsResponse.parse(await res.json());
  }

  /** Mark a plan read at the `mtime` the human actually read. Throws on any failure; callers ignore it */
  async markRead(name: string, mtime: string): Promise<void> {
    const res = await this.fetch(`/api/plans/${encodeURIComponent(name)}/read`, { method: "POST", body: { mtime }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status);
  }

  /** Tell the agent writing a plan file something; resolves with how it was delivered. Throws on any failure */
  async instructPlan(name: string, text: string): Promise<string> {
    const res = await this.fetch(`/api/plans/${encodeURIComponent(name)}/instruct`, { method: "POST", body: { text }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(j.error ?? `HTTP ${res.status}`, res.status);
    }
    return ((await res.json()) as { delivered_via?: string }).delivered_via ?? "hook";
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

const HANDLED = new Set(["decision.created", "decision.updated", "session.updated", "plan.updated", "plan.removed", "settings.updated"]);

/** Text of one event: decision.created / decision.updated, session.updated, plan.updated and plan.removed; others (heartbeats) are dropped without parsing */
export function parseSse(block: string): StreamEvent | null {
  let event = "";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (!HANDLED.has(event)) return null;
  try {
    const j: unknown = JSON.parse(data.join("\n"));
    if (event === "decision.created" || event === "decision.updated") {
      const r = Decision.safeParse(j);
      return r.success ? { event, decision: r.data } : null;
    }
    if (event === "session.updated") {
      const r = SessionSummary.safeParse(j);
      return r.success ? { event, session: r.data } : null;
    }
    if (event === "plan.updated") {
      const r = PlanSummary.safeParse(j);
      return r.success ? { event, plan: r.data } : null;
    }
    if (event === "settings.updated") {
      const r = Settings.safeParse(j);
      return r.success ? { event, settings: r.data } : null;
    }
    const r = PlanRemovedEvent.safeParse(j);
    return r.success ? { event: "plan.removed", name: r.data.name } : null;
  } catch {
    return null;
  }
}
