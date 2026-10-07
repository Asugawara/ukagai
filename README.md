# ukagai

Agents ask. Humans decide. One place for every coding agent's questions, with the context to answer them.

ukagai intercepts the decisions a coding agent asks a human for (Claude Code's `AskUserQuestion` and plan approval) with hooks, and collects them in a localhost GUI (or a terminal UI). Each decision comes with an explanation the agent wrote itself: why now, a recommendation, an options table, a Mermaid diagram and the related diff. No MCP is involved: it is hooks + a skill + a GUI.

## Requirements

- Node.js >= 22
- Claude Code

## Install

```sh
git clone <this repo> && cd ukagai
npm ci
npm run build
npm run vendor                              # bundle marked / mermaid into public/vendor/
node dist/cli.js install --dry-run          # preview the changes to ~/.claude/settings.json
node dist/cli.js install --lang en          # register hooks + skill; --lang en|ja picks the GUI / TUI language
```

`--lang` is stored in `<data-dir>/config.json` (default data dir: `~/.ukagai`). Without `--lang`, `install` asks on a TTY (Enter for `en`), uses `en` otherwise, and keeps an existing config. The agent writes its explanations in the same language.

`install` backs up your settings before writing. To try it without touching your real settings, write to a separate file and start a test session with it:

```sh
node dist/cli.js install --settings /tmp/ukagai-settings.json --data-dir /tmp/ukagai-data --lang ja
claude --settings /tmp/ukagai-settings.json
```

With `--settings` the skill is left alone; add `--skill` to place it too.

### Codex CLI

```sh
node dist/cli.js install --codex --dry-run   # preview the changes to ~/.codex/hooks.json and ~/.codex/config.toml
node dist/cli.js install --codex             # Codex only; add --claude to register Claude Code too
```

`install --codex` merges ukagai's handlers (PreToolUse `request_user_input`, PermissionRequest, Stop, SessionStart, SessionEnd; re-run `install --codex` after upgrading to pick up SessionEnd). SessionEnd arrives when Codex shuts the session down (possibly minutes after the TUI quit); the bridge then cancels the thread's pending progress card and forgets the thread into `$CODEX_HOME/hooks.json` (default `~/.codex`; `--codex-home <dir>` overrides) without touching other hooks, and writes the matching `[hooks.state."…"]` trust hashes into `config.toml`, so Codex does not show "Hooks need review". Only those tables are edited: an existing `hooks.json` keeps its indentation (tabs / spaces), final-newline state and key order, and both files get a `.bak-<time>` copy. `uninstall --codex` restores the original bytes (files `install` created are deleted again; what install did is recorded in `<CODEX_HOME>/.ukagai-codex.json`, without that record nothing is deleted). `install` never touches Codex without `--codex`; `uninstall --codex` and `doctor --codex` mirror it.

What Codex covers: `request_user_input` in Plan mode, questions written in prose (Default mode, caught at Stop), and approvals (shown in the GUI as an "Approval" card with Allow / Deny) through the hooks, and the plan approval ("Implement this plan?") through the codex-bridge (below).

**Codex plan approval (codex-bridge).** `serve` attaches to the Codex app-server daemon's socket (`<CODEX_HOME>/app-server-control/app-server-control.sock`; `serve --codex-home <dir>` overrides, `serve --no-codex-bridge` turns it off) and shows each finished Plan-mode plan as a plan card. Approve in the GUI / TUI starts the implementation turn in Codex; reject with a reason sends the reason back in Plan mode. Codex's own popup stays open in the terminal: choose "No, stay in Plan mode" there (a second "Yes" would run the plan twice). The bridge also raises a progress check (Continue / Give an instruction… / Stop here) 3 minutes (the default; see Settings) after a Codex turn finished without a new prompt, and sends your instruction back as a new turn. No check is raised once the Codex TUI in that folder has quit (the daemon keeps the thread loaded and says nothing, so the bridge looks for a running `codex` process there). Beyond plans and checkpoints it handles nothing; if you want questions in Default mode, add `features.default_mode_request_user_input = true` to Codex's `config.toml` yourself (under development in Codex; ukagai does not write it). Details: `docs/spec/codex-bridge.md`.

## Usage

**GUI.** After `install`, just start `claude`: the server starts automatically and the browser opens on the first session of the day. A plan card is two columns: the plan on the left, one option list on the right like a question: **1 Approve (continue in auto mode)** (the default; `y`), **2 Instruct** (a box that is always shown and takes the focus as soon as the selection lands on it: `↑` / `↓`, a click on the card, or `i`; type what the agent should do first, e.g. have another model review the plan, or click a preset chip, a second click sends it; the plan stays unapproved and the agent updates it and asks again) and **3 Reject** (landing on it opens the reason box; `n`; `Enter` in the box sends). **Approve** (`y`) also switches the session to auto mode: it takes effect at the agent's first permission prompt of any tool (Bash, Write, …) within 60 minutes, and is dropped when the session ends or a new plan is submitted. A long plan has no contents list: it starts in the **plan zone** with its first section selected (`↑` / `↓` move the selection and scroll the column, `Enter` / `Space` open or fold the section, `o` opens or folds all, `Home` / `End` or `gg` / `G` jump), and `→` goes to the **options zone** (`↑` / `↓` pick, `Enter` decides) and `←` back; `y` `n` `i` `1`-`3` work from either zone. `[` `]` and `Tab` switch pending decisions (`←` `→` do so only where there is no plan zone: questions, checkpoints, short plans). The same box is on the plan file card while the agent is still writing the plan; a plan file pops up only when its session is known (until then it waits in the list under `b`). You can also run it yourself with `node dist/cli.js serve` (http://127.0.0.1:4818). Stop it with `pkill -f "cli.js serve"`; turn off auto-start with `install --no-autostart`. The tab icon shows the pending count up to 5 (`5+` beyond, red while a blocker waits).

**TUI.** `node dist/cli.js tui` shows the same decision screen in the terminal with vim-style keys: `j`/`k` move, `Space` multi-select, `Enter` submit, `i` free text (the cursor landing on the free-text card or a checkpoint's instruction card opens the box by itself; `Esc` leaves it and keeps the text, `↑`/`↓` in an empty box move on; the header is two rows like the GUI's: the bold title, then the context line as bracket chips `[● repo] [⎇ branch] [⧉ worktree] [scope] [age]` with the repo in its own colour and bold; the Goal line is a bold `Goal` and a rule under it, the condition starts with a bold `Condition`; the TUI never uses the terminal's DIM on text, only on rules and box edges, and the GUI draws no text in a lighter colour: hierarchy is chips, labels, rules and weight), `y`/`n` approve (always in auto mode, one press) / reject a plan, instruct it ("do this before I approve": the instruction card is always shown above Approve / Reject and its box opens by itself when the cursor lands on it, `i` jumps there; `Esc` leaves keeping the text, `↑`/`↓` in an empty box move on; digits `1`-`9` put a preset into the empty box; also on a plan file whose agent session is known; a plan file pops up and counts in Pending only once its session is known, until then it waits in the list under `b`) (a long plan folds into one row per `##` section with read marks and no contents list; it has two zones, like the GUI: `←` / `h` = the plan zone (the background column; `j`/`k` or `↑`/`↓` move the section selection and scroll to it, `Enter` / `Space` open or fold it, `o` open / fold all, `Home` / `End` / `gg` / `G` jump) and `→` / `l` = the options zone, one list `1 Approve (continue in auto mode)` / `2 Instruct` / `3 Reject` that behaves like a question's cards; `Tab` switches the zone, `y` `n` `i` `1`-`3` work from either; unread sections are named in one line above the options and never block), `h`/`l` switch pending decisions (on a long plan `h`/`l` are the zone keys and `[` `]` switch pending decisions; `←`/`→` still scroll a too-wide diagram sideways), `b` list, `n` none of these (pick a reason), `x` can't answer (undefined terms / unclear / too much at once; sent at once; suspicious codes are underlined in red and pre-ticked), `e` jump to a footnote, plans flow in like questions (a new plan in `~/.claude/plans` comes up by itself with the same folding view and no buttons, counts in `Pending N`, and `Esc` is Done reading; a live update marks only the changed sections `updated`; its approval turns the same screen into the approval; a read plan is not listed anywhere afterwards; also in the GUI), `s` the session's instructions (the first one is shown as `Goal:` at the top of the background; `s` lists them, `Enter` shows one in full, `Esc` goes back), `q` quit. The decision column holds only the conclusion, its condition, the option cards, free text and the key hint (all three cards and the hint fit the first screen at 140x40 and 120x32); the background column reads in the same order as the GUI (Why, the rest of the recommendation, what you decide, the counter-argument, assumptions, what I checked, diagram, diff, terms, affected). Free text sends with one `Enter` on a single select. The screen shows the reversibility symbol (`↺` / `◐` / `■`), underlines terms, colors options, and asks for `Enter` twice before a question's answer that cannot be undone. Use `--server <url>` and `--data-dir <dir>` to connect to another server, and `--lang en|ja` to override the display language. See `ukagai tui --help` for all keys. The TUI shows every construct of ukagai Markdown as text (callouts, task lists, `<details>`, Mermaid, code titles and diffs, badges, `==mark==`, columns, images as `[image] alt — path`; see `docs/spec/markdown.md`).

**What the agent does.** When the agent calls `AskUserQuestion` or `ExitPlanMode`, the `PreToolUse` hook first denies the call once and asks the agent to write an explanation file (the `ukagai-explain` skill teaches the format). On the retry, the hook registers the decision with the server, waits for your answer in the GUI / TUI, and injects it back as the tool's result. The hook waits in one-hour legs: at the end of a leg it asks the agent to call the tool again and re-attaches to the same open question, so the question never falls back to the terminal while the server is up. If the server is unreachable, the hook prints nothing and Claude Code falls back to its normal prompt (a failed wait is retried for up to 120 seconds first); every abnormal exit (and each retry) is recorded as one JSON line in `<data-dir>/hook.log` (ids, status and error text only, never the question or answer; rotated at 1 MB; the last 3 lines are shown by `doctor`).

**Progress checkpoints.** When Claude Code writes a session recap, the server turns it into a non-blocking "Progress check" in the GUI / TUI; if you answer *Give an instruction…* or *Stop here*, a second, cheap `PreToolUse` hook (`hook --checkpoint`, matcher `Bash|Edit|Write|MultiEdit|NotebookEdit|Agent|Task|TodoWrite`, 3 s) hands it to the agent once at its next tool call (as context, or as a deny that asks it to write a short status and end the turn); with nothing pending it is a single 404 and prints nothing. A recap becomes a new card only when the agent did something since the previous card (Claude Code rewrites its recap while idle); a turn the harness starts to wake the agent (a task notification, a monitor firing) does not count unless the agent changed a file or asked something in it, and such a wake-up neither cancels the card you have nor lifts a stop you gave. A recap means the agent is idle, and an idle agent calls no tool, so the reply is delivered by where the agent is: idle → the server types it into the agent's terminal (herdr: `herdr pane send-text` + Enter; the card says so when it found the terminal); mid-turn → at the next tool call, or typed once the turn ends; Codex → the bridge starts a new turn. Typing goes to the terminal whatever is in the agent's composer: an unsent draft there (or an open picker such as `/model`) is submitted together with the reply, so leave the prompt empty while you wait on a progress check. The GUI / TUI say *Reply sent* when you answer and *Reply delivered* when it reaches the agent, and the history list marks each reply delivered / not delivered yet.

Check the setup any time with `node dist/cli.js doctor`.

## Settings

Open <http://127.0.0.1:4818/settings> (the header's `Settings` link, or the `,` key in the GUI). Every control saves the moment you change it, to `<data-dir>/config.json` (default `~/.ukagai/config.json`, next to the `lang` that `install --lang` writes), and takes effect without restarting the server. `Esc` goes back.

- **Display**: language (`en` / `ja`; the TUI follows it unless started with `--lang`), theme (system / light / dark), and whether the bottom key-hint line is shown.
- **Progress checkpoints (recap)**: create them at all (off: no recap from Claude Code or Codex becomes a card; cards already waiting stay), how long Codex has to be quiet after a turn (30 to 3600 s), and whether replies are typed into the agent's herdr pane (off: they wait for the agent's next tool call).
- **Plans**: show new plan files automatically (off: they neither pop up nor count in Pending; they stay in the list under `b`; with it on, a plan file pops up only when it is **ready**: its session is known, that agent has stopped (and did not end on a question put to you in the terminal), nothing else is waiting on you, and, when ukagai handed its plan rules to that session, the file has `Steps` and `Verification`; size does not matter; a file still being written is listed as Writing / 作成中); instruction presets (one per line, shown as one-click chips on plan cards).
- **Notifications**: a beep (while the tab is not focused) and / or a browser notification (while it is hidden) on a new decision (turning the browser one on asks for permission; if the browser denies it, the toggle stays off), and the `(N)` count in the tab title.

