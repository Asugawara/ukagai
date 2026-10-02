import {
  AskUserQuestionInput,
  DENY_LINK_WINDOW_MS,
  ExitPlanModeInput,
  type CreateDecisionRequest,
  type Decision,
  type DecisionResponse,
  type Explanation,
  type PreToolUseInput,
} from "../contract.js";
import type { Client } from "./client.js";
import {
  denyReason,
  multiDenyReason,
  explainDir,
  findExplanation,
  markUsed,
  MISSING_LABELS,
  parseFrontMatter,
  parsePlanImpact,
  validateExplanation,
  validatePlan,
  type Validation,
} from "./explain.js";
import type { HookOptions } from "./options.js";
import { join } from "node:path";

type Out = Record<string, unknown>;

/** Upper bound for waiting on cancel after a signal */
const CANCEL_TIMEOUT_MS = 300;

const NO_HAS = { mermaid: false, table: false, diff: false };

function deny(reason: string): Out {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

function allow(updatedInput: Record<string, unknown>): Out {
  return {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput },
  };
}

/** Marker for "no explanation": path / markdown are empty, match is a fixed value (see docs/spec/api.md) */
function noExplanation(none_reason: "plan_mode" | "loop_guard"): Explanation {
  return { path: "", markdown: "", has: NO_HAS, match: "question", attached_via: "none", none_reason };
}

function questionCount(d: Decision): number {
  const qs = (d.request as { questions?: unknown[] }).questions;
  return Array.isArray(qs) ? qs.length : 0;
}

function firstQuestion(d: Decision): string | undefined {
  const qs = (d.request as { questions?: { question?: string }[] }).questions;
  return qs?.[0]?.question;
}

export function buildOutput(
  kind: "answer_question" | "approve_plan",
  toolInput: Record<string, unknown>,
  response: DecisionResponse,
): Out | null {
  if (response.via === "terminal") return null;
  if (kind === "answer_question") {
    if (!response.answers) return null;
    return allow({ ...toolInput, answers: response.answers });
  }
  if (response.approve === true) return allow(toolInput);
  if (response.approve === false) return deny(response.reason ?? "Rejected.");
  return null;
}

