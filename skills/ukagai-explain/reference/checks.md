# Hook checks: every deny code

Copied from `src/hook/explain.ts`. Rows follow the order the hook reports them (`quiz_*`, `impact` and `multi` are separate paths); fix them all in one rewrite.

| Code | Fix |
|---|---|
| `file` | The explanation file does not exist yet. Write it before AskUserQuestion |
| `front_matter` | Start with `---`, `ukagai: 1`, and close with `---` |
| `language` | Configured language is Japanese: title, body and the AskUserQuestion text in Japanese (code and proper nouns may stay) |
| `question` | `question:` must equal `questions[0].question` exactly |
| `type` | `type` is `decision` (default), `blocker` or `quiz` |
| `title` | One sentence: the decision for the human |
| `reversibility` | `reversible` / `costly` / `irreversible` |
| `scope` | `file` / `repo` / `machine` / `external` |
| `recommended` | Must match one option label (a trailing `(Recommended)` / `(推奨)` is optional) |
| `quiz_recommended` | A quiz carries `recommended` |
| `quiz_why` | Quiz: "Why this question now", 1-600 characters |
| `quiz_premise` | Quiz: "Premise", non-empty, at most 600 characters |
| `quiz_leak` | Quiz text repeats an option label of 6+ characters |
| `why` | Section "Why this decision is needed now" |
| `why_long` | "Why" over 600 characters |
| `options` | Section "Options" |
| `table` | Header has a "happens" and a "risk" column; one row per option label (first column), 2+ rows, no empty cell |
| `cell_long` | A table cell over 160 characters (code points after NFKC) |
| `coined_term` | Plan code / phase word not defined under Terms |
| `undo` | A risk cell has neither an undo phrase nor a cannot-undo phrase |
| `todo` | Blocker only: "What you need to do" with a fenced code block |
| `recommend` | Section "Recommendation" |
| `recommend_long` | Over 5 sentences or 400 characters |
| `recommend_cond` | Needs a condition word (see below) |
| `recommend_name` | First sentence names the option: its full label, or its first 3 words (spaced ASCII label of 4+ words) or first 12 characters (long or Japanese label); a label of 3 characters or fewer matches on word boundaries. No positional wording |
| `against_weak` | Counterargument text is contained in the Recommendation |
| `assumptions_long` | More than 3 Assumptions |
| `diagram` | Required (not `reversible`, or scope machine / external) but no Mermaid and no `No diagram:` line |
| `diagram_trivial` | Flowchart / graph with 4 or fewer distinct nodes, or half the labels equal option labels |
| `checked` | "What I checked" is required unless `reversible` + `file` |
| `footnote` | A `[^n]` in the body without a `[^n]:` definition |
| `impact` | Plan only: "Scope and reversibility" with its 2 first lines |
| `multi` | AskUserQuestion with 2+ questions, or the same question after "Too much at once" |

## Words and patterns

- `recommend_cond` (whole words, not inside code or `>` callouts): `if` `when` `unless` `otherwise` `in case`; Japanese `なら` (not `ならない` / `ならず`), `なければ` (not `なければならない`), `場合`, `とき` (not `ときどき`), `であれば`, `際は`, `際に`.
- `recommend_name` positional wording: `the first one`, `the second option`, `option B`, `plan A`, `1つ目`, `2つ目`, `3つ目`, `一つ目`, `最初の案`, `案 A`, `選択肢 1`.
- `undo`, how to undo: `undo` `undone` `revert` `roll back` `restore` `reinstall` `recreate` `re-run` `rerun` `git checkout|revert|reset|stash` `delete the` `remove the`; Japanese `戻せ` `戻る` `戻す` `元に戻` `消せ` `やり直` `再実行` `再作成` `復元`.
- `undo`, cannot be undone (checked first, painted red): `cannot be undone|restored|reverted|recovered|rolled back` (also `can't`, `won't`), `no way back`, `irreversible`, `unrecoverable`, `permanent(ly)`; Japanese `戻せない` `戻せません` `元に戻らない` `元に戻せない` `復元できない` `取り消せない` `二度と`.
- `diagram`: a line `No diagram: <why, 8+ characters>` (or `図なし: …`, `図は不要: …`) outside code under Options.
- `diagram_trivial` compares trimmed, case-folded labels with `(Recommended)` / `（推奨）` stripped. Only flowchart / graph is checked.

## Coined terms (`coined_term`)

The scan covers title and body outside fences; inline code counts, and tokens in the question or option labels are exempt.
- Hit: 1-4 capitals + optional digits + `-` + 1-4 capitals/digits (`W-T2`, `P-GH`), or 1-4 capitals + 1-3 digits (+ capital) (`FT4`, `TM28`, `W3`); and an English phase word (any case) followed by a number or capital: `Phase 2`, `Gate B`, `Step 3a`, also Stage, Sprint, Milestone, Track, Wave, Round, Batch, Lane ("step by step" is not hit); Japanese `フェーズ` `ステップ` `段階` `工程` `ゲート` `トラック` `ラウンド` `第` hit only when followed by a number or capital (`フェーズ 2`, `第 3`), a bare word is not flagged.
- Allowed: CI CLI API GUI TUI SSE URL HTTP JSON YAML HTML CSS PR DB UI ID CPU GPU GB MB SQL SSH TLS DNS TCP AWS GCP S3 IAM VM OS PID NPM SVG PNG PDF CSV UTF IDE LSP MCP LLM AI QA README TODO CRUD REST RPC JWT SDK SHA RSA AES HMAC, plus ARM64 E2E ES5-7 W3C X11 V8 R2 U2 Z3 H264 H265 AV1 VP9 SOC2 BM25 I18N L10N A11Y OIDC, M1-M4 L1-L4 Q1-Q4 H1-H2 T1-T3, any token of 3+ capitals whose prefix is allowed.
- Skipped shapes: `FY25`, `CVE-2024-1234`, regions (`US-EAST-1`), `PCI-DSS`, `P-256`, `MPEG-4`, `PM2.5`, URLs, version-suffixed `v0.2.0-DT1`.
- Define under Terms in 12+ characters of plain words; "plan の行", "the plan item", "see plan", "計画の項目" count as nothing.

## Headings and columns (Japanese aliases)

English is preferred, and a Japanese-language run still writes English H2s and column names unless noted.
- Why 「なぜ今この判断が要るか」 · Options 「選択肢」 · Recommendation 「推奨」 · Diagram 「図」 · What I checked 「確かめたこと」 · Related diff 「関係する差分」 · Scope and reversibility 「影響範囲と可逆性」 · Terms 「用語」 · What only you know 「あなたにしか分からないこと」 · Assumptions 「前提」 · Counterargument 「反論」 · Affected 「影響を受けるもの」.
- Blocker: Why I stopped 「なぜ止まったか」 · What you need to do 「人にしてほしいこと」. Quiz: Why this question now 「なぜ今この質問か」 · Premise 「前提」 · How to answer 「答え方」.
- Columns: "what happens" matches `happens`, `outcome`, `起きること`; "risk" matches `risk`, `リスク`.

## Blocker labels (all accepted)

- Done: `Done. Continue` · `対応した。続けて` · `完了。続けて`
- Skip: `Skip this step and continue` · `この手順は飛ばして続けて` · `この手順を飛ばして続けて`
- Stop: `Stop here` · `ここで中断` · `ここで止める`
