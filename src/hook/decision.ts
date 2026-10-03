import {
  AskUserQuestionInput,
  DENY_LINK_WINDOW_MS,
  decisionFingerprint,
  ExitPlanModeInput,
  PLAN_BLOCK_SUFFIX,
  stripExplainBlocks,
  type CreateDecisionRequest,
  type Decision,
  type DecisionResponse,
  type Explanation,
  type PreToolUseInput,
} from "../contract.js";
import type { Client } from "./client.js";
import {
  checkRewrite,
  denyReason,
  handoffReason,
  type RewriteIssue,
  multiDenyReason,
  explainDir,
  findExplanation,
  type FoundExplanation,
  markUsed,
  MISSING_LABELS,
  coinedTermLabel,
  findCoinedTerms,
  parseFrontMatter,
  parsePlanImpact,
  toLines,
  validateExplanation,
  validatePlan,
  type Validation,
} from "./explain.js";
import type { HookOptions } from "./options.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { findPlanFile, readBlockFor } from "./plan-file.js";
import { setTimeout as sleep } from "node:timers/promises";
import { hookLog } from "./log.js";
import { readConfig } from "../settings/config.js";

type Out = Record<string, unknown>;

/** Upper bound for waiting on cancel after a signal */
const CANCEL_TIMEOUT_MS = 300;

/** Retry backoff for a failed wait: 1 s, 2 s, 4 s ... capped at 30 s */
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30_000;
/** Statuses that will not get better by retrying: wrong token, decision missing or already closed */
const FINAL_STATUSES = new Set([401, 404, 410]);
const ACK_RETRY_DELAY_MS = 1000;

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

type Kind = "answer_question" | "approve_plan";
type Parsed = { question: AskUserQuestionInput } | { plan: string };
type Log = (event: string, extra?: Record<string, string | number | undefined>) => void;
type Ctx = {
  input: PreToolUseInput;
  opts: HookOptions;
  client: Client;
  kind: Kind;
  base: CreateDecisionRequest;
  lg: Log;
  failMsg: () => Record<string, string | number | undefined>;
};
/** Either an explanation to register, or the hook's final output (a deny, or null to fall back to the normal UI) */
type Explained = { explanation: Explanation; usedPath?: string } | { out: Out | null };

/** Record a deny that carries no explanation, then answer with it. Null (fall back) when the server cannot record it */
async function denyAndRecord(c: Ctx, reason: string, missing: string[]): Promise<Out | null> {
  const reg = await c.client.createDecision({ ...c.base, status: "denied_explain", missing });
  if (!reg) {
    c.lg("create_decision_failed", c.failMsg());
    return null;
  }
  return deny(reason);
}

const sameAgent = (d: Decision, agentId: string | undefined): boolean => (d.session.agent_id ?? "") === (agentId ?? "");

