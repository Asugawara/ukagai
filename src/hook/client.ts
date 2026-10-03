import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PendingRewrite, WaitResponse, type CreateDecisionRequest, type Decision, type DecisionResponse } from "../contract.js";

const SHORT_TIMEOUT_MS = 1000;
/** Registration gets a longer timeout because the server's context collection takes up to 1.5 seconds */
const CREATE_TIMEOUT_MS = 3000;

export type WaitResult =
  | { kind: "answer"; response: DecisionResponse }
  | { kind: "timeout" }
  | { kind: "error" };

export class Client {
  private token: string | null | undefined;

  constructor(
    private readonly server: string,
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

  /** A missing token, no connection or a timeout yields null (treated as unreachable) */
  private async request(
    method: string,
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<{ status: number; text: string } | null> {
    const token = await this.getToken();
    if (!token) return null;
    try {
      const res = await fetch(this.server + path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        },
        body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { status: res.status, text: await res.text() };
    } catch {
      return null;
    }
  }

  private static json(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }

  /** Register. Returns the Decision (at least with an id) on success, otherwise null */
  async createDecision(
    body: CreateDecisionRequest,
  ): Promise<Pick<Decision, "id"> | null> {
    const r = await this.request("POST", "/api/decisions", body, CREATE_TIMEOUT_MS);
    if (!r || (r.status !== 200 && r.status !== 201)) return null;
    const j = Client.json(r.text) as { id?: unknown } | undefined;
    return j && typeof j.id === "string" ? { id: j.id } : null;
  }

  /** List of denied_explain decisions (filtered by session_id). null when unreachable */
  async listDeniedExplain(sessionId: string): Promise<Decision[] | null> {
    const q = new URLSearchParams({ status: "denied_explain" });
    const r = await this.request("GET", `/api/decisions?${q}`, undefined, SHORT_TIMEOUT_MS);
    if (!r || r.status !== 200) return null;
    const j = Client.json(r.text);
    const list = Array.isArray(j) ? j : (j as { decisions?: unknown } | undefined)?.decisions;
    return Array.isArray(list) ? (list as Decision[]).filter((d) => d.session?.session_id === sessionId) : null;
  }

  async wait(id: string, pollTimeoutMs: number): Promise<WaitResult> {
    const r = await this.request(
      "GET",
      `/api/decisions/${encodeURIComponent(id)}/wait?timeout_ms=${Math.round(pollTimeoutMs)}`,
      undefined,
      pollTimeoutMs + 5000,
    );
    if (!r) return { kind: "error" };
    if (r.status === 204) return { kind: "timeout" };
    if (r.status !== 200) return { kind: "error" };
    const parsed = WaitResponse.safeParse(Client.json(r.text));
    return parsed.success ? { kind: "answer", response: parsed.data.response } : { kind: "error" };
  }

  async ack(id: string): Promise<boolean> {
    const r = await this.request("POST", `/api/decisions/${encodeURIComponent(id)}/ack`, undefined, SHORT_TIMEOUT_MS);
    return r?.status === 200;
  }

  async answerFallback(id: string): Promise<boolean> {
    const r = await this.request(
      "POST",
      `/api/decisions/${encodeURIComponent(id)}/answer`,
      { fallback: true },
      SHORT_TIMEOUT_MS,
    );
    return r?.status === 200;
  }

  async cancel(id: string, timeoutMs: number): Promise<boolean> {
    const r = await this.request("POST", `/api/decisions/${encodeURIComponent(id)}/cancel`, undefined, timeoutMs);
    return r?.status === 200;
  }

  async postEvent(event: Record<string, unknown>, timeoutMs: number): Promise<boolean> {
    const r = await this.request("POST", "/api/events", event, timeoutMs);
    return r !== null && r.status >= 200 && r.status < 300;
  }

  /** On 200 the body is `{pending: boolean}`. Anything else is false */
  async getPendingModeSwitch(sessionId: string): Promise<boolean> {
    const r = await this.request(
      "GET",
      `/api/sessions/${encodeURIComponent(sessionId)}/pending-mode-switch`,
      undefined,
      SHORT_TIMEOUT_MS,
    );
    if (!r || r.status !== 200) return false;
    return (Client.json(r.text) as { pending?: unknown } | undefined)?.pending === true;
  }

  async consumeModeSwitch(sessionId: string): Promise<boolean> {
    const r = await this.request(
      "POST",
      `/api/sessions/${encodeURIComponent(sessionId)}/pending-mode-switch/consume`,
      undefined,
      SHORT_TIMEOUT_MS,
    );
    return r !== null && r.status >= 200 && r.status < 300;
  }

  /** The session's last "Cannot answer" memo. Unreachable, an error or an unexpected body yields null (ignored) */
  async getPendingRewrite(sessionId: string): Promise<PendingRewrite> {
    const r = await this.request(
      "GET",
      `/api/sessions/${encodeURIComponent(sessionId)}/pending-rewrite`,
      undefined,
      SHORT_TIMEOUT_MS,
    );
    if (!r || r.status !== 200) return null;
    const parsed = PendingRewrite.safeParse(Client.json(r.text));
    return parsed.success ? parsed.data : null;
  }

  async consumeRewrite(sessionId: string): Promise<boolean> {
    const r = await this.request(
      "POST",
      `/api/sessions/${encodeURIComponent(sessionId)}/pending-rewrite/consume`,
      undefined,
      SHORT_TIMEOUT_MS,
    );
    return r !== null && r.status >= 200 && r.status < 300;
  }
}
