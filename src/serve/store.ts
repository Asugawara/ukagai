import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CANCEL_WINDOW_MS,
  CHECKPOINT_TTL_MS,
  checkpointFingerprint,
  type DeliveredVia,
  checkpointToolUseId,
  DENY_LINK_WINDOW_MS,
  HANDOFF_GRACE_MS,
  MODE_SWITCH_TTL_MS,
  bodyHash,
  canTransition,
  decisionFingerprint,
  parseCannotAnswer,
  type CreateDecisionRequest,
  type Decision,
  type DecisionContext,
  type DecisionResponse,
  type DecisionStatus,
  type EventInput,
  type Instruction,
  type Metrics,
  type PendingModeSwitch,
  type PendingRewrite,
  type SessionState,
  type SessionSummary,
} from "../contract.js";
import type { SseEventName } from "./sse.js";

export class HttpError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409,
    message: string,
    public issues?: unknown,
  ) {
    super(message);
  }
}

export type StoreOptions = {
  dir: string;
  leaseGraceMs: number;
  /** Lease after a hand-off: how long the agent has to call the tool again (default HANDOFF_GRACE_MS) */
  handoffGraceMs?: number;
  broadcast?: (event: SseEventName, data: unknown) => void;
  /** Runs on every status change, after the status is set and before `decision.updated` is emitted (read marks of a closed plan go out first) */
  onTransition?: (d: Decision, from: DecisionStatus, to: DecisionStatus) => void;
  /** Basename of the plan file a path points at inside the plans directory, or null (resolved once when an approve_plan decision is created) */
  planNameOf?: (filePath: string) => string | null;
};

export type AnswerPatch =
  | { kind: "answers"; answers: Record<string, string> }
  | { kind: "approve"; set_mode_auto?: boolean }
  | { kind: "reject"; reason: string }
  | { kind: "fallback" }
  | { kind: "checkpoint"; answer: "continue" | "instruct" | "stop"; text?: string };

export const SESSION_PANEL_OPEN_EVENT = "ukagai.session_panel_open";

