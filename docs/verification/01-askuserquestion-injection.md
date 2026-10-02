# Verification 01: Injecting answers into AskUserQuestion via a PreToolUse hook

- Date: 2026-10-02
- Claude Code: `2.1.287 (Claude Code)` (`claude --version`)
- Node: v24.11.0 (runtime for the hook)
- The interactive session was started in the pane next to Herdr as `claude --settings verification/settings.json --model sonnet` (model Sonnet 5.5; started in auto mode because the global setting `defaultMode` is `auto`)
- Used: `verification/hook.mjs`, `verification/settings.json`, raw hook logs `verification/log/T*.json`
- Primary-source mapping: hook log = `verification/log/<test name>-<timestamp>.json`, transcript = `~/.claude/projects/-Users-user-dev-ukagai/<session_id>.jsonl`

## Results table

| Test | Condition | Result | Summary |
|---|---|---|---|
| T1 | interactive × auto | **Passed** | No question UI appeared; the hook's `answers` became the answer as is. Claude repeated "B" back |
| T2 | non-interactive (`claude -p`, no permission host) × auto | **Does not pass (hook does not fire)** | With `-p`, AskUserQuestion is not in the tool list. The hook was not called, and Claude asked back in prose, saying it could not use it in this environment |
| T3a | interactive × wait, no answer file, over 60 seconds | **Conditional: falls back to the normal UI on timeout** | The hook received SIGTERM at 60.056 seconds and exited. The transcript has `hook_cancelled` (`timedOut: true`). The normal question UI appeared on screen. No warning is shown on screen |
| T3a' | Place answer.json while the T3a UI is displayed | **Not picked up** | The hook process is already dead. The UI did not go away after waiting 10 seconds, and answer.json remained. Selecting "A" by hand continued as usual |
| T3b | interactive × wait, place answer.json first, then ask the question | **Passed** | The hook picked it up at 0 seconds and injected `answers`. The hook consumed answer.json |
| T3c | interactive × wait, place answer.json 29 seconds after the question | **Passed** | The hook was waiting (Herdr status stayed `working`, never `blocked`), picked it up after 29 seconds and injected it. Claude repeated "A" back |
| T4 | interactive × deny (reason: use ask_decision) | **Conditional: follows the reason, but asks in prose if the tool is missing** | Claude searched for `ask_decision` with `ToolSearch`, did not find it, and stopped after asking "A or B?" in prose |
| T5 | interactive × auto × ExitPlanMode (`--permission-mode plan`) | **Passed** | The plan approval UI did not appear and it became "User approved Claude's plan". However, the permission mode after approval became `manual` (confirm each edit), and a permission prompt appeared at the immediately following Write |

## Shape of the hook's stdin JSON (the real thing received in T1, `stdin` in `verification/log/T1-*.json`)

```json
{
  "session_id": "00000000-0000-4000-8000-000000000001",
  "transcript_path": "/Users/user/.claude/projects/-Users-user-dev-ukagai/00000000-0000-4000-8000-000000000001.jsonl",
  "cwd": "/Users/user/dev/ukagai",
  "scratchpad_dir": "/tmp/scratchpad",
  "prompt_id": "00000000-0000-4000-8000-000000000002",
  "permission_mode": "auto",
  "effort": { "level": "medium" },
  "hook_event_name": "PreToolUse",
  "tool_name": "AskUserQuestion",
  "tool_input": {
    "questions": [
      {
        "question": "A と B のどちらにしますか？",
        "header": "選択",
        "options": [
          { "label": "A", "description": "選択肢 A" },
          { "label": "B", "description": "選択肢 B" }
        ],
        "multiSelect": false
      }
    ]
  },
  "tool_use_id": "toolu_01C9XvdLwhw5t7NsMYWcdF4R"
}
```

- `tool_input.questions[].options[]` contains `label` and `description`. `answers` is not included (Claude does not set it, as in the official documentation).
- `tool_use_id` and `transcript_path` are included, so they serve as keys for matching questions and answers on the external UI side.
- Even though Sonnet was instructed with "A と B のどちらにしますか" (no question mark), it generated `question` with a trailing "？" (the same string in all 5 runs of T1, T3 and T4). The keys of `answers` must match `question` exactly, so the hook should use the `question` from stdin as the key as is. Hard-coding the string in advance may not match (T3b/T3c matched by coincidence with a hard-coded string. Behavior on mismatch is unverified).

## JSON returned by the hook (T1, `stdout` in `verification/log/T1-*.json`)

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "updatedInput": {
      "questions": [ ...stdin の questions をそのまま... ],
      "answers": { "A と B のどちらにしますか？": "B" }
    }
  }
}
```

## Observations per test

### T1 interactive × auto (session `00000000-0000-4000-8000-000000000001`)

Screen (`herdr agent read probe --source recent-unwrapped`):

```
❯ AskUserQuestion を使って『A と B のどちらにしますか』と選択肢 A・B
  で私に聞き、受け取った回答をそのまま一行で復唱してください

