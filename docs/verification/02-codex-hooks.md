# Verification: Codex CLI hooks (`hook --agent codex`)

Codex CLI 0.159.3 (gpt-5.6-sol), macOS, exec mode. Nothing was written to `~/.ukagai`, `~/.claude`, `~/.codex` or port 4818.

## How to run by hand

`install --codex` does not exist yet (the hook-trust hash is still being researched), so hooks are passed inline and trust is bypassed:

```sh
perl -e 'alarm 150; exec @ARGV' codex exec --json -s read-only --ephemeral --ignore-user-config \
  --dangerously-bypass-hook-trust -C <tmp project dir> --skip-git-repo-check \
  -c 'hooks.PreToolUse=[{hooks=[{type="command",command="node <repo>/dist/cli.js hook --agent codex --server http://127.0.0.1:<port> --data-dir <tmp data-dir>"}]}]' \
  "<prompt>" < /dev/null
```

- `< /dev/null` (otherwise exec waits on stdin); `perl alarm` as the time limit (macOS has no `timeout`).
- Start the server on a spare port with a temporary data dir: `node dist/cli.js serve --port <port> --data-dir <dir>`.
- Add `hooks.Stop=[…]` / `hooks.SessionStart=[…]` the same way to cover those events.

## Result: request_user_input answered through the API

Harness: an ephemeral server (temp data dir, temp home) in-process, a wrapper command that first copies a valid explanation to `<data-dir>/explain/<session_id>/e.md` (the session id is only known at call time; a real agent writes it after the first deny) and then runs the real hook, and a poller that answers the pending decision through `POST /api/decisions/:id/answer` in place of the GUI.

```
PENDING {"questions":[{"question":"A or B?","header":"Choice","options":[{"label":"A (Recommended)",...},{"label":"B",...}],"multiSelect":false,"id":"choice"}]} agent=codex
ANSWERED via API: B
stderr: ERROR codex_core::tools::router: error=Tool call blocked by PreToolUse hook: The human answered in the ukagai GUI: A or B? = B. Do not ask again; continue with this answer.. Tool: request_user_input
{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"CHOSEN=B"}}
```

The decision was registered with `session.agent: "codex"` and an empty `transcript_path`; the model's final output reflects the API answer (`CHOSEN=B`). The deny shows up as an ERROR line on stderr; it is expected.

## Unit tests

`test/hook/codex.test.ts` uses the saved real stdin in `test/fixtures/codex/` (PreToolUse × request_user_input, Stop with / without `stop_hook_active`, SessionStart / UserPromptSubmit / Bash PreToolUse) against a real in-process server.

## Not verified

- Interactive TUI (Default-mode `request_user_input`, PermissionRequest, Plan mode); only exec was run.
- Stop → `decision: block` with a human answer was only tested with fixtures + API (C0 verified the Codex side of the block continuation).
- Hook trust for a persistent install; Codex rollout (`~/.codex/sessions`) format, so GUI history is empty for Codex.
- SessionStart `additionalContext` contract on Codex (same shape assumed; its text still says "AskUserQuestion" / "skill ukagai-explain").
