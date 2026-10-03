import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { z } from "zod";

// ---- Constants ----

/** Separator for multiSelect answer values. Provisional until confirmed by the E2 result. */
export const MULTI_SELECT_SEPARATOR = ", ";
export const POLL_TIMEOUT_MS = 25000;
export const LEASE_GRACE_MS = 10000;
export const DENY_LINK_WINDOW_MS = 120000;
export const RECENCY_WINDOW_MS = 600000;
/** How long an "approve and auto" record lasts before it expires */
export const MODE_SWITCH_TTL_MS = 120000;
/** If UserPromptSubmit / Stop arrives within this time after the lease expires, the decision is cancelled */
export const CANCEL_WINDOW_MS = 10000;

// ---- hook stdin (unknown keys pass through) ----

/** The agent a hook / decision comes from. Absent means "claude" */
export const AgentName = z.enum(["claude", "codex"]);
export type AgentName = z.infer<typeof AgentName>;

export const HookInputBase = z.looseObject({
  session_id: z.string(),
  transcript_path: z.string(),
  cwd: z.string(),
  scratchpad_dir: z.string().optional(),
  permission_mode: z.string().optional(),
  hook_event_name: z.string(),
  agent_id: z.string().optional(),
  agent_type: z.string().optional(),
  agent: AgentName.optional(),
});
export type HookInputBase = z.infer<typeof HookInputBase>;

export const PreToolUseInput = HookInputBase.extend({
  tool_name: z.string(),
  tool_input: z.record(z.string(), z.unknown()),
  tool_use_id: z.string(),
});
export type PreToolUseInput = z.infer<typeof PreToolUseInput>;

/** Codex PreToolUse stdin for `request_user_input` (the hook maps it to the AskUserQuestion shape). `transcript_path` is null with --ephemeral */
export const CodexRequestUserInputInput = z.looseObject({
  session_id: z.string(),
  turn_id: z.string().optional(),
  transcript_path: z.string().nullable().optional(),
  cwd: z.string(),
  hook_event_name: z.literal("PreToolUse"),
  model: z.string().optional(),
  permission_mode: z.string().optional(),
  tool_name: z.literal("request_user_input"),
  tool_input: z.looseObject({
    questions: z
      .array(
        z.looseObject({
          header: z.string().optional(),
          id: z.string().optional(),
          question: z.string(),
          isOther: z.boolean().optional(),
          options: z.array(z.looseObject({ label: z.string(), description: z.string().optional() })).optional(),
        }),
      )
      .min(1)
      .max(4),
  }),
  tool_use_id: z.string(),
});
export type CodexRequestUserInputInput = z.infer<typeof CodexRequestUserInputInput>;

export const AskUserQuestionOption = z.looseObject({
  label: z.string(),
  description: z.string().optional(),
});

export const AskUserQuestionItem = z.looseObject({
  question: z.string(),
  header: z.string(),
  options: z.array(AskUserQuestionOption),
  multiSelect: z.boolean().optional(),
});

/** tool_input of AskUserQuestion */
export const AskUserQuestionInput = z.looseObject({
  questions: z.array(AskUserQuestionItem).min(1).max(4),
});
export type AskUserQuestionInput = z.infer<typeof AskUserQuestionInput>;

/** tool_input of ExitPlanMode */
export const ExitPlanModeInput = z.looseObject({
  plan: z.string(),
  planFilePath: z.string(),
});
export type ExitPlanModeInput = z.infer<typeof ExitPlanModeInput>;

// ---- hook stdout ----

export const PreToolUseAllow = z.object({
  hookSpecificOutput: z.looseObject({
    hookEventName: z.literal("PreToolUse"),
    permissionDecision: z.literal("allow"),
    updatedInput: z.record(z.string(), z.unknown()),
  }),
});
export type PreToolUseAllow = z.infer<typeof PreToolUseAllow>;

export const PreToolUseDeny = z.object({
  hookSpecificOutput: z.looseObject({
    hookEventName: z.literal("PreToolUse"),
    permissionDecision: z.literal("deny"),
    permissionDecisionReason: z.string(),
  }),
});
export type PreToolUseDeny = z.infer<typeof PreToolUseDeny>;

