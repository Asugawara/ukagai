import { CHECKPOINT_TTL_MS, PLAN_INSTRUCT_PREFIX, type Decision } from "../contract.js";
import type { SettingsStore } from "./settings.js";
import type { Store } from "./store.js";
import { REPLY_PREFIX, replyLine, terminalLabel, TerminalTypeError, type Terminal } from "./terminal.js";

export type DeliveryOptions = {
  store: Store;
  terminal: Terminal;
  /** Live settings: `checkpoints.terminal_delivery = false` leaves every reply for the hook */
  settings?: SettingsStore;
  log?: (event: string, fields?: Record<string, string | number | undefined>) => void;
  /** How often and how many times a `working` agent is asked again before the reply is left for the hook (default 6 x 500 ms) */
  pollMs?: number;
  polls?: number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Claude Code checkpoint replies for an idle agent. An idle agent calls no tool, so the PreToolUse hook would only hand the
 * reply over after the human typed something themselves: the reply is typed into the agent's terminal instead, once herdr says
 * the agent is idle (a `working` status is re-checked for a few seconds: herdr can lag behind the Stop event). When no terminal
 * is found, or its agent is blocked / unknown, the reply stays queued for the hook. Never throws.
 */
export function startCheckpointDelivery(opts: DeliveryOptions): void {
  const { store, terminal, log = () => {}, pollMs = 500, polls = 6, settings } = opts;

  store.onCheckpointCreated = (d) => {
    if (d.session.agent === "codex") return;
    // Delivery off: no terminal is looked up and none is shown, so the GUI does not promise to type the reply
    if (settings && !settings.get().checkpoints.terminal_delivery) {
      store.setTerminal(d.session.session_id, undefined);
      return;
    }
    void refreshTerminal(d.session.session_id).catch((err) => log("terminal_find_failed", { session: d.session.session_id, error: String(err) }));
  };

  // Turned off: forget the terminals found while it was on
  settings?.onChange((s, prev) => {
    if (s.checkpoints.terminal_delivery || !prev.checkpoints.terminal_delivery) return;
    for (const x of store.listSessions()) if (x.terminal) store.setTerminal(x.session_id, undefined);
  });

  store.onCheckpointDeliverable = (d: Decision) => {
    void deliver(d).catch((err) => log("terminal_deliver_failed", { decision: d.id, error: String(err) }));
  };

  store.deliverPlanInstruction = async (sid, queued) => {
    if (settings && !settings.get().checkpoints.terminal_delivery) return false;
    const found = await refreshTerminal(sid);
    if (!found) return false;
    let status = found.status;
    for (let i = 0; i < polls && status === "working"; i++) {
      await sleep(pollMs);
      status = await terminal.status(found.ref);
    }
    if (status !== "idle") return false;
    const ins = store.claimPlanInstruction(sid, queued);
    if (!ins) return false;
    try {
      await terminal.type(found.ref, replyLine(ins.text, ins.about === "plan" ? PLAN_INSTRUCT_PREFIX : REPLY_PREFIX));
    } catch (err) {
      const textSent = err instanceof TerminalTypeError && err.textSent;
      if (!textSent) store.requeueInstruction(sid, ins);
      log(textSent ? "terminal_enter_failed" : "terminal_type_failed", { session: sid, error: String(err) });
      return textSent;
    }
    store.deliveredToTerminal(ins.decision_id); // a checkpoint reply that the plan instruction was joined to; no-op for a plain one
    return true;
  };

  async function refreshTerminal(sid: string) {
    const found = await terminal.find(sid);
    store.setTerminal(sid, found ? terminalLabel(found.ref) : undefined);
    return found;
  }

  async function deliver(d: Decision): Promise<void> {
    if (d.session.agent === "codex") return;
    if (settings && !settings.get().checkpoints.terminal_delivery) {
      log("terminal_delivery_skipped", { decision: d.id, reason: "disabled" });
      return;
    }
    const sid = d.session.session_id;
    const text = d.response?.text;
    if (!text) return;
    const found = await refreshTerminal(sid);
    if (!found) {
      log("terminal_not_found", { decision: d.id, session: sid });
      return;
    }
    const { ref } = found;
    let status = found.status;
    for (let i = 0; i < polls && status === "working"; i++) {
      await sleep(pollMs);
      status = await terminal.status(ref);
    }
    if (status !== "idle") {
      log("terminal_busy", { decision: d.id, session: sid, status });
      return;
    }
    const ins = store.claimInstruction(d.id, CHECKPOINT_TTL_MS);
    if (!ins) return; // the hook took it first, the agent is no longer idle, or the reply is too old to type
    try {
      await terminal.type(ref, replyLine(ins.text)); // the queue may hold a reply joined with a plan instruction
    } catch (err) {
      const textSent = err instanceof TerminalTypeError && err.textSent;
      // The text is in the composer already: typing or handing it over again would duplicate it
      if (!textSent) store.requeueInstruction(sid, ins);
      log(textSent ? "terminal_enter_failed" : "terminal_type_failed", { decision: d.id, error: String(err) });
      return;
    }
    store.deliveredToTerminal(d.id);
    log("checkpoint_delivered", { decision: d.id, via: "terminal", terminal: terminalLabel(ref) });
  }
}
