# Verification 09: each ukagai deny shows one red line, and the agent still gets the instructions

- Date: 2026-10-20
- Build: branch `fix/quiet-denies` (`ce16453`), `npm run build`
- Versions: Claude Code 2.1.304 (sonnet in the checked session, haiku in the pre-check), node v24.11.0, Darwin 24.6.0
- `<S>` is a scratch directory. A temporary server ran on a free port with `--data-dir <S>/data` and no Codex bridge. The checked session used `--settings <S>/settings.json` with the branch's hooks (AskUserQuestion|ExitPlanMode with `--budget 40`, Bash with `--checkpoint`, SessionStart with `--no-autostart`), each run through `env -u UKAGAI_DISABLE`. The pane had `UKAGAI_DISABLE=1`, so the globally installed ukagai hooks stayed silent: `~/.ukagai/events.jsonl` has no line with the test session id. No real `~/.ukagai` or `~/.claude/settings.json` was written. Answers were given in the TUI (`ukagai tui --server … --data-dir <S>/data`) in a second pane.

## Pre-check: does `additionalContext` reach the model on a deny?

A dummy PreToolUse hook denied with `permissionDecisionReason: "[test] SHORT-<tool>"` and an `additionalContext` holding a secret word.

| Case | Model got the context | How it arrived |
|---|---|---|
| Bash, `claude -p` | ✓ | `hook_additional_context` attachment (system-reminder); the tool_result held only `PreToolUse:Bash hook error: [test] SHORT-REASON-7` |
| AskUserQuestion, interactive | ✓ | same; tool_result `PreToolUse:AskUserQuestion hook error: [test] SHORT-AskUserQuestion` |
| ExitPlanMode in plan mode, interactive | ✓ | same |
| AskUserQuestion from a subagent | — | subagents have no AskUserQuestion tool, so the deny path never runs |

`claude -p` offers neither AskUserQuestion nor ExitPlanMode, so those cases need an interactive session.

## Results

| # | Site | Red line in the terminal | Hook context in the transcript | Agent's next action | Result |
|---|---|---|---|---|---|
| 1 | AskUserQuestion with no explanation file | `PreToolUse:AskUserQuestion hook error: [ukagai, not a failure] Question not shown to the human yet: it has no explanation file (see hook context).` | `… Missing: the explanation file itself. Save to: <scratchpad>/ukagai/explain.md …` | loaded the skill, wrote the file, asked again | ✓ |
| 2 | Hand-off (unanswered for about 3 minutes, 40 s budget) | `… Still waiting for the human in ukagai: call AskUserQuestion again, unchanged (see hook context).`, one per leg (5 legs) | `… The human has not answered yet; the question stays open in ukagai. Call AskUserQuestion again now …` | re-called unchanged each time; got the answer given in the TUI | ✓ |
| 3a | ExitPlanMode rejected with a reason | `PreToolUse:ExitPlanMode hook error: [ukagai, not a failure] The human rejected the plan (see hook context).` | `[ukagai] The human rejected the plan and wrote: too short` | revised the plan | ✓ |
| 3b | ExitPlanMode with an instruction | `… Plan not approved yet: the human asked for something first (see hook context).` | `[ukagai] The human has not approved the plan yet and asks you to do this first: add a test step …` | added the step and called ExitPlanMode again | ✓ |
| 4 | Bash `open <S>/x.html` | `PreToolUse:Bash hook error: [ukagai, not a failure] Not opened: the human reads files in ukagai, not in a viewer (see hook context).` | `[ukagai] Do not open files for the human; they read ukagai. Reference the file from the explanation instead …` | offered to reference the page from an explanation; nothing opened | ✓ |

In every step:

- exactly one `hook error` line appeared per deny;
- none of `Missing:`, `Save to:`, `First read` or `The human has not answered yet` was visible in the pane;
- the transcript had the `hook_additional_context` attachment for the denied call.

## Notes

- A Bash deny is folded into "Ran 1 shell command" in the normal view. Its red line shows in the expanded view (ctrl+o).
- When the prompt said "do not write any file first", the agent asked before writing the explanation file. It wrote the file once told it may.
