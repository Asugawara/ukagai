# Verification 13: classic "approve and auto" through ExitPlanMode's PermissionRequest (PR-4), on a real Claude Code

- Date: 2026-10-20
- Build: branch `refactor/plan-auto-permission-request` (`b58f046`), `npm run build` at 20:57 JST. Files that another session edited in the work tree after that build (`src/serve/store.ts`, `src/contract.ts`, `src/hook/*`, `src/serve/routes.ts`, `public/app.js`, `src/tui/app.ts`) are not in the build that was verified.
- Versions: Claude Code 2.1.304 (sonnet), node v24.11.0, herdr, Darwin 24.6.0
- `<tmp>` is a scratch directory and `<data-dir>` is `<tmp>/D`. A dev server ran on port 4919 (`node dist/cli.js serve --port 4919 --data-dir <tmp>/D`). Claude Code ran with `--setting-sources project,local --settings <tmp>/settings-log.json`, so the user's own hooks and plugins did not fire. `settings-log.json` is the dev settings plus a logging hook that appends every hook input of `PreToolUse`, `PostToolUse`, `PermissionRequest` and `UserPromptSubmit` to `<tmp>/hooks.jsonl`; `settings-slow.json` adds a `PreToolUse` hook on `ExitPlanMode` that waits for the ack of the approval and then sleeps 12 s (section 4). The working directory was `<tmp>/cwd`. No real `~/.claude/settings.json`, `.claude/settings.json` or `~/.ukagai` was written. No code was changed for this check.
- Classic runs (sections 1–4, 6) had no `--plugin-dir`; section 5 used the mod plugin of verification 12 (`<tmp>/mod-dev`).
- Answers: the "approve and auto" of sections 1 and 2 was clicked in the GUI (agent-browser, "1 Approve (continue in auto mode)"); the others were sent with `POST /api/decisions/:id/answer` (`{"approve":true}` or `{"approve":true,"set_mode_auto":true}`), as the GUI does. The plan card has no button for a plain approval, so that one is API only.
- Prompt of every run: "Write a very small plan to create helloN.txt (one line) and ask for approval with ExitPlanMode. The plan needs a section `## Scope and reversibility` whose first two lines are `Reversibility: reversible` and `Scope: file`. Do not implement anything before the plan is approved. After the plan is approved and ExitPlanMode went through, create helloN.txt with Write and then run `ls` once with Bash and report its output."

## Results

| # | Check | Result |
|---|---|---|
| 1 | 06 E2: auto → shift+tab (`ESC [ Z`) into plan → "approve and auto" in the GUI: no dialog, next hook inputs say `auto`, `PermissionRequest` answers `allow` + `setMode auto`, `grant_used_at` set | ✓ |
| 2 | Same, started with `--permission-mode plan` | ✓ |
| 3 | Plain approval (no mode): no dialog, back to the pre-plan mode, no grant left (404) | ✓ |
| 4 | Server stopped between the ack and the `PermissionRequest`: Claude Code's own plan dialog (fail-open) | ✓ |
| 5 | Regression: the mod's asynchronous "approve and auto" still ends in auto | ✓ |
| 6 | The first Edit/Write after an approval is not forced to ask (the pending mode switch is gone) | ✓ |

## 1. 06 E2: from auto into plan, "approve and auto" (session 6c18c5da)

`--permission-mode auto`, then shift+tab three times (`auto → manual → acceptEdits → plan`; the status line said `plan mode on`). The plan was registered as `approve_plan` with no `delivery` (the ordinary long-poll). The GUI click gave:

- Hook inputs (`<tmp>/hooks-e2.jsonl`), `permission_mode` after the event name: `PreToolUse plan ExitPlanMode` → `PermissionRequest plan ExitPlanMode` → `PostToolUse auto ExitPlanMode` → `PreToolUse auto Write` → `PostToolUse auto Write` → `PreToolUse auto Bash` → `PostToolUse auto Bash`. No dialog (the pane showed `Allowed by PermissionRequest hook`), and the status line said `auto mode on`.
- Debug log (lines 1087–1097): `Hook PermissionRequest (… hook --data-dir … --managed-by ukagai) returned permissionDecision: allow`; the output is `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedInput":{"plan":"…","planFilePath":"…"},"updatedPermissions":[{"type":"setMode","mode":"auto","destination":"session"}]}}}`.
- Decision 9d2ce92f: `status: answered`, `response: {"via":"gui","approve":true,"set_mode_auto":true,"delivered_at":"…07.640Z","delivered_via":"hook"}`, `grant_used_at: "…07.749Z"` (0.11 s after the ack, the `PermissionRequest` output is at 07.750Z). `GET /api/sessions/:id/plan-grant?fingerprint=…` → 404 `no grant` afterwards.