⏺ User answered Claude's questions:
  ⎿  · A と B のどちらにしますか？ → B

⏺ 「A と B のどちらにしますか？」への回答は「B」です。

✻ Worked for 4s · done 12:09
```

- The question UI (list of options) did not appear on screen. Herdr's agent status went `working` → `done`, without passing through `blocked` (detection of a question or approval UI).
- The hook took 67 ms (`hook_success.durationMs` in the transcript).
- There is no warning text on screen or in the transcript.

Relevant transcript lines (excerpt):

```jsonl
// 行 29: Claude が出した tool_use。入力に answers は無い(モデルが出した原文)
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_01C9XvdLwhw5t7NsMYWcdF4R","name":"AskUserQuestion","input":{"questions":[{"question":"A と B のどちらにしますか？","header":"選択","multiSelect":false,"options":[{"label":"A","description":"選択肢 A"},{"label":"B","description":"選択肢 B"}]}]}}]}}
// 行 30: hook の結果
{"attachment":{"type":"hook_success","hookName":"PreToolUse:AskUserQuestion","toolUseID":"toolu_01C9XvdLwhw5t7NsMYWcdF4R","hookEvent":"PreToolUse","stdout":"{\"hookSpecificOutput\":{...\"answers\":{\"A と B のどちらにしますか？\":\"B\"}}}}\n","stderr":"","exitCode":0,"command":"node /Users/user/dev/ukagai/verification/hook.mjs","durationMs":67}}
// 行 31: tool_result。toolUseResult に answers が入っている
{"type":"user","message":{"content":[{"type":"tool_result","content":"Your questions have been answered: \"A と B のどちらにしますか？\"=\"B\". You can now continue with these answers in mind.","tool_use_id":"toolu_01C9XvdLwhw5t7NsMYWcdF4R"}]},"toolUseResult":{"questions":[...],"answers":{"A と B のどちらにしますか？":"B"}}}
```

(Comments in the block above, translated: line 29 = tool_use emitted by Claude, with no answers in the input (the model's original output); line 30 = the hook's result; line 31 = tool_result, with answers in toolUseResult.)

- Answer to "are answers in the transcript's tool_use input?": they are not in the `input` of the tool_use (line 29). The injected values remain in `toolUseResult.answers` (line 31) and `hook_success.stdout` (line 30).

### T2 non-interactive × auto (session `00000000-0000-4000-8000-000000000003`)

Run:

```
UKAGAI_MODE=auto claude -p --settings verification/settings.json --output-format json --model sonnet "<T1 と同じ文>"
```

(`<T1 と同じ文>` means "the same sentence as T1".)

Output (`result` only, exit 0, stderr empty):

```
`AskUserQuestion` はこの環境で使えません。ツール一覧にも、遅延ツールの検索結果にもありませんでした。そのためダイアログでは聞けず、回答も受け取れていません。

代わりにここで聞きます。**A と B のどちらにしますか。** 返信してもらえれば、その内容を一行で復唱します。
```

- No new file was created in `verification/log/`, and the hook was never called.
- Tool names in `prompt_snapshot.tools` in the transcript: `Agent, Bash, Edit, ListAgents, Read, ReportFindings, ScheduleWakeup, ShareOnboardingGuide, Skill, ToolSearch, Workflow, Write`. AskUserQuestion is not there.
- Claude called `ToolSearch {"query":"select:AskUserQuestion"}`, and the result was `No matching deferred tools found`.
- This agrees with the official documentation's statement that "`-p` provides AskUserQuestion only when there is a permission host". The case with `--permission-prompt-tool` was not tried in this verification (speculation: per the documentation the tool should be provided and the hook should fire, but this is unconfirmed).

### T3 interactive × wait (session `00000000-0000-4000-8000-000000000004`)

#### T3a: waiting without placing answer.json

Hook log (`verification/log/T3a-*.json`, excerpt):

```json
"started_at": "2026-10-02T03:11:29.883Z",
"ended_at":   "2026-10-02T03:12:29.858Z",
"stdout": null,
"exit_code": 143,
"events": [ ..., {"at":"2026-10-02T03:12:28.966Z","msg":"wait: still waiting (59s)"},
                 {"at":"2026-10-02T03:12:29.858Z","msg":"received SIGTERM"} ]
