# MVP 実装計画(hook + GUI 方式、MCP なし)

2026-10-02。`02-mvp-plan.md` の技術決定と日程を置き換える。指標と打ち切り条件は 02 を引き継ぐ。根拠は `docs/verification/01-askuserquestion-injection.md`。

## 1. 方針の変更点

| 項目 | 02 の決定 | この計画 | 理由 |
|---|---|---|---|
| 判断の捕捉 | MCP `ask_decision` を CLAUDE.md で使わせる。使われなければ hook で強制 | **PreToolUse hook が AskUserQuestion / ExitPlanMode を横取りし、GUI の回答を `updatedInput` で返す。** MCP も CLAUDE.md の指示も無し | 対話セッションで注入が通ることを実機確認済み(T1 / T3b / T3c / T5)。エージェントの協力が要らず、最初から強制になる |
| 説明の帯域 | MCP `show_diff` / `show_diagram` / `compare_options` をエージェントに呼ばせる | **エージェントに人向けの説明(なぜ今この判断か、選択肢の比較表、Mermaid 図、関係する差分)を Markdown で書かせ、hook が拾って GUI に描く。** 書かずに質問したら hook が deny + 理由で書き直させる。server は `git diff` と直近のツール呼び出しを補助として自動で添える | ここが製品の核(00-overview 3 節の空白 2)。MCP 無しでも skill(書き方)+ SessionStart の指示(事前)+ PreToolUse の deny(強制)で成立する。Claude が deny の理由に従うことは T4 で確認済み |
| 状況の地図 | hooks(Notification / Stop)+ ACP | **Claude Code の観測 hook(async)だけ。** ACP と 2 社目は 2 週目 | 1 週目は「判断を 1 か所に集めると速くなるか」だけを測る |
| 永続化 | SQLite | **JSONL 追記**(`~/.ukagai/`) | 1 週間分の判断ログに検索は要らない。エクスポートはファイルコピー。必要になれば `node:sqlite` に移す |
| UI | Vite + React | **ビルド無しの静的 HTML / JS**(`public/`) | カード 2 型と一覧だけ。ビルド工程を 1 つ減らす |
| パッケージ管理 | pnpm | **npm** | この機械の pnpm(corepack)は未セットアップで `pnpm --version` が失敗する(観察)。Node 24 同梱の npm 11 で足りる |

## 2. ゴールと指標(02 を引き継ぎ、(a) だけ差し替え)

