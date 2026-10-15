# Verification 06: the mode after a hook-allowed ExitPlanMode, and why the switch asks on the first edit

- Date: 2026-10-15
- Claude Code: `2.1.300 (Claude Code)`
- E1 and E3 ran in test sessions started by hand with only two test hooks (`--setting-sources project,local`, Haiku); E3 checks the Claude Code behaviour the fix relies on with stand-in hooks, not ukagai itself

## Results table

| Test | Result | Summary |
|---|---|---|
| E1 Can a PermissionRequest hook answer ExitPlanMode? | **No** | Test session with only two test hooks (`--setting-sources project,local`, auto mode, Haiku). The PreToolUse hook on ExitPlanMode printed nothing; a `PermissionRequest` fired with `tool_name: "ExitPlanMode"`, `permission_mode: "plan"`, `permission_suggestions: null`; the hook printed `allow` + `setMode auto`. Claude Code still showed its plan dialog ("Yes, and use auto mode" / "Yes, manually approve edits" / "Tell Claude what to change"). |
| E2 Mode after a hook-allowed ExitPlanMode | **Restores the pre-plan mode** | Real sessions on 2.1.300 where the human entered plan mode (no EnterPlanMode call) landed in acceptEdits after the hook-allowed ExitPlanMode, with no `PermissionRequest` afterwards and the switch still pending. A session on 2.1.299 that entered plan mode through EnterPlanMode from auto returned to auto. |
| E3 Can a PermissionRequest hook answer a prompt forced by PreToolUse `ask` in acceptEdits? | **Yes** | Session started with `--permission-mode acceptEdits`. A PreToolUse hook on `Edit\|Write` printed `permissionDecision: "ask"`; on "write ok to check.txt" a `PermissionRequest` fired with `tool_name: "Write"`, `permission_mode: "acceptEdits"`; the hook printed `allow` + `setMode auto`. No dialog appeared, the pane showed `Allowed by PermissionRequest hook`, and the status line went from `accept edits on` to `auto mode on`. |

## Notes

- The bundle restores `prePlanMode ?? "default"`. A human who presses shift+tab from auto passes through acceptEdits right before plan mode, so the session comes back in acceptEdits, where Edit / Write never prompt and the pending switch is never consumed.
- Hence the checkpoint PreToolUse hook answers `ask` on the first main-agent Edit / Write while the session is in default or acceptEdits; the prompt then reaches the PermissionRequest hook, which switches to auto.
