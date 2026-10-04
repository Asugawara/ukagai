# Codex bridge spec

`ukagai serve` contains a second client of the Codex app-server. It covers two things the hooks cannot reach: the plan approval ("Implement this plan?") and progress checkpoints (below). Questions and command approvals stay on the hook route (`hook --agent codex`). Research record: D1 (`docs/verification/02-codex-hooks.md`, last section).

## Connection

- Socket: `<CODEX_HOME>/app-server-control/app-server-control.sock` (`CODEX_HOME` = `--codex-home`, else `$CODEX_HOME`, else `~/.codex`). It is a symlink to the managed daemon's unix socket, speaking WebSocket; no authentication beyond the socket's mode (0600). The bridge uses the real path (`ws+unix://<realpath>`) and refuses a path that is not a socket or is 104 bytes or longer.
- At start, if the socket exists the bridge connects; if not it checks again every 30 s. `serve` never fails because of the bridge.
- Handshake: `initialize {clientInfo:{name:"ukagai"}, capabilities:{experimentalApi:true}}` → `initialized` → `thread/loaded/list` → `thread/resume {threadId, excludeTurns:true}` for each thread. `resume` never passes `config` / `model` / `sandbox` (it would change the user's thread).
- A thread that fails to resume (typically "no rollout found" before its first message) is retried on its next `thread/status/changed` with `status.type == "active"`. Threads announced with `ephemeral: true` (title generation) are never resumed.
- On disconnect (1006 etc.) the bridge reconnects with a backoff of 1, 2, 4 … 30 s and starts again from `thread/loaded/list`. A user's own Codex daemon is only touched when the user points the bridge at it: `serve` run programmatically (`start()`) does not start the bridge unless `codexBridge: true`.
- `--no-codex-bridge` turns it off. Log: `<data-dir>/codex-bridge.log` (JSON lines, ids and error text only, 1 MiB rotation like `hook.log`).
- Unknown fields and methods are ignored (the daemon may be newer than the CLI). Server requests (`item/tool/requestUserInput`, `…/requestApproval`) are logged (`server_request_ignored`) and **never answered**.

## Events → decision

Per thread the bridge remembers the last `collaborationMode.mode` and `settings` (from `thread/settings/updated.threadSettings.collaborationMode`, or the `thread/resume` result), the cwd and a title (`thread.name`, else `thread.preview`).

1. `item/completed {type:"plan", text}` — the text is kept under its `turnId`.
2. `turn/completed` for that turn: if the thread's mode is `plan`, register one `approve_plan` decision. In `default` mode nothing is registered (`plan_ignored` in the log). One decision per turn (`tool_use_id = codex-plan:<threadId>:<turnId>`, so a replay or a restart does not register twice).

The decision:

| Field | Value |
|---|---|
| `kind` | `approve_plan` |
| `session` | `{ session_id: <threadId>, cwd, transcript_path: "", agent: "codex", title }` (`session_id` equals the `session_id` of Codex hook input, so hook events and bridge decisions belong to one session) |
| `request` | `{ plan: <text>, planFilePath: "" }` (Codex has no plan file; the empty string keeps the shape the TUI parses) |
| `explanation` | `path: ""`, `reversibility` / `scope` read from the plan's "Scope and reversibility" section (left out when absent), `attached_via: "first_call"`, `markdown`: only the note below (both UIs print `request.plan` first and append `explanation.markdown` when it differs, so the plan is not repeated) |

The note (Japanese when `config.json` says `ja`): *Codex's own 'Implement this plan?' popup stays open in the terminal after you decide here; choose 'No, stay in Plan mode' there (a second 'Yes' would run the plan twice).*

## Human answer → Codex

The bridge waits on the decision like the hook does (`Store.wait`, 25 s long polls, which also keeps the lease alive). When it becomes `answer_submitted`:

| Answer | Sent |
|---|---|
| Approve, Approve and auto | `turn/start {threadId, input:[{type:"text", text:"Implement the plan.", text_elements:[]}], collaborationMode:{mode:"default", settings:{model, reasoning_effort, developer_instructions:null}}}` |
| Reject with a reason | the same with `mode:"plan"` and the reason as the text |
| Reject with a blank reason | nothing is sent |

`model` / `reasoning_effort` are the thread's last known values. After a successful send (or after deciding to send nothing) the decision is acknowledged: `answered`. If `turn/start` fails or the socket is down, the decision becomes `answer_lost` (the terminal popup still works). "Answer in the terminal" (`fallback`) sends nothing.

## Withdrawal

If the terminal moves first the pending plan decision of that thread becomes `cancelled` with `status_reason: "answered_elsewhere"` (the GUI shows its usual cancelled toast). Triggers: `turn/started` of any turn other than the plan's own, or `item/started userMessage` whose text is `Implement the plan.`. An `answer_submitted` decision is never withdrawn. "No, stay in Plan mode" in the terminal produces no event: that decision stays pending until the next turn on the thread.

## Progress checkpoints

Claude Code has a session recap; Codex has none, so the bridge makes the equivalent: a completed turn followed by `codexCheckpointDelayMs` (`ServeOptions.codexCheckpointDelayMs`, default 180 000 ms) without a new turn. The decision is the ordinary `checkpoint` kind (`docs/spec/api.md`), created with `store.createCheckpoint`; nothing waits on it.

Detection:

1. `item/completed {type:"agentMessage", text, phase}` — the last one of a turn is kept under its `turnId` (a `final_answer` wins over `commentary`; `turn/completed.turn.items` is the fallback).
2. `turn/completed`: arm a timer. Not armed for an `ephemeral` thread, for a turn without an agent message, for a plan turn (the `approve_plan` card covers it), for a turn seen while the bridge attaches or resumes the thread (a replay), or twice for the same turn. When the timer fires with no turn running and the socket up, the checkpoint is created: `session = { session_id: <threadId>, cwd, transcript_path: "", agent: "codex", title }`, `recap` = the agent message (trimmed, 2 000 characters at most, `…` when cut), `recap_at` = when `turn/completed` was seen.
   - **Thread lifetime.** `thread/closed` and the Codex `SessionEnd` hook both end the thread for the bridge: the timer and the thread's waiting instruction are dropped, the thread's pending checkpoint is cancelled (`status_reason` `thread_closed` / `session_end`), the thread is forgotten (logs `thread_closed` / `session_ended` with the thread id), and late events of it arm nothing until its next `turn/started` or `thread/started`. `SessionEnd` reaches `serve` as a session event (`session_id` = thread id, `agent: "codex"`). It arrives when Codex shuts the session down, which may be minutes after the TUI quit (the daemon keeps an idle thread loaded for `thread_unload_delay_secs`); it is not a signal that fires at quit. `install --codex` registers `SessionEnd` (timeout 3 s). Every `thread/*` / `turn/*` notification the bridge does not handle is logged as `bridge_notification {method, thread}` (to look for a signal that the TUI is gone).
   - **Loaded check.** When the timer fires the bridge lists `thread/loaded/list` (params `cursor` / `limit`, result `data` ids + `nextCursor`, all pages) and skips with `checkpoint_skipped` `reason: "not_loaded"` when the thread is missing (a daemon restart). The daemon still lists a thread after its TUI quit, so this does not replace `SessionEnd`. If the list cannot be read (`loaded_check_failed`) the checkpoint is created anyway.
   - **TUI check.** The daemon keeps a thread loaded after its TUI quits and sends no notification (measured on 0.160.0: still listed ~45 min later; `SessionEnd` did not fire within 25 min), so after the loaded check the bridge asks whether a Codex TUI is running in the thread's folder (`src/serve/codex-bridge/tui-probe.ts`, `tuiRunningIn(cwd)`). It lists processes with `ps -axo pid=,command=` (no shell, 5 s timeout), keeps those whose executable (or the one after `node`) is `codex`, `codex.js` or `codex-*` and whose arguments lack `app-server` (the daemon and an IDE extension's server are not TUIs), reads each cwd (Linux `/proc/<pid>/cwd`, macOS one `lsof -a -p … -d cwd -Fn`) and compares `realpath`s with the thread's cwd (`/tmp` vs `/private/tmp`). No match → `checkpoint_skipped` `reason: "tui_gone"`; the thread is not forgotten, so `codex resume` (a new `turn/started`) arms normally. `undefined` (unsupported platform, `ps` / `lsof` failed or timed out, empty thread cwd) → the checkpoint is created. The same epoch / connection guards apply after this await as after the list.
   - **After a stop.** The turn started by a `stop` answer's text (id from the `turn/start` response; also when it was queued) and the turn it interrupted arm nothing (tracked as turn ids, so a turn that never completes cannot suppress later ones): `checkpoint_skipped` `reason: "after_stop"`. A turn the human starts later arms normally.
