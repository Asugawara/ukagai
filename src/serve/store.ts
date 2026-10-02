import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CANCEL_WINDOW_MS,
  DENY_LINK_WINDOW_MS,
  MODE_SWITCH_TTL_MS,
  canTransition,
  type CreateDecisionRequest,
  type Decision,
  type DecisionContext,
  type DecisionResponse,
  type DecisionStatus,
  type EventInput,
  type Metrics,
  type PendingModeSwitch,
  type SessionState,
  type SessionSummary,
} from "../contract.js";
import type { SseEventName } from "./sse.js";

export class HttpError extends Error {
  constructor(
    public status: 400 | 401 | 404 | 409,
    message: string,
    public issues?: unknown,
  ) {
    super(message);
  }
}

export type StoreOptions = {
  dir: string;
  leaseGraceMs: number;
  broadcast?: (event: SseEventName, data: unknown) => void;
};

export type AnswerPatch =
  | { kind: "answers"; answers: Record<string, string> }
  | { kind: "approve"; set_mode_auto?: boolean }
  | { kind: "reject"; reason: string }
  | { kind: "fallback" };

export const SESSION_PANEL_OPEN_EVENT = "ukagai.session_panel_open";

const READY: readonly DecisionStatus[] = ["answer_submitted", "fallback"];
const CLOSED: readonly DecisionStatus[] = ["answered", "hook_disconnected", "answer_lost", "cancelled", "denied_explain"];
const EVENT_KEYS = [
  "session_id",
  "cwd",
  "hook_event_name",
  "tool_name",
  "tool_use_id",
  "agent_id",
  "agent_type",
  "received_at",
  "escaped_question",
  "observe",
  "notification_type",
] as const;
const LIVE: readonly DecisionStatus[] = ["pending", "answer_submitted"];

function stat(values: number[]): { count: number; median_ms: number | null; mean_ms: number | null } {
  if (values.length === 0) return { count: 0, median_ms: null, mean_ms: null };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return { count: sorted.length, median_ms: median, mean_ms: mean };
}

function firstQuestion(d: { request: Decision["request"] }): string | undefined {
  const qs = (d.request as { questions?: { question?: string }[] }).questions;
  return qs?.[0]?.question;
}

export class Store {
  private decisions = new Map<string, Decision>();
  private byToolUse = new Map<string, string>();
  private sessions = new Map<string, SessionSummary>();
  private modeSwitches = new Map<string, { set_at: number }>();
  private expiredAt = new Map<string, number>();
  private waiters = new Map<string, Set<() => void>>();
  private monitor: NodeJS.Timeout | undefined;

  // events から再構築する集計
  private escapedQuestions = 0;
  private panelOpens = 0;
  private observeStarts = new Map<string, number>();
  private baseline: number[] = [];

  private decisionsFile: string;
  private eventsFile: string;

  constructor(private opts: StoreOptions) {
    mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
    this.decisionsFile = join(opts.dir, "decisions.jsonl");
    this.eventsFile = join(opts.dir, "events.jsonl");
  }

  // ---- 永続化と復元 ----

