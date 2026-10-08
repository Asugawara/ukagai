# ukagai Markdown: the dialect the agent writes and both UIs render

Status: contract between the hook (what the agent is told), the GUI (`public/`) and the TUI (`src/tui/`). Every construct below has a rich rendering in the GUI and a plain-text fallback in the TUI, so one document serves both. Explanation files (`docs/spec/explain.md`) and plan files (`~/.claude/plans/*.md`, incl. the `<!-- ukagai-explain -->` block) are written in this dialect. Nothing here is required by the hook unless `explain.md` says so: the agent picks the constructs that make the decision easier to read.

## 1. Base

GitHub-flavoured Markdown as parsed by `marked` in the GUI and by `src/tui/markdown.ts` in the TUI: headings (`##`, `###`; `#` is reserved for the title), paragraphs, emphasis, inline code, fenced code with a language, links, ordered and unordered lists, nested lists, GFM tables with alignment, horizontal rules, blockquotes, footnotes (`[^1]` with `[^1]: …` definitions anywhere in the body).

Raw HTML is **not** part of the dialect: the GUI sanitizer drops every tag except the ones listed in §2.3, the TUI prints tags as text. Scripts, styles, iframes, forms and event attributes never render.

## 2. Constructs

Each entry: syntax → GUI rendering → TUI fallback → when to use it.

### 2.1 Callouts (five kinds, optional title)

```markdown
> [!NOTE] Optional title
> Body in Markdown.
```

Kinds: `NOTE` (accent), `TIP` (green), `IMPORTANT` (purple), `WARNING` (yellow), `CAUTION` (red). The first line may carry a title after the marker; without one the kind's word is the label (localised: GUI / TUI display language).
GUI: coloured left border, label line, body. TUI: `[!CAUTION] Title` in the kind's colour, body indented by two spaces.
Use: `CAUTION` for anything that cannot be undone or touches other people / external systems (required by `explain.md` for irreversible effects), `WARNING` for costly-to-undo, `IMPORTANT` for a premise the reader must accept, `TIP` for the easy path, `NOTE` for context.

### 2.2 Task lists

```markdown
- [x] done item
- [ ] open item
```

GUI: read-only checkboxes (☑ / ☐ glyphs, done items dimmed). TUI: `☑` / `☐`. Use for acceptance criteria, pre-flight checks and the progress of a plan; not for options (options are a table).

### 2.3 Folding (`<details>`)

```markdown
<details>
<summary>Full log (120 lines)</summary>

```text
…
```

</details>
```

The only raw HTML the dialect allows: `<details>`, `<summary>` (with the optional `open` attribute), `<br>`, `<sub>` and `<sup>`; `<kbd>` is dropped like every other tag (project rule: hints are plain text). Everything inside `<details>` is Markdown (leave a blank line after `<summary>`). An unclosed `<details>` ends at the next `## ` heading, so it never swallows the sections after it.
GUI: native disclosure, closed by default (`open` opens it); a `<details>` inside the plan outline folds with its section. TUI: a dim header `▸ summary (N lines)` followed by the body (the TUI does not fold details; long bodies fold with the section).
Use: logs, long evidence, command output, anything the reader should be able to skip. The GUI also folds code blocks longer than 9 lines on its own, so a short log needs no `<details>`.

### 2.4 Diagrams (Mermaid, any type)

```markdown
```mermaid
sequenceDiagram
  …
```
```

GUI: rendered by Mermaid (flowchart, sequenceDiagram, stateDiagram-v2, classDiagram, erDiagram, gantt, pie, mindmap, timeline, gitGraph, journey, quadrantChart, xychart-beta, block-beta); a render error shows the error text and the source. TUI: ASCII for flowchart, stateDiagram-v2, sequenceDiagram, classDiagram, erDiagram and xychart (via `beautiful-mermaid`); other types show a boxed `diagram: <type>` line followed by the source as a code block.
Use: flowchart for structure and data flow, sequenceDiagram for who-calls-whom, stateDiagram for lifecycles, gantt / timeline for rollout order, pie for a split, quadrantChart for risk × effort. `explain.md` requires one diagram for anything not reversible or scope machine / external.

### 2.5 Code with a title

```markdown
```ts title="src/serve/store.ts"
…
```
```

Also `diff` as the language for before / after (GUI highlights `+` / `-` lines; TUI colours them green / red).
GUI: a filename tab above the block; `title` is text, never a link. TUI: the title as a dim line above the block.
Use: whenever the block is a file excerpt; `diff` for proposed changes.

### 2.6 Status badges

Inline tokens at the start of a list item or table cell (or right after its bold title, as in Steps): `[done]`, `[todo]`, `[doing]`, `[blocked]`, `[risk]`, `[skip]` (English, lowercase, exactly these six).
GUI: small coloured badge (done green, doing accent, blocked / risk red, todo grey, skip dim). TUI: the same words in the same colours. The badge is text in both, so a plain Markdown viewer still reads it.
Use: step progress, per-item status in a checklist or table.

### 2.7 Highlight

`==text==` → GUI `<mark>`; TUI inverse video. Use sparingly for the one phrase the reader must not miss; bold stays the default emphasis.

### 2.8 Columns

```markdown
::: columns
Left column Markdown.

---

Right column Markdown.
:::
```

Two or three columns split by `---` lines inside the container.
GUI: side by side at ≥ 900 px, stacked below. TUI: stacked, each column preceded by a dim rule.
Use: before / after, option A vs B when a table is too narrow for prose.

### 2.9 Steps

A `## Steps` (ja `## 手順`) section whose body is an ordered list, each item starting with a bold title, optionally followed by a badge and nested details:

```markdown
## Steps
1. **Add the schema** [done] — `src/contract.ts`
   - [x] zod type
   - [ ] docs
2. **Wire the route** [todo]
```

