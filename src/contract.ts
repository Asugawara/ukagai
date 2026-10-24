import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { z } from "zod";

// ---- Constants ----

/** Separator for multiSelect answer values. Provisional until confirmed by the E2 result. */
export const MULTI_SELECT_SEPARATOR = ", ";
export const POLL_TIMEOUT_MS = 25000;
export const LEASE_GRACE_MS = 10000;
/** After a hand-off the agent re-calls the tool within seconds: the lease is armed for this long */
export const HANDOFF_GRACE_MS = 120000;
export const DENY_LINK_WINDOW_MS = 120000;
export const RECENCY_WINDOW_MS = 600000;
/** If UserPromptSubmit / Stop arrives within this time after the lease expires, the decision is cancelled */
export const CANCEL_WINDOW_MS = 10000;
/** A checkpoint nobody answered expires after this long */
export const CHECKPOINT_TTL_MS = 12 * 3600 * 1000;

// ---- Message delivery (the ukagai mod): see docs/spec/api.md "Message delivery" ----

/** The mod's tick interval */
export const MOD_POLL_MS = 1000;
/** The longest interval between the mod's requests while they fail (1 -> 2 -> 4 -> 5 s) */
export const MOD_BACKOFF_MAX_MS = 5000;
/** A mod that polled a session this recently can deliver to it: decisions are registered for message delivery, tools are held back */
export const MOD_FRESH_MS = 15_000;
/** A decision's owner that was last seen longer ago than this is gone: another owner of the session takes its items over */
export const MOD_CLAIM_STALE_MS = 30_000;
/** After a SessionEnd, an owner that polled the session within this time keeps its decisions open */
export const MOD_END_GRACE_MS = 10_000;
/** No owner polled the session for this long: the decision is flagged `no_agent` */
export const MOD_GONE_MS = 120_000;
/** A message-delivery decision nobody could deliver expires after this long (from `created_at`) */
export const MESSAGE_TTL_MS = 12 * 3600 * 1000;
/** Drops of a delivery before it is given up */
export const DELIVERY_MAX_ATTEMPTS = 5;
/** An approval of a plan lets the same plan through once (a re-called ExitPlanMode, or the PermissionRequest of "approve and auto"), never longer than this after the human decided (the outer bound of the limits below) */
export const PLAN_GRANT_TTL_MS = 12 * 3600 * 1000;
/**
 * A plan approved for message delivery is let through only by a re-call this soon after the approval was delivered (before delivery: after
 * the human decided). The approval message says "call ExitPlanMode once more" and the agent does at once; a grant left over after that
 * (the re-call never reached the server, Claude Code's own dialog asked and the human may have said no) must not pass the plan hours later.
 * An approval still undelivered past it is not delivered any more ("it will be allowed" would be wrong): the plan goes back to the human
 */
export const PLAN_GRANT_RECALL_MS = 10 * 60 * 1000;
/**
 * An "approve and auto" grant handed to the PermissionRequest of one ExitPlanMode (the PreToolUse printed nothing) lasts this long from then.
 * That hook runs right after the PreToolUse (its own timeout is 10 s); the slack is for a slow process start under load. A grant it did not
 * use (the server was out of reach, Claude Code's dialog asked and the human may have said no) must not let the same plan through later
 */
export const PLAN_GRANT_HAND_WINDOW_MS = 60 * 1000;
/** Characters of the decision id in a delivery text's ref */
export const DELIVERY_REF_LEN = 8;
/** The mod's identifier of one Claude Code process (`UKAGAI_MOD_OWNER`) */
export const MOD_OWNER_RE = /^[0-9a-f]{16}$/;
/** Leads every delivery text: `[ukagai] (ref a1b2c3d4) `. Group 1 is the ref */
export const DELIVERY_REF_RE = /^\[ukagai\] \(ref ([0-9a-f]{8})\) /;

/** The ref of a decision: the first characters of its id */
export function deliveryRef(decisionId: string): string {
  return decisionId.slice(0, DELIVERY_REF_LEN);
}

/** The ref a prompt starts with, or undefined */
export function parseDeliveryRef(text: string): string | undefined {
  return DELIVERY_REF_RE.exec(text)?.[1];
}

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

/**
 * Identity of a question across hand-off legs: sha256 hex of the questions with their option labels
 * (descriptions and key order do not count), or of the trimmed plan text (the plan file path when the plan is empty)
 */