  load(): void {
    if (existsSync(this.decisionsFile)) {
      for (const line of readFileSync(this.decisionsFile, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line) as Decision;
          if (typeof d.id !== "string") continue;
          this.decisions.set(d.id, d);
          this.byToolUse.set(d.tool_use_id, d.id);
        } catch {
          // 壊れた行は読み飛ばす
        }
      }
    }
    // 再起動では hook との接続が切れている。canTransition の外の特例
    for (const d of this.decisions.values()) {
      if (LIVE.includes(d.status)) {
        d.status = "hook_disconnected";
        delete d.lease_until;
        this.persist(d);
      }
    }
    if (existsSync(this.eventsFile)) {
      for (const line of readFileSync(this.eventsFile, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          this.applyEvent(JSON.parse(line) as EventInput, false);
        } catch {
          // 壊れた行は読み飛ばす
        }
      }
    }
  }

  private persist(d: Decision): void {
    appendFileSync(this.decisionsFile, JSON.stringify(d) + "\n");
  }

  private emit(event: SseEventName, data: unknown): void {
    this.opts.broadcast?.(event, data);
  }

  private notify(id: string): void {
    const set = this.waiters.get(id);
    if (!set) return;
    for (const fn of [...set]) fn();
  }

  // ---- 判断 ----

  get(id: string): Decision | undefined {
    return this.decisions.get(id);
  }

  findByToolUse(toolUseId: string): Decision | undefined {
    const id = this.byToolUse.get(toolUseId);
    return id ? this.decisions.get(id) : undefined;
  }

  list(status?: DecisionStatus): Decision[] {
    const all = [...this.decisions.values()];
    const filtered = status ? all.filter((d) => d.status === status) : all.filter((d) => d.status !== "denied_explain");
    return filtered.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  create(req: CreateDecisionRequest, context: DecisionContext): { decision: Decision; created: boolean } {
    const existing = this.findByToolUse(req.tool_use_id);
    if (existing && !(existing.status === "denied_explain" && req.status !== "denied_explain")) {
      return { decision: existing, created: false };
    }

    const denied = req.status === "denied_explain";
    const now = Date.now();
    const session = { ...req.session };
    if (!session.title && context.ai_title) session.title = context.ai_title;
    const decision: Decision = {
      id: randomUUID(),
      kind: req.kind,
      tool_use_id: req.tool_use_id,
      session,
      request: req.request,
      context,
      status: denied ? "denied_explain" : "pending",
      created_at: new Date(now).toISOString(),
    };
    if (req.explanation) decision.explanation = req.explanation;
    if (denied && req.missing) decision.missing = req.missing;
    if (!denied) {
      decision.lease_until = new Date(now + this.opts.leaseGraceMs).toISOString();
      const denial = req.explanation?.attached_via === "after_deny" ? this.findRecentDenial(decision, now) : undefined;
      if (denial) decision.first_denied_at = denial.created_at;
    }
    this.decisions.set(decision.id, decision);
    this.byToolUse.set(decision.tool_use_id, decision.id);
    this.persist(decision);
    if (!denied) {
      this.emit("decision.created", decision);
      this.touchSession(session.session_id, { state: "waiting_decision", cwd: session.cwd, title: session.title });
    }
    return { decision, created: true };
  }

  private findRecentDenial(d: Decision, now: number): Decision | undefined {
    const q = firstQuestion(d);
    let best: Decision | undefined;
    for (const c of this.decisions.values()) {
      if (c.status !== "denied_explain") continue;
      if (c.session.session_id !== d.session.session_id) continue;
      if ((c.session.agent_id ?? "") !== (d.session.agent_id ?? "")) continue;
      if (firstQuestion(c) !== q) continue;
      if (now - Date.parse(c.created_at) > DENY_LINK_WINDOW_MS) continue;
      if (!best || c.created_at > best.created_at) best = c;
    }
    return best;
  }

  private transition(d: Decision, to: DecisionStatus): void {
    if (!canTransition(d.status, to)) {
      throw new HttpError(409, `cannot transition ${d.status} -> ${to}`);
    }
    d.status = to;
  }

  submitAnswer(id: string, patch: AnswerPatch): Decision {
    const d = this.decisions.get(id);
    if (!d) throw new HttpError(404, "decision not found");
    const decided_at = new Date().toISOString();
    const needsKind = patch.kind === "answers" ? "answer_question" : patch.kind === "fallback" ? undefined : "approve_plan";
    if (needsKind && d.kind !== needsKind) throw new HttpError(400, `this answer does not fit kind ${d.kind}`);

    let response: DecisionResponse;
    let to: DecisionStatus = "answer_submitted";
    switch (patch.kind) {
      case "answers":
        response = { via: "gui", answers: patch.answers, decided_at };
        break;
      case "approve":
        response = { via: "gui", approve: true, decided_at };
        if (patch.set_mode_auto) response.set_mode_auto = true;
        break;
      case "reject":
        response = { via: "gui", approve: false, reason: patch.reason, decided_at };
        break;
      case "fallback":
        response = { via: "terminal", decided_at };
        to = "fallback";
        break;
    }
    this.transition(d, to);
    d.response = response;
    this.persist(d);
    if (patch.kind === "approve" && patch.set_mode_auto) {
      this.modeSwitches.set(d.session.session_id, { set_at: Date.now() });
    }
    this.emit("decision.updated", d);
    this.notify(d.id);
    return d;
  }

  /** hook が SIGTERM / SIGINT / SIGHUP で降りる時の通知。pending は cancelled、answer_submitted は answer_lost */
  cancel(id: string): Decision {
    const d = this.decisions.get(id);
    if (!d) throw new HttpError(404, "decision not found");
    this.transition(d, d.status === "answer_submitted" ? "answer_lost" : "cancelled");
    delete d.lease_until;
    this.persist(d);
    this.emit("decision.updated", d);
    this.notify(d.id);
    return d;
  }

  ack(id: string): Decision {
    const d = this.decisions.get(id);
    if (!d) throw new HttpError(404, "decision not found");
    this.transition(d, "answered");
    d.response = { ...d.response!, delivered_at: new Date().toISOString() };
    delete d.lease_until;
    this.persist(d);
    this.emit("decision.updated", d);
    this.touchSession(d.session.session_id, { state: "working" });
    return d;
  }

  private extendLease(d: Decision, timeoutMs: number): void {
    if (!LIVE.includes(d.status)) return;
    d.lease_until = new Date(Date.now() + timeoutMs + this.opts.leaseGraceMs).toISOString();
  }

  /** answer_submitted / fallback になるか timeout するまで待つ。timeout は undefined */
  async wait(id: string, timeoutMs: number, signal?: AbortSignal): Promise<Decision | undefined> {
    const d = this.decisions.get(id);
    if (!d) throw new HttpError(404, "decision not found");
    this.extendLease(d, timeoutMs);
    const settled = () => READY.includes(d.status) || CLOSED.includes(d.status);
    if (!settled() && !signal?.aborted) {
      await new Promise<void>((resolve) => {
        const set = this.waiters.get(id) ?? new Set();
        this.waiters.set(id, set);
        const onChange = () => {
          if (settled()) finish();
        };
        const finish = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", finish);
          set.delete(onChange);
          if (set.size === 0) this.waiters.delete(id);
          resolve();
        };
        const timer = setTimeout(finish, timeoutMs);
        set.add(onChange);
        signal?.addEventListener("abort", finish, { once: true });
      });
    }
    this.extendLease(d, timeoutMs);
    return READY.includes(d.status) ? d : undefined;
  }

  // ---- lease の監視 ----

  startMonitor(): void {
    const interval = Math.min(1000, Math.max(20, Math.floor(this.opts.leaseGraceMs / 2)));
    this.monitor = setInterval(() => this.checkLeases(), interval);
    this.monitor.unref();
  }

  checkLeases(now = Date.now()): void {
    for (const d of this.decisions.values()) {
      if (!LIVE.includes(d.status) || !d.lease_until || Date.parse(d.lease_until) > now) continue;
      const to: DecisionStatus = d.status === "pending" ? "hook_disconnected" : "answer_lost";
      d.status = to;
      this.persist(d);
      if (to === "hook_disconnected") this.expiredAt.set(d.id, now);
      this.emit("decision.updated", d);
      this.notify(d.id);
    }
  }

  close(): void {
    if (this.monitor) clearInterval(this.monitor);
    this.monitor = undefined;
  }

  // ---- セッションと events ----

  private touchSession(
    sessionId: string,
    patch: { state?: SessionState; cwd?: string; title?: string },
    live = true,
    at = new Date().toISOString(),
  ): void {
    const cur = this.sessions.get(sessionId);
    const next: SessionSummary = {
      session_id: sessionId,
      state: patch.state ?? cur?.state ?? "working",
      last_event_at: at,
      cwd: patch.cwd ?? cur?.cwd ?? "",
    };
    const title = patch.title ?? cur?.title;
    if (title) next.title = title;
    this.sessions.set(sessionId, next);
    if (live) this.emit("session.updated", next);
  }

  listSessions(): SessionSummary[] {
    return [...this.sessions.values()].sort((a, b) => b.last_event_at.localeCompare(a.last_event_at));
  }

  addEvent(ev: EventInput): void {
    // 生の hook 入力(tool_input / tool_response / prompt など)は保存しない
    const src = ev as Record<string, unknown>;
    const kept: Record<string, unknown> = {};
    for (const k of EVENT_KEYS) if (src[k] !== undefined) kept[k] = src[k];
    appendFileSync(this.eventsFile, JSON.stringify(kept) + "\n");
    this.applyEvent(ev, true);
  }

  private applyEvent(ev: EventInput, live: boolean): void {
    if (ev.hook_event_name === SESSION_PANEL_OPEN_EVENT) {
      this.panelOpens++;
      return;
    }
    if (ev.escaped_question) this.escapedQuestions++;
    const at = Date.parse(ev.received_at);
    if (ev.observe && Number.isFinite(at)) {
      const toolUseId = (ev as Record<string, unknown>).tool_use_id;
      const key =
        typeof toolUseId === "string"
          ? toolUseId
          : `${ev.session_id}|${ev.agent_id ?? ""}|${String((ev as Record<string, unknown>).tool_name ?? "")}`;
      if (ev.observe.phase === "start") this.observeStarts.set(key, at);
      else {
        const start = this.observeStarts.get(key);
        if (start !== undefined) {
          this.baseline.push(Math.max(0, at - start));
          this.observeStarts.delete(key);
        }
      }
    }
    const state: SessionState | undefined = {
      SessionStart: "working",
      UserPromptSubmit: "working",
      Stop: "idle",
      SessionEnd: "ended",
    }[ev.hook_event_name] as SessionState | undefined;
    this.touchSession(ev.session_id, { state, cwd: ev.cwd }, live, Number.isFinite(at) ? ev.received_at : undefined);
    if (live && (ev.hook_event_name === "UserPromptSubmit" || ev.hook_event_name === "Stop")) {
      this.cancelRecentlyDisconnected(ev.session_id);
    }
    if (live && ev.hook_event_name === "UserPromptSubmit") this.cancelPending(ev.session_id);
  }

  /** 人がターミナルで次の発話をした = pending の判断はもう待たれていない */
  private cancelPending(sessionId: string): void {
    for (const d of this.decisions.values()) {
      if (d.session.session_id !== sessionId || d.status !== "pending") continue;
      this.transition(d, "cancelled");
      delete d.lease_until;
      this.persist(d);
      this.emit("decision.updated", d);
      this.notify(d.id);
    }
  }

  private cancelRecentlyDisconnected(sessionId: string): void {
    const now = Date.now();
    for (const d of this.decisions.values()) {
      if (d.session.session_id !== sessionId || d.status !== "hook_disconnected") continue;
      const expired = this.expiredAt.get(d.id);
      if (expired === undefined || now - expired > CANCEL_WINDOW_MS) continue;
      d.status = "cancelled";
      this.persist(d);
      this.emit("decision.updated", d);
    }
  }

  // ---- 「承認して auto」 ----

  getModeSwitch(sessionId: string): PendingModeSwitch {
    const m = this.modeSwitches.get(sessionId);
    if (!m) return { pending: false };
    if (Date.now() - m.set_at > MODE_SWITCH_TTL_MS) {
      this.modeSwitches.delete(sessionId);
      return { pending: false };
    }
    return {
      pending: true,
      set_at: new Date(m.set_at).toISOString(),
      expires_at: new Date(m.set_at + MODE_SWITCH_TTL_MS).toISOString(),
    };
  }

  consumeModeSwitch(sessionId: string): boolean {
    const pending = this.getModeSwitch(sessionId).pending;
    if (pending) this.modeSwitches.delete(sessionId);
    return pending;
  }

  // ---- 集計 ----

  metrics(): Metrics {
    const count = { answered: 0, fallback: 0, hook_disconnected: 0, answer_lost: 0, cancelled: 0 };
    const human: number[] = [];
    const agent: number[] = [];
    const d = { first_call: 0, after_deny: 0, none: 0 };
    for (const x of this.decisions.values()) {
      if (x.status === "denied_explain") continue;
      if (x.status in count) count[x.status as keyof typeof count]++;
      if (x.response?.via === "gui") {
        human.push(Math.max(0, Date.parse(x.response.decided_at) - Date.parse(x.created_at)));
      }
      if (x.first_denied_at) agent.push(Math.max(0, Date.parse(x.created_at) - Date.parse(x.first_denied_at)));
      const e = x.explanation;
      if (e?.none_reason === "plan_mode") continue;
      if (!e || e.attached_via === "none") d.none++;
      else d[e.attached_via]++;
    }
    const total = count.answered + count.fallback + count.hook_disconnected + count.answer_lost + count.cancelled + this.escapedQuestions;
    const dTotal = d.first_call + d.after_deny + d.none;
    return {
      a: { ...count, escaped_question: this.escapedQuestions, total, rate: total === 0 ? null : count.answered / total },
      b: { human: stat(human), agent: stat(agent), baseline: stat(this.baseline) },
      c: { session_panel_opens: this.panelOpens },
      d: { ...d, total: dTotal, attach_rate: dTotal === 0 ? null : (d.first_call + d.after_deny) / dTotal },
    };
  }
}
