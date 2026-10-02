# 検証 02: hook の限界と「説明を書かせる」往復(E1〜E7)

- 実施日: 2026-10-02
- Claude Code: `2.1.287 (Claude Code)`(`claude --version`)
- Node: v24.11.0(hook の実行系)
- 対話セッションは Herdr の隣 pane で起動(`herdr agent start probe --kind claude -- --settings verification/settings*.json --model sonnet|opus`)。グローバル設定の `defaultMode` が `auto` のため、`--permission-mode` を付けない回は auto mode。モデルは Sonnet 5.5(`claude-sonnet-5-5`)と Opus 5.5(`claude-opus-5-5`、E4 / E5 の一部)。
- 使ったもの: `verification/hook.mjs`(検証 01 のものを拡張)、`verification/settings.json` ほか `settings-86400.json` / `settings-notif.json` / `settings-e3.json` / `settings-e5.json` / `settings-e6.json`、hook の生ログ `verification/log/<試験名>.json`
- 一次情報の対応表: hook ログ = `verification/log/<試験名>.json`(`events` に受信シグナル・判定、`stdin` / `stdout` に入出力)、transcript = `~/.claude/projects/-Users-user--herdr-worktrees-ukagai-verify-e1-e5/<session_id>.jsonl`
- 追加 brief(`E-addendum.md`)を反映した。説明ファイルの置き場は hook の stdin にある `scratchpad_dir` の下の `ukagai/`、front matter に `question:` を必須、連番なし、図は必須ではなく「構造や流れが関わるなら」。E1 は 660 秒。E6 / E7 を追加。
- 試験の実施順は E1(裏で 660 秒 × 2)、E2、E7、E6、E3、E4、E5。環境変数の切り替え漏れで無効になった回は `verification/log/void-*` に退避し、結果に含めていない(下の「無効にした回」)。

## 結果表

