# Verification 04: plan-writing context reaches the agent (EnterPlanMode PreToolUse, UserPromptSubmit in plan mode)

- Date: 2026-10-04
- Claude Code: `2.1.287 (Claude Code)`, model Haiku 4.5 (`--model haiku`), Node v24.11.0
- Hooks as installed by `node dist/cli.js install --lang ja` into `~/.claude/settings.json` (PreToolUse `EnterPlanMode` group, sync `UserPromptSubmit` group, both `node dist/cli.js hook --plan-context`); serve running on 127.0.0.1:4818 but the plan-context path never calls it
- No code was changed. The questions asked the model to quote the context verbatim, so the result shows what the model saw, not what the hook printed
- Markers: `~/.ukagai/plan-context/<session_id>` (one zero-byte file per session that received the context)

## Results table

| Test | Result | Summary |
|---|---|---|
| P1 UserPromptSubmit, plan mode entered by the user | **Passed** | `claude -p --model haiku --permission-mode plan "<quote the context>"` in a scratch dir. Marker written for the session. A second run in a fresh session answered `YES` and quoted lines 1-2: `[ukagai] Write the plan in ukagai Markdown; a human reads it in a GUI / TUI and decides on it. Plan sections, in this order:` / `- `# Title`: one line saying what the plan does.` (First run quoted the SessionStart context instead because the question did not single out the second block.) |
| P2 PreToolUse EnterPlanMode (model enters plan mode) | **Passed** | Interactive session in a Herdr pane (`herdr agent start livecheck --kind claude --pane … -- --model haiku`), prompted to call `EnterPlanMode` and report. Output: `Entered plan mode`, then `YES`, the same first line, and "the ukagai context is 12 lines, a PreToolUse additional context ending with the `Full spec: …` line". `additionalContext` without `permissionDecision` did not block or alter the tool call. |
| P3 Non-interactive EnterPlanMode | **Not applicable** | In `claude -p` (default permission mode) the model reported `EnterPlanMode is not available in this session`; the tool only exists interactively, so P2 was run in a pane. |

## Notes

- Three markers existed afterwards (two `-p` sessions, one interactive), matching the three sessions that entered plan mode; a marker is written once per session, so a second prompt in the same plan-mode session injects nothing (not re-tested here; covered by `test/hook/plan-context.test.ts`).
- The first interactive attempt was started in the scratch directory and died on the folder-trust dialog ("Is this a project you created or one you trust?") before any prompt; the record above is the re-run in the repo directory.
