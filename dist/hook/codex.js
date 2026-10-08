import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { CodexRequestUserInputInput, PreToolUseInput, isAllowedTranscriptPath, } from "../contract.js";
import { isEscapedQuestion, observedEvent } from "./context-hooks.js";
import { handleDecision } from "./decision.js";
/** Longest prose question shown in the GUI */
const STOP_QUESTION_MAX = 2000;
/**
 * Codex stdin → the shape the shared flow expects: `transcript_path` is null with --ephemeral ("" then; the server allows that for codex only),
 * `agent` is set, and `permission_mode` is dropped (Codex reports bypassPermissions in exec, so it must not decide plan mode)
 */
export function codexInput(raw) {
    const { permission_mode: _drop, ...rest } = raw;
    // A rollout outside ~/.codex/sessions (a custom CODEX_HOME) would be refused by the server and the decision lost; the server does not read Codex rollouts anyway
    const tp = raw["transcript_path"];
    return { ...rest, transcript_path: typeof tp === "string" && isAllowedTranscriptPath(tp, homedir()) ? tp : "", agent: "codex" };
}
/** `request_user_input` → AskUserQuestion shape (`id` and `isOther` pass through as extra keys) */
export function toAskUserQuestion(input) {
    return {
        questions: input.tool_input.questions.map((q) => ({
            ...q,
            header: q.header ?? "",
            options: (q.options ?? []).map((o) => ({ ...o })),
            multiSelect: false,
        })),
    };
}
/** The human's answers as the deny reason (Codex hooks cannot inject `answers` into request_user_input) */
export function codexAnswerReason(toolInput, answers) {
    const questions = toolInput["questions"] ?? [];
    const lines = questions.map((q) => `${q.question} = ${answers[q.question] ?? ""}`);
    if (lines.length === 1) {
        return `The human answered in the ukagai GUI: ${lines[0]}. Do not ask again; continue with this answer.`;
    }
    return `The human answered in the ukagai GUI:\n${lines.map((l) => `- ${l}`).join("\n")}\nDo not ask again; continue with these answers.`;
}
/** Fallback (budget ran out) and terminal answers print nothing: Codex's native UI takes over */
export function codexBuildOutput(kind, toolInput, response) {
    if (kind !== "answer_question" || response.via === "terminal" || !response.answers)
        return null;
    return {
        hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: codexAnswerReason(toolInput, response.answers),
        },
    };
}
/** PreToolUse × request_user_input. `input` has gone through codexInput */
export async function codexPreToolUse(input, opts, client, startedAt) {
    const parsed = CodexRequestUserInputInput.safeParse(input);
    if (!parsed.success)
        return null;
    const shared = PreToolUseInput.safeParse({
        ...input,
        tool_name: "AskUserQuestion",
        tool_input: toAskUserQuestion(parsed.data),
    });
    if (!shared.success)
        return null;
    return handleDecision(shared.data, opts, client, startedAt, codexBuildOutput);
}
const NO_EXPLANATION = {
    path: "",
    markdown: "",
    has: { mermaid: false, table: false, diff: false },
    match: "question",
    attached_via: "none",
    none_reason: "not_required",
};
/**
 * Stop: a prose question (ending with ？ / ?) is registered as a decision; if the human answers in the GUI within the budget,
 * the turn continues with the answer (`decision: block`). Anything else prints nothing
 */
export async function codexStop(input, opts, client, startedAt) {
    const msg = input["last_assistant_message"];
    const text = typeof msg === "string" ? msg : undefined;
    const detected = isEscapedQuestion(text);
    const act = detected && !opts.observe && input["stop_hook_active"] !== true;
    // The event comes first: the session must not read as idle after the answer arrives
    await Promise.race([observedEvent(input, client), new Promise((r) => setTimeout(r, 1500).unref())]);
    if (!act || !text)
        return null;
    const session = {
        session_id: String(input["session_id"]),
        cwd: String(input["cwd"]),
        transcript_path: String(input["transcript_path"] ?? ""),
        agent: "codex",
    };
    const question = text.length > STOP_QUESTION_MAX ? text.slice(-STOP_QUESTION_MAX) : text;
    const req = {
        tool_use_id: `stop-${String(input["turn_id"] ?? input["session_id"])}`,
        kind: "answer_question",
        session,
        request: { questions: [{ question, header: "Question", options: [], multiSelect: false }] },
        explanation: NO_EXPLANATION,
    };
    const response = await registerAndWait(req, opts, client, startedAt);
    if (!response)
        return null;
    const answer = Object.values(response.answers ?? {}).join("; ");
    return { decision: "block", reason: `The human answered your question in the ukagai GUI: ${answer}. Continue with it.` };
}
/**
 * Register a decision, wait for the human's answer in the GUI and acknowledge it. Null when nothing should be printed:
 * the server is unreachable, the budget ran out, the human answered in the terminal, or the ack failed
 */