| 試験 | 条件 | 結果 | 一言 |
|---|---|---|---|
| E1-1 | `timeout: 3600` で 660 秒超ブロック | **通った** | hook は 790 秒まで生存し、`hook_cancelled` は 0 件。既定 600 秒には丸められていない。790 秒後に answer を置くと拾った |
| E1-1s | hook エントリに `statusMessage` | **通った** | スピナー行が `Waddling… (ukagai: GUI で回答待ち… · 8s · ↓ 42 tokens)` になる。付けないと `running PreToolUse hook` |
| E1-2 | `timeout: 86400` で 660 秒超ブロック | **通った** | 683 秒まで生存し `hook_cancelled` 0 件、拾った。起動時・待機中に警告は見当たらない(起動画面は末尾 49 行のみ採取) |
| E1-2h | `/hooks` の表示 | **条件付き** | `--settings` で渡した PreToolUse hook は `/hooks` の一覧に出ない(「17 hooks on 8 events」、PreToolUse の行は `[Plugin]` 2 件のみ) |
| E1-3a | 待機中に Esc | **条件付き** | hook は SIGTERM を受けて終了(exit 143)。ツールは拒否扱い、Claude の返答は無くターン終了。transcript に `hook_cancelled` は残らない |
| E1-3b | 待機中に ctrl+c | **条件付き** | Esc と同じ(SIGTERM、拒否扱い、ターン終了) |
| E1-4 | Notification hook を足して待機中を観察 | **通らない(待機中は発火しない)** | 74 秒の待機中は 0 件。待機が終わって Claude がターンを終えた約 60 秒後に `idle_prompt` が 1 件発火 |
| E2-freetext | ラベルに無い自由文 | **通った** | Claude は自由文を受け取る。tool_result の書き出しが `The user answered:` に変わり、「依頼や不同意かもしれないので注意して読め」の一文が付く |
| E2-multi | multiSelect に `"A, C"` | **通った** | `Your questions have been answered: "…"="A, C".` で受理。画面も `→ A, C` |
| E2-missing | `answers: {}` | **条件付き** | エラーは出ず `The user did not answer the questions.`(無回答扱い)。Claude は「回答が無い」と返し、hook の横取りを疑った |
| E2-mismatch | キーが `question` と不一致 | **通らない(無回答扱い)** | 2 回観察(1 回は意図せず発生)。どちらも `The user did not answer the questions.`。hook の `answers` は `toolUseResult.answers` に残るが Claude には渡らない |
| E2-partial | 2 問のうち 1 問目だけ答える | **条件付き** | 答えた 1 問だけが `Your questions have been answered:` に載る。Claude は「2 問目の回答が返らない」と報告した |
| E3-1 | ExitPlanMode を deny(図と節を足せ)→ 2 回目は allow | **通った** | Claude は plan ファイルを編集して 6.3 秒後に再提出。plan は 403 → 673 文字、Mermaid の図と「影響範囲と可逆性」の節が入った。往復 2 回 |
| E3-2 | 承認後の状態行 | **条件付き** | `⏸ manual mode on`。続く Write で許可プロンプトが出た(Esc で拒否)。検証 01 T5 と同じ |
| E3-3 | allow の `updatedInput` に余分な欄 `permissionMode: "auto"` | **通った(無視される)** | エラーなし。承認後のモードは `manual` のまま |
| E3-4 | 承認直後の PermissionRequest hook で `setMode: auto` | **通った** | 承認後の最初の Write で許可プロンプトが出ず(`Allowed by PermissionRequest hook`)、状態行が `⏵⏵ auto mode on` に戻り、続く Write でも hook は再度呼ばれなかった |
| E3-5 | 長い deny 理由(1069 文字・25 行) | **通った** | 画面は 9 行で折りたたみ(`… +16 lines`)。Claude 側の tool_result は全文(末尾マーカーまで)入っている |
| E4 | deny で説明を書かせる往復(8 回有効 + 1 回断念) | **条件付き** | 往復 2 回で通ったのが 8/9(imperative 7 本中 6〈うち r4 は追加指示あり〉、fact 2/2)。deny → 再呼び出しは 7.4〜27 秒。書かれた説明は front matter と必須節が全回揃った。plan mode × Opus の 1 回は書かずに文章で止まった |
| E4-C2 | `<scratchpad_dir>/ukagai/` への Write | **通った** | default / acceptEdits / auto / plan(Sonnet)で許可プロンプトなし。plan(Opus)は Write を試みず「plan mode ではプランファイル以外は編集できない」と文章で返した |
| E5 | SessionStart の additionalContext だけで事前に書く | **通った(6/6)** | 1 回目の AskUserQuestion の時点で説明ファイルがあった率 6/6。ただし front matter の `reversibility` / `scope` は列挙値に従わず自由文 |
| E5-clear | `/clear` 後の再注入 | **通った** | SessionStart が `source: clear` で再発火し、新しい `session_id` / `scratchpad_dir` で additionalContext が届いた |
| E6-a | Explore / general-purpose サブエージェント内の AskUserQuestion | **通らない(ツールが無い)** | サブエージェントのツール一覧に AskUserQuestion が無く、PreToolUse は発火しない |
| E6-b | SubagentStart の additionalContext | **通った** | サブエージェントの transcript に `hook_additional_context` として入り、サブエージェントが合言葉を認識した。stdin に `agent_id` / `agent_type` あり |
| E7 | 到達不能 server に 1 秒で諦める hook | **通った** | `ECONNREFUSED` で 30 ms 後に何も出さず exit 0。tool_use から hook 終了まで 87 ms、通常の質問 UI が出た |

## 各試験の観察

### E1 timeout の上限と長時間ブロック中の表示

#### E1-1 `timeout: 3600`、wait モードで回答ファイルを置かない

(別 pane `probe2` で 2 回に分けて実施。先に 124 秒の予備、その後 `statusMessage` 付きで 790 秒。)

予備(`timeout: 3600`、statusMessage なし。`E1-1-timeout3600-wait.json`):

```
started_at 03:58:01.443Z / ended_at 04:00:05.603Z / exit 0 / "wait: answer.json found after 124s"
```

- 検証 01 T3a の 60 秒では落ちた hook が、60 秒を超えても生存(`pgrep -fl hook.mjs` で pid 26946 を確認)。
- 待機中の画面(`--source visible`):

```
✢ Twisting… (running PreToolUse hook · 18s · ↓ 42 tokens)
```

本番(`statusMessage: "ukagai: GUI で回答待ち"`、`E1-1b-timeout3600-660s.json`):

```
started_at 04:10:47.745Z / ended_at 04:23:57.691Z / exit 0 / "wait: answer.json found after 790s"
```

```
✽ Waddling… (ukagai: GUI で回答待ち… · 8s · ↓ 42 tokens)
✽ Waddling… (ukagai: GUI で回答待ち… · 13m 12s · ↓ 42 tokens)
```