3. `turn/started` on the thread stops the timer and cancels the thread's pending checkpoint (`status_reason: "new_prompt"`). A newer checkpoint supersedes an older one as usual (`superseded`).

Delivery (in-process: the store calls the bridge when a checkpoint of a `codex` session is answered; the Claude-only `hook --checkpoint` never runs for Codex):

| Answer | Sent |
|---|---|
| `continue` | nothing |
| `instruct` | `turn/start` with the human's text, `collaborationMode.mode: "default"` and the thread's last model / effort (like "Implement the plan.") |
| `stop` | `turn/start` with `The human asked you to stop. Write a short status (done / in progress / next) and end your turn.` + a blank line + the human's text when present |

If a turn is running (`turn/started` without `turn/completed`) `turn/interrupt {threadId, turnId}` (verified in the daemon's schema, `codex app-server generate-json-schema --experimental`) is sent first. If the daemon answers that the method is unknown, the text is queued and sent at the thread's next `turn/completed`; any other interrupt error is logged and the `turn/start` is still sent. After a successful send the instruction is consumed (`delivered_at` is set and `decision.updated` emitted, so `GET /api/sessions/:id/instruction` returns 404). If the send fails or the socket is down the decision becomes `answer_lost` (log: `checkpoint_deliver_failed`). Log events: `checkpoint_created`, `checkpoint_skipped` (`reason`: `no_agent_message`, `not_connected` (also when the socket went while the loaded list was in flight), `not_loaded`, `tui_gone`, `after_stop`), `checkpoint_queued`, `checkpoint_delivered`, `turn_interrupt_failed`.

Limits: the TUI check matches the process's own cwd, so a Codex started with `--cd` / `-C <dir>`, `codex resume --all` from another folder, or a non-CLI client of the daemon never matches and its thread gets no checkpoint (`tui_gone` logs the `cwd` compared); an answer given while the bridge is disconnected is `answer_lost`; a restart of `serve` drops a queued (not yet sent) instruction; `turn/start` straight after `turn/interrupt` is not synchronised with the interrupted turn's own `turn/completed`.

## Known limits (accepted)

- The terminal popup is not dismissed and not de-duplicated by an outside `turn/start`: a later "Yes" there starts a second turn. That is why the note is shown.
- Plan mode is only visible through `thread/settings/updated` / the resume result; a plan finished before the bridge attached its thread is not registered.
- Restarting `serve` drops the bridge's waiters: pending plan decisions then time out like any decision whose hook disappeared (`hook_disconnected`).
- Only `codex` sessions that use the managed daemon are reachable (see D1: a TUI started with `-c` overrides outside Codex's allow-list, and the VS Code extension, run their own server).
- `features.default_mode_request_user_input` is not written by ukagai (under development in Codex). To get questions in Default mode, add it to `config.toml` yourself.