| 指標 | 取り方 | 続行の目安 |
|---|---|---|
| (a') GUI 回答率 | 捕捉した判断のうち、GUI で回答した割合(server が自動集計。`response.via` が `gui` / `terminal`) | 90% 未満なら、ターミナルに戻した理由を 1 件ずつ記録して原因を潰す |
| (b) 判断 1 件の所要時間 | `created_at` → `decided_at` の秒数(自動集計)。基準値は MVP 前に通常運用で 1 日分、手で計測 | 基準値比で短くならなければ「説明の帯域」仮説が外れている |
| (c) pane を開き直した回数 | 1 日あたり、判断のためにターミナルへ戻った回数を手で記録。GUI の「ターミナルで答える」押下数を補助指標にする | 半減しなければ「地図」仮説が外れている |
| (d) 説明の添付率と質 | 判断ごとに `explanation.attached_via`(`first_call` / `after_deny` / `none`)を自動集計。質は 1 日 3 件を手で採点(図・比較表が判断に効いたか) | `none` が 10% を超えるなら deny の理由文を直す。採点が低ければ skill の書き方を直す |

打ち切り条件は 02 のまま: (b) と (c) の両方が改善しなければ 2 週間以内に止める。

## 3. アーキテクチャ

### プロセス

```
Claude Code ──PreToolUse(AskUserQuestion|ExitPlanMode)──▶ ukagai hook ──POST /api/decisions──▶ ukagai serve ──SSE──▶ ブラウザ(GUI)
                                                              │                                    ▲                 │
                                                              └──GET /api/decisions/:id/wait ◀─────┴── POST /answer ─┘
                                                              ▼
                                                   stdout: allow + updatedInput  /  deny + reason  /  出力なし(ターミナル UI に戻す)
Claude Code ──観測 hook(async)──▶ ukagai hook ──POST /api/events──▶ serve(セッション一覧)
```

- `ukagai serve`: `127.0.0.1:4818`。HTTP API + SSE + `public/` の配信。状態はメモリ、`~/.ukagai/decisions.jsonl` と `~/.ukagai/events.jsonl` に追記。
- `ukagai hook`: Claude Code の hook から呼ばれる単一コマンド。`hook_event_name` と `tool_name` で振り分ける。
  - PreToolUse × AskUserQuestion / ExitPlanMode: 判断を登録し、回答まで long-poll で待ち、hook 出力 JSON を stdout に書く。
  - それ以外(観測 hook): `POST /api/events` に投げて即終了。
- GUI: 保留一覧、カード(質問 / 計画)、文脈パネル、セッション一覧。

### フェイルオープン(MVP の決定)

- server に接続できない(1 秒以内に失敗): 何も出力せず exit 0 → Claude Code の通常 UI に落ちる。
- hook の持ち時間(`--budget` 秒)を使い切る: 何も出力せず exit 0 → 通常 UI。SIGTERM で殺される前に自分で降りることで、server 側に `fallback` を記録できる(T3a では SIGTERM 後に何も記録できなかった)。
- GUI の「ターミナルで答える」: server が `fallback` を返し、hook は何も出力せず exit 0。
- 企業向けの fail-closed は MVP の対象外。

### 契約(`src/contract.ts`、zod。`docs/spec/api.md` に同じ内容を人向けに書く)

```ts
type Decision = {
  id: string;                        // ulid
  kind: "answer_question" | "approve_plan";
  tool_use_id: string;               // 冪等キー
  session: { session_id: string; cwd: string; transcript_path: string; permission_mode?: string;
             agent_id?: string; agent_type?: string; title?: string };
  request: AskUserQuestionInput | ExitPlanModeInput;   // hook の tool_input をそのまま
  context: { branch?: string; git_status?: string; git_diff_stat?: string; git_diff?: string;
             last_assistant_text?: string; recent_tools?: { name: string; summary: string }[] };
  explanation?: { path: string; title?: string; reversibility?: "reversible" | "costly" | "irreversible";
                  scope?: "file" | "repo" | "machine" | "external"; markdown: string;
                  has: { mermaid: boolean; table: boolean; diff: boolean };
                  attached_via: "first_call" | "after_deny" | "none" };   // エージェントが書いた説明
  status: "pending" | "answered" | "fallback" | "hook_disconnected";
  created_at: string;
  response?: { via: "gui" | "terminal";
               answers?: Record<string, string>;      // answer_question
               approve?: boolean; reason?: string;    // approve_plan
               decided_at: string };
};
```

| API | 役割 |
|---|---|
| `POST /api/decisions` | hook が登録。`tool_use_id` が同じなら既存を返す(冪等) |
| `GET /api/decisions/:id/wait?timeout_ms=25000` | long-poll。回答済みなら 200 + response、未回答で timeout なら 204(hook は budget が尽きるまで繰り返す)。接続が切れたら `hook_disconnected` を立てる |
| `POST /api/decisions/:id/answer` | GUI から。`{answers}` / `{approve:true}` / `{approve:false, reason}` / `{fallback:true}` |
| `GET /api/decisions?status=pending` / `GET /api/decisions/:id` | 一覧・詳細 |
| `POST /api/events` | 観測 hook の生 JSON を受けてセッション状態を更新 |
| `GET /api/sessions` | セッションごとの最終イベント・状態(working / waiting_decision / idle / ended) |
| `GET /api/stream` | SSE: `decision.created` / `decision.answered` / `session.updated` |
| `GET /healthz` | hook の接続確認 |

hook の出力(検証で確定した形):

| 判断 | GUI の操作 | stdout |
|---|---|---|
| answer_question | 選択肢を選ぶ | `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"questions":<原文>,"answers":{"<question>":"<label>"}}}}` |
| approve_plan | 承認 | 同上で `updatedInput` は `tool_input` をそのまま |
| approve_plan | 却下 + 一言 | `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"<一言>"}}`(Claude が計画を直して再提出するかは E3 で確認) |
| どちらも | 説明ファイルが無い / 形式不備(1 回目) | `deny` + 理由(足りない項目、保存先、skill 名)。Claude が書いて再度呼ぶ |
| どちらも | ターミナルで答える / 接続不可 / budget 切れ | 出力なし、exit 0 |

### 文脈の収集(server 側、判断登録時にベストエフォート、各 500 ms 上限)

- git: `rev-parse --abbrev-ref HEAD`、`status --porcelain`、`diff --stat`、`diff`(200 KB で打ち切り)。
- transcript: 末尾 200 行を読み、直前の assistant テキスト(質問に至った理由)、直近 10 件の tool_use(名前 + ファイルパス / コマンドの先頭)、`ai-title` 行を拾う。transcript は書き込みが遅れることがある(公式ドキュメント)ので、取れなければ空のまま出す。

### 説明の経路(エージェント側。製品の核)

エージェントに「人が判断するための説明」を書かせる。MCP の代わりに 3 層で成立させる。

| 層 | 仕組み | 役割 |
|---|---|---|
| 書き方 | skill `ukagai-explain`(`skills/ukagai-explain/SKILL.md`。install が `~/.claude/skills/` に置く) | 説明ファイルの形式と、何を図にし何を表にするかの指針。deny の理由文からも参照させる |
| 事前の指示 | SessionStart hook が `additionalContext` で 3 行の指示を入れる(CLAUDE.md スニペットの hook 版) | 1 回目の呼び出しで説明が付く率を上げ、deny の往復を減らす |
| 強制 | PreToolUse hook が説明ファイルを探し、無ければ / 形式不備なら `deny` + 理由で書き直させる | T4 で Claude が理由文に従うことを確認済み。指示に従わない場合の保険 |

説明ファイルの置き場と形式(`docs/spec/explain.md` に正式に書く):

- 置き場: `~/.ukagai/explain/<session_id>/<連番>.md`。リポジトリの中には置かない。
- 形式: front matter(`ukagai: 1`、`for: AskUserQuestion | ExitPlanMode`、`title`、`reversibility`、`scope`)+ 本文。本文は「なぜ今この判断が要るか」「選択肢の比較(表)」「図(```mermaid)」「関係する差分(```diff)」の見出しで、比較表と図は選択肢が 2 つ以上なら必須、差分はコード変更が絡むなら必須。
- ExitPlanMode は別ファイルを要求しない。計画本文(`tool_input.plan`)に Mermaid の図と「影響範囲と可逆性」の節が入っていることを hook が確認し、無ければ deny で直させる。

hook の判定:

1. AskUserQuestion を受けたら `~/.ukagai/explain/<session_id>/` で、未使用かつ 10 分以内に書かれた最新の `.md` を探す。
2. 見つかり、形式が通れば `attached_via: first_call` で登録。
3. 無い / 形式不備なら `deny`。理由文は「足りない項目を列挙 + 保存先のフルパス + 『skill ukagai-explain に従って書き、同じ質問をもう一度 AskUserQuestion で出す』」。
4. 同じセッションで 2 分以内に deny 済みなのにまだ無ければ、ループを避けるため説明なし(`attached_via: none`)で GUI に出す。GUI には「説明なし」の印を付け、指標 (d) に数える。

GUI の描画: Markdown(見出し・表・コードブロック)、Mermaid(`mermaid.min.js` を `public/vendor/` に同梱、CDN は使わない)、diff(unified の色付け)。

### Claude Code への登録(`ukagai install`)

- 既定は `~/.claude/settings.json`。`--project` で `.claude/settings.json`、`--settings <file>` で任意ファイル(開発中はこれを使い、自分のセッションに hook をかけない)。
- 既存の hooks を壊さずマージし、書く前に `settings.json.bak-<timestamp>` を取る。`--dry-run` で差分表示。`ukagai uninstall` で自分の登録だけ外す。
- command は PATH に頼らず絶対パスで書く: `"<process.execPath> <repo>/dist/cli.js hook --budget 3590"`。
- skill `ukagai-explain` を `~/.claude/skills/ukagai-explain/SKILL.md` にコピーする(`--project` なら `.claude/skills/`)。`uninstall` で消す。
- 登録する hook:

| event | matcher | timeout | async |
|---|---|---|---|
| PreToolUse | `AskUserQuestion\|ExitPlanMode` | 3600(E1 の結果で調整) | no |
| SessionStart | なし | 5 | no(`additionalContext` を返すため同期) |
| UserPromptSubmit / Stop / SubagentStart / SubagentStop / SessionEnd | なし | 5 | yes |
| PostToolUse | `Edit\|Write\|MultiEdit\|NotebookEdit` | 5 | yes |
| Notification | `permission_prompt\|idle_prompt` | 5 | yes |

### 決めた細部

- 1 回の AskUserQuestion に質問が 1〜4 個入る。カードは全部出し、全問に答えてから送る。`multiSelect` はラベルを `, ` で結合(公式ドキュメントの記述。E2 で確認)。
- 自由記述は E2 で Claude に届くと確認できた場合だけ GUI に出す。届かなければ選択肢 + 「ターミナルで答える」のみ。
- サブエージェント内の AskUserQuestion も同じ hook が受ける(`agent_id` / `agent_type` が入る)。カードに表示する。
- bind は `127.0.0.1` のみ。認証なし。
- ExitPlanMode を注入承認すると権限モードが `default`(manual)になる(T5)。MVP では GUI の承認完了画面に「auto に戻すなら shift+tab」と出すだけ。hook から戻す手段は無い(推測。E3 で `updatedInput` の余分な欄が無視されることだけ確認する)。

## 4. 初日の追加検証(実装と並行)

`verification/hook.mjs` を流用し、結果は `docs/verification/02-hook-limits.md` に書く。

| # | 問い | やり方 | 計画への影響 |
|---|---|---|---|
| E1 | hook `timeout` の上限と、長時間ブロック中の表示 | `timeout: 3600` と `86400` で 70 秒ブロック。状態行・スピナー・Notification hook の発火・Esc / ctrl+c での中断を観察 | 上限が低ければ GUI に残り時間を出し、budget を合わせる |
| E2 | `answers` の変種 | ラベルに無い自由文、`multiSelect` の結合、キー欠落、キー不一致の 4 通りで Claude が受け取る文面を transcript で確認 | 自由記述の可否、エラー時の扱い |
| E3 | ExitPlanMode の deny + 理由 | 却下理由を返し、Claude が計画を直して再度 ExitPlanMode を呼ぶか。allow 時に `updatedInput` へ余分な欄を足しても無視されるか | 却下 UI を出すか、モード復帰を諦めるか |
| E4 | deny で説明を書かせる往復 | 1 回目の AskUserQuestion を deny し、理由に保存先と形式(front matter、比較表、Mermaid)を書く。Claude がファイルを書いて同じ質問を再度出すか、往復回数、所要秒数、書かれた説明の質を見る。3 種類の判断(設計分岐 / 削除系の操作 / 命名)で各 2 回 | 理由文の文面、ループ保険の閾値、(b) への上乗せ時間 |
| E5 | SessionStart の `additionalContext` だけで事前に書くか | E4 と同じ 3 種類で、deny 無しに 1 回目から説明ファイルが付く率を見る | 指示文の文面。付く率が高ければ deny は保険に下げる |

## 5. 分割と担当

分ける。hook と server は契約(W2)を先に固定すれば編集ファイルが独立し、E1〜E3 は実装と無関係に走る。すべて `sonnet` / `medium`: 触るファイルと受け入れ条件はこの計画で決まっており、不可逆な変更(migration / 認可 / 公開 API)は無い。W6 はユーザー設定ファイルを書き換えるが、バックアップと dry-run を受け入れ条件に含めるので「難」には当たらない。

| # | タスク | 触るファイル | モデル | effort | 依存 | 受け入れ条件 |
|---|---|---|---|---|---|---|
| 0 | main に最初のコミット(docs / verification / .gitignore)。worktree を切る前提 | ― | オーケストレータ(ユーザーの了解を得て) | ― | ― | `git log` に 1 件 |
| W1 | 骨格: `package.json`(npm)、`tsconfig.json`、`src/cli.ts`(serve / hook / install / uninstall / doctor の振り分けとスタブ)、`node --test` + `tsx`、`.gitignore`、`CLAUDE.md`(短く) | ルート、`src/cli.ts` | sonnet | medium | 0 | `npm run build` / `npm test` が通る。`node dist/cli.js --help` にサブコマンドが出る |
| W2 | 契約: `src/contract.ts`(zod)と `docs/spec/api.md`。検証 01 の stdin / stdout JSON をテストの fixture に使う | `src/contract.ts`、`docs/spec/api.md`、`test/contract.test.ts` | sonnet | medium | W1 | fixture が schema を通る。不正な `answers` が弾かれる |
| E1〜E3 | 初日の追加検証 | `verification/`、`docs/verification/02-hook-limits.md` | sonnet | medium | ― | 4 節の表が埋まる。推測は「推測」と書く |
| W3 | serve: Hono + `@hono/node-server`、store(メモリ + JSONL)、API、long-poll、SSE、`public/` 配信、文脈収集 `src/server/context.ts` | `src/server/**`、`test/server/**` | sonnet | medium | W2 | 一時ポートで起動して fetch するテスト: 登録 → wait が 204 → answer → wait が 200。冪等。接続切れで `hook_disconnected`。git 無しの cwd でも落ちない |
| W4 | hook: stdin → 振り分け → server → stdout。budget、フェイルオープン、観測イベント転送。説明ファイルの探索・形式検査・deny 理由文の生成・ループ保険(`src/hook/explain.ts`)。SessionStart の `additionalContext` | `src/hook/**`、`test/hook/**` | sonnet | medium | W2, W7 の spec(W3 と並列) | 偽 server に対するテスト: allow 出力が検証 01 の JSON と一致。server 不在で stdout 空・exit 0・1 秒以内。budget 切れで stdout 空。観測イベントは 100 ms 以内に終了。説明ファイル無し → deny 文に保存先が入る。形式不備 → 足りない項目名が入る。2 分以内に 2 回目 → `attached_via: none` で登録 |
| W5 | GUI: 保留一覧、質問カード、計画カード、説明パネル(Markdown + 表 + Mermaid + diff の描画。`marked` と `mermaid` を `public/vendor/` に同梱)、補助文脈パネル、セッション一覧、SSE 反映、「ターミナルで答える」、「説明なし」の印 | `public/**` のみ | sonnet | medium | W3 | agent-browser で: curl で登録した判断が 1 秒以内に一覧に出る、Mermaid が描画される、選択肢を押すと wait が 200 で返る。スクショ 3 枚を scratchpad に |
| W6 | install / uninstall / doctor: settings のマージ、バックアップ、`--dry-run`、`--project`、`--settings`、絶対パス、skill の配置 | `src/install/**`、`test/install/**` | sonnet | medium | W1, W4, W7 | 一時 HOME でテスト: 既存 hooks を保持、2 回実行しても重複しない、uninstall で元に戻る、`.bak` が残る、skill が置かれ消える |
| W7 | 説明の仕様と skill: `docs/spec/explain.md`(置き場、front matter、必須節、hook の判定規則、deny 理由文のテンプレート、SessionStart の 3 行)と `skills/ukagai-explain/SKILL.md`(何を図にし、何を表にし、差分をどう切り出すか。良い例 1 つ・悪い例 1 つ) | `docs/spec/explain.md`、`skills/ukagai-explain/**`、`test/explain-fixtures/**` | sonnet | medium | W2(W3 / W4 と並列。W4 は spec を読んでから実装) | fixture: 通る説明 3 つ・落ちる説明 3 つを用意し、W4 の検査がそのとおりに判定する。E4 / E5 の結果を反映して文面を直す |
| R1 | 実装レビュー(W3 + W4 の差分): 契約との一致、テストが主張どおり落ちうるか、フェイルオープンの経路が全部あるか | ― | sonnet | medium | W3, W4 | 報告 md。致命があれば担当に差し戻し |
| R2 | 実装レビュー(W6): ユーザー設定を壊す経路が無いか | ― | sonnet | medium | W6 | 報告 md |
| V1 | E2E 実機: `serve` 起動 → `install --settings verification/e2e-settings.json` → Herdr で probe 起動 → 検証 01 の T1 と同じプロンプト → GUI(agent-browser)で回答 → Claude が復唱。計画承認も 1 回 | `docs/verification/03-e2e.md` | sonnet | medium | W5, W6 | 画面・hook ログ・transcript の 3 点を記録 |
| D1 | README の表に 03 と spec を足す、02 の冒頭に「置き換え」注記 | `README.md`、`docs/strategy/02-mvp-plan.md` | haiku | ― | 最後 | ― |

並列の組: {W3, W7, E1〜E5} → {W4(W7 の spec 確定後), W3 続き} → {W5, W6}。W1 と W2 は直列(package.json / lockfile / 契約)。W7 は仕様が先、skill 文面は E4 / E5 の結果を見て最後に直す。W5 は `public/` だけを触り、`public/` の配信ルートは W3 が先に作る。各 worker は worktree で作業し、git の書き込みはオーケストレータが行う。

## 6. 日程

| 日 | 作業 | 完了条件 |
|---|---|---|
| 1 | 0、W1、W2。並行で E1〜E5(E4 / E5 は `verification/hook.mjs` に deny 文面を足して行う) | 骨格と契約がテスト付きで main に入る。`docs/verification/02-hook-limits.md` に E1〜E5 |
| 2 | W7 の spec → W3 ∥ W4、R1 | 偽 server / 一時ポートのテストが通る。説明ファイルの fixture 6 つが期待どおり判定される。契約の齟齬ゼロ |
| 3 | W5 ∥ W6、W7 の skill 文面 | GUI で Mermaid と比較表の付いた判断に答えられる。install が dry-run と実書き込みで動き、skill が置かれる |
| 4 | V1(説明付きの判断 1 件と、説明なし → deny → 書き直しの 1 件を含む)、R2、修正。終わったら自分の `~/.claude/settings.json` に install して dogfood 開始 | `docs/verification/03-e2e.md`。自分の作業で最初の 1 件が説明付きで GUI に出る |
| 5〜7 | 自分の実作業で使う。(a')(b)(d) は server の集計、(c) と説明の採点は手で記録。skill と deny 文面の調整は可、機能追加はしない | `docs/verification/04-week1-metrics.md` に 4 指標と判定 |

## 7. やらないこと(MVP)

- MCP サーバー。説明はファイル + hook で受け取る。
- ACP クライアント、Claude Code 以外のエージェント(2 週目に (b)(c) が改善していれば着手)。
- PermissionRequest の集約・自動解決(ExitPlanMode 承認後の manual モード対策はここに含まれるので、2 週目の候補)。
- 認証、リレー、モバイル、デッキ操作(スワイプ)、デザインの作り込み、SQLite。
- 説明の形式の拡張(スクショ、画像、Mermaid 以外の図)。1 週目は Markdown + 表 + Mermaid + diff だけ。

## 8. リスクと手当て

| リスク | 手当て |
|---|---|
| hook `timeout` に低い上限がある(E1) | budget を合わせ、GUI に残り時間を出す。切れたら通常 UI に落ちるだけで作業は止まらない |
| ExitPlanMode 注入後に manual モードになる(T5) | MVP は案内表示のみ。2 週目に PermissionRequest hook で auto 相当のポリシーを持つか判断 |
| transcript の遅延で直前の文脈が欠ける | 空で出す。500 ms 後に 1 回だけ再読。Stop hook の `last_assistant_message` は質問時点では使えないので当てにしない |
| hook 環境に `node` が無い(Desktop アプリ起動など) | install が `process.execPath` の絶対パスを書く |
| Herdr が `blocked` を検出しなくなる(注入で UI が出ないため) | 仕様どおり。ukagai 側のセッション一覧が代わりになる |
| deny の往復で Claude が同じ質問を出さない、または別の形で聞いてくる(E4) | 理由文に「同じ質問をもう一度 AskUserQuestion で」と明記。2 分以内の 2 回目は説明なしで通す保険。E4 で往復回数を測り、2 回を超えるなら SessionStart の事前指示を強める |
| 説明を書く分だけ (b) が伸びる | 判断の所要時間を「エージェント側(1 回目の deny → 登録)」と「人側(登録 → 回答)」に分けて集計し、仮説が効いているのは人側だと切り分ける |
| 説明の質が低い(図が飾り、表が埋まっていない) | (d) の手採点を 1 日 3 件。skill の良い例・悪い例を実例で差し替える |
