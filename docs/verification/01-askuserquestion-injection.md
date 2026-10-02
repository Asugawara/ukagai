# 検証 01: PreToolUse hook による AskUserQuestion への回答注入

- 実施日: 2026-10-02
- Claude Code: `2.1.287 (Claude Code)`(`claude --version`)
- Node: v24.11.0(hook の実行系)
- 対話セッションは Herdr の隣 pane で `claude --settings verification/settings.json --model sonnet` として起動(モデルは Sonnet 5.5、グローバル設定の `defaultMode` が `auto` のため auto mode で起動)
- 使ったもの: `verification/hook.mjs`、`verification/settings.json`、hook の生ログ `verification/log/T*.json`
- 一次情報の対応表: hook ログ = `verification/log/<試験名>-<timestamp>.json`、transcript = `~/.claude/projects/-Users-user-dev-ukagai/<session_id>.jsonl`

## 結果表

| 試験 | 条件 | 結果 | 一言 |
|---|---|---|---|
| T1 | 対話 × auto | **通った** | 質問 UI は出ず、hook の `answers` がそのまま回答になった。Claude は「B」と復唱 |
| T2 | 非対話(`claude -p`、permission host なし)× auto | **通らない(hook が発火しない)** | `-p` では AskUserQuestion がツール一覧に無い。hook は呼ばれず、Claude は「この環境で使えません」と文章で聞き返した |
| T3a | 対話 × wait、回答ファイルを置かず 60 秒超 | **条件付き: timeout で通常 UI に落ちる** | 60.056 秒で hook が SIGTERM を受けて終了。transcript に `hook_cancelled`(`timedOut: true`)。画面に通常の質問 UI が出た。警告文は画面に出ない |
| T3a' | T3a の UI 表示中に answer.json を置く | **拾わない** | hook プロセスは既に死んでいる。10 秒待っても UI は消えず、answer.json も残ったまま。手で「A」を選ぶと通常どおり続いた |
| T3b | 対話 × wait、answer.json を先に置いて質問させる | **通った** | hook が 0 秒で拾い、`answers` を注入。answer.json は hook が消費 |
| T3c | 対話 × wait、質問から 29 秒後に answer.json を置く | **通った** | hook は待機中(Herdr の状態は `working` のまま、`blocked` にならない)、29 秒後に拾って注入。Claude は「A」と復唱 |
| T4 | 対話 × deny(理由: ask_decision を使え) | **条件付き: 理由には従うが、ツールが無いと文章で聞く** | Claude は `ToolSearch` で `ask_decision` を探し、見つからず、文章で「A か B か」と聞いて止まった |
| T5 | 対話 × auto × ExitPlanMode(`--permission-mode plan`) | **通った** | 計画承認 UI は出ず「User approved Claude's plan」になった。ただし承認後の権限モードは `manual`(編集に都度確認)になり、直後の Write で許可プロンプトが出た |

## hook の stdin JSON の形(T1 で受信した実物、`verification/log/T1-*.json` の `stdin`)

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

- `tool_input.questions[].options[]` には `label` と `description` が入る。`answers` は含まれない(公式ドキュメントどおり Claude 側は設定しない)。
- `tool_use_id` と `transcript_path` が入るので、外部 UI 側で質問と回答を突き合わせる鍵になる。
- Sonnet は「A と B のどちらにしますか」と指示しても末尾に「？」を付けて `question` を生成した(T1・T3・T4 の 5 回とも同じ文字列)。`answers` のキーは `question` と完全一致させる必要があるため、hook 側では stdin の `question` をそのままキーに使うべき。文字列を事前に決め打ちすると一致しない可能性がある(T3b/T3c は決め打ちで偶然一致した。不一致時の挙動は未検証)。

## hook が返した JSON(T1、`verification/log/T1-*.json` の `stdout`)

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

## 各試験の観察

### T1 対話 × auto(session `00000000-0000-4000-8000-000000000001`)

画面(`herdr agent read probe --source recent-unwrapped`):

