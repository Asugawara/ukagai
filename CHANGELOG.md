# Changelog

## 0.1.0 (2026-10-08)


### Features

* **dist:** bin/ukagai launcher (follows symlinks, finds Node &gt;= 22 via UKAGAI_NODE, node-path, PATH, version managers, a login shell), launcher-form hook registration (hookInvocation), ukagai --version, /healthz reports version and cli, POST /api/shutdown, autostart restarts a stale server, serve records node-path, doctor rows; tests and docs ([83249a2](https://github.com/Asugawara/ukagai/commit/83249a2635bcbf3ef63bc62adb487c218a3900c2))
* **dist:** Claude Code and Codex plugin files generated into the release stage (.claude-plugin/plugin.json + hooks/claude.json from buildHookEntries, root plugin.json + .codex-plugin/plugin.json + hooks/codex.json from CODEX_SPECS, never hooks/hooks.json), the two marketplaces (.claude-plugin/marketplace.json, .agents/plugins/marketplace.json → branch plugin), the hook names the skill ukagai:ukagai-explain inside a plugin, install / doctor detect an enabled ukagai plugin and drop the settings-side hooks and skill copy (--force keeps them), the release workflow pushes the stage tree to branch plugin; tests ([155d7df](https://github.com/Asugawara/ukagai/commit/155d7dfa243fb362cc853a594314c6c289c8a751))
* **dist:** install.sh (versioned install under ~/.local/share/ukagai with SHA256 verification, symlink swap, prune, --lang / --codex / --claude pass-through), scripts/build-release.sh staging the release tarball with production node_modules, MIT LICENSE, third-party licence list, package.json metadata ([dd5abff](https://github.com/Asugawara/ukagai/commit/dd5abffc0fe251e588765f1d5f42b9489f46da74))


### Bug Fixes

* **dist:** doctor --settings ignores the user-level plugin, the plugin branch is built from the release tag, Codex plugin detection accepts literal keys and the dotted / inline TOML forms, Claude plugin detection follows the settings precedence (local, project, user), install --dry-run names an enabled plugin, the stage script fails without write-plugin-files.mjs, tests strip the plugin env ([cfbaafc](https://github.com/Asugawara/ukagai/commit/cfbaafc83feb72eed1a96092bd2e52766dc420dc))
* **dist:** install.sh forwards --data-dir, checks the bin link before downloading, treats node-path failures as warnings, records the resolved node path, uses https-only curl / wget flags and a connect timeout, warns under root, spares young .tmp dirs, hints at a development server, UKAGAI_PORT for the healthz probe, --help on stdout; the launcher bounds the login-shell fallback without timeout(1), knows fnm's macOS directory and tolerates spaced SessionStart JSON; /healthz reports cli only when the file exists; GNU tar mtimes from SOURCE_DATE_EPOCH or the last commit; release workflow has issues: write; package workflow waits for the mirror and checks the fail-open stdout; an install.sh test suite against a local mirror; tests that can fail ([70ba9f2](https://github.com/Asugawara/ukagai/commit/70ba9f203e9c136a8758ac6616b659bc6cb763f8))
* **gui:** the header's pending button shows the count only (☰ N) with an accessible name, no "Pending" / "保留" word; tests and GUI notes ([61a6e0f](https://github.com/Asugawara/ukagai/commit/61a6e0f915feda652d806ce62bbbabd8ffa3dd26))
* **hook:** the hook's request and healthz timeouts use a referenced timer instead of AbortSignal.timeout, whose unref'd timer let a hanging request end the event loop before the abort fired (the autostart tests were cancelled on Node 22 in CI) ([a778371](https://github.com/Asugawara/ukagai/commit/a778371988a4a724b09aaca6c77ad4086ea305ec))
