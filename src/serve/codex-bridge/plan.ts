import { POLL_TIMEOUT_MS, type Decision, type DecisionContext, type DecisionSession } from "../../contract.js";
import { parsePlanImpact, validatePlan } from "../../hook/explain.js";
import type { Lang } from "../../settings/config.js";
import { collectGuarded } from "../context.js";
import type { Store } from "../store.js";
import type { Notification } from "./client.js";
import type { BridgeLog } from "./log.js";

export const IMPLEMENT_TEXT = "Implement the plan.";
export const ANSWERED_ELSEWHERE = "answered_elsewhere";
export const STOP_TEXT = "The human asked you to stop. Write a short status (done / in progress / next) and end your turn.";
export const CHECKPOINT_DELAY_MS = 180_000;
const RECAP_MAX = 2000;
const METHOD_MISSING = /method not found|unknown (variant|method)|not implemented|unsupported|unrecognized|-32601/i;

const NOTE: Record<Lang, string> = {
  en: "Codex's own 'Implement this plan?' popup stays open in the terminal after you decide here; choose 'No, stay in Plan mode' there (a second 'Yes' would run the plan twice).",
  ja: "ここで決めても、Codex 自身の「Implement this plan?」ポップアップは端末に残ります。そちらでは「No, stay in Plan mode」を選んでください(もう一度「Yes」を選ぶと計画が 2 回実行されます)。",
};

export interface Rpc {
  request(method: string, params?: Record<string, unknown>): Promise<any>;
}

export type PlanBridgeDeps = {
  store: Store;
  log: BridgeLog;
  lang: Lang;
  /** Gathers git context for the decision (the server's collector). Optional */
  collect?: (session: DecisionSession) => Promise<DecisionContext>;
  waitMs?: number;
  /** Quiet time after a completed turn before a progress checkpoint is created (default 3 min) */
  checkpointDelayMs?: number;
};

type Thread = {
  id: string;
  cwd: string;
  title?: string;
  mode?: string;
  model?: string;
  effort?: string;
  ephemeral: boolean;
  resumed: boolean;
  resuming: boolean;
  /** Plan text per turn, kept until that turn completes */
  plans: Map<string, string>;
  /** Pending plan decisions of this thread: decision id → turn id */
  live: Map<string, string>;
  /** Turns whose plan was already registered (a replayed turn/completed must not register twice) */
  registered: Set<string>;
  /** Last agent message text per turn (a final answer wins over commentary), kept until that turn completes */
  messages: Map<string, { text: string; final: boolean }>;
  /** Turns that already armed a checkpoint timer */
  armed: Set<string>;
  checkpointTimer?: NodeJS.Timeout;
  /** The turn running now (turn/started without turn/completed) */
  running?: string;
  /** Instructions waiting for the running turn to end (the daemon has no turn/interrupt) */
  queued?: QueuedSend;
};

type QueuedSend = { decisionId: string; text: string };

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/**
 * Turns the events of the Codex app-server threads into `approve_plan` decisions and the human's answer back into
 * `turn/start`. Only plans: questions and approvals stay on the hook route, so server requests are not answered.
 */
export class PlanBridge {
  private rpc: Rpc | undefined;
  private threads = new Map<string, Thread>();
  private stopped = false;
  /** True while `attach` resumes threads: turn/completed seen then is a replay and must not arm a checkpoint */
  private attaching = false;

  constructor(private deps: PlanBridgeDeps) {}

  private thread(id: string): Thread {
    let t = this.threads.get(id);
    if (!t) {
      t = { id, cwd: "", ephemeral: false, resumed: false, resuming: false, plans: new Map(), live: new Map(), registered: new Set(), messages: new Map(), armed: new Set() };
      this.threads.set(id, t);
    }
    return t;
  }

  /** (Re)build the thread state on a fresh connection: list the loaded threads and resume each non-ephemeral one */
  async attach(rpc: Rpc): Promise<void> {
    this.rpc = rpc;
    for (const t of this.threads.values()) {
      t.resumed = false;
      t.resuming = false;
    }
    this.attaching = true;
    try {
      const res = await rpc.request("thread/loaded/list", {});
      const ids: unknown[] = Array.isArray(res?.data) ? res.data : [];
      this.deps.log("attached", { threads: ids.length });
      await Promise.all(ids.filter((i): i is string => typeof i === "string").map((id) => this.resume(id)));
    } finally {
      this.attaching = false;
    }
  }

  detach(): void {
    this.rpc = undefined;
  }

  stop(): void {
    this.stopped = true;
    this.rpc = undefined;
    for (const t of this.threads.values()) clearTimeout(t.checkpointTimer);
  }

