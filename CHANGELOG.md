# Changelog

## [0.2.0](https://github.com/Asugawara/ukagai/compare/v0.1.1...v0.2.0) (2026-10-09)


### Features

* **doctor:** report a custom skill version and whether the default changed since editing started; the settings guide and READMEs describe the sidebar and the Skill pane ([0478bef](https://github.com/Asugawara/ukagai/commit/0478bef60376b32d78a8070ecef4c44fc858f279))
* **hook:** SessionStart / SubagentStart copy the skill's reference/ into &lt;scratchpad&gt;/ukagai/skill/reference/ and the context names it ([7e6d247](https://github.com/Asugawara/ukagai/commit/7e6d247592e435f83091b5ad7affb5fdd06d9d6c))
* **hook:** when the user saved their own skill version, the SessionStart, plan-mode and deny texts point at it (Claude: a copy in &lt;scratchpad&gt;/ukagai/skill/ so no read prompt; Codex: the data-dir file), fail-open ([fb7acda](https://github.com/Asugawara/ukagai/commit/fb7acda2bafc762950aa46e51461d89d63998611))
* **install.sh:** only --version and --force; register on first install, refresh on upgrade ([2e9698e](https://github.com/Asugawara/ukagai/commit/2e9698ea3ab8514a429ed2b569b67fac37ff91a5))
* **install:** place and remove the whole skill directory (SKILL.md + reference/) instead of SKILL.md alone ([bdf2015](https://github.com/Asugawara/ukagai/commit/bdf2015a2e06da3759b7cba79d1153a0312408c0))
* **install:** register every agent found; re-registering keeps the registered options; the language comes from the locale and the Settings page ([e6bab78](https://github.com/Asugawara/ukagai/commit/e6bab78dd69d8cd125a3af291d5a5c28391f98d3))
* **serve:** a relative image / HTML path in a plan-block explanation or a plan approval is also resolved against the decision session's &lt;scratchpad&gt;/ukagai, after ~/.claude/plans; every candidate passes the same root / scratchpad checks, the standalone explanation scope and the plan= drawer are unchanged; spec and public/README updated ([1ae233f](https://github.com/Asugawara/ukagai/commit/1ae233fdd6fd81c5e0f045d884a322b259e20c4b))
* **serve:** the user's own version of the ukagai-explain skill in &lt;data-dir&gt;/skill/ (SKILL.md, base.md, meta.json) with GET / PUT / DELETE /api/skill and the skill.updated event ([4e536f3](https://github.com/Asugawara/ukagai/commit/4e536f3dac320fc165e4cfeca3c90bc55d4db449))
* **settings:** GitHub-style sidebar (General, Notifications, Plans, Progress checkpoints, Skill) with hash routing; Lucide icons vendored in public/icons.js; the back link drops the arrow glyph ([ebe7fce](https://github.com/Asugawara/ukagai/commit/ebe7fce775b201ca2fd8cb4b7bc2efa78a5f4f5e))
* **settings:** the Skill pane edits the whole ukagai-explain text (Edit / Preview / Diff from default tabs, Save with Cmd/Ctrl+S, Discard, Reset to default on a second click, unsaved indicator, live update from other tabs); the sanitizer moves to public/sanitize.js for both pages ([9ed0912](https://github.com/Asugawara/ukagai/commit/9ed09121035ab9fc3f06806d1b5bc1f3d175fd67))


### Bug Fixes

* **hook:** plan mode may write the scratchpad — mockups and screenshots go to &lt;scratchpad&gt;/ukagai and are referenced by absolute path from a plan; a visual choice is asked with AskUserQuestion before ExitPlanMode, never scheduled after approval; skill and spec aligned, the old 'only file you may write' / 'write no image' wording is gone and a test keeps it out ([c829170](https://github.com/Asugawara/ukagai/commit/c8291709236de0af526e77eba7dcba0f059eb327))
* **install:** trust keys under a symlinked parent of a missing Codex home; config.json in the registered data dir; nothing written when every agent failed ([75a3f43](https://github.com/Asugawara/ukagai/commit/75a3f43e3599ef32eeeee578501a49602c495f86))
* **install:** uninstall and the plugin cleanup report only what they removed, and remove an empty leftover skill directory; tests for the symlinked-checkout guard, the Codex no-copy path and the no-scratchpad path ([2a094b9](https://github.com/Asugawara/ukagai/commit/2a094b93fbbf8152083941268e944b509f7ee8ce))
* **settings:** deny reasons name only the custom skill path so real scratchpad paths no longer truncate Missing and the retry sentence; the Skill pane shows the real data-dir path from GET /api/skill; no false 'newer version' notice on reconnect; typing during a save is kept; hook-level deny tests and polling SSE tests ([38aa708](https://github.com/Asugawara/ukagai/commit/38aa7086719ac8aa1e34312a9715f735d50dc653))
* **settings:** no layout shift: the page shows once the sidebar and pane head are built, the scrollbar gutter is reserved, every pane shares one title and lede block, the Skill views have one fixed height, bold labels and the reset text keep their width, and late slots (path, saved time, newer-version notice) are reserved from the first paint; a GUI test measures the layout-shift score on load and pane switches ([5b72c0a](https://github.com/Asugawara/ukagai/commit/5b72c0a71df5e27c4baf5eddc8562afe4c5e6f22))
* **skill:** the passing example's diagram is a real sequence (the old 3-node flowchart passed only because dotted edges are not parsed); the table rule names the required columns; checks.md in the hook's report order with the recommend_name short forms and the phase-word conditions; writing.md gets an English headline pair; the skill test runs the validator on the examples, pins the LIMITS numbers and the one-link-per-reference rule ([8bb2a0d](https://github.com/Asugawara/ukagai/commit/8bb2a0da9d4a7110f7c4d613bea95834e5db5772))

## [0.1.1](https://github.com/Asugawara/ukagai/compare/v0.1.0...v0.1.1) (2026-10-08)


### Bug Fixes

* **install:** uninstall stops the server once no ukagai hooks remain (left running after a Claude-only or Codex-only uninstall; skipped for --settings / --project; dry-run says what it would do), doctor reports a server that never ran as 'not started yet' instead of two problems, README and guide say --codex --claude for both agents, what doctor shows after install, and that ~/.ukagai is kept on uninstall ([58fa6b1](https://github.com/Asugawara/ukagai/commit/58fa6b181226baba04b83fa9f8408afc3ea8e0f7))
* **install:** uninstall stops the server, doctor explains 'not started yet', README says --codex --claude ([9250666](https://github.com/Asugawara/ukagai/commit/925066670a6868793f2df6db515f3bd67676514a))
* **uninstall:** when the hook check throws and no server answers, say 'not running' instead of 'still running'; tests for the --project skip and the catch path; CLAUDE.md: PR titles carry no type prefix because release-please reads them for the merge commit ([367a92d](https://github.com/Asugawara/ukagai/commit/367a92d4e48b97b7a9376ecd5dc6edb30b39661c))

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
