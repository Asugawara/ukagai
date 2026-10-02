# Verification 02: hook limits and the round trip of "making Claude write the explanation" (E1 to E7)

- Date: 2026-10-02
- Claude Code: `2.1.287 (Claude Code)` (`claude --version`)
- Node: v24.11.0 (runtime for the hook)
- Interactive sessions were started in the pane next to Herdr (`herdr agent start probe --kind claude -- --settings verification/settings*.json --model sonnet|opus`). Because the global setting `defaultMode` is `auto`, runs without `--permission-mode` are in auto mode. Models were Sonnet 5.5 (`claude-sonnet-5-5`) and Opus 5.5 (`claude-opus-5-5`, part of E4 / E5).
- Used: `verification/hook.mjs` (extended from the one in verification 01), `verification/settings.json` plus `settings-86400.json` / `settings-notif.json` / `settings-e3.json` / `settings-e5.json` / `settings-e6.json`, raw hook logs `verification/log/<test name>.json`
- Primary-source mapping: hook log = `verification/log/<test name>.json` (signals received and judgments in `events`, input and output in `stdin` / `stdout`), transcript = `~/.claude/projects/-Users-user--herdr-worktrees-ukagai-verify-e1-e5/<session_id>.jsonl`
- Reflects the additional brief (`E-addendum.md`). Explanation files go under `ukagai/` in the `scratchpad_dir` found in the hook's stdin, with `question:` required in the front matter, no sequence numbers, and a diagram not required but "if structure or flow is involved". E1 is 660 seconds. E6 / E7 were added.
- Order of the tests: E1 (660 seconds × 2 in the background), E2, E7, E6, E3, E4, E5. Runs invalidated by a missed environment-variable switch were moved to `verification/log/void-*` and are not included in the results (see "Voided runs" below).

## Results table

| Test | Condition | Result | Summary |
|---|---|---|---|
| E1-1 | Block for over 660 seconds with `timeout: 3600` | **Passed** | The hook survived to 790 seconds, with 0 `hook_cancelled`. It was not rounded down to the default 600 seconds. It picked up the answer placed after 790 seconds |
| E1-1s | `statusMessage` on the hook entry | **Passed** | The spinner line becomes `Waddling… (ukagai: GUI で回答待ち… · 8s · ↓ 42 tokens)`. Without it, it is `running PreToolUse hook` |
| E1-2 | Block for over 660 seconds with `timeout: 86400` | **Passed** | Survived to 683 seconds with 0 `hook_cancelled`, and picked up the answer. No warning seen at startup or while waiting (only the last 49 lines of the startup screen were captured) |
| E1-2h | Display in `/hooks` | **Conditional** | The PreToolUse hook passed via `--settings` does not appear in the `/hooks` list ("17 hooks on 8 events", and the PreToolUse rows are only 2 `[Plugin]` entries) |
| E1-3a | Esc while waiting | **Conditional** | The hook received SIGTERM and exited (exit 143). The tool is treated as rejected, Claude gives no reply and the turn ends. No `hook_cancelled` remains in the transcript |
| E1-3b | ctrl+c while waiting | **Conditional** | Same as Esc (SIGTERM, treated as rejected, turn ends) |
| E1-4 | Add a Notification hook and observe while waiting | **Does not pass (does not fire while waiting)** | 0 events during the 74-second wait. One `idle_prompt` fired about 60 seconds after the wait ended and Claude finished its turn |
| E2-freetext | Free text not among the labels | **Passed** | Claude accepts the free text. The opening of the tool_result changes to `The user answered:`, with one added sentence saying it may be a request or disagreement so read carefully |
| E2-multi | `"A, C"` for multiSelect | **Passed** | Accepted as `Your questions have been answered: "…"="A, C".` The screen also shows `→ A, C` |
| E2-missing | `answers: {}` | **Conditional** | No error; `The user did not answer the questions.` (treated as unanswered). Claude replied that there was no answer and suspected the hook of intercepting |
| E2-mismatch | Key does not match `question` | **Does not pass (treated as unanswered)** | Observed twice (once occurred unintentionally). Both gave `The user did not answer the questions.` The hook's `answers` remains in `toolUseResult.answers` but is not passed to Claude |
| E2-partial | Answer only the first of 2 questions | **Conditional** | Only the one answered question appears in `Your questions have been answered:`. Claude reported that the answer to the second question did not come back |
| E3-1 | Deny ExitPlanMode (add a diagram and a section) → allow the second time | **Passed** | Claude edited the plan file and resubmitted 6.3 seconds later. The plan went from 403 to 673 characters, with a Mermaid diagram and a "影響範囲と可逆性" (scope and reversibility) section added. 2 round trips |
| E3-2 | Status line after approval | **Conditional** | `⏸ manual mode on`. A permission prompt appeared at the following Write (rejected with Esc). Same as verification 01 T5 |
| E3-3 | Extra field `permissionMode: "auto"` in allow's `updatedInput` | **Passed (ignored)** | No error. The mode after approval stays `manual` |
| E3-4 | `setMode: auto` from a PermissionRequest hook right after approval | **Passed** | No permission prompt at the first Write after approval (`Allowed by PermissionRequest hook`), the status line returned to `⏵⏵ auto mode on`, and the hook was not called again at the following Write |
| E3-5 | Long deny reason (1069 characters, 25 lines) | **Passed** | The screen folds it to 9 lines (`… +16 lines`). Claude's tool_result contains the full text (up to the end marker) |
| E4 | Round trip of making Claude write an explanation via deny (8 valid runs + 1 abandoned) | **Conditional** | Passed in 2 round trips in 8 of 9 (6 of 7 imperative, of which r4 had an extra instruction; fact 2/2). deny → re-call took 7.4 to 27 seconds. The written explanations had the front matter and required sections every time. One run in plan mode × Opus stopped in prose without writing |
| E4-C2 | Write to `<scratchpad_dir>/ukagai/` | **Passed** | No permission prompt in default / acceptEdits / auto / plan (Sonnet). plan (Opus) did not attempt Write and replied in prose that "in plan mode, anything other than the plan file cannot be edited" |
| E5 | Writing in advance with only SessionStart's additionalContext | **Passed (6/6)** | Rate at which the explanation file existed by the first AskUserQuestion: 6/6. However, `reversibility` / `scope` in the front matter did not follow the enumerated values and were free text |
| E5-clear | Re-injection after `/clear` | **Passed** | SessionStart fired again with `source: clear`, and additionalContext arrived with the new `session_id` / `scratchpad_dir` |
| E6-a | AskUserQuestion inside an Explore / general-purpose subagent | **Does not pass (no tool)** | AskUserQuestion is not in the subagent's tool list, and PreToolUse does not fire |
| E6-b | SubagentStart's additionalContext | **Passed** | It entered the subagent's transcript as `hook_additional_context`, and the subagent recognized the passphrase. stdin has `agent_id` / `agent_type` |
| E7 | A hook that gives up in 1 second against an unreachable server | **Passed** | Exit 0 with no output after 30 ms due to `ECONNREFUSED`. From tool_use to hook end was 87 ms, and the normal question UI appeared |

