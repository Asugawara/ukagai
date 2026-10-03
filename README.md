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

## Usage

**GUI.** After `install`, just start `claude`: the server starts automatically and the browser opens on the first session of the day. You can also run it yourself with `node dist/cli.js serve` (http://127.0.0.1:4818). Stop it with `pkill -f "cli.js serve"`; turn off auto-start with `install --no-autostart`.

**TUI.** `node dist/cli.js tui` shows the same decision screen in the terminal with vim-style keys: `j`/`k` move, `Space` multi-select, `Enter` submit, `i` free text, `y`/`a`/`n` approve / auto / reject a plan, `h`/`l` switch pending decisions, `b` list, `n` none of these (pick a reason), `x` can't answer (undefined terms / unclear / too much at once; sent at once; suspicious codes are underlined in red and pre-ticked), `e` jump to a footnote, `q` quit. The screen shows the one-sentence conclusion, reversibility symbol (`↺` / `◐` / `■`), what you decide, assumptions, the counter-argument and affected names, underlines terms, colors options, and asks for `Enter` twice before an answer that cannot be undone. Use `--server <url>` and `--data-dir <dir>` to connect to another server, and `--lang en|ja` to override the display language. See `ukagai tui --help` for all keys.

**What the agent does.** When the agent calls `AskUserQuestion` or `ExitPlanMode`, the `PreToolUse` hook first denies the call once and asks the agent to write an explanation file (the `ukagai-explain` skill teaches the format). On the retry, the hook registers the decision with the server, waits for your answer in the GUI / TUI, and injects it back as the tool's result. If the server is unreachable, the hook prints nothing and Claude Code falls back to its normal prompt.

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

## Uninstall

```sh
node dist/cli.js uninstall --dry-run
node dist/cli.js uninstall
```

This removes only the hooks and skill that `install` registered (pass the same `--settings` / `--project` you installed with). `<data-dir>/config.json` is kept.
