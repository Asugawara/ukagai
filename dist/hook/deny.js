/** Every deny line starts with this, so neither the human nor the agent reads a validation round as an error */
export const DENY_TAG = "[ukagai, not a failure] ";
/** Every deny line ends with this: the agent finds the instructions in the hook context */
export const DENY_LINE_END = "(see hook context).";
/** Longest deny line (one terminal line) */
export const DENY_LINE_MAX = 160;
/** PreToolUse deny output. Codex has no verified PreToolUse additionalContext: it keeps the full text as the reason (today's output) */
export function denyOutput(t, agent) {
    return {
        hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            ...(agent === "codex" ? { permissionDecisionReason: t.context } : { permissionDecisionReason: t.line, additionalContext: t.context }),
        },
    };
}
/** `[ukagai, not a failure] <what> (see hook context).` */
export function denyLine(what) {
    return `${DENY_TAG}${what} ${DENY_LINE_END}`;
}
//# sourceMappingURL=deny.js.map