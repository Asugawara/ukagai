# MVP Implementation Plan (hook + GUI approach, no MCP)

Created 2026-10-02, v2 the same day (reflecting the adversarial review; the report is saved in the work log). Replaces the technical decisions and schedule of the earlier plan (superseded). The metrics and cutoff conditions carry over from it. The basis is `docs/verification/01-askuserquestion-injection.md` (hereafter 01).

## 1. What changes in the approach

| Item | Decision in 02 | This plan | Reason |
|---|---|---|---|
| Capturing decisions | Make the agent use MCP `ask_decision` via CLAUDE.md. If unused, enforce with a hook | **A PreToolUse hook intercepts AskUserQuestion / ExitPlanMode and returns the GUI's answer via `updatedInput`.** No MCP and no CLAUDE.md instruction | Confirmed on a real machine that injection works in interactive sessions (01 T1 / T3b / T3c / T5; Claude Code 2.1.287 x Sonnet x auto mode). It needs no cooperation from the agent and captures by default (not "enforcement": the paths of asking in prose to slip away and of self-answering remain. Section 8) |
| Bandwidth of explanation | Have the agent call MCP `show_diff` / `show_diagram` / `compare_options` | **Have the agent write an explanation for humans (why this decision now, a comparison table of options, a Mermaid diagram if needed, the relevant diff) in Markdown, and the hook picks it up and renders it in the GUI.** If it asks without writing one, the hook denies with a reason and makes it rewrite. The server automatically attaches `git diff` and recent tool calls as supplementary context | This is the core of the product (gap 2 in section 3 of the superseded overview). Without MCP it should still work with a skill (how to write) + SessionStart / SubagentStart instructions (in advance) + a PreToolUse deny (as insurance). **T4 confirmed that Claude reads the deny reason and changes its behavior, but "write the file and ask the same question again" is unconfirmed. E4 is the Day 2 gate (branches in section 8)** |
| Map of status | hooks (Notification / Stop) + ACP | **Only Claude Code's observation hooks.** ACP and a second vendor come in week 2 or later | Week 1 measures only "does gathering decisions in one place make things faster" |
| Persistence | SQLite | **Append to JSONL** (`~/.ukagai/`). Restore `pending` at startup | Two weeks of decision logs need no search. Move to `node:sqlite` if it becomes necessary |
| UI | Vite + React | **Static HTML / JS with no build** (`public/`). `marked` and `mermaid` are copied from npm into `public/vendor/` and bundled | Only two card types and a list |
| Package management | pnpm | **npm** | pnpm (corepack) on this machine is not set up and `pnpm --version` fails (observed). Settled on npm in W1 |

## 2. Goals and metrics (carried over from 02, with (a) replaced and (d) added)

