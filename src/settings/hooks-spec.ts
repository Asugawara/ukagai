/** install が登録する hook を 1 か所で定義する(docs/strategy/03 3 節の表) */

export const MANAGED_FLAG = "--managed-by";
export const MANAGED_VALUE = "ukagai";
export const STATUS_MESSAGE = "ukagai: GUI で回答待ち";
export const DECISION_MATCHER = "AskUserQuestion|ExitPlanMode";

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
  node: string;
  cli: string;
  timeout: number;
  observe: boolean;
  /** false なら SessionStart の hook に --no-autostart を渡す。省略は true */
  autostart?: boolean;
  /** 全 hook に渡す共通の引数(--data-dir / --server) */
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

/** 印: args に `--managed-by ukagai` を含む(settings の schema に未知のキーを足さない) */
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
    command: opts.node,
    args: [opts.cli, "hook", ...extra, ...(opts.hookArgs ?? []), MANAGED_FLAG, MANAGED_VALUE],
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
    PreToolUse: group(pre, DECISION_MATCHER),
    PermissionRequest: group(mk([], 5), "Write|Edit"),
    SessionStart: group(mk(opts.autostart === false ? ["--no-autostart"] : [], 5)),
    SubagentStart: group(mk([], 5)),
    UserPromptSubmit: group(mk([], 5, { async: true })),
    Stop: group(mk([], 5, { async: true })),
    SubagentStop: group(mk([], 5, { async: true })),
    PostToolUse: group(post, postMatcher),
    SessionEnd: group(mk([], 2)),
    Notification: group(mk([], 5, { async: true }), "permission_prompt|idle_prompt"),
  };
}
