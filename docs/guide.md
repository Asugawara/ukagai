# ukagai user guide

The details behind the [README](../README.md): how the decision screen works, plan approval, progress checkpoints, the TUI, Settings, Rich Markdown, Codex CLI, the hook, and what to do when something does not work.

Print the version with `ukagai --version`. Check the setup any time with `ukagai doctor`.

## The decision screen

After `ukagai install`, just start `claude`: the server starts automatically and the browser opens on the first session of the day, but only when no GUI tab is connected within 8 seconds (a pinned tab reconnects by itself); a tab opened this way closes itself when another ukagai tab answers.

You can also run the server yourself with `ukagai serve` (http://127.0.0.1:4818). Stop it with `pkill -f "cli.js serve"`; turn off auto-start with `ukagai install --no-autostart`. The tab icon shows the pending count up to 5 (`5+` beyond, red while a blocker waits).

`[` `]` and `Tab` switch pending decisions (`←` `→` do so only where there is no plan zone: questions, checkpoints, short plans). `b` opens the list of pending decisions.

The language is stored in `<data-dir>/config.json` (default data dir: `~/.ukagai`) and changed on the Settings page (below). When `ukagai install` finds no `config.json` it creates one whose language comes from your locale (`ja` if the first non-empty of `LC_ALL`, `LC_MESSAGES`, `LANG` starts with `ja`, otherwise `en`); an existing config is never touched. A plugin-only user never runs `install`, so they start in `en` and switch on the Settings page. The agent writes its explanations in the same language. `ukagai install` backs up your settings before writing.

## Plan approval

A plan card is two columns: the plan on the left, one option list on the right like a question:

- **1 Approve (continue in auto mode)** (the default; `y`).
- **2 Instruct**: a box that is always shown and takes the focus as soon as the selection lands on it (`↑` / `↓`, a click on the card, or `i`). Type what the agent should do first, e.g. have another model review the plan, or click a preset chip; a second click sends it. The plan stays unapproved and the agent updates it and asks again.
- **3 Reject**: landing on it opens the reason box; `n`; `Enter` in the box sends.

**Approve** (`y`) also switches the session to auto mode: it takes effect at the agent's first permission prompt of any tool (Bash, Write, …) within 60 minutes, and is dropped when the session ends or a new plan is submitted.

A long plan has no contents list: it starts in the **plan zone** with its first section selected (`↑` / `↓` move the selection and scroll the column, `Enter` / `Space` open or fold the section, `o` opens or folds all, `Home` / `End` or `gg` / `G` jump), and `→` goes to the **options zone** (`↑` / `↓` pick, `Enter` decides) and `←` back; `y` `n` `i` `1`-`3` work from either zone.

The same box is on the plan file card while the agent is still writing the plan; a plan file pops up only when its session is known (until then it waits in the list under `b`).

When a plan was rewritten after an instruction, the plan screen (GUI and TUI) shows version tabs (`v1（指示前） v2（今回）★`, `<` / `>` to switch), a one-line summary of what changed (sections added / changed / removed and the instruction that led to it) and marks the new / changed sections and lines; the versions and the diff come from `GET /api/sessions/:id/plan-versions`.

## Progress checkpoints

When Claude Code writes a session recap, the server turns it into a non-blocking "Progress check" in the GUI / TUI. If you answer *Give an instruction…* or *Stop here*, a second, cheap `PreToolUse` hook (`hook --checkpoint`, matcher `Bash|Edit|Write|MultiEdit|NotebookEdit|Agent|Task|TodoWrite`, 3 s) hands it to the agent once at its next tool call (as context, or as a deny that asks it to write a short status and end the turn); with nothing pending it is a single 404 and prints nothing.

A recap becomes a new card only when the agent did something since the previous card (Claude Code rewrites its recap while idle); a turn the harness starts to wake the agent (a task notification, a monitor firing) does not count unless the agent changed a file or asked something in it, and such a wake-up neither cancels the card you have nor lifts a stop you gave.

A recap means the agent is idle, and an idle agent calls no tool, so the reply is delivered by where the agent is:

- idle → the server types it into the agent's terminal (herdr: `herdr pane send-text` + Enter; the card says so when it found the terminal);
- mid-turn → at the next tool call, or typed once the turn ends;
- Codex → the bridge starts a new turn.

Typing goes to the terminal whatever is in the agent's composer: an unsent draft there (or an open picker such as `/model`) is submitted together with the reply, so leave the prompt empty while you wait on a progress check. The GUI / TUI say *Reply sent* when you answer and *Reply delivered* when it reaches the agent, and the history list marks each reply delivered / not delivered yet.

## The TUI

`ukagai tui` shows the same decision screen in the terminal with vim-style keys. Use `--server <url>` and `--data-dir <dir>` to connect to another server, and `--lang en|ja` to override the display language. See `ukagai tui --help` for all keys.

**Keys for questions**

- `j`/`k` move, `Space` multi-select, `Enter` submit; `h`/`l` switch pending decisions (on a long plan `h`/`l` are the zone keys and `[` `]` switch pending decisions; `←`/`→` still scroll a too-wide diagram sideways).
- `i` free text (the cursor landing on the free-text card or a checkpoint's instruction card opens the box by itself; `Esc` leaves it and keeps the text, `↑`/`↓` in an empty box move on). Free text sends with one `Enter` on a single select.
- `b` list, `n` none of these (pick a reason), `x` can't answer (undefined terms / unclear / too much at once; sent at once; suspicious codes are underlined in red and pre-ticked).
- `e` jump to a footnote, `s` the session's instructions (the first one is shown as `Goal:` at the top of the background; `s` lists them, `Enter` shows one in full, `Esc` goes back), `q` quit.

**Keys for plans**

- `y`/`n` approve (always in auto mode, one press) / reject a plan.
- Instruct it ("do this before I approve"): the instruction card is always shown above Approve / Reject and its box opens by itself when the cursor lands on it, `i` jumps there; `Esc` leaves keeping the text, `↑`/`↓` in an empty box move on; digits `1`-`9` put a preset into the empty box. Also on a plan file whose agent session is known; a plan file pops up and counts in Pending only once its session is known, until then it waits in the list under `b`.
- A long plan folds into one row per `##` section with read marks and no contents list. It has two zones, like the GUI: `←` / `h` = the plan zone (the background column; `j`/`k` or `↑`/`↓` move the section selection and scroll to it, `Enter` / `Space` open or fold it, `o` open / fold all, `Home` / `End` / `gg` / `G` jump) and `→` / `l` = the options zone, one list `1 Approve (continue in auto mode)` / `2 Instruct` / `3 Reject` that behaves like a question's cards (`n` then `Enter` in the empty reason box rejects without a reason; with two or more plan versions a `v1  v2` line shows the selected one in bold reverse video). `Tab` switches the zone, `y` `n` `i` `1`-`3` work from either; unread sections are named in one line above the options and never block.
- Plans flow in like questions: a new plan in `~/.claude/plans` comes up by itself with the same folding view and no buttons, counts in `Pending N`, and `Esc` is Done reading; a live update marks only the changed sections `updated`; its approval turns the same screen into the approval; a read plan is not listed anywhere afterwards (also in the GUI).

**What the screen shows**

- The header is two rows like the GUI's: the bold title, then the context line as bracket chips `[● repo] [⎇ branch] [⧉ worktree] [scope] [age]` with the repo in its own colour and bold. The Goal line is a bold `Goal` and a rule under it, the condition starts with a bold `Condition`. The TUI never uses the terminal's DIM on text, only on rules and box edges, and the GUI draws no text in a lighter colour: hierarchy is chips, labels, rules and weight.
- The decision column holds only the conclusion, its condition, the option cards, free text and the key hint (all three cards and the hint fit the first screen at 140x40 and 120x32); the background column reads in the same order as the GUI (Why, the rest of the recommendation, what you decide, the counter-argument, assumptions, what I checked, diagram, diff, terms, affected).
- The reversibility symbol (`↺` / `◐` / `■`), underlined terms, coloured options, and `Enter` twice before an answer to a question that cannot be undone.
- Every construct of ukagai Markdown as text (callouts, task lists, `<details>`, Mermaid, code titles and diffs, badges, `==mark==`, columns, images as `[image] alt — path`, HTML pages as `[HTML] alt — x.html (shown in the GUI)`; see `docs/spec/markdown.md`). TUI diagrams are rendered with beautiful-mermaid (MIT).

## Settings

Open <http://127.0.0.1:4818/settings> (the header's `Settings` link, or the `,` key in the GUI). A sidebar on the left (a scrolling row on a narrow window) switches between **General**, **Notifications**, **Plans**, **Progress checkpoints** and, under **Agent**, **Skill**; the address keeps the pane (`/settings#skill`), so a reload stays where you were. Every control saves the moment you change it, to `<data-dir>/config.json` (default `~/.ukagai/config.json`, next to the initial `lang` that `install` writes), and takes effect without restarting the server. `Esc` goes back.

- **General**: language (`en` / `ja`; the TUI follows it unless started with `--lang`), theme (system / light / dark), and whether the bottom key-hint line is shown.
- **Notifications**: a beep (while the tab is not focused) and / or a browser notification (while it is hidden) on a new decision (turning the browser one on asks for permission; if the browser denies it, the toggle stays off), and the `(N)` count in the tab title.
- **Plans**: show new plan files automatically (off: they neither pop up nor count in Pending; they stay in the list under `b`; with it on, a plan file pops up only when it is **ready**: its session is known, that agent has stopped (and did not end on a question put to you in the terminal; background subagents still running, or the wake-up turn they trigger not yet started, count as not stopped), nothing else is waiting on you, and, when ukagai handed its plan rules to that session, the file has `Steps` and `Verification`; size does not matter; a file still being written is listed as Writing / 作成中); instruction presets (one per line, shown as one-click chips on plan cards).
- **Progress checkpoints (recap)**: create them at all (off: no recap from Claude Code or Codex becomes a card; cards already waiting stay), how long Codex has to be quiet after a turn (30 to 3600 s), and whether replies are typed into the agent's herdr pane (off: they wait for the agent's next tool call).
- **Skill**: the text of the `ukagai-explain` skill, the instructions the agent follows when it writes an explanation. Edit it as a whole (tabs: Edit, Preview, Diff from default) and save with the button or Cmd/Ctrl+S. Your version is kept in `<data-dir>/skill/SKILL.md` (with `base.md`, the default as it was when you first saved, and `meta.json`); the installed skill file is not touched, so `ukagai install` and plugin updates do not overwrite it. From the next hook run on, the session-start, plan-mode and "write an explanation first" texts tell the agent to read your file instead of the skill (Claude Code gets a copy under its scratchpad, Codex the file itself); in a session without a scratchpad (headless `claude -p`) the text names `<data-dir>/skill/SKILL.md` directly and reading it needs a read permission for that directory, for example `--add-dir <data-dir>`; this works for the plain install, the plugin and Codex alike. The hook's checks are unchanged: the cell, recommendation and diagram rules still apply to what the agent writes, whatever your text says. **Reset to default** (click twice) deletes `<data-dir>/skill/`. When a new ukagai changes the default, your version does not follow: the Diff tab compares the default with yours and `ukagai doctor` says "the default changed since you started editing".

`config.json` is read when `serve` starts; a change made to it by hand needs a restart (or a save on the page). Ports, the data directory, hook budgets and the Codex home are not settings (flags / environment, see the README). The API is `GET` / `PUT /api/settings` and `GET` / `PUT` / `DELETE /api/skill`, documented in `docs/spec/api.md`.

## Rich Markdown

Explanations and plans are written in a small Markdown dialect that the GUI renders richly and the TUI degrades to readable text: titled callouts, task lists, `<details>`, any Mermaid diagram, code blocks with a title or `diff`, status badges (`[done]`, `[risk]`, …), `==mark==`, `::: columns`, a Steps timeline, screenshots from allowed folders and HTML pages (`![alt](compare.html)`, shown in a sandboxed frame in the GUI; `docs/spec/markdown.md`). The screenshot in the [README](../README.md#what-makes-it-different) (`docs/images/compare.png`) shows two such HTML proposals side by side in `::: columns` next to the options.

Agents never `open` a file for you: the cheap `hook --checkpoint` path denies a Bash `open` / `xdg-open` / `start` on a scratchpad / data-dir path or a document / image file and tells the agent to reference it from the explanation (Codex's hooks do not see shell commands, so only its context sentence applies).

The agent learns the dialect from one sentence in the SessionStart context, from the `ukagai-explain` skill (section "Rich Markdown") and, in Claude Code, from a cheap sync hook (`hook --plan-context`, 3 s, never calls the server) that hands it the plan-writing rules (title, Scope and reversibility, Steps, Risks, Verification) once per session in plan mode. It has two triggers: `PreToolUse` on `EnterPlanMode` (the agent enters plan mode) and `UserPromptSubmit` with `permission_mode: plan` (you entered plan mode yourself, which calls no tool); a marker file `<data-dir>/plan-context/<session_id>` keeps it to one injection. Codex has no such tool and gets only the SessionStart sentence.

## Codex CLI

The same hook can serve Codex CLI: `ukagai hook --agent codex` (default `--agent claude`). Codex PreToolUse `request_user_input` is mapped to the usual question flow (explanation file under `<data-dir>/explain/<session_id>/`), and the human's answer from the GUI comes back as a `deny` whose reason carries the answer. A prose question at Stop is registered too; if the human answers in the GUI the turn continues with the answer. A PermissionRequest (approval of a command) is registered as an "Approval" question with Allow / Deny. Plan approval is not reachable by Codex hooks; the codex-bridge inside `serve` covers it. `docs/verification/02-codex-hooks.md` has the real runs.

### Install and uninstall

```sh
ukagai install --dry-run      # preview: which agents were found and what would change
ukagai install                # register the hooks and the skill for every agent found
ukagai install --codex        # only Codex CLI (--claude: only Claude Code), found or not
ukagai install --refresh      # re-register only the agents that are already registered
```

`ukagai install` registers every agent it finds: Claude Code when an executable `claude` is on `PATH`, or `~/.claude.json` or `~/.claude/projects/` exists (a bare `~/.claude` does not count: an old install or uninstall can leave it behind); Codex CLI when an executable `codex` is on `PATH`, or `<Codex home>/sessions/` exists (`--codex-home <dir>`, then `$CODEX_HOME`, then `~/.codex`). It prints an `agents:` line with what it found and why (for example `Claude Code (claude on PATH), Codex CLI (~/.codex/sessions)`; `registered` under `--refresh`, `requested` when you named the agent), a `lang:` line (not on `--dry-run`) that points at the Settings page, and a closing `next:` line once an agent was registered. If nothing is found it says so and exits 0. `--claude` / `--codex` (or `--settings` / `--project`) name the agents yourself and skip the detection. In the automatic mode and with `--refresh`, a failure in one agent is reported on stderr (`claude: error: …` / `codex: error: …`) and the other agent is still done; the exit code is then 1. With an explicit `--claude` / `--codex` an error stops the command as it always did (`ukagai install: …`, exit 1). A second `install` that would change nothing writes no file and makes no backup (the settings line says `(unchanged)`).

An agent that is already registered keeps its options when `install` registers it again: `--timeout`, `--observe`, `--no-autostart`, `--server` and `--data-dir` are read back from the existing hooks, and only the options you pass override them. `install.sh` runs `ukagai install` the first time and `ukagai install --refresh` on an upgrade or a reinstall; `--refresh` touches only the agents that are already registered, found or not. To put the options back to the defaults, run `ukagai uninstall` and then `ukagai install`. `install.sh` ignores the old `--lang`, `--codex` and `--claude` with a warning, and `ukagai install`, `uninstall` and `doctor` ignore `--lang` with a warning too (the value is skipped unless it starts with `-`).

`ukagai uninstall` removes both Claude Code and Codex CLI (`--claude` or `--codex` picks one; `--dry-run` previews). It stops the server once no ukagai hooks remain (after a one-agent uninstall it is left running while the other agent still has hooks). Without `--claude` / `--codex`, a failure in one agent (`codex: error: …`) does not stop the other from being removed; the exit code is 1 and the server is left running, with a `server:   left running (an agent failed above; …)` line, so run `uninstall` again once it is fixed; `<data-dir>` (`~/.ukagai`: config, history, logs) stays until you `rm -rf` it. It never creates `~/.codex` for a user without Codex.

For Codex, `install` merges ukagai's handlers (PreToolUse `request_user_input`, PermissionRequest, Stop, SessionStart, SessionEnd; an upgrade re-registers them, which picks up new ones such as SessionEnd). SessionEnd arrives when Codex shuts the session down (possibly minutes after the TUI quit); the bridge then cancels the thread's pending progress card and forgets the thread.

The handlers go into `$CODEX_HOME/hooks.json` (default `~/.codex`; `--codex-home <dir>` overrides) without touching other hooks, and the matching `[hooks.state."…"]` trust hashes go into `config.toml`, so Codex does not show "Hooks need review". Only those tables are edited: an existing `hooks.json` keeps its indentation (tabs / spaces), final-newline state and key order, and both files get a `.bak-<time>` copy. `uninstall --codex` restores the original bytes (files `install` created are deleted again; what install did is recorded in `<CODEX_HOME>/.ukagai-codex.json`, without that record nothing is deleted). `install` touches Codex only when it is found (or named with `--codex`); `uninstall --codex` and `doctor --codex` act on Codex alone.

### What Codex covers

`request_user_input` in Plan mode, questions written in prose (Default mode, caught at Stop), and approvals (shown in the GUI as an "Approval" card with Allow / Deny) through the hooks, and the plan approval ("Implement this plan?") through the codex-bridge (below).

### Plan approval (codex-bridge)

`serve` attaches to the Codex app-server daemon's socket (`<CODEX_HOME>/app-server-control/app-server-control.sock`; `serve --codex-home <dir>` overrides, `serve --no-codex-bridge` turns it off) and shows each finished Plan-mode plan as a plan card.

- Approve in the GUI / TUI starts the implementation turn in Codex.
- Reject with a reason sends the reason back in Plan mode; reject without a reason (`{ approve: false }`) is allowed too: the agent is told no reason was given and to revise or ask one question.
- Codex's own popup stays open in the terminal: choose "No, stay in Plan mode" there (a second "Yes" would run the plan twice).
- The bridge also raises a progress check (Continue / Give an instruction… / Stop here) 3 minutes (the default; see Settings) after a Codex turn finished without a new prompt, and sends your instruction back as a new turn. No check is raised once the Codex TUI in that folder has quit (the daemon keeps the thread loaded and says nothing, so the bridge looks for a running `codex` process there).
- Beyond plans and checkpoints it handles nothing; if you want questions in Default mode, add `features.default_mode_request_user_input = true` to Codex's `config.toml` yourself (under development in Codex; ukagai does not write it).

Details: `docs/spec/codex-bridge.md`.

### Codex plugin

`codex plugin marketplace add Asugawara/ukagai`, then `codex plugin add ukagai@ukagai`, then run `/hooks` in the Codex TUI and trust the hooks (Codex skips plugin hooks until they are trusted). Verified on Codex CLI 0.159.3. Trust is recorded against the hook definition and keyed by the hooks file path relative to the plugin root, so an update to a new version does not need a new trust unless the hook definitions changed; if the hooks stop reacting after an update, open `/hooks` and trust them again. The skill arrives as `ukagai:ukagai-explain`.

## How the hook works

When the agent calls `AskUserQuestion` or `ExitPlanMode`, the `PreToolUse` hook first denies the call once and asks the agent to write an explanation file (the `ukagai-explain` skill teaches the format). On the retry, the hook registers the decision with the server, waits for your answer in the GUI / TUI, and injects it back as the tool's result.

The hook waits in one-hour legs: at the end of a leg it asks the agent to call the tool again and re-attaches to the same open question, so the question never falls back to the terminal while the server is up. If the server is unreachable, the hook prints nothing and Claude Code falls back to its normal prompt (a failed wait is retried for up to 120 seconds first).

Every abnormal exit (and each retry) is recorded as one JSON line in `<data-dir>/hook.log` (ids, status and error text only, never the question or answer; rotated at 1 MB; the last 3 lines are shown by `doctor`).

## Troubleshooting

- **First step: `ukagai doctor`.** It diagnoses the hook registration and the connection to the server (`--server <url>`, `--data-dir <dir>` point it elsewhere) and shows the last lines of `hook.log`. Without `--claude` / `--codex` it checks the agents that are registered or whose plugin is enabled; if there are none, the agents found; if still none, Claude Code. Each agent gets its own hint, for example `run: ukagai install --codex`. A plugin-only user cannot type `ukagai` in the shell: run `"${CLAUDE_PLUGIN_ROOT}/bin/ukagai" doctor` through the agent's Bash tool in Claude Code. It also reports a double registration (`install.sh` plus the plugin) as a problem.
- **Doctor says "not started yet".** The server only starts at your first `claude` session (or run `ukagai serve`), so before that `ukagai doctor` reports the server and token lines as "not started yet" and still prints `no problems`; once the token exists, an unreachable server is a problem.
- **`hook.log`.** `<data-dir>/hook.log` (default `~/.ukagai/hook.log`) holds one JSON line per abnormal exit or retry: ids, status and error text, never the question or the answer.
- **"Pending N" never appears.** The hook did not register a decision: check that `ukagai doctor` shows the hooks registered, that `UKAGAI_DISABLE=1` is not set in that shell, and that you restarted `claude` after installing. For a plan file, remember it pops up only when its session is known and the agent has stopped; otherwise it waits in the list under `b` (see Settings, Plans). The tab title and icon only count decisions that are pending.
- **The server did not start.** Run `ukagai serve` in a terminal and read the error (the port 4818 may be taken). Auto-start can be turned off with `ukagai install --no-autostart`. A server left over from an old version is replaced at the next session start; `pkill -f "cli.js serve"` stops it by hand.
- **The hook falls back to the terminal.** That is by design when the server is unreachable; the hook prints nothing and exits 0. Start the server and ask again.
- **`install.sh` refuses to run.** A foreign (non-ukagai) file at `~/.local/bin/ukagai` is refused before anything is downloaded; move it away or pass `--force`. `install.sh --help` prints the usage to stdout.