## Observations per test

### E1 Upper limit of timeout and display during long blocking

#### E1-1 `timeout: 3600`, wait mode, no answer file placed

(Done in two parts in a separate pane `probe2`: first a 124-second preliminary, then 790 seconds with `statusMessage`.)

Preliminary (`timeout: 3600`, no statusMessage. `E1-1-timeout3600-wait.json`):

```
started_at 03:58:01.443Z / ended_at 04:00:05.603Z / exit 0 / "wait: answer.json found after 124s"
```

- The hook, which died at 60 seconds in verification 01 T3a, survived beyond 60 seconds (confirmed pid 26946 with `pgrep -fl hook.mjs`).
- Screen while waiting (`--source visible`):

```
✢ Twisting… (running PreToolUse hook · 18s · ↓ 42 tokens)
```

Main run (`statusMessage: "ukagai: GUI で回答待ち"`, `E1-1b-timeout3600-660s.json`):

```
started_at 04:10:47.745Z / ended_at 04:23:57.691Z / exit 0 / "wait: answer.json found after 790s"
```

```
✽ Waddling… (ukagai: GUI で回答待ち… · 8s · ↓ 42 tokens)
✽ Waddling… (ukagai: GUI で回答待ち… · 13m 12s · ↓ 42 tokens)
```