  private async resume(id: string): Promise<void> {
    const rpc = this.rpc;
    const t = this.thread(id);
    if (!rpc || t.ephemeral || t.resumed || t.resuming) return;
    t.resuming = true;
    try {
      const r = await rpc.request("thread/resume", { threadId: id, excludeTurns: true });
      t.resumed = true;
      const th = r?.thread ?? {};
      if (th.ephemeral === true) t.ephemeral = true;
      t.cwd = str(r?.cwd) ?? str(th.cwd) ?? t.cwd;
      t.title = str(th.name) ?? str(th.preview) ?? t.title;
      t.model = str(r?.model) ?? t.model;
      t.effort = str(r?.reasoningEffort) ?? t.effort;
      const cm = r?.collaborationMode;
      if (str(cm?.mode) && t.mode === undefined) this.applyMode(t, cm);
      this.deps.log("resumed", { thread: id });
    } catch (err) {
      // "no rollout found" before the first message: retried on the next `thread/status/changed active`
      this.deps.log("resume_failed", { thread: id, error: err instanceof Error ? err.message : String(err) });
    } finally {
      t.resuming = false;
    }
  }

  private applyMode(t: Thread, cm: any): void {
    t.mode = str(cm?.mode) ?? t.mode;
    t.model = str(cm?.settings?.model) ?? t.model;
    t.effort = str(cm?.settings?.reasoning_effort) ?? t.effort;
  }

  /** A server→client request (approval / question). Logged only: the hook route answers those */
  onServerRequest(n: Notification & { id: number | string }): void {
    this.deps.log("server_request_ignored", { method: n.method, thread: str(n.params.threadId) });
  }

  handle(n: Notification): void {
    if (this.stopped) return;
    const p = n.params;
    switch (n.method) {
      case "thread/started": {
        const th = p.thread ?? {};
        const id = str(th.id);
        if (!id) return;
        const t = this.thread(id);
        t.ephemeral = th.ephemeral === true;
        t.cwd = str(th.cwd) ?? t.cwd;
        t.title = str(th.name) ?? str(th.preview) ?? t.title;
        void this.resume(id);
        return;
      }
      case "thread/status/changed": {
        const id = str(p.threadId);
        if (id && p.status?.type === "active") void this.resume(id);
        return;
      }
      case "thread/closed": {
        const id = str(p.threadId);
        const t = id ? this.threads.get(id) : undefined;
        if (t) clearTimeout(t.checkpointTimer);
        if (id) this.threads.delete(id);
        return;
      }
      case "thread/name/updated": {
        const id = str(p.threadId);
        const name = str(p.threadName) ?? str(p.name);
        if (id && name) this.thread(id).title = name;
        return;
      }
      case "thread/settings/updated": {
        const id = str(p.threadId);
        const s = p.threadSettings;
        if (!id || !s) return;
        const t = this.thread(id);
        t.cwd = str(s.cwd) ?? t.cwd;
        t.model = str(s.model) ?? t.model;
        t.effort = str(s.effort) ?? t.effort;
        if (s.collaborationMode) this.applyMode(t, s.collaborationMode);
        return;
      }
      case "turn/started": {
        const id = str(p.threadId);
        if (!id) return;
        const t = this.thread(id);
        t.running = str(p.turn?.id) ?? t.running;
        this.withdraw(t, str(p.turn?.id));
        this.checkpointTurnStarted(t);
        return;
      }
      case "item/started": {
        const id = str(p.threadId);
        const item = p.item;
        if (!id || item?.type !== "userMessage") return;
        const text = Array.isArray(item.content) ? item.content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("") : "";
        if (text.trim() === IMPLEMENT_TEXT) this.withdraw(this.thread(id), undefined);
        return;
      }
      case "item/completed": {
        const id = str(p.threadId);
        const turnId = str(p.turnId);
        if (!id || !turnId) return;
        if (p.item?.type === "plan" && str(p.item.text)) this.thread(id).plans.set(turnId, p.item.text);
        else if (p.item?.type === "agentMessage") this.rememberMessage(this.thread(id), turnId, p.item);
        return;
      }
      case "turn/completed": {
        const id = str(p.threadId);
        const turnId = str(p.turn?.id);
        if (!id || !turnId) return;
        const t = this.thread(id);
        t.running = undefined;
        const plan = t.plans.get(turnId);
        t.plans.delete(turnId);
        const asPlan = plan !== undefined && t.mode === "plan";
        if (plan !== undefined && !asPlan) this.deps.log("plan_ignored", { thread: id, turn: turnId, mode: t.mode });
        // The plan card already covers a plan turn (also a replayed one): no progress checkpoint for it
        if (asPlan && !t.registered.has(turnId)) {
          t.registered.add(turnId);
          void this.register(t, turnId, plan).catch((err) => this.deps.log("register_failed", { thread: id, error: String(err) }));
        }
        if (asPlan || t.registered.has(turnId)) t.messages.delete(turnId);
        else this.armCheckpoint(t, turnId, p.turn);
        void this.flushQueued(t);
        return;
      }
    }
  }

