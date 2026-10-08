import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Instruction, PendingRewrite, WaitResponse, type CreateDecisionRequest, type Decision, type DecisionResponse } from "../contract.js";

const SHORT_TIMEOUT_MS = 1000;
/** Registration gets a longer timeout because the server's context collection takes up to 1.5 seconds */
const CREATE_TIMEOUT_MS = 3000;

export type WaitResult =
  | { kind: "answer"; response: DecisionResponse }
  | { kind: "timeout" }
  | { kind: "error"; status?: number; message: string };

/** Why the last request did not succeed: an HTTP status, or the exception text */
export interface Failure {
  status?: number;
  message: string;
}

export class Client {
  private token: string | null | undefined;
  /** Failure of the most recent request (undefined when it got a response). For hook.log */
  lastFailure: Failure | undefined;

  constructor(
    private readonly server: string,
    private readonly dataDir: string,
  ) {}

  private async getToken(fresh = false): Promise<string | null> {
    if (!fresh && this.token !== undefined) return this.token;
    try {
      const t = (await readFile(join(this.dataDir, "token"), "utf8")).trim();
      this.token = t === "" ? null : t;
    } catch {
      this.token = null;
    }
    return this.token;
  }

  /**
   * A missing token, no connection or a timeout yields null (treated as unreachable).
   * A 401 means the server may have restarted with a new token: re-read the token file and try again (up to twice, 300 ms apart,
   * since the server writes the file just after it starts listening).
   */
  private async request(
    method: string,
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<{ status: number; text: string } | null> {
    let r = await this.requestOnce(method, path, body, timeoutMs, false);
    for (let i = 0; i < 2 && r?.status === 401; i++) {
      if (i > 0) await new Promise((res) => setTimeout(res, 300));
      r = await this.requestOnce(method, path, body, timeoutMs, true);
    }
    return r;
  }

  private async requestOnce(
    method: string,
    path: string,
    body: unknown,
    timeoutMs: number,
    fresh: boolean,
  ): Promise<{ status: number; text: string } | null> {
    this.lastFailure = undefined;
    const token = await this.getToken(fresh);
    if (!token) {
      this.lastFailure = { message: "no token" };
      return null;
    }
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
      const text = await res.text();
      if (res.status < 200 || res.status >= 300) this.lastFailure = { status: res.status, message: `HTTP ${res.status}` };
      return { status: res.status, text };
    } catch (err) {
      const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : "";
      this.lastFailure = { message: `${err instanceof Error ? err.message : String(err)}${cause}` };
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
    if (!r) return { kind: "error", ...this.lastFailure, message: this.lastFailure?.message ?? "request failed" };
    if (r.status === 204) return { kind: "timeout" };
    if (r.status !== 200) return { kind: "error", status: r.status, message: `HTTP ${r.status}` };
    const parsed = WaitResponse.safeParse(Client.json(r.text));
    return parsed.success
      ? { kind: "answer", response: parsed.data.response }
      : { kind: "error", status: 200, message: "unparseable wait response" };
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

  /** The budget of this leg ended: the server keeps the decision open for the agent's next call. False when it could not be recorded */
  async handoff(id: string, sessionId: string): Promise<boolean> {
    const r = await this.request("POST", `/api/decisions/${encodeURIComponent(id)}/handoff`, { session_id: sessionId }, SHORT_TIMEOUT_MS);
    return r?.status === 200;
  }

  /** The still-open decision of this session and agent with the same fingerprint (the server swaps in the new tool_use_id). Null on a miss or any failure */
  async findOpen(sessionId: string, agentId: string | undefined, fingerprint: string, toolUseId: string): Promise<Decision | null> {
    const q = new URLSearchParams({ fingerprint, tool_use_id: toolUseId });
    if (agentId) q.set("agent_id", agentId);
    const r = await this.request("GET", `/api/sessions/${encodeURIComponent(sessionId)}/open?${q}`, undefined, SHORT_TIMEOUT_MS);
    if (!r || r.status !== 200) return null;
    const d = (Client.json(r.text) as { decision?: Decision } | undefined)?.decision;
    return d && typeof d.id === "string" ? d : null;
  }

  async cancel(id: string, timeoutMs: number): Promise<boolean> {
    const r = await this.request("POST", `/api/decisions/${encodeURIComponent(id)}/cancel`, undefined, timeoutMs);
    return r?.status === 200;
  }

  /** Ask the server to open the GUI (once a day, only when no tab is connected). The result string, or null on any failure */
  async requestGuiOpen(timeoutMs: number): Promise<string | null> {
    const r = await this.request("POST", "/api/gui/open", {}, timeoutMs);
    if (!r || r.status !== 200) return null;
    const result = (Client.json(r.text) as { result?: unknown } | undefined)?.result;
    return typeof result === "string" ? result : null;
  }

  /** Ask the running server to stop (POST /api/shutdown). True when it said ok */
  async shutdown(timeoutMs: number): Promise<boolean> {
    const r = await this.request("POST", "/api/shutdown", {}, timeoutMs);
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

  /** Take (consume) the session's checkpoint instruction. Null on 404, any failure, timeout or an unexpected body */
  async takeInstruction(sessionId: string, timeoutMs: number): Promise<Instruction | null> {
    const r = await this.request("GET", `/api/sessions/${encodeURIComponent(sessionId)}/instruction`, undefined, timeoutMs);
    if (!r || r.status !== 200) return null;
    const parsed = Instruction.safeParse((Client.json(r.text) as { instruction?: unknown } | undefined)?.instruction);
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