```
❯ AskUserQuestion を使って『A と B のどちらにしますか』と選択肢 A・B
  で私に聞き、受け取った回答をそのまま一行で復唱してください

⏺ User answered Claude's questions:
  ⎿  · A と B のどちらにしますか？ → B

⏺ 「A と B のどちらにしますか？」への回答は「B」です。

✻ Worked for 4s · done 12:09
```

- 質問 UI(選択肢リスト)は画面に出なかった。Herdr の agent 状態は `working` → `done` で、`blocked`(質問・承認 UI の検出)を経由していない。
- hook の所要時間は 67 ms(transcript の `hook_success.durationMs`)。
- 警告文は画面にも transcript にも無い。

transcript の該当行(抜粋):

```jsonl
// 行 29: Claude が出した tool_use。入力に answers は無い(モデルが出した原文)
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_01C9XvdLwhw5t7NsMYWcdF4R","name":"AskUserQuestion","input":{"questions":[{"question":"A と B のどちらにしますか？","header":"選択","multiSelect":false,"options":[{"label":"A","description":"選択肢 A"},{"label":"B","description":"選択肢 B"}]}]}}]}}
// 行 30: hook の結果
{"attachment":{"type":"hook_success","hookName":"PreToolUse:AskUserQuestion","toolUseID":"toolu_01C9XvdLwhw5t7NsMYWcdF4R","hookEvent":"PreToolUse","stdout":"{\"hookSpecificOutput\":{...\"answers\":{\"A と B のどちらにしますか？\":\"B\"}}}}\n","stderr":"","exitCode":0,"command":"node /Users/user/dev/ukagai/verification/hook.mjs","durationMs":67}}
// 行 31: tool_result。toolUseResult に answers が入っている
{"type":"user","message":{"content":[{"type":"tool_result","content":"Your questions have been answered: \"A と B のどちらにしますか？\"=\"B\". You can now continue with these answers in mind.","tool_use_id":"toolu_01C9XvdLwhw5t7NsMYWcdF4R"}]},"toolUseResult":{"questions":[...],"answers":{"A と B のどちらにしますか？":"B"}}}
```

- 「transcript の tool_use 入力に answers が入っているか」への答え: tool_use(行 29)の `input` には入らない。注入後の値は `toolUseResult.answers`(行 31)と `hook_success.stdout`(行 30)に残る。

### T2 非対話 × auto(session `00000000-0000-4000-8000-000000000003`)

実行:

```
UKAGAI_MODE=auto claude -p --settings verification/settings.json --output-format json --model sonnet "<T1 と同じ文>"
```

出力(`result` のみ、exit 0、stderr 空):

```
`AskUserQuestion` はこの環境で使えません。ツール一覧にも、遅延ツールの検索結果にもありませんでした。そのためダイアログでは聞けず、回答も受け取れていません。

代わりにここで聞きます。**A と B のどちらにしますか。** 返信してもらえれば、その内容を一行で復唱します。
```

- `verification/log/` に新しいファイルは作られず、hook は一度も呼ばれていない。
- transcript の `prompt_snapshot.tools` に載っていたツール名: `Agent, Bash, Edit, ListAgents, Read, ReportFindings, ScheduleWakeup, ShareOnboardingGuide, Skill, ToolSearch, Workflow, Write`。AskUserQuestion は無い。
- Claude は `ToolSearch {"query":"select:AskUserQuestion"}` を呼び、結果は `No matching deferred tools found`。
- 公式ドキュメントの「`-p` では permission host がある場合だけ AskUserQuestion を提供する」の記述と一致する。`--permission-prompt-tool` を付けた場合は本検証では試していない(推測: ドキュメントどおりならツールが提供され hook が発火するはずだが、未確認)。

### T3 対話 × wait(session `00000000-0000-4000-8000-000000000004`)

#### T3a: answer.json を置かずに待つ

hook ログ(`verification/log/T3a-*.json`、抜粋):

```json
"started_at": "2026-10-02T03:11:29.883Z",
"ended_at":   "2026-10-02T03:12:29.858Z",
"stdout": null,
"exit_code": 143,
"events": [ ..., {"at":"2026-10-02T03:12:28.966Z","msg":"wait: still waiting (59s)"},
                 {"at":"2026-10-02T03:12:29.858Z","msg":"received SIGTERM"} ]
```

