# MVP 実装計画(hook + GUI 方式、MCP なし)

2026-10-02 作成、同日 v2(敵対的レビューを反映。報告は作業ログに保存)。`02-mvp-plan.md` の技術決定と日程を置き換える。指標と打ち切り条件は 02 を引き継ぐ。根拠は `docs/verification/01-askuserquestion-injection.md`(以下 01)。

## 1. 方針の変更点

| 項目 | 02 の決定 | この計画 | 理由 |
|---|---|---|---|
| 判断の捕捉 | MCP `ask_decision` を CLAUDE.md で使わせる。使われなければ hook で強制 | **PreToolUse hook が AskUserQuestion / ExitPlanMode を横取りし、GUI の回答を `updatedInput` で返す。** MCP も CLAUDE.md の指示も無し | 対話セッションで注入が通ることを実機確認済み(01 T1 / T3b / T3c / T5。Claude Code 2.1.287 × Sonnet × auto mode)。エージェントの協力が要らず、既定で捕捉になる(「強制」ではない: 文章で聞いて逃げる経路と自己回答の経路が残る。8 節) |
| 説明の帯域 | MCP `show_diff` / `show_diagram` / `compare_options` をエージェントに呼ばせる | **エージェントに人向けの説明(なぜ今この判断か、選択肢の比較表、必要なら Mermaid 図、関係する差分)を Markdown で書かせ、hook が拾って GUI に描く。** 書かずに質問したら hook が deny + 理由で書き直させる。server は `git diff` と直近のツール呼び出しを補助として自動で添える | ここが製品の核(00-overview 3 節の空白 2)。MCP 無しでも skill(書き方)+ SessionStart / SubagentStart の指示(事前)+ PreToolUse の deny(保険)で成立する見込み。**Claude が deny 理由を読んで行動を変えることは T4 で確認したが、「ファイルを書いて同じ質問を再度出す」は未確認。E4 を Day 2 のゲートにする(8 節の分岐)** |
| 状況の地図 | hooks(Notification / Stop)+ ACP | **Claude Code の観測 hook だけ。** ACP と 2 社目は 2 週目以降 | 1 週目は「判断を 1 か所に集めると速くなるか」だけを測る |
| 永続化 | SQLite | **JSONL 追記**(`~/.ukagai/`)。起動時に `pending` を復元 | 2 週間分の判断ログに検索は要らない。必要になれば `node:sqlite` に移す |
| UI | Vite + React | **ビルド無しの静的 HTML / JS**(`public/`)。`marked` と `mermaid` は npm から `public/vendor/` にコピーして同梱 | カード 2 型と一覧だけ |
| パッケージ管理 | pnpm | **npm** | この機械の pnpm(corepack)は未セットアップで `pnpm --version` が失敗する(観察)。W1 で npm に確定済み |

## 2. ゴールと指標(02 を引き継ぎ、(a) を差し替え、(d) を追加)

