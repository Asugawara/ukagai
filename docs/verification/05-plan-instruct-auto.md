# Verification 05: instructing from a plan card keeps plan mode; "approve and continue in auto mode" switches the mode

- Date: 2026-10-06
- Claude Code: `2.1.287 (Claude Code)`, model Haiku 4.5 (`--model haiku`), interactive session in a Herdr pane in the ukagai checkout; hooks as installed by `node dist/cli.js install --lang ja` (PermissionRequest group without a matcher, main `edf0450` or later); serve on 127.0.0.1:4818
- Answers were sent with `curl` to `POST /api/decisions/:id/answer` (bearer token), which is what the GUI / TUI do
- No code was changed

## Results table

| Test | Result | Summary |
|---|---|---|
| I1 Instruct on the approval card | **Passed** | The agent entered plan mode, wrote a two-line plan and called ExitPlanMode. Answer `{"instruct": true, "text": "Add one more step … Then call ExitPlanMode again."}`. The pane showed `PreToolUse:ExitPlanMode hook error: [ukagai] The human has not approved the plan yet and asks you to do this first: …` (Claude Code's label for a hook deny), the status line stayed `plan mode on`, the agent updated the plan and called ExitPlanMode again: a second `approve_plan` decision appeared in ukagai 40 s later. |
| A1 Approve with `set_mode_auto` | **Passed, with a caveat** | Answer `{"approve": true, "set_mode_auto": true}` on the second decision. The agent left plan mode and ran `git status --short` and `git branch --show-current`: both are read-only commands that Claude Code allows without a prompt, so no `PermissionRequest` fired, the record stayed `pending: true` and the status line read `manual mode on`. |
| A2 First real permission prompt | **Passed** | Then asked for `touch /private/tmp/ukagai-ms1-probe.txt`. The pane showed `Allowed by PermissionRequest hook`, the status line turned to `auto mode on (shift+tab to cycle)`, and `GET /api/sessions/:id/pending-mode-switch` returned `{"pending": false}`. |

## Notes

- The switch rides on the first permission prompt of any tool. A session that only runs commands Claude Code allows on its own (read-only git, Read, Glob) stays in default mode until its first real prompt, which is the prompt the human would otherwise have had to answer. The record lives 60 minutes.
- The deny-with-instruction path keeps plan mode, which the reject path already relied on; this is the first record of it on a real session.