| Metric | How to measure | Guideline for continuing |
|---|---|---|
| (a') GUI answer rate | Numerator = `answered` (decisions the hook acked). Denominator = `answered + fallback + hook_disconnected + answer_lost + cancelled + escaped_question` (status definitions are in section 3). The server aggregates automatically | If below 90%, record the reason for each case that flowed somewhere other than the GUI and eliminate them one by one |
| (b) Time per decision | Human side = `created_at → decided_at`. Agent side = `first_denied_at → created_at` (the round trip for the explanation). Aggregated separately. **The baseline is taken on Day 3 for one day with observe mode (`hook --observe`) using the same definition** | If the human side does not get shorter than the baseline, the "bandwidth of explanation" hypothesis is wrong |
| (c) Number of pane switches | Count by hand the terminal pane switches made not only for decisions but also to check status. As a supplementary metric, use the number of times the GUI's session list panel was opened (recorded in events). **Caution: an improvement in (c) may be the effect of injection, not of the map** | If it does not halve, the "map" hypothesis is wrong |
| (d) Explanation attach rate and quality | Aggregate `explanation.attached_via` (`first_call` / `after_deny` / `none`) automatically. Plan-mode decisions are excluded from the denominator. Score 3 per day by hand for quality (whether the table and diagram helped the decision, whether the diagram is not decoration) | If `none` exceeds 10%, fix the deny reason text. If scores are low, fix the skill's guidance |

The cutoff condition stays as in 02: if neither (b) nor (c) improves, stop within two weeks. The judgment date is Day 14 (section 6).

## 3. Architecture

### Processes

```
Claude Code ──PreToolUse(AskUserQuestion|ExitPlanMode)──▶ ukagai hook ──POST /api/decisions──▶ ukagai serve ──SSE──▶ browser (GUI)
                                                              │                                    ▲                 │
                                                              ├──GET /api/decisions/:id/wait ◀─────┴── POST /answer ─┘
                                                              └──POST /api/decisions/:id/ack
                                                              ▼
                                                   stdout: allow + updatedInput  /  deny + reason  /  no output (fall back to the terminal UI)
Claude Code ──observation hooks──▶ ukagai hook ──POST /api/events──▶ serve (session list, escaped_question)
Claude Code ──PermissionRequest(Write|Edit)──▶ ukagai hook ──(only the one right after "Approve and auto" in the GUI)──▶ allow + setMode auto
```

- `ukagai serve`: `127.0.0.1:4818`. Serves the HTTP API + SSE + `public/`. State lives in memory and is appended to `~/.ukagai/decisions.jsonl` and `~/.ukagai/events.jsonl`. At startup, `pending` entries in `decisions.jsonl` are restored as `hook_disconnected`.
- `ukagai hook`: a single command called from Claude Code's hooks. It dispatches on `hook_event_name` and `tool_name`.
  - PreToolUse x AskUserQuestion / ExitPlanMode: looks for the explanation file, registers the decision, waits by long-poll until the answer, sends the ack, and then writes the hook output JSON to stdout.
  - PermissionRequest x Write / Edit: only when the server has a record that "within the last 120 seconds, 'Approve and auto' was pressed in the GUI for this session and is not yet consumed", returns allow + `setMode auto` and deletes the record. Otherwise no output.
  - SessionStart / SubagentStart (sync): returns the advance instructions for explanations via `additionalContext`.
  - Others (observation): posts to `POST /api/events` and exits immediately. On Stop, if the end of `last_assistant_message` is "？" or "?", or contains "どちら", "よろしいですか", or "教えてください", attach `escaped_question` (a rough detection that counts decisions that slipped away by being asked in prose).
  - `hook --observe`: for baseline measurement. On PreToolUse x AskUserQuestion / ExitPlanMode it outputs nothing and only posts the timestamp to `POST /api/events`; on PostToolUse x the same matcher it sends the end time. The server aggregates the difference as the baseline for (b) (PostToolUse's `duration_ms` does not include the time of permission prompts, so it is not used).
- GUI: pending list, cards (question / plan), explanation panel, supplementary context panel, session list.

### Fail-open (an MVP decision)

- Cannot connect to the server (fails within 1 second), or wait returns 404 / 5xx: output nothing and exit 0, which falls back to Claude Code's normal UI.
- When the hook's remaining time (`--budget` seconds) drops below `poll timeout + 5 seconds`, it does not poll, sends `fallback`, and exits 0. It steps down on its own before being killed by SIGTERM (in T3a nothing could be recorded after SIGTERM).
- GUI's "Answer in the terminal": the server returns `fallback`, and the hook outputs nothing and exits 0.
- Enterprise fail-closed is out of scope for the MVP.

### Contract (`src/contract.ts`, zod. The same content is written for humans in `docs/spec/api.md`)

```ts
type Decision = {
  id: string;                        // crypto.randomUUID()
  kind: "answer_question" | "approve_plan";
  tool_use_id: string;               // re-registering the same tool_use_id returns the existing one (not used to pair round trips: it changes on a re-call)
  session: { session_id: string; cwd: string; transcript_path: string; scratchpad_dir?: string;
             permission_mode?: string; agent_id?: string; agent_type?: string; title?: string };
  request: AskUserQuestionInput | ExitPlanModeInput;   // the hook's tool_input as is
  context: { branch?: string; git_status?: string; git_diff_stat?: string; git_diff?: string;
             last_assistant_text?: string; recent_tools?: { name: string; summary: string }[] };
  explanation?: { path: string; title?: string; question?: string;
                  reversibility?: "reversible" | "costly" | "irreversible";
                  scope?: "file" | "repo" | "machine" | "external";
                  markdown: string;                                   // the scratchpad is temporary, so copy it
                  has: { mermaid: boolean; table: boolean; diff: boolean };
                  match: "question" | "recency";
                  attached_via: "first_call" | "after_deny" | "none";
                  none_reason?: "plan_mode" | "loop_guard" | "not_required" };
  first_denied_at?: string;          // for after_deny, the time of the first deny (agent-side (b))
  status: "pending" | "answer_submitted" | "answered" | "fallback" | "hook_disconnected"
        | "answer_lost" | "cancelled" | "denied_explain";
  lease_until?: string;              // end of the last poll + poll timeout + 10 seconds. When it expires: hook_disconnected
  created_at: string;
  response?: { via: "gui" | "terminal";
               answers?: Record<string, string>;      // answer_question
               approve?: boolean; reason?: string;    // approve_plan
               set_mode_auto?: boolean;               // "Approve and auto"
               decided_at: string; delivered_at?: string };
};
```

State transitions: `pending` →(GUI answer)`answer_submitted` →(the hook receives wait's 200 and acks)`answered`. If the lease expires in `pending` / `answer_submitted`, it becomes `hook_disconnected`; if it expires in `answer_submitted`, it becomes `answer_lost` (the GUI shows "fell back to the terminal"). If a UserPromptSubmit / Stop for the same session arrives right after the lease expires, it becomes `cancelled`. Denied calls are also registered as `denied_explain` (not shown in the GUI), and on a re-call the most recent `denied_explain` is looked up by `session_id + agent_id + questions[0].question` to attach `attached_via: after_deny` and `first_denied_at`.

| API | Role |
|---|---|
| `POST /api/decisions` | Registered by the hook. If `tool_use_id` is the same, returns the existing one |
| `GET /api/decisions/:id/wait?timeout_ms=25000` | Long-poll. 200 + response if answered; 204 on timeout if unanswered. Updates `lease_until` at the end of each poll |
| `POST /api/decisions/:id/ack` | Confirmation that the hook received the response. This sets `answered` / `delivered_at` |
| `POST /api/decisions/:id/answer` | From the GUI. `{answers}` / `{approve:true, set_mode_auto?:boolean}` / `{approve:false, reason}` / `{fallback:true}` |
| `GET /api/decisions?status=pending` / `GET /api/decisions/:id` | List and detail |
| `POST /api/events` | Raw JSON from observation hooks (the `--observe` timestamps, Stop's `escaped_question`, consumption of PermissionRequest) |
| `GET /api/sessions` | Per-session state (working / waiting_decision / idle / ended). `waiting_decision` is set when PreToolUse registers. Notification (`permission_prompt` / `idle_prompt`) is used only to detect "stuck on the terminal side (injection did not work)" (because it fires 6 seconds / 60 seconds late) |
| `GET /api/sessions/:id/pending-mode-switch` / `POST .../consume` | The PermissionRequest hook reads and deletes the "Approve and auto" record |
| `GET /api/metrics` | Aggregates for (a')(b)(d) |
| `GET /api/stream` | SSE: `decision.created` / `decision.updated` / `session.updated` |
| `GET /healthz` | The hook's connectivity check |

Authorization and input validation (another process of the same user can get through by reading the file. That is stated as a limitation in section 7):

- At startup `serve` creates a random token and writes it to `~/.ukagai/token` (0600). The hook reads it and sends it as `Authorization: Bearer`. The GUI receives a `SameSite=Strict; HttpOnly` cookie on `GET /`, and write APIs require the cookie or Bearer.
- A `Host` other than `127.0.0.1:4818` / `localhost:4818` gets 400 (DNS rebinding countermeasure). Write APIs require `Content-Type: application/json`.
- A `transcript_path` received from the hook is read only under `~/.claude/projects/`, `explanation.path` only under `scratchpad_dir` or `~/.ukagai/explain/`, and `cwd` only if it is an existing directory. git is called as `git -C <cwd> --no-pager`, and a failure yields empty.
- Do not write the GUI's URL in deny reasons, additionalContext, or statusMessage (so Claude itself does not answer with `curl`).

The hook's output (the shapes settled by verification):

| Decision | GUI operation | stdout |
|---|---|---|
| answer_question | Choose an option | `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"questions":<original text>,"answers":{"<question>":"<label>"}}}}` (settled in T1) |
| approve_plan | Approve / Approve and auto | Same as above, with `updatedInput` being `tool_input` as is (settled in T5). "Approve and auto" is recorded on the server, and the PermissionRequest hook right after returns `setMode auto` (confirmed in E3) |
| approve_plan | Reject + a note | `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"<note>"}}` (whether Claude fixes the plan and resubmits is confirmed in E3) |
| Both | No explanation file / malformed (first time) | `deny` + reason (the missing items, the absolute save path, the original text to write in `question:`, the skill name). Registered as `denied_explain` |
| Both | Answer in the terminal / cannot connect / budget exhausted | No output, exit 0 |

### Context collection (server side, best-effort at decision registration, 500 ms cap each)

- git: `rev-parse --abbrev-ref HEAD`, `status --porcelain`, `diff --stat`, `diff` (cut off at 200 KB).
- transcript: read the last 512 KB by bytes and split into lines (a tool_result line can be hundreds of KB), and pick up the preceding assistant text (the reason that led to the question), the last 10 tool_use entries (name + the file path / the start of the command), and the `ai-title` line. If there is an `agent_id`, try the subagent's transcript first (`<dirname>/<session_id>/subagents/agent-<agent_id>.jsonl`. The path shape is a guess, confirmed in E6). The transcript can be written late (official documentation), so if it cannot be obtained, re-read once after 500 ms, and if still missing, show it empty.

### Path for explanations (agent side; the core of the product)

Have the agent write "an explanation for the human to decide with". In place of MCP, it is made to work in three layers.

| Layer | Mechanism | Role |
|---|---|---|
| How to write | skill `ukagai-explain` (the skill directory `skills/ukagai-explain/`: `SKILL.md` + `reference/`; install places it in `~/.claude/skills/`) | The format of the explanation file, guidance on what to turn into a diagram and what into a table, good and bad examples |
| Advance instruction | SessionStart and SubagentStart hooks (both sync) put three lines of instruction and the absolute save path into `additionalContext` | Raises the rate at which the first call has an explanation and reduces deny round trips. Async would only reach the next turn, so sync |
| Insurance | The PreToolUse hook looks for the explanation file, and if it is missing or malformed makes the agent rewrite it with `deny` + reason | A one-time insurance for when the instruction was not followed. That the round trip works is confirmed in E4 |

Location and format of the explanation file (to be written formally in `docs/spec/explain.md`):

- Location: **`<scratchpad_dir>/ukagai/<any name>.md`**. `scratchpad_dir` is in the hook's stdin, Claude knows its own scratchpad from the system prompt, and it should be able to write there without a permission prompt in modes other than auto (E4 checks default / acceptEdits / plan). In older versions without `scratchpad_dir`, use `~/.ukagai/explain/<session_id>/`. Do not place it inside the repository. The server copies the body into the Decision.
- Front matter: `ukagai: 1`, **`question:` (the original text of the question, exactly `questions[0].question`)**, `title`, `reversibility`, `scope`.
- Headings in the body: 「なぜ今この判断が要るか」 and 「選択肢の比較」 (a table; the advantages, disadvantages, and cost of each option) are required. 「図」 (```mermaid) is required only when `reversibility` is other than `reversible`, or `scope` is `machine` / `external`, and optional otherwise. 「関係する差分」 (```diff) only when code changes are involved. The hook cannot check Mermaid syntax, so if rendering fails the GUI shows the code as is and attaches an error.
- ExitPlanMode does not require a separate file. It only checks whether the plan body (`tool_input.plan`) has a section 「影響範囲と可逆性」 (heading matching is a partial match after normalizing whitespace, full-width / half-width, and 「と」 and 「・」). Mermaid is recommended (if absent, it is counted in (d) as `has.mermaid: false`). Denying to make it fix this happens at most once per session.
- AskUserQuestion during plan mode (`permission_mode === "plan"`) does not require an explanation file (`attached_via: none`, `none_reason: plan_mode`). It is excluded from the denominator of (d).

The hook's judgment (AskUserQuestion):

1. Among the `.md` files in `<scratchpad_dir>/ukagai/` (excluding `.used.md`), look for one whose front matter `question:` exactly matches `questions[0].question`. If none, and there is exactly one unused file written within the last 10 minutes, use it and record `match: recency`.
2. If found and the format passes, register it (`attached_via` is `after_deny` if there is a `denied_explain` within the last 2 minutes, otherwise `first_call`). Rename the used file to `<name>.used.md`.
3. If missing / malformed, `deny` + register `denied_explain`. The reason text is "a list of the missing items + the absolute save path + the original text to write in `question:` + 'write following skill ukagai-explain and ask the same question again with AskUserQuestion'". The tone (imperative, or fact + request) and the 2-minute / 10-minute values are settled by the results of E4.
4. If there is a `denied_explain` within 2 minutes for the same `session_id + agent_id + question` and it is still missing, to avoid a loop, show it in the GUI without an explanation (`attached_via: none`, `none_reason: loop_guard`). The GUI marks it "no explanation".

GUI rendering: Markdown (headings, tables, code blocks), Mermaid (`mermaid.min.js` bundled in `public/vendor/`, no CDN), diff (unified coloring).

### Registration into Claude Code (`ukagai install`)

- The default is `~/.claude/settings.json`. `--project` for `.claude/settings.json`, `--settings <file>` for an arbitrary file (use this during development so hooks are not applied to my own sessions).
- Merge without breaking existing hooks, and take `settings.json.bak-<timestamp>` before writing. `--dry-run` shows the diff. `ukagai uninstall` removes only its own registrations.
- Write the command in exec form (no shell involved, so it does not break when the path has spaces): `{"type":"command","command":"<process.execPath>","args":["<repo>/dist/cli.js","hook","--budget","<timeout - 10>"],"timeout":<timeout>,"statusMessage":"ukagai: waiting for an answer in the GUI"}`. `--budget` is derived from the settings `timeout`.
- Copy the skill directory to `~/.claude/skills/ukagai-explain/` (`SKILL.md` + `reference/`; `.claude/skills/` with `--project`). `uninstall` removes the shipped entries and the directory when it is then empty.
- Registered hooks:

| event | matcher | timeout (seconds) | sync / async |
|---|---|---|---|
| PreToolUse | `AskUserQuestion\|ExitPlanMode` | 3600 (adjust by the result of E1) | sync, with `statusMessage` |
| PermissionRequest | `Write\|Edit` | 5 | sync |
| SessionStart / SubagentStart | none | 5 | sync (to return `additionalContext`) |
| UserPromptSubmit / Stop / SubagentStop | none | 5 | async |
| PostToolUse | `Edit\|Write\|MultiEdit\|NotebookEdit` (also `AskUserQuestion\|ExitPlanMode` when `--observe`) | 5 | async |
| SessionEnd | none | 2 | sync (budget 1.5 seconds. The POST gives up at 500 ms) |
| Notification | `permission_prompt\|idle_prompt` | 5 | async |

- The dogfood target is only sessions I interact with directly. Herdr's worker panes keep running without hooks via `--settings` (while a hook is blocking, Herdr stays `working`, and the orchestrator's `agent wait` would not return until the GUI answers).

### Detailed decisions

- One AskUserQuestion holds 1 to 4 questions. Show all the cards and send after answering all of them. The `multiSelect` delimiter is made a constant and settled by the result of E2 (the official documentation says "commas").
- Free-form input is shown in the GUI only if E2 confirms that it reaches Claude. If it does not, only the options + "Answer in the terminal".
- An AskUserQuestion inside a subagent is received by the same hook (official documentation; `agent_id` / `agent_type` are included. On a real machine: E6). Display it on the card.
- Bind only to `127.0.0.1`. Authorization is the token + cookie above.
- ExitPlanMode approval has three choices: "Approve", "Approve and auto", and "Reject + a note". If "Approve and auto" does not work in E3, drop ExitPlanMode capture from the MVP (AskUserQuestion alone can measure (a')(b)(d)).

## 4. Additional verification for Day 1-2 (in parallel with implementation. E1-E5 have been started, and a supplement has been sent)

Reuse `verification/hook.mjs`, and write results to `docs/verification/02-hook-limits.md`.

| # | Question | Method | Effect on the plan |
|---|---|---|---|
| E1 | The upper limit of hook `timeout`, the display during a long block, the behavior on interruption | Block for 660 seconds with `timeout: 3600` and `86400`, and judge rounding by the presence of `hook_cancelled` and `timeoutMs`. Display of `statusMessage`. The signal the hook receives on Esc / ctrl+c, the transcript, and Claude afterwards | If the limit is low, match the budget and the GUI's remaining-time display |
| E2 | Variants of `answers` | Free text not in the labels, joining of `multiSelect`, `answers: {}`, key mismatch, answering only 1 of 2 questions. Check in the transcript the text Claude receives | Whether free-form is possible, handling on error, the delimiter |
| E3 | ExitPlanMode deny, and returning to the mode after approval | Return a rejection reason and see whether Claude fixes the plan and resubmits (number of round trips, plan length). Whether `updatedPermissions: [{type: "setMode", mode: "auto", destination: "session"}]` works at the first PermissionRequest after allow. Display and truncation of a 2 KB deny reason | The rejection UI, whether "Approve and auto" holds, whether to keep ExitPlanMode in the MVP |
| E4 | The round trip of making it write an explanation via deny (**the Day 2 gate**) | 3 kinds of decisions (design fork / hard-to-reverse operation / naming) x 2 times, one of them with opus. Whether a Write to `<scratchpad_dir>/ukagai/` goes through without a prompt in default / acceptEdits / plan. Whether the re-call rate changes between imperative and "fact + request". Number of round trips, seconds, whether it asked the same question again, quality of the explanation | The wording and tone of the reason text, the 2-minute / 10-minute values, the addition to (b). **If the re-call rate is below 80% or round trips exceed 2, take the branch in section 8** |
| E5 | Whether it writes in advance from the SessionStart `additionalContext` alone | With the same 3 kinds as E4, the rate at which an explanation file is attached from the first call without deny. Whether it is re-injected after `/clear` | The wording of the instruction. If the rate is high, deny stays as insurance |
| E6 | Subagents | Have an Explore subagent call AskUserQuestion, and check whether the hook fires, `session_id` / `agent_id` / `scratchpad_dir`, the display in the parent terminal, and whether sync SubagentStart `additionalContext` arrives | The pairing key, the context-collection path, advance instructions to subagents |
| E7 | Measuring fail-open | With a hook that gives up in 1 second when the server is absent, whether AskUserQuestion falls back to the normal UI in 1-2 seconds | Backing for the W4 test |

## 5. Split and assignments

Split it. If the contract (W2) is fixed first, the files that the hook and server edit are independent, and the E tasks run regardless of implementation. The design decisions (pairing, authorization, mode return) were settled in this v2, so everything is `sonnet` / `medium`. There are no irreversible changes (migration / public API / billing). W6 rewrites a user settings file, but backup and dry-run are included in the acceptance criteria.

| # | Task | Files touched | Model | effort | Depends on | Acceptance criteria |
|---|---|---|---|---|---|---|
| 0 | First commit to main | - | done | - | - | done |
| W1 | Skeleton | - | done (merged into main) | - | - | done |
| W2 | Contract: `src/contract.ts` (zod. Decision / API input and output / hook output / events) and `docs/spec/api.md`. Use the stdin / stdout JSON of 01 as fixtures | `src/contract.ts`, `docs/spec/api.md`, `test/contract.test.ts`, `test/fixtures/**` | sonnet | medium | W1 | Fixtures pass the schema. Invalid `answers`, invalid status transitions, and a `transcript_path` outside `~/.claude/projects/` are rejected |
| E1-E7 | Additional verification | `verification/`, `docs/verification/02-hook-limits.md` | sonnet | medium | - | The table in section 4 is filled in. Guesses are marked as "guess" |
| W7 | Explanation spec and skill: `docs/spec/explain.md` (location, front matter, required sections and conditions, matching rules, the template of the deny reason text, the 3 lines for SessionStart / SubagentStart, matching of ExitPlanMode's section) and `skills/ukagai-explain/SKILL.md` (what to turn into a diagram, what into a table, how to cut out the diff. One good example and one bad example). Fixtures: 3 explanations that pass, 3 that fail, and a plan whose headings differ slightly (passes) | `docs/spec/explain.md`, `skills/ukagai-explain/**`, `test/explain-fixtures/**` | sonnet | medium | W2 (can be parallel). The deny wording and thresholds are fixed last by the results of E4 / E5 | The expected verdict of each fixture can be derived uniquely from the spec's rules |
| W3 | serve: Hono + `@hono/node-server`, store (memory + JSONL + restore at startup), API, long-poll and lease, ack, authorization (token + cookie + Host + Content-Type), SSE, serving `public/`, context collection `src/server/context.ts`, metrics | `src/server/**`, `test/server/**` | sonnet | medium | W2 | Tests that fetch on a temporary port: register → wait 204 → answer → wait 200 → ack gives `answered`. Without ack it does not become `answered`. A poll gap expires the lease → `hook_disconnected`. A fake Host gives 400, an answer without a token gives 401, and `transcript_path: /etc/passwd` is rejected. `pending` is restored on restart. It does not crash on a cwd without git |
| W4 | hook: stdin → dispatch → server → stdout. Budget and boundary rules, fail-open (cannot connect / 404 / 5xx), ack, search / matching / format check of the explanation file, deny reason text, loop insurance (`src/hook/explain.ts`), `denied_explain` registration, `additionalContext` for SessionStart / SubagentStart, PermissionRequest's `setMode`, Stop's `escaped_question`, `--observe` | `src/hook/**`, `test/hook/**` | sonnet | medium | W2, the spec of W7 (parallel with W3) | Tests against a fake server: the allow output matches 01's JSON. With the server absent, stdout is empty, exit 0, within 1 second. With remaining time under poll + 5 seconds, it does not poll and falls back. No explanation file → the deny text includes the save path and the original text of `question:`. Malformed → the names of the missing items are included. Second time within 2 minutes → registered as `none / loop_guard`. Plan mode → not required. The 6 + 1 fixtures of W7 are judged as specified |
| W5 | GUI: pending list, question card, plan card (Approve / Approve and auto / Reject + a note), explanation panel (Markdown + table + Mermaid + diff. Show code on a rendering failure), supplementary context panel, session list (send the open count to events), SSE reflection, "Answer in the terminal", the "no explanation" mark, display of `answer_lost` | `public/**`, one line of the `vendor` script in `package.json` | sonnet | medium | W3 | With agent-browser: a decision registered by curl appears in the list within 1 second, Mermaid renders, broken Mermaid shows as code, and pressing an option makes wait return 200. 3 screenshots to the scratchpad |
| W6 | install / uninstall / doctor: merging settings (exec form, `statusMessage`, deriving `--budget`), backup, `--dry-run`, `--project`, `--settings`, placing the skill | `src/install/**`, `src/uninstall/**`, `src/doctor/**`, `test/install/**` | sonnet | medium | W1, W4, W7 | Tests with a temporary HOME: existing hooks are kept, running twice does not duplicate, uninstall restores the original, `.bak` remains, the skill is placed and removed, the generated command is exec form |
| R1 | Implementation review (the diff of W3 + W4): conformance to the contract, whether tests can fail as claimed, whether every fail-open path exists, gaps in authorization | - | sonnet | medium | W3, W4 | Report md. If anything is critical, send it back to the owner |
| R2 | Implementation review (W6): whether any path breaks user settings | - | sonnet | medium | W6 | Report md |
| V1 | E2E on a real machine: start `serve` → `install --settings verification/e2e-settings.json` → launch a probe in Herdr → 1 decision with an explanation, 1 with no explanation → deny → rewrite, 1 plan approval (Approve and auto), 1 fail-open with the server stopped | `docs/verification/03-e2e.md` | sonnet | medium | W5, W6 | Record three things: the screen, the hook log, and the transcript |
| D1 | Add 03 and the spec to the README table | `README.md` | haiku | - | Last | - |

Parallel groups: {W2, the spec of W7, E1-E7} → {W3, W4 (after W7's spec is settled)} → {W5, W6} → {R1, R2} → V1. The lockfile and `package.json` are serial (W5's `vendor` script is one line, so it is resolved in the merge). W5 touches only `public/` and one line of `package.json`, and the serving route for `public/` is created first by W3. Each worker works in a worktree, and the orchestrator does the git writes.

## 6. Schedule

| Day | Work | Done when |
|---|---|---|
| 1 (done to start) | 0, W1 (done), reflecting the review (done), W2, the spec of W7, E1-E7 (started) | The contract and spec are in main. E1-E3, E6, E7 are in `docs/verification/02-hook-limits.md` |
| 2 | Gate judgment by the results of E4 / E5 → settle W7's deny wording. W3 ∥ W4 | Tests against the fake server / temporary port pass. The 7 fixtures are judged as expected |
| 3 | W3 / W4 continued, R1. **Baseline measurement**: run my normal work with `hook --observe` for one day (start serve, and register only observe via `--settings`) | The baseline of (b) appears in `GET /api/metrics` |
| 4 | W5 ∥ W6 | A decision with a Mermaid diagram and comparison table can be answered in the GUI. install works in both dry-run and real writes |
| 5 | V1, R2, fixes. When done, install into my own `~/.claude/settings.json` and start dogfooding | `docs/verification/03-e2e.md`. The first case in my own work appears in the GUI with an explanation |
| 6-14 | Use it in my own real work. (a')(b)(d) are the server's aggregates; (c) and the scoring of explanations are recorded by hand. Tuning the skill and deny wording is allowed, adding features is not | On Day 14, the 4 metrics and the verdict go to `docs/verification/04-metrics.md` |

## 7. Out of scope (MVP)

- An MCP server. Explanations are received via files + hooks.
- ACP clients and agents other than Claude Code (start in week 2 or later if (b)(c) have improved).
- Aggregation of PermissionRequest and auto-resolution policy (the one right after "Approve and auto" is the sole exception).
- Handling the authorization limitation: another process of the same user can call the API by reading `~/.ukagai/token`. Week 2 or later, together with enterprise fail-closed.
- Authentication (login), relay, mobile, deck operations (swipe), polishing the design, SQLite.
- Extending the explanation format (screenshots, images, diagrams other than Mermaid). Week 1 is only Markdown + table + Mermaid + diff.

## 8. Risks and branches

| Risk | Countermeasure |
|---|---|
| **In E4, deny → write → ask the same question again does not hold** (re-call rate below 80%, or more than 2 round trips) | Remove the deny insurance and keep only the advance instructions of SessionStart / SubagentStart + measuring `attached_via`. (d) can still be measured. W4's `explain.ts` keeps only search and matching |
| `setMode auto` does not work in E3 | Drop ExitPlanMode capture from the MVP. AskUserQuestion alone can measure (a')(b)(d) |
| Hook `timeout` has a low upper limit (E1) | install derives `--budget` from the settings `timeout` and the GUI shows the remaining time. When it runs out it just falls back to the normal UI and work does not stop |
| A transcript delay leaves the immediately preceding context missing | Show it empty. Re-read once after 500 ms |
| `node` is absent in the hook environment (e.g. launched from the Desktop app) | install writes `process.execPath` into the exec-form `command` |
| Decisions that slip away by being asked in prose are not captured | Only look at the count via Stop hook's `escaped_question`. If many, strengthen the advance instructions in week 2 |
| (b) grows by the time spent writing the explanation | Aggregate the agent side (`first_denied_at → created_at`) and the human side (`created_at → decided_at`) separately |
| Low explanation quality (diagram as decoration, table not filled in) | Narrowed the diagram's required condition by `scope` / `reversibility`. Hand-score (d) 3 per day. Replace the skill's good and bad examples with real ones |
| Claude itself calls the API and answers itself | Token authorization + not writing the URL in reason text. The limitation is in section 7 |

## 9. Verification results (as of 2026-10-02. Details in `docs/verification/02-hook-limits.md` and `03-e2e.md`)

| Item | Status |
|---|---|
| Injection (allow + updatedInput) works | Confirmed (01: Sonnet x auto. 02 E4: Opus, also works in default / acceptEdits / plan) |
| deny → write an explanation → ask the same question again | Confirmed (02 E4: 8 of 9 succeeded in 2 round trips. One plan mode x Opus run gave up without writing. 03 V1-2b: `after_deny` in 15 seconds) |
| SessionStart's advance instruction alone attaches an explanation from the first call | Confirmed (02 E5: 6/6. However the enumerated values become free text, so write the values in additionalContext. 03 V1-2: with SessionStart, no deny occurred and it was `first_call`) |
| No output with exit 0 falls back to the normal UI | Confirmed (02 E7: 30-90 ms on connection refused. 03 V1-4: 0.09 seconds) |
| It can step down on its own at budget exhaustion and record a fallback | Unit test only. Not confirmed on a real machine |
| Can write to `<scratchpad_dir>/ukagai/` in modes other than auto | Confirmed (02 E4: no permission prompt in default / acceptEdits / plan (Sonnet)) |
| Resubmission after an ExitPlanMode deny | Confirmed (02 E3: resubmitted in 6.3 seconds with a diagram and sections added) |
| PermissionRequest's `setMode auto` returns the mode | Confirmed (02 E3, 03 V1-3: the following Write went through without a permission prompt and the status line was auto. However, the session default in that environment is auto, so reconfirmation with the default as default is needed) |
| Thresholds of 2 minutes / 10 minutes | Round trips take 6-15 seconds, so 2 minutes is enough. Handling of old files over 10 minutes is unverified |
| timeout 3600 is not rounded | Confirmed (02 E1: both 3600 / 86400 survived beyond 660 seconds, no `hook_cancelled`. `statusMessage` appears on the spinner line) |
| Behavior during Esc / ctrl+c | Confirmed (02 E1-3: SIGTERM to the hook, treated as a tool rejection and the turn ends. The hook notifies the server of cancel on SIGTERM: F3) |
| multiSelect delimiter, free-form, key mismatch / omission | Confirmed (02 E2: `"A, C"` and free text are passed to Claude as is. Mismatch / omission is treated as no answer and is not an error. A partial answer passes only what was answered) |
| AskUserQuestion inside a subagent | **Does not occur** (02 E6: tools are not provided to subagents and the hook does not fire. SubagentStart's additionalContext does arrive) |
| The Notification hook fires while waiting | Does not fire (02 E1-4. As designed, used only for detecting "stuck on the terminal side") |
| Display in `/hooks` | Hooks via `--settings` do not appear in the list (02 E1-2h) |
| server ↔ hook integration | Confirmed (03 V1: with explanation, deny round trip, loop_guard, plan approval + setMode, fail-open, answer in the terminal. 3 integration tests of real server x real hook) |
