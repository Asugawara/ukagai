# Verification 07: release 0.1.0 installs from GitHub on every distribution path

- Date: 2026-10-08
- Build: public release v0.1.0 (`ukagai-0.1.0.tar.gz`, `SHA256SUMS`) and branch `plugin` (`686df61 release: v0.1.0`); `install.sh` from `main`
- Versions: Claude Code 2.1.294, codex-cli 0.159.3, node v24.11.0, Darwin 24.6.0
- `<tmp>` below is a scratch directory. Every command ran with `HOME`, `UKAGAI_HOME`, `UKAGAI_BIN_DIR`, `UKAGAI_DATA_DIR`, `UKAGAI_PORT=1`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME` inside it, so no real home, config or the default port was written. No code was changed for this check

## Results

| # | Check | Result |
|---|---|---|
| 1 | `install.sh` from GitHub (curl and wget), `--version`, `doctor`, re-run, hook smoke | ✓ |
| 2 | Tarball content | ✓ |
| 3 | `plugin` branch content, `claude plugin validate` | ✓ |
| 4 | Claude Code marketplace, non-interactive CLI | ✓ |
| 5 | Codex marketplace (GitHub shorthand) | ✓ |
| 6 | Double-registration guard | ✓ (with one finding: `CLAUDE_CONFIG_DIR` is not read) |
| 7 | Stale-server restart | ✓ (not with the planned trigger: see below) |

## 1. install.sh

```
$ curl -fsSL https://raw.githubusercontent.com/Asugawara/ukagai/main/install.sh | sh -s -- --lang ja
ukagai-install: downloading ukagai 0.1.0
ukagai-install: <tmp>/bin is not on your PATH. Add it: ...
settings: <tmp>/home/.claude/settings.json
hook:     <tmp>/bin/ukagai hook
events:   PreToolUse, PermissionRequest, SessionStart, ... Notification
autostart: on
skill:    <tmp>/home/.claude/skills/ukagai-explain/SKILL.md
lang:     ja (<tmp>/data/config.json)
```

- Exit 0. `<tmp>/ukhome/versions/0.1.0/` exists; `<tmp>/bin/ukagai` is a symlink to `…/versions/0.1.0/bin/ukagai`; `<tmp>/data/node-path` holds the node binary.
- `settings.json` hooks are launcher-form: `command` = `<tmp>/bin/ukagai`, `args` = `["hook", "--budget", "3590", "--data-dir", "<tmp>/data", "--managed-by", "ukagai"]` for the PreToolUse ask hook; the other entries start with `hook` too. The skill was copied.
- `bin/ukagai --version` → `0.1.0`.
- `bin/ukagai doctor --data-dir <tmp>/data`: `version 0.1.0 (<tmp>/ukhome/versions/0.1.0)`, all 13 hook rows, `launcher … -> …/versions/0.1.0/bin/ukagai`, `node-path`, `skill`, `autostart on`, `lang ja`. The one problem is `token` (no server was ever started with this data dir; expected). `doctor` probes `http://127.0.0.1:4818/healthz` with a read-only GET regardless of `UKAGAI_PORT` (it answered HTTP 200 from the real server); nothing was written there.
- Second run: `ukagai-install: ukagai 0.1.0 is already installed`.
- `wget -qO- … | sh -s --` into a second home (`<tmp>/h2`): installs `versions/0.1.0`, `h2/bin/ukagai --version` → `0.1.0`.
- Hook smoke: `printf '{"hook_event_name":"SessionStart","session_id":"x","transcript_path":"/tmp/x.jsonl","cwd":"/tmp"}' | <tmp>/bin/ukagai hook --no-autostart --server http://127.0.0.1:1 --data-dir <tmp>/data` → exit 0 and the `hookSpecificOutput` / `additionalContext` JSON on stdout. (An input without `transcript_path` and `cwd` fails the schema and the hook stays silent, exit 0: fail-open as designed.)

## 2. Tarball

- `SHA256SUMS` and `shasum -a 256` agree: `94549b53…48b74`. 2241 entries, one top directory `ukagai-0.1.0/`.
- Present: `bin/ukagai` (mode 755), `dist/cli.js`, `public/vendor/mermaid.min.js`, `skills/ukagai-explain/SKILL.md`, `docs/spec/markdown.md`, `node_modules/hono/package.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `plugin.json`, `hooks/claude.json`, `hooks/codex.json`, `package.json`.
- Absent: `hooks/hooks.json`, `package-lock.json`.
- Version `0.1.0` in `package.json`, `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`.

## 3. `plugin` branch

- `git clone --depth 1 --branch plugin https://github.com/Asugawara/ukagai.git` → `686df61 release: v0.1.0`, 1929 files.
- The file set equals the tarball's (`diff` of the sorted file lists is empty; the tarball only adds directory entries). `bin/ukagai` is `-rwxr-xr-x`; the three version fields say `0.1.0`; no `hooks/hooks.json`, no lock file.
- `claude plugin validate <tmp>/plugin` → `✔ Validation passed`.

## 4. Claude Code marketplace (`CLAUDE_CONFIG_DIR=<tmp>/claude-config`)