export function decisionFingerprint(kind: "answer_question" | "approve_plan", toolInput: Record<string, unknown>): string {
  let canonical: string;
  if (kind === "answer_question") {
    const qs = Array.isArray(toolInput["questions"]) ? (toolInput["questions"] as { question?: unknown; options?: { label?: unknown }[] }[]) : [];
    canonical = JSON.stringify(qs.map((q) => ({ question: q.question, options: (q.options ?? []).map((o) => o.label) })));
  } else {
    const plan = typeof toolInput["plan"] === "string" ? toolInput["plan"].trim() : "";
    const file = typeof toolInput["planFilePath"] === "string" ? toolInput["planFilePath"] : "";
    canonical = plan !== "" ? plan : file;
  }
  return createHash("sha256").update(canonical).digest("hex");
}

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
    /** Claude Code: the full instructions, while the reason is the one red line (Codex: absent, the reason carries them) */
    additionalContext: z.string().optional(),
  }),
});
export type PreToolUseDeny = z.infer<typeof PreToolUseDeny>;

/** PermissionRequest × ExitPlanMode: a plan the human approved with "and auto" in a message-delivery decision. Without `updatedInput` Claude Code keeps its own dialog */
export const PermissionRequestAllowExitPlan = z.object({
  hookSpecificOutput: z.object({
    hookEventName: z.literal("PermissionRequest"),
    decision: z.object({
      behavior: z.literal("allow"),
      updatedInput: z.record(z.string(), z.unknown()),
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
export type PermissionRequestAllowExitPlan = z.infer<typeof PermissionRequestAllowExitPlan>;

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

export const DecisionKind = z.enum(["answer_question", "approve_plan", "checkpoint"]);
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

/** A progress recap Claude Code wrote into the transcript (`away_summary`). Non-blocking: no hook waits on it */
export const CheckpointRequest = z.object({
  recap: z.string(),
  /** Timestamp of the recap line in the transcript */
  recap_at: z.string(),
});
export type CheckpointRequest = z.infer<typeof CheckpointRequest>;

export const DecisionRequestBody = z.union([AskUserQuestionInput, ExitPlanModeInput, CheckpointRequest]);

/** `tool_use_id` of a checkpoint (the unique index key) */
export function checkpointToolUseId(sessionId: string, recapAt: string): string {
  return `checkpoint:${sessionId}:${recapAt}`;
}

/** Identity of a checkpoint: sha256 hex of `recap_at` */
export function checkpointFingerprint(recapAt: string): string {
  return createHash("sha256").update(recapAt).digest("hex");
}

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
  type: z.enum(["decision", "blocker", "quiz"]).optional(),
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

// ---- inline comments ----

export const COMMENTS_MAX = 30;
const CommentRect = z.strictObject({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().min(1),
  h: z.number().int().min(1),
});
export const CommentSource = z.strictObject({
  kind: z.enum(["plan", "explanation", "page", "image"]),
  /** page / image: the absolute path the GUI shows (from the /api/files URL). plan / explanation: ignored, the server uses its own record */
  file: z.string().max(300).regex(/^[^\u0000-\u001f\u007f]*$/).optional(),
});
export type CommentSource = z.infer<typeof CommentSource>;
export const Comment = z
  .strictObject({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
    kind: z.enum(["text", "element", "region"]),
    source: CommentSource,
    /** heading path, outermost first */
    section: z.array(z.string().max(120)).max(6).optional(),
    /** text: the selected text (required for kind text) */
    quote: z.string().max(500).optional(),
    /** text: up to 64 chars before / after, for re-anchoring */
    prefix: z.string().max(64).optional(),
    suffix: z.string().max(64).optional(),
    /** element (or text inside a page): CSS selector in the page */
    selector: z.string().max(200).regex(/^[^\u0000-\u001f\u007f]*$/).optional(),
    tag: z.string().max(40).regex(/^[^\u0000-\u001f\u007f]*$/).optional(),
    /** element: its visible text / aria-label / alt */
    text: z.string().max(120).optional(),
    /** region: natural pixels of the image (required for kind region) */
    rect: CommentRect.optional(),
    /** region: id returned by POST /api/marks */
    mark: z.string().regex(/^[0-9a-f]{16}$/).optional(),
    /** the anchor is no longer found in the current text */
    orphan: z.boolean().optional(),
    /** what the human wrote */
    note: z.string().trim().min(1).max(1000),
  })
  .refine((c) => c.kind !== "text" || c.quote !== undefined, { message: "quote is required for kind text", path: ["quote"] })
  .refine((c) => c.kind !== "region" || c.rect !== undefined, { message: "rect is required for kind region", path: ["rect"] });
export type Comment = z.infer<typeof Comment>;
export const Comments = z.array(Comment).min(1).max(COMMENTS_MAX);
export type Comments = z.infer<typeof Comments>;

/**
 * How an answered decision or checkpoint reached the agent: the PreToolUse hook, typed into its terminal, the Codex bridge, nothing to do
 * (stop of an idle agent), a message the ukagai mod submitted, or (a plan approved for message delivery) the re-called ExitPlanMode used its grant
 */
export const DeliveredVia = z.enum(["hook", "terminal", "bridge", "noop", "message", "grant"]);
export type DeliveredVia = z.infer<typeof DeliveredVia>;

export const DecisionResponse = z.object({
  via: z.enum(["gui", "terminal"]),
  answers: z.record(z.string(), z.string()).optional(),
  approve: z.boolean().optional(),
  reason: z.string().optional(),
  set_mode_auto: z.boolean().optional(),
  /** approve_plan only: the human asks the agent to do `text` before the plan is approved (`approve` is absent) */
  instruct: z.literal(true).optional(),
  /** checkpoint only (see CheckpointResponse) */
  kind: z.enum(["continue", "instruct", "stop"]).optional(),
  /** the instruction of a checkpoint `instruct` or of an approve_plan `instruct` */
  text: z.string().optional(),
  /** the inline comments the human sent with the answer (their text is already appended to the fields above) */
  comments: Comments.optional(),
  decided_at: z.string(),
  /** For a checkpoint: when its instruction was handed to the agent */
  delivered_at: z.string().optional(),
  delivered_via: DeliveredVia.optional(),
});
export type DecisionResponse = z.infer<typeof DecisionResponse>;

/** The response of an answered checkpoint (`text` is required for `instruct`, optional for `stop`) */
export const CheckpointResponse = z.object({
  via: z.enum(["gui", "terminal"]),
  kind: z.enum(["continue", "instruct", "stop"]),
  text: z.string().optional(),
  decided_at: z.string(),
  delivered_at: z.string().optional(),
  delivered_via: DeliveredVia.optional(),
});
export type CheckpointResponse = z.infer<typeof CheckpointResponse>;

/** What the human told the agent through a checkpoint, waiting for the agent's next tool call (one per session, newest wins) */
export const Instruction = z.object({
  /** "" for a plan instruction (no decision behind it) */
  decision_id: z.string(),
  kind: z.enum(["instruct", "stop"]),
  text: z.string(),
  created_at: z.string(),
  /** `plan`: sent from a plan file card while the agent is still writing the plan (the hook words it differently) */
  about: z.literal("plan").optional(),
});
export type Instruction = z.infer<typeof Instruction>;

/** What holds the main agent's tools back: an async decision of its session whose answer has not reached it yet */
export const Waiting = z.object({ decision_id: z.string(), kind: z.enum(["answer_question", "approve_plan"]) });
export type Waiting = z.infer<typeof Waiting>;

/** Body of a 200 from GET /api/sessions/:id/instruction (404 when there is neither). `waiting` only for `?main=1` */
export const InstructionResponse = z.union([z.object({ instruction: Instruction }), z.object({ waiting: Waiting })]);
export type InstructionResponse = z.infer<typeof InstructionResponse>;


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
  /** Why the decision was closed without an answer (`answered_elsewhere` when the codex-bridge saw the terminal move first) */
  status_reason: z.string().optional(),
  lease_until: z.string().optional(),
  created_at: z.string(),
  response: DecisionResponse.optional(),
  /** decisionFingerprint of the request: how a re-called tool finds its still-open decision */
  fingerprint: z.string().optional(),
  /** approve_plan only: basename of the plan file inside the plans directory (resolved once at create; absent when the path is outside it) */
  plan_name: z.string().optional(),
  /** Number of hand-off cycles (the hook's budget ended and the agent was asked to call the tool again) */
  handoffs: z.number().int().nonnegative().optional(),
  /** `tool_use_id` is the current one; the ones before a re-attach are kept here */
  previous_tool_use_ids: z.array(z.string()).optional(),
  /** `message`: registered for message delivery (no hook waits; the ukagai mod delivers the answer). Removed when the decision is switched back to the long-poll */
  delivery: z.literal("message").optional(),
  /** message delivery: the mod (`UKAGAI_MOD_OWNER`) that owns the delivery; the one that took it over after a reload */
  mod_owner: z.string().optional(),
  /** message delivery: the mod that took the answer to submit it. `offset` is the transcript size at that moment */
  claim: z.object({ owner: z.string(), at: z.string(), offset: z.number().int().nonnegative() }).optional(),
  /** message delivery: a prompt carrying this decision's ref reached the hook. A record only: it does not mean the answer was delivered */
  ref_seen_at: z.string().optional(),
  /** message delivery: the human typed in the terminal while the answer was waiting */
  human_prompt_at: z.string().optional(),
  /** message delivery: the decision must close as soon as the claim ends (a `status_reason`) */
  close_reason: z.string().optional(),
  /** message delivery: drops of the delivery so far */
  delivery_attempts: z.number().int().nonnegative().optional(),
  /** message delivery: the reason of the last drop */
  delivery_note: z.string().optional(),
  /** `no_agent` (message delivery) = no mod has polled the session for MOD_GONE_MS; `auto_not_applied` = the plan was approved with auto mode, but ExitPlanMode went through without ukagai switching the mode */
  delivery_flag: z.enum(["no_agent", "auto_not_applied"]).optional(),
  /** approve_plan: the approval's one-time pass for the same plan (the grant) was used or revoked */
  grant_used_at: z.string().optional(),
  /** approve_plan, "approve and auto": the grant was handed to the PermissionRequest of one ExitPlanMode (once only; PLAN_GRANT_HAND_WINDOW_MS) */
  grant_handed_at: z.string().optional(),
});
export type Decision = z.infer<typeof Decision>;

/** Body of a 200 from GET /api/sessions/:id/plan-grant: the human approved this plan (`mode: "auto"` = and asked for auto mode) and it was not let through yet */
export const PlanGrant = z.object({ decision_id: z.string(), mode: z.literal("auto").optional() });
export type PlanGrant = z.infer<typeof PlanGrant>;
export type PlanGrantResponse = { grant: PlanGrant };

/** POST /api/sessions/:id/plan-grant/consume */
export const ConsumePlanGrantRequest = z.object({ fingerprint: z.string().regex(/^[0-9a-f]{64}$/) });
export type ConsumePlanGrantRequest = z.infer<typeof ConsumePlanGrantRequest>;
export const ConsumePlanGrantResponse = z.union([
  z.object({ consumed: z.literal(true), mode: z.literal("auto").optional() }),
  z.object({ consumed: z.literal(false) }),
]);
export type ConsumePlanGrantResponse = z.infer<typeof ConsumePlanGrantResponse>;
/** POST /api/sessions/:id/plan-grant/hand (body: ConsumePlanGrantRequest). `handed: false` = no auto grant, or it was handed before and is now written off */
export const HandPlanGrantResponse = z.object({ handed: z.boolean() });
export type HandPlanGrantResponse = z.infer<typeof HandPlanGrantResponse>;

/** POST /api/decisions/:id/ack (the waiting hook). `keep_plan_grant`: an "approve and auto" grant is left to the PermissionRequest of the same ExitPlanMode */
export const DecisionAckRequest = z.object({ keep_plan_grant: z.literal(true).optional() });
export type DecisionAckRequest = z.infer<typeof DecisionAckRequest>;

/** Body of a 200 from GET /api/sessions/:id/open: the open decision to re-attach to, or one a live mod is delivering right now */
export type OpenResponse = { decision: Decision } | { delivering: { decision_id: string } };

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
  /** The hook's `UKAGAI_MOD_OWNER`: asks for message delivery (the server decides; a malformed value counts as absent) */
  mod_owner: z.string().optional(),
});
export type CreateDecisionRequest = z.infer<typeof CreateDecisionRequest>;

export const INSTRUCTION_MAX_CHARS = 4000;

/** Leads the text of an instruction sent from a plan file card (the hook's context and the terminal line) */
export const PLAN_INSTRUCT_PREFIX = "[ukagai] About the plan you are writing:";

const InstructText = z.string().trim().min(1).max(INSTRUCTION_MAX_CHARS);

/** POST /api/plans/:name/instruct: `text`, `comments`, or both */
export const PlanInstructRequest = z
  .strictObject({ text: InstructText.optional(), comments: Comments.optional() })
  .refine((b) => b.text !== undefined || b.comments !== undefined, { message: "text or comments is required", path: ["text"] });
export type PlanInstructRequest = z.infer<typeof PlanInstructRequest>;

/** POST /api/decisions/:id/answer. Strict so that the key sets are mutually exclusive */
export const AnswerRequest = z.union([
  // checkpoint: `text` is required for instruct; `via` / `decided_at` of the CheckpointResponse shape are accepted and ignored (the server sets them)
  z
    .strictObject({
      kind: z.enum(["continue", "instruct", "stop"]),
      text: z.string().optional(),
      via: z.enum(["gui", "terminal"]).optional(),
      decided_at: z.string().optional(),
    })
    .refine((b) => b.kind !== "instruct" || (b.text ?? "").trim() !== "", { message: "text is required for instruct", path: ["text"] }),
  z.strictObject({ answers: z.record(z.string(), z.string()), comments: Comments.optional() }),
  z.strictObject({ approve: z.literal(true), set_mode_auto: z.boolean().optional() }),
  z.strictObject({ approve: z.literal(false), reason: z.string().optional(), comments: Comments.optional() }),
  // approve_plan only (the route rejects it for other kinds): do `text` / the comments first, the plan stays unapproved
  z
    .strictObject({ instruct: z.literal(true), text: InstructText.optional(), comments: Comments.optional() })
    .refine((b) => b.text !== undefined || b.comments !== undefined, { message: "text or comments is required", path: ["text"] }),
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
  /** UserPromptSubmit only: the prompt was a harness wake-up (task-notification), not typed by a human */
  wakeup: z.boolean().optional(),
  /** UserPromptSubmit only: the ref of a delivery text the prompt started with (the prompt text itself is never sent) */
  delivered_ref: z.string().regex(/^[0-9a-f]{8}$/).optional(),
  blocker_detected: z.boolean().optional(),
  observe: z.object({ phase: z.enum(["start", "end"]) }).optional(),
});
export type EventInput = z.infer<typeof EventInput>;

// ---- Message delivery: the mod's inbox (POST /api/sessions/:id/inbox/<poll|ack|release>) ----

export const PollRequest = z.object({ owner: z.string().regex(MOD_OWNER_RE), idle: z.boolean() });
export type PollRequest = z.infer<typeof PollRequest>;
/** 200 from poll: `held` = this owner is delivering that item already; `item` = one was handed over. 204 (no body) when there is nothing */
export type PollResponse = { held: { item_id: string } } | { item: { item_id: string; text: string } };

export const AckRequest = z.object({ owner: z.string().regex(MOD_OWNER_RE), item_id: z.string().min(1).max(100) });
export type AckRequest = z.infer<typeof AckRequest>;

export const ReleaseRequest = z.object({
  owner: z.string().regex(MOD_OWNER_RE),
  item_id: z.string().min(1).max(100),
  /** Why `$.prompt.submit` dropped the prompt; absent when it threw (the server then counts a failed attempt after checking the transcript) */
  drop: z.string().min(1).max(500).optional(),
});
export type ReleaseRequest = z.infer<typeof ReleaseRequest>;
/** 200 / 409 from ack and release */
export type InboxStatusResponse = { status: DecisionStatus };

export const SessionState = z.enum(["working", "waiting_decision", "idle", "ended"]);
export type SessionState = z.infer<typeof SessionState>;

export const SessionSummary = z.object({
  session_id: z.string(),
  state: SessionState,
  last_event_at: z.string(),
  title: z.string().optional(),
  cwd: z.string(),
  /** From the hook events (absent for Codex --ephemeral and before the first event) */
  transcript_path: z.string().optional(),
  /** Where a checkpoint reply can be typed into the agent's terminal, e.g. "herdr:w1:p1" */
  terminal: z.string().optional(),
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
    // Historical only: the Stop detector was removed, so nothing emits blocker_detected any more. Not included in the denominator (total)
    blocker_detected: z.number().int().nonnegative(),
    // Hand-off cycles (sum of Decision.handoffs) and how many times an open decision was re-attached
    handoffs: z.number().int().nonnegative(),
    reattached: z.number().int().nonnegative(),
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
  c: z.object({
    session_panel_opens: z.number().int().nonnegative(),
    // Progress checkpoints (excluded from a.total and d)
    checkpoints: z.object({
      created: z.number().int().nonnegative(),
      answered: z.number().int().nonnegative(),
      delivered: z.number().int().nonnegative(),
    }),
  }),
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
  // only the first line counts: an inline-comment block may follow after a newline
  const first = answer.split("\n", 1)[0] ?? "";
  if (!first.startsWith(CANNOT_PREFIX)) return null;
  const rest = first.slice(CANNOT_PREFIX.length);
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
  hook_disconnected: ["pending", "cancelled"],
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

/** The directory Claude Code writes plan files to */
export function plansDir(home: string): string {
  return join(home, ".claude", "plans");
}

/** A basename only: no separators, no "..", no leading dot, no NUL */
export function isPlanName(name: string): boolean {
  return name !== "" && !/[/\\\0]/.test(name) && !name.includes("..") && !name.startsWith(".");
}

/** A name the plans API lists and the hook accepts: `*.md` and a plain basename */
export function isPlanFile(name: string): boolean {
  return name.endsWith(".md") && isPlanName(name);
}

/** realpath of `p` if it is an existing regular file under `root` (both realpath'd), else null */
export function realFileUnder(root: string, p: string): string | null {
  try {
    const real = realpathSync(p);
    if (!isUnder(real, root) || !statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

/** Largest transcript tail that is read (history reader and the hook's plan-file lookup) */
export const TRANSCRIPT_MAX_BYTES = 64 * 1024 * 1024;

/** A Claude Code transcript (the recap watcher reads these only) */
export function isClaudeTranscriptPath(p: string, home: string): boolean {
  return isUnder(p, join(home, ".claude", "projects"));
}

export function isAllowedTranscriptPath(p: string, home: string): boolean {
  return isUnder(p, join(home, ".claude", "projects")) || isUnder(p, join(home, ".codex", "sessions"));
}

/** `explanation.path` of a plan-mode explanation is the plan file path plus this suffix */
export const PLAN_BLOCK_SUFFIX = "#ukagai-explain";

export function isAllowedExplanationPath(p: string, scratchpadDir: string | undefined, home: string, dataDir?: string): boolean {
  if (scratchpadDir && isUnder(p, join(scratchpadDir, "ukagai"))) return true;
  // The hook falls back to <data-dir>/explain/<session_id>/ (always so for Codex, which has no scratchpad)
  if (dataDir && isUnder(p, join(dataDir, "explain"))) return true;
  // Plan mode: the explanation is a block inside the plan file (`<plan file>#ukagai-explain`); the plans directory is configurable, so any *.md under home
  if (p.endsWith(PLAN_BLOCK_SUFFIX)) {
    const file = p.slice(0, -PLAN_BLOCK_SUFFIX.length);
    return file.endsWith(".md") && isUnder(file, home);
  }
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

// ---- GET /api/plans, GET /api/plans/:name ----

export const PlanSummary = z.object({
  /** File name including `.md` (the `:name` of GET /api/plans/:name) */
  name: z.string(),
  /** First H1 of the file, or `name` if there is none */
  title: z.string(),
  /** File mtime, ISO */
  mtime: z.string(),
  bytes: z.number().int().nonnegative(),
  /** Number of H2 headings */
  sections: z.number().int().nonnegative(),
  lines: z.number().int().nonnegative(),
  /** The stored read mark equals the current `mtime` (see POST /api/plans/:name/read) */
  read: z.boolean(),
  /** The file has the `Steps` (a list item) and `Verification` (a task item) sections ukagai's plan-writing rules ask for; `ready` needs it only for a session that was handed those rules */
  format_ok: z.boolean(),
  /** Worth showing to the human now: its session known, not working, not asking in the terminal, with no decision pending and (when the session got ukagai's plan rules) format_ok. Computed by the server */
  ready: z.boolean(),
  /** The live Claude Code session writing this plan (the plan file is named after its slug); absent when none is found */
  session_id: z.string().optional(),
});
export type PlanSummary = z.infer<typeof PlanSummary>;

export const PlanContent = z.object({
  name: z.string(),
  title: z.string(),
  mtime: z.string(),
  markdown: z.string(),
  read: z.boolean(),
  format_ok: z.boolean(),
  ready: z.boolean(),
  session_id: z.string().optional(),
});
export type PlanContent = z.infer<typeof PlanContent>;

/** SSE `plan.updated` */
export const PlanEvent = PlanSummary;
export type PlanEvent = PlanSummary;

/** SSE `plan.removed` */
export const PlanRemovedEvent = z.object({ name: z.string() });
export type PlanRemovedEvent = z.infer<typeof PlanRemovedEvent>;

/** POST /api/plans/:name/read */
export const PlanReadRequest = z.object({ mtime: z.string().min(1) });
export type PlanReadRequest = z.infer<typeof PlanReadRequest>;

// ---- plan-mode explanation blocks (inside the plan file) ----

export const EXPLAIN_BLOCK_OPEN = "<!-- ukagai-explain -->";
export const EXPLAIN_BLOCK_CLOSE = "<!-- /ukagai-explain -->";

/** One terminated block on its own lines; the body may not contain another opening marker, so an unterminated block is never matched */
function explainBlockRe(): RegExp {
  return /^[ \t]*<!-- ukagai-explain -->[ \t]*\r?\n((?:(?!<!-- ukagai-explain -->)[\s\S])*?)^[ \t]*<!-- \/ukagai-explain -->[ \t]*(?:\r?\n|$)/gm;
}

/** The text between the markers of every terminated block, trimmed */
export function extractExplainBlocks(markdown: string): { question: string | undefined; body: string }[] {
  const out: { question: string | undefined; body: string }[] = [];
  for (const m of markdown.matchAll(explainBlockRe())) {
    const body = m[1]!.trim();
    const fm = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body);
    let question: string | undefined;
    if (fm) {
      const q = /^question:[ \t]*(.*?)[ \t]*$/m.exec(fm[1]!);
      if (q) question = q[1]!.replace(/^(["'])(.*)\1$/, "$2");
    }
    out.push({ question, body });
  }
  return out;
}

/** The plan without its ukagai-explain blocks; everything outside the blocks stays byte-identical */
export function stripExplainBlocks(markdown: string): string {
  return markdown.includes(EXPLAIN_BLOCK_OPEN) ? markdown.replace(explainBlockRe(), "") : markdown;
}

// ---- Settings (<data-dir>/config.json, GET / PUT /api/settings) ----

export const CODEX_DELAY_MIN_S = 30;
export const CODEX_DELAY_MAX_S = 3600;
export const INSTRUCTION_PRESETS_MAX = 10;
export const INSTRUCTION_PRESET_MAX_CHARS = 300;

export const DEFAULT_CLAUDE_SETTINGS = { message_delivery: true };

export const Settings = z.object({
  /** Display language of the GUI / TUI (and the language the agent writes explanations in) */
  lang: z.enum(["en", "ja"]),
  theme: z.enum(["system", "light", "dark"]),
  /** false hides the bottom hint line of the GUI */
  hints: z.boolean(),
  checkpoints: z.object({
    /** false: nothing creates a progress checkpoint (recap watcher, Codex bridge) */
    enabled: z.boolean(),
    /** Quiet time after a completed Codex turn before its checkpoint (read at arm time) */
    codex_delay_s: z.number().int().min(CODEX_DELAY_MIN_S).max(CODEX_DELAY_MAX_S),
    /** false: a reply is never typed into a herdr pane; it waits for the agent's next tool call */
    terminal_delivery: z.boolean(),
  }),
  plans: z.object({
    /** false: new plan files neither pop up nor count in Pending (still in the drawer list) */
    auto_show: z.boolean(),
    /** One-click chips on plan cards: trimmed, blank lines dropped, then at most 10 of 1-300 characters */
    instruction_presets: z
      .array(z.string())
      .transform((a) => a.map((t) => t.trim()).filter((t) => t !== ""))
      .pipe(z.array(z.string().max(INSTRUCTION_PRESET_MAX_CHARS)).max(INSTRUCTION_PRESETS_MAX))
      .default([]),
  }),
  notify: z.object({
    sound: z.boolean(),
    browser: z.boolean(),
    title_badge: z.boolean(),
  }),
  claude: z
    .object({
      /** false: answers are never delivered as messages by the ukagai mod; the hook waits for them (long-poll) */
      message_delivery: z.boolean(),
    })
    .default(DEFAULT_CLAUDE_SETTINGS),
});
export type Settings = z.infer<typeof Settings>;

export const DEFAULT_SETTINGS: Settings = {
  lang: "en",
  theme: "system",
  hints: true,
  checkpoints: { enabled: true, codex_delay_s: 180, terminal_delivery: true },
  plans: { auto_show: false, instruction_presets: [] },
  notify: { sound: false, browser: false, title_badge: true },
  claude: DEFAULT_CLAUDE_SETTINGS,
};

// ---- The user's version of the skill (GET / PUT / DELETE /api/skill) ----

/** PUT /api/skill: the whole text, at most this many UTF-8 bytes */
export const SKILL_MAX_BYTES = 256 * 1024;
export const SkillPut = z.object({
  text: z
    .string()
    .refine((t) => t.trim() !== "", "text must not be empty")
    .refine((t) => Buffer.byteLength(t, "utf8") <= SKILL_MAX_BYTES, `text must be at most ${SKILL_MAX_BYTES} bytes`),
});

/** What /api/skill returns, and what SSE `skill.updated` carries */
export type SkillView = {
  /** The shipped text; null when it cannot be read (the GUI shows an error and does not edit) */
  default: string | null;
  /** The user's version; null when there is none */
  custom: string | null;
  /** The default has changed since the user started editing */
  stale: boolean;
  /** The ukagai version the user's version started from */
  baseVersion: string | null;
  /** Where the user's version is (or would be) kept: <data-dir>/skill/SKILL.md; absent when the server has no data directory */
  path?: string;
  /** Line diff, default → (custom ?? default); empty when the default is unreadable or the text is too big to diff */
  diff: DiffLine[];
  /** Added + removed lines of `diff` */
  changed: number;
};

// ---- plan versions (GET /api/sessions/:id/plan-versions) ----

export const PlanInstruction = z.object({
  text: z.string(),
  kind: z.enum(["instruct", "reject"]),
  comments: Comments.optional(),
  at: z.string(),
});
export type PlanInstruction = z.infer<typeof PlanInstruction>;

/** One version of a session's plan; `instruction` is what the human sent after this version (what led to the next one) */
export const PlanVersion = z.object({
  /** 1-based, in `at` order */
  n: z.number().int().positive(),
  at: z.string(),
  source: z.enum(["approval", "file"]),
  decision_id: z.string().optional(),
  plan: z.string(),
  instruction: PlanInstruction.optional(),
  /** The version the client shows (not stored: appended by the server) */
  current: z.literal(true).optional(),
});
export type PlanVersion = z.infer<typeof PlanVersion>;

export const DiffLine = z.object({ kind: z.enum(["same", "add", "del"]), text: z.string() });
export type DiffLine = z.infer<typeof DiffLine>;
export const SectionStatus = z.enum(["same", "added", "removed", "changed"]);
export type SectionStatus = z.infer<typeof SectionStatus>;
export const SectionDiff = z.object({
  /** "" for the text before the first H2 */
  heading: z.string(),
  status: SectionStatus,
  /** changed: the line diff */
  lines: z.array(DiffLine).optional(),
  /** removed: the old lines */
  old_lines: z.array(z.string()).optional(),
  /** added: the new lines */
  new_lines: z.array(z.string()).optional(),
});
export type SectionDiff = z.infer<typeof SectionDiff>;
export const PlanDiff = z.object({
  sections: z.array(SectionDiff),
  summary: z.object({
    added: z.number().int().nonnegative(),
    changed: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    same: z.number().int().nonnegative(),
  }),
});
export type PlanDiff = z.infer<typeof PlanDiff>;

/** `diffs[i]` is the diff from `versions[i-1]` to `versions[i]` (`diffs[0]` against an empty plan) */
export const PlanVersionsResponse = z.object({ versions: z.array(PlanVersion), diffs: z.array(PlanDiff) });
export type PlanVersionsResponse = z.infer<typeof PlanVersionsResponse>;

// ---- aside (side questions to a forked, throwaway run of the agent) ----

export const ASIDE_MAX_ENTRIES = 50;

export const AsideQuote = z.strictObject({
  source: z.enum(["explanation", "plan", "option"]),
  text: z.string().min(1).max(1000),
});
export type AsideQuote = z.infer<typeof AsideQuote>;

/** What the fork did on the way: a path, a pattern or a command (200 chars at most) */
export const AsideTrace = z.strictObject({
  kind: z.enum(["read", "search", "command", "tool"]),
  label: z.string().max(200),
});
export type AsideTrace = z.infer<typeof AsideTrace>;

export const AsideUsage = z.strictObject({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_read_tokens: z.number().int().nonnegative().optional(),
  cost_usd: z.number().nonnegative().optional(),
});
export type AsideUsage = z.infer<typeof AsideUsage>;

export const AsideStatus = z.enum(["running", "done", "error", "cancelled"]);
export type AsideStatus = z.infer<typeof AsideStatus>;

export const AsideEntry = z.strictObject({
  id: z.string(),
  decision_id: z.string(),
  decision_title: z.string().optional(),
  question: z.string().min(1).max(4000),
  quote: AsideQuote.optional(),
  /** The entry this one re-asks; UIs show only the latest entry of a chain */
  regenerate_of: z.string().optional(),
  /** Markdown. Grows while running (Claude streams; Codex arrives at the end) */
  answer: z.string(),
  trace: z.array(AsideTrace),
  status: AsideStatus,
  error: z.string().optional(),
  usage: AsideUsage.optional(),
  created_at: z.string(),
  finished_at: z.string().optional(),
});
export type AsideEntry = z.infer<typeof AsideEntry>;

export const AsideThread = z.strictObject({
  session_id: z.string(),
  agent: AgentName,
  /** false: unknown session, or no cwd / rollout to fork from */
  available: z.boolean(),
  unavailable_reason: z.string().optional(),
  /** Oldest first, at most ASIDE_MAX_ENTRIES kept */
  entries: z.array(AsideEntry),
});
export type AsideThread = z.infer<typeof AsideThread>;

/** POST /api/sessions/:id/aside. With `regenerate_of` the server re-asks that entry's question and quote and ignores the two here */
export const AsideRequest = z.strictObject({
  question: z.string().min(1).max(4000),
  quote: AsideQuote.optional(),
  decision_id: z.string().min(1),
  regenerate_of: z.string().optional(),
});
export type AsideRequest = z.infer<typeof AsideRequest>;

/** SSE `aside.updated` */
export type AsideUpdated = { session_id: string; entry: AsideEntry };