`config.json` is read when `serve` starts; a change made to it by hand needs a restart (or a save on the page). Ports, the data directory, hook budgets and the Codex home are not settings (flags / environment, see above). The API is `GET` / `PUT /api/settings`, documented in `docs/spec/api.md`.

**Rich Markdown.** Explanations and plans are written in a small Markdown dialect that the GUI renders richly and the TUI degrades to readable text: titled callouts, task lists, `<details>`, any Mermaid diagram, code blocks with a title or `diff`, status badges (`[done]`, `[risk]`, …), `==mark==`, `::: columns`, a Steps timeline and screenshots from allowed folders (`docs/spec/markdown.md`). The agent learns it from one sentence in the SessionStart context, from the `ukagai-explain` skill (section "Rich Markdown") and, in Claude Code, from a cheap sync hook (`hook --plan-context`, 3 s, never calls the server) that hands it the plan-writing rules (title, Scope and reversibility, Steps, Risks, Verification) once per session in plan mode. It has two triggers: `PreToolUse` on `EnterPlanMode` (the agent enters plan mode) and `UserPromptSubmit` with `permission_mode: plan` (you entered plan mode yourself, which calls no tool); a marker file `<data-dir>/plan-context/<session_id>` keeps it to one injection. Codex has no such tool and gets only the SessionStart sentence.

