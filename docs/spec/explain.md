# 説明ファイルの仕様

エージェントが人に判断を求める前に書く「説明」の形式と、hook(`src/hook/explain.ts`)が行う検査の規則。実装計画は `docs/strategy/03-mvp-implementation-plan.md` の 3 節「説明の経路」。この文書の規則が実装と fixture(`test/explain-fixtures/`)の正になる。

**v2 の方針**: 人が GUI で矢印キーと Enter だけで決められるように、エージェントに判断材料を考え抜かせる。GUI は `AskUserQuestion` の生の質問文・選択肢をそのまま出さず、説明ファイル(`title` / 「推奨」節 / 「選択肢」の表)で判断画面を組む。説明ファイルが判断材料の本体になる。

## 1. 置き場

| 優先 | 場所 |
|---|---|
| 1 | `<scratchpad_dir>/ukagai/<自由な名前>.md`(`scratchpad_dir` は hook の stdin の値) |
| 2 | `scratchpad_dir` が無いとき: `~/.ukagai/explain/<session_id>/<自由な名前>.md` |

- リポジトリの中には置かない。
- 拡張子は `.md`。名前は自由。`.used.md` で終わるものは使用済みで、探索の対象外。
- hook は使ったファイルを `<名前>.used.md` に rename する。server は本文を Decision に複写する(scratchpad は一時領域)。
- 改行は読み込み時に LF へ正規化する。

## 2. front matter

ファイルの先頭行が `---` で、次の `---` までを front matter とする。書式は YAML の部分集合: 1 行 1 項目の `key: value`。値は 1 行のスカラーで、前後を `"` で囲んでもよい(囲んだ場合は外側の `"` だけを外す。エスケープは解釈しない)。値に `: ` や `#` を含むときは `"` で囲む。未知のキーは無視する。

| 欄 | 必須 | 値 | 意味 |
|---|---|---|---|
| `ukagai` | 必須 | `1` | 形式のバージョン。`1` 以外は不正 |
| `question` | 必須 | 文字列 | `AskUserQuestion` の `questions[0].question` を**一字一句そのまま**。照合は完全一致(空白・全角半角の正規化はしない)。質問が複数のときも `questions[0]` だけを使う |
| `type` | 任意 | `decision` / `blocker` | 説明の種類。無い・`decision` = 人に判断を求める(従来)。`blocker` = 人にしかできない作業(認証・権限付与・2 要素認証・鍵の配置・物理操作)で進めなくなった(3.2 節の blocker の必須節、12 節)。これ以外の値は不正(`type` を missing) |
| `title` | 必須 | 文字列 | 人向けの「決めてほしいこと」1 文(例: `判断ログの保存形式を JSONL と SQLite のどちらにするか`)。GUI の判断見出し。`question` は照合用で GUI には出さない |
| `reversibility` | 必須 | `reversible` / `costly` / `irreversible` | 決めた後に戻せるか。`reversible` = 簡単に戻せる、`costly` = 戻せるが手間かコストがかかる、`irreversible` = 戻せない |
| `scope` | 必須 | `file` / `repo` / `machine` / `external` | 影響の範囲。`file` = 数ファイル、`repo` = リポジトリ全体、`machine` = この機械(リポジトリ外のファイル・設定・プロセス)、`external` = 他人・他システム(push、公開、課金、メッセージ送信) |
| `recommended` | 必須 | 文字列 | 推す選択肢のラベル。ラベル照合(下記)で `questions[0].options[].label` のどれかと一致すること(stdin で選択肢が分かるときだけ照合。分からなければ空でなければよい) |

**ラベル照合**(`normalizeLabel`。hook と GUI で同じ規則): 両辺を NFKC → 末尾の `(Recommended)` / `（Recommended）` / `(推奨)` / `（推奨）` を除去 → 空白(全種)を削除 → 小文字化、にして完全一致で比べる。

「`scope` が `repo` 以上」= `repo` / `machine` / `external`(順序は `file` < `repo` < `machine` < `external`)。

## 3. 本文

### 3.1 見出しの照合

