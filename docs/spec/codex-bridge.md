# Codex bridge spec

`ukagai serve` contains a second client of the Codex app-server. It covers one gap the hooks cannot reach: the plan approval ("Implement this plan?"). Questions and command approvals stay on the hook route (`hook --agent codex`). Research record: D1 (`docs/verification/02-codex-hooks.md`, last section).

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

## Known limits (accepted)

- The terminal popup is not dismissed and not de-duplicated by an outside `turn/start`: a later "Yes" there starts a second turn. That is why the note is shown.
- Plan mode is only visible through `thread/settings/updated` / the resume result; a plan finished before the bridge attached its thread is not registered.
- Restarting `serve` drops the bridge's waiters: pending plan decisions then time out like any decision whose hook disappeared (`hook_disconnected`).
- Only `codex` sessions that use the managed daemon are reachable (see D1: a TUI started with `-c` overrides outside Codex's allow-list, and the VS Code extension, run their own server).
- `features.default_mode_request_user_input` is not written by ukagai (under development in Codex). To get questions in Default mode, add it to `config.toml` yourself.