## Development

```sh
npm run typecheck
npm test              # GUI tests (test/gui/) run only when agent-browser is available
npm run dev:serve
```

`claude --settings <file>` is used together with the global settings, so a globally installed hook also fires in a test session and writes into your real queue. For tests, run `UKAGAI_DISABLE=1 claude …` to silence the global hook (the `hook` subcommand then prints nothing and exits 0 for every event), or enable only the hook in the test settings file.

| Path | Content |
|---|---|
| `docs/strategy/` | Strategy and the current MVP implementation plan (`03-*`) |
| `docs/spec/api.md` | Server API, state transitions, authorization |
| `docs/spec/explain.md` | The explanation file the agent writes and the hook's validation rules |
| `docs/spec/markdown.md` | The Markdown dialect explanations and plans are written in |
| `docs/verification/` | Records of real-environment verification (01 question injection, 02 Codex hooks and hook limits, 03 E2E, 04 plan-writing context, 05 plan instruct and approve-and-auto, 06 wake-up turns and the progress check) |
| (removed before publication) |
| `skills/ukagai-explain/SKILL.md` | The skill that teaches Claude how to write explanations |

TUI diagrams are rendered with beautiful-mermaid (MIT).

## Codex CLI (experimental)

The same hook can serve Codex CLI: `node dist/cli.js hook --agent codex` (default `--agent claude`). Codex PreToolUse `request_user_input` is mapped to the usual question flow (explanation file under `<data-dir>/explain/<session_id>/`), and the human's answer from the GUI comes back as a `deny` whose reason carries the answer. A prose question at Stop is registered too; if the human answers in the GUI the turn continues with the answer. A PermissionRequest (approval of a command) is registered as an "Approval" question with Allow / Deny. Plan approval is not reachable by Codex hooks; the codex-bridge inside `serve` covers it. Register everything with `install --codex` (see Install); `docs/verification/02-codex-hooks.md` has the real runs.

## Uninstall

```sh
node dist/cli.js uninstall --dry-run
node dist/cli.js uninstall
```

This removes only the hooks and skill that `install` registered (pass the same `--settings` / `--project` you installed with). `<data-dir>/config.json` is kept.
