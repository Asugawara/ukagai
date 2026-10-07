# Explanation file specification

The format of the "explanation" an agent writes before asking a human to decide, and the rules of the checks the hook (`src/hook/explain.ts`) performs. For the implementation plan see section 3, "The explanation path", of `docs/strategy/03-mvp-implementation-plan.md`. The rules in this document are the source of truth for the implementation and the fixtures (`test/explain-fixtures/`).

**Policy (v2)**: make the agent think through the decision material so that a human can decide with arrow keys and Enter only in the GUI. The GUI does not show the raw question and options of `AskUserQuestion` as they are; it builds the decision screen from the explanation file (`title` / the "Recommendation" section / the "Options" table). The explanation file is the body of the decision material.

**Language.** English is the canonical format; Japanese aliases are accepted (section 3.1 and the alias table in section 13). The hook tells the agent which language to write the explanation in via the SessionStart context (section 8), based on `lang` in `<data-dir>/config.json`.

## 1. Location

| Priority | Place |
|---|---|
| 1 | `<scratchpad_dir>/ukagai/<any name>.md` (`scratchpad_dir` is the value in the hook's stdin) |
| 2 | When there is no `scratchpad_dir`: `~/.ukagai/explain/<session_id>/<any name>.md` |

- Never put it inside the repository.
- The extension is `.md`; the name is free. Files ending in `.used.md` are used and are excluded from the lookup.
- The hook renames the file it used to `<name>.used.md`. The server copies the body into the Decision (the scratchpad is temporary).
- Line endings are normalized to LF when reading.

## 2. Front matter

The first line of the file is `---`, and everything up to the next `---` is the front matter. The syntax is a subset of YAML: one `key: value` per line. A value is a one-line scalar and may be wrapped in `"` (only the outer `"` is removed; escapes are not interpreted). Wrap the value in `"` when it contains `: ` or `#`. Unknown keys are ignored.

**Block scalar (`question` only):** `question: |` (also `|-` / `|+`) followed by indented lines is a YAML literal block scalar. The block is the indented (and blank) lines after the key; one common indent is removed, line breaks are kept, and trailing newlines are stripped. Exactly the common leading-whitespace prefix (tabs and spaces alike) is removed from each line; trailing spaces on a line are kept (as in YAML), so the text still matches an ask question that has them. The result is compared with `questions[0].question` exactly like a one-line value, so it must hold the same text with real newlines. A one-line `question: text` keeps working. No other key accepts a block scalar.

| Field | Required | Value | Meaning |
|---|---|---|---|
| `ukagai` | Required | `1` | Format version. Anything other than `1` is invalid |
| `question` | Required | string | `questions[0].question` of `AskUserQuestion`, **verbatim**. Matching is exact (no normalization of whitespace or full-width / half-width). With several questions only `questions[0]` is used |
| `type` | Optional | `decision` / `blocker` / `quiz` | The kind of explanation. Absent or `decision` = asks a human to decide (the original). `quiz` = a comprehension question that must not recommend an answer; see "When `type: quiz`" in section 3.2. `blocker` = progress is blocked by work only a human can do (authentication, permission grants, two-factor authentication, placing a key, physical operations); see the blocker required sections in section 3.2 and section 12. Any other value is invalid (`type` is reported missing) |
| `title` | Required | string | The decision for the human in one sentence (example: `Choose JSONL or SQLite as the storage format of the decision log`). The decision heading in the GUI. `question` is for matching and is not shown in the GUI |
| `reversibility` | Required | `reversible` / `costly` / `irreversible` | Whether the decision can be undone. `reversible` = easy to undo, `costly` = can be undone at some effort or cost, `irreversible` = cannot be undone |
| `scope` | Required | `file` / `repo` / `machine` / `external` | The range of impact. `file` = a few files, `repo` = the whole repository, `machine` = this machine (files, settings and processes outside the repository), `external` = other people or systems (push, publish, billing, sending messages) |
| `recommended` | Required (**absent for `type: quiz`**) | string | The label of the option you recommend. By label matching (below) it must equal one of `questions[0].options[].label` (matched only when the options are known from stdin; otherwise it only has to be non-empty) |

**Label matching** (`normalizeLabel`; the same rule in the hook and the GUI): normalize both sides by NFKC → strip a trailing `(Recommended)` / `（Recommended）` / `(推奨)` / `（推奨）` → remove all whitespace → lowercase, then compare for exact equality.

"`scope` is `machine` or above" = `machine` / `external` (the order is `file` < `repo` < `machine` < `external`). Used for the diagram requirement (3.2).

## 3. Body

### 3.1 Heading matching

- Headings are ATX (1–6 `#` + space + text). Lines inside code fences (```` ``` ````, `~~~`) are not headings.
- A section runs from its heading to just before the next heading of the same or a shallower level (deeper headings belong to the section).
- Matching is **normalized matching**: the same normalization is applied to the heading text and to every accepted name. **An exact match wins**; without an exact match, a partial match (the heading contains an accepted name). This keeps "Options" from hitting a preceding "Recommended options".
- Each section has an **English name and a Japanese alias** (the table below). A heading matches when it matches either. Exact matches on any name are tried first, then partial matches on any name. English names are case-insensitive.
- Normalization = Unicode NFKC (unify full-width / half-width) → remove all whitespace → remove 「と」 and 「・」 → lowercase.
- When several headings match at the same stage (exact among exact, partial among partial), the first one is used.

The names are exported from `src/hook/explain.ts` as `SECTION`:

| Code | English name | Japanese alias | Normalized (English) |
|---|---|---|---|
| `why` | Why this decision is needed now | なぜ今この判断が要るか | whythisdecisionisneedednow |
| `options` | Options | 選択肢 | options |
| `recommend` | Recommendation | 推奨 | recommendation |
| `diagram` | Diagram | 図 | diagram |
| `checked` | What I checked | 確かめたこと | whatichecked |
| `terms` | Terms | 用語 | terms |
| `unknowns` | What only you know | あなたにしか分からないこと | whatonlyyouknow |
| `assumptions` | Assumptions | 前提 | assumptions |
| `against` | Counterargument | 反論 | counterargument |
| `affects` | Affected | 影響を受けるもの | affected |
| (blocker) `why` | Why I stopped | なぜ止まったか | whyistopped |
| (blocker) `todo` | What you need to do | 人にしてほしいこと | whatyouneedtodo |
| (plan) `impact` | Scope and reversibility | 影響範囲と可逆性 | scopeandreversibility |

"Related diff" (関係する差分) is not matched (section 3.2). `terms` / `unknowns` / `assumptions` / `against` / `affects` are optional and only parsed (section 3.7); the hook checks only one thing about them: `against_weak` (section 4). **Use only the section names defined here for H2**: a heading that is not in this table is not shown prominently on the decision screen, and the hook does not warn about it.

`findSection(headings, total, names)` takes an array of names.

### 3.2 Required conditions

| Section | Condition |
|---|---|
| Why this decision is needed now | Always required. At least one non-empty line in the section. Write the situation and **why only a human can decide** (what the agent cannot know) (the content is not checked) |
| Options | Always required. A table of 3.3 inside the section. A heading such as "Options compared" (選択肢の比較) also passes by partial match |
| Recommendation | Always required. At least one non-empty line in the section. Write which option you recommend, the reason (aim for 3 sentences, limit 5 sentences and 400 characters), and **the condition under which another option is right** ("if …, B") (the content is checked only for the condition words; see `recommend_cond`) |
| Diagram | **Required when `reversibility` is anything but `reversible`, or `scope` is `machine` / `external`** (`repo` + `reversible` is optional). At least one ` ```mermaid ` code block inside the section. When `scope` or `reversibility` is missing or invalid it is treated as required (the safe side). A flowchart / graph that is trivial (4 or fewer distinct nodes, or at least half of its node labels equal an option label: trimmed, case-folded, `(Recommended)` / `（推奨）` stripped) is reported as `diagram_trivial`; other diagram types never are. When a diagram is required but none meets the rule (a sequence of 3+ steps between 2+ actors, a state machine with 4+ states, or a data flow between 3+ components; a flowchart needs 5+ nodes), one line under Options, `No diagram: <why>` / `図なし: <理由>` (reason of 8+ characters), satisfies `diagram` |
| What I checked | **Required unless `reversibility` is `reversible` and `scope` is `file`** (code `checked`). At least one non-empty line in the section. file:line and command results. Mark guesses as guesses. Put evidence in footnotes: `[^1]: evidence` here, `[^1]` in the body (3.7). Not required for a blocker |
| What only you know | Optional (the skill says to always write it). 1–3 bullets: what the agent could not settle by investigating. The GUI shows it as the "You decide:" band under the title |
| Assumptions | Optional (the skill says to always write it). One premise per bullet. The GUI shows a checklist under the recommendation |
| Counterargument | Optional. The strongest argument against the recommendation, 1–2 sentences |
| Affected | Optional. Concrete names (files, services, people, environments), one per bullet. The GUI shows chips (up to 6, then "+N") |
| Terms | Optional. `- **term** — definition` per item (3.7). The GUI annotates the term in the body |
| Related diff | Write it when code changes are involved. The hook cannot judge it, so it is **not checked** (optional). At most 20 lines in a ` ```diff ` block |

**When `type: blocker`** (the options are exactly 3: `Done. Continue (Recommended)` / `Skip this step and continue` / `Stop here`; `recommended` is `Done. Continue`; `reversibility` / `scope` as usual, typically `reversible` / `machine`). The Japanese labels `対応した。続けて` / `この手順は飛ばして続けて` / `ここで中断` are accepted as aliases (exported as `BLOCKER_LABELS`):

| Section | Condition |
|---|---|
| Why I stopped | Required (code `why`). At least one non-empty line in the section. Include the failed command and an excerpt of the error (at most 10 lines in ` ``` `) (the content is not checked). Replaces "Why this decision is needed now" |
| What you need to do | **Required for a blocker** (code `todo`). Numbered steps, and a fenced code block with commands the human can type as they are. Checked: at least one ` ``` ` code block inside the section (the content is not checked) |
| Options | As usual (the table of 3.3; first column = the 3 labels above) |
| Recommendation / Diagram | **Not required** |

When `type` is absent or `decision`, nothing changes and `todo` is not required.

**When `type: quiz`** (a question whose answer the human must find alone: the file is normally written by a tool such as whoknows from its Stop hook, not by the agent; the options come from the AskUserQuestion call itself). Front matter: `ukagai`, `type: quiz`, `question` (usually a block scalar, section 2), `title`, `reversibility`, `scope` are required; **`recommended` must be absent**.

| Section | Condition |
|---|---|
| Why this question now (`なぜ今この質問か`) | Required (code `quiz_why`). Non-empty, 1 to 600 characters (the `why_long` limit of 3.6) |
| Premise (`前提`) | Required (code `quiz_premise`). Non-empty, at most 600 characters |
| How to answer (`答え方`) | Optional |
| Terms | Optional |

Not evaluated for a quiz: `recommended`, `recommend*`, `against_weak`, `assumptions_long`, `options` / `table` / `cell_long` / `undo`, `coined_term` (identifiers are the subject of the question; the premise explains them), `diagram`, `checked`, `footnote`. `language` and `question` matching are evaluated as usual (for `ja`, the title, the Why and the Premise are checked for Japanese). The heading alias `前提` is also the alias of Assumptions; for a quiz it means Premise.

**No leak (`quiz_leak`).** When the option labels are known, none of them may occur in the bodies of Why, Premise and How to answer (outside code fences). A label is looked for in the normalized form of the body: NFKC, whitespace / backticks / asterisks removed, lowercase (the form `recommend_name` uses; a trailing `(Recommended)` / `(推奨)` is dropped from the label first). Labels shorter than 6 characters (after that normalization) are not looked for. The front matter `question` is exempt.

Example (the contract whoknows writes; valid with the 4 labels of its question):

```markdown
---
ukagai: 1
type: quiz
question: |
  対象: src/quiz/context.rs › is_test_code
  いま聞く理由: 回復不能(U 0.00)。エージェント行 1088 / 全 1088。クイズ正答はまだ無い
  前提: src/quiz/context.rs は出題プロンプト用に、定義・呼び出し元・import・テストの行を静的に集める。is_test_code は、収集したヒットのうちテストとして引用する対象かを判定するパス判定関数である。

  is_test_code に "tests/fixtures/a.json" を渡したときの戻り値と、その理由として正しいものはどれか。
title: src/quiz/context.rs の is_test_code についての理解度クイズ
reversibility: reversible
scope: file
---

## Why this question now

回復不能(U 0.00)。エージェント行 1088 / 全 1088。クイズ正答はまだ無い

## Premise

src/quiz/context.rs は出題プロンプト用に、定義・呼び出し元・import・テストの行を静的に集める。is_test_code は、収集したヒットのうちテストとして引用する対象かを判定するパス判定関数である。

## How to answer

選択肢を矢印キーで選んで Enter。分からなければ Other に「分からない」と入力する。正解・理由・根拠は回答のあとに表示される。
```

The GUI shows a "Quiz" band, the title, the Why and Premise sections, then the options exactly as the call gives them (no recommended highlight, no `(Recommended)` handling, no risk colors); the TUI shows the same sections with no recommendation line. Quizzes sort with questions (after blockers). The deny reason for a quiz that lacks front matter keys pastes a quiz template (no `recommended`, no Options).

### 3.3 Minimum table conditions

Inside the "Options" section there must be a GFM table (header row + separator row `|---|` + data rows) that satisfies all of the following.

1. Among the header cells there is a column matching `COLUMN_HAPPENS` (`/happens|outcome|起きること/i`) and a column matching `COLUMN_RISK` (`/risk|リスク/i`) (recommended column names: "What happens if chosen" and "Risks and how to undo"; other columns are free). The header cell text is NFKC-normalized before the test. **The first column = the option label.** A table with the old columns (pros / cons / cost) fails here.
2. At least `max(2, number of options)` data rows. The number of options is the count of `questions[0].options` from stdin, and 2 when unknown.
3. In every data row the cells of those 2 columns are non-empty. Whitespace only, or only `-` `—` `ー`, counts as empty.
4. When the options are known from stdin, for each label there is a row whose first cell matches by `normalizeLabel`.

If a section has several tables, one of them satisfying the conditions is enough.

5. **Extra columns.** The table may have 3 or more columns: the label, the `COLUMN_HAPPENS` column, the `COLUMN_RISK` column and any others (cost, effort, …). Columns may be in any order after the label. `Table.extraColumns` lists the indexes of the columns that are neither the label (0), `COLUMN_HAPPENS` nor `COLUMN_RISK` (empty for the usual 3 columns). Extra columns are not checked (the hook does not look at their cells).
6. **Undo (`undo`).** Every data row's `COLUMN_RISK` cell matches `UNDO_BAD_WORDS` (phrases saying it cannot be undone) **or** `UNDO_WORDS` (phrases saying how to undo). Both are exported from `src/hook/explain.ts`, and the GUI / TUI use the same lists for colors (bad words red first, then the remaining undo words green; "cannot be restored" is red only). English entries match on word boundaries, Japanese entries as substrings, all case-insensitive. `UNDO_BAD_WORDS` = `/\b(cannot|can't|can not|couldn't|won't) be (undone|restored|reverted|recovered|rolled back)\b|\bno way back\b|\birreversibl[ey]\b|\bunrecoverable\b|\bpermanent(ly)?\b|戻せない|戻せません|元に戻らない|元に戻せない|復元できない|取り消せない|二度と/i`. `UNDO_WORDS` = `/\b(undo|undone|revert|reverted|roll ?back|rolled back|restore|restored|reinstall|recreate|re-run|rerun|git (checkout|revert|reset|stash)|delete the|remove the)\b|戻せ|戻る|戻す|元に戻|消せ|やり直|再実行|再作成|復元/i`. For a blocker, the rows of the 3 fixed labels are exempt (they need no undo sentence); any other row is checked. Evaluated only for tables satisfying 1–4, after `cell_long` and `coined_term`.

### 3.4 `has` (facts for the record)

Recorded separately from pass / fail, for the whole body (`explanation.has`, used for the (d) tally).

| Field | Condition |
|---|---|
| `mermaid` | There is a ` ```mermaid ` code block anywhere in the body |
| `table` | There is a GFM table (header row + separator row) anywhere in the body (columns and rows are not checked) |
| `diff` | There is a ` ```diff ` code block anywhere in the body |

### 3.5 Emphasis syntax (optional; the hook does not check)

- Use `**bold**` only for the phrases that decide the matter (skill advice: at most one per sentence and 8 in the whole explanation; the hook does not check). The GUI draws it in the accent color, and only inside "Risks and how to undo" in red.
- Make irreversible results and effects on other people or external systems a callout: `> [!WARNING]` (undoing costs something), `> [!CAUTION]` (cannot be undone). 1–2 lines.
- A checked fact that sways the decision may use `> [!NOTE]` (supplement), and a useful hint `> [!TIP]`.
- The GUI renders a callout as a colored box (NOTE = accent, TIP = green, WARNING = yellow, CAUTION = red). A different syntax does not break; it appears as a plain quote.

### 3.6 Length limits

So that option cards are not pushed off screen in the right column of the GUI, lengths are checked. Characters are code points after NFKC (full-width and half-width are the same 1 character). The body of a section excludes code blocks and blank lines.

| Target | Limit | Code |
|---|---|---|
| Body of the "Recommendation" section | 400 characters and 5 sentences (the check limit; the skill aims for 3 sentences) | `recommend_long` |
| Cells of "What happens if chosen" and "Risks and how to undo" in the options table | 160 characters each (sentences are not counted; the skill aims for 2 sentences) | `cell_long` |
| Body of "Why this decision is needed now" ("Why I stopped" for a blocker) | 600 characters | `why_long` |

- Sentences are split on `。` `!` `?` (also `！` `？` after NFKC) and on a `.` followed by whitespace or the end (`file.ts` and `0.5` are not split).
- `cell_long` looks only at tables that satisfy 3.3. For a blocker `recommend_long` / `recommend_cond` are not evaluated (there is no Recommendation section).
- Put details, evidence and logs in the "What I checked" section (required unless reversible + file; the content is not checked).

### 3.8 Coined terms (`coined_term`)

The reader did not write the agent's plan, so identifiers the agent made up (plan item codes, phase / gate / worker names) mean nothing to them. The hook denies any such token that Terms does not define. Evaluated for decisions and blockers (not plans), right after `cell_long` (even when the table is absent) and before `undo`.

**Text scanned.** The front matter `title` plus the body outside code fences (inline code is included). URLs are ignored. Text is NFKC-normalized first.

**Detection** (exported from `src/hook/explain.ts`):

- `COINED_TOKEN` = `/\b[A-Z]{1,4}\d{0,3}-[A-Z0-9]{1,4}\b|\b[A-Z]{1,4}\d{1,3}[A-Z]?\b/g` (case-sensitive): `W-T2`, `FT4`, `G-T2`, `TM28`, `P-GH`, `DT1`, `Q5-01` (the hyphenated form is tried first, so `Q5-01` is one token). Before scanning, `COINED_SKIP` blanks well-known shapes: `FY\d{2,4}`, `CVE-\d{4}-\d+`, cloud regions (`US-EAST-1`), `PCI-DSS`, `P-?\d{3}` (`P-256`), `MPEG-\d`, `PM2.5`. A match is skipped when it is in the allowlist (one letter + one digit such as `W3` or `P1` **is** a hit; agents name work items that way), or when it is the tail of a version (`v0.2.0-DT1`).
- `COINED_PHASE_EN`: a process word (Phase, Step, Stage, Sprint, Milestone, Gate, Track, Wave, Round, Batch, Lane; any case; `Day` / `Week` / `Tier` are ordinary prose and not listed) + optional space + an id of 1-3 digits with an optional letter (`Phase 2`, `Step 3a`) or 1-3 capitals / digits starting with a capital (`Gate B`). The id must not continue into letters / digits or `-X` (so "step by step" and "gate G-T2" are not hits; `G-T2` is the hit).
- `COINED_PHASE_JA`: (フェーズ|ステップ|段階|工程|ゲート|トラック|ラウンド|第) + optional space + 1-3 digits / capitals (`フェーズ 2`, `第 3`). A capital-only id in the allowlist (`段階 CI`) is skipped.
- `COINED_ALLOW` (whole token, uppercase): CI CD CLI API GUI TUI SSE URL URI HTTP HTTPS JSON YAML TOML HTML CSS JS TS PR OSS DB UI UX OK NG ID CPU GPU RAM GB MB KB TB MS TTY ANSI SQL SSH TLS SSL DNS IP TCP UDP GCP AWS GCS S3 IAM VM OS PID ENV NPM PNPM CDN SVG PNG JPG PDF CSV UTF IDE LSP MCP LLM AI QA ADR README TODO FAQ EOF CRUD REST RPC GRPC JWT SDK ETA TBD WIP NFKC SGR ESC CJK IME UTC ISO RFC HEAD, plus SHA RSA AES HMAC GPT IPV MD5 MP3 MP4 EC2 K8S P50 P90 P95 P99, ARM64 ARM32 X86 X64 ES5 ES6 ES7 E2E W3C X11 CO2 H2O V8 R2 U2 Z3 A100 H100 H264 H265 AV1 VP9 DB2 IE11 PS5 PS4 SOC2 SAML2 PCI MPEG D3 BM25 B2B B2C C2C P2P I18N L10N A11Y OIDC, Apple chips M1-M4, cache levels L1-L4, quarters / halves Q1-Q4 H1 H2, T1-T3, C4 TS5 PG16 S3A F-16 B-52. Those are the only one-letter-plus-digit exceptions (M1-M4 L1-L4 Q1-Q4 H1 H2 T1-T3 V8 R2 U2 Z3); any other such token (`W3`, `P1`) stays a hit. A token whose leading letters (3 or more) are in the list is also allowed (`UTF-8`, `HTTP-2`, `SHA-256`). `#12` and `v1` / `v0.2.0` never match the patterns; HTTP statuses are digits only.

**Exempt tokens.** Tokens found in the front matter `question`, in `recommended`, in the AskUserQuestion option labels, or in the first column of the Options tables (labels are what the human picks; the hook cannot change the question).

**Defined by Terms.** A token is defined when a Terms item (3.7 `parseTerms`) whose term contains it has a definition of at least 12 characters (NFKC code points) after removing pointer phrases (`plan の行` / `the plan item` / `see plan` / `計画の項目`, case-insensitive) and leading punctuation. A short definition or a pointer alone counts as undefined.

**Deny text.** `coined_term` is listed as "internal identifiers the reader cannot know (<tokens, at most 8, then "and N more">; plan codes, phase / gate / worker names). Say what each is in plain words, or define it under Terms". When the Cannot answer sentence of section 15 is also in the same deny reason, the trailing "Say what each is …" clause is dropped so that "define it under Terms" appears once.

### 3.7 Parsers (exported; the GUI keeps its own copy, the TUI imports these)

All take the whole Markdown (front matter included; it is skipped). Lines inside code fences are ignored. Headings are matched by the rules of 3.1.

| Export | Signature | Result |
|---|---|---|
| `parseBullets` | `(markdown: string, names: readonly string[]) => string[]` (`names` e.g. `SECTION.unknowns`) | The bullet items (`-` `*` `+` `1.` `1)`) of the section, marker removed. Indented continuation lines are joined with a space. `[]` when the section is absent |
| `parseTerms` | `(markdown: string) => { term: string; definition: string }[]` | The items of the Terms section. Accepted: `- **term** — definition`, `- **term**: definition` (also `**term:** definition`), `- term — definition` (a `:` also works for the plain form; `—` `–` `―` `-` and `：` are separators). Items without a separator or with an empty side are skipped |
| `parseFootnotes` | `(markdown: string) => { defs: { id: string; text: string }[]; refs: string[] }` | `defs`: lines `[^id]: text` anywhere in the body (indented continuation lines joined; the first definition of an id wins). `refs`: distinct `[^id]` references in order of appearance (definition lines, inline code and fences are not references) |
| `Table.extraColumns` | `number[]` on each table from `findTables` | See 3.3 item 5 |

**Footnotes (`footnote`).** For every id in `refs` there must be a definition in `defs`, anywhere in the body (recommended: in "What I checked"). A definition without a reference is fine. Not evaluated for a blocker.

## 4. Check result

The check lists the following `missing` codes **in this order** (the table is by group; the actual order is: `front_matter`, `language`, `question` … `recommended`, then for `type: quiz` only `quiz_recommended`, `quiz_why`, `quiz_premise`, `quiz_leak` (nothing after them is evaluated), else `why`, `why_long`, `options`, `table`, `cell_long`, `coined_term`, `undo`, `todo` / `recommend`, `recommend_long`, `recommend_cond`, `recommend_name`, `against_weak`, `assumptions_long`, `diagram`, `diagram_trivial`, `checked`, `footnote`). When `missing` is empty, `valid: true`.

| Code | Condition (added when it is not satisfied) | Name in the deny reason |
|---|---|---|
| `file` | The explanation file is not found (no other code is evaluated in this case) | the explanation file itself |
| `front_matter` | No front matter, it is not closed, or `ukagai` is not `1` | front matter (`ukagai: 1`) |
| `question` | `question` is absent or empty | `question` |
| `type` | `type` exists but is none of `decision` / `blocker` / `quiz` (evaluated as decision from then on) | `type` (decision / blocker / quiz) |
| `title` | `title` is absent or empty | `title` (the decision for the human, in one sentence) |
| `reversibility` | Absent, or the value is outside the set | `reversibility` |
| `scope` | Absent, or the value is outside the set | `scope` |
| `recommended` | Absent or empty, or by label matching it matches none of `options[].label` (when labels are known) | `recommended` (label of the option you recommend) |
| `quiz_recommended` | (`type: quiz` only; right after `scope`) `recommended` is present, even empty | a quiz must not recommend an answer; remove `recommended` |
| `quiz_why` | (`type: quiz`) The "Why this question now" section is absent, empty or over 600 characters | the "Why this question now" section (1 to 600 characters) |
| `quiz_premise` | (`type: quiz`) The "Premise" section is absent, empty or over 600 characters | the "Premise" section (non-empty, at most 600 characters) |
| `quiz_leak` | (`type: quiz`; only when labels are known) An option label of 6 or more characters occurs in the Why / Premise / How to answer bodies (section 3.2) | the explanation repeats an option; a quiz explanation must not point at an answer |
| `why` | The "Why this decision is needed now" section ("Why I stopped" for a blocker) is absent or empty | the "Why this decision is needed now" section |
| `why_long` | The `why` section exceeds the limit of 3.6 (not evaluated when `why` failed) | the "Why this decision is needed now" section is too long (at most 600 characters; put details in "What I checked") |
| `options` | The "Options" section is absent | the "Options" section |
| `table` | `options` exists but there is no table of 3.3 (not evaluated when `options` is absent) | the options table (first column is the label; columns for what happens if chosen and for risks and how to undo; one row per option) |
| `cell_long` | A cell of a table satisfying 3.3 exceeds the limit of 3.6 (not evaluated when `table` failed) | a cell in the options table is too long (at most 160 characters per cell) |
| `language` | Configured language is `ja` (`config.json`) and the front matter `title` plus the Why section (blocker: "Why I stopped") has no hiragana / katakana / han, **or** `questions[0].question` has none, **or** some option has a `description` but none of the descriptions has one (labels are not checked: an English sentence may itself be the option). Not checked for `en`. Right after `front_matter`, before `question`; blockers too. `validateExplanation(markdown, kind, labels, lang = "en", ask?)` | the configured language is Japanese: write the title, the explanation and the AskUserQuestion question / labels / descriptions in Japanese (code and proper nouns may stay) |
| `coined_term` | An identifier-like token (3.8) in the title or body is neither exempt nor defined under Terms (decisions and blockers; right after `cell_long`, evaluated even when `table` failed) | internal identifiers the reader cannot know (plan codes, phase / gate / worker names). Say what each is in plain words, or define it under Terms (the deny text lists the tokens) |
| `undo` | A risk cell of a table satisfying 3.3 matches none of `UNDO_WORDS` (3.3 item 6; blocker: the 3 fixed rows are exempt; not evaluated when `table` failed; right after `coined_term`) | each risk cell must say how to undo (or that it cannot be undone) |
| `todo` | `type: blocker` but the "What you need to do" section is absent or empty, or has no code block | the "What you need to do" section (with a code block of commands) |
| `recommend` | (not evaluated for a blocker) The "Recommendation" section is absent or empty | the "Recommendation" section |
| `recommend_long` | (not evaluated for a blocker) The "Recommendation" section exceeds the limit of 3.6 (not evaluated when `recommend` failed) | the "Recommendation" section is too long (at most 5 sentences and 400 characters) |
| `recommend_cond` | (not evaluated for a blocker) The body of the "Recommendation" section (excluding code blocks and callout lines) contains none of the words matched by `RECOMMEND_COND`: `なら` (not `ならない` / `ならず`) / `なければ` (not `なければなら…`; includes 「でなければ」) / `場合` / `とき` (not `ときどき`) / `であれば` / `際は` / `際に` / `\bif\b` / `\bwhen\b` / `\bunless\b` / `\botherwise\b` / `\bin case\b` (Latin letters are case-insensitive) (not evaluated when `recommend` failed; right after `recommend_long`) | a condition in "Recommendation" under which another option is right (write it as "if ... choose B", "when ...", "unless ...", etc.) |
| `multi` | (not a check; used in step 0 of section 5) `questions` has two or more entries | one question per call |
| `recommend_name` | (not evaluated for a blocker; only when `recommended` is set and `recommend` passed) The **first sentence** of the "Recommendation" body (callouts and code blocks excluded; ends at `。` / `!` / `?` / a `.` followed by whitespace; NFKC, whitespace / backticks / asterisks removed, lowercase) does not contain the `recommended` label without `(Recommended)` / `(推奨)`, nor its opening (first 3 words for an ASCII label of 4+ words, else the first 12 characters), **or** it refers to an option by position. The label (or its opening) is **masked with a placeholder everywhere in the body before the text is split into sentences**, so a `.` / `。` inside the label (`1. Redis`, `Keep it.`) does not end the sentence and a positional word inside the label (`Plan B: rollback`, `案 A を採用`) is not checked; a label of 3 characters or fewer (`Go`) must match on a word boundary (not inside `Google`). `POSITIONAL_REF` is tested on the first sentence after masking: `POSITIONAL_REF` = `1つ目` / `2つ目` / `3つ目` / `一つ目` / `二つ目` / `三つ目` / `最初の案` / `案 ?[A-D]` / `選択肢 ?[0-9]` / `the first|second|third one|option` / `option [0-9A-D]` / `plan [A-D]` (a positional wording fails even when the label is present; right after `recommend_cond`) | the first sentence of "Recommendation" must name the recommended option by its label (quote its first words), not by position; do not refer to options by position ("the first one", "plan A") |
| `against_weak` | (not a blocker; only when both sections exist) The "Counterargument" body, with whitespace, punctuation and symbols removed (NFKC, lowercase), is a substring of the "Recommendation" body normalized the same way (right after `recommend_cond`) | the Counterargument repeats the Recommendation; make it attack the pick |
| `assumptions_long` | (not a blocker) The "Assumptions" section has 4 or more **top-level** bullets (`-` / `*` / `+` / `1.` only those at the shallowest indentation of the section count; deeper-indented children and fenced lines are not counted; right after `against_weak`) | at most 3 Assumptions: keep only premises you did not verify and that would change the pick |
| `diagram` | (not evaluated for a blocker) A diagram is required (3.2) but the "Diagram" section or the ` ```mermaid ` block is absent | a "Diagram" section with a Mermaid diagram |
| `diagram_trivial` | (not evaluated for a blocker) A Mermaid flowchart / graph in the file is trivial (see 3.2); when it is, `diagram` is not reported | remove the diagram: it only branches into the options or has 4 or fewer nodes, and the Options table already says it |
| `checked` | (not evaluated for a blocker) Not (`reversibility: reversible` and `scope: file`), and the "What I checked" section is absent or empty (right after `diagram`) | the "What I checked" section (required unless reversible + file; commands run, files read, evidence as footnotes) |
| `footnote` | (not evaluated for a blocker) The body has a `[^id]` reference with no `[^id]: …` definition (3.7; right after `checked`) | a footnote definition for every `[^n]` in the body (write `[^n]: evidence` in "What I checked") |
| `impact` | (plans only, section 9) The "Scope and reversibility" section is absent or empty | the "Scope and reversibility" section |

- Without front matter only `front_matter` is added, and `question` `title` `reversibility` `scope` `recommended` are not evaluated (the diagram requirement is judged "required" on the safe side).
- The input of the check is "the whole file" and an optional `labels` (an array of `questions[0].options[].label`; `validateExplanation(markdown, kind, labels?)`).
- The format check of the `question` field itself and the matching against the question in stdin (step 1 of the next section) are separate. The check looks only at whether the field exists.

## 5. The hook's procedure (PreToolUse × AskUserQuestion)

When `permission_mode === "plan"` the explanation is a block in the plan file (section 6; no plan file found, or Codex: no explanation is required). Otherwise:

0. **Deny when there are several questions**: when `questions.length > 1`, before any lookup return `permissionDecision: "deny"` and register it as `denied_explain` (no `explanation` attached). The reason is the following (repeated in section 7; at most 1000 characters; no URL): `[ukagai, not a failure] Ask one question per AskUserQuestion call (this call had N). The GUI shows one question at a time, with its explanation file. Starting from the first question, write an explanation file for each and call AskUserQuestion again with that single question. Do not ask in prose.` (For `agent: codex`, `AskUserQuestion` reads `request_user_input`.) Loop guard: when a `denied_explain` with `questions.length > 1` exists for the same `session_id + agent_id` **within 2 minutes**, do not deny and go to step 1 (with no explanation: `attached_via: none` / `none_reason: loop_guard`). The question text is not compared (the first question after splitting has a different text).
1. **Lookup**: among the `.md` files (excluding `.used.md`) in the location (section 1), look for one whose front matter `question` **exactly matches** `questions[0].question` (the latest mtime if several; `match: question`). If there is none, use the unused file written **within 10 minutes** (by mtime) if there is exactly one (`match: recency`). With zero or two or more it is "not found" (`file`).
2. **Check and register**: run the file found through the check of section 4. If it passes, register the Decision. `attached_via` is `after_deny` when a `denied_explain` for the same `session_id + agent_id + questions[0].question` exists within the last **2 minutes**, otherwise `first_call`. The file used is renamed to `<name>.used.md`.
3. **Deny**: when not found or the check fails, return `permissionDecision: "deny"` + the reason of section 7 and register it as `denied_explain` (not shown in the GUI).
4. **Loop guard** (not applied while a "Cannot answer" memo exists for the session, section 15): at the time of step 3, when a `denied_explain` for the same `session_id + agent_id + questions[0].question` already exists within **2 minutes**, do not deny and show it in the GUI without an explanation (`attached_via: none`, `none_reason: loop_guard`, with a "no explanation" mark in the GUI).

## 6. Plan mode

In plan mode the plan file is the only file the agent may write, so a Claude `AskUserQuestion` with `permission_mode === "plan"` carries its explanation **inside the plan file**, one block per question:

```
<!-- ukagai-explain -->
---
ukagai: 1
question: <the question verbatim>
...front matter and sections of an ordinary explanation file...
<!-- /ukagai-explain -->
```

- **Plan file discovery** (`findPlanFile`, `src/hook/plan-file.ts`). The transcript (last 64 MB, streamed) is scanned for the plan-mode reminder: the last match of `create your plan at <abs path>.md` or `plan file … <abs path>.md` (also in the JSON-escaped `\/` form). The plans directory is configurable, so any absolute `*.md` is accepted, provided it exists, is a regular file, and its realpath is under the home directory. Fallback: the newest `<home>/.claude/plans/*.md` modified within 30 minutes that holds a block for this question.
- **Block**: `extractExplainBlocks` returns every terminated block (an unterminated one is ignored); the block whose front matter `question` equals `questions[0].question` verbatim is validated with the same `validateExplanation` as a file (section 4). Missing or invalid → deny with the plan-mode text below (loop guard, multi-question guard, `--deny-template` and the "Cannot answer" memo apply as in section 5). Valid → registered with `explanation.markdown` = the block body and `explanation.path` = `<plan file>#ukagai-explain` (the hook never edits the plan file; no `.used.md` rename). The server accepts that path when the plan file is under home.
- **No plan file found** (a reworded reminder, no transcript) and **Codex** (no plan file): no explanation is required, `attached_via: none`, `none_reason: plan_mode`, excluded from the denominator of (d).
- **Deny text** (variant A; B is the polite variant): `First read skill ukagai-explain (if you have not). In plan mode the explanation goes into your plan file, not a separate file: append to <planFilePath> a block between <!-- ukagai-explain --> and <!-- /ukagai-explain --> holding the explanation (…), then call AskUserQuestion again with the same question. Missing: <missing>.` plus a short block template when a front matter key is missing (at most 1600 characters).
- **ExitPlanMode** strips every block from `plan` (`stripExplainBlocks`, `src/contract.ts`) before checking and registering it; the server's plan views (`/api/plans`) strip them too.

### 6.1 Plan-writing rules (`hook --plan-context`)

Two triggers, one command. Plan mode the agent enters itself calls `EnterPlanMode`; plan mode the human enters (Shift+Tab, `--permission-mode plan`) calls no tool, so the first prompt typed in plan mode carries the rules instead.

| Group | Event / matcher | Fires when |
|---|---|---|
| `PreToolUse` | `EnterPlanMode` | the agent enters plan mode |
| `UserPromptSubmit` (sync, next to the async observe entry) | none | the hook input has `permission_mode: "plan"` (`HookEvent` carries it) |

Both are sync, `timeout: 3`, no statusMessage, omitted with `install --observe`. The command never calls the server and exits 0 in every case; a failure prints nothing. It injects **at most once per session**: a marker file `<data-dir>/plan-context/<session_id>` is created with `wx`; if it exists nothing is printed, any other marker error (read-only dir, unset HOME) means inject. Output (the tool / prompt proceeds; no `permissionDecision`, like the checkpoint path), with `hookEventName` = the event's name:

```
{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"<text>"}}
```

`<text>` is 13 lines, English (`planContextText`, `src/hook/plan-context.ts`; `test/hook/plan-context.test.ts` pins this block to it); `<repo>` is the checkout the installed `dist/` sits in, and the last line names the spec file only when it exists there:

```
[ukagai] Write the plan in ukagai Markdown; a human reads it in a GUI / TUI and decides on it. Plan sections, in this order:
- `# Title`: one line saying what the plan does.
- `## Scope and reversibility`: its first 2 lines are exactly `Reversibility: reversible|costly|irreversible` and `Scope: file|repo|machine|external`.
- `## Steps`: an ordered list; each item starts with a **bold title**, then a badge ([done] [todo] [doing] [blocked] [risk] [skip]) and the `path` it touches; nest task lists or details under it.
- `## Risks`: one callout per risk, `> [!CAUTION] Title` for anything irreversible or touching other people / external systems, `> [!WARNING]` for costly to undo.
- `## Verification`: a task list (`- [ ] command or check`) the reader can tick off.
A question you ask while in plan mode needs its explanation inside the plan file between `<!-- ukagai-explain -->` and `<!-- /ukagai-explain -->` (same format as the explanation file; see skill ukagai-explain).
Palette (use what makes the decision easier to read, nothing more):
- callouts with titles `> [!NOTE|TIP|IMPORTANT|WARNING|CAUTION] Title`, task lists `- [x]` / `- [ ]`, folding `<details><summary>..</summary>` (blank line after the summary) for long evidence;
- Mermaid of any type (flowchart, sequenceDiagram, stateDiagram-v2, gantt, pie, quadrantChart, ...), code blocks with a title (```ts title="src/x.ts") and ```diff for proposed changes;
- Draw a diagram only when it shows something the Options table cannot: a sequence of 3 or more steps between 2 or more actors, a state machine with 4 or more states, or a data flow between 3 or more components (a flowchart needs 5 or more nodes). Never draw the options themselves as nodes (a branch into A / B / C) and never restate the table; at most one diagram; when in doubt, none. When the decision is not reversible or the scope is machine / external, a diagram that meets this rule is required; if none does, write none and say why in one line under Options ("No diagram: <why>").
- `==mark==` for the one phrase not to miss, `::: columns` (columns split by `---`, closed by `:::`) for before / after (the Options section stays a table), images `![meaningful alt](shots/x.png)` only for a file that already exists next to the plan file (the plan file is the only file you may write).
Never open a file or a URL for the human (`open`, `xdg-open`, a browser): put it in the explanation — images `![alt](x.png)`, HTML pages `![alt](x.html)` (the GUI renders them in a sandboxed frame); files next to the explanation file or under the session's scratchpad.
Full spec: skill ukagai-explain, section "Rich Markdown (ukagai dialect)", or <repo>/docs/spec/markdown.md.
```

Nothing is required by this hook: `ExitPlanMode` still checks only the "Scope and reversibility" section (section 9). `doctor` lists the groups as `hook PreToolUse (plan context)` and `hook UserPromptSubmit (plan context)`. Codex has no such tool (see `codex-bridge.md`).

## 7. Deny reason templates

There are two. By the result of E4 (round trips of 2 passed for 6 of 7 imperative sentences, and 2/2 for fact + request) **variant A is the default**. `--deny-template` switches to variant B.

Placeholders:

- `{path}`: absolute save path (`<scratchpad_dir>/ukagai/explain.md`; any name is fine but one example is shown)
- `{question}`: the verbatim `questions[0].question`
- `{missing}`: the "names" of section 4 (including `recommended`, `title`, etc.; because the names are long the 1000-character cut is likely to apply) joined with `; ` (`todo` = the "What you need to do" section (with a code block of commands), `type` = `type` (decision / blocker))

Common constraints: every deny reason the hook sends (explanation, plan, several questions, hand-off) starts with `[ukagai, not a failure] `, so the agent does not read a validation round as an error. **Do not write the GUI URL, port or API path** (so that Claude does not answer by itself with `curl`). The expanded text is **at most 1000 characters** (**at most 1600 characters** when the "minimal template" below is embedded). When it is exceeded, `{missing}` is cut to "... and N more", and if it is still too long the last sentence is dropped. `{question}` is never cut because matching needs the verbatim text.

### Variant A: imperative

```
First read skill ukagai-explain (if you have not). Before AskUserQuestion, write an explanation file the human can decide from. Missing: {missing}.
Save to: {path} (any name in the same directory). Put exactly this string in the front matter question: {question}
The full format is in skill ukagai-explain. When done, call AskUserQuestion again with the same question. Do not ask in prose.
```

### Variant B: fact + request

```
Could you first read skill ukagai-explain (if you have not)? The explanation file (ukagai format) for this decision does not meet the requirements yet. Missing: {missing}.
Could you write {path} (any name in the same directory is fine)? The front matter question: must be identical to "{question}".
The full format is in skill ukagai-explain. When done, please call AskUserQuestion again with the same question.
```

### Minimal template (Q4-04)

When `missing` contains any of `file` / `front_matter` / `question` / `title` / `recommended` (= the format is unknown at the first deny), paste the following as one code block right after the `Save to:` line. `question:` holds the real question text (in this case the sentence "Put exactly this string…" is omitted). When only other codes such as `table` are missing, it is not pasted (the reason stays short). The placeholder under Recommendation must not contain any word that satisfies `RECOMMEND_COND` (if / when / unless / otherwise / in case), so leaving it as it is does not pass `recommend_cond`.

```
---
ukagai: 1
question: {question}
title: <the decision for the human, in one sentence>
recommended: <label of the option you recommend>
reversibility: reversible | costly | irreversible
scope: file | repo | machine | external
---
## Why this decision is needed now
## What only you know  (1-3 bullets: what you could not settle by investigating)
## Options
| Option | What happens if chosen | Risks and how to undo |
## Recommendation
(the option you recommend and why; the last sentence names the condition that makes another option right)
## Assumptions  (one premise per bullet)
## Diagram  (Mermaid; for anything not reversible, or scope machine / external)
## What I checked  (commands run and files read; evidence as [^1]: ... cited from the body; not needed for reversible + file)
```

Terms, Counterargument and Affected are optional and are not in the template. The placeholders under "What only you know" and "Assumptions" are in parentheses on the heading line, so leaving them as they are does not pass any check.

When the file found has `type: blocker`, the blocker template is pasted whenever anything at all is missing: the front matter has `type: blocker`, `recommended: Done. Continue`, `reversibility: reversible`, `scope: machine`; the sections are "Why I stopped", "What you need to do" and "Options" (the table header and the rows of the 3 fixed labels; no Recommendation or Diagram).

### Deny reason for several questions (step 0)

`[ukagai, not a failure] Ask one question per AskUserQuestion call (this call had N). The GUI shows one question at a time, with its explanation file. Starting from the first question, write an explanation file for each and call AskUserQuestion again with that single question. Do not ask in prose.` There is no A / B distinction.

## 8. additionalContext of SessionStart / SubagentStart

Both return synchronously. At most 5 lines. `{absolute location}` is the `<scratchpad_dir>/ukagai/` or `~/.ukagai/explain/<session_id>/` decided in section 1. No URL. The enumerated values are written (E5 found that without them `reversibility` / `scope` become free text). All of it is English.

The hook reads `lang` with `readConfig(dataDir)` (`<data-dir>/config.json`; default `en`) and adds one sentence to line 2:

- `en`: `Write the explanation file in English.`
- `ja`: `Write the explanation file in Japanese (the human reads it in Japanese); section headings may be English or Japanese.`

```
Before asking a human, read the code and verify with commands, and settle on one recommendation. If you cannot state in one sentence why only a human can decide (taste, external circumstances, an irreversible change, premises you cannot know), do not ask: proceed with the recommendation and report it.
When you do ask, write the explanation the human reads as Markdown in {absolute location}/ following skill ukagai-explain. {language sentence}
front matter: question is the AskUserQuestion question verbatim, title is the decision for the human in one sentence, recommended is the label of the option you recommend, reversibility is reversible / costly / irreversible, scope is file / repo / machine / external. Body: "Why this decision is needed now", "Options" (table: first column is the label; columns for what happens if chosen and for risks and how to undo), "Recommendation" (reason, and the condition under which another option is right). Recommendation: first sentence is a conclusion that decides on its own and names the option, last sentence is "if ..., B" (at most 5 sentences and 400 characters); table cells at most 160 characters and each risk cell says how to undo. Also write "What only you know" (1-3 bullets) and "Assumptions" (one per line), and unless reversible + file, "What I checked" with evidence as footnotes ([^1]) cited from the body. Optional: "Terms", "Counterargument", "Affected". Draw a Mermaid diagram only when the decision is hard to undo (anything but reversible) or scope is machine / external, and the options differ in structure or flow.
Do not ask in prose. Call AskUserQuestion one question at a time from the start (never batch; do not write an explanation that contradicts an earlier answer), mark the deciding factor in **bold**, put irreversible effects in a > [!CAUTION] callout, put the recommended option first and append (Recommended) to its label. A plan body needs a "Scope and reversibility" section whose first 2 lines are "Reversibility: reversible|costly|irreversible" and "Scope: file|repo|machine|external". In plan mode, put the explanation into your plan file between <!-- ukagai-explain --> and <!-- /ukagai-explain --> (same format) instead of a separate file. Explanations and plans are written in ukagai Markdown (callouts, task lists, details, Mermaid, badges, columns, images); the palette is in skill ukagai-explain, section "Rich Markdown".
When stopped by human work such as authentication or permissions, do not end in prose: write a blocker-format explanation and ask with AskUserQuestion (Done. Continue / Skip this step and continue / Stop here). After the human acts, retry the same work. If an answer starts with "None of these — ", act on its type: add options, fix the premise and re-ask, add evidence, or ask later.
```

The Codex context (`codexContextText`) carries a shorter sentence on its format line (only the self-evident constructs with their syntax: callouts, task lists, `<details>`, Mermaid; Codex has no skill and no plan-mode hook). Claude Code adds the plan-writing rules in plan mode (section 6.1).

`AskUserQuestion` is not provided inside a subagent, so no decision arises there (confirmed with Claude Code 2.1.287). The additionalContext of SubagentStart arrives but is never used.

### 8.1 SessionStart autostart (the hook's behavior)

- Before returning additionalContext, the SessionStart hook checks the server with `GET /healthz` (300 ms). When it is unreachable and the server URL is `127.0.0.1` / `localhost`, it starts `cli.js serve` detached (log in `<data-dir>/serve.log`) and waits up to 2 seconds for healthz. At most 2.5 seconds overall.
- Once the server is reachable, the hook only asks: `POST /api/gui/open` (Bearer, 300 ms; the answer is ignored). The server decides and owns the `<data-dir>/gui-opened` marker (local `YYYY-MM-DD`): when the marker is not today and no GUI tab (an `/api/stream` client with the cookie; the TUI uses the Bearer and does not count) is connected within 8 s (a pinned tab reconnects every 5 s at most), it opens `http://127.0.0.1:<port>/?autostart=1` with `open` (darwin) / `xdg-open` (linux) and writes today's date. A connected tab only moves the marker. A tab opened this way closes itself when another ukagai tab answers on a `BroadcastChannel` (see `public/README.md`).
- With `--no-autostart` it does nothing (`install --no-autostart` puts it in the SessionStart args). SubagentStart does nothing. Failures are swallowed (fail open).

## 9. ExitPlanMode

- No separate file is required. `tool_input.plan` (the plan body) is checked.
- Check: by the matching rules of 3.1, there is a heading matching "Scope and reversibility" (影響範囲と可逆性), and the section has at least one non-empty line. The heading level does not matter. Otherwise `missing: ["impact"]`.
- Mermaid is **recommended** and not required. Without it `has.mermaid: false` is counted in (d).
- A deny for a defect happens **at most once per session (`session_id`)**. From the second time it does not deny and registers (`attached_via: none`, `none_reason: loop_guard`).
- When it passes, `attached_via` is `first_call` (`after_deny` if denied before). `explanation.markdown` holds the plan body.
- Reversibility and scope: `parsePlanImpact` reads `Reversibility:` / `Scope:` lines (also `reversibility:` / `scope:` / `可逆性:` / `影響範囲:`; a bullet, bold or backticks are fine; values are the English words, 3 / 4 of them) from the "Scope and reversibility" section. When found they are sent as `explanation.reversibility` / `explanation.scope` (the GUI / TUI then apply the confirm-twice and undo grace rules). A missing or unknown value is left out, and that plan is sent at once. They are not validated and never deny.
- It is required even in plan mode (ExitPlanMode is only called in plan mode). Section 6 (explanation blocks in the plan file) is for AskUserQuestion only.
- The deny reason follows the variant of section 7, with `{missing}` = "the "Scope and reversibility" section" and the `{path}` / `{question}` lines omitted.

## 10. Handling of Mermaid

The hook does not check Mermaid syntax (it only checks whether the code block exists). When rendering fails, the GUI shows the code as it is with an error attached.

## 11. Fixtures

`test/explain-fixtures/` has 34. An optional `<name>.labels.json` (an array of strings) next to a fixture gives the option labels passed to the check (used by `fail-quiz-leak`). Each `*.md` is the whole explanation (or plan), and `*.expected.json` is the expected check result `{ valid, missing, has: {mermaid, table, diff}, question }`. `question` is the front matter value (`null` when absent, and for plans). Files starting with `plan-` go through section 9 (the plan body), the others through the check of section 4. Tables are judged assuming `labels` is not passed (2 or more data rows, no label matching).

`pass-*` and the other `fail-*` fixtures satisfy `checked` and `undo` (their text was extended), so each `fail-*` reports only its own code. The fixtures are written in English. The `question:` line keeps the original question text, because `expected.json` records it. Three Japanese variants (`*-ja.md`, with the same `expected.json` contents) exercise the Japanese aliases.

| File | valid | missing |
|---|---|---|
| `pass-design.md` | true | none |
| `pass-design-ja.md` | true | none (Japanese headings and columns) |
| `pass-naming.md` | true | none |
| `pass-destructive.md` | true | none |
| `fail-no-table.md` | false | `table` |
| `fail-no-table-ja.md` | false | `table` (Japanese) |
| `fail-no-recommended.md` | false | `recommended` |
| `fail-old-columns.md` | false | `table` (the old pros / cons / cost table) |
| `fail-no-recommend-section.md` | false | `recommend` |
| `fail-no-question.md` | false | `question` |
| `fail-no-diagram-when-required.md` | false | `diagram` |
| `plan-heading-variant.md` | true | none |
| `pass-blocker.md` | true | none (`type: blocker`, a code block in `todo`, a 3-row table, no Recommendation or Diagram) |
| `pass-blocker-ja.md` | true | none (Japanese headings and fixed labels) |
| `fail-blocker-no-todo.md` | false | `todo` |
| `fail-bad-type.md` | false | `type` (`type: foo`) |
| `fail-no-recommend-cond.md` | false | `recommend_cond` |
| `fail-recommend-name.md` | false | `recommend_name` (`pass-design-ja.md` whose first sentence says 「1つ目を勧めます。」) |
| `fail-assumptions-long.md` | false | `assumptions_long` (`pass-rich.md` with 4 Assumptions) |
| `fail-against-weak.md` | false | `against_weak` (`pass-rich.md` whose Counterargument repeats a sentence of the Recommendation) |
| `fail-cell-long.md` | false | `cell_long` |
| `pass-quiz-ja.md` | true | none (the contract example: `type: quiz`, a block-scalar `question`, no Options table) |
| `pass-quiz-en.md` | true | none (English quiz) |
| `fail-quiz-recommended.md` | false | `quiz_recommended` |
| `fail-quiz-no-premise.md` | false | `quiz_premise` |
| `fail-quiz-leak.md` | false | `quiz_leak` (with `fail-quiz-leak.labels.json`) |
| `fail-coined-terms.md` | false | `coined_term` (plan codes W-T2 / FT4 / G-T2 / TM28 / P-GH, undefined) |
| `pass-coined-defined.md` | true | none (the same codes defined under Terms in plain words) |
| `fail-recommend-long.md` | false | `recommend_long` |
| `fail-why-long.md` | false | `why_long` |
| `pass-rich.md` | true | none (every section, a 4-column table, footnotes `[^1]` `[^2]` with definitions in "What I checked") |
| `fail-no-undo.md` | false | `undo` (`pass-rich.md` with risk cells that do not say how to undo) |
| `fail-no-checked.md` | false | `checked` (costly + repo, no "What I checked") |
| `fail-footnote.md` | false | `footnote` (`[^2]` referenced, not defined) |

## 12. Stop hook safeguard (removed)

**Removed (2026-10-05).** The `Stop` hook used to make the agent continue when its last message matched a bilingual vocabulary (a target word such as 認証 / 権限 / permission / login / token and a stuck word such as ない / 必要 / denied in the same sentence), telling it to re-ask in blocker format (`decision: block`, `blocker_detected: true` on the event).

Why it went: over 3 days of real use it blocked 32 times in 15 sessions, and only 2 were followed by a blocker question. The rest were false positives on messages *about* authentication or permissions; each cost an extra turn and was shown by Claude Code as "Stop hook error". 6 of the 8 blocker questions were raised by agents from the SessionStart instruction alone.

What replaces it: the instruction stays (the SessionStart context, section 8, and "When stopped by human work" in skill ukagai-explain, with the `type: blocker` explanation and its GUI / TUI rendering), and progress checkpoints surface a session that stopped in prose anyway.

Now: Claude `Stop` is observe-only and **async** (like `SubagentStop`): it posts the event (with `escaped_question` when the message ends with ？ / ?) and never prints anything. The Codex `Stop` hook still registers a prose question that ends with ？ / ? (`stop_hook_active` still stops a second continuation). The section number is kept so references to section 13 stay valid.

## 13. Alias table (English name ↔ Japanese alias)

English is canonical and preferred; the Japanese alias is accepted anywhere the English is. They can be mixed in one file. The constants are exported from `src/hook/explain.ts` (the GUI keeps the same content as constants in `public/app.js`).

| Kind | English (canonical) | Japanese alias |
|---|---|---|
| Section | Why this decision is needed now | なぜ今この判断が要るか |
| Section | Options | 選択肢 |
| Section | Recommendation | 推奨 |
| Section | Diagram | 図 |
| Section | What I checked | 確かめたこと |
| Section | What only you know | あなたにしか分からないこと |
| Section | Assumptions | 前提 |
| Section | Counterargument | 反論 |
| Section | Affected | 影響を受けるもの |
| Section | Terms | 用語 |
| Section | Related diff | 関係する差分 |
| Section (quiz) | Why this question now | なぜ今この質問か |
| Section (quiz) | Premise | 前提 |
| Section (quiz) | How to answer | 答え方 |
| Section (blocker) | Why I stopped | なぜ止まったか |
| Section (blocker) | What you need to do | 人にしてほしいこと |
| Section (plan) | Scope and reversibility | 影響範囲と可逆性 |
| Table column | `/happens\|outcome/i`, e.g. "What happens if chosen" | 起きること, e.g. 「選ぶと起きること」 |
| Table column | `/risk/i`, e.g. "Risks and how to undo" | リスク, e.g. 「リスクと戻し方」 |
| Undo words (risk cells) | `UNDO_WORDS` and `UNDO_BAD_WORDS` (section 3.3 item 6) | 戻せ / 戻す / 元に戻 / 消せ / やり直 / 再実行 / 再作成 / 復元 / 戻せない / 元に戻らない / 復元できない |
| "None of these" type | Missing option / Wrong premise / Need more evidence / Ask me later | 選択肢が足りない / 前提が違う / 証拠が足りない / あとで聞いて |
| Blocker label | Done. Continue | 対応した。続けて |
| Blocker label | Skip this step and continue | この手順は飛ばして続けて |
| Blocker label | Stop here | ここで中断 |
| Label suffix | `(Recommended)` | `(推奨)` |
| Recommendation condition | if / when / unless / otherwise / in case | なら / 場合 / とき / であれば / 際は / 際に |

GUI and TUI show the section headings as written in the file (they are not translated). Only the UI's own text follows the display language.

## 14. The "None of these" answer

After the options the GUI / TUI offers "None of these…" (ja 「どれでもない…」). The human picks one of four types and may add one line of text. The answer reaches the agent as a free-text answer in this exact form (English, whatever the display language):

```
None of these — <type>: <text>
```

`<type>` is one of `Missing option` / `Wrong premise` / `Need more evidence` / `Ask me later`; `<text>` may be empty (then `None of these — <type>`). The hook does not check it. The skill tells the agent to act on the type: add the missing option (read `<text>`) and ask again; fix the premise and ask again; add the missing evidence to "What I checked" and ask again; do not ask now and proceed with work that does not depend on the answer.

## 15. The "Cannot answer" answer

Next to "None of these…" the GUI / TUI offers "Can't answer this…" (ja 「返答不可…」, key `x`), sent at once. It means the explanation could not be read, not that the options are wrong. The answer reaches the agent as a free-text answer in this exact form (English, whatever the display language):

```
Cannot answer — <reason>: <detail>
```

| `<reason>` | `<detail>` |
|---|---|
| `Undefined terms` | the words the human did not know, comma-separated (at least one) |
| `Unclear` | one line of free text; may be empty (then `Cannot answer — Unclear`) |
| `Too much at once` | one line of free text; may be empty |

`parseCannotAnswer` (`src/contract.ts`) reads it; an unknown reason is not a Cannot answer.

**Memo.** When the server stores such an answer it keeps one memo per session (a later one overwrites): `{question, reason, terms, body_hash, at}`, where `body_hash` is the SHA-256 of the answered explanation without its front matter (`bodyHash`). The hook reads it with `GET /api/sessions/:id/pending-rewrite` before it checks the next AskUserQuestion explanation (a missing explanation skips it; an unreachable server or a bad body means no memo, so the hook stays fail-open). The memo is held in server memory (lost on restart, like `pending-mode-switch`).

**Enforcement.** With a memo, the hook denies the explanation (the sentences are added to the usual deny reason) when:

1. its body hash equals `body_hash` (code `coined_term`): "the human could not answer the previous explanation; this one is identical. Rewrite it";
2. `Undefined terms`: any memo term appears (whole word, case-insensitive) in the title or the body outside code fences and Terms does not define it with a definition that says something (see section 3.8; option labels, the first column of the Options tables, `question` and `recommended` are exempt) — code `coined_term`, "the human said they could not understand: <terms>. Replace each with plain words or define it under Terms";
3. `Unclear`: the Recommendation is over 200 characters or 3 sentences, half of the usual limits (code `recommend_long`): "keep the Recommendation to 3 sentences";
4. `Too much at once`: the explanation's question equals the memo's question (whitespace, punctuation and case ignored) (code `multi`): "split it: ask the first decision only".

The loop guard of section 5 does **not** apply while the session has a memo: a second try for the same question within the deny-link window is denied again if it still fails (including the plain `coined_term` check), because the human has just said they could not read it and must not receive an unexplained call. Without a memo the guard applies as usual (the GUI red underline and Cannot answer catch what it lets through).

**Lifetime.** The memo is consumed (`POST /api/sessions/:id/pending-rewrite/consume`) when the next AskUserQuestion decision of the session is registered after the hook's checks. `a.cannot_answer` of `GET /api/metrics` counts decisions answered this way.

## Known limitations

- The `missing` codes of a deny remain in the `denied_explain` Decision (`missing?: string[]`). A multi-question deny is `["multi"]`.
- A multi-question call in plan mode is not denied; as before it appears in the GUI with the raw question text and options.
- A `question` that spans several lines cannot match exactly as a one-line front matter scalar, so it relies on recency.
- Recency can also pick up a file meant for another question (when exactly one exists within 10 minutes it is attached with `match: recency`).
- Heading matching prefers an exact match, but without one it becomes a partial match. "Diagram" is a partial match, so it can hit an earlier heading such as "Diagram notes" and hide the real "Diagram" section.
- The `after_deny` of ExitPlanMode has no time window (it holds whenever the session has a denied_explain) and can drift from the server's `first_denied_at` (120-second window).

## 16. Checkpoint instruction (`hook --checkpoint`)

Not part of the explanation flow: a second `PreToolUse` group (matcher `Bash|Edit|Write|MultiEdit|NotebookEdit|Agent|Task|TodoWrite`, `timeout: 3`, sync, no statusMessage; omitted with `install --observe`). The hook reads stdin, calls `GET /api/sessions/:id/instruction` once (700 ms timeout) and exits 0 in every case. No explanation logic, no observe POST, nothing logged on 404.

| Server reply | Hook output |
|---|---|
| 404, closed port, timeout, bad body | nothing |
| `instruct` | `{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"[ukagai] The human read your progress recap and says: <text>\nFollow this before continuing; do not ask for confirmation of this message."}}` — the tool runs |
| `stop` | `permissionDecision: "deny"`, reason `[ukagai] The human read your progress recap and asked you to stop. Do not run more tools: write a short status (done / in progress / next) and end your turn.` plus `\nThe human adds: <text>` when the human wrote one |

The server consumes the instruction on the GET, so it is delivered once. Codex is unchanged. `doctor` lists the group as `hook PreToolUse (checkpoint)`.