async function explainQuestion(c: Ctx, data: AskUserQuestionInput): Promise<Explained> {
  const { input, opts, client, lg, failMsg } = c;
  const q0 = data.questions[0]!;
  // Plan mode (Claude): the plan file is the only writable file, so the explanation is a block inside it. Without a findable plan file (Codex, a reworded reminder) there is none
  const planHit =
    input.permission_mode === "plan" && (input.agent ?? opts.agent) !== "codex"
      ? await findPlanFile(input.transcript_path, homedir(), q0.question)
      : null;
  if (input.permission_mode === "plan" && !planHit) return { explanation: noExplanation("plan_mode") };
  const planFile = planHit?.file;
  const dir = explainDir(input.scratchpad_dir, opts.dataDir, input.session_id);
  // The human's last "Cannot answer" (null when none or the server is unreachable: ignored)
  const [{ lang }, memo, denied] = await Promise.all([
    readConfig(opts.dataDir),
    client.getPendingRewrite(input.session_id),
    client.listDeniedExplain(input.session_id),
  ]);
  if (!denied) {
    // server absent: skip the safeguard and fall back to the normal UI
    lg("list_denied_explain_failed", failMsg());
    return { out: null };
  }
  const now = Date.now();
  // One decision = one question = one explanation. Multiple questions are denied before looking for an explanation (counted per session + agent, ignoring the question text)
  const multiGuarded =
    data.questions.length > 1 &&
    denied.some(
      (d) =>
        d.status === "denied_explain" &&
        d.kind === "answer_question" &&
        sameAgent(d, input.agent_id) &&
        questionCount(d) > 1 &&
        now - Date.parse(d.created_at) <= DENY_LINK_WINDOW_MS,
    );
  if (data.questions.length > 1 && !multiGuarded) {
    return { out: await denyAndRecord(c, multiDenyReason(data.questions.length, input.agent), ["multi"]) };
  }
  let found: FoundExplanation | null;
  if (planHit) {
    const block = planHit.block ?? (await readBlockFor(planHit.file, q0.question));
    found = block ? { path: planHit.file + PLAN_BLOCK_SUFFIX, markdown: block.body, match: "question" } : null;
  } else {
    found = await findExplanation(dir, q0.question);
  }
  const labels = q0.options.map((o) => o.label);
  const v = found
    ? validateExplanation(found.markdown, "answer_question", labels, lang, {
        question: q0.question,
        descriptions: q0.options.map((o) => o.description ?? ""),
      })
    : null;
  const rewriteIssues: RewriteIssue[] = found ? checkRewrite(memo, found.markdown, q0.question, labels) : [];
  const linked = denied.filter(
    (d) =>
      d.status === "denied_explain" &&
      d.kind === "answer_question" &&
      sameAgent(d, input.agent_id) &&
      firstQuestion(d) === q0.question &&
      now - Date.parse(d.created_at) <= DENY_LINK_WINDOW_MS,
  );
  if (found && v?.valid && rewriteIssues.length === 0) {
    const fm = parseFrontMatter(toLines(found.markdown)).fields;
    const explanation: Explanation = {
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
    // The hook never edits a plan file: no rename for a plan-mode block
    return { explanation, usedPath: planFile ? undefined : found.path };
  }
  if ((linked.length > 0 && !memo) || multiGuarded) {
    // With a "Cannot answer" memo the loop guard does not apply: never hand the human, right after they said they could not read it, an explanation that still fails
    return { explanation: noExplanation("loop_guard") };
  }
  const own = v ? v.missing : ["file" as const];
  const codes = [...own, ...rewriteIssues.map((i) => i.code).filter((c) => !own.includes(c))];
  const reason = denyReason(opts.denyTemplate, {
    ...(planFile ? { planFile } : { path: join(dir, "explain.md") }),
    question: q0.question,
    missing: [
      ...own.map((c) => (c === "coined_term" && found ? coinedTermLabel(findCoinedTerms(found.markdown, labels), rewriteIssues.length === 0) : MISSING_LABELS[c])),
      ...rewriteIssues.map((i) => i.text),
    ],
    codes,
    agent: input.agent,
    blocker: found ? parseFrontMatter(toLines(found.markdown)).fields["type"] === "blocker" : false,
  });
  return { out: await denyAndRecord(c, reason, codes) };
}

async function explainPlan(c: Ctx, plan: string): Promise<Explained> {
  const { input, opts, client, lg, failMsg } = c;
  const v: Validation = validatePlan(plan);
  const denied = await client.listDeniedExplain(input.session_id);
  if (!denied) {
    lg("list_denied_explain_failed", failMsg());
    return { out: null };
  }
  const prior = denied.filter((d) => d.status === "denied_explain" && d.kind === "approve_plan");
  if (v.valid) {
    return {
      explanation: {
        path: "",
        ...parsePlanImpact(plan),
        markdown: plan,
        has: v.has,
        match: "question",
        attached_via: prior.length > 0 ? "after_deny" : "first_call",
      },
    };
  }
  if (prior.length > 0) return { explanation: noExplanation("loop_guard") };
  const reason = denyReason(opts.denyTemplate, { missing: v.missing.map((m) => MISSING_LABELS[m]), agent: input.agent });
  return { out: await denyAndRecord(c, reason, v.missing) };
}

/** First sight of a question: validate its explanation (deny when it is missing or unfit) and register the decision */
async function registerFresh(c: Ctx, parsed: Parsed): Promise<Pick<Decision, "id"> | { out: Out | null }> {
  const { input, client, kind, base, lg, failMsg } = c;
  const r = "question" in parsed ? await explainQuestion(c, parsed.question) : await explainPlan(c, parsed.plan);
  if ("out" in r) return r;
  const created = await client.createDecision({ ...base, explanation: r.explanation });
  if (!created) {
    lg("create_decision_failed", failMsg());
    return { out: null };
  }
  // The explanation got through: the human's "Cannot answer" has been answered with a new one
  if (kind === "answer_question" && r.explanation.none_reason !== "plan_mode") await client.consumeRewrite(input.session_id);
  if (r.usedPath) {
    try {
      await markUsed(r.usedPath);
    } catch {
      // a failed rename does not affect the decision
    }
  }
  return created;
}

/** PreToolUse × AskUserQuestion / ExitPlanMode. Returns the JSON for stdout, or null for no output. The caller swallows exceptions */
export async function handleDecision(
  input: PreToolUseInput,
  opts: HookOptions,
  client: Client,
  startedAt: number,
  /** Maps the human's answer to stdout. Claude: allow + updatedInput; Codex: deny carrying the answer */
  build: typeof buildOutput = buildOutput,
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
    agent: input.agent,
  };
  const lg = (event: string, extra: Record<string, string | number | undefined> = {}): void =>
    hookLog(event, { session_id: input.session_id, elapsed_s: Math.round((Date.now() - startedAt) / 100) / 10, ...extra });
  const failMsg = (): Record<string, string | number | undefined> => ({
    status: client.lastFailure?.status,
    message: client.lastFailure?.message,
  });
  // What ukagai registers and fingerprints: a plan without the explanation blocks written for AskUserQuestion (the answer still goes back with the original input)
  const regInput: Record<string, unknown> =
    kind === "approve_plan" && typeof toolInput["plan"] === "string" ? { ...toolInput, plan: stripExplainBlocks(toolInput["plan"]) } : toolInput;
  const base = { tool_use_id: input.tool_use_id, kind, session, request: regInput } as CreateDecisionRequest;

  // Input that is not a well-formed question / plan is never ours to handle
  let parsed: Parsed;
  if (kind === "answer_question") {
    const r = AskUserQuestionInput.safeParse(toolInput);
    if (!r.success) return null;
    parsed = { question: r.data };
  } else {
    const r = ExitPlanModeInput.safeParse(regInput);
    if (!r.success) return null;
    parsed = { plan: r.data.plan };
  }

  // A question that is still open in ukagai (the previous leg handed off, or the hook died) is re-attached, never registered again
  const open = await client.findOpen(input.session_id, input.agent_id, decisionFingerprint(kind, regInput), input.tool_use_id);
  let created: Pick<Decision, "id">;
  if (open) {
    created = { id: open.id };
    lg("reattach", { decision_id: open.id, handoffs: open.handoffs ?? 0 });
  } else {
    const fresh = await registerFresh({ input, opts, client, kind, base, lg, failMsg }, parsed);
    if ("out" in fresh) return fresh.out;
    created = fresh;
  }

  // Termination signal from Esc / ctrl+c: tell the server to cancel once, print nothing, and exit
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  let cancelling = false;
  const onSignal = () => {
    if (cancelling) return;
    cancelling = true;
    lg("signal_cancel", { decision_id: created.id });
    void client.cancel(created.id, CANCEL_TIMEOUT_MS).finally(() => process.exit(0));
  };
  for (const s of signals) process.on(s, onSignal);
  try {
    // Long-poll. Step down on our own when less than the poll timeout + 5 seconds remain
    const marginSec = opts.pollTimeoutMs / 1000 + 5;
    // Consecutive wait failures are retried until retryWindowMs has passed since the first of them
    let failStreakStart: number | undefined;
    let failCount = 0;
    for (;;) {
      const remainingSec = opts.budgetSec - (Date.now() - startedAt) / 1000;
      if (remainingSec < marginSec) {
        // The question stays open in ukagai: the agent is asked to call the tool again, which re-attaches. Only when
        // the server cannot record the hand-off is it a real failure and Claude Code's own prompt takes over
        if (await client.handoff(created.id, input.session_id)) {
          lg("handoff", { decision_id: created.id });
          return deny(handoffReason(kind, input.agent));
        }
        lg("fallback_budget", { decision_id: created.id, ...failMsg() });
        await client.answerFallback(created.id);
        return null;
      }
      const r = await client.wait(created.id, opts.pollTimeoutMs);
      if (r.kind === "timeout") {
        failStreakStart = undefined;
        failCount = 0;
        continue;
      }
      if (r.kind === "error") {
        const now = Date.now();
        failStreakStart ??= now;
        failCount++;
        const windowLeft = opts.retryWindowMs - (now - failStreakStart);
        const final = r.status !== undefined && FINAL_STATUSES.has(r.status);
        if (final || windowLeft <= 0) {
          lg("wait_error_final", {
            decision_id: created.id,
            status: r.status,
            message: final ? r.message : `${r.message} (retry window exhausted after ${failCount} failures)`,
          });
          return null;
        }
        const delay = Math.min(RETRY_BASE_MS * 2 ** (failCount - 1), RETRY_MAX_MS, windowLeft);
        lg("wait_retry", { decision_id: created.id, status: r.status, message: r.message, retry_in_ms: delay, failures: failCount });
        await sleep(delay);
        continue;
      }
      failStreakStart = undefined;
      failCount = 0;
      const out = build(kind, toolInput, r.response);
      if (!out) {
        lg("no_answer_output", { decision_id: created.id, message: `via=${r.response.via}` });
        return null;
      }
      // The human's answer is already submitted: one retry before giving up on the ack
      let acked = await client.ack(created.id);
      if (!acked) {
        lg("ack_retry", { decision_id: created.id, ...failMsg() });
        await sleep(ACK_RETRY_DELAY_MS);
        acked = await client.ack(created.id);
      }
      if (!acked) {
        lg("ack_failed", { decision_id: created.id, ...failMsg() });
        return null;
      }
      return out;
    }
  } finally {
    for (const s of signals) process.off(s, onSignal);
  }
}