## 2. `--permission-mode plan`, "approve and auto" (session a812d229)

Same hook sequence (`PermissionRequest plan ExitPlanMode` → `PostToolUse auto ExitPlanMode` → `PreToolUse auto Write` → `PreToolUse auto Bash`), debug log line 1023 `returned permissionDecision: allow`, `updatedPermissions` `setMode auto / session`. Decision e76575e9: `delivered_via: "hook"`, `grant_used_at` 0.12 s after `delivered_at`, grant 404 afterwards.

## 3. Plain approval (session 5dc08f22, `--permission-mode plan`)

`{"approve":true}`: `PreToolUse plan ExitPlanMode` printed `permissionDecision: allow` + `updatedInput` (debug log lines 1016–1021); there was no `PermissionRequest` for ExitPlanMode; the next hook inputs say `permission_mode: "default"` (`PostToolUse default ExitPlanMode`), the pre-plan mode. Decision cec6dc07: `delivered_via: "hook"` and `grant_used_at` equal to `delivered_at` (…34.822Z, the ack used it up); the lookup → 404. The following `Write` in `default` mode showed Claude Code's own dialog, which is the normal prompt of that mode (both ukagai hooks for that `Write` exited 0 and printed nothing).

## 4. Server stopped after the ack (session b4529add)

`<tmp>/settings-slow.json` keeps the PreToolUse phase of ExitPlanMode open for 12 s after the ack, so that the server could be stopped between the ack and the `PermissionRequest`. "Approve and auto" was sent at 12:06:43.27Z; the ack-time record: `delivered_via: "hook"`, `grant_used_at` absent, and `GET …/plan-grant` → 200 `{"grant":{"decision_id":"43ac3ef7-…","mode":"auto"}}` (the grant is kept for the `PermissionRequest`). The server was killed at 12:06:45Z. The `PermissionRequest` hook of ExitPlanMode (debug log lines 1031–1033) finished with status 0 in 115 ms and printed nothing, and Claude Code showed its own dialog: "Claude has written up a plan and is ready to execute. Would you like to proceed? 1. Yes, and use auto mode / 2. Yes, manually approve edits / 3. Tell Claude what to change". The dialog was left with Esc; the plan was not carried out. The decision record stays `answered` with `grant_used_at` absent (the server was down, nothing consumed it). Not run: ExitPlanMode with the server already down at the first call.

## 5. Regression: the mod, asynchronous "approve and auto" (session aaf2a10a)

`--plugin-dir <tmp>/mod-dev`, `--permission-mode plan`. The plan was registered with `delivery: "message"`; the answer arrived as a message, the agent called ExitPlanMode again. Hook sequence: `PreToolUse plan ExitPlanMode` (denied, async) → `UserPromptSubmit plan` (the message) → `PreToolUse plan ExitPlanMode` → `PermissionRequest plan ExitPlanMode` → `PostToolUse auto ExitPlanMode` → `Write`/`Bash` in `auto`. `updatedPermissions` `setMode auto / session` in the debug log. Decision 951fa25c: `delivered_via: "message"`, `grant_used_at` set (…35.505Z, 2 s after the answer), grant → 404.

## 6. The forced prompt is gone (session cc15798c, `--permission-mode acceptEdits`)

shift+tab from `acceptEdits` into plan, then `{"approve":true}`: hook inputs `PostToolUse acceptEdits ExitPlanMode` → `PreToolUse acceptEdits Write` → `PostToolUse acceptEdits Write` → `PreToolUse acceptEdits Bash` → `PostToolUse acceptEdits Bash`. There is no `PermissionRequest` for the `Write` (before this change the checkpoint hook forced a prompt on the first edit); the file was written without a dialog and the status line stayed on `accept edits on`. The auto runs of sections 1, 2 and 5 also have no prompt for the first `Write`.

## Findings

1. **No button for a plain approval (info).** The classic plan card offers "1 Approve (continue in auto mode)" and "3 Reject" (and the Instruct box), as in verification 12; a plain approval is only possible through the API. Not new in PR-4.
2. **Another session edited the work tree during the check (setup).** `git status` showed eight modified files at 21:06–21:07, after the build used here. The results above are for the build of `b58f046`.
3. **shift+tab path (setup).** From `--permission-mode auto`, three `ESC [ Z` reach plan (`auto → manual → acceptEdits → plan`), so the "pre-plan mode" of that session is `acceptEdits` for the cycle, not `auto`; the approval still ended in `auto`.

## Not verified

- ExitPlanMode with the server already down at the first call (only the stop after the ack, section 4).
- A grant left behind by an unreachable `PermissionRequest` and a later same-plan ExitPlanMode (the residual risk in the implementer's report, 7).
- Other models; only sonnet was run.
