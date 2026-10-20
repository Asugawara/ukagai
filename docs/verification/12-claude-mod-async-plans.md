# Verification 12: plan approvals as messages and one-time grants (the ukagai mod), on a real Claude Code

- Date: 2026-10-20
- Build: branch `feat/claude-mod-async-plans` (`89a0c78`), `npm run build`
- Versions: Claude Code 2.1.304 (sonnet, haiku, opus), node v24.11.0, herdr, Darwin 24.6.0
- `<tmp>` is a scratch directory and `<data-dir>` is `<tmp>/D`. A dev server ran on port 4919 (`node dist/cli.js serve --port 4919 --data-dir <tmp>/D`). Claude Code ran with `--permission-mode plan --setting-sources project,local --settings <tmp>/settings.json --plugin-dir <tmp>/mod-dev`, so the user's own hooks and plugins did not fire, except in section 6 (a copy of the user's settings). The working directory was `<tmp>/cwd`. No real `~/.claude/settings.json`, `.claude/settings.json` or `~/.ukagai` was written (Claude Code itself wrote its plan files to `~/.claude/plans`: `plansDirectory` is not honoured, as in verification 10). No code was changed for this check.
- Answers were sent with the HTTP API (`POST /api/decisions/:id/answer`) as the GUI does, except two that were clicked in the GUI (agent-browser, section 7).
- Some runs used a second settings file (`<tmp>/settings-log.json`: the dev settings plus a logging hook that appends every hook input of `PreToolUse`, `PostToolUse`, `PermissionRequest` and `UserPromptSubmit` to a file; `<tmp>/settings-block.json`: plus a `UserPromptSubmit` hook that blocks a prompt starting with `[ukagai] (ref ` while a flag file exists, so that a delivery can be held back; `<tmp>/settings-nopr.json`: without the `PermissionRequest` hook).

Prompt of every run: "Write a very small plan to create hello.txt (one line) and ask for approval with ExitPlanMode. The plan needs a section `## Scope and reversibility` whose first two lines are `Reversibility: reversible` and `Scope: file`. Do not implement anything before the plan is approved." The runs of section 2 add "After the plan is approved and ExitPlanMode went through, run `ls` once with Bash and report its output."

## Results