- 状態行(最下段)は `⏵⏵ auto mode on` のまま、待機を示す文言は無い。スピナーの `(… · 経過時間 · ↓ トークン)` の括弧内の先頭が statusMessage に置き換わる。末尾の「…」は Claude Code が付ける。
- transcript(`1a4d0367-…jsonl`)に `hook_cancelled` は 0 件。600 秒での打ち切りも無い。
- 790 秒時点で `answer-e1.json` を置くと拾い、`hook_success` で通常どおり継続した。
- 予備の回は Claude が質問文に半角「?」を使い、answer のキー(全角「？」)と不一致になった。tool_result は `"The user did not answer the questions."`、画面は `User answered Claude's questions: · A と B のどちらにしますか？ → A`(hook の key で表示)。transcript の `toolUseResult.answers` には hook が入れた値が残る。→ E2-mismatch の 1 回目。以降 wait モードは `answer.json` に `{"*": "A"}` と書くと stdin の `question` をそのままキーにするよう hook を直した。

#### E1-2 `timeout: 86400`

`E1-2b-timeout86400-660s.json`:

```
started_at 04:24:33.517Z / ended_at 04:35:56.314Z / exit 0 / "wait: answer.json found after 683s"
```

- 待機中 `✢ Drizzling… (ukagai: GUI で回答待ち… · 11m 17s · ↓ 42 tokens)`。`hook_cancelled` は 0 件。拾った後は通常どおり。
- 予備(`E1-2-timeout86400-wait.json`、statusMessage なし、74 秒): 起動直後の画面末尾 49 行に警告・エラーの文言は無い(上部のスクロール外は未採取)。
- `/hooks`(予備の回): 先頭に `17 hooks on 8 events`。PreToolUse の行は次の 2 件のみで、`--settings` の hook は出ない。

```
PreToolUse  before tool execution
❯ [Plugin] export PATH="$($SHELL -l…   claude-mem@thedotmack
  [Plugin] sh ${CLAUDE_PLUGIN_ROOT}…   agent-web-memory@agent-w…
```

(それでも hook 自体は発火している。transcript に `hook_success` が残る。)

#### E1-3 Esc / ctrl+c(`timeout: 3600`、wait モード、statusMessage なしの設定)

`E1-3-esc.json`:

```json
"started_at": "2026-10-02T04:00:55.136Z", "ended_at": "2026-10-02T04:01:07.194Z", "exit_code": 143,
"events": [{"msg":"wait: still waiting (9s)"},{"at":"2026-10-02T04:01:07.194Z","msg":"received SIGTERM"}]
```

画面:

```
⏺ User declined to answer questions
  ⎿  · A と B のどちらにしますか? (A / B)
```

transcript(行 48、49):

```jsonl
{"type":"user","message":{"content":[{"type":"tool_result","content":"The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.","is_error":true,...}]}}
{"type":"user","message":{"content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]}}
```

- hook は Esc の瞬間(12 秒後)に SIGTERM を受けて exit 143。プロセスは生き残らない。Claude の返答は無く、ターンはそこで終わる(画面の次の入力待ちまで)。`hook_cancelled` 行は無い(timeout 経由ではないため)。
- ctrl+c(`E1-3-ctrlc.json`): 同じ。`received SIGTERM`(12.4 秒後)、画面 `User declined to answer questions`、transcript に同じ 2 行。
- 本検証では Esc / ctrl+c をそれぞれ 1 回ずつ。`statusMessage` 付きの設定では再実施していない。

#### E1-4 Notification hook

`settings-notif.json`(PreToolUse 3600 + Notification、matcher なし)、wait モード:

- 待機 74 秒(`E1-4-notification-wait.json`: 04:04:03.698Z〜04:05:17.793Z)の間、Notification のログは 0 件。
- 待機が終わり Claude がターンを終えた後、04:06:19.409Z に 1 件(`E1-4-notification-idle_prompt.json`):

```json
{"session_id":"a2cb7e34-…","hook_event_name":"Notification","message":"Claude is waiting for your input","notification_type":"idle_prompt", ...}
```

- 結論は「待機中の PreToolUse hook ブロックでは Notification は発火しない(74 秒の範囲)」。660 秒の回には Notification hook を入れていない。

### E2 `answers` の変種(mode `auto`、質問は「A と B のどちらにしますか」)

Sonnet は質問文に半角の `?` を付けた(検証 01 は全角 `？`)。`mismatch` は末尾の `？` / `?` を落とした文字列をキーにした。

