---
name: ukagai-explain
description: "Write an explanation file before asking a human to decide. Use it right before calling AskUserQuestion or ExitPlanMode, when a human decides: a design fork, a hard-to-undo operation, naming. The file holds a recommendation and a table of options, written as Markdown."
---

# ukagai-explain

Write the explanation a human needs to decide as Markdown, then ask the same question with AskUserQuestion. The SessionStart context gives the format, location and language; this file adds what the hook checks. A question is denied once, so the first file must pass.

Reference files are under this skill's directory in `reference/`. Claude Code: read them from the directory the SessionStart context names (`<scratchpad>/ukagai/skill/reference/`); the `reference/` next to this file is outside the project and asks for a permission. Codex: read `reference/<name>.md` relative to this file; ask with `request_user_input` in Plan mode, else as the last sentence of the reply (the context says which).

## Before you ask

- Verify, narrow to 2-4 options, recommend exactly one (first, label ending `(Recommended)`).
- If you cannot say in one sentence why only a human can decide, do not ask: proceed and report. A `reversible` + `file` decision is never asked.
- One AskUserQuestion call = one question; several go in order, one file each.
- No internal identifiers (plan codes, phase / step numbers, worker names): use plain words, or define under Terms (12+ characters).
- Japanese setting: prose in Japanese; H2 headings and column names stay English.

## Skeleton

````markdown
---
ukagai: 1
question: <the AskUserQuestion question, verbatim>
title: <the decision for the human, one sentence>
recommended: <label of the recommended option>
reversibility: reversible | costly | irreversible
scope: file | repo | machine | external
---
## Why this decision is needed now
## What only you know
## Options
| Option | What happens if chosen | Risks and how to undo |
|---|---|---|
## Recommendation
## Assumptions
## What I checked
[^1]: evidence
````

Optional H2s: Counterargument, Affected, Terms, Diagram, Related diff; no others.

## What the hook checks

| Code | Limit |
|---|---|
| `front_matter` `question` `recommended` `table` | `ukagai: 1`; `question` equals the call's; `recommended` is a label; table: columns named like happens / risk, one row per option, no empty cell |
| `recommend_long` `recommend_name` `recommend_cond` | 5 sentences / 400 characters (aim for 3 sentences); first sentence names the option (never "the first one"); needs "if …, B" / when / unless |
| `cell_long` `undo` | 160 characters per cell (aim for 2 sentences); each risk cell says how to undo, or that it cannot be |
| `why_long` `assumptions_long` `against_weak` | 600 characters; at most 3; Counterargument must not repeat the Recommendation |
| `checked` `footnote` `coined_term` | What I checked unless `reversible` + `file`; each `[^n]` defined; `W-T2` / `Phase 2` need a Terms entry |
| `diagram` `diagram_trivial` `language` `multi` `todo` `impact` `quiz_*` | see Diagram rule and the reference |

Read [reference/checks.md](reference/checks.md) (under this skill's directory) when a deny code is unclear or before writing Japanese headings.

## Sections

- Why: 2-3 sentences; the first says what is decided, where and when.
- What only you know: 1-3 bullets, each a thing to decide, never what you could have checked.
- Assumptions: unverified premises that would change the pick; no implementation notes.
- Affected: concrete names, up to 6. Terms: `- **term** — definition`.
- No pros / cons columns; do not paraphrase `question`; no GUI URL or API.
- `scope`: machine = outside the repo on this machine; external = other people or systems.

Read [reference/writing.md](reference/writing.md) (under this skill's directory) when a headline, Assumptions or Terms entry was denied. Read [reference/example.md](reference/example.md) (under this skill's directory) after a deny or before your first long explanation.

## Diagram rule

Draw a diagram only when it shows something the Options table cannot: a sequence of 3 or more steps between 2 or more actors, a state machine with 4 or more states, or a data flow between 3 or more components (a flowchart needs 5 or more nodes). Never draw the options themselves as nodes (a branch into A / B / C) and never restate the table; at most one diagram; when in doubt, none. When the decision is not reversible or the scope is machine / external, a diagram that meets this rule is required; if none does, write none and say why in one line under Options ("No diagram: <why>").

`diagram_trivial`: a flowchart with 4 or fewer nodes, or half its labels equal to option labels. `No diagram: <why, 8+ characters>` satisfies `diagram`.

## Emphasis

`**bold**` only for the recommended option's name and a fact that cannot be undone: one per sentence, 8 in the whole explanation. `> [!WARNING]` costly to undo, `> [!CAUTION]` cannot be undone.

## Rich Markdown (ukagai dialect)

Raw HTML other than details / summary / br / sub / sup never renders.

| Construct | Syntax | Use it for |
|---|---|---|
| Callout | `> [!CAUTION] Title` then `> body` (NOTE, TIP, IMPORTANT, WARNING, CAUTION) | CAUTION irreversible, WARNING costly, IMPORTANT a premise, TIP the easy path |
| Badge | `[done]` `[todo]` `[doing]` `[blocked]` `[risk]` `[skip]` (exactly these) | step or row status |
| Highlight | `==the one phrase==` | the phrase not to miss |
| Columns | `::: columns` … `---` … `:::` | before / after (Options stays a table) |
| Image / HTML | `![alt](a.png)`, `![alt](page.html)` | what the reader must see; only under the document's folder, the scratchpad or `~/.claude/plans/` |

Never open a file or a URL for the human (`open`, `xdg-open`, a browser): put it in the explanation — images `![alt](x.png)`, HTML pages `![alt](x.html)` (the GUI renders them in a sandboxed frame); files next to the explanation file or under the session's scratchpad. A Bash `open` / `xdg-open` on such a file is denied by the hook.

## In plan mode

Put an AskUserQuestion explanation in the plan file between `<!-- ukagai-explain -->` and `<!-- /ukagai-explain -->` (same checks); the hook strips the blocks at ExitPlanMode. The plan body needs `## Scope and reversibility` whose first 2 lines are `Reversibility: …` and `Scope: …`. Mockups go in `<scratchpad_dir>/ukagai/`, referenced by absolute path from a plan; ask a visual choice before ExitPlanMode, never after approval. Read [reference/plan-and-images.md](reference/plan-and-images.md) (under this skill's directory) in plan mode or before embedding an image / HTML page.

## When stopped by human work (blocker)

When only a human can unblock you (login, permission, key), never end in prose: write the file with `type: blocker` and `recommended: Done. Continue`, then ask with the 3 labels from the context (`Done. Continue` / `Skip this step and continue` / `Stop here`). Sections: Why I stopped, What you need to do (with a code block of commands), Options; no Recommendation or Diagram. On Done, retry the same work. Read [reference/blocker-and-quiz.md](reference/blocker-and-quiz.md) (under this skill's directory) to write a blocker or when a quiz file exists.

## Answers that are not a choice

`None of these — <type>: <text>`:

- `Missing option`: add the option in `<text>`, ask again with a new file.
- `Wrong premise`: fix the premise, ask again.
- `Need more evidence`: add to What I checked, ask again.
- `Ask me later`: do not ask now; continue with independent work.

`Cannot answer — <reason>: <detail>` is not a choice: proceed on no option; ask again with a new file.

- `Undefined terms`: replace the listed words with plain words, or define them under Terms.
- `Unclear`: a 1-sentence Recommendation and 2-3 options.
- `Too much at once`: split; ask only the first decision.
