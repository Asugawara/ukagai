# Plan mode, screenshots and HTML

## Explanation block in the plan file

Append one block per question, then call AskUserQuestion with the same question. The block is checked like an explanation file; the hook strips it from the plan at ExitPlanMode.

```
<!-- ukagai-explain -->
---
ukagai: 1
question: <the AskUserQuestion question verbatim>
title: ...
recommended: ...
reversibility: ...
scope: ...
---
## Why this decision is needed now
... (the normal explanation: same sections, same rules)
<!-- /ukagai-explain -->
```

## Plan sections

In this order. Only "Scope and reversibility" is hook-checked; the rest makes the plan readable.

1. `# Title`: one line saying what the plan does.
2. `## Scope and reversibility`: first 2 lines `Reversibility: …` and `Scope: …`.
3. `## Steps`: an ordered list; each item a **bold title**, a badge and the `path` it touches; nest task lists or `<details>`.
4. `## Risks`: one callout per risk (`CAUTION` irreversible, `WARNING` costly).
5. `## Verification`: a task list of the commands / checks.

## Screenshots and mockups

Show a UI decision, do not describe it. `<scratchpad_dir>/ukagai` is the folder the SessionStart context names; it stays writable in plan mode. When a plan hinges on a visual choice (UI variants, layouts), build the candidates there and ask with AskUserQuestion before ExitPlanMode; never schedule "make the mockups" as a step after approval. Reference a file only once it exists.

```bash
mkdir -p <scratchpad_dir>/ukagai/shots
agent-browser open http://localhost:3000/settings
agent-browser screenshot <scratchpad_dir>/ukagai/shots/settings-dark.png
agent-browser close
```

From an explanation file use a relative path; from a plan file the absolute path (a relative path in a plan resolves against `~/.claude/plans/`, then the session's `<scratchpad>/ukagai`). Write alt text the TUI reader can use on its own:

```markdown
![Settings page, dark theme: the Display group is selected](shots/settings-dark.png)
![Settings page, dark theme: the Display group is selected](/private/tmp/claude-…/scratchpad/ukagai/shots/settings-dark.png)
```

Limits: only `.png` / `.jpg` / `.jpeg` / `.gif` / `.webp` up to 10 MB, under the document's folder, `~/.claude/plans/` or the scratchpad; external `http(s)` images are never shown.

A comparison page you built (HTML with screenshots, up to 2 MB, in the document's folder or the scratchpad) goes the same way: `![Header variants A-D](compare.html)`. The GUI shows it in a sandboxed frame (no scripts; relative `src` / `url()` work, so keep screenshots next to it) with a full-screen button; the TUI shows one line saying it is in the GUI.