  /** The terminal moved first (a next turn, or its own "Implement the plan."): close the plan decisions still pending */
  private withdraw(t: Thread, nextTurnId: string | undefined): void {
    for (const [decisionId, turnId] of [...t.live]) {
      if (turnId === nextTurnId) continue;
      if (this.deps.store.get(decisionId)?.status !== "pending") continue;
      try {
        this.deps.store.cancel(decisionId, ANSWERED_ELSEWHERE);
        t.live.delete(decisionId);
        this.deps.log("withdrawn", { decision: decisionId, thread: t.id });
      } catch (err) {
        this.deps.log("withdraw_failed", { decision: decisionId, error: String(err) });
      }
    }
  }

  private async register(t: Thread, turnId: string, plan: string): Promise<void> {
    const session: DecisionSession = {
      session_id: t.id,
      cwd: t.cwd,
      transcript_path: "",
      agent: "codex",
      ...(t.title ? { title: t.title } : {}),
    };
    const context: DecisionContext = this.deps.collect ? await collectGuarded(this.deps.collect, session) : {};
    const { decision, created } = this.deps.store.create(
      {
        tool_use_id: `codex-plan:${t.id}:${turnId}`,
        kind: "approve_plan",
        session,
        // The plan itself goes to both UIs as `request.plan`; Codex has no plan file
        request: { plan, planFilePath: "" },
        explanation: {
          path: "",
          ...parsePlanImpact(plan),
          // Only the note: the GUI / TUI print `request.plan` first and append this when it differs
          markdown: NOTE[this.deps.lang],
          has: validatePlan(plan).has,
          match: "question",
          attached_via: "first_call",
        },
      },
      context,
    );
    if (!created) return;
    t.live.set(decision.id, turnId);
    this.deps.log("plan_registered", { decision: decision.id, thread: t.id, turn: turnId });
    void this.follow(t, decision.id);
  }

  /** Waits for the human's answer exactly like the hook does, then sends it to Codex */
  private async follow(t: Thread, decisionId: string): Promise<void> {
    const { store } = this.deps;
    try {
      for (;;) {
        if (this.stopped) return;
        const d = await store.wait(decisionId, this.deps.waitMs ?? POLL_TIMEOUT_MS);
        if (d) return await this.deliver(t, d);
        const cur = store.get(decisionId);
        if (!cur || !["pending", "answer_submitted"].includes(cur.status)) return;
      }
    } catch (err) {
      this.deps.log("follow_failed", { decision: decisionId, error: String(err) });
    } finally {
      t.live.delete(decisionId);
    }
  }

  private async deliver(t: Thread, d: Decision): Promise<void> {
    const { store, log } = this.deps;
    if (d.status !== "answer_submitted") return; // "fallback" = answered in the terminal
    const r = d.response;
    let text: string | undefined;
    let mode: "default" | "plan" = "default";
    if (r?.approve === true) text = IMPLEMENT_TEXT;
    else if (r?.approve === false && r.reason?.trim()) {
      text = r.reason;
      mode = "plan";
    }
    if (text === undefined) {
      // Reject without feedback: nothing to send, the terminal keeps its popup
      store.ack(d.id);
      log("reject_no_feedback", { decision: d.id });
      return;
    }
    try {
      await this.startTurn(t, text, mode);
    } catch (err) {
      log("turn_start_failed", { decision: d.id, thread: t.id, error: err instanceof Error ? err.message : String(err) });
      // The answer did not reach Codex: answer_lost lets the human see it and use the terminal popup
      store.cancel(d.id);
      return;
    }
    store.ack(d.id);
    log("turn_started", { decision: d.id, thread: t.id, mode });
  }
  /** `turn/start` on the thread with its last known model / effort (never changes anything else of the thread) */
  private async startTurn(t: Thread, text: string, mode: "default" | "plan"): Promise<void> {
    if (!this.rpc) throw new Error("not connected");
    await this.rpc.request("turn/start", {
      threadId: t.id,
      input: [{ type: "text", text, text_elements: [] }],
      collaborationMode: {
        mode,
        settings: { model: t.model ?? null, reasoning_effort: t.effort ?? null, developer_instructions: null },
      },
    });
  }

  // ---- Progress checkpoints: a completed turn, then `checkpointDelayMs` without the user ----

  private rememberMessage(t: Thread, turnId: string, item: any): void {
    const text = typeof item?.text === "string" ? item.text.trim() : "";
    if (!text) return;
    const final = item.phase === "final_answer";
    const cur = t.messages.get(turnId);
    // A final answer is the recap; commentary only stands in until one arrives
    if (cur?.final && !final) return;
    t.messages.set(turnId, { text, final });
  }

