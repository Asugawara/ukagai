# Verification 11: progress-check replies and plan instructions as messages (the ukagai mod), on a real Claude Code

- Date: 2026-10-20
- Build: branch `feat/mod-checkpoint-delivery` (`13eac97`), `npm run build`
- Versions: Claude Code 2.1.304 (sonnet), node v24.11.0, herdr, Darwin 24.6.0
- `<tmp>` is a scratch directory and `<data-dir>` is `<tmp>/D`. A dev server ran on port 4921 (`node dist/cli.js serve --port 4921 --data-dir <tmp>/D`). Claude Code ran with `--setting-sources project,local --settings <tmp>/settings.json` (and `--plugin-dir <tmp>/mod-dev` when the mod was on), so the user's own hooks and plugins did not fire. The working directory was `<tmp>/cwd`. No real `~/.claude/settings.json`, `.claude/settings.json` or `~/.ukagai` was written. No code was changed for this check.
- Progress checkpoints were made by appending an `away_summary` line to the session's transcript (as in verification 10, section 6). Replies were sent with `POST /api/decisions/:id/answer` and `POST /api/plans/:name/instruct`, the calls the GUI makes; items 1 (first run) and 2 also went through the GUI (agent-browser).

## Results

| # | Check | Result |
|---|---|---|
| 1 | Mod on, idle: a checkpoint reply arrives as `[ukagai] (ref …) … Reply to your progress recap: …` plugin message, the agent continues, `delivered_via: "message"`, nothing typed by herdr, newline kept | ✓ (see finding 1 for the doubled `[ukagai]`) |
| 2 | Mod on, plan instruction without a decision: plugin message, `POST /api/plans/:name/instruct` → `{"delivered_via":"message"}`, toast "Sent to the agent as a message" (ja "エージェントにメッセージとして送りました") | ✓ |
| 3 | No mod: the same reply is typed into the pane by herdr (`delivered_via: "terminal"`, a human line in the transcript) | ✓ |
| 4 | The mod disappears after the reply entered the inbox: the reply goes back to the queue after `MOD_GONE_MS` and is typed once | ✓ |
| 5 | Two replies joined into one message (a checkpoint reply and a plan instruction; two plan instructions) | ✓ for those; two checkpoint replies: not verified |
| 6 | GUI toasts for 1 and 2, English and Japanese, screenshots | ✓ |

## Setup

