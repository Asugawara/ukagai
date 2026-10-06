# Verification 06: a harness wake-up turn does not produce a new progress card

- Date: 2026-10-06
- Build: main `87e4889` (hook posts `wakeup: true` on a `UserPromptSubmit` whose prompt carries a task notification; the store does not count that turn as progress), serve restarted at 11:16 JST; hooks installed by `install --lang ja`
- Session: a Claude Code session that keeps a background `Monitor` task and is woken by the harness every 10 to 30 minutes without any human input. Before this build it had produced 131 progress cards with the same recap (one per wake-up)
- No code was changed for this check

## Results

| Time (UTC) | Hook event | Note |
|---|---|---|
| 02:10:09 | UserPromptSubmit (old hook, no flag) | last wake-up before the build; a new card was created at 02:13:19 as before |
| 02:25:18 | UserPromptSubmit `wakeup: true` | first wake-up with the new hook (two other sessions woken in the same second carried the flag too) |
| 02:25:37 | Stop | the agent re-armed its monitor and ended the turn |
| 02:26:37 | Notification | |
| 02:28:40 | SubagentStop | the recap watcher ran on this event |
| 02:28:40 | `serve.log`: `checkpoint_skipped` `reason: no_progress` | **no new card**; `decisions.jsonl` has no checkpoint for the session after 02:25 |

- Only the boolean reached the server: the event line carries `wakeup: true` and no prompt text.
- The first `checkpoint_skipped` with `no_progress` ever written to `serve.log` is this one: before this build every wake-up cycle counted as progress.
