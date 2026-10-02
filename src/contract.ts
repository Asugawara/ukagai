import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { z } from "zod";

// ---- 定数 ----

/** multiSelect の answers 値の区切り。E2 の結果で確定するまで仮。 */
export const MULTI_SELECT_SEPARATOR = ", ";
export const POLL_TIMEOUT_MS = 25000;
export const LEASE_GRACE_MS = 10000;
export const DENY_LINK_WINDOW_MS = 120000;
export const RECENCY_WINDOW_MS = 600000;
/** 「承認して auto」の記録が失効するまで */
export const MODE_SWITCH_TTL_MS = 120000;
/** lease 切れからこの時間内に UserPromptSubmit / Stop が来たら cancelled */
export const CANCEL_WINDOW_MS = 10000;

// ---- hook の stdin(知らないキーは通す) ----

export const HookInputBase = z.looseObject({
  session_id: z.string(),
  transcript_path: z.string(),
  cwd: z.string(),
  scratchpad_dir: z.string().optional(),
  permission_mode: z.string().optional(),
  hook_event_name: z.string(),
  agent_id: z.string().optional(),
  agent_type: z.string().optional(),
});
export type HookInputBase = z.infer<typeof HookInputBase>;

export const PreToolUseInput = HookInputBase.extend({
  tool_name: z.string(),
  tool_input: z.record(z.string(), z.unknown()),
  tool_use_id: z.string(),
});
export type PreToolUseInput = z.infer<typeof PreToolUseInput>;

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

/** AskUserQuestion の tool_input */
export const AskUserQuestionInput = z.looseObject({
  questions: z.array(AskUserQuestionItem).min(1).max(4),
});
export type AskUserQuestionInput = z.infer<typeof AskUserQuestionInput>;

/** ExitPlanMode の tool_input */
export const ExitPlanModeInput = z.looseObject({
  plan: z.string(),
  planFilePath: z.string(),
});
export type ExitPlanModeInput = z.infer<typeof ExitPlanModeInput>;

// ---- hook の stdout ----

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
  // not_required は予約(どの経路も設定しない。GUI / TUI が表示文だけ持つ)
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
  /** denied_explain のときだけ。deny した理由の MissingCode(spec explain.md 4 節) */
  missing: z.array(z.string()).optional(),
  status: DecisionStatus,
  lease_until: z.string().optional(),
  created_at: z.string(),
  response: DecisionResponse.optional(),
});
export type Decision = z.infer<typeof Decision>;

// ---- API の入出力 ----

/** hook が POST /api/decisions に送るもの(context は server が集める) */
export const CreateDecisionRequest = z.object({
  tool_use_id: z.string(),
  kind: DecisionKind,
  session: DecisionSession,
  request: DecisionRequestBody,
  explanation: Explanation.optional(),
  /** 説明なしの deny を記録するときだけ `denied_explain`(GUI には出ない) */
  status: z.literal("denied_explain").optional(),
  /** denied_explain のときだけ。deny した理由の MissingCode */
  missing: z.array(z.string()).optional(),
});
export type CreateDecisionRequest = z.infer<typeof CreateDecisionRequest>;

/** POST /api/decisions/:id/answer。キーの組が互いに排他になるよう strict にしてある */
export const AnswerRequest = z.union([
  z.strictObject({ answers: z.record(z.string(), z.string()) }),
  z.strictObject({ approve: z.literal(true), set_mode_auto: z.boolean().optional() }),
  z.strictObject({ approve: z.literal(false), reason: z.string().min(1) }),
  z.strictObject({ fallback: z.literal(true) }),
]);
export type AnswerRequest = z.infer<typeof AnswerRequest>;

/** GET /api/decisions/:id/wait の 200 の本文(204 は本文なし) */
export const WaitResponse = z.object({
  response: DecisionResponse,
});
export type WaitResponse = z.infer<typeof WaitResponse>;

/** POST /api/events。観測 hook の生 JSON + 受信時刻 */
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

/** GET /api/metrics。計画 2 節の (a')(b)(d) と (c) の補助指標 */
export const Metrics = z.object({
  // (a') GUI 回答率。分子 = answered、分母 = total(answered + 他の 5 種)
  a: z.object({
    answered: z.number().int().nonnegative(),
    fallback: z.number().int().nonnegative(),
    hook_disconnected: z.number().int().nonnegative(),
    answer_lost: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
    escaped_question: z.number().int().nonnegative(),
    // Stop で blocker 語彙を検知した回数。分母(total)には含めない
    blocker_detected: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    rate: z.number().nullable(),
  }),
  // (b) 判断 1 件の所要時間。human = created_at → decided_at、agent = first_denied_at → created_at
  b: z.object({
    human: DurationStat,
    agent: DurationStat,
    baseline: DurationStat,
  }),
  // (c) 補助: GUI のセッション一覧を開いた回数
  c: z.object({ session_panel_opens: z.number().int().nonnegative() }),
  // (d) 説明の添付。plan_mode の判断は total から除く
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

/** POST /api/sessions/:id/pending-mode-switch/consume。未消費の記録があれば true */
export const ConsumeModeSwitchResponse = z.object({ consumed: z.boolean() });
export type ConsumeModeSwitchResponse = z.infer<typeof ConsumeModeSwitchResponse>;

// ---- 状態遷移 ----

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

// ---- パス検証 ----

/** 実パス化。存在しない末尾は、存在する最も深い祖先を実パス化して付け直す */
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
  return isUnder(p, join(home, ".claude", "projects"));
}

export function isAllowedExplanationPath(p: string, scratchpadDir: string | undefined, home: string): boolean {
  if (scratchpadDir && isUnder(p, join(scratchpadDir, "ukagai"))) return true;
  return isUnder(p, join(home, ".ukagai", "explain"));
}
