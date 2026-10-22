# Verification 14: inline comments on a question and on plans, through a real Claude Code and the GUI in a browser

- Date: 2026-10-22
- Build: branch `feat/inline-comments` (`efd7ccf`), `npm run build` before the run. No code was changed.
- Versions: Claude Code 2.1.308 (sonnet, `--effort low`), node v24.11.0, Darwin 24.6.0, herdr
- Setup: dev server `node dist/cli.js serve --port 4828 --data-dir <tmp>/e2e-data`; hooks installed with `node dist/cli.js install --settings verification/e2e-settings.json --server http://127.0.0.1:4828 --data-dir <tmp>/e2e-data --no-skill`; probe agent `claude --setting-sources project,local --settings verification/e2e-settings.json --model sonnet --effort low` (herdr agent `probe2`, auto mode; plan mode entered with `/plan`). The GUI was driven with agent-browser (Claude in Chrome was not connected), 1440x900, English / light for the screenshots.
- Primary sources: the decision JSON in `<tmp>/e2e-data/decisions.jsonl`, and the probe's transcript (`~/.claude/projects/.../985a589b-….jsonl`).

## Results

| # | Check | Result |
|---|---|---|
| 1 | Question with a text, an element and a region comment | ✓ |
| 2 | Read of the marked copy | ✓ (no prompt; the probe ran in auto mode, so this is weak evidence) |
| 3 | Plan instruct with 2 comments and an overall message | ✓ |
| 4 | Approve once (discard confirm), then Reject with a reason | ✓ |
| 5 | Reload keeps and re-highlights; orphan after the plan changes | Reload ✓; orphan not reproduced (see below) |
| 6 | Full-screen HTML page, zoom, pick an element | ✗ no popover appeared |
| 7 | Esc closes a popover without leaving the plan | ✓ |

## Observations

### 1 Question
Text selected in the explanation (drag), "Comment on an element" in the frame bar then a click on Save, a drag on the image; option A clicked twice (confirm). The tool result the model received (from the transcript, verbatim; paths shortened to `…`):

```text
The user answered: "どちらの案で進めますか？"="案 A (推奨)

The human left 3 comments:
1. explanation …/scratchpad/ukagai/exp.md, "なぜ今この判断が要るか": "これは画像と HTML ページの埋め込み表示を確認するための試験的な質問で"
   → 文1: ここの説明をもっと短くして
2. page …/scratchpad/ukagai/x.html, element button:nth-of-type(1) "Save"
   → 要素: Save を右寄せにして
3. image …/scratchpad/ukagai/x.png, region x=20 y=18 w=150 h=65 (marked copy: …/scratchpad/ukagai/marks/65b689b465c409e2.png)
   → 領域: この赤をもう少し薄く". Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.
```

The option, a blank line, then the block, as specified. The new lines arrive intact inside the quoted answer value.

### 2 Marked copy
The probe's Read of the `marked copy:` path went through at once, no permission prompt. It described the image with the red block outlined in a darker red rectangle.

### 3 Plan instruct
Two text comments (a step, a risk sentence) plus the overall message. The model received, as PreToolUse hook additional context:

```text
[ukagai] The human has not approved the plan yet and asks you to do this first: 先にコメントを反映して、計画を直してください

The human left 2 comments:
1. plan /Users/a14628/.claude/plans/you-are-in-plan-tidy-thompson.md, "Make the export job retry with a capped backoff > Steps > Cap the backoff at 30 seconds": "Cap the backoff at 30 seconds"
   → 60 秒にしたい。上流の SLA が 45 秒なので
2. plan /Users/a14628/.claude/plans/you-are-in-plan-tidy-thompson.md, "Make the export job retry with a capped backoff > Risks": "A failed export may be retried; the job must stay safe to run twice"
   → 二重実行の対策も書いて
You are still in plan mode: do it (research, subagents and reviews are fine; do not edit project files), update the plan file, then call ExitPlanMode again.
```

### 4 Approve and Reject
With one comment waiting, the first press on "Approve" showed "1 comment will be discarded — press again to approve" and sent nothing. Reject with the reason `却下: 上限の根拠が弱い` gave:

```text
[ukagai] The human rejected the plan and wrote: 却下: 上限の根拠が弱い

The human left 1 comment:
1. plan /Users/a14628/.claude/plans/you-are-in-plan-tidy-thompson.md, "Make the export job retry with a capped backoff > Steps Changed > Cap the backoff at 60 seconds": "Cap the backoff at 60 seconds"
   → やっぱり 90 秒で
```

Cosmetic: the section path reads `Steps Changed` because the "Changed" badge of a revised section leaks into the heading text.

### 5 Reload and re-anchor
A comment survived a reload and was highlighted again (badge, yellow highlight, list entry). Orphans: a pending plan decision holds a snapshot of the plan, so editing the plan file under it changed nothing on screen (the file was edited in place and restored; the probe was blocked in the hook and could not do it). Switching to the v1 tab, whose text lacks the sentence, removed the highlight but the row was not marked "Not found in the current text" (class `cmt-row`, no `orphan`). The orphan state was therefore not seen.

### 6 Full screen and zoom
Full screen opens, `+` zooms (to 195%), "Comment on an element" turns blue. Clicks on Save (hover first, several attempts, also at 100%) opened no popover and added no comment. The same flow in the inline frame worked (popover under the Save button). Possibly an automation artefact of the synthetic mouse, but it matches the user's report that picking sometimes does not show the comment UI; it needs a look by hand.

### 7 Esc
With a popover open on a plan, Esc closed it; the plan screen stayed.

## Other observations (cosmetic)
- The popover's Cancel button wraps into three lines ("キャ/ンセ/ル") in Japanese; the English one fits.
- Clicking the highlighted text did not open its popover once; clicking the number badge did.
- Picking showed the hint "Click an element (Esc to cancel)" but no outline on hover in the screenshots.
- A person using the same GUI answered the first question while the run was unattended (answer without comments) and switched the display language back to Japanese once; those runs were repeated.