transcript の該当行(行 30):

```jsonl
{"attachment":{"type":"hook_cancelled","hookName":"PreToolUse:AskUserQuestion","toolUseID":"toolu_0122etacZmjCja5X9ygeaVdu","hookEvent":"PreToolUse","command":"node /Users/user/dev/ukagai/verification/hook.mjs","durationMs":60056,"timedOut":true,"timeoutMs":60000},"timestamp":"2026-10-02T03:12:29.860Z"}
```

timeout 直後の画面(`--source visible`。この間 Herdr の状態は `blocked`):

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

- hook は settings の `timeout: 60` ちょうどで SIGTERM を受けて終了し(`pgrep` でプロセスが消えていることを確認)、ツールは通常の質問 UI に落ちた。エラーにもツール失敗にもならない。
- 画面に hook の timeout を知らせる警告は出ていない(transcript に `hook_cancelled` 行が残るだけ)。
- UI 表示中に `answer.json` を置いて 10 秒待っても状態は `blocked` のままで、`answer.json` も残ったまま(hook は既に死んでいるので拾えない)。
- 手で Enter(選択肢 1 = A)を押すと通常どおり進み、tool_result は `"A と B のどちらにしますか？"="A"`、Claude は「回答は『A』でした」と復唱。

#### T3b: answer.json を先に置いてから質問させる

- hook ログ `T3b-*.json`: `"wait: answer.json found after 0s"`、`answers: {"A と B のどちらにしますか？": "B"}`、exit 0。
- 画面: `User answered Claude's questions: · A と B のどちらにしますか？ → B`、復唱「B」。質問 UI は出ない。
- hook が `answer.json` を消費(unlink)した。

#### T3c: 質問から 29 秒後に answer.json を置く

- hook ログ `T3c-*.json`: `started_at 03:14:49.642Z`、`"wait: still waiting (19s)"`、`"wait: answer.json found after 29s"`、`ended_at 03:15:18.684Z`、exit 0。
- 待機中: `herdr agent wait probe --until blocked --timeout 20000` が timeout した(= Herdr は質問 UI を検出していない)。`pgrep` で hook プロセス(pid 42830)が生きていることを確認。
- `answer.json`(`{"A と B のどちらにしますか？": "A"}`)を置いた直後に hook が拾い、Claude は「回答は『A』でした」と復唱。画面は `Sautéed for 33s · done`。

### T4 対話 × deny(session `00000000-0000-4000-8000-000000000005`)