- 見出しは ATX 形式(`#` 1〜6 個 + 空白 + 文字列)。コードフェンス(```` ``` ````、`~~~`)の内側の行は見出しとして扱わない。
- 節は、その見出しから、同じか浅いレベルの次の見出しの直前まで(深い見出しは節に含む)。
- 照合は**正規化した一致**: 見出しの文字列と必須の見出し名の両方に同じ正規化をかける。**完全一致を優先**し、完全一致が無ければ部分一致(見出しが必須名を含めば一致)。「選択肢」が先に出る「推奨する選択肢」に誤って当たらないため。
- 正規化 = Unicode NFKC(全角半角を統一)→ 空白(全種)を削除 → 「と」と「・」を削除 → 小文字化。
- 同じ段階(完全一致どうし、部分一致どうし)で一致する見出しが複数あれば、最初のものを使う。

| コード | 必須の見出し名 | 正規化後 |
|---|---|---|
| `why` | なぜ今この判断が要るか | なぜ今この判断が要るか |
| `options` | 選択肢 | 選択肢 |
| `recommend` | 推奨 | 推奨 |
| `diagram` | 図 | 図 |
| (計画) | 影響範囲と可逆性 | 影響範囲可逆性 |

「関係する差分」は照合の対象にしない(3.2 節)。

### 3.2 必須条件

| 節 | 条件 |
|---|---|
| なぜ今この判断が要るか | 常に必須。節に空でない行が 1 行以上。状況と、**人でなければ決められない理由**(エージェントが知り得ないこと)を書く(内容は検査しない) |
| 選択肢 | 常に必須。節の中に 3.3 の表。旧見出し「選択肢の比較」も部分一致で通る |
| 推奨 | 常に必須。節に空でない行が 1 行以上。どれを推すか、理由(2〜3 文)、**別の選択肢が正しくなる条件**(「〜なら B」)を書く(内容は検査しない) |
| 図 | **`scope` が `repo` 以上、または `reversibility` が `reversible` 以外のとき必須**。節の中に ` ```mermaid ` のコードブロックが 1 つ以上。`scope` か `reversibility` が欠落・不正なときは必須として扱う(安全側)。それ以外は任意 |
| 確かめたこと | 任意。file:line、コマンドの結果。推測は「推測」と書く。検査しない |
| 関係する差分 | コード変更が絡むときに書く。hook は判定できないので**検査しない**(任意)。` ```diff ` で 20 行以内 |

**`type: blocker` のとき**(選択肢は固定の 3 つ: `対応した。続けて (Recommended)` / `この手順は飛ばして続けて` / `ここで中断`。`recommended` は `対応した。続けて`。`reversibility` / `scope` は通常どおり、たいてい `reversible` / `machine`):

| 節 | 条件 |
|---|---|
| なぜ止まったか | 必須(コード `why`)。節に空でない行が 1 行以上。失敗したコマンドとエラーの抜粋(` ``` ` で 10 行以内)を含める(内容は検査しない)。「なぜ今この判断が要るか」の代わり |
| 人にしてほしいこと | **blocker では必須**(コード `todo`)。番号付きの手順と、人がそのまま打てるコマンドの fenced code block。節の中に ` ``` ` のコードブロックが 1 つ以上あることを検査する(内容は検査しない) |
| 選択肢 | 通常どおり(3.3 の表。先頭列 = 上の 3 ラベル) |
| 推奨 / 図 | **要求しない** |

`type` が無い・`decision` のときは従来どおりで、`todo` は要求しない。

### 3.3 表の最低条件

「選択肢」の節の中に、GFM の表(ヘッダ行 + 区切り行 `|---|` + データ行)が次を満たすこと。

1. ヘッダの列のうち、正規化後(3.1 の見出し正規化)に `起きること` を含む列と `リスク` を含む列がある(推奨の列名: 「選ぶと起きること」「リスクと戻し方」。他の列は自由)。**先頭列 = 選択肢のラベル**。旧列(利点・欠点・コスト)の表はここで落ちる。
2. データ行が `max(2, 選択肢数)` 以上。選択肢数は stdin の `questions[0].options` の数で、分からないときは 2。
3. 各データ行の上記 2 列のセルが空でない。空白のみ、または `-` `—` `ー` のみは空とみなす。
4. stdin から選択肢が分かるときは、各ラベルについて、先頭セルが `normalizeLabel` で一致する行がある。

節の中に表が複数あれば、どれか 1 つが満たせばよい。

### 3.4 `has`(記録用の事実)

検査の合否とは別に、本文全体について記録する(`explanation.has`、(d) の集計用)。

| 欄 | 条件 |
|---|---|
| `mermaid` | ` ```mermaid ` のコードブロックが本文のどこかにある |
| `table` | GFM の表(ヘッダ行 + 区切り行)が本文のどこかにある(列や行の条件は問わない) |
| `diff` | ` ```diff ` のコードブロックが本文のどこかにある |

### 3.5 強調の記法(任意。hook は検査しない)

- 判断の決め手になる語句だけを `**太字**` にする(1 文に 1 つまで、説明全体で 3〜5 箇所)。GUI は accent 色で描き、「リスクと戻し方」の中だけ赤で描く。
- 戻せない結果・他人や外部システムに及ぶ影響は callout にする: `> [!WARNING]`(戻すのにコストがかかる)、`> [!CAUTION]`(戻せない)。1〜2 行。
- 確かめた事実のうち判断を左右するものは `> [!NOTE]`(補足)、有用な示唆は `> [!TIP]`(ヒント)でもよい。
- GUI は callout を色付きの箱にする(NOTE = accent、TIP = green、WARNING = yellow、CAUTION = red)。記法が違っても壊れず、素の引用として出る。

## 4. 検査結果

検査は次の `missing` コードを**この順で**列挙する。`missing` が空のとき `valid: true`。

| コード | 条件(これを満たさないとき追加) | deny 理由文での呼び名 |
|---|---|---|
| `file` | 説明ファイルが見つからない(この場合は他のコードを評価しない) | 説明ファイル本体 |
| `front_matter` | front matter が無い、閉じていない、または `ukagai` が `1` でない | front matter(`ukagai: 1`) |
| `question` | `question` が無い、または空 | `question` |
| `type` | `type` があるのに `decision` / `blocker` のどちらでもない(以降は decision として評価) | `type`(decision / blocker) |
| `title` | `title` が無い、または空 | `title`(決めてほしいこと 1 文) |
| `reversibility` | 無い、または値が集合外 | `reversibility` |
| `scope` | 無い、または値が集合外 | `scope` |
| `recommended` | 無い・空、またはラベル照合で `options[].label` のどれにも一致しない(labels が分かるとき) | `recommended`(推す選択肢のラベル) |
| `why` | 「なぜ今この判断が要るか」(blocker では「なぜ止まったか」)の節が無い、または空 | 「なぜ今この判断が要るか」の節 |
| `options` | 「選択肢」の節が無い | 「選択肢」の節 |
| `table` | `options` があるのに 3.3 の表が無い(`options` が無いときは評価しない) | 選択肢の表(先頭列はラベル、選ぶと起きること・リスクと戻し方の列、選択肢ごとに 1 行) |
| `todo` | `type: blocker` なのに、「人にしてほしいこと」の節が無い・空、または節の中にコードブロックが無い | 「人にしてほしいこと」の節(コマンドのコードブロック付き) |
| `recommend` | (blocker では評価しない)「推奨」の節が無い、または空 | 「推奨」の節 |
| `multi` | (検査ではなく 5 節の手順 0 で使う)`questions` が 2 つ以上 | 質問は 1 回に 1 問 |
| `diagram` | (blocker では評価しない)図が必須(3.2)なのに、「図」の節か ` ```mermaid ` が無い | 「図」の節と Mermaid の図 |

