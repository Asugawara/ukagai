import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  CANCEL_WINDOW_MS,
  CHECKPOINT_TTL_MS,
  DELIVERY_MAX_ATTEMPTS,
  MESSAGE_TTL_MS,
  MOD_BACKOFF_MAX_MS,
  MOD_CLAIM_STALE_MS,
  MOD_END_GRACE_MS,
  MOD_FRESH_MS,
  MOD_GONE_MS,
  MOD_OWNER_RE,
  PLAN_GRANT_TTL_MS,
  deliveryRef,
  type PlanGrant,
  type PollResponse,
  type Waiting,
  checkpointFingerprint,
  type DeliveredVia,
  checkpointToolUseId,
  DENY_LINK_WINDOW_MS,
  HANDOFF_GRACE_MS,
  INSTRUCTION_MAX_CHARS,
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
  type PendingRewrite,
  type SessionState,
  type SessionSummary,
} from "../contract.js";
import { deliveryText, instructionParts } from "./delivery-text.js";
import { transcriptHasDelivery } from "./history.js";
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
  /** One line to serve.log (plan_instruction_dropped, message_to_classic) */
  log?: (event: string, fields?: Record<string, string | number | undefined>) => void;
  /** Settings `claude.message_delivery`, read when a decision is registered (default: on) */
  messageDelivery?: () => boolean;
  /** The clock of the message-delivery rules (default Date.now; tests drive it) */
  now?: () => number;
};

/** An instruction in the mod's inbox (the text is built from `source` when it is claimed) */
type MessageInstruction = {
  /** Its ref (the first characters) leads the delivery text */
  id: string;
  session_id: string;
  transcript_path: string | undefined;
  source: Instruction;
  /** The texts in the order they were answered, each worded with its own prefix (a reply and a plan instruction may be joined) */
  parts: { text: string; about?: "plan" }[];
  /** Every checkpoint the item answers: all are marked delivered when it closes */
  decision_ids: string[];
  /** When the newest text was answered (a join renews it) */
  created_at: string;
  claim?: { owner: string; at: string; offset: number };
  /** The transcript size at the first claim: a plugin line with the ref after it means a submit got in */
  first_offset?: number;
  attempts: number;
};

/** What an inbox request answers: the HTTP status and, for 200 / 409, the decision's status */
export type InboxResult = { http: 200 | 409; status: DecisionStatus } | { http: 404 };

export type AnswerPatch =
  | { kind: "answers"; answers: Record<string, string> }
  | { kind: "approve"; set_mode_auto?: boolean }
  | { kind: "reject"; reason?: string }
  | { kind: "instruct_plan"; text: string }
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
  "wakeup",
  "blocker_detected",
  "observe",
  "notification_type",
  "delivered_ref",
] as const;
const LIVE: readonly DecisionStatus[] = ["pending", "answer_submitted"];

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** PostToolUse of a tool that changes files: the agent did something even in a wake-up turn */
function isFileChange(ev: EventInput): boolean {
  return ev.hook_event_name === "PostToolUse" && FILE_TOOLS.has(String((ev as Record<string, unknown>).tool_name ?? ""));
}

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

/** The text of a plan request, trimmed ("" when there is none) */
function planText(request: Decision["request"]): string {
  const plan = (request as { plan?: unknown }).plan;
  return typeof plan === "string" ? plan.trim() : "";
}

/** A running-subagent entry older than this is ignored (a lost SubagentStop or a killed task must not hide the plan forever) */
export const SUBAGENT_TTL_MS = 60 * 60_000;
/** A wake-up-due mark older than this is ignored */
export const WAKEUP_DUE_TTL_MS = 2 * 60_000;

export class Store {
  private decisions = new Map<string, Decision>();
  private byToolUse = new Map<string, string>();
  private sessions = new Map<string, SessionSummary>();
  private rewrites = new Map<string, NonNullable<PendingRewrite>>();
  private expiredAt = new Map<string, number>();
  private waiters = new Map<string, Set<() => void>>();
  /** Answered checkpoints whose text has not reached the agent yet: one per session, newest wins */
  private instructions = new Map<string, Instruction>();
  /** Claude Code sessions whose last delivered instruction was a stop and that have not had a UserPromptSubmit since */
  private stoppedSessions = new Set<string>();
  /** When the session's agent last did something (a hook event or a decision its hook registered), as epoch ms. Insertions of checkpoints, answers and settings do not count */
  private lastActivity = new Map<string, number>();
  /** Sessions whose last UserPromptSubmit was a harness wake-up: their events are not activity (see applyEvent) */
  private wakeupTurns = new Set<string>();
  /** session -> running background subagents (agent_id -> SubagentStart received_at, epoch ms) */
  private runningSubagents = new Map<string, Map<string, number>>();
  /** session -> when a SubagentStop arrived while the agent was idle (epoch ms): the harness starts a wake-up turn; cleared by the next UserPromptSubmit */
  private wakeupDue = new Map<string, number>();
  /** Called after each live hook event of a session (the recap watcher reads that session's transcript now) */
  onSessionEvent: ((sessionId: string, hookEvent: string) => void) | undefined;
  /** Called after a checkpoint is answered (the Codex bridge delivers its answer in-process; Claude's hook polls the instruction instead) */
  onCheckpointAnswered: ((d: Decision) => void) | undefined;
  /** Claude Code checkpoints: an answered instruct that an idle agent will not pick up by itself (the terminal delivery types it) */
  onCheckpointDeliverable: ((d: Decision) => void) | undefined;
  /** A checkpoint was created for a session (the terminal delivery looks up where its terminal is) */
  onCheckpointCreated: ((d: Decision) => void) | undefined;
  /** Types a queued plan instruction into the idle agent's terminal; true when it went in (set by the terminal delivery) */
  deliverPlanInstruction: ((sessionId: string, ins: Instruction) => Promise<boolean>) | undefined;
  private monitor: NodeJS.Timeout | undefined;
  /** When this store started: an owner named by a stored decision counts as seen then, so a restart does not hand its items to another owner */
  private readonly startedAt: number;
  /** `<session>\0<owner>` -> when the mod's last inbox request for that session was accepted (epoch ms) */
  private ownerSeen = new Map<string, number>();
  /** session -> when its SessionEnd arrived (epoch ms): its message-delivery decisions close unless a mod keeps polling it */
  private endMarks = new Map<string, number>();
  /** Instructions (a checkpoint reply, a plan instruction) handed to a live mod instead of the hook / the terminal: item id -> item, one per session */
  private messageInstructions = new Map<string, MessageInstruction>();
  /** ref of an inbox instruction -> session: a prompt that starts with it is the mod's delivery, not the human (kept after the item closes: the hook's event can arrive after the ack) */
  private instructionRefs = new Map<string, string>();
  /** Sessions whose inbox delivery was given up: their next instruction is not offered to the mod again until one reaches the agent */
  private modBypass = new Map<string, number>();
  /** First checkpoint of a joined instruction -> the others it carries, marked delivered with it */
  private joinedIds = new Map<string, string[]>();

