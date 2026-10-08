# Distribution plan

A record of how ukagai reaches users: the release tarball, `install.sh`, the release flow, and the two plugin marketplaces. The implementation plan for the MVP is `03-mvp-implementation-plan.md`.

## Goals

- Install without a Node.js package registry: one script, one tarball, checksum verified.
- Keep the agents' own mechanisms in charge: Claude Code and Codex CLI each get a plugin marketplace, and the same hook definitions feed both the settings-file form and the plugin form.
- One source of truth for the hook definitions (`buildHookEntries`, `CODEX_SPECS`), so the plugin files cannot drift from `ukagai install`.

## Tarball layout

`scripts/build-release.sh <version> <outdir>` writes `ukagai-<version>.tar.gz` and `SHA256SUMS` into `<outdir>`. The archive holds one top-level directory, `ukagai-<version>/`:

- `bin/ukagai`: the launcher (POSIX sh, mode 755).
- `dist/`, `public/`, `skills/`, `docs/spec/markdown.md`, `README.md`, `LICENSE`, `package.json` (its `version` set to the release version).
- `node_modules/`: production dependencies only (`npm ci --omit=dev --ignore-scripts`). `package-lock.json` is removed from the stage.
- Plugin files, written by `scripts/write-plugin-files.mjs` from `src/plugin/build.ts`: `.claude-plugin/plugin.json`, `hooks/claude.json`, `plugin.json`, `.codex-plugin/plugin.json`, `hooks/codex.json`.

There is deliberately no `hooks/hooks.json`. Codex discovers that file by default, and it would pick up the Claude hooks.

## Launcher and Node.js search order

`bin/ukagai` follows symlinks to find its own root, then runs `dist/cli.js` with the first Node.js >= 22 it finds, in this order:

1. `UKAGAI_NODE`, if set and >= 22.
2. `<data-dir>/node-path` (written by `install.sh` and by `serve`).
3. `command -v node`.
4. nvm (`~/.nvm` and `~/.local/share/nvm`), fnm (`~/.local/share/fnm` and `~/Library/Application Support/fnm`), mise installs (newest version first), then `~/.volta/bin/node`.
5. `/opt/homebrew/bin/node`, `/usr/local/bin/node`.
6. The login shell's `command -v node`.

When nothing qualifies: for a `hook` call on SessionStart, the launcher prints one line to the agent and exits 0; any other call exits 127 with a message on stderr.

## `install.sh`

- Entry point: `curl -fsSL https://raw.githubusercontent.com/Asugawara/ukagai/main/install.sh | sh -s -- [flags]`. POSIX sh; `wget` works in place of `curl`.
- Flags: `--version`, `--lang en|ja`, `--codex`, `--claude`, `--force`. Environment: `UKAGAI_HOME`, `UKAGAI_BIN_DIR`, `UKAGAI_DATA_DIR`, `UKAGAI_PORT` (default 4818), `UKAGAI_NODE`, `UKAGAI_DOWNLOADER`, `UKAGAI_VERSION`.
- Steps: check Node.js >= 22; refuse a foreign `~/.local/bin/ukagai` before anything is downloaded (`--force` replaces it); resolve the version (latest is read from the `SHA256SUMS` of `releases/latest`); download the tarball and `SHA256SUMS`; verify the SHA256; extract to `versions/<v>/`; smoke-test `bin/ukagai --version` against the expected version; record the Node.js path in `<data-dir>/node-path` (a failure there is a warning only); link `~/.local/bin/ukagai`; prune old versions, keeping the target, the previous one, the one the server on `UKAGAI_PORT` runs, and any young `*.tmp` directory (a concurrent install).
- A server without a `version` in `/healthz` (a development server) is never restarted by the installer; the installer only prints a note.
- With `--lang`, `--codex` or `--claude` it then runs `ukagai install <args>`, adding `--data-dir` when `UKAGAI_DATA_DIR` is not the default. Without them it only prints the next command.
- Running as root prints a warning, because the files under `$HOME` would be owned by root.
- Versions live under `~/.local/share/ukagai/versions/<v>/`; the link at `~/.local/bin/ukagai` moves to the new one.