| 変種 | hook が返した answers | tool_result(transcript 原文) | 画面 | Claude の返答 |
|---|---|---|---|---|
| freetext | `{"A と B のどちらにしますか?": "どちらでもない。C にしてください"}` | `The user answered: "A と B のどちらにしますか?"="どちらでもない。C にしてください". Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.` | `User answered Claude's questions: · … → どちらでもない。C にしてください` | 「回答: 『A と B のどちらにしますか?』=『どちらでもない。C にしてください』」(エラー無し) |
| multi | `{"A・B・C から選んでください(複数選択可)": "A, C"}`(質問は `multiSelect: true`) | `Your questions have been answered: "A・B・C から選んでください(複数選択可)"="A, C". You can now continue with these answers in mind.` | `→ A, C` | 「A・C を選択」 |
| missing | `{}` | `The user did not answer the questions.`(`toolUseResult.answers` は `{}`) | 未採取 | 「回答は返ってきませんでした」。過去の記憶(claude-mem)を根拠に「hook が横取りしている可能性」にも言及 |
| mismatch | `{"A と B のどちらにしますか": "B"}` | `The user did not answer the questions.`(`toolUseResult.answers` には hook の値が残る) | 未採取(予備の回では `→ A` と表示された) | 「回答は返ってきませんでした」 |
| partial(2 問) | 1 問目だけ `"A"` | `Your questions have been answered: "A と B のどちらにしますか?"="A". You can now continue with these answers in mind.` | 未採取 | 「回答を受け取れたのは 1 問目だけです。2 問目の回答は返ってきませんでした」 |

- いずれもツールエラー(`is_error`)にはならない。`hook_success` の `exitCode` は 0。
- `freetext` だけ tool_result の書き出しが `The user answered:` に変わる。ラベルに一致する値は `Your questions have been answered:`。
- ログ: `E2-freetext.json` / `E2-multi.json` / `E2-missing.json` / `E2-mismatch.json` / `E2-partial.json`、不一致の 1 回目は `E1-1-timeout3600-wait.json`。

### E3 ExitPlanMode の deny と承認後のモード(`--permission-mode plan`、`settings-e3.json`)

プロンプト: 「verification/e3-note.md に 1 行書く計画を立てて ExitPlanMode で承認を求めてください。承認まで実装しないでください」

#### E3-1 deny → 再提出(mode `deny`、2 回目は allow)

hook ログ(`E3-1-deny.json` / `E3-1-resubmit-allow.json`):

```
call #1  04:16:28.762Z  deny   plan_chars=403
call #2  04:16:35.091Z  allow  plan_chars=673
```

transcript(session `80d4c384-…`):

```
行 45  tool_use ExitPlanMode {"plan":"# 計画: … 1 行書く\n## Context …\n## 変更 …\n## 検証 …","planFilePath":"…/verification-e3-note-md-1-linear-bunny.md"}
行 46  tool_result ERR "PreToolUse:ExitPlanMode hook error: 計画に Mermaid の図と『影響範囲と可逆性』の節を足して、もう一度 ExitPlanMode で提出してください"
行 52  tool_result "The file …/verification-e3-note-md-1-linear-bunny.md has been updated successfully."   ← plan ファイルを編集
行 56  tool_use ExitPlanMode {"plan":"…## 流れ ```mermaid flowchart LR … ## 影響範囲と可逆性 …"}
行 58  tool_result "User has approved your plan. You can now start coding. …"
```

- deny の理由は `hook error:` 付きで Claude に渡り、Claude は plan ファイル(`~/.claude/plans/…`)を編集してから再提出した。1 回で直った。deny → 再提出まで 6.3 秒(`28.762` → `35.091`)。
- 直した plan に `mermaid` の `flowchart LR` と `## 影響範囲と可逆性` が入った(`plan_snapshot` を `E3-1-resubmit-allow.json` に保存)。文字数 403 → 673。往復 2 回。

#### E3-2 承認後の状態行

承認後の Write の許可プロンプトを Esc で拒否した後の状態行:

```
  [Sonnet 5.5:medium] #10 | 5h: 27% (1h33m) | 7d: 10% (20h43m) | ct…
  ⏸ manual mode on · ← 1 agent
```

- 同時に PermissionRequest hook のログ(`E3-2-permissionrequest-observed.json`)に `permission_mode: "default"`(= manual)、`tool_name: Write`。

#### E3-3 余分な欄(mode `plan-extra`、session `82679430-…`)

- hook が返した `updatedInput` は `{plan, planFilePath, permissionMode: "auto"}`(`E3-3-extra-permissionMode.json` の `stdout`)。
- エラーなし。tool_result は通常の `User has approved your plan…`。状態行は `⏸ manual mode on`(承認後、続く Bash の許可プロンプトが出て、Esc で拒否した後)。モードは変わらない。
- この回は Claude が Write ではなく Bash で書こうとしたため PermissionRequest(matcher `Write|Edit`)は発火しなかった。

#### E3-4 PermissionRequest で `setMode`(mode `auto` + `UKAGAI_PERM=setmode`、session `e87df0c5-…`)

hook が PermissionRequest に返した JSON(`E3-4-setmode-permissionrequest.json` の `stdout`):

```json
{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedPermissions":[{"type":"setMode","mode":"auto","destination":"session"}]}}}
```