  // Aggregates rebuilt from events
  private escapedQuestions = 0;
  /** Sessions whose last Stop was an escaped question (the agent asked in the terminal and waits there); cleared by the next UserPromptSubmit or the end of the session */
  private askedInTerminal = new Set<string>();
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
    this.startedAt = this.clock();
  }

  private clock(): number {
    return this.opts.now?.() ?? Date.now();
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
          if (d.kind !== "checkpoint") this.markActivity(d.session?.session_id, Date.parse(d.created_at));
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
      // A message-delivery decision has no hook behind it, so no lease either
      if (LIVE.includes(d.status) && d.kind !== "checkpoint" && d.delivery !== "message") d.lease_until = lease;
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
    const now = this.clock();
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
    const now = this.clock();
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
      if (this.wantsMessageDelivery(req, now)) {
        decision.delivery = "message";
        decision.mod_owner = req.mod_owner!;
      } else decision.lease_until = new Date(now + this.opts.leaseGraceMs).toISOString();
      const denial = req.explanation?.attached_via === "after_deny" ? this.findRecentDenial(decision, now) : undefined;
      if (denial) decision.first_denied_at = denial.created_at;
    }
    this.decisions.set(decision.id, decision);
    this.byToolUse.set(decision.tool_use_id, decision.id);
    this.persist(decision);
    this.markActivity(session.session_id, now);
    // The agent reached ExitPlanMode: an instruction queued for the plan it was writing is stale (the human instructs on the approval card now)
    const stale = this.instructions.get(session.session_id);
    if (!denied && req.kind === "approve_plan" && stale?.about === "plan" && stale.decision_id === "") {
      this.instructions.delete(session.session_id);
      this.modBypass.delete(session.session_id);
      this.opts.log?.("plan_instruction_dropped", { session: session.session_id, decision: decision.id });
    }
    if (!denied && req.kind === "approve_plan") {
      for (const [id, m] of this.messageInstructions) {
        if (m.session_id !== session.session_id || m.claim || m.decision_ids.length > 0 || !m.parts.every((x) => x.about === "plan")) continue;
        this.messageInstructions.delete(id);
        this.opts.log?.("plan_instruction_dropped", { session: session.session_id, decision: decision.id });
      }
    }
    if (!denied) {
      this.emit("decision.created", decision);
      this.touchSession(session.session_id, { state: "waiting_decision", cwd: session.cwd, title: session.title });
    }
    // A new plan of the main agent, whether it waits for message delivery or for the hook, replaces the session's earlier plans: the
    // message-delivery ones close, and an approval of any of them no longer lets it through (the human decides again). A subagent's plan
    // is not the main agent's next plan: it leaves them
    if (!denied && req.kind === "approve_plan" && session.agent_id === undefined) this.supersedePlans(decision);
    return { decision, created: true };
  }

  /** A progress recap seen in the session's transcript: supersedes the session's pending checkpoint and never changes the session state */
  createCheckpoint(
    session: SessionSummary & { agent?: "claude" | "codex" },
    recap: string,
    recapAt: string,
  ): { decision: Decision; created: boolean; skipped?: undefined } | { decision?: undefined; created: false; skipped: "after_stop" | "no_progress" | "decision_pending" } {
    if (session.agent !== "codex") {
      // The human told the agent to stop: no more progress checks until they speak again (Claude Code only; the Codex bridge handles its own)
      if (this.stoppedSessions.has(session.session_id)) return { created: false, skipped: "after_stop" };
      // A question waits for its answer to be delivered as a message: a card now would be a second thing to answer for the same agent
      if (this.hasOpenAsync(session.session_id)) return { created: false, skipped: "decision_pending" };
      // Claude Code rewrites its recap while idle: a new card needs the agent to have done something since the last one
      if (!this.hasProgressSinceLastCheckpoint(session.session_id)) return { created: false, skipped: "no_progress" };
    }
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

  private markActivity(sessionId: string | undefined, at: number): void {
    if (!sessionId || !Number.isFinite(at)) return;
    if (at > (this.lastActivity.get(sessionId) ?? 0)) this.lastActivity.set(sessionId, at);
  }

  /** True when the session has no checkpoint yet, or its agent was active after the newest one was created */
  private hasProgressSinceLastCheckpoint(sessionId: string): boolean {
    let newest = -Infinity;
    for (const d of this.decisions.values()) {
      if (d.kind === "checkpoint" && d.session.session_id === sessionId) newest = Math.max(newest, Date.parse(d.created_at));
    }
    if (!Number.isFinite(newest)) return true;
    return (this.lastActivity.get(sessionId) ?? 0) > newest;
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
    this.modBypass.delete(d.session.session_id);
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
    this.modBypass.delete(sessionId);
    this.markDelivered(ins.decision_id, via);
    if (ins.kind === "stop" && this.decisions.get(ins.decision_id)?.session.agent !== "codex") this.stoppedSessions.add(sessionId);
    return ins;
  }

  private markDelivered(decisionId: string, via: DeliveredVia): void {
    const joined = this.joinedIds.get(decisionId);
    if (joined) {
      this.joinedIds.delete(decisionId);
      for (const x of joined) this.markDelivered(x, via);
    }
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
      if (this.sessions.get(sid)?.state !== "idle" || this.clock() - Date.parse(ins.created_at) > maxAgeMs || this.hasOpenAsync(sid)) return undefined;
      this.instructions.delete(sid);
      this.modBypass.delete(sid);
      return ins;
    }
    return undefined;
  }

  /**
   * An instruction from a plan file card: queued for the session's next tool call (newest wins, like a checkpoint reply). An idle
   * Claude Code agent calls no tool, so it is offered to the terminal delivery, which resolves with how it went
   */
  async queuePlanInstruction(sessionId: string, text: string): Promise<DeliveredVia> {
    // The store's clock, like a checkpoint reply's `decided_at`: the instruction's time limit is checked against it
    const created_at = new Date(this.clock()).toISOString();
    const queued = this.instructions.get(sessionId);
    // A queued stop must still reach the agent; a queued reply or earlier plan instruction keeps its identity (so its checkpoint is marked delivered) and the texts are joined
    if (queued?.kind === "stop") throw new HttpError(409, "a stop is queued for this session");
    // A queued reply with no text of its own would make the hook word the plan text as a recap reply: such a join is worded as a plan instruction
    const ins: Instruction = queued
      ? queued.text.trim() === ""
        ? { ...queued, text: text.slice(0, INSTRUCTION_MAX_CHARS), about: "plan" }
        : { ...queued, text: `${queued.text}\n${text}`.slice(0, INSTRUCTION_MAX_CHARS) }
      : { decision_id: "", kind: "instruct", text, created_at, about: "plan" };
    this.instructions.set(sessionId, ins);
    if (this.sessions.get(sessionId)?.state === "idle" && !this.hasOpenAsync(sessionId) && this.offerToMod(sessionId)) return "message";
    if (this.sessions.get(sessionId)?.state !== "idle" || !this.deliverPlanInstruction || this.hasOpenAsync(sessionId)) return "hook";
    try {
      return (await this.deliverPlanInstruction(sessionId, ins)) ? "terminal" : "hook";
    } catch {
      return "hook";
    }
  }

  /** A claimed instruction could not be typed: back on the queue for the hook, unless a newer one took its place */
  requeueInstruction(sessionId: string, ins: Instruction): void {
    if (!this.instructions.has(sessionId)) this.instructions.set(sessionId, ins);
  }

  /** The queued plan instruction of a session, taken off the queue for the terminal delivery (undefined when the hook took it first or the agent is not idle) */
  claimPlanInstruction(sessionId: string, ins: Instruction): Instruction | undefined {
    if (this.instructions.get(sessionId) !== ins || this.sessions.get(sessionId)?.state !== "idle" || this.hasOpenAsync(sessionId)) return undefined;
    this.instructions.delete(sessionId);
    this.modBypass.delete(sessionId);
    return ins;
  }

  /** A claimed instruction reached the agent's terminal */
  deliveredToTerminal(decisionId: string): void {
    this.markDelivered(decisionId, "terminal");
  }

  /** The newest decision of the session and agent that is still open (pending, its hook went away, or a message-delivery answer not delivered yet) and asks the same thing */
  findOpen(sessionId: string, agentId: string | undefined, fingerprint: string): Decision | undefined {
    let best: Decision | undefined;
    for (const d of this.decisions.values()) {
      if (d.kind === "checkpoint" || d.session.session_id !== sessionId || (d.session.agent_id ?? "") !== (agentId ?? "") || d.fingerprint !== fingerprint) continue;
      if (d.status !== "pending" && d.status !== "hook_disconnected" && !(d.delivery === "message" && d.status === "answer_submitted")) continue;
      if (!best || d.created_at > best.created_at) best = d;
    }
    return best;
  }

  /**
   * The tool was called again: what the hook does with it. A decision a live mod is delivering right now is left alone (`delivering`);
   * any other open message-delivery decision is switched to the long-poll first, because the agent is now waiting for the answer here
   */
  openFor(sessionId: string, agentId: string | undefined, fingerprint: string, toolUseId: string): { decision: Decision } | { delivering: { decision_id: string } } | undefined {
    const d = this.findOpen(sessionId, agentId, fingerprint);
    if (!d) return undefined;
    if (d.delivery === "message") {
      // An approval that no longer lets the plan through (revoked) must not come back through the waiting hook either: the human decides again
      if (this.approvalWithoutGrant(d)) {
        this.closeUndelivered(d, "superseded");
        const after = d.status as DecisionStatus;
        if (after !== "pending" && after !== "answer_submitted") return undefined;
        return { delivering: { decision_id: d.id } }; // a live mod still holds it: its ack or release closes it
      }
      if (d.status === "answer_submitted" && d.claim) {
        if (this.claimAlive(d, this.clock())) return { delivering: { decision_id: d.id } };
        this.settleDeadClaim(d);
        const after = d.status as DecisionStatus; // settleDeadClaim may have changed it
        if (after !== "pending" && after !== "answer_submitted") return undefined; // delivered after all, or closed
      }
      this.switchToClassic(d);
    }
    return { decision: this.reattach(d, toolUseId) };
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
    if (d.delivery === "message") throw new HttpError(409, "a message-delivery decision has no hook to hand off");
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
    // The store's clock: a plan's grant lasts PLAN_GRANT_TTL_MS from this
    const decided_at = new Date(this.clock()).toISOString();
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
        response = { via: "gui", approve: false, decided_at };
        if (patch.reason) response.reason = patch.reason;
        break;
      case "instruct_plan":
        response = { via: "gui", instruct: true, text: patch.text, decided_at };
        break;
      case "fallback":
        response = { via: "terminal", decided_at };
        to = "fallback";
        break;
    }
    this.transition(d, to);
    d.response = response;
    this.persist(d);
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
      if (claude && patch.answer === "instruct" && this.sessions.get(d.session.session_id)?.state === "idle" && !this.hasOpenAsync(d.session.session_id) && !this.offerToMod(d.session.session_id)) this.onCheckpointDeliverable?.(d);
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
    if (d.delivery === "message") throw new HttpError(409, "a message-delivery decision is not waited for by a hook");
    this.transition(d, d.status === "answer_submitted" ? "answer_lost" : "cancelled");
    if (reason) d.status_reason = reason;
    delete d.lease_until;
    this.persist(d);
    this.emit("decision.updated", d);
    this.notify(d.id);
    return d;
  }

  /**
   * The waiting hook took the answer. A plan approval's grant is used by the hook's own allow, unless the hook leaves an "approve and auto"
   * grant of the main agent to the PermissionRequest of the same ExitPlanMode (`keepPlanGrant`), the only place the mode can switch
   */
  ack(id: string, keepPlanGrant = false): Decision {
    const d = this.decisions.get(id);
    if (!d) throw new HttpError(404, "decision not found");
    if (d.delivery === "message") throw new HttpError(409, "a message-delivery decision is acknowledged by the mod");
    this.transition(d, "answered");
    d.response = { ...d.response!, delivered_at: new Date().toISOString() };
    if (d.kind === "approve_plan" && d.response.approve === true) {
      // the mark of an approval the hook took: only such a record holds a grant for the waiting hook (an older record has none)
      d.response.delivered_via = "hook";
      const grant = this.grantOf(d, this.clock());
      if (!(keepPlanGrant && grant?.mode === "auto" && d.session.agent_id === undefined)) {
        d.grant_used_at = new Date(this.clock()).toISOString();
        if (d.response.set_mode_auto) d.delivery_flag = "auto_not_applied";
      }
    }
    delete d.lease_until;
    this.persist(d);
    this.emit("decision.updated", d);
    this.touchSession(d.session.session_id, { state: "working" });
    return d;
  }

  private extendLease(d: Decision, timeoutMs: number): void {
    if (!LIVE.includes(d.status) || d.delivery === "message") return;
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

  checkLeases(now = this.clock()): void {
    for (const d of [...this.decisions.values()]) {
      if (d.kind === "checkpoint") {
        if (d.status === "pending" && now - Date.parse(d.created_at) > CHECKPOINT_TTL_MS) this.closeCheckpoint(d, "expired");
        continue;
      }
      if (d.delivery === "message") {
        if (LIVE.includes(d.status)) this.checkMessageDelivery(d, now);
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
    this.checkEndMarks(now);
    this.checkNoAgent(now);
    this.checkInstructions(now);
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

  /** The session's last Stop ended with a question put in the terminal: the human is being asked there */
  isAskedInTerminal(sessionId: string): boolean {
    return this.askedInTerminal.has(sessionId);
  }

  /** The session's Stop is not final: a background subagent still runs, or the wake-up turn its end triggers has not started. Stale marks are ignored */
  isWaitingOnSubagents(sessionId: string, now = Date.now()): boolean {
    const due = this.wakeupDue.get(sessionId);
    if (due !== undefined && now - due <= WAKEUP_DUE_TTL_MS) return true;
    for (const at of this.runningSubagents.get(sessionId)?.values() ?? []) if (now - at <= SUBAGENT_TTL_MS) return true;
    return false;
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
    if (ev.hook_event_name === "UserPromptSubmit") {
      if (ev.wakeup) this.wakeupTurns.add(ev.session_id);
      else this.wakeupTurns.delete(ev.session_id);
    }
    // A wake-up turn is the harness polling the agent: only a change to files counts as progress
    if (!this.wakeupTurns.has(ev.session_id) || isFileChange(ev)) this.markActivity(ev.session_id, Date.parse(ev.received_at));
    this.trackSubagents(ev);
    if (ev.escaped_question) this.escapedQuestions++;
    if (ev.hook_event_name === "Stop" && ev.escaped_question) this.askedInTerminal.add(ev.session_id);
    else if (ev.hook_event_name === "Stop" || ev.hook_event_name === "UserPromptSubmit" || ev.hook_event_name === "SessionEnd") this.askedInTerminal.delete(ev.session_id);
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
    // A wake-up prompt is the harness, not the human: it neither cancels pending cards nor lifts / drops a stop.
    // A prompt that starts with the ref of a message-delivery decision is the mod's delivery (the hook saw it before it could be dropped): not the human either
    if (live && ev.hook_event_name === "UserPromptSubmit" && !ev.wakeup) {
      const delivery = ev.delivered_ref ? this.findByRef(ev.session_id, ev.delivered_ref) : undefined;
      if (delivery) this.noteRefSeen(delivery, ev.received_at);
      else if (ev.delivered_ref && this.instructionRefs.get(ev.delivered_ref) === ev.session_id) {
        // The mod delivering an inbox instruction: not the human either. It closes by ack or by the transcript, not by this event
      } else {
        const receivedAt = Number.isFinite(at) ? at : Infinity;
        this.cancelPending(ev.session_id, receivedAt);
        this.humanPrompted(ev.session_id, receivedAt, ev.received_at);
        this.stoppedSessions.delete(ev.session_id);
        this.dropQueuedStop(ev.session_id);
      }
    }
    if (live && ev.hook_event_name === "Stop") this.offerQueuedInstruction(ev.session_id);
    // ExitPlanMode went through without using the grant (Claude Code's own dialog, or no PermissionRequest): the session is out of plan mode, so no grant of it is wanted any more
    if (live && ev.hook_event_name === "PostToolUse" && (ev as Record<string, unknown>).tool_name === "ExitPlanMode" && !ev.agent_id && !ev.observe) {
      this.planExited(ev.session_id);
    }
    // The main agent's session is out of plan mode after the human decided (they left it by hand, or the plan went through some other way):
    // an approval of that time lets nothing through any more. A late event built before the decision does not count
    const mode = (ev as Record<string, unknown>).permission_mode;
    if (live && typeof mode === "string" && mode !== "plan" && !ev.agent_id && Number.isFinite(at)) this.revokeGrantsBefore(ev.session_id, at);
    if (live && ev.hook_event_name === "SessionEnd") {
      this.endMarks.set(ev.session_id, Number.isFinite(at) ? at : this.clock());
      // A delivered approval waits for no mod: it is written off now, so a restart within the grace cannot keep it (undelivered ones keep the grace)
      for (const d of this.plansOf(ev.session_id)) if (d.status === "answered") this.revokeGrant(d);
    }
    if (ev.hook_event_name === "SessionEnd") this.endCheckpoints(ev.session_id, live);
    if (live) this.onSessionEvent?.(ev.session_id, ev.hook_event_name);
  }

  private trackSubagents(ev: EventInput): void {
    const sid = ev.session_id;
    const at = Date.parse(ev.received_at);
    if (ev.hook_event_name === "SubagentStart" && ev.agent_id && Number.isFinite(at)) {
      let m = this.runningSubagents.get(sid);
      if (!m) this.runningSubagents.set(sid, (m = new Map()));
      m.set(ev.agent_id, at);
    } else if (ev.hook_event_name === "SubagentStop") {
      this.runningSubagents.get(sid)?.delete(ev.agent_id ?? "");
      // The agent already stopped: the harness wakes it with a task notification
      if (this.sessions.get(sid)?.state === "idle" && Number.isFinite(at)) this.wakeupDue.set(sid, at);
    } else if (ev.hook_event_name === "UserPromptSubmit") {
      this.wakeupDue.delete(sid);
    } else if (ev.hook_event_name === "SessionEnd") {
      this.wakeupDue.delete(sid);
      this.runningSubagents.delete(sid);
    }
  }

  /** The session ended: its pending checkpoints and the instruction nobody can receive any more are dropped */
  private endCheckpoints(sessionId: string, live: boolean): void {
    this.instructions.delete(sessionId);
    this.dropMessageInstructions(sessionId);
    this.modBypass.delete(sessionId);
    for (const [ref, sid] of this.instructionRefs) if (sid === sessionId) this.instructionRefs.delete(ref);
    this.wakeupTurns.delete(sessionId);
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
    this.modBypass.delete(sessionId);
    this.markDelivered(ins.decision_id, "noop"); // nothing left to stop
  }

  /** The agent went idle without calling a tool: an instruct still queued for it goes to the terminal delivery */
  private offerQueuedInstruction(sessionId: string): void {
    const ins = this.instructions.get(sessionId);
    if (!ins) return;
    // Typing now would start a turn whose first prompt cancels the question that waits for its answer: the reply stays queued for the next tool call
    if (this.hasOpenAsync(sessionId)) return;
    // A live mod delivers it as a message; without one it is typed into the terminal below
    if (this.offerToMod(sessionId)) return;
    // A plan instruction has no decision behind it: type it now that the agent is idle
    if (ins.about === "plan" && ins.decision_id === "") {
      void Promise.resolve(this.deliverPlanInstruction?.(sessionId, ins)).catch(() => {});
      return;
    }
    const d = this.decisions.get(ins.decision_id);
    if (!d || d.session.agent === "codex") return;
    if (ins.kind === "stop") {
      // The agent stopped on its own before the deny could reach it: nothing to stop
      this.instructions.delete(sessionId);
      this.modBypass.delete(sessionId);
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

  /**
   * The human spoke next in the terminal = the pending decision is no longer being waited for. Only decisions registered no later than the
   * prompt count: the prompt's event is built when the hook runs and may reach the server late, after the same turn registered a new one
   */
  private cancelPending(sessionId: string, receivedAt: number): void {
    for (const d of this.decisions.values()) {
      if (d.session.session_id !== sessionId || d.status !== "pending" || Date.parse(d.created_at) > receivedAt) continue;
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

  // ---- Message delivery ----

  private wantsMessageDelivery(req: CreateDecisionRequest, now: number): boolean {
    const owner = req.mod_owner;
    if (owner === undefined || !MOD_OWNER_RE.test(owner)) return false;
    if (req.kind === "checkpoint" || req.session.agent_id !== undefined || req.session.agent === "codex") return false;
    // A plan without text would be identified by its file path alone: its approval must not become a pass for whatever the file holds next
    if (req.kind === "approve_plan" && !planText(req.request)) return false;
    if (this.opts.messageDelivery && !this.opts.messageDelivery()) return false;
    const seen = this.ownerSeen.get(`${req.session.session_id}\0${owner}`);
    if (seen === undefined || now - seen > MOD_FRESH_MS) return false;
    // An irreversible question outside plan mode keeps the hook waiting (the tools of other kinds are not held back, so the agent could act before the answer)
    if (req.explanation?.reversibility === "irreversible" && req.session.permission_mode !== "plan") return false;
    return true;
  }

  private markSeen(sessionId: string, owner: string): void {
    this.ownerSeen.set(`${sessionId}\0${owner}`, this.clock());
  }

  /** Some mod polled the session within `windowMs` (a mod actually seen since this server started) */
  private liveOwner(sessionId: string, windowMs: number, now: number): boolean {
    const prefix = `${sessionId}\0`;
    for (const [k, at] of this.ownerSeen) if (k.startsWith(prefix) && now - at <= windowMs) return true;
    return false;
  }

  /** Whether `owner`, named by a decision of the session, is alive: seen within MOD_CLAIM_STALE_MS, or (not seen since this server started) the server started that recently */
  private ownerAlive(sessionId: string, owner: string | undefined, now: number): boolean {
    if (!owner) return false;
    const at = this.ownerSeen.get(`${sessionId}\0${owner}`) ?? this.startedAt;
    return now - at <= MOD_CLAIM_STALE_MS;
  }

  private claimAlive(d: Decision, now: number): boolean {
    return d.claim !== undefined && this.ownerAlive(d.session.session_id, d.claim.owner, now);
  }

  private asyncOf(sessionId: string): Decision[] {
    const out: Decision[] = [];
    for (const d of this.decisions.values()) if (d.delivery === "message" && d.session.session_id === sessionId) out.push(d);
    return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  /** The session's plans, for message delivery or for the waiting hook: the ones that can hold a grant */
  private plansOf(sessionId: string): Decision[] {
    const out: Decision[] = [];
    for (const d of this.decisions.values()) if (d.kind === "approve_plan" && d.session.session_id === sessionId) out.push(d);
    return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  /** A message-delivery decision of the session waits for its answer or for the answer to be delivered, and a mod is there to deliver it */
  hasOpenAsync(sessionId: string): boolean {
    return this.asyncOf(sessionId).some((d) => LIVE.includes(d.status) && d.delivery_flag === undefined);
  }

  /** The decision whose id starts with `ref` among the session's message-delivery decisions (any status) */
  private findByRef(sessionId: string, ref: string): Decision | undefined {
    return this.asyncOf(sessionId).find((d) => deliveryRef(d.id) === ref);
  }

  private noteRefSeen(d: Decision, at: string): void {
    if (d.ref_seen_at) return;
    d.ref_seen_at = at;
    this.persist(d);
  }

  /** The human typed in the terminal: an answer waiting for delivery is either delivered after their turn (a mod is there) or dropped */
  private humanPrompted(sessionId: string, receivedAt: number, receivedIso: string): void {
    const live = this.liveOwner(sessionId, MOD_FRESH_MS, this.clock());
    for (const d of this.asyncOf(sessionId)) {
      if (d.status !== "answer_submitted" || Date.parse(d.created_at) > receivedAt) continue;
      if (live) {
        d.human_prompt_at = receivedIso;
        this.persist(d);
        this.emit("decision.updated", d);
      } else this.closeUndelivered(d, "typed_in_terminal");
    }
  }

  /** The decision that holds the main agent's tools back right now (oldest first), or undefined */
  waitingFor(sessionId: string): Waiting | undefined {
    if (!this.liveOwner(sessionId, MOD_FRESH_MS, this.clock())) return undefined;
    for (const d of this.asyncOf(sessionId)) {
      const holds = d.status === "pending" || (d.status === "answer_submitted" && !d.claim && !d.human_prompt_at);
      if (holds && (d.kind === "answer_question" || d.kind === "approve_plan")) return { decision_id: d.id, kind: d.kind };
    }
    return undefined;
  }

  /** The long-poll takes the decision back: the agent called the tool again and waits for the answer here */
  private switchToClassic(d: Decision): void {
    delete d.delivery;
    delete d.mod_owner;
    delete d.claim;
    delete d.human_prompt_at;
    delete d.close_reason;
    delete d.delivery_flag;
    this.opts.log?.("message_to_classic", { session: d.session.session_id, decision: d.id });
  }

  private transcriptSize(d: Decision): number {
    try {
      return statSync(d.session.transcript_path).size;
    } catch {
      return 0;
    }
  }

  private completeDelivery(d: Decision): void {
    // A superseded approval reached the agent anyway (its submit was already under way): it lets nothing through, so it is not an answer
    if (d.close_reason === "superseded") {
      this.loseDelivery(d, "superseded");
      return;
    }
    this.transition(d, "answered");
    d.response = { ...d.response!, delivered_at: new Date(this.clock()).toISOString(), delivered_via: "message" };
    delete d.claim;
    delete d.close_reason;
    this.persist(d);
    this.emit("decision.updated", d);
    this.notify(d.id);
  }

  private loseDelivery(d: Decision, reason: string): void {
    this.transition(d, "answer_lost");
    d.status_reason = reason;
    delete d.claim;
    delete d.close_reason;
    this.persist(d);
    this.emit("decision.updated", d);
    this.notify(d.id);
  }

  /** The claim of a mod that is gone (or released without a drop) ends: the transcript says whether the message got in */
  private settleDeadClaim(d: Decision): void {
    const claim = d.claim;
    if (!claim) return;
    delete d.claim;
    if (transcriptHasDelivery(d.session.transcript_path, claim.offset, deliveryRef(d.id))) this.completeDelivery(d);
    else if (d.close_reason) this.loseDelivery(d, d.close_reason);
    else {
      this.persist(d);
      this.emit("decision.updated", d);
    }
  }

  /** Close a message-delivery decision whose answer has not been delivered (session_end, expired, typed_in_terminal, superseded) */
  private closeUndelivered(d: Decision, reason: string): void {
    // An approval that is not delivered lets nothing through any more, even while the mod still holds it
    this.revokeGrant(d);
    if (d.status === "pending") {
      this.transition(d, "cancelled");
      d.status_reason = reason;
      delete d.claim;
      this.persist(d);
      this.emit("decision.updated", d);
      this.notify(d.id);
    } else if (d.status === "answer_submitted") {
      if (!d.claim) this.loseDelivery(d, reason);
      else if (this.claimAlive(d, this.clock())) {
        // The mod is submitting it right now: its ack or release closes the decision
        d.close_reason = reason;
        this.persist(d);
        this.emit("decision.updated", d);
      } else {
        d.close_reason = reason;
        this.settleDeadClaim(d);
      }
    }
  }

  private checkMessageDelivery(d: Decision, now: number): void {
    if (now - Date.parse(d.created_at) >= MESSAGE_TTL_MS) {
      this.closeUndelivered(d, "expired");
      return;
    }
    if (d.status === "answer_submitted" && d.claim && !this.claimAlive(d, now)) this.settleDeadClaim(d);
  }

  /** SessionEnd + MOD_END_GRACE_MS: a session no mod polled since then is over (a `/clear` polls under a new id, a `--resume` keeps polling) */
  private checkEndMarks(now: number): void {
    for (const [sid, endAt] of [...this.endMarks]) {
      if (now < endAt + MOD_END_GRACE_MS) continue;
      this.endMarks.delete(sid);
      const prefix = `${sid}\0`;
      let kept = false;
      // Still polling now = a mod lives on in that session (`--resume` from another process). A single poll just after the event is the
      // dying mod's last tick: it does not keep the session open (a live mod polls at least every MOD_BACKOFF_MAX_MS)
      for (const [k, at] of this.ownerSeen) if (k.startsWith(prefix) && at > endAt && now - at <= MOD_BACKOFF_MAX_MS) kept = true;
      if (kept) continue;
      for (const d of this.asyncOf(sid)) {
        if (LIVE.includes(d.status)) this.closeUndelivered(d, "session_end");
        else this.revokeGrant(d);
      }
    }
  }

  /** `no_agent`: no mod has polled the session for MOD_GONE_MS (never within that time of the server's start); cleared when one comes back */
  private checkNoAgent(now: number): void {
    for (const d of this.decisions.values()) {
      if (d.delivery !== "message" || !LIVE.includes(d.status)) continue;
      const gone = now - this.startedAt > MOD_GONE_MS && !this.liveOwner(d.session.session_id, MOD_GONE_MS, now);
      if (gone === (d.delivery_flag === "no_agent")) continue;
      if (gone) d.delivery_flag = "no_agent";
      else delete d.delivery_flag;
      this.persist(d);
      this.emit("decision.updated", d);
    }
  }

  private inboxItem(sessionId: string, itemId: string): Decision | undefined {
    const d = this.decisions.get(itemId);
    return d && d.session.session_id === sessionId && d.kind !== "checkpoint" ? d : undefined;
  }

  /** The mod asks for work. `held`: it is delivering one already. `item`: one answer, claimed for this owner. undefined: nothing (204) */
  inboxPoll(sessionId: string, owner: string, idle: boolean): PollResponse | undefined {
    const now = this.clock();
    this.markSeen(sessionId, owner);
    const open = this.asyncOf(sessionId).filter((d) => d.status === "answer_submitted");
    const held = open.find((d) => d.claim?.owner === owner);
    if (held) return { held: { item_id: held.id } };
    const heldInstruction = this.heldInstruction(sessionId, owner);
    if (heldInstruction) return { held: { item_id: heldInstruction } };
    if (!idle) return undefined;
    // Its own items first-come by age; the items of an owner that is gone (a reload) are taken over
    const next = open.find(
      (d) => !d.claim && !d.close_reason && (d.delivery_attempts ?? 0) < DELIVERY_MAX_ATTEMPTS && (d.mod_owner === owner || !this.ownerAlive(sessionId, d.mod_owner, now)),
    );
    if (!next) return open.length === 0 ? this.pollInstruction(sessionId, owner, now) : undefined;
    // An approval whose grant is gone would tell the agent "it will be allowed" for a plan that is not: it is not delivered
    if (this.approvalWithoutGrant(next)) {
      this.closeUndelivered(next, "superseded");
      // An instruction that waited behind it in the hook queue may go now (as when a delivery completes)
      if (this.sessions.get(sessionId)?.state === "idle" && !this.hasOpenAsync(sessionId)) this.offerToMod(sessionId);
      return this.inboxPoll(sessionId, owner, idle);
    }
    next.mod_owner = owner;
    next.claim = { owner, at: new Date(now).toISOString(), offset: this.transcriptSize(next) };
    this.persist(next);
    this.emit("decision.updated", next);
    return { item: { item_id: next.id, text: deliveryText(next) } };
  }

  /** The mod's `$.prompt.submit` succeeded: the answer is delivered (idempotent) */
  inboxAck(sessionId: string, owner: string, itemId: string): InboxResult {
    this.markSeen(sessionId, owner);
    if (this.messageInstructions.has(itemId)) return this.ackInstruction(sessionId, owner, itemId);
    const d = this.inboxItem(sessionId, itemId);
    if (!d) return { http: 404 };
    if (d.delivery !== "message") return { http: 409, status: d.status };
    if (d.status === "answered") return { http: 200, status: "answered" };
    if (d.status !== "answer_submitted") return { http: 409, status: d.status };
    if (d.claim && d.claim.owner !== owner && this.claimAlive(d, this.clock())) return { http: 409, status: d.status };
    this.completeDelivery(d);
    const after = d.status as DecisionStatus; // a superseded approval closes as answer_lost
    return after === "answered" ? { http: 200, status: after } : { http: 409, status: after };
  }

  /** The mod could not submit: `drop` is the reason `$.prompt.submit` gave (absent when it threw) */
  inboxRelease(sessionId: string, owner: string, itemId: string, drop?: string): InboxResult {
    this.markSeen(sessionId, owner);
    if (this.messageInstructions.has(itemId)) return this.releaseInstruction(sessionId, owner, itemId, drop);
    const d = this.inboxItem(sessionId, itemId);
    if (!d) return { http: 404 };
    if (d.delivery !== "message") return { http: 409, status: d.status };
    // A closed decision, or one nobody holds (this release was sent twice): nothing to change
    if (d.status !== "answer_submitted" || !d.claim) return { http: 200, status: d.status };
    if (d.claim.owner !== owner && this.claimAlive(d, this.clock())) return { http: 409, status: d.status };
    if (drop !== undefined) {
      delete d.claim;
      d.delivery_attempts = (d.delivery_attempts ?? 0) + 1;
      d.delivery_note = drop.slice(0, 500);
      if (d.delivery_attempts >= DELIVERY_MAX_ATTEMPTS) this.loseDelivery(d, "undeliverable");
      else if (d.close_reason) this.loseDelivery(d, d.close_reason);
      else {
        this.persist(d);
        this.emit("decision.updated", d);
      }
    } else {
      this.settleDeadClaim(d);
      // Not in the transcript either (submit threw, or the mod lost its state): that is a failed attempt too, so a submit that always throws
      // cannot claim and release forever
      const after = d.status as DecisionStatus;
      if (after === "answer_submitted" && !d.claim) {
        d.delivery_attempts = (d.delivery_attempts ?? 0) + 1;
        d.delivery_note ??= "the prompt could not be submitted";
        if (d.delivery_attempts >= DELIVERY_MAX_ATTEMPTS) this.loseDelivery(d, "undeliverable");
        else {
          this.persist(d);
          this.emit("decision.updated", d);
        }
      }
    }
    return { http: 200, status: d.status };
  }

  // ---- Message delivery of instructions (a checkpoint reply, a plan instruction): no decision is waiting, so no decision carries the state ----

  /** A mod polled the session lately and the message-delivery switch is on: an instruction can go to it instead of the terminal */
  hasLiveMod(sessionId: string): boolean {
    if (this.opts.messageDelivery && !this.opts.messageDelivery()) return false;
    const bypassAt = this.modBypass.get(sessionId);
    if (bypassAt !== undefined) {
      if (this.clock() - bypassAt < MOD_GONE_MS) return false;
      this.modBypass.delete(sessionId); // a mod that failed five times gets another chance after a while
    }
    return this.liveOwner(sessionId, MOD_FRESH_MS, this.clock());
  }

  /**
   * Moves the session's queued instruction (not a stop) to the mod's inbox. True when it went; false leaves the queue as it was.
   * An item nobody holds is joined with the new text (a newline between, like the hook queue); one the mod is submitting right now
   * stays, and the new instruction waits in the queue until that one closes
   */
  offerToMod(sessionId: string): boolean {
    const ins = this.instructions.get(sessionId);
    if (!ins || ins.kind !== "instruct" || !this.hasLiveMod(sessionId)) return false;
    const d = ins.decision_id ? this.decisions.get(ins.decision_id) : undefined;
    if (d?.session.agent === "codex") return false;
    const now = this.clock();
    const existing = [...this.messageInstructions.values()].find((m) => m.session_id === sessionId);
    if (existing?.claim) {
      if (this.ownerAlive(sessionId, existing.claim.owner, now)) return false;
      if (existing.first_offset !== undefined && this.instructionTranscriptHas(existing, existing.first_offset)) {
        this.completeInstruction(existing, false);
        return this.offerToMod(sessionId);
      }
      delete existing.claim;
    }
    this.instructions.delete(sessionId);
    if (existing) {
      existing.parts.push({ text: ins.text, ...(ins.about ? { about: ins.about } : {}) });
      if (ins.decision_id) existing.decision_ids.push(ins.decision_id);
      existing.created_at = ins.created_at; // the newest text renews the time limit
      return true;
    }
    const transcript_path = d?.session.transcript_path ?? this.sessions.get(sessionId)?.transcript_path;
    const id = randomUUID();
    this.messageInstructions.set(id, { id, session_id: sessionId, transcript_path, source: ins, parts: [{ text: ins.text, ...(ins.about ? { about: ins.about } : {}) }], decision_ids: ins.decision_id ? [ins.decision_id] : [], created_at: ins.created_at, attempts: 0 });
    this.instructionRefs.set(deliveryRef(id), sessionId);
    if (this.instructionRefs.size > 500) this.instructionRefs.delete(this.instructionRefs.keys().next().value!);
    return true;
  }

  private dropMessageInstructions(sessionId: string): void {
    for (const [id, m] of this.messageInstructions) if (m.session_id === sessionId) this.messageInstructions.delete(id);
  }

  private instructionTranscriptHas(m: MessageInstruction, offset: number): boolean {
    return m.transcript_path !== undefined && transcriptHasDelivery(m.transcript_path, offset, deliveryRef(m.id));
  }

  private heldInstruction(sessionId: string, owner: string): string | undefined {
    for (const m of this.messageInstructions.values()) if (m.session_id === sessionId && m.claim?.owner === owner) return m.id;
    return undefined;
  }

  /** The delivery is over: the checkpoint it answers (if any) is marked delivered, and an instruction that waited behind it goes next */
  private completeInstruction(m: MessageInstruction, offerNext = true): void {
    this.messageInstructions.delete(m.id);
    for (const id of m.decision_ids) this.markDelivered(id, "message");
    if (offerNext && this.sessions.get(m.session_id)?.state === "idle" && !this.hasOpenAsync(m.session_id)) this.offerToMod(m.session_id);
  }

  /**
   * The item goes back to the hook queue (joined in front of a newer instruction; a queued stop wins and the text is logged as
   * dropped), and an idle agent gets it through the terminal delivery now. `bypass`: the mod failed to deliver it, so it is not offered again
   */
  private returnToQueue(m: MessageInstruction, bypass: boolean): void {
    this.messageInstructions.delete(m.id);
    const sid = m.session_id;
    const queued = this.instructions.get(sid);
    if (queued?.kind === "stop") {
      this.opts.log?.("instruction_dropped", { session: sid, item: m.id });
      return;
    }
    // One slot, one prefix: the texts are joined (the prefix of the first one stays); the checkpoints all stay with it
    const ids = [...m.decision_ids, ...(queued?.decision_id ? [queued.decision_id, ...(this.joinedIds.get(queued.decision_id) ?? [])] : [])];
    const text = [...m.parts.map((x) => x.text), ...(queued ? [queued.text] : [])].join("\n").slice(0, INSTRUCTION_MAX_CHARS);
    const about = m.parts[0]?.about;
    this.instructions.set(sid, { decision_id: ids[0] ?? "", kind: "instruct", text, created_at: m.source.created_at, ...(about ? { about } : {}) });
    if (ids[0]) this.joinedIds.set(ids[0], ids.slice(1));
    if (bypass) this.modBypass.set(sid, this.clock());
    if (this.sessions.get(sid)?.state === "idle") this.offerQueuedInstruction(sid);
  }

  /** Items nobody can deliver: too old, a plugin line already in the transcript, or no mod left (back to the queue and the terminal) */
  private checkInstructions(now: number): void {
    const modOff = this.opts.messageDelivery !== undefined && !this.opts.messageDelivery();
    for (const m of [...this.messageInstructions.values()]) {
      if (now - Date.parse(m.created_at) >= CHECKPOINT_TTL_MS) {
        this.messageInstructions.delete(m.id); // too old to start a turn with
        this.opts.log?.("instruction_expired", { session: m.session_id, item: m.id });
        continue;
      }
      if (m.claim && this.ownerAlive(m.session_id, m.claim.owner, now)) continue;
      if (m.first_offset !== undefined && this.instructionTranscriptHas(m, m.first_offset)) {
        this.completeInstruction(m); // a submit of a gone mod got in
        continue;
      }
      if (!modOff && this.liveOwner(m.session_id, MOD_GONE_MS, now)) {
        delete m.claim; // its owner is gone but another mod polls the session
        continue;
      }
      this.returnToQueue(m, false);
    }
  }

  private pollInstruction(sessionId: string, owner: string, now: number): PollResponse | undefined {
    for (const m of [...this.messageInstructions.values()]) {
      if (m.session_id !== sessionId) continue;
      if (m.claim && this.ownerAlive(sessionId, m.claim.owner, now)) continue;
      if (m.claim && this.instructionTranscriptHas(m, m.claim.offset)) {
        this.completeInstruction(m); // the gone mod's submit got in
        continue;
      }
      if (this.hasOpenAsync(sessionId)) return undefined;
      m.claim = { owner, at: new Date(now).toISOString(), offset: m.transcript_path ? this.transcriptSizeOf(m.transcript_path) : 0 };
      m.first_offset ??= m.claim.offset;
      return { item: { item_id: m.id, text: instructionParts(m.id, m.parts) } };
    }
    return undefined;
  }

  private transcriptSizeOf(path: string): number {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  }

  private ackInstruction(sessionId: string, owner: string, itemId: string): InboxResult {
    const m = this.messageInstructions.get(itemId);
    if (!m || m.session_id !== sessionId) return { http: 404 };
    if (m.claim && m.claim.owner !== owner && this.ownerAlive(sessionId, m.claim.owner, this.clock())) return { http: 409, status: "answer_submitted" };
    this.completeInstruction(m);
    return { http: 200, status: "answered" };
  }

  private releaseInstruction(sessionId: string, owner: string, itemId: string, drop?: string): InboxResult {
    const m = this.messageInstructions.get(itemId);
    if (!m || m.session_id !== sessionId) return { http: 404 };
    if (!m.claim) return { http: 200, status: "answer_submitted" };
    if (m.claim.owner !== owner && this.ownerAlive(sessionId, m.claim.owner, this.clock())) return { http: 409, status: "answer_submitted" };
    // Without a drop the submit may still have got in: the transcript says
    if (drop === undefined && this.instructionTranscriptHas(m, m.claim.offset)) {
      this.completeInstruction(m);
      return { http: 200, status: "answered" };
    }
    delete m.claim;
    m.attempts++;
    if (m.attempts >= DELIVERY_MAX_ATTEMPTS) {
      this.opts.log?.("instruction_undeliverable", { session: sessionId, item: m.id });
      this.returnToQueue(m, true);
    }
    return { http: 200, status: "answer_submitted" };
  }

  // ---- Plan grants (an approved plan is let through once: a re-called ExitPlanMode, or the PermissionRequest of "approve and auto") ----

  /**
   * The grant `d` stands for, or undefined: an approval of a plan, not used, not older than PLAN_GRANT_TTL_MS. For message delivery from
   * the answer on; for the waiting hook only once the hook took the answer (`answered` by its ack) and left the grant to the PermissionRequest
   */
  private grantOf(d: Decision, now: number): PlanGrant | undefined {
    const r = d.response;
    if (d.kind !== "approve_plan" || r?.approve !== true || d.grant_used_at) return undefined;
    const ready = d.delivery === "message" ? d.status === "answer_submitted" || d.status === "answered" : d.status === "answered" && r.delivered_via === "hook";
    if (!ready) return undefined;
    const decided = Date.parse(r.decided_at);
    if (!Number.isFinite(decided) || now - decided > PLAN_GRANT_TTL_MS || !planText(d.request)) return undefined;
    return r.set_mode_auto ? { decision_id: d.id, mode: "auto" } : { decision_id: d.id };
  }

  /** The newest grant of the session for this exact plan (session and fingerprint must both match) */
  private findGrant(sessionId: string, fingerprint: string): { d: Decision; grant: PlanGrant } | undefined {
    const now = this.clock();
    let best: { d: Decision; grant: PlanGrant } | undefined;
    for (const d of this.plansOf(sessionId)) {
      if (d.fingerprint !== fingerprint || d.session.agent_id !== undefined) continue;
      const grant = this.grantOf(d, now);
      if (grant && (!best || d.created_at > best.d.created_at)) best = { d, grant };
    }
    return best;
  }

  /** GET /api/sessions/:id/plan-grant: looks, does not use */
  planGrant(sessionId: string, fingerprint: string): PlanGrant | undefined {
    return this.findGrant(sessionId, fingerprint)?.grant;
  }

  /** POST /api/sessions/:id/plan-grant/consume: the re-called ExitPlanMode is let through, once. The decision is answered by it */
  consumePlanGrant(sessionId: string, fingerprint: string): { consumed: true; mode?: "auto" } | { consumed: false } {
    const hit = this.findGrant(sessionId, fingerprint);
    if (!hit) return { consumed: false };
    this.useGrant(hit.d);
    return hit.grant.mode ? { consumed: true, mode: hit.grant.mode } : { consumed: true };
  }

  /** The grant is used: written down (it never lets anything through again), and an answer not delivered yet needs no delivery any more */
  private useGrant(d: Decision): void {
    d.grant_used_at = new Date(this.clock()).toISOString();
    if (d.status === "answer_submitted") {
      this.transition(d, "answered");
      d.response = { ...d.response!, delivered_at: d.grant_used_at, delivered_via: "grant" };
      delete d.claim;
      delete d.close_reason;
    }
    this.persist(d);
    this.emit("decision.updated", d);
    this.notify(d.id);
  }

  /** The grant of `d` (if any) is written off without being used: it lets nothing through */
  private revokeGrant(d: Decision): void {
    if (!this.grantOf(d, this.clock())) return;
    d.grant_used_at = new Date(this.clock()).toISOString();
    // A mod is already submitting the approval ("it will be allowed"): its ack or the transcript check closes it as lost, not answered
    if (d.status === "answer_submitted" && d.claim) d.close_reason ??= "superseded";
    this.persist(d);
    this.emit("decision.updated", d);
  }

  /** An approved plan for message delivery that no longer has its grant (used, written off or too old) */
  private approvalWithoutGrant(d: Decision): boolean {
    return d.kind === "approve_plan" && d.delivery === "message" && d.response?.approve === true && !this.grantOf(d, this.clock());
  }

  /** The grants of the session decided before `at` are written off */
  private revokeGrantsBefore(sessionId: string, at: number): void {
    for (const d of this.plansOf(sessionId)) {
      const decided = Date.parse(d.response?.decided_at ?? "");
      if (Number.isFinite(decided) && decided < at) this.revokeGrant(d);
    }
  }

  /** PostToolUse of the main agent's ExitPlanMode: every grant of the session is used up; one that asked for auto mode did not get it */
  private planExited(sessionId: string): void {
    const now = this.clock();
    for (const d of this.plansOf(sessionId)) {
      const grant = d.session.agent_id === undefined ? this.grantOf(d, now) : undefined;
      if (!grant) continue;
      if (grant.mode === "auto") d.delivery_flag = "auto_not_applied";
      this.useGrant(d);
    }
  }

  /** A new plan of the main agent: the session's earlier message-delivery ones close as `superseded`, and every earlier grant is written off */
  private supersedePlans(current: Decision): void {
    for (const d of this.plansOf(current.session.session_id)) {
      if (d === current || d.created_at > current.created_at) continue;
      if (d.delivery === "message" && LIVE.includes(d.status)) this.closeUndelivered(d, "superseded");
      else this.revokeGrant(d);
    }
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
