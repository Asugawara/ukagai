import { execFile } from "node:child_process";
import { PLAN_INSTRUCT_PREFIX } from "../contract.js";
/** Typing failed; `textSent` says the text already reached the composer (only the Enter failed), so typing it again would duplicate it */
export class TerminalTypeError extends Error {
    textSent;
    constructor(message, textSent) {
        super(message);
        this.textSent = textSent;
    }
}
const TIMEOUT_MS = 5000;
const MAX_TEXT = 4000;
export const REPLY_PREFIX = "[ukagai] Reply to your progress recap:";
export { PLAN_INSTRUCT_PREFIX };
/** `herdr:w1:p1` — how a TerminalRef is shown on a session */
export function terminalLabel(ref) {
    return `${ref.kind}:${ref.pane_id}`;
}
/** One line (Enter would submit early otherwise): the reply to a progress recap, control characters and newlines turned into spaces, capped */
export function replyLine(text, prefix = REPLY_PREFIX) {
    return `${prefix} ${text}`.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
}
function run(bin, args) {
    return new Promise((resolve, reject) => {
        execFile(bin, args, { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
}
/** herdr reports a finished turn as `done`: the agent is at its prompt, like `idle` */
function statusOf(s) {
    if (s === "idle" || s === "done")
        return "idle";
    return s === "working" || s === "blocked" ? s : "unknown";
}
/** No terminal anywhere: every reply waits for the hook */
export class NoTerminal {
    async find() {
        return undefined;
    }
    async type() { }
    async status() {
        return "unknown";
    }
}
export class HerdrTerminal {
    bin;
    onError;
    /** `onError` hears why `herdr` could not be asked (a missing binary, a timeout, odd output); the answer path never sees it */
    constructor(bin = "herdr", onError) {
        this.bin = bin;
        this.onError = onError;
    }
    async panes() {
        try {
            const j = JSON.parse(await run(this.bin, ["pane", "list"]));
            return Array.isArray(j.result?.panes) ? j.result.panes : [];
        }
        catch (err) {
            this.onError?.(err instanceof Error ? err.message : String(err));
            return [];
        }
    }
    async find(sessionId) {
        const p = (await this.panes()).find((x) => x.agent === "claude" && x.agent_session?.value === sessionId && typeof x.pane_id === "string");
        return p ? { ref: { kind: "herdr", pane_id: p.pane_id }, status: statusOf(p.agent_status) } : undefined;
    }
    async status(ref) {
        return statusOf((await this.panes()).find((x) => x.pane_id === ref.pane_id)?.agent_status);
    }
    async type(ref, text) {
        try {
            await run(this.bin, ["pane", "send-text", ref.pane_id, text]);
        }
        catch (err) {
            throw new TerminalTypeError(err instanceof Error ? err.message : String(err), false);
        }
        try {
            await run(this.bin, ["pane", "send-keys", ref.pane_id, "Enter"]);
        }
        catch (err) {
            throw new TerminalTypeError(err instanceof Error ? err.message : String(err), true);
        }
    }
}
//# sourceMappingURL=terminal.js.map