- front matter が無いときは `front_matter` だけを追加し、`question` `title` `reversibility` `scope` `recommended` は評価しない(図の必須判定は安全側で「必須」)。
- 検査の入力は「ファイル全文」と、任意の `labels`(`questions[0].options[].label` の配列。`validateExplanation(markdown, kind, labels?)`)。
- `question` の欄そのものの形式検査と、stdin の質問文との照合(次節の手順 1)は別物。検査は欄の有無だけを見る。

## 5. hook の判定手順(PreToolUse × AskUserQuestion)

`permission_mode === "plan"` のときは説明を要求しない(6 節)。それ以外:

0. **多問なら deny**: `questions.length > 1` なら、探索より前に `permissionDecision: "deny"` を返し `denied_explain` として登録する(`explanation` は付けない)。理由文は次(7 節にも再掲、600 文字以内、URL なし): `AskUserQuestion は 1 回に 1 問にしてください(今回は N 問)。GUI は 1 問ずつ、説明ファイルと一緒に表示します。最初の質問から順に、1 問ごとに説明ファイルを書いて AskUserQuestion を 1 問だけで出し直してください。文章で聞き直してはいけません。` ループ保険: 同じ `session_id + agent_id` で `questions.length > 1` の `denied_explain` が **2 分以内**にあれば deny せず手順 1 に進む(説明が無ければ `attached_via: none` / `none_reason: loop_guard`)。質問文は照合しない(分けた後の 1 問目は別の質問文になるため)。
1. **探索**: 置き場(1 節)の `.md`(`.used.md` を除く)から、front matter の `question` が `questions[0].question` と**完全一致**するものを探す(複数あれば更新時刻が最新のもの。`match: question`)。無ければ、**10 分以内**(E4 で確定)に書かれた(更新時刻)未使用ファイルがちょうど 1 つならそれを使う(`match: recency`)。0 個または 2 個以上なら「見つからない」(`file`)。
2. **検査と登録**: 見つかったファイルを 4 節の検査にかける。通れば Decision に登録する。`attached_via` は、同じ `session_id + agent_id + questions[0].question` の `denied_explain` が直近 **2 分以内**(E4 で確定)にあれば `after_deny`、無ければ `first_call`。使ったファイルは `<名前>.used.md` に rename する。
3. **deny**: 見つからない / 検査が落ちたら、`permissionDecision: "deny"` + 7 節の理由文を返し、`denied_explain` として登録する(GUI には出さない)。
4. **ループ保険**: 手順 3 の時点で、同じ `session_id + agent_id + questions[0].question` の `denied_explain` が **2 分以内**(E4 で確定)に既にあれば、deny せず説明なしで GUI に出す(`attached_via: none`、`none_reason: loop_guard`、GUI に「説明なし」の印)。

