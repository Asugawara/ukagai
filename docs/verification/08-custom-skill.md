# Verification 08: the agent reads the human's edited skill without a permission prompt

- Date: 2026-10-09
- Build: branch `feat/settings-skill` (`7984448`), `npm run build`
- Versions: Claude Code 2.1.295 (haiku), codex-cli 0.159.3, node v24.11.0, Darwin 24.6.0
- `<tmp>` is a scratch directory; `<data-dir>` is `<tmp>/D` (with a custom skill) or `<tmp>/Dempty` (control); `<scratchpad>` is the session scratchpad Claude Code reports in the hook input. Claude Code ran with `--setting-sources project` and a temp cwd, so the user's own hooks and plugins did not fire; Codex ran with a temp `CODEX_HOME`. No real `~/.ukagai`, `~/.claude/settings.json` or `~/.codex` was written. No code was changed for this check

## Results

| # | Check | Result |
|---|---|---|
| 1 | Claude Code, interactive, `--permission-mode default`: the custom skill is read without a prompt and its added line reaches the agent | ✓ |
| 2 | Claude Code, headless `claude -p`: same | ✗ by design: no scratchpad, so the data-dir file asks for a read permission |
| 3 | Control without a custom version | ✓ (the context names the skill, no file) |
| 4 | Codex `codex exec`: reads `<data-dir>/skill/SKILL.md`, not stopped | ✓ |

## Setup

- `<data-dir>/skill/SKILL.md` = `skills/ukagai-explain/SKILL.md` with `- Always put the word PERSIMMON-42 in the title of every explanation.` added after `# ukagai-explain` (line 8).
- Claude settings file (`--settings`) with only SessionStart: the hook `node <repo>/dist/cli.js hook --data-dir <data-dir> --no-autostart --managed-by ukagai`, plus `sh -c 'cat > <tmp>/hook-input.json'` to see the hook input.

## 1. Claude Code, interactive

```
$ cd <tmp>/cwd
$ claude --model haiku --permission-mode default --setting-sources project --settings <tmp>/settings-custom.json
> Your SessionStart context names a skill file for writing explanations. Read that file with the Read tool and quote the line that contains PERSIMMON. If you cannot read it, say exactly why.
```

- The status line shows manual mode (default permission mode).
- SessionStart hook input keys: `cwd, hook_event_name, model, scratchpad_dir, session_id, source, transcript_path`.
- The hook copied the file to `<scratchpad>/ukagai/skill/SKILL.md` (byte-identical to `<data-dir>/skill/SKILL.md`, `cmp`), and the context named that path.
- Transcript: `tool_use Read <scratchpad>/ukagai/skill/SKILL.md` → `tool_result` without `is_error`: allowed, no prompt.
- Answer: `The skill file is readable. Its PERSIMMON line is on line 8: - Always put the word PERSIMMON-42 in the title of every explanation.`

## 2. Claude Code, headless (`claude -p`): the limit

```
$ claude -p --model haiku --permission-mode default --setting-sources project --settings <tmp>/settings-custom.json --output-format stream-json --verbose "<same prompt>"
```

- SessionStart hook input keys: `cwd, hook_event_name, session_id, source, transcript_path`: **no `scratchpad_dir`** (UserPromptSubmit, PreToolUse and Stop also have none). The hook therefore named `<data-dir>/skill/SKILL.md` itself.
- `Read <data-dir>/skill/SKILL.md` was refused: `Claude requested permissions to read from <data-dir>/skill/SKILL.md, but you haven't granted it yet.` (listed in `permission_denials`); the agent said it could not read the file.
- Consequence: in a session without a scratchpad the human's version is only visible to the agent when that directory is readable (for example `--add-dir <data-dir>`). This is the documented fallback (`docs/spec/explain.md` section 8.2), not a bug.

## 3. Control

With an empty data dir the SessionStart context is 5 lines and names the skill, not a file; there is no "edited version" sentence. (The agent said the context names `ukagai-explain` but gives no path.)

## 4. Codex

```
$ node dist/cli.js install --codex --codex-home <tmp>/CH --data-dir <data-dir> --no-autostart --lang en
codex:  <tmp>/CH/hooks.json (PreToolUse, PermissionRequest, Stop, SessionStart, SessionEnd)
trust:  5 hook(s) trusted in <tmp>/CH/config.toml
$ cd <tmp>/cwd; CODEX_HOME=<tmp>/CH codex exec --skip-git-repo-check --json "Your SessionStart context names a rules file written by the human for writing explanations. Read that file (use a shell command such as cat) and quote the line that contains PERSIMMON. If you cannot read it, say exactly why."
```

- The hooks ran headless because the install had trusted them in the temp home (`src/install/codex-trust.ts`). Authentication was a copy of the auth file in the temp home, deleted afterwards.
- Events: `command_execution` `cat <data-dir>/skill/SKILL.md` (the path from the SessionStart context) completed with the file content; no approval event; final message: `- Always put the word PERSIMMON-42 in the title of every explanation.`
- Codex's default sandbox can read that path, so "not stopped" is not a special exemption. A Codex control run without the custom version was not done.

## Side effects

Answering Claude Code's folder-trust prompt for the temp cwd stored one project entry for it in `~/.claude.json`. Temp directories and the test transcripts were deleted.