1. `npm run build`.
2. `node dist/cli.js install --settings <tmp>/settings.json --data-dir <tmp>/D --server http://127.0.0.1:4921 --no-autostart --claude`.
3. `<tmp>/mod-dev/` is a mod-only plugin as in verification 10 (`plugin.json` names `"hooks": "./hooks/claude.json"`, `hooks/mod/{core,register}.ts` copied from the branch, `config.json` pointing at port 4921). `claude plugin validate` passes.
4. **herdr must know the session.** `HerdrTerminal.find` matches `agent_session.value` of `herdr pane list` to the session id. With `--setting-sources project,local` the user's herdr `SessionStart` hook (`herdr-agent-state.sh session`) does not run, so the pane had no `agent_session` and the server logged `terminal_not_found` (the first run of item 3). The hook was added to `<tmp>/settings.json`; the runs below (items 1 again, 2, 3, 4, 5) used it. The first run of items 1 and 2 (before the hook) delivered by message too, but they could not show that herdr was kept from typing, because no terminal was found anyway, so item 1 was repeated.
5. Each run started in a pane made with `herdr pane split --current --direction right --no-focus` (one pane at a time, closed at the end); the trust prompt of the scratch directory was accepted once (it is written to Claude Code's own project state, not to a settings file).

## 1. Mod on, idle agent: a checkpoint reply

Session `8dc24be5` (sonnet, plan mode, mod loaded, 37 polls after 35 s). `away_summary` line appended → checkpoint `431405a3`. Answer `{"kind":"instruct","text":"First line: reply ONE-OK.\nSecond line: then say TWO-OK."}`:

- Checkpoint: `status: "answered"`, `response.delivered_via: "message"`, `decided_at` 09:44:16.627, `delivered_at` 09:44:17.831 (about 1 s, one mod poll).
- Transcript lines 53 and 55: line 53 is `queue-operation enqueue` of `[ukagai] (ref e97a0bed) [ukagai] Reply to your progress recap: First line: reply ONE-OK.\nSecond line: then say TWO-OK.`; line 55 is `type: user`, `origin: {"kind":"plugin","name":"ukagai-mod-dev"}` with "The ukagai-mod-dev plugin sent a message: …". No `origin.kind: "human"` line holds the text. The newline is kept (`\n` in both lines). The agent answered "ONE-OK.\nTWO-OK."
- `serve.log` has no `checkpoint_delivered` line for this decision (only the terminal path writes it); the pane showed no typed prompt.
- First run (session `70848aa3`, answered in the GUI with one line): `delivered_via: "message"`, `delivered_at` 09:38:20.192, transcript line 48 the plugin message with ref `228907c6`; the agent wrote `world.txt` and answered DONE. The GUI's reply box for a checkpoint is a single-line input, so a newline cannot be typed there; the API check above covers it.
- The checkpoint's toast is the generic "Reply sent" (`shots/item1-toast.png`); only the plan instruction toast has a message-specific text (finding 2).

## 2. Mod on, plan instruction (no decision)

Session `8dc24be5` (plan mode): the plan file `write-a-three-line-plan-purring-hamster.md` was written, no ExitPlanMode.

- `POST /api/plans/write-a-three-line-plan-purring-hamster.md/instruct` with a two-line text → `{"delivered_via":"message"}`; `serve.log`: `plan_instructed … "via":"message"` (09:44:35.687).
- Transcript line 66: `origin {"kind":"plugin","name":"ukagai-mod-dev"}`, `[ukagai] (ref c79e0112) [ukagai] About the plan you are writing: Plan note A.\nLine two of note A. Reply NOTE-A.`. The agent continued.
- GUI (Plans drawer → plan → Instruct → Send): toast "Sent to the agent as a message" (en) and "エージェントにメッセージとして送りました" (ja); `serve.log` `plan_instructed … via message` at 09:46:15 and 09:46:47.

## 3. No mod

Session `dfff081d` (`claude` without `--plugin-dir`, herdr hook on). `away_summary` → checkpoint `159051ce`, answered with an instruction:

- `response.delivered_at` 09:42:57.406, `delivered_via: "terminal"`; `serve.log` `checkpoint_delivered … "via":"terminal","terminal":"herdr:wY:p3"`.
- Transcript line 47: `origin {"kind":"human"}`, `[ukagai] Reply to your progress recap: Write typed.txt containing the word typed, then say TYPED-DONE.`; the agent wrote `typed.txt`.
- Without the herdr hook (first run, session `2859cb7c`) the server logged `terminal_not_found` and the reply stayed queued for the hook (setup step 4).

## 4. The mod disappears after the reply is in the inbox

Session `8dc24be5` with the mod. A pending checkpoint `85f7a8bf` existed; then `config.json` of the mod was changed to `http://127.0.0.1:4999` (nothing listens), `plugin.json`'s version bumped, and `/reload-plugins` sent (Claude Code does not reload a module whose plugin settings are unchanged: "skipping reload, plugin-affecting settings unchanged"). The last poll to the dev server was 09:48:34.7; the mod then polled port 4999 only.

- 09:48:37.419 the reply (`Orphan reply line one.\nOrphan line two: say ORPHAN-OK.`) was answered within the 15 s freshness window, so it went to the inbox; nothing delivered for the next 3 s and no typing.
- `delivered_at` 09:50:35.579 (118 s after the answer, about `MOD_GONE_MS` after the last poll), `delivered_via: "terminal"`, `serve.log` `checkpoint_delivered … "via":"terminal"`.
- Transcript line 145 (only one line holds the text): `origin {"kind":"human"}`, `[ukagai] Reply to your progress recap: Orphan reply line one. Orphan line two: say ORPHAN-OK.` The newline became a space on the way (the terminal path has always typed one line). No plugin message was sent: delivered once.
- An earlier attempt changed only `config.json`: the module was not reloaded and kept polling port 4921, so the reply was delivered by message in 1.5 s (`delivered_at` 09:47:48.138), as expected for a live mod.

## 5. Joining

The mod polls every 1 s, so the window is the time between two requests that are sent together (`&` in a shell):

- A checkpoint reply `a080019f` ("Reply text R1: say R1-OK.") and a plan instruction ("Plan text P1: say P1-OK.") sent at the same time: transcript line 74, one plugin message: `[ukagai] (ref 45e1ec68) [ukagai] Reply to your progress recap: Reply text R1: say R1-OK.\n[ukagai] About the plan you are writing: Plan text P1: say P1-OK.`; the checkpoint got `delivered_via: "message"`, `delivered_at` 09:45:21.928; the plan instruction answered `{"delivered_via":"message"}`.
- Two plan instructions at the same time: transcript line 84, one message with ref `e7821659`: `…About the plan you are writing: Plan text P2: say P2-OK.\n[ukagai] About the plan you are writing: Plan text P3: say P3-OK.`; both requests answered `{"delivered_via":"message"}`.
- Two checkpoint replies: not verified. A new `away_summary` supersedes the pending card and needs agent progress; the watcher looks every 5 s, the mod every 1 s, so the first card is claimed before a second one can exist. The unit tests (`test/serve/inbox.test.ts`, "two joined checkpoint replies are both marked delivered by one ack") cover it.

## Findings

1. **The message carries the tag twice (cosmetic).** The prefix constants `REPLY_PREFIX` (`[ukagai] Reply to your progress recap:`) and `PLAN_INSTRUCT_PREFIX` (`[ukagai] About the plan you are writing:`) already start with `[ukagai]`, and `instructionParts` puts `[ukagai] (ref …)` in front, so the agent sees `[ukagai] (ref e97a0bed) [ukagai] Reply to your progress recap: …`. The plan's wording is `[ukagai] (ref …) Reply to your progress recap: …`. Delivery and the closing rule (the ref) are unaffected.
2. **The checkpoint toast does not say "message" (info).** After a checkpoint answer the GUI shows the generic "Reply sent"; the new text applies to plan instructions only. The checkpoint card's `delivered_via` is shown nowhere before it is replaced by the next card.
3. **With `--setting-sources project,local`, herdr does not know the session (dev set-up, not a product bug).** `terminal_not_found` until the herdr `SessionStart` hook is added to the dev settings (setup step 4).
4. **A reply typed by herdr is one line (info).** The newline of a multi-line reply is replaced by a space when the reply is typed (items 3 and 4); the message path keeps it.

## Not verified

- Two checkpoint replies joined into one message (item 5).
- The GUI's checkpoint card and the reply box were used once; multi-line text in it cannot be typed (single-line input).
- The mod disappearing and the reply returning to the hook queue instead of herdr (the agent was idle, so herdr was used).
- No comparison with a `main` build; no recording (ffmpeg is not installed). Screenshots are in the scratchpad, not in the repository.