## 6. plan mode

`permission_mode === "plan"` の AskUserQuestion は説明ファイルを要求しない。探索もしない。`attached_via: none`、`none_reason: plan_mode`。(d) の分母から除く。

## 7. deny 理由文のテンプレート

2 種類を用意する。E4 の結果(往復 2 回で通ったのは命令文 7 本中 6、事実 + 依頼 2/2)により**既定は版 A**。`--deny-template` で版 B に切り替えられる。

プレースホルダ:

- `{path}`: 保存先の絶対パス(`<scratchpad_dir>/ukagai/explain.md`。名前は自由だが例を 1 つ示す)
- `{question}`: `questions[0].question` の原文
- `{missing}`: 4 節の「呼び名」(`recommended` `title` なども含む。呼び名が長いため 600 文字の切り詰めが効きやすい)を `、` で連結したもの(`todo` = 「人にしてほしいこと」の節(コマンドのコードブロック付き)、`type` = `type`(decision / blocker))

共通の制約: **GUI の URL・ポート・API パスを書かない**(Claude 自身に `curl` で回答させないため)。展開後の全文は **600 文字以内**。超えるときは `{missing}` を「…ほか N 件」に切り詰め、なお超えるときは最終文を削る。`{question}` は原文でなければ照合できないので切り詰めない。

### 版 A: 命令文

```
AskUserQuestion の前に、人が判断するための説明ファイルを書いてください。足りない項目: {missing}。
保存先: {path}(同じディレクトリなら名前は自由)。front matter の question: には次の文字列を一字一句そのまま入れること: {question}
書式は skill ukagai-explain に従い、書き終えたら同じ質問をもう一度 AskUserQuestion で出してください。文章で聞き直してはいけません。
```

### 版 B: 事実 + 依頼

```
この判断に付ける説明ファイル(ukagai 形式)が、まだ条件を満たしていません。足りない項目: {missing}。
{path} に書いていただけますか(同じディレクトリなら名前は自由です)。front matter の question: は「{question}」と完全に同じにしてください。
書き方は skill ukagai-explain にあります。書けたら、同じ質問をもう一度 AskUserQuestion で出してください。
```

### 多問の deny 理由文(手順 0)

`AskUserQuestion は 1 回に 1 問にしてください(今回は N 問)。GUI は 1 問ずつ、説明ファイルと一緒に表示します。最初の質問から順に、1 問ごとに説明ファイルを書いて AskUserQuestion を 1 問だけで出し直してください。文章で聞き直してはいけません。` 版 A / B の区別は無い。

## 8. SessionStart / SubagentStart の additionalContext

