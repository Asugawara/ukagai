import { existsSync } from "node:fs";
import type { PlanSummary } from "../contract.js";
import { markerPath } from "../hook/plan-context.js";
import type { PlanSessions } from "./plan-session.js";
import type { Store } from "./store.js";

type Send = (event: "plan.updated", data: PlanSummary) => void;

/**
 * Whether a plan is worth showing the human now: its session is known, that session is not working
 * (the file is in flux between UserPromptSubmit and Stop), its last Stop was not a question put in the terminal (the agent waits for the human
 * there; the plan is not finished), no decision of it is pending (the human is asked that first) and, only when ukagai handed its plan format to the
 * session (the plan-context marker), the file has the `Steps` / `Verification` sections. There is no size threshold: a small plan shows.
 * Computed here, once; the GUI and the TUI only read `ready`.
 */
export class PlanReady {
  /** plan name -> the last summary handed out (with its session) and the `ready` it carried */
  private last = new Map<string, { summary: PlanSummary; ready: boolean }>();

  constructor(
    private store: Pick<Store, "listSessions" | "list" | "isAskedInTerminal">,
    private planSessions: Pick<PlanSessions, "cached" | "plansOf">,
    private send: Send,
    /** Where the plan-context markers are (`<dataDir>/plan-context/<session>`): a session with one was handed ukagai's plan format */
    private dataDir: string,
  ) {}

  /** `ready` for a plan with this completeness and session, as of now */
  readyOf(plan: { format_ok: boolean }, sessionId: string | undefined): boolean {
    if (!sessionId) return false;
    // The Steps / Verification format is asked of a session only when ukagai gave it the rules; any other plan format is fine
    if (!plan.format_ok && existsSync(markerPath(this.dataDir, sessionId))) return false;
    const session = this.store.listSessions().find((s) => s.session_id === sessionId);
    if (!session || session.state === "working" || session.state === "ended") return false;
    if (this.store.isAskedInTerminal(sessionId)) return false; // the agent ended its turn with a question: the plan is not finished
    return !this.store.list("pending").some((d) => d.session.session_id === sessionId);
  }

  /** The summary with its session and `ready` filled in; remembered as what the clients were told */
  decorate(p: PlanSummary): PlanSummary {
    const session_id = p.session_id ?? this.planSessions.cached(p.name);
    const summary: PlanSummary = { ...p, ready: false };
    if (session_id) summary.session_id = session_id;
    summary.ready = this.readyOf(summary, session_id);
    this.last.set(p.name, { summary, ready: summary.ready });
    return summary;
  }

  /** `plan.updated` for a summary */
  announce(p: PlanSummary): void {
    this.send("plan.updated", this.decorate(p));
  }

  forget(name: string): void {
    this.last.delete(name);
  }

  /** The session's state or decisions changed: the plans of that session whose `ready` flipped are announced again, the others are not */
  recheck(sessionId: string): void {
    for (const name of this.planSessions.plansOf(sessionId)) {
      const prev = this.last.get(name);
      if (!prev) continue;
      const next = this.decorate(prev.summary);
      if (next.ready !== prev.ready) this.send("plan.updated", next);
    }
  }
}