```

Relevant transcript line (line 30):

```jsonl
{"attachment":{"type":"hook_cancelled","hookName":"PreToolUse:AskUserQuestion","toolUseID":"toolu_0122etacZmjCja5X9ygeaVdu","hookEvent":"PreToolUse","command":"node /Users/user/dev/ukagai/verification/hook.mjs","durationMs":60056,"timedOut":true,"timeoutMs":60000},"timestamp":"2026-10-02T03:12:29.860Z"}
```

Screen right after the timeout (`--source visible`. During this time Herdr's status is `blocked`):

```
❯ AskUserQuestion を使って『A と B のどちらにしますか』と選択肢 A・B
  で私に聞き、受け取った回答をそのまま一行で復唱してください
──────────────────────────────────────────────────────────────────────
 ☐ 選択

A と B のどちらにしますか？

❯ 1. A
     選択肢 A
  2. B
     選択肢 B
  3. Type something.
──────────────────────────────────────────────────────────────────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
```

- The hook received SIGTERM at exactly the `timeout: 60` in settings and exited (confirmed with `pgrep` that the process was gone), and the tool fell back to the normal question UI. It is neither an error nor a tool failure.
- No warning about the hook timeout appears on screen (only a `hook_cancelled` line remains in the transcript).
- Even after placing `answer.json` while the UI was displayed and waiting 10 seconds, the status stayed `blocked` and `answer.json` remained (the hook is already dead, so it cannot pick it up).
- Pressing Enter by hand (option 1 = A) continued as usual; the tool_result was `"A と B のどちらにしますか？"="A"`, and Claude repeated back "回答は『A』でした".

#### T3b: placing answer.json first, then asking the question

- Hook log `T3b-*.json`: `"wait: answer.json found after 0s"`, `answers: {"A と B のどちらにしますか？": "B"}`, exit 0.
- Screen: `User answered Claude's questions: · A と B のどちらにしますか？ → B`, repeated back "B". The question UI does not appear.
- The hook consumed (unlinked) `answer.json`.

#### T3c: placing answer.json 29 seconds after the question

- Hook log `T3c-*.json`: `started_at 03:14:49.642Z`, `"wait: still waiting (19s)"`, `"wait: answer.json found after 29s"`, `ended_at 03:15:18.684Z`, exit 0.
- While waiting: `herdr agent wait probe --until blocked --timeout 20000` timed out (= Herdr did not detect a question UI). Confirmed with `pgrep` that the hook process (pid 42830) was alive.
- The hook picked up `answer.json` (`{"A と B のどちらにしますか？": "A"}`) immediately after it was placed, and Claude repeated back "回答は『A』でした". The screen showed `Sautéed for 33s · done`.

### T4 interactive × deny (session `00000000-0000-4000-8000-000000000005`)

JSON returned by the hook (`T4-*.json`):

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"文章で質問せず、MCP ツール ask_decision を使ってください"}}
```

Screen:

```
❯ AskUserQuestion を使って『A と B のどちらにしますか』と選択肢 A・B
  で私に聞き、受け取った回答をそのまま一行で復唱してください
  ⎿  Error: PreToolUse:AskUserQuestion hook error: 文章で質問せず、MCP
     ツール ask_decision を使ってください

⏺ 質問できませんでした。AskUserQuestion
  はフックに拒否され、代わりに使うよう指示された MCP ツール
  ask_decision はこのセッションに存在しません（ToolSearch
  でも見つかりませんでした）。

  ask_decision を使える状態にするか、フックの設定を見直してください。
  もしくはここで「A」か「B」と直接答えてもらえれば、それを復唱します。

