import {
  CodexRequestUserInputInput,
  PreToolUseInput,
  type CreateDecisionRequest,
  type DecisionResponse,
  type Explanation,
} from "../contract.js";
import type { Client } from "./client.js";
import { isBlockerMessage } from "./blocker.js";
import { isEscapedQuestion, observedEvent } from "./context-hooks.js";
import { handleDecision } from "./decision.js";
import type { HookOptions } from "./options.js";

type Out = Record<string, unknown>;

/** Longest prose question shown in the GUI */
const STOP_QUESTION_MAX = 2000;

/**
 * Codex stdin → the shape the shared flow expects: `transcript_path` is null with --ephemeral ("" then; the server allows that for codex only),
 * `agent` is set, and `permission_mode` is dropped (Codex reports bypassPermissions in exec, so it must not decide plan mode)
 */
export function codexInput(raw: Record<string, unknown>): Record<string, unknown> {
  const { permission_mode: _drop, ...rest } = raw;
  return { ...rest, transcript_path: typeof raw["transcript_path"] === "string" ? raw["transcript_path"] : "", agent: "codex" };
}

/** `request_user_input` → AskUserQuestion shape (`id` and `isOther` pass through as extra keys) */
export function toAskUserQuestion(input: CodexRequestUserInputInput): Record<string, unknown> {
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
export function codexAnswerReason(toolInput: Record<string, unknown>, answers: Record<string, string>): string {
  const questions = (toolInput["questions"] as { question: string }[] | undefined) ?? [];
  const lines = questions.map((q) => `${q.question} = ${answers[q.question] ?? ""}`);
  if (lines.length === 1) {
    return `The human answered in the ukagai GUI: ${lines[0]}. Do not ask again; continue with this answer.`;
  }
  return `The human answered in the ukagai GUI:\n${lines.map((l) => `- ${l}`).join("\n")}\nDo not ask again; continue with these answers.`;
}

/** Fallback (budget ran out) and terminal answers print nothing: Codex's native UI takes over */
export function codexBuildOutput(
  kind: "answer_question" | "approve_plan",
  toolInput: Record<string, unknown>,
  response: DecisionResponse,
): Out | null {
  if (kind !== "answer_question" || response.via === "terminal" || !response.answers) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: codexAnswerReason(toolInput, response.answers),
    },
  };
}

/** PreToolUse × request_user_input. `input` has gone through codexInput */
export async function codexPreToolUse(
  input: Record<string, unknown>,
  opts: HookOptions,
  client: Client,
  startedAt: number,
): Promise<Out | null> {
  const parsed = CodexRequestUserInputInput.safeParse(input);
  if (!parsed.success) return null;
  const shared = PreToolUseInput.safeParse({
    ...input,
    tool_name: "AskUserQuestion",
    tool_input: toAskUserQuestion(parsed.data),
  });
  if (!shared.success) return null;
  return handleDecision(shared.data, opts, client, startedAt, codexBuildOutput);
}

const NO_EXPLANATION: Explanation = {
  path: "",
  markdown: "",
  has: { mermaid: false, table: false, diff: false },
  match: "question",
  attached_via: "none",
  none_reason: "not_required",
};

/**
 * Stop: a prose question / blocker is registered as a decision; if the human answers in the GUI within the budget,
 * the turn continues with the answer (`decision: block`). Anything else prints nothing
 */
export async function codexStop(
  input: Record<string, unknown>,
  opts: HookOptions,
  client: Client,
  startedAt: number,
): Promise<Out | null> {
  const msg = input["last_assistant_message"];
  const text = typeof msg === "string" ? msg : undefined;
  const detected = isEscapedQuestion(text) || isBlockerMessage(text);
  const act = detected && !opts.observe && input["stop_hook_active"] !== true;
  // The event comes first: the session must not read as idle after the answer arrives
  await Promise.race([observedEvent(input, client), new Promise<void>((r) => setTimeout(r, 1500).unref())]);
  if (!act || !text) return null;

  const session = {
    session_id: String(input["session_id"]),
    cwd: String(input["cwd"]),
    transcript_path: String(input["transcript_path"] ?? ""),
    agent: "codex" as const,
  };
  const question = text.length > STOP_QUESTION_MAX ? text.slice(-STOP_QUESTION_MAX) : text;
  const req = {
    tool_use_id: `stop-${String(input["turn_id"] ?? input["session_id"])}`,
    kind: "answer_question",
    session,
    request: { questions: [{ question, header: "Question", options: [], multiSelect: false }] },
    explanation: NO_EXPLANATION,
  } as CreateDecisionRequest;
  const created = await client.createDecision(req);
  if (!created) return null;

  const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  let cancelling = false;
  const onSignal = () => {
    if (cancelling) return;
    cancelling = true;
    void client.cancel(created.id, 300).finally(() => process.exit(0));
  };
  for (const s of signals) process.on(s, onSignal);
  try {
    const marginSec = opts.pollTimeoutMs / 1000 + 5;
    for (;;) {
      const remainingSec = opts.budgetSec - (Date.now() - startedAt) / 1000;
      if (remainingSec < marginSec) {
        await client.answerFallback(created.id);
        return null;
      }
      const r = await client.wait(created.id, opts.pollTimeoutMs);
      if (r.kind === "timeout") continue;
      if (r.kind === "error") return null;
      if (r.response.via === "terminal" || !r.response.answers) return null;
      const answer = Object.values(r.response.answers).join("; ");
      if (!(await client.ack(created.id))) return null;
      return { decision: "block", reason: `The human answered your question in the ukagai GUI: ${answer}. Continue with it.` };
    }
  } finally {
    for (const s of signals) process.off(s, onSignal);
  }
}
