import { existsSync } from "node:fs";
import { markerPath } from "../hook/plan-context.js";
/**
 * Whether a plan is worth showing the human now: its session is known, that session is not working
 * (the file is in flux between UserPromptSubmit and Stop), its last Stop was not a question put in the terminal (the agent waits for the human
 * there; the plan is not finished), the agent's Stop is not final while its background subagents run, nor until the wake-up turn they trigger
 * has started, no decision of it is pending (the human is asked that first) and, only when ukagai handed its plan format to the
 * session (the plan-context marker), the file has the `Steps` / `Verification` sections. There is no size threshold: a small plan shows.
 * Computed here, once; the GUI and the TUI only read `ready`.
 */
export class PlanReady {
    store;
    planSessions;
    send;
    dataDir;
    /** plan name -> the last summary handed out (with its session) and the `ready` it carried */
    last = new Map();
    constructor(store, planSessions, send, 
    /** Where the plan-context markers are (`<dataDir>/plan-context/<session>`): a session with one was handed ukagai's plan format */
    dataDir) {
        this.store = store;
        this.planSessions = planSessions;
        this.send = send;
        this.dataDir = dataDir;
    }
    /** `ready` for a plan with this completeness and session, as of now */
    readyOf(plan, sessionId) {
        if (!sessionId)
            return false;
        // The Steps / Verification format is asked of a session only when ukagai gave it the rules; any other plan format is fine
        if (!plan.format_ok && existsSync(markerPath(this.dataDir, sessionId)))
            return false;
        const session = this.store.listSessions().find((s) => s.session_id === sessionId);
        if (!session || session.state === "working" || session.state === "ended")
            return false;
        if (this.store.isAskedInTerminal(sessionId))
            return false; // the agent ended its turn with a question: the plan is not finished
        if (this.store.isWaitingOnSubagents(sessionId))
            return false;
        return !this.store.list("pending").some((d) => d.session.session_id === sessionId);
    }
    /** The summary with its session and `ready` filled in; remembered as what the clients were told */
    decorate(p) {
        const session_id = p.session_id ?? this.planSessions.cached(p.name);
        const summary = { ...p, ready: false };
        if (session_id)
            summary.session_id = session_id;
        summary.ready = this.readyOf(summary, session_id);
        this.last.set(p.name, { summary, ready: summary.ready });
        return summary;
    }
    /** `plan.updated` for a summary */
    announce(p) {
        this.send("plan.updated", this.decorate(p));
    }
    forget(name) {
        this.last.delete(name);
    }
    /** The session's state or decisions changed: the plans of that session whose `ready` flipped are announced again, the others are not */
    recheck(sessionId) {
        for (const name of this.planSessions.plansOf(sessionId)) {
            const prev = this.last.get(name);
            if (!prev)
                continue;
            const next = this.decorate(prev.summary);
            if (next.ready !== prev.ready)
                this.send("plan.updated", next);
        }
    }
}
//# sourceMappingURL=plan-ready.js.map