GUI: a vertical timeline (numbered dots, connecting line, badge beside the title, nested content indented). TUI: the ordered list as written. Use in plans; the hook does not require the section.

### 2.10 File references

Inline code that looks like a repository path with an optional line (`` `src/x.ts:12` ``, `` `public/app.js#L40-L60` ``).
GUI: rendered as a chip; clicking copies the path (the same copy affordance as the badge). TUI: inline code as today. Use for "where": one path per sentence, as the writing rules already say.

### 2.11 Tables

GFM tables with alignment markers. The explanation-file **Options** table keeps its contract (first column = option label; see `explain.md` §3.3) and the GUI turns it into cards. Other tables render as tables; a cell may hold a badge (§2.6), inline code, a short callout-free sentence. No nested lists in cells.

### 2.13 HTML pages

```markdown
![Header variants A-D](compare.html)
```

An image whose target ends in `.html` / `.htm` embeds the page. The file rules are those of 2.12 (same roots, ≤ 2 MB); the server adds a CSP sandbox and rewrites the page's relative URLs (`docs/spec/api.md`, `GET /api/files`). GUI: a block with a caption row (alt text, file name chip, a **Full screen** / **全画面** button) and a 480 px high `<iframe sandbox>` (empty `sandbox`: no script, no same-origin); the button opens the page in the shared overlay (Esc closes). TUI: one line `[HTML] alt — x.html (shown in the GUI)`. Agents never `open` such a file for the human (the hook denies it): they reference it here.

### 2.12 Images (screenshots)

```markdown
![Settings page, dark theme](shots/settings-dark.png)
```

The agent writes the file next to the document (a relative path, resolved against the explanation file's or the plan file's directory) or gives an absolute path. The server serves an image only when its real path (symlinks resolved) is under one of: `~/.claude/plans/`, a Claude Code scratchpad (`/private/tmp/claude-*/…/scratchpad/`, `$TMPDIR/claude-*/…/scratchpad/`), `<data-dir>/`, or the directory of the document being shown **when that document is a standalone explanation file** whose path the server already validated (under `<data-dir>/explain/`, a scratchpad's `ukagai/` or `~/.ukagai/explain/`). The directory of a plan file or of a plan-block explanation (`<file>.md#ukagai-explain`, allowed anywhere under `$HOME`) only resolves relative paths; the result must still lie under one of the fixed roots above. A plan approval without an explanation is resolved against the plans directory, and only when the server recognised its plan file (`plan_name`); only `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`; at most 10 MB; `Content-Type` from the extension, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-cache` (a screenshot re-taken at the same path is fresh), cookie auth like the rest of the GUI API (`GET /api/files?decision=<id>&path=<as written>`; `404` for anything else, never a directory listing). External `http(s)` images, `data:` and every other scheme stay dropped.
GUI: the image at column width (max 100% / 480 px tall), click for a full-size lightbox (Esc closes), alt text as caption; a missing file shows the alt text with a dim "image not found". TUI: `[image] alt — path (W×H when known)` in dim text; the TUI does not draw pixels.
Use: UI decisions (before / after screenshots taken with agent-browser into the document's folder), diagrams exported by tools, anything the reader must *see*. Keep alt text meaningful: the TUI reader only gets that.

## 3. Fallback summary

| Construct | GUI | TUI |
|---|---|---|
| Callout (5 kinds, title) | coloured box | coloured label + indented body |
| Task list | glyph checkboxes | `☑` / `☐` |
| `<details>` | native disclosure | `▸ summary (N lines)` + body |
| Mermaid, 6 ASCII-capable types | diagram | ASCII diagram |
| Mermaid, other types | diagram | `diagram: <type>` + source |
| Code `title=` | filename tab | dim title line |
| `diff` | +/- highlight | green / red lines |
| Badges | coloured chips | coloured words |
| `==mark==` | highlight | inverse |
| `::: columns` | side by side | stacked with rules |
| `## Steps` | timeline | ordered list |
| File refs | copy chip | inline code |
| Images | inline, lightbox | `[image] alt — path` |

## 4. What the hook tells the agent

- SessionStart / SubagentStart context (`explain.md` §8): one sentence that explanations and plans are written in this dialect (callouts, task lists, details, Mermaid, badges, columns, images), pointing at the skill section "Rich Markdown" for the palette. The Codex context carries the sentence without the skill pointer (no skill there; `codex-bridge.md`).
- Plan mode (`hook --plan-context`; two triggers, once per session): PreToolUse `EnterPlanMode` when the agent enters plan mode, and UserPromptSubmit with `permission_mode: "plan"` for plan mode the human entered (no tool call happens then). `additionalContext` with the plan-writing rules: the sections a plan should have (title, `## Scope and reversibility` with its two fixed lines, `## Steps`, `## Risks` as callouts, `## Verification` as a task list), and the one-line palette (callouts, task lists, details, Mermaid types, code titles, badges, columns). Output is context only (no `permissionDecision`); the text is in `explain.md` §6.1 and names the skill section and, when it exists next to the installed `dist/`, `docs/spec/markdown.md`. Injected only in plan mode, so it costs nothing elsewhere. Codex has no such tool.
- `ExitPlanMode` (PreToolUse): unchanged requirements (`validatePlan`); the dialect adds no new deny.
- The skill `ukagai-explain` (section "Rich Markdown (ukagai dialect)") carries the palette with examples and the "when to use" column, so a deny that says "read the skill" also teaches the dialect.

## 5. Not in the dialect (and why)

Raw HTML beyond §2.3 (XSS surface, no TUI rendering), `<kbd>` (project rule: hints are plain text), math (no need in engineering plans), custom inline directives (`:name[...]`) beyond the six badges (every new inline form must degrade to readable text).
