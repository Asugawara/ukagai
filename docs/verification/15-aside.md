# Verification 15: side questions through a forked session

- Date: 2026-10-24
- Build: branch `feat/aside-questions` (`329dadd`). Section 1 ran the CLIs directly, before the feature was implemented; no ukagai code was involved.
- Versions: Claude Code 2.1.310 (probe model haiku), Codex CLI 0.162.1, node v24.11.0, Darwin 24.6.0
- Setup: a throwaway session was created for each probe and forked. Before and after each fork, the sha256 of the original transcript (Claude Code) or rollout (Codex) was compared, and the session directories were checked for new files.

## 1 Fork probe (before implementation)

Six forks, all answered correctly. In every case the original transcript or rollout kept its sha256, and no new session or rollout file was created.

| What was checked | Answer | Original file | New file | Cost / tokens |
|---|---|---|---|---|
| Claude: fork with `--tools Read,Grep,Glob` | Correct | Unchanged | None | cache read 14,310 / created 11,737, $0.0038 |
| Claude: fork with `--allowedTools Read,Grep,Glob` (tool list same as the original) | Correct | Unchanged | None | cache read 17,808 / created 9,930, $0.0034 |
| Claude: fork without disabling hooks | Correct | Unchanged | None | The user's `SessionStart:fork` hook ran 3 times, so **hooks must be disabled** |
| Claude: fork of a session stopped in a `PreToolUse` hook (the real situation) | Correct; the pending command was not run | Unchanged | None | cache read 0 / created 27,755, $0.0056. The original session finished normally after the hook returned |
| Codex: `exec fork --ephemeral` | Correct | Unchanged | None | input 32,312 / cached 15,872 |
| Codex: fork of a turn while a command was running | Correct. stderr shows `Custom tool call output is missing for call id …`, but the answer is returned | Unchanged | None | Not recorded |

- Keeping the tool list the same as the original session reuses the cache better. So the probe does not narrow tools with `--tools`. It uses `--allowedTools` and `--permission-mode dontAsk` to refuse everything except reads.
- `--allowedTools` takes a variable number of arguments, so the question is always passed on stdin. Passing it as an argument made the question text get read as a tool name.
- In a real session, input tokens grow with the length of the session. When several questions are asked in a row about the same matter, the cache written by the previous question should be reused.

The commands the implementation uses (cwd = the session's working directory; the question goes on stdin):

```sh
# Claude Code
claude -p --resume <session_id> --fork-session --no-session-persistence \
  --output-format stream-json --verbose --include-partial-messages \
  --allowedTools Read,Grep,Glob --permission-mode dontAsk \
  --settings '{"disableAllHooks":true}' [--model <model of the last assistant turn in the transcript>]
```

```sh
# Codex
codex exec fork <session_id> --ephemeral --json --skip-git-repo-check --disable hooks \
  -c sandbox_mode="read-only" -c approval_policy="never" -
```

## 2 Real environment

Filled in from the real-environment check.