hook が返した JSON(`T4-*.json`):

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"文章で質問せず、MCP ツール ask_decision を使ってください"}}
```

画面:

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

transcript の該当行(抜粋):

```
行 30: tool_use AskUserQuestion {"questions":[{"question":"A と B のどちらにしますか？", ...}]}
行 31: tool_result is_error=True "PreToolUse:AskUserQuestion hook error: 文章で質問せず、MCP ツール ask_decision を使ってください"
行 41: tool_use ToolSearch {"query":"ask_decision","max_results":5}
行 42: tool_result "No matching deferred tools found"
行 45: text 「質問できませんでした。... もしくはここで「A」か「B」と直接答えてもらえれば、それを復唱します。」
```

- Claude は理由文に従って `ask_decision` を探した(1 回)。存在しないので、文章で聞き直してターンを終えた。止まりはしない。
- 実際に `ask_decision` を MCP で提供した場合に使うかは本検証では試していない。

### T5 対話 × auto × ExitPlanMode(session `00000000-0000-4000-8000-000000000006`)

- `verification/settings.json` の matcher を `AskUserQuestion|ExitPlanMode` に変更し、`--permission-mode plan` で起動。起動直後の状態行は `⏸ plan mode on`。
- プロンプト: 「verification/t5-note.md という新規ファイルに『T5 検証メモ』という 1 行だけを書く作業の計画を立て、ExitPlanMode で私に承認を求めてください。承認されるまで実装しないでください。」

hook の stdin(`T5-*.json`、`tool_input`。公式ドキュメントどおり `plan` と `planFilePath` が注入されている):

```json
{"plan": "# T5 検証メモ作成計画\n\n## Context\n...", "planFilePath": "/Users/user/.claude/plans/verification-t5-note-md-t5-1-curried-valiant.md"}
```

hook は `permissionDecision: "allow"` と `updatedInput: <tool_input をそのまま>` を返した(所要 73 ms)。

transcript の該当行(抜粋):

```
行 49: tool_use ExitPlanMode {"plan": "...", "planFilePath": "..."}
行 50: attachment hook_success PreToolUse:ExitPlanMode exitCode 0 durationMs 73
行 51: tool_result "User has approved your plan. You can now start coding. ... ## Approved Plan: ..."
行 52: attachment plan_mode_exit {"planFilePath": "...", "planExists": true}
行 56: tool_use Write {"file_path": "/Users/user/dev/ukagai/verification/t5-note.md", "content": "T5 検証メモ\n"}
行 57: tool_result "The user doesn't want to proceed with this tool use. ..."(検証側が Esc で拒否)
```

画面(承認直後):

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

Esc で拒否した後の状態行: `⏸ manual mode on`

- 計画承認 UI(通常は「承認して自動編集 / 手動承認 / 却下」を選ぶ)は出ず、hook の allow だけで「User approved Claude's plan」になった。Herdr も `blocked` を検出していない(`blocked` になったのは次の Write の許可プロンプト)。
- 承認後の権限モードは `manual`(状態行表示)。セッション開始時のグローバル既定 `auto` には戻らず、通常の承認 UI で「auto-accept edits」を選んだときの `acceptEdits` にもならない。注入で承認した場合、承認後のモードを選ぶ経路が無い。transcript には承認後の `permission-mode` レコードは追記されていない(`plan` の記録が 3 件のみ)。
- `verification/t5-note.md` は作成していない(Write を拒否)。

## timeout の挙動まとめ

- settings の `timeout`(秒)に達すると、Claude Code は hook プロセスに SIGTERM を送り(T3a で 60.056 秒)、hook の出力を捨て、ツールは通常の権限フロー(= 標準の質問 UI)に進む。transcript に `hook_cancelled`(`timedOut: true, timeoutMs`)が残る。画面に警告は出ない。
- timeout 後に回答を用意しても、その呼び出しの hook には届かない。拾わせるには hook プロセスが生きている間(= `timeout` 以内)に回答が要る。
- `timeout` 内であれば hook はブロックし続け、Claude Code 側は「ツール実行中」として待つ(T3c で 29 秒)。この間 Herdr は `working` と判定し、質問 UI は出ない。
- `timeout` の上限値や、`timeout` を長くした場合の副作用(例: 状態行の表示、`Notification` hook の発火)は未検証。公式ドキュメントでは command 型の既定は 600 秒。

## 未検証(推測の扱い)

- `answers` のキーが `question` と一致しないとき、または `answers` が一部欠けているときの挙動。
- `-p` に `--permission-prompt-tool` を付けた場合に hook が発火するか。
- MCP ツール `ask_decision` を実際に提供した状態で deny 理由に従うか(T4 は存在しない状態のみ)。
- `multiSelect: true` の質問に対する `answers` の形(ドキュメントでは「ラベルをカンマで結合」)。
- Claude Code 以外のバージョン、Sonnet 以外のモデルでの再現。

## 判定

- 実装に進んで良いか: **進んで良い。** 対話セッションでも `allow` + `updatedInput.answers` による注入は通り(T1、T3b、T3c)、ExitPlanMode の承認注入も通る(T5)。
- 方式: **注入方式。** deny 代替方式(T4)は Claude がツールを探すところまでは従うが、応答が文章での聞き直しになり、注入方式のように回答を 1 往復で返せない。注入方式の制約は「hook の `timeout` 以内に回答が要る(超えると標準 UI に落ちる)」と「ExitPlanMode の注入承認後は `manual` モードになる」の 2 点。
