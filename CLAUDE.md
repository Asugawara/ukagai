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

- `docs/guide.md` — the user guide (the details the README links to)
- `README.md` / `README.ja.md` — keep them in sync (same structure, same images)
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

- `main` is protected on GitHub: no direct push, no force push, no deletion; a pull request with green CI (`test (ubuntu-latest)`, `test (macos-latest)`, `lint-sh`, `gitleaks`) is the only way in, for admins too. Flow: rebase the branch onto `main`, push it, `gh pr create`, wait with `gh pr checks <n> --watch`, then `gh pr merge <n> --merge` (merge commits only; squash and rebase merges are disabled in the repository settings).
- Rebase before merging: release-please walks the history by commit date and stops at the last release commit, so older-dated commits on an unrebased branch are left out of the changelog.
- Conventional commit subjects on the branch commits (`feat:`, `fix:`, `docs:`, `ci:`, `test:`, `chore:`); the merge commit's subject stays `Merge …` so release-please does not count a change twice.