  private armCheckpoint(t: Thread, turnId: string, turn: any): void {
    const log = this.deps.log;
    let msg = t.messages.get(turnId)?.text;
    t.messages.delete(turnId);
    if (msg === undefined && Array.isArray(turn?.items)) {
      for (const it of turn.items) if (it?.type === "agentMessage" && typeof it.text === "string" && it.text.trim()) msg = it.text.trim();
    }
    if (t.ephemeral || this.attaching || t.resuming || t.armed.has(turnId)) return;
    if (msg === undefined) {
      log("checkpoint_skipped", { thread: t.id, turn: turnId, reason: "no_agent_message" });
      return;
    }
    t.armed.add(turnId);
    const recap = msg.length > RECAP_MAX ? msg.slice(0, RECAP_MAX - 1) + "…" : msg;
    const recapAt = new Date().toISOString();
    clearTimeout(t.checkpointTimer);
    t.checkpointTimer = setTimeout(() => {
      t.checkpointTimer = undefined;
      if (this.stopped || t.running) return;
      if (!this.rpc) {
        // Nobody could deliver the answer: not worth asking
        log("checkpoint_skipped", { thread: t.id, turn: turnId, reason: "not_connected" });
        return;
      }
      try {
        const { decision, created } = this.deps.store.createCheckpoint(
          { session_id: t.id, state: "idle", last_event_at: recapAt, cwd: t.cwd, ...(t.title ? { title: t.title } : {}), transcript_path: "", agent: "codex" },
          recap,
          recapAt,
        );
        if (created) log("checkpoint_created", { decision: decision.id, thread: t.id, turn: turnId });
      } catch (err) {
        log("checkpoint_failed", { thread: t.id, error: String(err) });
      }
    }, this.deps.checkpointDelayMs ?? CHECKPOINT_DELAY_MS);
    t.checkpointTimer.unref();
  }

  /** The user (or anything) started a new turn: no checkpoint for the previous one */
  private checkpointTurnStarted(t: Thread): void {
    clearTimeout(t.checkpointTimer);
    t.checkpointTimer = undefined;
    this.deps.store.cancelPendingCheckpoints(t.id, "new_prompt");
  }

  /** The human answered a checkpoint of a Codex thread (called by the store, in-process) */
  onCheckpointAnswered(d: Decision): void {
    if (this.stopped || d.session.agent !== "codex") return;
    const r = d.response;
    if (!r || r.kind === "continue") return;
    const text = r.kind === "stop" ? (r.text?.trim() ? `${STOP_TEXT}\n\n${r.text}` : STOP_TEXT) : (r.text ?? "");
    void this.deliverCheckpoint(d, text).catch((err) => this.deps.log("checkpoint_deliver_failed", { decision: d.id, error: String(err) }));
  }

  private async deliverCheckpoint(d: Decision, text: string): Promise<void> {
    const { store, log } = this.deps;
    const t = this.threads.get(d.session.session_id);
    try {
      if (!t || !this.rpc) throw new Error("not connected");
      if (t.running) {
        try {
          await this.rpc.request("turn/interrupt", { threadId: t.id, turnId: t.running });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (METHOD_MISSING.test(msg)) {
            // This daemon cannot interrupt: send when the running turn completes
            t.queued = { decisionId: d.id, text };
            log("checkpoint_queued", { decision: d.id, thread: t.id });
            return;
          }
          // e.g. the turn ended meanwhile: the turn/start below is still right
          log("turn_interrupt_failed", { decision: d.id, thread: t.id, error: msg });
        }
      }
      await this.startTurn(t, text, "default");
    } catch (err) {
      this.checkpointLost(d.id, err);
      return;
    }
    store.consumeInstruction(d.session.session_id, "bridge");
    log("checkpoint_delivered", { decision: d.id, thread: t.id, kind: d.response?.kind });
  }

  /** Sends what waited for the running turn to end */
  private async flushQueued(t: Thread): Promise<void> {
    const q = t.queued;
    if (!q) return;
    t.queued = undefined;
    try {
      await this.startTurn(t, q.text, "default");
    } catch (err) {
      this.checkpointLost(q.decisionId, err);
      return;
    }
    this.deps.store.consumeInstruction(t.id, "bridge");
    this.deps.log("checkpoint_delivered", { decision: q.decisionId, thread: t.id, via: "queue" });
  }

  private checkpointLost(decisionId: string, err: unknown): void {
    this.deps.log("checkpoint_deliver_failed", { decision: decisionId, error: err instanceof Error ? err.message : String(err) });
    try {
      this.deps.store.loseCheckpoint(decisionId);
    } catch (e) {
      this.deps.log("checkpoint_lose_failed", { decision: decisionId, error: String(e) });
    }
  }
}