✻ Brewed for 9s · done 12:16
```

Relevant transcript lines (excerpt):

```
行 30: tool_use AskUserQuestion {"questions":[{"question":"A と B のどちらにしますか？", ...}]}
行 31: tool_result is_error=True "PreToolUse:AskUserQuestion hook error: 文章で質問せず、MCP ツール ask_decision を使ってください"
行 41: tool_use ToolSearch {"query":"ask_decision","max_results":5}
行 42: tool_result "No matching deferred tools found"
行 45: text 「質問できませんでした。... もしくはここで「A」か「B」と直接答えてもらえれば、それを復唱します。」
```

(Line numbers: 30 = tool_use, 31 = tool_result error, 41 = ToolSearch call, 42 = result, 45 = text.)

- Claude followed the reason text and searched for `ask_decision` (once). Because it does not exist, it asked again in prose and ended the turn. It does not hang.
- Whether it would actually use `ask_decision` if it were provided over MCP was not tried in this verification.

### T5 interactive × auto × ExitPlanMode (session `00000000-0000-4000-8000-000000000006`)

- Changed the matcher in `verification/settings.json` to `AskUserQuestion|ExitPlanMode` and started with `--permission-mode plan`. The status line right after startup was `⏸ plan mode on`.
- Prompt: 「verification/t5-note.md という新規ファイルに『T5 検証メモ』という 1 行だけを書く作業の計画を立て、ExitPlanMode で私に承認を求めてください。承認されるまで実装しないでください。」

Hook stdin (`T5-*.json`, `tool_input`. `plan` and `planFilePath` are injected, as in the official documentation):

```json
{"plan": "# T5 検証メモ作成計画\n\n## Context\n...", "planFilePath": "/Users/user/.claude/plans/verification-t5-note-md-t5-1-curried-valiant.md"}
```

The hook returned `permissionDecision: "allow"` and `updatedInput: <tool_input as is>` (took 73 ms).

Relevant transcript lines (excerpt):

```
行 49: tool_use ExitPlanMode {"plan": "...", "planFilePath": "..."}
行 50: attachment hook_success PreToolUse:ExitPlanMode exitCode 0 durationMs 73
行 51: tool_result "User has approved your plan. You can now start coding. ... ## Approved Plan: ..."
行 52: attachment plan_mode_exit {"planFilePath": "...", "planExists": true}
行 56: tool_use Write {"file_path": "/Users/user/dev/ukagai/verification/t5-note.md", "content": "T5 検証メモ\n"}
行 57: tool_result "The user doesn't want to proceed with this tool use. ..."(検証側が Esc で拒否)
```

(Line numbers: 49 = tool_use, 50 = hook_success, 51 = tool_result, 52 = plan_mode_exit, 56 = Write tool_use, 57 = tool_result; the verifier rejected it with Esc.)

Screen (right after approval):

```
⏺ User approved Claude's plan
  ⎿  Plan saved to:
     ~/.claude/plans/verification-t5-note-md-t5-1-curried-valiant.md ·
     /plan to edit
     T5 検証メモ作成計画
     ...

⏺ Write(verification/t5-note.md)
 Create file
 verification/t5-note.md
  1 T5 検証メモ
 Do you want to create t5-note.md?
 ❯ 1. Yes
   2. Yes, and switch to accept edits (auto-approve file edits and
      common file commands) for this session (shift+tab)
   3. No
```

Status line after rejecting with Esc: `⏸ manual mode on`

- The plan approval UI (normally where you choose "approve and auto-edit / manual approval / reject") did not appear, and the hook's allow alone produced "User approved Claude's plan". Herdr also did not detect `blocked` (it became `blocked` at the permission prompt of the next Write).
- The permission mode after approval is `manual` (as shown in the status line). It does not return to the session-start global default `auto`, nor does it become the `acceptEdits` you get when choosing "auto-accept edits" in the normal approval UI. When approving by injection, there is no path for choosing the mode after approval. No post-approval `permission-mode` record was appended to the transcript (only 3 `plan` records).
- `verification/t5-note.md` was not created (the Write was rejected).

## Summary of timeout behavior

- When the settings `timeout` (seconds) is reached, Claude Code sends SIGTERM to the hook process (60.056 seconds in T3a), discards the hook's output, and the tool proceeds to the normal permission flow (= the standard question UI). A `hook_cancelled` (`timedOut: true, timeoutMs`) remains in the transcript. No warning appears on screen.
- Even if an answer is prepared after the timeout, it does not reach the hook of that call. For the hook to pick it up, the answer is needed while the hook process is alive (= within `timeout`).
- Within `timeout`, the hook keeps blocking, and Claude Code waits treating it as "tool running" (29 seconds in T3c). During this time Herdr judges it as `working`, and no question UI appears.
- The upper limit of `timeout`, and side effects of lengthening `timeout` (e.g. status line display, firing of the `Notification` hook), are unverified. In the official documentation the default for the command type is 600 seconds.

## Unverified (how speculation is handled)

- Behavior when a key of `answers` does not match `question`, or when `answers` is partially missing.
- Whether the hook fires when `-p` is combined with `--permission-prompt-tool`.
- Whether the deny reason is followed when the MCP tool `ask_decision` is actually provided (T4 covers only the case where it does not exist).
- The shape of `answers` for a question with `multiSelect: true` (the documentation says "labels joined by commas").
- Reproduction on Claude Code versions other than this one, and on models other than Sonnet.

## Verdict

- Whether to proceed to implementation: **Yes, proceed.** Injection via `allow` + `updatedInput.answers` works in interactive sessions too (T1, T3b, T3c), and approval injection for ExitPlanMode also works (T5).
- Approach: **Injection.** The deny-alternative approach (T4) is followed up to Claude searching for the tool, but the response becomes asking again in prose, so unlike injection it cannot return the answer in one round trip. The injection approach has two constraints: "an answer is needed within the hook's `timeout` (beyond it, it falls back to the standard UI)" and "after injected approval of ExitPlanMode, the mode becomes `manual`".
