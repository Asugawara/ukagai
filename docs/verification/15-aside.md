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

- Date: 2026-10-24
- Build: branch `feat/aside-questions` (`3f9d7fd`; built as `329dadd`, which differs only in a test fixture), the feature as committed. No code or git writes during the run.
- Versions: Claude Code 2.1.310 (probe and answers on sonnet), Codex CLI 0.162.1, node v24.11.0, Darwin 24.6.0
- Setup: `node dist/cli.js serve` against a scratch data dir under `<tmp>`. The probe was a Claude Code session in a scratch working directory, driven from herdr; the Ask panel was driven in a browser with agent-browser, because the Claude in Chrome extension was not connected. The TUI ran in a herdr pane.
- Cost: one real answer (Claude, sonnet) used 62k tokens, about USD 0.057–0.059.

Checks: G = GUI, T = TUI, A = agent session (Claude Code), X = Codex.

| # | Check | Result |
|---|---|---|
| G1 | Plan card shows the header button 質問 (Ask), with no count (UI in Japanese) | ✓ |
| G2 | `a` opens the panel with the agent name for the cwd and 3 plan suggestions | ✓ |
| G3 | A question gets an answer with tokens and cost, and Copy / Answer again | ✓ ("Thinking…" was not captured) |
| G4 | A selected sentence becomes a quote in the selection popover; the question shows the quote | ✓ |
| G5 | The answer says it did not change anything; README sha256 unchanged | ✓ |
| G6 | Stop during an answer | ✗ not observed: the answer finished before the Stop click landed (no "Stopped" entry). Stop is covered by `test/serve/aside.test.ts` and `test/gui/aside.test.ts`; not retried |
| G7 | At 1100 px the panel overlays the options column | ✓ |
| T1 | `a` in the TUI opens the thread with the GUI's 4 Q&A entries | ✓ |
| T2 | A question gets "PONG" | ✓ (TUI pane width not measured) |
| T3 | Esc returns to the plan card | ✓ |
| A1 | Original transcript sha256 identical before and after; no new `.jsonl` in its directory | ✓ |
| A2 | Plan approved in the GUI; the probe's prompt list has no side question in it | ✓ |
| X1 | `codex exec` created a thread and answered "OK" | ✓ |
| X2 | A Codex SessionStart event sets the session's agent | ✗ deviation: the event returned 204 but the agent stayed `claude`. The agent comes from the session's decisions (real Codex questions and plan approvals carry `codex`) |
| X3 | A question to the Codex thread returns an answer with usage | ✓ |
| X4 | The Codex rollout is unchanged by the aside, and no new rollout appears | ✓ with a caveat: checked by mtime and file count, not by a sha256 taken right after X1 |

Observations:

- **G6.** The answer was short and completed before the Stop click. Stop needs a longer answer to be checked by hand; the automated tests cover it.
- **X2.** The seeded checkpoint decision with `session.agent: "codex"` set the agent (the thread then answered as Codex). The SessionStart event did not. Whether the real Codex bridge sets it differently was not checked here.
- **X3 before seeding.** The first question to the Codex thread, before the agent was set, ran as Claude against a Codex id and ended as `error_during_execution` with 0 usage. That error entry stays in the thread; the answer that followed is the X3 result.
- **A2.** The probe got its first prompt and its own list request; the side questions are not in its transcript.
- **Setup.** The probe first stopped at Claude Code's trust dialog. The trust choice is stored for the scratch working directory only.
- **Cleanup.** The probe and the Codex thread were removed after their codewords were checked. The probe's plan file was removed from `~/.claude/plans` afterwards; its `hello.txt` stayed in the scratch directory.