## Release flow

`release.yml` runs on every push to `main`:

1. `release_please`: release-please in manifest mode (`.release-please-manifest.json`, `release-please-config.json`, `release-type: node`). Conventional commits produce a release PR; merging it creates the tag and a **draft** release.
2. `package` (reusable `package.yml`): runs `scripts/build-release.sh` and uploads the tarball and `SHA256SUMS` as an artifact.
3. `publish`: `gh release upload --clobber`, then `gh release edit --draft=false --latest`.
4. `plugin_branch`: rebuilds the stage and commits its whole tree (`node_modules` included) to the `plugin` branch from a separate worktree, as `github-actions[bot]`. A rerun with no change exits 0.

The `plugin` branch is what both marketplaces install from.

## The two marketplaces

- Claude Code: `.claude-plugin/marketplace.json` (name `ukagai`, plugin `ukagai`, `github` source `Asugawara/ukagai`, ref `plugin`). Install: `/plugin marketplace add Asugawara/ukagai`, `/plugin install ukagai@ukagai`.
- Codex CLI: `.agents/plugins/marketplace.json` (`url` source, ref `plugin`, `policy.installation` AVAILABLE, `category` Productivity). Install: `codex plugin marketplace add`, `codex plugin add ukagai@ukagai`, then trust the hooks in `/hooks`.
- The plugin's skill is `ukagai:ukagai-explain` (the name is `ukagai-explain` outside a plugin; `src/hook/skill-name.ts` decides).
- Codex reads the hooks file only from `.codex-plugin/plugin.json` (`hooks: ./hooks/codex.json`) in Codex CLI 0.159.3; the root `plugin.json` also carries `extensions.com.openai.hooks` for the same file. Codex skips plugin hooks until they are trusted, and trust is keyed by the hooks file path relative to the plugin root, so a new version does not need a new trust unless the hook definitions changed.

## `install` and `doctor` with an enabled plugin

- Claude Code: `enabledClaudePlugin` looks for an `enabledPlugins` entry `ukagai@<marketplace>` set to `true` in the user settings (and, with `--project`, the project settings). When found, and with neither `--settings` nor `--force`, `ukagai install` removes its managed hooks and the `~/.claude/skills/ukagai-explain` copy from `settings.json` and prints one line saying the plugin supplies them.
- Codex CLI: `enabledCodexPlugin` reads `[plugins."ukagai@…"] enabled = true` in `config.toml`. `ukagai install --codex` then runs the uninstall plan on `hooks.json` and `config.toml` instead of the install plan.
- `--force` keeps the settings-side registration for users who want both.
- `ukagai doctor` reports `hooks registered twice` when the plugin and the settings-side hooks are both present, and shows the plugin rows (`plugin`, `codex plugin`).

## Stale-server restart

Each `/healthz` response carries `version` and `cli` (the path of the running `dist/cli.js`). At SessionStart the hook compares them with its own. When the version differs, or the `cli` path no longer exists (the install was replaced), it calls `POST /api/shutdown`, polls `/healthz` for up to 3 s, and then starts the new server. `doctor` shows a version mismatch as a note.

## Out of scope (for now)

- Windows: not supported. `bin/ukagai` and `install.sh` are POSIX sh.
- An npm registry package: the package is `private`; `npm install -g` is not a supported path.
- Homebrew: not planned until there are users who ask for it.

## Release caveat: merge commits and the changelog

release-please walks the history by commit date and stops at the last release commit. A branch merged with `--no-ff` whose commits are older than the last release would be left out of the changelog. Rebase the branch onto `main` before merging it.

## Before the first release

- `release-please-config.json` still has `"bootstrap-sha": "REPLACE_BEFORE_FIRST_PUSH"`. Set it to the commit that the first release should start from.
- The README's `codex plugin marketplace add Asugawara/ukagai` (GitHub shorthand) was not verified in DIST-E, which tested a local directory and a `url` source only. Check it against the released marketplace.