async function registerAndWait(req, opts, client, startedAt) {
    const created = await client.createDecision(req);
    if (!created)
        return null;
    const signals = ["SIGTERM", "SIGINT", "SIGHUP"];
    let cancelling = false;
    const onSignal = () => {
        if (cancelling)
            return;
        cancelling = true;
        void client.cancel(created.id, 300).finally(() => process.exit(0));
    };
    for (const s of signals)
        process.on(s, onSignal);
    try {
        const marginSec = opts.pollTimeoutMs / 1000 + 5;
        for (;;) {
            const remainingSec = opts.budgetSec - (Date.now() - startedAt) / 1000;
            if (remainingSec < marginSec) {
                await client.answerFallback(created.id);
                return null;
            }
            const r = await client.wait(created.id, opts.pollTimeoutMs);
            if (r.kind === "timeout")
                continue;
            if (r.kind === "error")
                return null;
            if (r.response.via === "terminal" || !r.response.answers)
                return null;
            if (!(await client.ack(created.id)))
                return null;
            return r.response;
        }
    }
    finally {
        for (const s of signals)
            process.off(s, onSignal);
    }
}
/** Longest command shown in an approval card */
const APPROVAL_COMMAND_MAX = 2000;
/** What the approval card shows: the model's description, then the command (or the raw tool input when there is no command) */
export function approvalQuestion(toolInput) {
    const description = typeof toolInput["description"] === "string" ? toolInput["description"].trim() : "";
    const raw = typeof toolInput["command"] === "string" ? toolInput["command"] : JSON.stringify(toolInput);
    const command = raw.length > APPROVAL_COMMAND_MAX ? raw.slice(0, APPROVAL_COMMAND_MAX) + " …" : raw;
    return `${description ? description + "\n\n" : ""}\`${command}\``;
}
/** The PermissionRequest output for the human's answer: "Allow" allows, "Deny" or any free text denies (the text rides along) */
export function approvalOutput(answer) {
    const text = answer.trim();
    if (text === APPROVE_LABEL)
        return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } };
    const message = text === DENY_LABEL || text === "" ? "Denied in the ukagai GUI" : `Denied in the ukagai GUI: ${text}`;
    return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message } } };
}
const APPROVE_LABEL = "Allow";
const DENY_LABEL = "Deny";
/**
 * PermissionRequest (Codex asks for approval of a command): registered as a two-option question headed "Approval".
 * No answer within the budget, no server, a terminal answer → nothing is printed and Codex shows its own popup
 */
export async function codexPermissionRequest(input, opts, client, startedAt) {
    const toolInput = input["tool_input"];
    if (typeof toolInput !== "object" || toolInput === null || Array.isArray(toolInput))
        return null;
    const session = {
        session_id: String(input["session_id"]),
        cwd: String(input["cwd"]),
        transcript_path: String(input["transcript_path"] ?? ""),
        agent: "codex",
    };
    const question = approvalQuestion(toolInput);
    const req = {
        tool_use_id: `perm-${String(input["turn_id"] ?? input["session_id"])}-${randomUUID().slice(0, 8)}`,
        kind: "answer_question",
        session,
        request: {
            questions: [{ question, header: "Approval", options: [{ label: APPROVE_LABEL }, { label: DENY_LABEL }], multiSelect: false }],
            tool_name: input["tool_name"],
        },
        explanation: NO_EXPLANATION,
    };
    const response = await registerAndWait(req, opts, client, startedAt);
    if (!response)
        return null;
    return approvalOutput(Object.values(response.answers ?? {}).join("; "));
}
//# sourceMappingURL=codex.js.map