`claude plugin` has non-interactive subcommands, so no `/plugin` session was needed.

```
$ claude plugin marketplace add Asugawara/ukagai
Cloning repository: https://github.com/Asugawara/ukagai.git
✔ Successfully added marketplace: ukagai (declared in user settings)
$ claude plugin install ukagai@ukagai
✔ Successfully installed plugin: ukagai@ukagai (scope: user)
$ claude plugin list
  ❯ ukagai@ukagai   Version: 0.1.0   Scope: user   Status: ✔ enabled
```

`<tmp>/claude-config/settings.json`:

```json
{
  "extraKnownMarketplaces": { "ukagai": { "source": { "source": "github", "repo": "Asugawara/ukagai" } } },
  "enabledPlugins": { "ukagai@ukagai": true }
}
```

The cache `plugins/cache/ukagai/ukagai/0.1.0/` holds the full tree including `hooks/claude.json` and `hooks/codex.json`.

## 5. Codex marketplace (`CODEX_HOME=<tmp>/codex-home`)

```
$ codex plugin marketplace add Asugawara/ukagai
Added marketplace `ukagai` from https://github.com/Asugawara/ukagai.git.
$ codex plugin add ukagai@ukagai
Added plugin `ukagai` from marketplace `ukagai`.
Installed plugin root: <tmp>/codex-home/plugins/cache/ukagai/ukagai/0.1.0
$ codex plugin list --json
"pluginId": "ukagai@ukagai", "version": "0.1.0", "installed": true, "enabled": true,
"source": { "source": "git", "url": "https://github.com/Asugawara/ukagai.git", "ref": "plugin" }
```

The GitHub shorthand worked on the first try, so the URL form was not needed. The cache tree has `.codex-plugin/plugin.json`, `hooks/codex.json` and `hooks/claude.json`. `codex exec` was not run.

## 6. Double-registration guard

`ukagai install` reads `~/.claude/settings.json` under `$HOME`, not `CLAUDE_CONFIG_DIR` (no reference to the variable exists in `src/`). So the `enabledPlugins` block produced by step 4 was copied into `<tmp>/h3/.claude/settings.json` (the `HOME` of this check) before running:

```
$ <tmp>/bin/ukagai install --lang ja
skill:    removed <tmp>/h3/.claude/skills/ukagai-explain/SKILL.md
plugin ukagai@ukagai is enabled: hooks and skill come from the plugin (use --force to register them in settings.json as well)
$ ukagai doctor        → plugin  ukagai@ukagai enabled   skill ukagai-explain  from the plugin
$ ukagai install --lang ja --force   (backup settings.json.bak-… written; 13 hook entries again, skill copied back)
$ ukagai doctor        → ×  hooks registered twice   plugin and settings.json: run ukagai install
```

Before `--force` the settings file had 0 `hook` entries; after it, 13. Doctor's other problems in these runs are the missing `token` (no server for this data dir).

## 7. Stale-server restart

The planned trigger (dev checkout reporting `0.0.0`) does not exist: the dev checkout's `dist/cli.js --version` is `0.1.0`, the same as the release. The hook (`src/hook/autostart.ts`) calls a server stale when its version differs from the hook's **or** its `dist/cli.js` no longer exists, so the same-version case is correctly left alone. The second condition was used instead, which is what an upgrade does when it prunes the old version directory:

1. Copied `versions/0.1.0` to `<tmp>/vcopy`, started `<tmp>/vcopy/bin/ukagai serve --port 0 --data-dir <tmp>/data2 --no-codex-bridge` (`http://127.0.0.1:58572`, pid 73274). `/healthz` → `{"ok":true,"version":"0.1.0","cli":"<tmp>/vcopy/dist/cli.js"}`.
2. SessionStart hook of the dev checkout (`node <dev>/dist/cli.js hook --server http://127.0.0.1:58572 --data-dir <tmp>/data2`, full SessionStart JSON on stdin) while `vcopy` still existed: pid 73274 stayed alive.
3. `rm -rf <tmp>/vcopy`, same hook again: exit 0, pid 73274 gone, a new `…/dev/ukagai/dist/cli.js serve --port 58572 --data-dir <tmp>/data2` process (pid 73657) answers `/healthz` with `"cli":"<dev>/dist/cli.js"`, and `serve.log` has `ukagai serve: http://127.0.0.1:58572`.

An earlier attempt with a SessionStart JSON that lacked `transcript_path` / `cwd` did nothing (the hook rejects the input and fails open), which is why the stdin must be complete. The version-mismatch branch was not run (no second build with a different version was available).

## Cleanup

Servers started here were killed by pid; `pgrep -f 'cli.js serve'` lists only the owner's server (`--port 4818`). The `plugin` clone and `vcopy` were deleted.

## Findings

- `install` / `uninstall` / `doctor` ignore `CLAUDE_CONFIG_DIR` and always use `$HOME/.claude`; a user who relocates Claude Code's config directory gets hooks written to the wrong place and the plugin check misses `enabledPlugins`.
- `doctor` probes port 4818 even when `UKAGAI_PORT` is set to something else.