export const PermissionRequestAllowSetMode = z.object({
  hookSpecificOutput: z.object({
    hookEventName: z.literal("PermissionRequest"),
    decision: z.object({
      behavior: z.literal("allow"),
      updatedPermissions: z.tuple([
        z.object({
          type: z.literal("setMode"),
          mode: z.literal("auto"),
          destination: z.literal("session"),
        }),
      ]),
    }),
  }),
});
export type PermissionRequestAllowSetMode = z.infer<typeof PermissionRequestAllowSetMode>;

export const SessionStartContext = z.object({
  hookSpecificOutput: z.object({
    hookEventName: z.enum(["SessionStart", "SubagentStart"]),
    additionalContext: z.string(),
  }),
});
export type SessionStartContext = z.infer<typeof SessionStartContext>;

// ---- Decision ----

export const DecisionKind = z.enum(["answer_question", "approve_plan"]);
export type DecisionKind = z.infer<typeof DecisionKind>;

export const DecisionStatus = z.enum([
  "pending",
  "answer_submitted",
  "answered",
  "fallback",
  "hook_disconnected",
  "answer_lost",
  "cancelled",
  "denied_explain",
]);
export type DecisionStatus = z.infer<typeof DecisionStatus>;

export const DecisionSession = z.object({
  session_id: z.string(),
  cwd: z.string(),
  transcript_path: z.string(),
  scratchpad_dir: z.string().optional(),
  permission_mode: z.string().optional(),
  agent_id: z.string().optional(),
  agent_type: z.string().optional(),
  /** Which agent the session belongs to. Absent means "claude" */
  agent: AgentName.optional(),
  title: z.string().optional(),
});
export type DecisionSession = z.infer<typeof DecisionSession>;

export const DecisionRequestBody = z.union([AskUserQuestionInput, ExitPlanModeInput]);

export const DecisionContext = z.object({
  branch: z.string().optional(),
  git_status: z.string().optional(),
  git_diff_stat: z.string().optional(),
  git_diff: z.string().optional(),
  last_assistant_text: z.string().optional(),
  recent_tools: z.array(z.object({ name: z.string(), summary: z.string() })).optional(),
  ai_title: z.string().optional(),
});
export type DecisionContext = z.infer<typeof DecisionContext>;

export const Explanation = z.object({
  path: z.string(),
  type: z.enum(["decision", "blocker"]).optional(),
  title: z.string().optional(),
  question: z.string().optional(),
  reversibility: z.enum(["reversible", "costly", "irreversible"]).optional(),
  scope: z.enum(["file", "repo", "machine", "external"]).optional(),
  markdown: z.string(),
  has: z.object({ mermaid: z.boolean(), table: z.boolean(), diff: z.boolean() }),
  match: z.enum(["question", "recency"]),
  attached_via: z.enum(["first_call", "after_deny", "none"]),
  // not_required is reserved (no path sets it; the GUI / TUI only carry display text for it)
  none_reason: z.enum(["plan_mode", "loop_guard", "not_required"]).optional(),
});
export type Explanation = z.infer<typeof Explanation>;

export const DecisionResponse = z.object({
  via: z.enum(["gui", "terminal"]),
  answers: z.record(z.string(), z.string()).optional(),
  approve: z.boolean().optional(),
  reason: z.string().optional(),
  set_mode_auto: z.boolean().optional(),
  decided_at: z.string(),
  delivered_at: z.string().optional(),
});
export type DecisionResponse = z.infer<typeof DecisionResponse>;

export const Decision = z.object({
  id: z.string(),
  kind: DecisionKind,
  tool_use_id: z.string(),
  session: DecisionSession,
  request: DecisionRequestBody,
  context: DecisionContext,
  explanation: Explanation.optional(),
  first_denied_at: z.string().optional(),
  /** Only for denied_explain. The MissingCode of the deny reason (spec explain.md section 4) */
  missing: z.array(z.string()).optional(),
  status: DecisionStatus,
  lease_until: z.string().optional(),
  created_at: z.string(),
  response: DecisionResponse.optional(),
});
export type Decision = z.infer<typeof Decision>;

// ---- API input / output ----

/** What the hook sends to POST /api/decisions (the server gathers the context) */
export const CreateDecisionRequest = z.object({
  tool_use_id: z.string(),
  kind: DecisionKind,
  session: DecisionSession,
  request: DecisionRequestBody,
  explanation: Explanation.optional(),
  /** `denied_explain` only when recording a deny without an explanation (not shown in the GUI) */
  status: z.literal("denied_explain").optional(),
  /** Only for denied_explain. The MissingCode of the deny reason */
  missing: z.array(z.string()).optional(),
});
export type CreateDecisionRequest = z.infer<typeof CreateDecisionRequest>;