どちらも sync で返す。5 行以内。`{置き場の絶対パス}` は 1 節で決まる `<scratchpad_dir>/ukagai/` または `~/.ukagai/explain/<session_id>/`。URL は書かない。列挙値を書く(E5 で、書かないと `reversibility` / `scope` が自由文になると分かった)。

```
人に判断を求める前に、コードを読みコマンドで確かめて推奨を 1 つ決めること。人でなければ決められない理由(好み、外部の事情、戻せない変更、あなたが知り得ない前提)を 1 文で言えないなら、聞かずに推奨どおり進めて報告する。
聞くときは、人が読む説明を Markdown で {置き場の絶対パス}/ に書くこと。書式は skill ukagai-explain に従う。
front matter: question は AskUserQuestion の質問文を一字一句そのまま、title は人に決めてほしいこと 1 文、recommended は推す選択肢のラベル、reversibility は reversible / costly / irreversible、scope は file / repo / machine / external。本文: 「なぜ今この判断が要るか」「選択肢」(表。先頭列はラベル、列は選ぶと起きること・リスクと戻し方)「推奨」(理由と、別の選択肢が正しくなる条件)。構造や流れは Mermaid の図にする。
文章で質問せず AskUserQuestion を使い、決め手は **太字**、戻せない影響は > [!CAUTION] の callout にし、推奨の選択肢を先頭に置いてラベル末尾に (Recommended) を付ける。計画の本文には「影響範囲と可逆性」の節を入れる。plan mode 中の AskUserQuestion には説明ファイルは不要。
認証・権限など人の作業で止まるときは、文章で終えず blocker 形式の説明を書いて AskUserQuestion(対応した / 飛ばして続ける / 中断)で聞く。人が対応したら同じ作業を再試行する。
```

サブエージェント内では AskUserQuestion が提供されないため判断は発生しない(Claude Code 2.1.287 で確認)。SubagentStart の additionalContext は届くが、使われる場面はない。

### 8.1 SessionStart の自動起動(hook の挙動)

- SessionStart の hook は additionalContext を返す前に `GET /healthz`(300 ms)で server を確かめる。届かず、server URL が `127.0.0.1` / `localhost` なら `cli.js serve` を detached で起動し(log は `<data-dir>/serve.log`)、最大 2 秒 healthz を待つ。全体で 2.5 秒以内。
- server に届いたとき、`<data-dir>/gui-opened` の日付(ローカル `YYYY-MM-DD`)が今日でなければ `open`(darwin)/ `xdg-open`(linux)で GUI を開き、今日の日付を書く。
- `--no-autostart` なら何もしない(`install --no-autostart` で SessionStart の args に入る)。SubagentStart では何もしない。失敗は握りつぶす(フェイルオープン)。

## 9. ExitPlanMode

- 別ファイルは要求しない。`tool_input.plan`(計画本文)を検査する。
- 検査: 3.1 の照合規則で「影響範囲と可逆性」(正規化後 `影響範囲可逆性`)に一致する見出しがあり、その節に空でない行が 1 行以上ある。見出しのレベルは問わない。無ければ `missing: ["impact"]`。
- Mermaid は**推奨**で、要求しない。無ければ `has.mermaid: false` として (d) に数える。
- 不備のときの deny は**同一セッション(`session_id`)で 1 回まで**。2 回目以降は deny せず登録する(`attached_via: none`、`none_reason: loop_guard`)。
- 通ったときの `attached_via` は `first_call`(deny 済みなら `after_deny`)。`explanation.markdown` には計画本文を入れる。
- plan mode 中でも要求する(ExitPlanMode は plan mode でしか呼ばれない)。6 節の免除は AskUserQuestion だけ。
- deny 理由文は 7 節の版に準じ、`{missing}` を「「影響範囲と可逆性」の節」、`{path}` / `{question}` の行を省く。

## 10. Mermaid の扱い

hook は Mermaid の構文を検査しない(コードブロックの有無だけを見る)。GUI は描画に失敗したら、コードをそのまま表示してエラーを添える。

## 11. fixture

`test/explain-fixtures/` に 13。各 `*.md` は説明(または計画)の全文、`*.expected.json` は検査の期待値 `{ valid, missing, has: {mermaid, table, diff}, question }`。`question` は front matter の値(無ければ `null`、計画は `null`)。`plan-` で始まるファイルは 9 節(計画本文)、他は 4 節の検査にかける。表は `labels` を渡さない前提(データ行 2 以上、ラベル照合なし)で判定する。

