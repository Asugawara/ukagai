# ukagai

A tool that intercepts Claude Code's decisions (AskUserQuestion / ExitPlanMode) with hooks and lets a human answer them together in a GUI.

## Approach

Built with hooks + skill + GUI, without MCP.

## Stack

TypeScript (ESM, NodeNext), Node >= 22, npm, Hono + `@hono/node-server`, zod, `node:test` + `tsx`. The UI is static HTML / JS with no build step (`public/`).

## Commands

- `npm run build` — emit to `dist/` with `tsc`
- `npm run typecheck` — type check only
- `npm test` — run `test/**/*.test.ts`
- `npm run dev:serve` — `tsx src/cli.ts serve`
- `npm run release:stage` — `sh scripts/build-release.sh <version> out` (stage the release tree, tarball, SHA256SUMS). `bin/ukagai` and `install.sh` must stay POSIX sh (check with `shellcheck -s sh`)

## Docs

- `docs/strategy/03-*`, `04-*` — the implementation plans (MVP, distribution); 00 / 02 were removed before publication
- `docs/spec/` — contracts (API, explanation file)
- `docs/verification/` — records of real-environment verification

## Language

English is the default for code, comments, tests, docs, the skill, CLI output and everything the hook says to the agent. Only the GUI / TUI display language is selectable (`en` | `ja`), stored in `<data-dir>/config.json` by `install --lang`.

## Don'ts

- Do not write hooks directly into `.claude/settings.json`. During development, use a separate file via `--settings <file>`.
- Keep the `hook` subcommand fail-open (on failure, print nothing and exit 0).
- Do not add `hooks/hooks.json` to the plugin tree. Codex would read the Claude hooks from it; the plugin's hook files are `hooks/claude.json` and `hooks/codex.json`.

## Commits

- Before merging a branch into main with `--no-ff`, rebase it onto main. release-please walks the history by commit date and stops at the last release commit, so older-dated commits on an unrebased branch are left out of the changelog.