const READY: readonly DecisionStatus[] = ["answer_submitted", "fallback"];
const CLOSED: readonly DecisionStatus[] = ["answered", "hook_disconnected", "answer_lost", "cancelled", "denied_explain"];
const EVENT_KEYS = [
  "session_id",
  "cwd",
  "transcript_path",
  "hook_event_name",
  "tool_name",
  "tool_use_id",
  "agent_id",
  "agent_type",
  "agent",
  "received_at",
  "escaped_question",
  "blocker_detected",
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
  private rewrites = new Map<string, NonNullable<PendingRewrite>>();
  private expiredAt = new Map<string, number>();
  private waiters = new Map<string, Set<() => void>>();
  /** Answered checkpoints whose text has not reached the agent yet: one per session, newest wins */
  private instructions = new Map<string, Instruction>();
  /** Claude Code sessions whose last delivered instruction was a stop and that have not had a UserPromptSubmit since */
  private stoppedSessions = new Set<string>();
  /** Called after each live hook event of a session (the recap watcher reads that session's transcript now) */
  onSessionEvent: ((sessionId: string, hookEvent: string) => void) | undefined;
  /** Called after a checkpoint is answered (the Codex bridge delivers its answer in-process; Claude's hook polls the instruction instead) */
  onCheckpointAnswered: ((d: Decision) => void) | undefined;
  /** Claude Code checkpoints: an answered instruct that an idle agent will not pick up by itself (the terminal delivery types it) */
  onCheckpointDeliverable: ((d: Decision) => void) | undefined;
  /** A checkpoint was created for a session (the terminal delivery looks up where its terminal is) */
  onCheckpointCreated: ((d: Decision) => void) | undefined;
  private monitor: NodeJS.Timeout | undefined;

  // Aggregates rebuilt from events
  private escapedQuestions = 0;
  private blockersDetected = 0;
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

  // ---- Persistence and restore ----

  load(): void {
    if (existsSync(this.decisionsFile)) {
      for (const line of readFileSync(this.decisionsFile, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line) as Decision;
          if (typeof d.id !== "string") continue;
          this.decisions.set(d.id, d);
          this.byToolUse.set(d.tool_use_id, d.id);
          for (const prev of d.previous_tool_use_ids ?? []) this.byToolUse.set(prev, d.id);
        } catch {
          // Skip malformed lines
        }
      }
    }
    // After a restart live decisions stay live: the hook retries its wait (W2), so re-arm the lease with the default grace.
    // If no hook comes back, the lease expires and checkLeases moves it to hook_disconnected / answer_lost as usual.
    const lease = new Date(Date.now() + this.opts.leaseGraceMs).toISOString();
    for (const d of this.decisions.values()) {
      if (LIVE.includes(d.status) && d.kind !== "checkpoint") d.lease_until = lease;
    }
    this.restoreInstructions();
    if (existsSync(this.eventsFile)) {
      for (const line of readFileSync(this.eventsFile, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          this.applyEvent(JSON.parse(line) as EventInput, false);
        } catch {
          // Skip malformed lines
        }
      }
    }
  }

  /** The newest undelivered instruction of each session (at most CHECKPOINT_TTL_MS old) is still waiting after a restart */
  private restoreInstructions(): void {
    const now = Date.now();
    for (const d of this.decisions.values()) {
      const r = d.response;
      if (d.kind !== "checkpoint" || d.status !== "answered" || !r || r.delivered_at || (r.kind !== "instruct" && r.kind !== "stop")) continue;
      if (now - Date.parse(r.decided_at) > CHECKPOINT_TTL_MS) continue;
      const cur = this.instructions.get(d.session.session_id);
      if (cur && cur.created_at >= r.decided_at) continue;
      this.instructions.set(d.session.session_id, { decision_id: d.id, kind: r.kind, text: r.text ?? "", created_at: r.decided_at });
    }
  }

  private persist(d: Decision): void {
    appendFileSync(this.decisionsFile, JSON.stringify(d) + "\n");
  }

  private emit(event: SseEventName, data: unknown): void {
    this.opts.broadcast?.(event, data);
  }

  /** The one place a status changes. `onTransition` runs before the caller emits */
  private setStatus(d: Decision, to: DecisionStatus): void {
    const from = d.status;
    d.status = to;
    try {
      this.opts.onTransition?.(d, from, to);
    } catch {
      // Read marks are a convenience
    }
  }

  private notify(id: string): void {
    const set = this.waiters.get(id);
    if (!set) return;
    for (const fn of [...set]) fn();
  }

  // ---- Decisions ----

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

    if (req.kind === "checkpoint") return this.insertCheckpoint(req);

    const denied = req.status === "denied_explain";
    const fingerprint = decisionFingerprint(req.kind, req.request as Record<string, unknown>);
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
      fingerprint,
      handoffs: 0,
    };
    const planFilePath = req.kind === "approve_plan" ? (req.request as { planFilePath?: unknown }).planFilePath : undefined;
    if (typeof planFilePath === "string" && planFilePath !== "") {
      const planName = this.opts.planNameOf?.(planFilePath);
      if (planName) decision.plan_name = planName;
    }
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

  /** A progress recap seen in the session's transcript: supersedes the session's pending checkpoint and never changes the session state */
  createCheckpoint(
    session: SessionSummary & { agent?: "claude" | "codex" },
    recap: string,
    recapAt: string,
  ): { decision: Decision; created: boolean; skipped?: undefined } | { decision?: undefined; created: false; skipped: "after_stop" } {
    // The human told the agent to stop: no more progress checks until they speak again (Claude Code only; the Codex bridge handles its own)
    if (session.agent !== "codex" && this.stoppedSessions.has(session.session_id)) return { created: false, skipped: "after_stop" };
    const ds: CreateDecisionRequest["session"] = { session_id: session.session_id, cwd: session.cwd, transcript_path: session.transcript_path ?? "" };
    if (session.agent) ds.agent = session.agent;
    if (session.title) ds.title = session.title;
    return this.insertCheckpoint({
      tool_use_id: checkpointToolUseId(session.session_id, recapAt),
      kind: "checkpoint",
      session: ds,
      request: { recap, recap_at: recapAt },
    });
  }

  private insertCheckpoint(req: CreateDecisionRequest): { decision: Decision; created: boolean } {
    const existing = this.findByToolUse(req.tool_use_id);
    if (existing) return { decision: existing, created: false };
    const request = req.request as { recap: string; recap_at: string };
    const sid = req.session.session_id;
    for (const d of this.decisions.values()) {
      if (d.kind === "checkpoint" && d.session.session_id === sid && d.status === "pending") this.closeCheckpoint(d, "superseded");
    }
    const decision: Decision = {
      id: randomUUID(),
      kind: "checkpoint",
      tool_use_id: req.tool_use_id,
      session: { ...req.session },
      request,
      context: {},
      status: "pending",
      created_at: new Date().toISOString(),
      fingerprint: checkpointFingerprint(request.recap_at),
    };
    this.decisions.set(decision.id, decision);
    this.byToolUse.set(decision.tool_use_id, decision.id);
    this.persist(decision);
    this.emit("decision.created", decision);
    this.touchSession(sid, { cwd: req.session.cwd, title: req.session.title, transcript_path: req.session.transcript_path });
    try {
      this.onCheckpointCreated?.(decision);
    } catch {
      // A subscriber must not break the checkpoint
    }
    return { decision, created: true };
  }

  /** The terminal the session's agent runs in (looked up when a checkpoint is created and again when it is answered); undefined = not found */
  setTerminal(sessionId: string, terminal: string | undefined): void {
    const cur = this.sessions.get(sessionId);
    if (!cur || cur.terminal === terminal) return;
    const { terminal: _old, ...rest } = cur;
    const next: SessionSummary = terminal ? { ...rest, terminal } : rest;
    this.sessions.set(sessionId, next);
    this.emit("session.updated", next);
  }

  /** pending checkpoint -> cancelled (no lease, no waiter) */
  private closeCheckpoint(d: Decision, reason: string): void {
    this.transition(d, "cancelled");
    d.status_reason = reason;
    this.persist(d);
    this.emit("decision.updated", d);
  }

  /** The session's pending checkpoints are no longer wanted (its next turn started elsewhere): cancelled with `reason` */
  cancelPendingCheckpoints(sessionId: string, reason: string): void {
    for (const d of this.decisions.values()) {
      if (d.kind === "checkpoint" && d.session.session_id === sessionId && d.status === "pending") this.closeCheckpoint(d, reason);
    }
  }

  /** An answered checkpoint whose instruction could not be handed over (Codex bridge): answer_lost, and the queued instruction is dropped */
  loseCheckpoint(id: string): Decision {
    const d = this.decisions.get(id);
    if (!d) throw new HttpError(404, "decision not found");
    if (d.kind !== "checkpoint" || d.status !== "answered" || d.response?.delivered_at) return d;
    if (this.instructions.get(d.session.session_id)?.decision_id === id) this.instructions.delete(d.session.session_id);
    this.setStatus(d, "answer_lost");
    this.persist(d);
    this.emit("decision.updated", d);
    return d;
  }

  /** The instruction waiting for the session's agent, or undefined. Consuming it marks the checkpoint delivered */
  consumeInstruction(sessionId: string, via: DeliveredVia = "hook"): Instruction | undefined {
    const ins = this.instructions.get(sessionId);
    if (!ins) return undefined;
    this.instructions.delete(sessionId);
    this.markDelivered(ins.decision_id, via);
    if (ins.kind === "stop" && this.decisions.get(ins.decision_id)?.session.agent !== "codex") this.stoppedSessions.add(sessionId);
    return ins;
  }

  private markDelivered(decisionId: string, via: DeliveredVia): void {
    const d = this.decisions.get(decisionId);
    if (!d?.response || d.response.delivered_at) return;
    d.response = { ...d.response, delivered_at: new Date().toISOString(), delivered_via: via };
    this.persist(d);
    this.emit("decision.updated", d);
  }

  /** The queued instruction of this checkpoint, taken off the queue for the terminal delivery (undefined when the hook took it first) */
  claimInstruction(decisionId: string, maxAgeMs: number): Instruction | undefined {
    for (const [sid, ins] of this.instructions) {
      if (ins.decision_id !== decisionId) continue;
      // Typing starts a new turn: only for an agent that is still idle, and not for a reply the human gave long ago
      if (this.sessions.get(sid)?.state !== "idle" || Date.now() - Date.parse(ins.created_at) > maxAgeMs) return undefined;
      this.instructions.delete(sid);
      return ins;
    }
    return undefined;
  }

  /** A claimed instruction could not be typed: back on the queue for the hook, unless a newer one took its place */
  requeueInstruction(sessionId: string, ins: Instruction): void {
    if (!this.instructions.has(sessionId)) this.instructions.set(sessionId, ins);
  }

  /** A claimed instruction reached the agent's terminal */
  deliveredToTerminal(decisionId: string): void {
    this.markDelivered(decisionId, "terminal");
  }

  /** The newest decision of the session and agent that is still open (pending, or its hook went away) and asks the same thing */
  findOpen(sessionId: string, agentId: string | undefined, fingerprint: string): Decision | undefined {
    let best: Decision | undefined;
    for (const d of this.decisions.values()) {
      if (d.kind === "checkpoint" || d.session.session_id !== sessionId || (d.session.agent_id ?? "") !== (agentId ?? "") || d.fingerprint !== fingerprint) continue;
      if (d.status !== "pending" && d.status !== "hook_disconnected") continue;
      if (!best || d.created_at > best.created_at) best = d;
    }
    return best;
  }

  /** The tool was called again for an open decision: it takes the new tool_use_id and is waited for again (a lost hook is revived) */
  reattach(d: Decision, toolUseId: string): Decision {
    if (d.status === "hook_disconnected") {
      this.transition(d, "pending");
      this.expiredAt.delete(d.id);
    }
    if (toolUseId !== d.tool_use_id) {
      d.previous_tool_use_ids = [...(d.previous_tool_use_ids ?? []), d.tool_use_id];
      d.tool_use_id = toolUseId;
      this.byToolUse.set(toolUseId, d.id);
    }
    d.lease_until = new Date(Date.now() + this.opts.leaseGraceMs).toISOString();
    this.persist(d);
    this.emit("decision.updated", d);
    this.touchSession(d.session.session_id, { state: "waiting_decision" });
    return d;
  }

  /** The hook's budget for this leg ended: the decision stays pending and waits for the agent's next call. Memory and SSE only: the re-attach that follows persists the record, and a restart re-arms the lease */
  handoff(id: string, sessionId: string): Decision {
    const d = this.decisions.get(id);
    if (!d) throw new HttpError(404, "decision not found");
    if (d.session.session_id !== sessionId) throw new HttpError(403, "decision belongs to another session");
    if (d.status !== "pending") throw new HttpError(409, `cannot hand off a ${d.status} decision`);
    d.handoffs = (d.handoffs ?? 0) + 1;
    d.lease_until = new Date(Date.now() + (this.opts.handoffGraceMs ?? HANDOFF_GRACE_MS)).toISOString();
    this.emit("decision.updated", d);
    return d;
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
    this.setStatus(d, to);
  }

  submitAnswer(id: string, patch: AnswerPatch): Decision {
    const d = this.decisions.get(id);
    if (!d) throw new HttpError(404, "decision not found");
    const decided_at = new Date().toISOString();
    if ((patch.kind === "checkpoint") !== (d.kind === "checkpoint")) throw new HttpError(400, `this answer does not fit kind ${d.kind}`);
    if (patch.kind === "checkpoint") return this.answerCheckpoint(d, patch, decided_at);
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
    if (patch.kind === "answers") this.rememberCannotAnswer(d, patch.answers);
    this.emit("decision.updated", d);
    this.notify(d.id);
    return d;
  }

  /** pending -> answered directly: nobody waits for a checkpoint, so there is no hook ack. instruct / stop queue an instruction */
  private answerCheckpoint(d: Decision, patch: { answer: "continue" | "instruct" | "stop"; text?: string }, decidedAt: string): Decision {
    if (d.status !== "pending") throw new HttpError(409, `cannot answer a ${d.status} checkpoint`);
    const text = patch.text?.trim() ? patch.text : undefined;
    if (patch.answer === "instruct" && !text) throw new HttpError(400, "text is required for instruct");
    d.response = { via: "gui", kind: patch.answer, ...(text !== undefined && patch.answer !== "continue" ? { text } : {}), decided_at: decidedAt };
    this.setStatus(d, "answered");
    const claude = d.session.agent !== "codex";
    // Nothing to stop in an idle Claude Code session: delivered at once, nothing queued
    const noop = claude && patch.answer === "stop" && this.sessions.get(d.session.session_id)?.state === "idle";
    if (noop) {
      d.response = { ...d.response, delivered_at: decidedAt, delivered_via: "noop" };
      this.stoppedSessions.add(d.session.session_id);
    }
    this.persist(d);
    if (patch.answer !== "continue" && !noop) {
      this.instructions.set(d.session.session_id, { decision_id: d.id, kind: patch.answer, text: d.response.text ?? "", created_at: decidedAt });
    }
    this.emit("decision.updated", d);
    try {
      this.onCheckpointAnswered?.(d);
      if (claude && patch.answer === "instruct" && this.sessions.get(d.session.session_id)?.state === "idle") this.onCheckpointDeliverable?.(d);
    } catch {
      // A subscriber must not break the answer
    }
    return d;
  }

  /** "Cannot answer — ..." keeps one memo per session (overwritten) for the hook to enforce on the next explanation */
  private rememberCannotAnswer(d: Decision, answers: Record<string, string>): void {
    for (const [question, value] of Object.entries(answers)) {
      const c = parseCannotAnswer(value);
      if (!c) continue;
      this.rewrites.set(d.session.session_id, {
        question: firstQuestion(d) ?? question,
        reason: c.reason,
        terms: c.terms,
        body_hash: bodyHash(d.explanation?.markdown ?? ""),
        at: Date.now(),
      });
      return;
    }
  }

  /** Notification when the hook exits on SIGTERM / SIGINT / SIGHUP. pending becomes cancelled, answer_submitted becomes answer_lost */
  cancel(id: string, reason?: string): Decision {
    const d = this.decisions.get(id);
    if (!d) throw new HttpError(404, "decision not found");
    this.transition(d, d.status === "answer_submitted" ? "answer_lost" : "cancelled");
    if (reason) d.status_reason = reason;
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

  /** Wait until the decision becomes answer_submitted / fallback or times out. A timeout yields undefined */
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

  // ---- Lease monitoring ----

  startMonitor(): void {
    const interval = Math.min(1000, Math.max(20, Math.floor(this.opts.leaseGraceMs / 2)));
    this.monitor = setInterval(() => this.checkLeases(), interval);
    this.monitor.unref();
  }

  checkLeases(now = Date.now()): void {
    for (const d of this.decisions.values()) {
      if (d.kind === "checkpoint") {
        if (d.status === "pending" && now - Date.parse(d.created_at) > CHECKPOINT_TTL_MS) this.closeCheckpoint(d, "expired");
        continue;
      }
      if (!LIVE.includes(d.status) || !d.lease_until || Date.parse(d.lease_until) > now) continue;
      const to: DecisionStatus = d.status === "pending" ? "hook_disconnected" : "answer_lost";
      this.setStatus(d, to);
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

  // ---- Sessions and events ----

  private touchSession(
    sessionId: string,
    patch: { state?: SessionState; cwd?: string; title?: string; transcript_path?: string },
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
    const transcript = patch.transcript_path || cur?.transcript_path;
    if (transcript) next.transcript_path = transcript;
    if (cur?.terminal) next.terminal = cur.terminal;
    this.sessions.set(sessionId, next);
    if (live) this.emit("session.updated", next);
  }

  listSessions(): SessionSummary[] {
    return [...this.sessions.values()].sort((a, b) => b.last_event_at.localeCompare(a.last_event_at));
  }

  addEvent(ev: EventInput): void {
    // Raw hook input (tool_input / tool_response / prompt, etc.) is not stored
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
    if (ev.blocker_detected) this.blockersDetected++;
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
    this.touchSession(ev.session_id, { state, cwd: ev.cwd, transcript_path: ev.transcript_path }, live, Number.isFinite(at) ? ev.received_at : undefined);
    if (live && (ev.hook_event_name === "UserPromptSubmit" || ev.hook_event_name === "Stop")) {
      this.cancelRecentlyDisconnected(ev.session_id);
    }
    if (live && ev.hook_event_name === "UserPromptSubmit") {
      this.cancelPending(ev.session_id);
      this.stoppedSessions.delete(ev.session_id);
      this.dropQueuedStop(ev.session_id);
    }
    if (live && ev.hook_event_name === "Stop") this.offerQueuedInstruction(ev.session_id);
    if (ev.hook_event_name === "SessionEnd") this.endCheckpoints(ev.session_id, live);
    if (live) this.onSessionEvent?.(ev.session_id, ev.hook_event_name);
  }

  /** The session ended: its pending checkpoints and the instruction nobody can receive any more are dropped */
  private endCheckpoints(sessionId: string, live: boolean): void {
    this.instructions.delete(sessionId);
    this.stoppedSessions.delete(sessionId);
    if (!live) return;
    for (const d of this.decisions.values()) {
      if (d.kind === "checkpoint" && d.session.session_id === sessionId && d.status === "pending") this.closeCheckpoint(d, "session_end");
    }
  }

  /** The human typed a new prompt: a queued stop would deny the first tool call of that prompt. A queued instruct stays */
  private dropQueuedStop(sessionId: string): void {
    const ins = this.instructions.get(sessionId);
    if (ins?.kind !== "stop") return;
    this.instructions.delete(sessionId);
    this.markDelivered(ins.decision_id, "noop"); // nothing left to stop
  }

  /** The agent went idle without calling a tool: an instruct still queued for it goes to the terminal delivery */
  private offerQueuedInstruction(sessionId: string): void {
    const ins = this.instructions.get(sessionId);
    if (!ins) return;
    const d = this.decisions.get(ins.decision_id);
    if (!d || d.session.agent === "codex") return;
    if (ins.kind === "stop") {
      // The agent stopped on its own before the deny could reach it: nothing to stop
      this.instructions.delete(sessionId);
      this.markDelivered(ins.decision_id, "noop");
      this.stoppedSessions.add(sessionId);
      return;
    }
    try {
      this.onCheckpointDeliverable?.(d);
    } catch {
      // A subscriber must not break the event
    }
  }

  /** The human spoke next in the terminal = the pending decision is no longer being waited for */
  private cancelPending(sessionId: string): void {
    for (const d of this.decisions.values()) {
      if (d.session.session_id !== sessionId || d.status !== "pending") continue;
      this.transition(d, "cancelled");
      if (d.kind === "checkpoint") d.status_reason = "new_prompt";
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
      this.setStatus(d, "cancelled");
      this.persist(d);
      this.emit("decision.updated", d);
    }
  }

  // ---- "Approve and auto" ----

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

  // ---- "Cannot answer" ----

  getRewrite(sessionId: string): PendingRewrite {
    return this.rewrites.get(sessionId) ?? null;
  }

  consumeRewrite(sessionId: string): boolean {
    return this.rewrites.delete(sessionId);
  }

  // ---- Aggregation ----

  metrics(): Metrics {
    const count = { answered: 0, fallback: 0, hook_disconnected: 0, answer_lost: 0, cancelled: 0 };
    const human: number[] = [];
    const agent: number[] = [];
    const d = { first_call: 0, after_deny: 0, none: 0 };
    let cannot = 0;
    let handoffs = 0;
    let reattached = 0;
    const cp = { created: 0, answered: 0, delivered: 0 };
    for (const x of this.decisions.values()) {
      if (x.kind === "checkpoint") {
        cp.created++;
        if (x.status === "answered") cp.answered++;
        if (x.response?.delivered_at) cp.delivered++;
        continue;
      }
      if (x.status === "denied_explain") continue;
      handoffs += x.handoffs ?? 0;
      reattached += x.previous_tool_use_ids?.length ?? 0;
      if (x.status in count) count[x.status as keyof typeof count]++;
      if (x.response?.answers && Object.values(x.response.answers).some((v) => parseCannotAnswer(v))) cannot++;
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
      a: { ...count, escaped_question: this.escapedQuestions, blocker_detected: this.blockersDetected, handoffs, reattached, cannot_answer: cannot, total, rate: total === 0 ? null : count.answered / total },
      b: { human: stat(human), agent: stat(agent), baseline: stat(this.baseline) },
      c: { session_panel_opens: this.panelOpens, checkpoints: cp },
      d: { ...d, total: dTotal, attach_rate: dTotal === 0 ? null : (d.first_call + d.after_deny) / dTotal },
    };
  }
}