/** POST /api/decisions/:id/answer. Strict so that the key sets are mutually exclusive */
export const AnswerRequest = z.union([
  z.strictObject({ answers: z.record(z.string(), z.string()) }),
  z.strictObject({ approve: z.literal(true), set_mode_auto: z.boolean().optional() }),
  z.strictObject({ approve: z.literal(false), reason: z.string().min(1) }),
  z.strictObject({ fallback: z.literal(true) }),
]);
export type AnswerRequest = z.infer<typeof AnswerRequest>;

/** Body of a 200 from GET /api/decisions/:id/wait (204 has no body) */
export const WaitResponse = z.object({
  response: DecisionResponse,
});
export type WaitResponse = z.infer<typeof WaitResponse>;

/** POST /api/events. Raw JSON of an observing hook + receive time */
export const EventInput = HookInputBase.extend({
  received_at: z.string(),
  escaped_question: z.boolean().optional(),
  blocker_detected: z.boolean().optional(),
  observe: z.object({ phase: z.enum(["start", "end"]) }).optional(),
});
export type EventInput = z.infer<typeof EventInput>;

export const SessionState = z.enum(["working", "waiting_decision", "idle", "ended"]);
export type SessionState = z.infer<typeof SessionState>;

export const SessionSummary = z.object({
  session_id: z.string(),
  state: SessionState,
  last_event_at: z.string(),
  title: z.string().optional(),
  cwd: z.string(),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

const DurationStat = z.object({
  count: z.number().int().nonnegative(),
  median_ms: z.number().nullable(),
  mean_ms: z.number().nullable(),
});

/** GET /api/metrics. Metrics (a')(b)(d) from plan section 2, plus the auxiliary metric (c) */
export const Metrics = z.object({
  // (a') GUI answer rate. Numerator = answered, denominator = total (answered + the other 5 kinds)
  a: z.object({
    answered: z.number().int().nonnegative(),
    fallback: z.number().int().nonnegative(),
    hook_disconnected: z.number().int().nonnegative(),
    answer_lost: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
    escaped_question: z.number().int().nonnegative(),
    // Number of times Stop detected blocker vocabulary. Not included in the denominator (total)
    blocker_detected: z.number().int().nonnegative(),
    // Answers of the form "Cannot answer — ...". Counted among answers, not an extra term of total
    cannot_answer: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    rate: z.number().nullable(),
  }),
  // (b) Time per decision. human = created_at → decided_at, agent = first_denied_at → created_at
  b: z.object({
    human: DurationStat,
    agent: DurationStat,
    baseline: DurationStat,
  }),
  // (c) Auxiliary: number of times the GUI session list was opened
  c: z.object({ session_panel_opens: z.number().int().nonnegative() }),
  // (d) Explanation attachment. plan_mode decisions are excluded from total
  d: z.object({
    first_call: z.number().int().nonnegative(),
    after_deny: z.number().int().nonnegative(),
    none: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    attach_rate: z.number().nullable(),
  }),
});
export type Metrics = z.infer<typeof Metrics>;

/** GET /api/sessions/:id/pending-mode-switch */
export const PendingModeSwitch = z.union([
  z.object({ pending: z.literal(false) }),
  z.object({ pending: z.literal(true), set_at: z.string(), expires_at: z.string() }),
]);
export type PendingModeSwitch = z.infer<typeof PendingModeSwitch>;

/** POST /api/sessions/:id/pending-mode-switch/consume. True if there was an unconsumed record */
export const ConsumeModeSwitchResponse = z.object({ consumed: z.boolean() });
export type ConsumeModeSwitchResponse = z.infer<typeof ConsumeModeSwitchResponse>;

// ---- "Cannot answer" ----

/** The human could not read the explanation. Always English, whatever the display language: `Cannot answer — <reason>[: <detail>]` */
export const CANNOT_PREFIX = "Cannot answer — ";
export const CANNOT_REASONS = ["Undefined terms", "Unclear", "Too much at once"] as const;
export type CannotReason = (typeof CANNOT_REASONS)[number];

export interface CannotAnswer {
  reason: CannotReason;
  /** Undefined terms only: the words the human did not know (comma-separated in the answer) */
  terms: string[];
  /** The free-text detail (for Undefined terms, the raw comma-separated list); may be empty */
  text: string;
}

/** Parses an answer value. null when it is not a Cannot answer (an unknown reason is not one either) */
export function parseCannotAnswer(answer: string): CannotAnswer | null {
  if (!answer.startsWith(CANNOT_PREFIX)) return null;
  const rest = answer.slice(CANNOT_PREFIX.length);
  const reason = CANNOT_REASONS.find((r) => rest === r || rest.startsWith(r + ":"));
  if (!reason) return null;
  const text = rest.slice(reason.length).replace(/^:\s*/, "").trim();
  const terms = reason === "Undefined terms" ? text.split(/[,、，]/).map((t) => t.trim()).filter((t) => t !== "") : [];
  return { reason, terms, text };
}

/** SHA-256 (hex) of an explanation without its front matter (CRLF normalized, trimmed). Server and hook must agree */
export function bodyHash(markdown: string): string {
  const body = markdown.replace(/\r\n?/g, "\n").replace(/^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/, "").trim();
  return createHash("sha256").update(body).digest("hex");
}

/** The last Cannot answer of a session, kept until an explanation passes the hook */
export const PendingRewrite = z
  .object({
    question: z.string(),
    reason: z.enum(CANNOT_REASONS),
    terms: z.array(z.string()),
    body_hash: z.string(),
    at: z.number(),
  })
  .nullable();
export type PendingRewrite = z.infer<typeof PendingRewrite>;

/** POST /api/sessions/:id/pending-rewrite/consume (GET /api/sessions/:id/pending-rewrite returns a PendingRewrite as is) */
export const ConsumeRewriteResponse = z.object({ consumed: z.boolean() });

// ---- State transitions ----

const TRANSITIONS: Record<DecisionStatus, readonly DecisionStatus[]> = {
  pending: ["answer_submitted", "fallback", "hook_disconnected", "cancelled"],
  answer_submitted: ["answered", "answer_lost"],
  hook_disconnected: ["cancelled"],
  answered: [],
  fallback: [],
  answer_lost: [],
  cancelled: [],
  denied_explain: [],
};

export function canTransition(from: DecisionStatus, to: DecisionStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

// ---- Path validation ----

/** Resolve to a real path. For a non-existent tail, resolve the deepest existing ancestor and re-append the rest */
function realish(p: string): string {
  const abs = resolve(p);
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs;
      rest.unshift(basename(cur));
      cur = parent;
    }
  }
}

function isUnder(p: string, base: string): boolean {
  if (!isAbsolute(p)) return false;
  const target = realish(p);
  const root = realish(base);
  return target.startsWith(root.endsWith(sep) ? root : root + sep);
}

export function isAllowedTranscriptPath(p: string, home: string): boolean {
  return isUnder(p, join(home, ".claude", "projects")) || isUnder(p, join(home, ".codex", "sessions"));
}

export function isAllowedExplanationPath(p: string, scratchpadDir: string | undefined, home: string, dataDir?: string): boolean {
  if (scratchpadDir && isUnder(p, join(scratchpadDir, "ukagai"))) return true;
  // The hook falls back to <data-dir>/explain/<session_id>/ (always so for Codex, which has no scratchpad)
  if (dataDir && isUnder(p, join(dataDir, "explain"))) return true;
  return isUnder(p, join(home, ".ukagai", "explain"));
}

// ---- GET /api/decisions/:id/history ----

export const HistoryEntry = z.object({
  /** ISO timestamp of the human instruction (empty string if the transcript line had none) */
  at: z.string(),
  text: z.string(),
});
export type HistoryEntry = z.infer<typeof HistoryEntry>;

export const SessionHistory = z.object({
  session_id: z.string(),
  ai_title: z.string().optional(),
  /** Number of human instructions in the transcript */
  total: z.number().int().nonnegative(),
  /** The first instruction (max 4000 chars, cut with a trailing …). null if none or unreadable */
  first: HistoryEntry.nullable(),
  /** The last 20 instructions in chronological order (max 500 chars each). May overlap `first` */
  recent: z.array(HistoryEntry),
});
export type SessionHistory = z.infer<typeof SessionHistory>;
