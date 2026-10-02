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

## Docs

- `docs/strategy/03-*` — the current implementation plan (02 is superseded)
- `docs/spec/` — contracts (API, explanation file)
- `docs/verification/` — records of real-environment verification

## Language

English is the default for code, comments, tests, docs, the skill, CLI output and everything the hook says to the agent. Only the GUI / TUI display language is selectable (`en` | `ja`), stored in `<data-dir>/config.json` by `install --lang`.

## Don'ts

- Do not write hooks directly into `.claude/settings.json`. During development, use a separate file via `--settings <file>`.
- Keep the `hook` subcommand fail-open (on failure, print nothing and exit 0).