- The status line (bottom row) stays `⏵⏵ auto mode on`, with no wording indicating waiting. The first item inside the parentheses of the spinner `(… · elapsed time · ↓ tokens)` is replaced by the statusMessage. The trailing "…" is added by Claude Code.
- There are 0 `hook_cancelled` in the transcript (`1a4d0367-…jsonl`). There was no cut-off at 600 seconds either.
- Placing `answer-e1.json` at the 790-second mark was picked up, and it continued as usual with `hook_success`.
- In the preliminary run, Claude used a half-width "?" in the question text, which did not match the answer key (full-width "？"). The tool_result was `"The user did not answer the questions."`, and the screen showed `User answered Claude's questions: · A と B のどちらにしますか？ → A` (displayed with the hook's key). The value the hook injected remains in the transcript's `toolUseResult.answers`. → this is the first run of E2-mismatch. After that, the hook was fixed so that in wait mode, writing `{"*": "A"}` to `answer.json` uses the stdin `question` as the key as is.

#### E1-2 `timeout: 86400`

`E1-2b-timeout86400-660s.json`:

```
started_at 04:24:33.517Z / ended_at 04:35:56.314Z / exit 0 / "wait: answer.json found after 683s"
```

- While waiting: `✢ Drizzling… (ukagai: GUI で回答待ち… · 11m 17s · ↓ 42 tokens)`. 0 `hook_cancelled`. After pickup, normal.
- Preliminary (`E1-2-timeout86400-wait.json`, no statusMessage, 74 seconds): no warning or error wording in the last 49 lines of the screen right after startup (the part scrolled off above was not captured).
- `/hooks` (preliminary run): `17 hooks on 8 events` at the top. The PreToolUse rows are only the following 2, and the `--settings` hook does not appear.

```
PreToolUse  before tool execution
❯ [Plugin] export PATH="$($SHELL -l…   claude-mem@thedotmack
  [Plugin] sh ${CLAUDE_PLUGIN_ROOT}…   agent-web-memory@agent-w…
```

(Even so, the hook itself fires. `hook_success` remains in the transcript.)

#### E1-3 Esc / ctrl+c (`timeout: 3600`, wait mode, settings without statusMessage)

`E1-3-esc.json`:

```json
"started_at": "2026-10-02T04:00:55.136Z", "ended_at": "2026-10-02T04:01:07.194Z", "exit_code": 143,
"events": [{"msg":"wait: still waiting (9s)"},{"at":"2026-10-02T04:01:07.194Z","msg":"received SIGTERM"}]
```

Screen:

```
⏺ User declined to answer questions
  ⎿  · A と B のどちらにしますか? (A / B)
```

transcript (lines 48, 49):

```jsonl
{"type":"user","message":{"content":[{"type":"tool_result","content":"The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.","is_error":true,...}]}}
{"type":"user","message":{"content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]}}
```

- The hook received SIGTERM at the moment of Esc (after 12 seconds) and exited 143. The process does not survive. Claude gives no reply and the turn ends there (until the next input prompt on screen). There is no `hook_cancelled` line (because it was not via timeout).
- ctrl+c (`E1-3-ctrlc.json`): same. `received SIGTERM` (after 12.4 seconds), screen `User declined to answer questions`, and the same 2 lines in the transcript.
- In this verification Esc and ctrl+c were each done once. Not repeated with settings that have `statusMessage`.

#### E1-4 Notification hook

`settings-notif.json` (PreToolUse 3600 + Notification, no matcher), wait mode:

- During the 74-second wait (`E1-4-notification-wait.json`: 04:04:03.698Z to 04:05:17.793Z), there were 0 Notification logs.
- After the wait ended and Claude finished its turn, there was 1 at 04:06:19.409Z (`E1-4-notification-idle_prompt.json`):

```json
{"session_id":"a2cb7e34-…","hook_event_name":"Notification","message":"Claude is waiting for your input","notification_type":"idle_prompt", ...}
```

- Conclusion: "Notification does not fire while a PreToolUse hook is blocking and waiting (within the 74-second range)". No Notification hook was included in the 660-second runs.

### E2 Variants of `answers` (mode `auto`, the question is "A と B のどちらにしますか")

Sonnet put a half-width `?` on the question text (verification 01 had full-width `？`). `mismatch` used as its key a string with the trailing `？` / `?` dropped.

| Variant | answers the hook returned | tool_result (transcript original) | Screen | Claude's reply |
|---|---|---|---|---|
| freetext | `{"A と B のどちらにしますか?": "どちらでもない。C にしてください"}` | `The user answered: "A と B のどちらにしますか?"="どちらでもない。C にしてください". Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.` | `User answered Claude's questions: · … → どちらでもない。C にしてください` | 「回答: 『A と B のどちらにしますか?』=『どちらでもない。C にしてください』」 (no error) |
| multi | `{"A・B・C から選んでください(複数選択可)": "A, C"}` (the question has `multiSelect: true`) | `Your questions have been answered: "A・B・C から選んでください(複数選択可)"="A, C". You can now continue with these answers in mind.` | `→ A, C` | 「A・C を選択」 |
| missing | `{}` | `The user did not answer the questions.` (`toolUseResult.answers` is `{}`) | Not captured | 「回答は返ってきませんでした」. Also mentioned the possibility that "the hook is intercepting", citing past memory (claude-mem) |
| mismatch | `{"A と B のどちらにしますか": "B"}` | `The user did not answer the questions.` (the hook's value remains in `toolUseResult.answers`) | Not captured (in the preliminary run, `→ A` was displayed) | 「回答は返ってきませんでした」 |
| partial (2 questions) | `"A"` for the first question only | `Your questions have been answered: "A と B のどちらにしますか?"="A". You can now continue with these answers in mind.` | Not captured | 「回答を受け取れたのは 1 問目だけです。2 問目の回答は返ってきませんでした」 |

- None of them becomes a tool error (`is_error`). `exitCode` of `hook_success` is 0.
- Only `freetext` changes the opening of the tool_result to `The user answered:`. A value that matches a label gives `Your questions have been answered:`.
- Logs: `E2-freetext.json` / `E2-multi.json` / `E2-missing.json` / `E2-mismatch.json` / `E2-partial.json`; the first mismatch run is `E1-1-timeout3600-wait.json`.

### E3 Deny of ExitPlanMode and the mode after approval (`--permission-mode plan`, `settings-e3.json`)

Prompt: 「verification/e3-note.md に 1 行書く計画を立てて ExitPlanMode で承認を求めてください。承認まで実装しないでください」

#### E3-1 deny → resubmit (mode `deny`, allow the second time)

Hook logs (`E3-1-deny.json` / `E3-1-resubmit-allow.json`):

```
call #1  04:16:28.762Z  deny   plan_chars=403
call #2  04:16:35.091Z  allow  plan_chars=673
```

transcript (session `80d4c384-…`):

```
行 45  tool_use ExitPlanMode {"plan":"# 計画: … 1 行書く\n## Context …\n## 変更 …\n## 検証 …","planFilePath":"…/verification-e3-note-md-1-linear-bunny.md"}
行 46  tool_result ERR "PreToolUse:ExitPlanMode hook error: 計画に Mermaid の図と『影響範囲と可逆性』の節を足して、もう一度 ExitPlanMode で提出してください"
行 52  tool_result "The file …/verification-e3-note-md-1-linear-bunny.md has been updated successfully."   ← plan ファイルを編集
行 56  tool_use ExitPlanMode {"plan":"…## 流れ ```mermaid flowchart LR … ## 影響範囲と可逆性 …"}
行 58  tool_result "User has approved your plan. You can now start coding. …"
```

(`行` = line. Line 52 annotation: "← plan file was edited".)

- The deny reason was passed to Claude prefixed with `hook error:`, and Claude edited the plan file (`~/.claude/plans/…`) and then resubmitted. It was fixed in one try. deny to resubmission took 6.3 seconds (`28.762` → `35.091`).
- The revised plan contained `mermaid` `flowchart LR` and `## 影響範囲と可逆性` (`plan_snapshot` saved in `E3-1-resubmit-allow.json`). Characters 403 → 673. 2 round trips.

#### E3-2 Status line after approval

Status line after rejecting the post-approval Write permission prompt with Esc:

```
  [Sonnet 5.5:medium] #10 | 5h: 27% (1h33m) | 7d: 10% (20h43m) | ct…
  ⏸ manual mode on · ← 1 agent
```

- At the same time, the PermissionRequest hook log (`E3-2-permissionrequest-observed.json`) has `permission_mode: "default"` (= manual) and `tool_name: Write`.

#### E3-3 Extra field (mode `plan-extra`, session `82679430-…`)

- The `updatedInput` the hook returned was `{plan, planFilePath, permissionMode: "auto"}` (`stdout` in `E3-3-extra-permissionMode.json`).
- No error. The tool_result was the usual `User has approved your plan…`. The status line was `⏸ manual mode on` (after approval, after the following Bash permission prompt appeared and was rejected with Esc). The mode does not change.
- In this run, Claude tried to write with Bash instead of Write, so PermissionRequest (matcher `Write|Edit`) did not fire.

#### E3-4 `setMode` via PermissionRequest (mode `auto` + `UKAGAI_PERM=setmode`, session `e87df0c5-…`)

JSON the hook returned for PermissionRequest (`stdout` in `E3-4-setmode-permissionrequest.json`):

```json
{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedPermissions":[{"type":"setMode","mode":"auto","destination":"session"}]}}}
```

Screen (Write after approval):

```
  ⎿  Allowed by PermissionRequest hook
⏺ verification/e3-note.md を作成し、…
  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent
```

- No permission prompt appeared and the status line was `auto mode on`. Even when Write was requested in the next turn, the PermissionRequest hook was not called (no log added) and no prompt appeared. This is as the official documentation describes `updatedPermissions` / `setMode`.
- In this run, "after approval, create the file with the Write tool" was added to the prompt (because if Claude chooses Bash, it does not hit the PermissionRequest matcher).

#### E3-5 Long deny reason (`UKAGAI_LONG_REASON=1`, session `5d3d0741-…`)

- The reason was 1069 characters and 25 lines (about 2.5 KB in UTF-8). The screen showed the first 9 lines and folded the rest:

```
  ⎿  Error: PreToolUse:ExitPlanMode hook error: 計画に Mermaid
     の図と『影響範囲と可逆性』の節を足して、もう一度 ExitPlanMode
     で提出してください
     (補足 1) 図は flowchart で、節は見出し二つ分にしてください。
     …
     (補足 9) 図は flowchart で、節は見出し二つ分にしてください。
     … +16 lines
```

- The transcript's tool_result is 1069 characters and contains the trailing `[END-OF-REASON-MARKER]` and `補足 24`. There is no truncation. Claude fixed the plan and resubmitted (`E3-long-*.json`, 566 characters the second time).

### E4 Round trip of making Claude write an explanation via deny (mode `explain-deny`)

Hook behavior: among `<scratchpad_dir>/ukagai/*.md`, look for files within 10 minutes that are not `.used.md`, and adopt the one whose front matter `question:` matches the question text exactly (if none match and there is exactly one candidate, `match: recency`). If none, deny; if found, allow + inject the second option, rename it to `.used.md`, and save the content in the log. There are 2 kinds of deny reason text (imperative = "…書いてください" ("please write…"), fact = "…説明が無いため保留されました。…出すことを求めます" ("held because there is no explanation. … we ask that you submit …")). Both contain the absolute save path, the original text to put in `question:`, and the specification of front matter and sections.

| Run | Decision | Model | Permission mode | Reason text | Round trips (AskUserQuestion calls) | 1st deny → 2nd call | Same question? | Explanation file |
|---|---|---|---|---|---|---|---|---|
| r1 | design fork | Sonnet | default | imperative | 2 | 18.1 s | Same (exact match) | 1373 chars, with diagram and diff |
| r2 | design fork | Opus | acceptEdits | imperative | 2 | 14.2 s | Same | 1320 chars, with diagram and diff |
| r3 | deletion | Sonnet | plan | imperative | 2 | 11.1 s | Same | 540 chars |
| r4 | deletion | Opus | default | imperative | 2 (see note below) | 27.1 s | Same | 565 chars |
| r5 | naming | Sonnet | acceptEdits | imperative | 2 | 7.4 s | Same | 657 chars |
| r6 | naming | Opus | plan | imperative | 1 (no re-call) | - | Stopped in prose | Not written |
| r7 | design fork | Sonnet | auto | fact | 2 | 11.3 s | Same | 717 chars, with diagram |
| r8 | deletion | Sonnet | auto | fact | 2 | 9.8 s | Same | 437 chars |
| r9 | naming | Opus | auto | imperative | 2 | 12.5 s | Same (full-width "？" kept) | 506 chars |

- The question text did not change on re-call after deny, and was adopted with `match: question` in all runs. `match: recency` did not occur.
- Breakdown: imperative 7 runs (re-call in 6, none only in r6), fact 2 runs (re-call in 2). With these counts, a difference in re-call rate cannot be judged.
- Note on r4: after deny, Opus issued investigative Bash (including `git ls-files`), a permission prompt appeared in default mode and it stopped. I rejected it with Esc and asked additionally "git は使わずに、説明ファイルを書いて同じ質問をもう一度 AskUserQuestion で出してください" ("don't use git; write the explanation file and ask the same question again with AskUserQuestion"), after which it wrote and re-called (the 27.1 seconds includes waiting for my action). This run had an extra instruction, so it is not counted as a pure result. The first deny log of r4 was overwritten by a rename collision and lost (the deny remains in the transcript. It was fixed afterwards so numbers do not collide).
- Claude's text in r6 (Opus, plan mode): 「ukagai の hook がこの質問を保留にしました。… ただ、今はプランモード中で、プランファイル以外は編集できません。そのため説明ファイルを書けず、質問をまだ出せていません。プランモードを解除してもらえれば…」. It did not actually attempt Write. Sonnet in the same plan mode (r3) could write to the scratchpad (`Made 1 scratchpad edit`). Whether this is a model difference is undetermined since it is one run each.
- Writes to the scratchpad (C2): no permission prompt in default (r1), acceptEdits (r2, r5), plan (Sonnet r3), and auto. The way of writing was a mix of Write and Bash heredoc (Opus sometimes writes with Bash).
- Format of the written files (full text in `verification/log/E4-r*-explain.md`): front matter `ukagai` / `for` / `question` / `title` / `reversibility` / `scope`, and the sections "なぜ今この判断が要るか" (why this decision is needed now) and "選択肢の比較" (comparison of options, a table) were complete in 8/8. `reversibility` was an enumerated value (`reversible` / `irreversible`) and `scope` was an enumerated value (`file` / `repo`). A diagram (` ```mermaid `) appeared only in the 3 design-fork runs (r1, r2, r7), and a diff only in r1 and r2. The deletion and naming runs had no diagram ("if structure or flow is involved" was sufficient).
- Mermaid syntax was checked by eye only (not rendered): in r1, r2 and r7, `flowchart TD/LR`, nodes `A[…]`, branches `B{…}`, and labeled arrows `-- ある -->` show no syntax errors.

Explanation file of r1 (excerpt; full text in `E4-r1-design-sonnet-default-2-explain.md`):

```markdown
---
ukagai: 1
for: AskUserQuestion
question: verification/hook.mjs の wait モードは、ポーリングと fs.watch のどちらにしますか?
title: hook.mjs wait モードの待機方式
reversibility: reversible
scope: file
---
## なぜ今この判断が要るか
…
## 選択肢の比較
| 選択肢 | 利点 | 欠点 | コスト |
|---|---|---|---|
| ポーリングのまま | 実装が単純。OS 差やイベントの取りこぼしがない。… | 検知が最大 1 秒遅れる。… | 変更なし |
| fs.watch に変更 | 検知がほぼ即時。… | macOS と Linux でイベントの挙動が違い、重複発火や取りこぼしが起きる。… | 数十行の書き換えと、E1〜E5 の再検証 |
## 図  (```mermaid flowchart TD …)
## 関係する差分  (```diff …)
```

r3 (deletion, 540 chars) has only a table and "なぜ今" (why now); irreversibility (`reversibility: irreversible`) is in the front matter, but the body has no emphasis saying it "cannot be undone".

Deny reason text (imperative, from `stdout` of `E4-r1-…-1-AskUserQuestion.json`. The path changes per session):

```
この質問は保留されました。人が判断するための説明を `<scratchpad_dir>/ukagai/<任意の名前>.md` に Markdown で書いてください。先頭に front matter(ukagai: 1、for: AskUserQuestion、question: 次の文字列をそのまま書く: `<質問文の原文>`、title、reversibility: reversible|costly|irreversible、scope: file|repo|machine|external)。本文は見出し「なぜ今この判断が要るか」「選択肢の比較」(表。各選択肢の利点・欠点・コスト)、構造や流れが関わるなら「図」(```mermaid)、コード変更が絡むなら「関係する差分」(```diff)。書き終えたら、同じ質問を AskUserQuestion でもう一度出してください。
```

### E5 Writing in advance with only SessionStart's additionalContext (mode `explain-observe`, `settings-e5.json`)

Text the SessionStart hook returned (`<scratchpad_dir>` is the value from stdin):

```
人に判断を求める前(AskUserQuestion / ExitPlanMode を呼ぶ前)に、説明を `<scratchpad_dir>/ukagai/<自由な名前>.md` に書くこと。
形式: front matter(ukagai: 1、for: AskUserQuestion、question: 聞く質問文の原文、title、reversibility、scope)+「なぜ今この判断が要るか」「選択肢の比較」(表)。構造や流れが関わるなら「図」(```mermaid)。
ディレクトリが無ければ作ること。説明は質問ごとに 1 ファイル。
```

- In the transcript it appears as `hook_additional_context` (`system-reminder: SessionStart hook additional context: …`).

| Run | Decision | Model | Did the file exist at the time of the first call? | match | How written | Explanation length (chars) |
|---|---|---|---|---|---|---|
| r1 | design fork | Sonnet | Yes | question | Bash | 734 |
| r2 | design fork | Opus | Yes | question | Bash | 1093 |
| r3 | deletion | Sonnet | Yes | question | Write | 609 |
| r4 | deletion | Opus | Yes | question | Bash | 1051 |
| r5 | naming | Sonnet | Yes | question | Write | 618 |
| r6 | naming | Opus | Yes | question | Bash | 492 |

- Rate at which the file existed: 6/6. In all runs AskUserQuestion was called only once (no deny). The time from receiving additionalContext to the question was about 15 to 27 seconds (some runs include an investigative Bash).
- Quality, from the same viewpoint as E4: front matter keys, "なぜ今" and the table were complete in 6/6, and `question:` matched the original in all runs. A diagram appeared only in r2 and r4 (in r2 the diagram's meaning fits the actual situation, in r4 it is a relationship diagram `hook → log → docs`). diff 0/6.
- Premise (because the enumerated values were not written in additionalContext): `reversibility` / `scope` did not follow the enumerated values and became free text. Example: `reversibility: 高い(verification/hook.mjs の 268-298 行目だけの差し替えで、いつでも戻せる)`, `scope: verification/hook.mjs の wait モードのみ。…`. E4 (where the enumerated values were written in the deny reason) followed the enumerated values.
- `/clear` (`E5-clear-*.json`, session `feca91f9-…`): after `/clear`, SessionStart fired again with `source: "clear"`, and `session_id` changed to `836fc24d-…` (`scratchpad_dir` was also that of the new session). additionalContext was re-injected with the new session_id / scratchpad path, and to "SessionStart の追加指示を復唱して" ("repeat the additional SessionStart instructions"), Claude repeated the 3 lines with the new path.
- Note: because claude-mem's SessionStart context is also injected at the same time, in some runs Claude's reply mixes in references to "past records" (E2-missing, etc.).

### E6 AskUserQuestion inside a subagent, and SubagentStart

Done with Explore (session `a3e61061-…`, subagent `adab6629457cfddf3`) and general-purpose (`a464cb492ba5eb631`). In both, the request was meant to be synchronous, but the metadata recorded `requestShape: "background"` and `requestNonInteractive: true` (Claude Code automatically started them as background and non-interactive).

- Subagent transcript (`…/subagents/agent-*.jsonl`): the result of `ToolSearch {"query":"select:AskUserQuestion"}` is `No matching deferred tools found`. AskUserQuestion is not in the subagent's tool list, and PreToolUse (AskUserQuestion) did not fire (no AskUserQuestion log in `verification/log/`). How a question would appear in the parent terminal could not be observed because the question itself does not occur.
- stdin of the SubagentStart hook (`E6-subagentstart-explore.json`, timeout 5, sync):

```json
{"session_id":"a3e61061-…","transcript_path":"…/a3e61061-….jsonl","cwd":"…","scratchpad_dir":"…/a3e61061-…/scratchpad","prompt_id":"7c7f877e-…","agent_id":"adab6629457cfddf3","agent_type":"Explore","hook_event_name":"SubagentStart"}
```

- `session_id` and `scratchpad_dir` are the same as the parent's. `agent_id` is a 17-character alphanumeric (`a` + 16 hex digits), and `agent_type` is `Explore` / `general-purpose`.
- additionalContext (`起動時指示: 合言葉は ukagai-7f3a。…`) entered the subagent's transcript as `hook_additional_context` and `<system-reminder>SubagentStart hook additional context: …`. In its final report the subagent stated that "the passphrase (ukagai-7f3a) was included in the additional startup instructions". The parent Claude treated the instruction-like text in the report as "the subagent's output, not your instruction" (I wrote "repeat it back" in my prompt, but the request text to the subagent was cut off midway and the second item was not passed, so the repeat itself was not obtained).
- AskUserQuestion by a subagent started synchronously (foreground) is unverified (both became background).

### E7 Measured fail-open (mode `unreachable`)

`E7-unreachable.json`:

```
started_at 04:13:19.760Z / ended_at 04:13:19.791Z / exit 0 / stdout null
"unreachable: fetch failed after 30ms (TypeError) -> no output"
```

- `http://127.0.0.1:1/` failed in 30 ms by connection refusal (the 1-second timeout was not reached). In the transcript, from `tool_use` (`04:13:19.704Z`) to hook end was 87 ms.
- The screen (`--source visible`) was the normal question UI (`☐ 選択 / A と B のどちらにしますか? / 1. A 2. B 3. Type something. 4. Chat about this`). It was already displayed when `herdr agent wait --until blocked` returned (seconds until the UI displayed were not measured even at 1-second resolution). Choosing with Enter returned the answer as usual.
- This is a different path from the SIGTERM path of verification 01 T3a (timeout reached). A server that accepts the connection but does not respond (waiting until the timeout is reached) was not tried in this verification.

## Voided runs

- `void-E7-try1-mode-was-auto.json`: the first run of E7. `set -x UKAGAI_MODE unreachable` had not taken effect and it ran in mode `auto` (`auto: variant=partial`). Not included in the results. From the second run, the env was checked with `env | grep UKAGAI` before starting.
- `void-misfire-E5-r{2..6}-…-SessionStart.json`: a misfire of E5. The loop's shell was zsh and did not word-split the variable, so 5 sessions were started with an empty prompt (only SessionStart logs). Not included in the results, and retaken under the same conditions.

## Changed files (under `verification/`)

`hook.mjs` (extended), `settings.json` (`timeout` 3600 + `statusMessage`), `settings-86400.json`, `settings-notif.json`, `settings-e3.json`, `settings-e5.json`, `settings-e6.json`, `e3-note.md` (created by Claude with Write after approval in E3-4), `state/` (counters for tests), `log/` (raw hook logs and full text of explanation files).

## List of unverified items and speculation

- With both `timeout: 3600` / `86400` the hook survived beyond 660 seconds, but anything longer (over 1 hour) is unverified. No condition was found where the upper limit is lower than `3600` or `86400`. Other side effects on the Claude Code side when `timeout` is large are unconfirmed.
- That a `--settings` hook does not appear in `/hooks` is from a single screen's observation. Whether it would appear via `settings.json` is unverified. Startup warnings were checked only in the last 49 lines of the startup screen.
- Esc / ctrl+c were each observed once, with settings without `statusMessage`. It can be read that Esc was processed as a tool rejection rather than an "interrupt to Claude", but the internal path is speculation.
- Notification: 0 events during the 74-second wait, and no Notification hook was included in the 660-second runs. Other types such as `permission_prompt` were not observed.
- E2: the screen displays for missing / mismatch / partial were not captured (only `→ A` appeared in the preliminary mismatch). The case of `multiSelect` "including a value not among the labels" is unverified.
- E3: Claude does not necessarily edit the plan every time (in the first session it was an Edit-equivalent "updated successfully" rather than Write). That one deny fixed it is from only 2 observations. `setMode` was observed only with Write's PermissionRequest (whether the same happens with a Bash permission prompt is unverified). The long reason was tried once.
- E4: n is small (9 runs; model, mode and reason text differ per run, so factors cannot be separated). `match: recency` (when the question text is reworded) and the handling of old files over 10 minutes are unverified. Whether the abandonment in Opus × plan mode reproduces is unconfirmed. Mermaid was not rendered.
- E5: only 6 runs. Whether `reversibility` / `scope` would be correct if enumerated values were written in additionalContext is unverified (speculation: they would). The case where Claude does not write an explanation (rate 0) was not observed.
- E6: how a subagent's question appears in the parent terminal was not observed, because asking is not possible in the first place. Synchronously started subagents and configurations such as `--permission-prompt-tool` are unverified.
- E7: only connection refusal (immediate failure). The path of the 1-second timeout against a non-responding server is unverified.
- Only a few runs each of Sonnet 5.5 / Opus 5.5. Anything other than Claude Code 2.1.287 is unverified. In some runs, additional context from the environment's claude-mem hook may be affecting Claude's replies.

## How sections 3 and 4 of plan 03 should be revised

- Section 3 "route of the explanation" (説明の経路): the location can be fixed as `<scratchpad_dir>/ukagai/` with `question:` matching (all 8 runs were `match: question` in E4, and 6/6 in E5). deny can be demoted to a safety net (6/6 with SessionStart alone), but the enumerated values (`reversibility` / `scope`) should also be written in additionalContext (otherwise they become free text).
- Section 3 "fail-open" (フェイルオープン) and budget: with `timeout` 3600 / 86400 the hook passed beyond 660 seconds, so setting `timeout` to 3600 produced no warning. The waiting display can be produced with `statusMessage` (at the head of the spinner line). Esc / ctrl+c send SIGTERM to the hook and the turn ends treated as "rejected", so the premise should be that on SIGTERM the hook notifies the server with `hook_disconnected`.
- Section 3 "answers": use the stdin `question` as the key as is (half-width `?` / full-width `？` changes from run to run). Mismatch or omission is treated as unanswered (no error, and Claude suspects the hook). Free text can be passed but the opening of the tool_result changes. If only some of 2 questions are answered, only the answered ones are passed.
- Section 3 "ExitPlanMode": the rejection UI works (the deny reason is passed with `hook error:`, and the plan is fixed and resubmitted). The post-approval `manual` can be restored with PermissionRequest hook's `setMode: auto` (confirmed at Write with matcher `Write|Edit`), so the "candidate for week 2" in section 7 of the plan can be brought forward. Extra fields in `updatedInput` are ignored.
- Section 4: because of E6, state that AskUserQuestion by subagents does not appear in the GUI (no tool) and is out of scope. Notification does not ring while waiting. E7: immediate failure falls back to the normal UI in 87 ms. The E1 / E3 rows are filled by the above.
