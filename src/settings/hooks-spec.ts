/** Defines in one place the hooks that install registers (table in docs/strategy/03 section 3) */

export const MANAGED_FLAG = "--managed-by";
export const MANAGED_VALUE = "ukagai";
export const STATUS_MESSAGE = "ukagai: waiting for an answer in the GUI";
export const DECISION_MATCHER = "AskUserQuestion|ExitPlanMode";
/** Tools that carry a checkpoint instruction to the agent (never the decision tools) */
export const CHECKPOINT_MATCHER = "Bash|Edit|Write|MultiEdit|NotebookEdit|Agent|Task|TodoWrite";
export const CHECKPOINT_FLAG = "--checkpoint";
/** EnterPlanMode (and the first UserPromptSubmit in plan mode) carries the plan-writing rules (docs/spec/markdown.md section 4) */
export const PLAN_CONTEXT_MATCHER = "EnterPlanMode";
export const PLAN_CONTEXT_FLAG = "--plan-context";

export interface HookCommand {
  type: "command";
  command: string;
  args: string[];
  timeout: number;
  statusMessage?: string;
  async?: boolean;
}

export interface MatcherGroup {
  matcher?: string;
  hooks: HookCommand[];
}

export interface BuildOptions {
  /** How the hook is started: `command` + `prefix` + `hook` … */
  invocation: { command: string; prefix: string[] };
  timeout: number;
  observe: boolean;
  /** If false, pass --no-autostart to the SessionStart hook. Defaults to true */
  autostart?: boolean;
  /** Common args passed to every hook (--data-dir / --server) */
  hookArgs?: string[];
}

export const HOOK_EVENTS = [
  "PreToolUse",
  "PermissionRequest",
  "SessionStart",
  "SubagentStart",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
  "PostToolUse",
  "SessionEnd",
  "Notification",
] as const;

/** Marker: args contain `--managed-by ukagai` (avoids adding unknown keys to the settings schema) */
export function isManagedHook(h: unknown): boolean {
  if (typeof h !== "object" || h === null) return false;
  const args = (h as { args?: unknown }).args;
  if (!Array.isArray(args)) return false;
  const i = args.indexOf(MANAGED_FLAG);
  return i >= 0 && args[i + 1] === MANAGED_VALUE;
}

export function buildHookEntries(opts: BuildOptions): Record<string, MatcherGroup[]> {
  const mk = (
    extra: string[],
    timeout: number,
    more: Partial<HookCommand> = {},
  ): HookCommand => ({
    type: "command",
    command: opts.invocation.command,
    args: [...opts.invocation.prefix, "hook", ...extra, ...(opts.hookArgs ?? []), MANAGED_FLAG, MANAGED_VALUE],
    timeout,
    ...more,
  });
  const group = (h: HookCommand, matcher?: string): MatcherGroup[] => [
    matcher === undefined ? { hooks: [h] } : { matcher, hooks: [h] },
  ];

  const preExtra = ["--budget", String(opts.timeout - 10), ...(opts.observe ? ["--observe"] : [])];
  const pre = mk(preExtra, opts.timeout, opts.observe ? {} : { statusMessage: STATUS_MESSAGE });
  const postMatcher = opts.observe
    ? `Edit|Write|MultiEdit|NotebookEdit|${DECISION_MATCHER}`
    : "Edit|Write|MultiEdit|NotebookEdit";
  const post = mk(opts.observe ? ["--observe"] : [], 5, { async: true });

  return {
    PreToolUse: [
      ...group(pre, DECISION_MATCHER),
      // observe mode only watches: it must not steer the agent
      ...(opts.observe ? [] : group(mk([CHECKPOINT_FLAG], 3), CHECKPOINT_MATCHER)),
      ...(opts.observe ? [] : group(mk([PLAN_CONTEXT_FLAG], 3), PLAN_CONTEXT_MATCHER)),
    ],
    PermissionRequest: group(mk([], 5)),
    SessionStart: group(mk(opts.autostart === false ? ["--no-autostart"] : [], 5)),
    SubagentStart: group(mk([], 5)),
    UserPromptSubmit: [
      ...group(mk([], 5, { async: true })),
      // plan mode entered by the human never calls EnterPlanMode: the first prompt typed in plan mode carries the rules instead
      ...(opts.observe ? [] : group(mk([PLAN_CONTEXT_FLAG], 3))),
    ],
    Stop: group(mk([], 5, { async: true })),
    SubagentStop: group(mk([], 5, { async: true })),
    PostToolUse: group(post, postMatcher),
    SessionEnd: group(mk([], 2)),
    Notification: group(mk([], 5, { async: true }), "permission_prompt|idle_prompt"),
  };
}