画面(承認後の Write):

```
  ⎿  Allowed by PermissionRequest hook
⏺ verification/e3-note.md を作成し、…
  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent
```

- 許可プロンプトは出ず、状態行は `auto mode on`。次のターンで Write を頼んでも PermissionRequest hook は呼ばれず(ログ追加なし)、プロンプトも出なかった。公式ドキュメントの `updatedPermissions` / `setMode` の記述どおり。
- この回はプロンプトに「承認後は Write ツールでファイルを作ってください」を足した(Claude が Bash を選ぶと PermissionRequest の matcher に当たらないため)。

#### E3-5 長い deny 理由(`UKAGAI_LONG_REASON=1`、session `5d3d0741-…`)

- 理由は 1069 文字・25 行(UTF-8 で約 2.5 KB)。画面は先頭 9 行を出して折りたたまれた:

```
  ⎿  Error: PreToolUse:ExitPlanMode hook error: 計画に Mermaid
     の図と『影響範囲と可逆性』の節を足して、もう一度 ExitPlanMode
     で提出してください
     (補足 1) 図は flowchart で、節は見出し二つ分にしてください。
     …
     (補足 9) 図は flowchart で、節は見出し二つ分にしてください。
     … +16 lines
```

- transcript の tool_result は 1069 文字で、末尾の `[END-OF-REASON-MARKER]` と `補足 24` を含む。切り詰めは無い。Claude は plan を直して再提出した(`E3-long-*.json`、2 回目は 566 文字)。

### E4 deny で説明を書かせる往復(mode `explain-deny`)

hook の動作: `<scratchpad_dir>/ukagai/*.md` のうち 10 分以内で `.used.md` でないものを探し、front matter の `question:` が質問文と完全一致するものを採用(一致が無く候補がちょうど 1 つなら `match: recency`)。無ければ deny、あれば allow + 2 番目の選択肢を注入して `.used.md` に rename し、ログに中身を保存する。deny 理由文は 2 通り(imperative = 「…書いてください」、fact = 「…説明が無いため保留されました。…出すことを求めます」)。どちらも保存先の絶対パス、`question:` に書く原文、front matter と節の指定を含む。

| 回 | 判断 | モデル | 権限モード | 理由文 | 往復(AskUserQuestion の呼び出し) | 1 回目の deny → 2 回目の呼び出し | 同じ質問か | 説明ファイル |
|---|---|---|---|---|---|---|---|---|
| r1 | 設計分岐 | Sonnet | default | imperative | 2 | 18.1 秒 | 同じ(原文一致) | 1373 字、図・diff あり |
| r2 | 設計分岐 | Opus | acceptEdits | imperative | 2 | 14.2 秒 | 同じ | 1320 字、図・diff あり |
| r3 | 削除 | Sonnet | plan | imperative | 2 | 11.1 秒 | 同じ | 540 字 |
| r4 | 削除 | Opus | default | imperative | 2(下の注記) | 27.1 秒 | 同じ | 565 字 |
| r5 | 命名 | Sonnet | acceptEdits | imperative | 2 | 7.4 秒 | 同じ | 657 字 |
| r6 | 命名 | Opus | plan | imperative | 1(再呼び出し無し) | ― | 文章で止まった | 書かれず |
| r7 | 設計分岐 | Sonnet | auto | fact | 2 | 11.3 秒 | 同じ | 717 字、図あり |
| r8 | 削除 | Sonnet | auto | fact | 2 | 9.8 秒 | 同じ | 437 字 |
| r9 | 命名 | Opus | auto | imperative | 2 | 12.5 秒 | 同じ(全角「？」のまま) | 506 字 |