| 指標 | 取り方 | 続行の目安 |
|---|---|---|
| (a') GUI 回答率 | 分子 = `answered`(hook が ack した判断)。分母 = `answered + fallback + hook_disconnected + answer_lost + cancelled + escaped_question`(状態の定義は 3 節)。server が自動集計 | 90% 未満なら、GUI 以外に流れた 1 件ずつ理由を記録して潰す |
| (b) 判断 1 件の所要時間 | 人側 = `created_at → decided_at`。エージェント側 = `first_denied_at → created_at`(説明の往復)。別々に集計。**基準値は Day 3 に観測モード(`hook --observe`)で同じ定義で 1 日分取る** | 人側が基準値比で短くならなければ「説明の帯域」仮説が外れている |
| (c) pane を切り替えた回数 | 判断のためだけでなく、状況確認のためにターミナルの pane を切り替えた回数を手で記録。GUI のセッション一覧パネルを開いた回数(events に記録)を補助指標にする。**注意: (c) の改善は地図ではなく注入の効果かもしれない** | 半減しなければ「地図」仮説が外れている |
| (d) 説明の添付率と質 | `explanation.attached_via`(`first_call` / `after_deny` / `none`)を自動集計。plan mode の判断は分母から除く。質は 1 日 3 件を手で採点(表と図が判断に効いたか、図が飾りでないか) | `none` が 10% を超えるなら deny の理由文を直す。採点が低ければ skill の書き方を直す |

打ち切り条件は 02 のまま: (b) と (c) の両方が改善しなければ 2 週間以内に止める。判定日は Day 14(6 節)。

## 3. アーキテクチャ

### プロセス

```
Claude Code ──PreToolUse(AskUserQuestion|ExitPlanMode)──▶ ukagai hook ──POST /api/decisions──▶ ukagai serve ──SSE──▶ ブラウザ(GUI)
                                                              │                                    ▲                 │
                                                              ├──GET /api/decisions/:id/wait ◀─────┴── POST /answer ─┘
                                                              └──POST /api/decisions/:id/ack
                                                              ▼
                                                   stdout: allow + updatedInput  /  deny + reason  /  出力なし(ターミナル UI に戻す)
Claude Code ──観測 hook──▶ ukagai hook ──POST /api/events──▶ serve(セッション一覧、escaped_question)
Claude Code ──PermissionRequest(Write|Edit)──▶ ukagai hook ──(GUI で「承認して auto」直後の 1 件だけ)──▶ allow + setMode auto
```

- `ukagai serve`: `127.0.0.1:4818`。HTTP API + SSE + `public/` の配信。状態はメモリ、`~/.ukagai/decisions.jsonl` と `~/.ukagai/events.jsonl` に追記。起動時に `decisions.jsonl` の `pending` を `hook_disconnected` として復元する。
- `ukagai hook`: Claude Code の hook から呼ばれる単一コマンド。`hook_event_name` と `tool_name` で振り分ける。
  - PreToolUse × AskUserQuestion / ExitPlanMode: 説明ファイルを探し、判断を登録し、回答まで long-poll で待ち、ack を打ってから hook 出力 JSON を stdout に書く。
  - PermissionRequest × Write / Edit: server に「このセッションで 120 秒以内に GUI で『承認して auto』が押され、未消費」の記録があるときだけ、allow + `setMode auto` を返して記録を消す。それ以外は出力なし。
  - SessionStart / SubagentStart(sync): `additionalContext` で説明の事前指示を返す。
  - その他(観測): `POST /api/events` に投げて即終了。Stop では `last_assistant_message` の末尾が「？」「?」、または「どちら」「よろしいですか」「教えてください」を含めば `escaped_question` を付ける(粗い検出。文章で聞いて逃げた判断を数える)。
  - `hook --observe`: 基準値測定用。PreToolUse × AskUserQuestion / ExitPlanMode で何も出力せず時刻だけ `POST /api/events`、PostToolUse × 同 matcher で終了時刻を送る。server が差分を (b) の基準値として集計する(PostToolUse の `duration_ms` は許可プロンプトの時間を含まないので使わない)。
- GUI: 保留一覧、カード(質問 / 計画)、説明パネル、補助文脈パネル、セッション一覧。

### フェイルオープン(MVP の決定)

- server に接続できない(1 秒以内に失敗)、wait が 404 / 5xx: 何も出力せず exit 0 → Claude Code の通常 UI に落ちる。
- hook の持ち時間(`--budget` 秒)の残りが `poll timeout + 5 秒` を切ったら、poll せず `fallback` を送って exit 0。SIGTERM で殺される前に自分で降りる(T3a では SIGTERM 後に何も記録できなかった)。
- GUI の「ターミナルで答える」: server が `fallback` を返し、hook は何も出力せず exit 0。
- 企業向けの fail-closed は MVP の対象外。

### 契約(`src/contract.ts`、zod。`docs/spec/api.md` に同じ内容を人向けに書く)

```ts
type Decision = {
  id: string;                        // crypto.randomUUID()
  kind: "answer_question" | "approve_plan";
  tool_use_id: string;               // 同一 tool_use_id の再登録は既存を返す(往復の対応付けには使わない: 再呼び出しで変わる)
  session: { session_id: string; cwd: string; transcript_path: string; scratchpad_dir?: string;
             permission_mode?: string; agent_id?: string; agent_type?: string; title?: string };
  request: AskUserQuestionInput | ExitPlanModeInput;   // hook の tool_input をそのまま
  context: { branch?: string; git_status?: string; git_diff_stat?: string; git_diff?: string;
             last_assistant_text?: string; recent_tools?: { name: string; summary: string }[] };
  explanation?: { path: string; title?: string; question?: string;
                  reversibility?: "reversible" | "costly" | "irreversible";
                  scope?: "file" | "repo" | "machine" | "external";
                  markdown: string;                                   // scratchpad は一時領域なので複写する
                  has: { mermaid: boolean; table: boolean; diff: boolean };
                  match: "question" | "recency";
                  attached_via: "first_call" | "after_deny" | "none";
                  none_reason?: "plan_mode" | "loop_guard" | "not_required" };
  first_denied_at?: string;          // after_deny のとき、1 回目の deny の時刻(エージェント側の (b))
  status: "pending" | "answer_submitted" | "answered" | "fallback" | "hook_disconnected"
        | "answer_lost" | "cancelled" | "denied_explain";
  lease_until?: string;              // 最後の poll 終了 + poll timeout + 10 秒。切れたら hook_disconnected
  created_at: string;
  response?: { via: "gui" | "terminal";
               answers?: Record<string, string>;      // answer_question
               approve?: boolean; reason?: string;    // approve_plan
               set_mode_auto?: boolean;               // 「承認して auto」
               decided_at: string; delivered_at?: string };
};
```

状態遷移: `pending` →(GUI 回答)`answer_submitted` →(hook が wait の 200 を受けて ack)`answered`。`pending` / `answer_submitted` で lease が切れたら `hook_disconnected`、`answer_submitted` で切れたら `answer_lost`(GUI に「ターミナルに落ちた」と出す)。lease 切れの直後に同セッションの UserPromptSubmit / Stop が来たら `cancelled`。deny した呼び出しも `denied_explain` として登録し(GUI には出さない)、再呼び出し時に `session_id + agent_id + questions[0].question` で直近の `denied_explain` を引いて `attached_via: after_deny` と `first_denied_at` を付ける。

| API | 役割 |
|---|---|
| `POST /api/decisions` | hook が登録。`tool_use_id` が同じなら既存を返す |
| `GET /api/decisions/:id/wait?timeout_ms=25000` | long-poll。回答済みなら 200 + response、未回答で timeout なら 204。各 poll の終了時に `lease_until` を更新 |
| `POST /api/decisions/:id/ack` | hook が response を受け取ったことの確認。ここで `answered` / `delivered_at` |
| `POST /api/decisions/:id/answer` | GUI から。`{answers}` / `{approve:true, set_mode_auto?:boolean}` / `{approve:false, reason}` / `{fallback:true}` |
| `GET /api/decisions?status=pending` / `GET /api/decisions/:id` | 一覧・詳細 |
| `POST /api/events` | 観測 hook の生 JSON(`--observe` の時刻、Stop の `escaped_question`、PermissionRequest の消費) |
| `GET /api/sessions` | セッションごとの状態(working / waiting_decision / idle / ended)。`waiting_decision` は PreToolUse の登録時に立てる。Notification(`permission_prompt` / `idle_prompt`)は「ターミナル側で止まっている(注入が効かなかった)」の検出にだけ使う(発火が 6 秒 / 60 秒遅れるため) |
| `GET /api/sessions/:id/pending-mode-switch` / `POST .../consume` | PermissionRequest hook が「承認して auto」の記録を読んで消す |
| `GET /api/metrics` | (a')(b)(d) の集計 |
| `GET /api/stream` | SSE: `decision.created` / `decision.updated` / `session.updated` |
| `GET /healthz` | hook の接続確認 |

認可と入力検証(同一ユーザーの他プロセスがファイルを読めば突破できる。それは限界として 7 節に明記):

- `serve` が起動時にランダムトークンを作り `~/.ukagai/token`(0600)に書く。hook は読んで `Authorization: Bearer` で送る。GUI は `GET /` で `SameSite=Strict; HttpOnly` cookie を受け取り、書き込み API は cookie か Bearer を要求する。
- `Host` が `127.0.0.1:4818` / `localhost:4818` 以外は 400(DNS rebinding 対策)。書き込み API は `Content-Type: application/json` 必須。
- hook から受けた `transcript_path` は `~/.claude/projects/` 配下、`explanation.path` は `scratchpad_dir` または `~/.ukagai/explain/` 配下、`cwd` は実在ディレクトリに限って読む。git は `git -C <cwd> --no-pager` で呼び、失敗は空。
- deny 理由文・additionalContext・statusMessage に GUI の URL を書かない(Claude 自身に `curl` で回答させない)。

hook の出力(検証で確定した形):

| 判断 | GUI の操作 | stdout |
|---|---|---|
| answer_question | 選択肢を選ぶ | `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"questions":<原文>,"answers":{"<question>":"<label>"}}}}`(T1 で確定) |
| approve_plan | 承認 / 承認して auto | 同上で `updatedInput` は `tool_input` をそのまま(T5 で確定)。「承認して auto」は server に記録し、直後の PermissionRequest hook が `setMode auto` を返す(E3 で確認) |
| approve_plan | 却下 + 一言 | `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"<一言>"}}`(Claude が計画を直して再提出するかは E3 で確認) |
| どちらも | 説明ファイルが無い / 形式不備(1 回目) | `deny` + 理由(足りない項目、保存先の絶対パス、`question:` に書く原文、skill 名)。`denied_explain` として登録 |
| どちらも | ターミナルで答える / 接続不可 / budget 切れ | 出力なし、exit 0 |

### 文脈の収集(server 側、判断登録時にベストエフォート、各 500 ms 上限)

- git: `rev-parse --abbrev-ref HEAD`、`status --porcelain`、`diff --stat`、`diff`(200 KB で打ち切り)。
- transcript: 末尾 512 KB をバイトで読んで行に分け(tool_result 行は数百 KB になりうる)、直前の assistant テキスト(質問に至った理由)、直近 10 件の tool_use(名前 + ファイルパス / コマンドの先頭)、`ai-title` 行を拾う。`agent_id` があればサブエージェントの transcript(`<dirname>/<session_id>/subagents/agent-<agent_id>.jsonl`。パスの形は推測、E6 で確認)を先に試す。transcript は書き込みが遅れることがある(公式ドキュメント)ので、取れなければ 500 ms 後に 1 回だけ再読し、それでも無ければ空のまま出す。

### 説明の経路(エージェント側。製品の核)

エージェントに「人が判断するための説明」を書かせる。MCP の代わりに 3 層で成立させる。

| 層 | 仕組み | 役割 |
|---|---|---|
| 書き方 | skill `ukagai-explain`(`skills/ukagai-explain/SKILL.md`。install が `~/.claude/skills/` に置く) | 説明ファイルの形式と、何を図にし何を表にするかの指針、良い例・悪い例 |
| 事前の指示 | SessionStart と SubagentStart の hook(どちらも sync)が `additionalContext` で 3 行の指示と保存先の絶対パスを入れる | 1 回目の呼び出しで説明が付く率を上げ、deny の往復を減らす。async だと次のターンにしか届かないので sync |
| 保険 | PreToolUse hook が説明ファイルを探し、無ければ / 形式不備なら `deny` + 理由で書き直させる | 指示に従わなかったときの 1 回限りの保険。往復の成立は E4 で確認 |

説明ファイルの置き場と形式(`docs/spec/explain.md` に正式に書く):

- 置き場: **`<scratchpad_dir>/ukagai/<自由な名前>.md`**。`scratchpad_dir` は hook の stdin にあり、Claude は自分の scratchpad を system prompt で知っていて、auto 以外のモードでも許可プロンプト無しで書ける見込み(E4 で default / acceptEdits / plan を確認)。`scratchpad_dir` が無い古い版では `~/.ukagai/explain/<session_id>/`。リポジトリの中には置かない。server は本文を Decision に複写する。
- front matter: `ukagai: 1`、**`question:`(質問文の原文。`questions[0].question` をそのまま)**、`title`、`reversibility`、`scope`。
- 本文の見出し: 「なぜ今この判断が要るか」「選択肢の比較」(表。各選択肢の利点・欠点・コスト)は必須。「図」(```mermaid)は `scope` が `repo` 以上または `reversibility` が `reversible` 以外のときだけ必須、それ以外は任意。「関係する差分」(```diff)はコード変更が絡むときだけ。hook は Mermaid の構文を検査できないので、GUI は描画に失敗したらコードをそのまま表示してエラーを添える。
- ExitPlanMode は別ファイルを要求しない。計画本文(`tool_input.plan`)に「影響範囲と可逆性」の節があるかだけを見る(見出しの照合は空白・全角半角・「と」「・」を正規化した部分一致)。Mermaid は推奨(無ければ `has.mermaid: false` で (d) に数える)。無ければ deny で直させるのは同一セッションで 1 回まで。
- plan mode(`permission_mode === "plan"`)中の AskUserQuestion は説明ファイルを要求しない(`attached_via: none`、`none_reason: plan_mode`)。(d) の分母から除く。

hook の判定(AskUserQuestion):

1. `<scratchpad_dir>/ukagai/` の `.md`(`.used.md` を除く)から、front matter の `question:` が `questions[0].question` と完全一致するものを探す。無ければ、10 分以内に書かれた未使用ファイルがちょうど 1 つならそれを使い `match: recency` を記録する。
2. 見つかり形式が通れば登録(`attached_via` は直近 2 分の `denied_explain` があれば `after_deny`、無ければ `first_call`)。使ったファイルは `<名前>.used.md` に rename。
3. 無い / 形式不備なら `deny` + `denied_explain` 登録。理由文は「足りない項目の列挙 + 保存先の絶対パス + `question:` に書く原文 + 『skill ukagai-explain に従って書き、同じ質問をもう一度 AskUserQuestion で出す』」。文体(命令文か事実 + 依頼か)と 2 分 / 10 分の値は E4 の結果で確定する。
4. 同じ `session_id + agent_id + question` で 2 分以内に `denied_explain` があるのにまだ無ければ、ループを避けるため説明なし(`attached_via: none`、`none_reason: loop_guard`)で GUI に出す。GUI には「説明なし」の印を付ける。

GUI の描画: Markdown(見出し・表・コードブロック)、Mermaid(`mermaid.min.js` を `public/vendor/` に同梱、CDN は使わない)、diff(unified の色付け)。

### Claude Code への登録(`ukagai install`)

- 既定は `~/.claude/settings.json`。`--project` で `.claude/settings.json`、`--settings <file>` で任意ファイル(開発中はこれを使い、自分のセッションに hook をかけない)。
- 既存の hooks を壊さずマージし、書く前に `settings.json.bak-<timestamp>` を取る。`--dry-run` で差分表示。`ukagai uninstall` で自分の登録だけ外す。
- command は exec form で書く(shell を介さない。パスに空白があっても壊れない): `{"type":"command","command":"<process.execPath>","args":["<repo>/dist/cli.js","hook","--budget","<timeout - 10>"],"timeout":<timeout>,"statusMessage":"ukagai: GUI で回答待ち"}`。`--budget` は settings の `timeout` から導出する。
- skill `ukagai-explain` を `~/.claude/skills/ukagai-explain/SKILL.md` にコピーする(`--project` なら `.claude/skills/`)。`uninstall` で消す。
- 登録する hook:

| event | matcher | timeout(秒) | sync / async |
|---|---|---|---|
| PreToolUse | `AskUserQuestion\|ExitPlanMode` | 3600(E1 の結果で調整) | sync、`statusMessage` 付き |
| PermissionRequest | `Write\|Edit` | 5 | sync |
| SessionStart / SubagentStart | なし | 5 | sync(`additionalContext` を返すため) |
| UserPromptSubmit / Stop / SubagentStop | なし | 5 | async |
| PostToolUse | `Edit\|Write\|MultiEdit\|NotebookEdit`(`--observe` 時は `AskUserQuestion\|ExitPlanMode` も) | 5 | async |
| SessionEnd | なし | 2 | sync(予算 1.5 秒。POST は 500 ms で諦める) |
| Notification | `permission_prompt\|idle_prompt` | 5 | async |

- dogfood の対象は自分が直接対話するセッションだけ。Herdr の worker pane は `--settings` で hook 無しのまま動かす(hook がブロックしている間 Herdr は `working` のままで、オーケストレータの `agent wait` が GUI の回答まで返らなくなるため)。

### 決めた細部

- 1 回の AskUserQuestion に質問が 1〜4 個入る。カードは全部出し、全問に答えてから送る。`multiSelect` の区切りは定数にして E2 の結果で確定(公式ドキュメントは「commas」)。
- 自由記述は E2 で Claude に届くと確認できた場合だけ GUI に出す。届かなければ選択肢 + 「ターミナルで答える」のみ。
- サブエージェント内の AskUserQuestion も同じ hook が受ける(公式ドキュメント。`agent_id` / `agent_type` が入る。実機は E6)。カードに表示する。
- bind は `127.0.0.1` のみ。認可は上記のトークン + cookie。
- ExitPlanMode の承認は「承認」「承認して auto」「却下 + 一言」の 3 択。「承認して auto」が E3 で効かなければ、ExitPlanMode の捕捉を MVP から外す(AskUserQuestion だけで (a')(b)(d) は測れる)。

## 4. 初日〜2 日目の追加検証(実装と並行。E1〜E5 は着手済み、追補を送付済み)

`verification/hook.mjs` を流用し、結果は `docs/verification/02-hook-limits.md` に書く。

| # | 問い | やり方 | 計画への影響 |
|---|---|---|---|
| E1 | hook `timeout` の上限、長時間ブロック中の表示、中断時の挙動 | `timeout: 3600` と `86400` で 660 秒ブロックし、`hook_cancelled` の有無と `timeoutMs` で丸めを判定。`statusMessage` の表示。Esc / ctrl+c で hook が受けるシグナルと transcript、その後の Claude | 上限が低ければ budget と GUI の残り時間表示を合わせる |
| E2 | `answers` の変種 | ラベルに無い自由文、`multiSelect` の結合、`answers: {}`、キー不一致、2 問中 1 問だけ回答。Claude が受け取る文面を transcript で確認 | 自由記述の可否、エラー時の扱い、区切り文字 |
| E3 | ExitPlanMode の deny と、承認後のモード復帰 | 却下理由を返し、Claude が計画を直して再提出するか(往復回数、plan の文字数)。allow 後の最初の PermissionRequest で `updatedPermissions: [{type: "setMode", mode: "auto", destination: "session"}]` が効くか。2 KB の deny 理由文の表示と切り詰め | 却下 UI、「承認して auto」の成立、ExitPlanMode を MVP に残すか |
| E4 | deny で説明を書かせる往復(**Day 2 のゲート**) | 3 種類の判断(設計分岐 / 取り消しにくい操作 / 命名)× 2 回、うち 1 回は opus。`<scratchpad_dir>/ukagai/` への Write が default / acceptEdits / plan でプロンプト無しで通るか。命令文と「事実 + 依頼」で再呼び出し率が変わるか。往復回数、秒数、同じ質問を再度出したか、説明の質 | 理由文の文面と文体、2 分 / 10 分の値、(b) への上乗せ。**再呼び出し率 80% 未満か往復 2 回超なら 8 節の分岐** |
| E5 | SessionStart の `additionalContext` だけで事前に書くか | E4 と同じ 3 種類で、deny 無しに 1 回目から説明ファイルが付く率。`/clear` 後に再注入されるか | 指示文の文面。付く率が高ければ deny は保険のまま |
| E6 | サブエージェント | Explore 内で AskUserQuestion を呼ばせ、hook の発火、`session_id` / `agent_id` / `scratchpad_dir`、親ターミナルでの表示、sync の SubagentStart `additionalContext` が届くか | 対応付けのキー、文脈収集のパス、サブエージェントへの事前指示 |
| E7 | フェイルオープンの実測 | server 不在で 1 秒で諦める hook にして、AskUserQuestion が 1〜2 秒で通常 UI に落ちるか | W4 のテストの裏付け |

## 5. 分割と担当

分ける。hook と server は契約(W2)を先に固定すれば編集ファイルが独立し、E 系は実装と無関係に走る。設計判断(対応付け、認可、モード復帰)はこの v2 で確定したので、すべて `sonnet` / `medium`。不可逆な変更(migration / 公開 API / 課金)は無い。W6 はユーザー設定ファイルを書き換えるが、バックアップと dry-run を受け入れ条件に含める。

| # | タスク | 触るファイル | モデル | effort | 依存 | 受け入れ条件 |
|---|---|---|---|---|---|---|
| 0 | main に最初のコミット | ― | 済 | ― | ― | 済 |
| W1 | 骨格 | ― | 済(main にマージ済み) | ― | ― | 済 |
| W2 | 契約: `src/contract.ts`(zod。Decision / API の入出力 / hook 出力 / events)と `docs/spec/api.md`。01 の stdin / stdout JSON を fixture に | `src/contract.ts`、`docs/spec/api.md`、`test/contract.test.ts`、`test/fixtures/**` | sonnet | medium | W1 | fixture が schema を通る。不正な `answers`、不正な status 遷移、`transcript_path` が `~/.claude/projects/` 外のものが弾かれる |
| E1〜E7 | 追加検証 | `verification/`、`docs/verification/02-hook-limits.md` | sonnet | medium | ― | 4 節の表が埋まる。推測は「推測」と書く |
| W7 | 説明の仕様と skill: `docs/spec/explain.md`(置き場、front matter、必須節と条件、照合規則、deny 理由文のテンプレート、SessionStart / SubagentStart の 3 行、ExitPlanMode の節の照合)と `skills/ukagai-explain/SKILL.md`(何を図にし、何を表にし、差分をどう切り出すか。良い例 1 つ・悪い例 1 つ)。fixture: 通る説明 3 つ・落ちる説明 3 つ・見出しが微妙に違う計画(通る) | `docs/spec/explain.md`、`skills/ukagai-explain/**`、`test/explain-fixtures/**` | sonnet | medium | W2(並列可)。deny 文面と閾値は E4 / E5 の結果で最後に直す | fixture の期待判定が spec の規則から一意に導ける |
| W3 | serve: Hono + `@hono/node-server`、store(メモリ + JSONL + 起動時復元)、API、long-poll と lease、ack、認可(トークン + cookie + Host + Content-Type)、SSE、`public/` 配信、文脈収集 `src/server/context.ts`、metrics | `src/server/**`、`test/server/**` | sonnet | medium | W2 | 一時ポートで fetch するテスト: 登録 → wait 204 → answer → wait 200 → ack で `answered`。ack 無しは `answered` にならない。poll 途絶で lease 切れ → `hook_disconnected`。偽 Host で 400、トークン無しの answer が 401、`transcript_path: /etc/passwd` が弾かれる。再起動で `pending` が復元される。git 無しの cwd でも落ちない |
| W4 | hook: stdin → 振り分け → server → stdout。budget と境界規則、フェイルオープン(接続不可 / 404 / 5xx)、ack、説明ファイルの探索・照合・形式検査・deny 理由文・ループ保険(`src/hook/explain.ts`)、`denied_explain` 登録、SessionStart / SubagentStart の `additionalContext`、PermissionRequest の `setMode`、Stop の `escaped_question`、`--observe` | `src/hook/**`、`test/hook/**` | sonnet | medium | W2, W7 の spec(W3 と並列) | 偽 server に対するテスト: allow 出力が 01 の JSON と一致。server 不在で stdout 空・exit 0・1 秒以内。残り時間が poll + 5 秒未満で poll せず fallback。説明ファイル無し → deny 文に保存先と `question:` の原文が入る。形式不備 → 足りない項目名が入る。2 分以内に 2 回目 → `none / loop_guard` で登録。plan mode → 要求しない。W7 の fixture 6 + 1 がそのとおり判定される |
| W5 | GUI: 保留一覧、質問カード、計画カード(承認 / 承認して auto / 却下 + 一言)、説明パネル(Markdown + 表 + Mermaid + diff。描画失敗時はコード表示)、補助文脈パネル、セッション一覧(開いた回数を events に送る)、SSE 反映、「ターミナルで答える」、「説明なし」の印、`answer_lost` の表示 | `public/**`、`package.json` の `vendor` script 1 行 | sonnet | medium | W3 | agent-browser で: curl で登録した判断が 1 秒以内に一覧に出る、Mermaid が描画される、壊れた Mermaid がコード表示になる、選択肢を押すと wait が 200 で返る。スクショ 3 枚を scratchpad に |
| W6 | install / uninstall / doctor: settings のマージ(exec form、`statusMessage`、`--budget` の導出)、バックアップ、`--dry-run`、`--project`、`--settings`、skill の配置 | `src/install/**`、`src/uninstall/**`、`src/doctor/**`、`test/install/**` | sonnet | medium | W1, W4, W7 | 一時 HOME でテスト: 既存 hooks を保持、2 回実行しても重複しない、uninstall で元に戻る、`.bak` が残る、skill が置かれ消える、生成された command が exec form |
| R1 | 実装レビュー(W3 + W4 の差分): 契約との一致、テストが主張どおり落ちうるか、フェイルオープンの経路が全部あるか、認可の抜け | ― | sonnet | medium | W3, W4 | 報告 md。致命があれば担当に差し戻し |
| R2 | 実装レビュー(W6): ユーザー設定を壊す経路が無いか | ― | sonnet | medium | W6 | 報告 md |
| V1 | E2E 実機: `serve` 起動 → `install --settings verification/e2e-settings.json` → Herdr で probe 起動 → 説明付きの判断 1 件、説明なし → deny → 書き直しの 1 件、計画承認(承認して auto)1 件、server 停止中のフェイルオープン 1 件 | `docs/verification/03-e2e.md` | sonnet | medium | W5, W6 | 画面・hook ログ・transcript の 3 点を記録 |
| D1 | README の表に 03 と spec を足す | `README.md` | haiku | ― | 最後 | ― |

並列の組: {W2, W7 の spec, E1〜E7} → {W3, W4(W7 の spec 確定後)} → {W5, W6} → {R1, R2} → V1。lockfile と `package.json` は直列(W5 の `vendor` script は 1 行なのでマージで解く)。W5 は `public/` と `package.json` の 1 行だけを触り、`public/` の配信ルートは W3 が先に作る。各 worker は worktree で作業し、git の書き込みはオーケストレータが行う。

## 6. 日程

| 日 | 作業 | 完了条件 |
|---|---|---|
| 1(済〜) | 0、W1(済)、レビュー反映(済)、W2、W7 の spec、E1〜E7(着手済み) | 契約と spec が main に入る。`docs/verification/02-hook-limits.md` に E1〜E3、E6、E7 |
| 2 | E4 / E5 の結果でゲート判定 → W7 の deny 文面確定。W3 ∥ W4 | 偽 server / 一時ポートのテストが通る。fixture 7 つが期待どおり判定される |
| 3 | W3 / W4 続き、R1。**基準値測定**: 自分の通常作業を `hook --observe` で 1 日(serve を立て、`--settings` で observe だけ登録) | (b) の基準値が `GET /api/metrics` に出る |
| 4 | W5 ∥ W6 | GUI で Mermaid と比較表の付いた判断に答えられる。install が dry-run と実書き込みで動く |
| 5 | V1、R2、修正。終わったら自分の `~/.claude/settings.json` に install して dogfood 開始 | `docs/verification/03-e2e.md`。自分の作業で最初の 1 件が説明付きで GUI に出る |
| 6〜14 | 自分の実作業で使う。(a')(b)(d) は server の集計、(c) と説明の採点は手で記録。skill と deny 文面の調整は可、機能追加はしない | Day 14 に `docs/verification/04-metrics.md` へ 4 指標と判定 |

## 7. やらないこと(MVP)

- MCP サーバー。説明はファイル + hook で受け取る。
- ACP クライアント、Claude Code 以外のエージェント(2 週目以降に (b)(c) が改善していれば着手)。
- PermissionRequest の集約・自動解決ポリシー(「承認して auto」直後の 1 件だけは例外)。
- 認可の限界への対処: 同一ユーザーの他プロセスが `~/.ukagai/token` を読めば API を叩ける。企業向けの fail-closed と合わせて 2 週目以降。
- 認証(ログイン)、リレー、モバイル、デッキ操作(スワイプ)、デザインの作り込み、SQLite。
- 説明の形式の拡張(スクショ、画像、Mermaid 以外の図)。1 週目は Markdown + 表 + Mermaid + diff だけ。

## 8. リスクと分岐

| リスク | 手当て |
|---|---|
| **E4 で deny → 書く → 同じ質問を再度出す、が成立しない**(再呼び出し率 80% 未満、または往復 2 回超) | deny の保険を外し、SessionStart / SubagentStart の事前指示 + `attached_via` の計測だけにする。(d) は測れる。W4 の `explain.ts` は探索と照合だけ残す |
| E3 で `setMode auto` が効かない | ExitPlanMode の捕捉を MVP から外す。AskUserQuestion だけで (a')(b)(d) は測れる |
| hook `timeout` に低い上限がある(E1) | install が settings の `timeout` から `--budget` を導出し、GUI に残り時間を出す。切れたら通常 UI に落ちるだけで作業は止まらない |
| transcript の遅延で直前の文脈が欠ける | 空で出す。500 ms 後に 1 回だけ再読 |
| hook 環境に `node` が無い(Desktop アプリ起動など) | install が `process.execPath` を exec form の `command` に書く |
| 文章で聞いて逃げる判断が捕捉されない | Stop hook の `escaped_question` で数だけ見る。多ければ 2 週目に事前指示を強める |
| 説明を書く分だけ (b) が伸びる | エージェント側(`first_denied_at → created_at`)と人側(`created_at → decided_at`)を分けて集計 |
| 説明の質が低い(図が飾り、表が埋まっていない) | 図の必須条件を `scope` / `reversibility` で絞った。(d) の手採点を 1 日 3 件。skill の良い例・悪い例を実例で差し替える |
| Claude 自身が API を叩いて自己回答する | トークン認可 + 理由文に URL を書かない。限界は 7 節 |

## 9. 未確認の一覧(「動く」と書いていないこと)

| 事項 | 状態 |
|---|---|
| 注入(allow + updatedInput)が通る | 確認済み。ただし Claude Code 2.1.287 × Sonnet 5.5 × auto mode のみ。opus / default / acceptEdits は E4 で一部確認 |
| deny → 説明を書く → 同じ質問を再度出す | 未確認(E4) |
| 出力なし exit 0 で通常 UI に落ちる | 公式ドキュメントに記述あり。実機は E7 |
| budget 切れで自分で降りて fallback を記録できる | 推測(境界規則は 3 節) |
| `<scratchpad_dir>/ukagai/` に auto 以外のモードで書ける | 未確認(E4) |
| ExitPlanMode の deny 後に再提出する | 未確認(E3) |
| PermissionRequest の `setMode auto` でモードが戻る | 公式ドキュメントに記述あり。実機は E3 |
| 2 分 / 10 分の閾値 | 根拠なし。E4 で往復時間を測ってから確定 |
| timeout 3600 が丸められない | 未確認(E1) |
| SessionStart / SubagentStart の `additionalContext` で事前指示が効く | 未確認(E5 / E6) |
| multiSelect の区切り、自由記述、キー不一致・欠落 | 未確認(E2) |
| サブエージェント内の hook 発火と `agent_id`、`session_id` の同一性、transcript のパス | 公式ドキュメントに記述あり。実機は E6 |