| ファイル | valid | missing |
|---|---|---|
| `pass-design.md` | true | なし |
| `pass-naming.md` | true | なし |
| `pass-destructive.md` | true | なし |
| `fail-no-table.md` | false | `table` |
| `fail-no-recommended.md` | false | `recommended` |
| `fail-old-columns.md` | false | `table`(利点・欠点・コストの旧表) |
| `fail-no-recommend-section.md` | false | `recommend` |
| `fail-no-question.md` | false | `question` |
| `fail-no-diagram-when-required.md` | false | `diagram` |
| `plan-heading-variant.md` | true | なし |
| `pass-blocker.md` | true | なし(`type: blocker`、`todo` にコードブロック、3 行の表、推奨節・図なし) |
| `fail-blocker-no-todo.md` | false | `todo` |
| `fail-bad-type.md` | false | `type`(`type: foo`) |

## 12. Stop hook の保険(文章で止まった blocker)

エージェントが blocker 形式を使わず、文章で「認証してください」と言って turn を終えたときの保険。

- `Stop` は **sync**(`async: false`、timeout 5)。`SubagentStop` は async のまま。
- 次のとき何も返さない: `stop_hook_active === true`(Claude Code は Stop hook で続行させた後の Stop に付ける。**続行は 1 回限り**でループしない)、`permission_mode === "plan"`、`--observe`、`last_assistant_message` が無い、ブロッカー語彙に一致しない。
- `stop_hook_active` が false で `last_assistant_message` がブロッカー語彙に一致したら、stdout に `{"decision":"block","reason":"<理由文>"}` を返す。理由文(600 文字以内、URL なし。`src/hook/blocker.ts` の `BLOCKER_REASON`):
  `人の作業(認証・権限など)が要るなら、文章で終えずに ukagai の blocker 形式で聞いてください: skill ukagai-explain の「人の作業で止まったとき」に従って説明ファイル(type: blocker、「なぜ止まったか」「人にしてほしいこと」「選択肢」)を書き、AskUserQuestion を選択肢「対応した。続けて (Recommended)」「この手順は飛ばして続けて」「ここで中断」で出してください。人の作業が要らないなら、そのまま終えて構いません。`
- ブロッカー語彙(`src/hook/blocker.ts`、大小無視): 文を「。」「.」改行で区切り、**同じ文に「対象語」と「詰まり語」の両方**が含まれるときだけ一致にする。
  - 対象語(`BLOCKER_TARGET`): `認証|ログイン|権限|credential|permission|unauthori[sz]ed|forbidden|\b40[13]\b|token|api key|鍵`
  - 詰まり語(`BLOCKER_STUCK`): `ない|無い|切れ|失敗|必要|してください|お願い|できません|進められません|denied|failed|required|missing|expired|not logged in|cannot proceed|blocked`
  - 一致する例: 「gcloud の認証がないため進められません」「Permission denied (403)」「トークンが期限切れです。再ログインしてください」。一致しない例: 「認証は有効です」「権限の実装を終えました」「どちらにしますか？」(片方だけ)。
  - `escaped_question`(末尾が ？)の判定とは独立。
- 観測 event(`POST /api/events`)は今までどおり送り、語彙に一致したら `blocker_detected: true` を足す(`stop_hook_active` に関係なく)。POST は 1000 ms で打ち切り、hook 全体は 1.9 秒以内に返す。失敗しても何も出力しない(フェイルオープン)。

## 既知の制約

- 多問 deny は `missing` を記録しない(Decision に `missing` の欄が無いため)。`denied_explain` かつ `request.questions` が 2 件以上であることで見分ける。
- plan mode の多問は deny せず、従来どおり生の質問文・選択肢で GUI に出る。
- `question` が複数行の質問文は front matter の 1 行スカラーで完全一致できず、recency に頼る。
- recency は別の質問向けのファイルも拾いうる(10 分以内にちょうど 1 つあれば `match: recency` で添付される)。
- 見出し照合は完全一致を優先するが、完全一致が無いと部分一致になる。「図」は部分一致なので、先に出る「図解」などの見出しに当たり、本来の「図」の節を隠しうる。
- ExitPlanMode の `after_deny` には時間窓が無く(同一セッションの denied_explain があれば成立)、server の `first_denied_at`(120 秒窓)とずれうる。