/** PreToolUse × AskUserQuestion / ExitPlanMode. Returns the JSON for stdout, or null for no output. The caller swallows exceptions */
export async function handleDecision(
  input: PreToolUseInput,
  opts: HookOptions,
  client: Client,
  startedAt: number,
): Promise<Out | null> {
  const kind = input.tool_name === "ExitPlanMode" ? "approve_plan" : "answer_question";
  const toolInput = input.tool_input;
  const session = {
    session_id: input.session_id,
    cwd: input.cwd,
    transcript_path: input.transcript_path,
    scratchpad_dir: input.scratchpad_dir,
    permission_mode: input.permission_mode,
    agent_id: input.agent_id,
    agent_type: input.agent_type,
  };
  const base = { tool_use_id: input.tool_use_id, kind, session, request: toolInput } as CreateDecisionRequest;

  let explanation: Explanation;
  let usedPath: string | undefined;

  if (kind === "answer_question") {
    const parsed = AskUserQuestionInput.safeParse(toolInput);
    if (!parsed.success) return null;
    const q0 = parsed.data.questions[0]!;
    if (input.permission_mode === "plan") {
      explanation = noExplanation("plan_mode");
    } else {
      const dir = explainDir(input.scratchpad_dir, opts.dataDir, input.session_id);
      // One decision = one question = one explanation. Multiple questions are denied before looking for an explanation (counted per session + agent, ignoring the question text)
      let multiGuarded = false;
      if (parsed.data.questions.length > 1) {
        const prior = await client.listDeniedExplain(input.session_id);
        if (!prior) return null;
        const t = Date.now();
        multiGuarded = prior.some(
          (d) =>
            d.status === "denied_explain" &&
            d.kind === "answer_question" &&
            (d.session.agent_id ?? "") === (input.agent_id ?? "") &&
            questionCount(d) > 1 &&
            t - Date.parse(d.created_at) <= DENY_LINK_WINDOW_MS,
        );
        if (!multiGuarded) {
          const reg = await client.createDecision({ ...base, status: "denied_explain", missing: ["multi"] });
          if (!reg) return null;
          return deny(multiDenyReason(parsed.data.questions.length));
        }
      }
      const found = await findExplanation(dir, q0.question);
      const v = found ? validateExplanation(found.markdown, "answer_question", q0.options.map((o) => o.label)) : null;
      const denied = await client.listDeniedExplain(input.session_id);
      if (!denied) return null; // server absent: skip the safeguard and fall back to the normal UI
      const now = Date.now();
      const linked = denied
        .filter(
          (d) =>
            d.status === "denied_explain" &&
            d.kind === "answer_question" &&
            (d.session.agent_id ?? "") === (input.agent_id ?? "") &&
            firstQuestion(d) === q0.question &&
            now - Date.parse(d.created_at) <= DENY_LINK_WINDOW_MS,
        )
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      if (found && v?.valid) {
        const fm = parseFrontMatter(found.markdown.replace(/\r\n?/g, "\n").split("\n")).fields;
        explanation = {
          path: found.path,
          type: fm["type"] === "blocker" || fm["type"] === "decision" ? fm["type"] : undefined,
          title: fm["title"] || q0.question,
          question: fm["question"],
          reversibility: fm["reversibility"] as Explanation["reversibility"],
          scope: fm["scope"] as Explanation["scope"],
          markdown: found.markdown,
          has: v.has,
          match: found.match,
          attached_via: linked.length > 0 ? "after_deny" : "first_call",
        };
        usedPath = found.path;
      } else if (linked.length > 0 || multiGuarded) {
        explanation = noExplanation("loop_guard");
      } else {
        const codes = v ? v.missing : ["file" as const];
        const reason = denyReason(opts.denyTemplate, {
          path: join(dir, "explain.md"),
          question: q0.question,
          missing: codes.map((c) => MISSING_LABELS[c]),
          codes,
          blocker: found ? parseFrontMatter(found.markdown.replace(/\r\n?/g, "\n").split("\n")).fields["type"] === "blocker" : false,
        });
        const reg = await client.createDecision({ ...base, status: "denied_explain", missing: codes });
        if (!reg) return null;
        return deny(reason);
      }
    }
  } else {
    const parsed = ExitPlanModeInput.safeParse(toolInput);
    if (!parsed.success) return null;
    const plan = parsed.data.plan;
    const v: Validation = validatePlan(plan);
    const denied = await client.listDeniedExplain(input.session_id);
    if (!denied) return null;
    const prior = denied
      .filter((d) => d.status === "denied_explain" && d.kind === "approve_plan")
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (v.valid) {
      explanation = {
        path: "",
        ...parsePlanImpact(plan),
        markdown: plan,
        has: v.has,
        match: "question",
        attached_via: prior.length > 0 ? "after_deny" : "first_call",
      };
    } else if (prior.length > 0) {
      explanation = noExplanation("loop_guard");
    } else {
      const reason = denyReason(opts.denyTemplate, { missing: v.missing.map((c) => MISSING_LABELS[c]) });
      const reg = await client.createDecision({ ...base, status: "denied_explain", missing: v.missing });
      if (!reg) return null;
      return deny(reason);
    }
  }

  const created = await client.createDecision({
    ...base,
    explanation,
  });
  if (!created) return null;
  if (usedPath) {
    try {
      await markUsed(usedPath);
    } catch {
      // a failed rename does not affect the decision
    }
  }

  // Termination signal from Esc / ctrl+c: tell the server to cancel once, print nothing, and exit
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  let cancelling = false;
  const onSignal = () => {
    if (cancelling) return;
    cancelling = true;
    void client.cancel(created.id, CANCEL_TIMEOUT_MS).finally(() => process.exit(0));
  };
  for (const s of signals) process.on(s, onSignal);
  try {
    // Long-poll. Step down on our own when less than the poll timeout + 5 seconds remain
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
      const out = buildOutput(kind, toolInput, r.response);
      if (!out) return null;
      if (!(await client.ack(created.id))) return null;
      return out;
    }
  } finally {
    for (const s of signals) process.off(s, onSignal);
  }
}