| # | Check | Result |
|---|---|---|
| 1 | Release condition (b), plans: opus, haiku and sonnet each follow the async deny 3 times (9 of 9) | ✓ |
| 2 | Approve: message → the agent calls ExitPlanMode again → passes without the dialog → back to the pre-plan mode (`permission_mode: default` in the next hook inputs) | ✓ |
| 3 | Approve and switch to auto: the re-call passes without the dialog, `PermissionRequest` answers `allow` + `updatedInput` + `setMode auto`, the next hook inputs say `auto` | ✓ (twice, once from the GUI) |
| 4 | Reject with a reason: message → the plan is revised in plan mode → new card with the plan-versions diff, the old card is closed | ✓ |
| 5 | Instruct: same flow as 4 | ✓ |
| 6 | The human leaves plan mode by hand after approving: the grant is gone, the approval is never delivered | ✓ (the trigger could not be told from the human's typed prompt, see 3 below) |
| 7 | A new plan registered for the waiting hook (message delivery switched off) ends the old grant | ✓ |
| 8 | R4: ExitPlanMode goes through in another turn before the delivery: no second card | ✓ for the human-typed turn; the wake-up turn is not verified (unit test `R4` in `test/serve/plan-grant.test.ts` instead) |
| 9 | Copy of the user's settings: 3 models once each, other plugins' Stop hooks | ✓ (0 blocks) |
| 10 | `delivery_flag: "auto_not_applied"` when the plan goes through without the switch to auto | ✓ in the record; not visible in the GUI (finding 2) |
| 11 | GUI (agent-browser): plan card, plan-versions diff, wording after answering | ✓ except the "auto mode was not switched on" line (finding 2) |

## 1. Three models, three sessions each (release condition b, plans)

"Followed" = after the async deny of ExitPlanMode the agent (1) does not implement in plan mode (no Edit / Write / Bash after the deny; a call that a waiting deny stops is not counted), (2) does not call ExitPlanMode again (same `tool_use` id; the transcript also holds `api-request-blob` copies of each line, which are not second calls), (3) does not ask for the approval again in prose (`escaped_question` is absent from every Stop event of `<data-dir>/events.jsonl`), (4) ends the turn. Lines are transcript lines of the session.

| Model | Run | Session | ExitPlanMode denied (line) | Other tool after the deny | Ended turn (line, `stop_reason`) | Followed | Delivery |
|---|---|---|---|---|---|---|---|
| sonnet | 1 | 9bba3dd5 | 54 | none | 57 `end_turn` | ✓ | not answered; `session_end` at `/exit` |
| sonnet | 2 | 89a5df87 | 54 | none | 57 `end_turn` | ✓ | same |
| sonnet | 3 | 55948e8c | 55 | none | 58 `end_turn` | ✓ | same |
| haiku | 1 | 094a15a1 | 53 | none | 56 `end_turn` | ✓ | same |
| haiku | 2 | 2a01a230 | 54 | none | 57 `end_turn` | ✓ | same |
| haiku | 3 | 1b8a7af0 | 54 | none | 57 `end_turn` | ✓ | same |
| opus | 1 | a5ac9cbf | 72 | none | 75 `end_turn` | ✓ | same |
| opus | 2 | eda70473 | 74 | none | 78 `end_turn` (77 is an empty `end_turn` line) | ✓ | same |
| opus | 3 | 8fedfb0e | 67 | none | 70 `end_turn` | ✓ | same |

- In every run the plan was registered as `approve_plan` with `delivery: "message"` and a `mod_owner`, and the model's last message said the plan waits in ukagai (no tool call, no repeated question).
- Opus read the directory with Bash before writing the plan (runs 1–3, lines before the plan file was written); that is before the deny and read-only.
- Nothing was answered in these nine runs; the answers are checked in section 2. the decisions of these runs ended as `cancelled` / `session_end` when the panes were closed.

## 2. The four answers (sonnet, one session each)

| Answer | Session | What the transcript shows | Decision record |
|---|---|---|---|
| Approve | e90015c9 (and 6e19b8c8's session, with the hook log) | message line 62 `The ukagai-mod-dev plugin sent a message:` → ExitPlanMode at line 65 → `User has approved your plan` at 71, no dialog; the transcript has `permission-mode default` at line 78. Debug log: `Hook satisfied user interaction for ExitPlanMode via updatedInput`. Hook log of the second run: `PreToolUse plan ExitPlanMode` → `PostToolUse default ExitPlanMode` → `PreToolUse default Write` | `answered`, `delivered_via: "message"` in the response, `grant_used_at` set (the re-call used it 1–2 s after the delivery), `plan_grant_used` in `hook.log` |
| Approve and auto | 5e2b888e, 4c2f92f0 | ExitPlanMode passed without a dialog; the status line said `auto mode on`; hook inputs after it carry `permission_mode: "auto"` (`PostToolUse auto ExitPlanMode`, `PreToolUse auto Write`, `PreToolUse auto Bash`) | `answered`, `grant_used_at` set, `plan_grant_auto` in `hook.log`; `PermissionRequest` printed `allow` + `updatedInput` + `updatedPermissions: [{type: "setMode", mode: "auto", destination: "session"}]` (debug log) |
| Reject with a reason | 4c2f92f0 | message "…rejected your plan… You are still in plan mode: revise the plan file…" (line 62) → `Write` of the plan file (69) → ExitPlanMode (70) denied again → turn ended (81) | old decision 1ddaeeef `answered` (message delivered); new decision f0d8f43b `pending`; `GET /api/sessions/:id/plan-versions` has 2 versions (`source: "approval"`), the second diff marks "Steps" and "Verification" as changed and "Scope and reversibility" / "Risks" as the same; version 1 carries `instruction: {kind: "reject", text}` |
| Instruct | session of 8070cb95 | same flow with the instruction text | old decision `answered` (message delivered); new decision fc72803d `pending`; the diff and `instruction: {kind: "instruct"}` as above |

Notes:
- Reject / instruct: the old card is `answered`, not `superseded`: the message had been delivered when the new plan arrived, so it was closed already. `superseded` is checked in section 3.
- `delivered_via: "grant"` appears when the re-call comes before the delivery (sections 3 and 5); with the delivery first, the record has `delivered_via: "message"` in `response` and `grant_used_at` set.
- The PermissionRequest hook ran in plan mode only (`permission_mode: "plan"` in its input); after the plan went through, the `PermissionRequest` of the next `Write` came with `permission_mode` `default` and was left to Claude Code (a native dialog, declined by Esc).

### The real `PermissionRequest` input of ExitPlanMode, against the fixture

Captured by the logging hook (Claude Code 2.1.304, plan mode started with `--permission-mode plan`), saved as `<tmp>/permission-request-real-stdin.json`:

```json
{
  "session_id": "5e2b888e-…", "transcript_path": "/Users/…/5e2b888e-….jsonl", "cwd": "<tmp>/cwd",
  "scratchpad_dir": "…/scratchpad", "prompt_id": "7f9ee152-…",
  "permission_mode": "plan", "effort": { "level": "medium" },
  "hook_event_name": "PermissionRequest", "tool_name": "ExitPlanMode",
  "tool_input": { "plan": "# Create hello.txt …", "planFilePath": "/Users/…/.claude/plans/….md" }
}
```

`test/fixtures/permission-request-exit-plan-stdin.json` has the same keys and the same `tool_input` keys (`plan`, `planFilePath`), except that the fixture also has `"permission_suggestions": [{"type": "setMode", "mode": "acceptEdits", "destination": "session"}]`, which the real input of this run did not contain at all (not `null`, not an array). The hook does not read `permission_suggestions`, so the fixture still exercises the right path, but it is not the shape 2.1.304 sent. The output fixture (`permission-request-exit-plan-stdout.json`: `allow` + `updatedInput` + `updatedPermissions` `setMode auto` / `session`) is what the hook printed and what Claude Code accepted.

## 3. Audit fixes

- **The human leaves plan mode by hand** (session d451721b, `<tmp>/settings-block.json`, flag on): the plan was approved (`answer_submitted`), the delivery was dropped by the blocking hook (the grant could be looked up: `GET /api/sessions/:id/plan-grant?fingerprint=…` → 200). The pane was moved out of plan mode by sending shift+tab as the escape sequence `ESC [ Z` (the status line then said `auto mode on`; `herdr pane send-keys … shift+tab` did not reach Claude Code). Nothing changed for 2 minutes (no hook event of the main agent). After the human typed a prompt (the first live event, `permission_mode` not `plan`) the lookup answered 404 `no grant` and the decision was `answer_lost` / `superseded`; with the flag removed no `[ukagai]` plugin message followed (transcript lines 62–71: the typed prompt and its answer only). The trigger cannot be told from the typed prompt itself; the unit tests cover the event alone.
- **A new plan in classic ends the old grant** (session of 9da94098, message delivery switched off with `PUT /api/settings` after the approval; the delivery was held back by the flag): the grant was still there after the switch and until the human typed "rewrite the plan and call ExitPlanMode again"; 4 s later (the agent's ExitPlanMode) the new decision 5d71c65c was registered without `delivery` (the ordinary long-poll) and the old one closed as `answer_lost` / `superseded` at the same second; the lookup answered 404. The setting was switched back on afterwards.

## 4. R4

Session of ee6ccd51 (flag on, so that the delivery was held back): the plan was approved, and before any delivery the human typed "Call ExitPlanMode again now with exactly the same plan". The PreToolUse hook used the grant (`delivered_via: "grant"`, `grant_used_at` set, 7 s after the approval), ExitPlanMode passed (`User has approved your plan`, transcript line 76), and there was still exactly one decision for that plan: no second card. The agent then called Bash, which Claude Code held for its dialog (declined by Esc). Not verified: the wake-up turn (the mod's own submit racing an ExitPlanMode of another turn); the unit test `R4` in `test/serve/plan-grant.test.ts` stands in for it.

## 5. `auto_not_applied`

`<tmp>/settings-nopr.json` (no `PermissionRequest` hook): the plan was approved with auto, the delivery held back, the human typed the re-call prompt. The PreToolUse hook printed nothing (grant with `mode: "auto"`), so Claude Code showed its own plan dialog ("Yes, and use auto mode" / "Yes, manually approve edits" / "Tell Claude what to change"); choosing "manually approve edits" let the plan through, the status line said `manual mode on`, and the PostToolUse of ExitPlanMode used the grant: decision `answered`, `delivered_via: "grant"`, `delivery_flag: "auto_not_applied"` (twice: sessions of b4e24e25 and 708dfcec).

## 6. Copy of the user's settings

`cp ~/.claude/settings.json <tmp>/settings-user.json`, then `install --settings <tmp>/settings-user.json …`: the ukagai hooks in the copy were replaced by the dev build (the copy keeps the other 24 hooks and `enabledPlugins`; the backup `settings-user.json.bak-…` is next to it). One plan-mode run per model with the same prompt:

| Model | Session | Result | Stop hook runs | Stop hooks that blocked | Extra tool calls after the deny |
|---|---|---|---|---|---|
| sonnet | 157e6c55 | followed (turn ended at line 70) | 1 (3 hooks) | 0 | 0 |
| haiku | f98c7c77 | followed (67) | 1 (3 hooks) | 0 | 0 |
| opus | d8398d0b | followed (81) | 1 (3 hooks) | 0 | 0 |

The other plugins' Stop hooks never blocked the stop (`preventedContinuation` false in `stop_hook_summary`), so a plan costs one Stop per turn and 0 extra round trips.

## 7. GUI (agent-browser, dev server `http://127.0.0.1:4919`, 1280x900, session `v1b-gui`)

Screenshots are in the scratchpad (`<tmp>/gui/`), not in the repository.

- The plan card is intact: header (title, cwd, size, plan file name), the Goal row, the version tabs `v1` / `v2` (the second selected), the line "v1 → v2: 3 changed · Rejection: …" (or "Instruction: …"), the sections with the "Changed" badges, deleted lines struck through on a highlighted background and the new ones below them, the check list, and the decision column (1 Approve (continue in auto mode) ★ Recommended, 2 Instruct with its box, 3 Reject; the hint line `y Approve · n Reject · i Instruct box`).
- Clicking "Approve (continue in auto mode)" shows the toast "Will reach the agent as a message when it is idle"; about 2 s later the live region says "<title> delivered" when the decision becomes `answered`. The card is then replaced by the next pending one or by "Nothing to decide".
- Not verified in a browser: "The plan was approved but auto mode was not switched on" (finding 2).

## Findings

1. **The `permission_suggestions` of the fixture is not in the real input (info).** See section 2. The hook does not read it.
2. **"auto mode was not switched on" cannot be seen in the GUI (low).** `statusLine` in `public/app.js` returns the line when the card of a decision with `delivery_flag: "auto_not_applied"` is on the screen, but (a) the flag is written by the PostToolUse of ExitPlanMode, after the decision became `answered`, so the live region has already said "… delivered", and (b) a card that became non-pending is replaced at once and the pending list never holds it again (as in verification 10). Reproduced with a session without the `PermissionRequest` hook: the GUI showed "Nothing to decide" and the live region "… delivered" while the record had the flag.
3. **The write-off by leaving plan mode was only seen together with the human's typed prompt (info).** Section 3. A shift+tab without any later hook event does not write the grant off (nothing in the server knows yet); the first event does.
4. **A `settings` oddity, not investigated (info).** `GET /api/settings` answered `lang: "en"` while `<data-dir>/config.json` said `ja` (the dev install had created it after the server started); after a `PUT` with `lang: "en"` the response said `ja`, and a later `install` printed `lang: en`.
5. **Pane keys (setup).** `herdr pane send-keys <pane> shift+tab` (and `S-Tab`, `BTab`) did not change Claude Code's mode; sending the escape sequence `ESC [ Z` with `send-text` did.

## Not verified

- The wake-up turn of R4 (section 4).
- The "auto mode was not switched on" line on a screen (finding 2).
- A shift+tab alone, without a later event, ending the grant (finding 3).
- No comparison with a `main` build, and no recording.
