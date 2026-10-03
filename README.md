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

`install --codex` merges ukagai's handlers (PreToolUse `request_user_input`, PermissionRequest, Stop, SessionStart) into `$CODEX_HOME/hooks.json` (default `~/.codex`; `--codex-home <dir>` overrides) without touching other hooks, and writes the matching `[hooks.state."…"]` trust hashes into `config.toml`, so Codex does not show "Hooks need review". Only those tables are edited: an existing `hooks.json` keeps its indentation (tabs / spaces), final-newline state and key order, and both files get a `.bak-<time>` copy. `uninstall --codex` restores the original bytes (files `install` created are deleted again; what install did is recorded in `<CODEX_HOME>/.ukagai-codex.json`, without that record nothing is deleted). `install` never touches Codex without `--codex`; `uninstall --codex` and `doctor --codex` mirror it.

What Codex covers: `request_user_input` in Plan mode, questions written in prose (Default mode, caught at Stop), and approvals (shown in the GUI as an "Approval" card with Allow / Deny). The plan approval popup ("Implement this plan?") is not covered.

## Usage

**GUI.** After `install`, just start `claude`: the server starts automatically and the browser opens on the first session of the day. You can also run it yourself with `node dist/cli.js serve` (http://127.0.0.1:4818). Stop it with `pkill -f "cli.js serve"`; turn off auto-start with `install --no-autostart`.

**TUI.** `node dist/cli.js tui` shows the same decision screen in the terminal with vim-style keys: `j`/`k` move, `Space` multi-select, `Enter` submit, `i` free text, `y`/`a`/`n` approve / auto / reject a plan (a long plan folds into one row per `##` section with a contents and read marks: `j`/`k` pick a contents row, `Enter` / `Space` open or fold it, `o` open / fold all, `[` `]` previous / next section with the background focused; `y`/`a` with unread sections name them and need a second press), `h`/`l` switch pending decisions, `b` list, `n` none of these (pick a reason), `x` can't answer (undefined terms / unclear / too much at once; sent at once; suspicious codes are underlined in red and pre-ticked), `e` jump to a footnote, `s` the session's instructions (the first one is shown as `Goal:` at the top of the background; `s` lists them, `Enter` shows one in full, `Esc` goes back), `q` quit. The decision column holds only the conclusion, its condition, the option cards, free text and the key hint (all three cards and the hint fit the first screen at 140x40 and 120x32); the background column reads in the same order as the GUI (Why, the rest of the recommendation, what you decide, the counter-argument, assumptions, what I checked, diagram, diff, terms, affected). Free text sends with one `Enter` on a single select. The screen shows the reversibility symbol (`↺` / `◐` / `■`), underlines terms, colors options, and asks for `Enter` twice before an answer that cannot be undone. Use `--server <url>` and `--data-dir <dir>` to connect to another server, and `--lang en|ja` to override the display language. See `ukagai tui --help` for all keys.

**What the agent does.** When the agent calls `AskUserQuestion` or `ExitPlanMode`, the `PreToolUse` hook first denies the call once and asks the agent to write an explanation file (the `ukagai-explain` skill teaches the format). On the retry, the hook registers the decision with the server, waits for your answer in the GUI / TUI, and injects it back as the tool's result. If the server is unreachable, the hook prints nothing and Claude Code falls back to its normal prompt. A failed wait is retried for up to 120 seconds before that; every abnormal exit (and each retry) is recorded as one JSON line in `<data-dir>/hook.log` (ids, status and error text only, never the question or answer; rotated at 1 MB; the last 3 lines are shown by `doctor`).

Check the setup any time with `node dist/cli.js doctor`.

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
| `docs/verification/` | Records of real-environment verification |
| (removed before publication) |
| `skills/ukagai-explain/SKILL.md` | The skill that teaches Claude how to write explanations |

TUI diagrams are rendered with beautiful-mermaid (MIT).

## Codex CLI (experimental)

The same hook can serve Codex CLI: `node dist/cli.js hook --agent codex` (default `--agent claude`). Codex PreToolUse `request_user_input` is mapped to the usual question flow (explanation file under `<data-dir>/explain/<session_id>/`), and the human's answer from the GUI comes back as a `deny` whose reason carries the answer. A prose question at Stop is registered too; if the human answers in the GUI the turn continues with the answer. A PermissionRequest (approval of a command) is registered as an "Approval" question with Allow / Deny. Plan approval is not reachable by Codex hooks. Register everything with `install --codex` (see Install); `docs/verification/02-codex-hooks.md` has the real runs.

## Uninstall

```sh
node dist/cli.js uninstall --dry-run
node dist/cli.js uninstall
```

This removes only the hooks and skill that `install` registered (pass the same `--settings` / `--project` you installed with). `<data-dir>/config.json` is kept.