- 質問文は deny 後の再呼び出しで変わらず、`match: question` で全回採用された。`match: recency` は発生しなかった。
- 内訳: imperative 7 回(再呼び出し 6、r6 のみ無し)、fact 2 回(再呼び出し 2)。この件数で再呼び出し率の差は判断できない。
- r4 の注記: Opus は deny 後に調査の Bash(`git ls-files` を含む)を出し、default mode で許可プロンプトが出て止まった。Esc で拒否し、「git は使わずに、説明ファイルを書いて同じ質問をもう一度 AskUserQuestion で出してください」と追加で頼んだ後に書いて再呼び出し(27.1 秒には私の操作の待ちが含まれる)。この回は追加指示つきで、純粋な結果としては数えない。r4 の 1 回目の deny ログは rename の衝突で上書きされて失われた(transcript に deny は残っている。以降は番号が衝突しないよう直した)。
- r6(Opus、plan mode)の Claude の文面: 「ukagai の hook がこの質問を保留にしました。… ただ、今はプランモード中で、プランファイル以外は編集できません。そのため説明ファイルを書けず、質問をまだ出せていません。プランモードを解除してもらえれば…」。実際には Write を試みていない。同じ plan mode の Sonnet(r3)は scratchpad に書けた(`Made 1 scratchpad edit`)。モデル差かどうかは 1 回ずつなので未確定。
- scratchpad への書き込み(C2): default(r1)、acceptEdits(r2、r5)、plan(Sonnet r3)、auto で許可プロンプトは出なかった。書き方は Write と Bash の heredoc が混在した(Opus は Bash で書くことがある)。
- 書かれたファイルの形式(`verification/log/E4-r*-explain.md` に全文): front matter の `ukagai` / `for` / `question` / `title` / `reversibility` / `scope` と、「なぜ今この判断が要るか」「選択肢の比較」(表)は 8/8 で揃った。`reversibility` は列挙値(`reversible` / `irreversible`)、`scope` は列挙値(`file` / `repo`)。図(` ```mermaid `)は設計分岐の 3 本(r1、r2、r7)のみ、diff は r1、r2 のみ。削除・命名の回は図なし(「構造や流れが関わるなら」で足りた)。
- Mermaid の構文は目視のみ(描画していない): r1、r2、r7 の `flowchart TD/LR`、ノード `A[…]`、分岐 `B{…}`、ラベル付き矢印 `-- ある -->` は構文の誤りが見当たらない。

r1 の説明ファイル(抜粋、全文は `E4-r1-design-sonnet-default-2-explain.md`):

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

r3(削除、540 字)は表と「なぜ今」のみで、不可逆性(`reversibility: irreversible`)は front matter にあるが本文に「取り消せない」旨の強調は無い。

deny の理由文(imperative、`E4-r1-…-1-AskUserQuestion.json` の `stdout` から。パスは session ごとに変わる):

```
この質問は保留されました。人が判断するための説明を `<scratchpad_dir>/ukagai/<任意の名前>.md` に Markdown で書いてください。先頭に front matter(ukagai: 1、for: AskUserQuestion、question: 次の文字列をそのまま書く: `<質問文の原文>`、title、reversibility: reversible|costly|irreversible、scope: file|repo|machine|external)。本文は見出し「なぜ今この判断が要るか」「選択肢の比較」(表。各選択肢の利点・欠点・コスト)、構造や流れが関わるなら「図」(```mermaid)、コード変更が絡むなら「関係する差分」(```diff)。書き終えたら、同じ質問を AskUserQuestion でもう一度出してください。
```

### E5 SessionStart の additionalContext だけで事前に書く(mode `explain-observe`、`settings-e5.json`)

SessionStart hook が返した文(`<scratchpad_dir>` は stdin の値):

```
人に判断を求める前(AskUserQuestion / ExitPlanMode を呼ぶ前)に、説明を `<scratchpad_dir>/ukagai/<自由な名前>.md` に書くこと。
形式: front matter(ukagai: 1、for: AskUserQuestion、question: 聞く質問文の原文、title、reversibility、scope)+「なぜ今この判断が要るか」「選択肢の比較」(表)。構造や流れが関わるなら「図」(```mermaid)。
ディレクトリが無ければ作ること。説明は質問ごとに 1 ファイル。
```

- transcript では `hook_additional_context` として入る(`system-reminder: SessionStart hook additional context: …`)。

| 回 | 判断 | モデル | 1 回目の呼び出し時点でファイルがあったか | match | 書き方 | 説明の字数 |
|---|---|---|---|---|---|---|
| r1 | 設計分岐 | Sonnet | あった | question | Bash | 734 |
| r2 | 設計分岐 | Opus | あった | question | Bash | 1093 |
| r3 | 削除 | Sonnet | あった | question | Write | 609 |
| r4 | 削除 | Opus | あった | question | Bash | 1051 |
| r5 | 命名 | Sonnet | あった | question | Write | 618 |
| r6 | 命名 | Opus | あった | question | Bash | 492 |

- ファイルがあった率 6/6。全回 AskUserQuestion は 1 回だけ(deny なし)。additionalContext を受けてから質問までの所要は約 15〜27 秒(調査の Bash を挟む回がある)。
- 質は E4 と同じ観点で、front matter のキー・「なぜ今」・表は 6/6 で揃い、`question:` は全回原文一致。図は r2、r4 のみ(r2 は図の意味が実態に合う、r4 は `hook → log → docs` の関係図)。diff は 0/6。
- 前提(additionalContext に列挙値を書かなかったため): `reversibility` / `scope` は列挙値に従わず自由文になった。例: `reversibility: 高い(verification/hook.mjs の 268-298 行目だけの差し替えで、いつでも戻せる)`、`scope: verification/hook.mjs の wait モードのみ。…`。E4(deny 理由に列挙値を書いた)は列挙値どおり。
- `/clear`(`E5-clear-*.json`、session `feca91f9-…`): `/clear` の後、SessionStart が `source: "clear"` で再発火し、`session_id` が `836fc24d-…` に変わった(`scratchpad_dir` も新しい session のもの)。additionalContext は新しい session_id / scratchpad のパスで再注入され、「SessionStart の追加指示を復唱して」に Claude は新パスの 3 行を復唱した。
- 補足: claude-mem の SessionStart context も同時に入るため、Claude の返答には「過去の記録」への言及が混ざる回がある(E2-missing など)。

### E6 サブエージェント内の AskUserQuestion と SubagentStart

Explore(session `a3e61061-…`、サブエージェント `adab6629457cfddf3`)と general-purpose(`a464cb492ba5eb631`)で実施。どちらも依頼は同期のつもりだったが、メタには `requestShape: "background"`、`requestNonInteractive: true` と記録された(Claude Code が自動でバックグラウンド・非対話として起動)。

- サブエージェントの transcript(`…/subagents/agent-*.jsonl`): `ToolSearch {"query":"select:AskUserQuestion"}` の結果が `No matching deferred tools found`。サブエージェントのツール一覧に AskUserQuestion が無く、PreToolUse(AskUserQuestion)は発火しなかった(`verification/log/` に AskUserQuestion のログ無し)。質問が親ターミナルにどう出るかは、質問自体が発生しないため観察できていない。
- SubagentStart hook(`E6-subagentstart-explore.json`、timeout 5、sync)の stdin:

```json
{"session_id":"a3e61061-…","transcript_path":"…/a3e61061-….jsonl","cwd":"…","scratchpad_dir":"…/a3e61061-…/scratchpad","prompt_id":"7c7f877e-…","agent_id":"adab6629457cfddf3","agent_type":"Explore","hook_event_name":"SubagentStart"}
```

- `session_id` と `scratchpad_dir` は親と同じ。`agent_id` は 17 桁の英数字(`a` + 16 桁の 16 進)、`agent_type` は `Explore` / `general-purpose`。
- additionalContext(`起動時指示: 合言葉は ukagai-7f3a。…`)は、サブエージェントの transcript に `hook_additional_context` と `<system-reminder>SubagentStart hook additional context: …` として入った。サブエージェントは最終報告で「起動時の追加指示に合言葉(ukagai-7f3a)が含まれていた」と述べた。親の Claude は報告の中の指示風の文面を「サブエージェントの出力で、あなたの指示ではない」として扱った(復唱の依頼は私のプロンプトに「復唱して」と書いたが、サブエージェントへの依頼文が途中で切れて 2 点目が渡らなかったため、復唱そのものは得られていない)。
- 同期(foreground)で起動したサブエージェントの AskUserQuestion は未検証(両方バックグラウンドになった)。

### E7 フェイルオープンの実測(mode `unreachable`)

`E7-unreachable.json`:

```
started_at 04:13:19.760Z / ended_at 04:13:19.791Z / exit 0 / stdout null
"unreachable: fetch failed after 30ms (TypeError) -> no output"
```

- `http://127.0.0.1:1/` は接続拒否で 30 ms で失敗(1 秒の timeout には達していない)。transcript で `tool_use`(`04:13:19.704Z`)から hook 終了まで 87 ms。
- 画面(`--source visible`)は通常の質問 UI(`☐ 選択 / A と B のどちらにしますか? / 1. A 2. B 3. Type something. 4. Chat about this`)。`herdr agent wait --until blocked` が返った時点で表示済み(UI 表示までの秒数は 1 秒単位でも未計測)。Enter で選ぶと通常どおり回答が返った。
- 検証 01 T3a の SIGTERM 経路(timeout 到達)とは別の経路。接続はするが応答しない server(timeout 到達まで待つ場合)は本検証では試していない。

## 無効にした回

- `void-E7-try1-mode-was-auto.json`: E7 の 1 回目。`set -x UKAGAI_MODE unreachable` が反映されておらず mode が `auto`(`auto: variant=partial`)で動いた。結果に含めない。2 回目から env を `env | grep UKAGAI` で確認してから起動。
- `void-misfire-E5-r{2..6}-…-SessionStart.json`: E5 の誤発射。ループのシェルが zsh で変数を単語分割せず、プロンプトが空のまま 5 セッションを起動した(SessionStart のログのみ)。結果に含めず、同じ条件で取り直した。

## 変更したファイル(`verification/` 配下)

`hook.mjs`(拡張)、`settings.json`(`timeout` 3600 + `statusMessage`)、`settings-86400.json`、`settings-notif.json`、`settings-e3.json`、`settings-e5.json`、`settings-e6.json`、`e3-note.md`(E3-4 の承認後に Claude が Write で作成)、`state/`(試験用カウンタ)、`log/`(hook 生ログと説明ファイル全文)。

## 未検証と推測の一覧

- `timeout: 3600` / `86400` とも 660 秒超で生存したが、それ以上(1 時間超)は未検証。上限が `3600` や `86400` より低くなる条件は見つかっていない。`timeout` が大きいときの Claude Code 側の別の副作用は未確認。
- `/hooks` に `--settings` の hook が出ないのは 1 画面の観察のみ。`settings.json` 経由なら出るかは未検証。起動時の警告は起動画面の末尾 49 行のみ確認。
- Esc / ctrl+c は各 1 回、`statusMessage` なしの設定で観察した。Esc は「Claude への割り込み」ではなくツール拒否として処理されたと読めるが、内部の経路は推測。
- Notification: 74 秒の待機中は 0 件、660 秒の回には Notification hook を入れていない。`permission_prompt` などの他タイプは未観察。
- E2: missing / mismatch / partial の画面表示は未採取(予備の mismatch で `→ A` と出たのみ)。`multiSelect` で「ラベルに無い値を含む」場合は未検証。
- E3: plan の編集は Claude が毎回行うとは限らない(1 回目のセッションでは Write ではなく Edit 相当の「updated successfully」)。deny 1 回で直ったのは 2 回の観察のみ。`setMode` は Write の PermissionRequest だけを観察(Bash の許可プロンプトで同じことが起きるかは未検証)。長い理由は 1 回のみ。
- E4: n が小さい(9 回、モデル・モード・理由文が回ごとに違うため要因の切り分けは不可)。`match: recency`(質問文を言い換えた場合)と、10 分超の古いファイルの扱いは未検証。Opus × plan mode の断念が再現するかは未確認。Mermaid は描画していない。
- E5: 6 回のみ。additionalContext に列挙値を書けば `reversibility` / `scope` が揃うかは未検証(推測: 揃う)。Claude が説明を書かない場合(率 0)は観察されていない。
- E6: 親のターミナルにサブエージェントの質問がどう出るかは、そもそも質問できないため未観察。同期起動のサブエージェント、`--permission-prompt-tool` などの構成は未検証。
- E7: 接続拒否(即時失敗)のみ。応答しない server に対する 1 秒 timeout の経路は未検証。
- Sonnet 5.5 / Opus 5.5 の各数回のみ。Claude Code 2.1.287 以外は未検証。環境の claude-mem hook による追加コンテキストが Claude の返答に影響している回がある。

## 計画 03 の 3 節・4 節をどう直すべきか

- 3 節「説明の経路」: 置き場を `<scratchpad_dir>/ukagai/` と `question:` 一致に確定してよい(E4 で全 8 回が `match: question`、E5 で 6/6)。deny は保険に下げられる(SessionStart だけで 6/6)が、列挙値(`reversibility` / `scope`)は additionalContext にも書く(自由文になる)。
- 3 節「フェイルオープン」と budget: `timeout` は 3600 / 86400 で 660 秒超が通ったので `timeout` を 3600 にしても警告は出なかった。待機表示は `statusMessage` で出せる(スピナー行の先頭)。Esc / ctrl+c は hook に SIGTERM が来て「拒否」扱いでターンが終わるので、hook は SIGTERM 時に server へ `hook_disconnected` を通知する前提にする。
- 3 節「answers」: キーは stdin の `question` をそのまま使う(半角 `?` / 全角 `？` が回ごとに変わる)。不一致・欠落は無回答扱い(エラーにならず Claude は hook を疑う)。自由記述は渡せるが tool_result の書き出しが変わる。2 問のうち一部だけ答えると答えた分だけが渡る。
- 3 節「ExitPlanMode」: 却下 UI は成立する(deny 理由が `hook error:` で渡り、plan を直して再提出)。承認後の `manual` は PermissionRequest hook の `setMode: auto` で戻せる(matcher `Write|Edit` の Write で確認)ので、計画 7 節の「2 週目の候補」を前倒しできる。`updatedInput` の余分な欄は無視される。
- 4 節: E6 により、サブエージェントの AskUserQuestion は GUI に出ない(ツールが無い)ので対象外と書く。Notification は待機中に鳴らない。E7 は即時失敗が 87 ms で通常 UI に落ちる。E1 / E3 の行は上記で埋まった。
