# Verification 10: questions as messages (the ukagai mod), on a real Claude Code

- Date: 2026-10-20
- Build: branch `feat/claude-mod-async` (`6fcd5e7`), `npm run build`
- Versions: Claude Code 2.1.304 (sonnet, haiku, opus), node v24.11.0, herdr, Darwin 24.6.0
- `<tmp>` is a scratch directory and `<data-dir>` is `<tmp>/D`. A dev server ran on port 4919 (`node dist/cli.js serve --port 4919 --data-dir <tmp>/D`). Claude Code ran with `--setting-sources project,local --settings <tmp>/settings.json --plugin-dir <tmp>/mod-dev`, so the user's own hooks and plugins did not fire, except in section 5 (a copy of the user's settings). The working directory was `<tmp>/cwd`. No real `~/.claude/settings.json`, `.claude/settings.json` or `~/.ukagai` was written. No code was changed for this check.
- Answers were sent with the HTTP API (`POST /api/decisions/:id/answer`) as the GUI does; the browser check could not run (see "Not verified").

## Results

| # | Check | Result |
|---|---|---|
| 1 | Release condition (b): opus, haiku and sonnet each follow the async deny 3 times (9 of 9) | ✓ |
| 2 | Release condition (a): a tool call is denied while an async answer is not delivered (opus, 4 times) | ✓ |
| 3 | Question → one-sentence end of turn → answer → `[ukagai] (ref …)` plugin message → agent continues → `answered` | ✓ (every run that was answered) |
| 4 | Esc in the delivery turn: no second delivery | ✓ |
| 5 | Esc while the delivery is queued | not verified (could not make the mod submit while the agent was busy) |
| 6 | A UserPromptSubmit hook that blocks the message (`block-ukagai.mjs`): the human's turns are not stopped, 5 attempts → `undeliverable` | ✓ (see finding 3) |
| 7 | Mod stopped (server address changed, plugin reloaded): no hold-back within 15 s, `no_agent` within 2.5 min, the human types → card closes | ✓ |
| 8 | Toggle off, `UKAGAI_MOD=0`, irreversible question: ordinary long-poll | ✓ |
| 9 | `claude -p`: the mod does not poll | ✓ for the mod; the hook path could not be exercised (finding 5) |
| 10 | Server stopped: the hook fails open (native question dialog), the mod stays silent | ✓ |
| 11 | The human types while a question is pending: it is cancelled; history has no plugin line | ✓ |
| 12 | No progress card while an async decision is open; a card is made after delivery | ✓ |
| 13 | Plan mode: the plan file is not `ready` until the answer is delivered | ✓ |
| 14 | `/clear`: the mod keeps polling under the new session id, a question after it is delivered as a message, and `/exit` closes it (`session_end`) | ✓ after the fix in `4a58371` (the first run on `6fcd5e7`: the mod stopped for the rest of the process, finding 2) |
| 15 | `/exit` closes a pending async decision after about 10–12 s (`session_end`) | ✓ |
| 16 | A SessionEnd of a nested `claude -p` does not close the parent's question | ✓ (run as a separate process, not from the agent's Bash) |
| 17 | `--resume` of one session in two panes: one delivery, to the process that asked | ✓ |
| 18 | Copy of the user's settings: 3 models once each, other plugins' Stop hooks | ✓ (0 blocks) |
| 19 | `claude plugin list` shows `ukagai-mod@skills-dir` as loaded; the module loads and polls at run time | ✓ |
| 20 | herdr: a queued reply is not typed while an async decision is open | not verified |
| 21 | GUI in a browser (agent-browser): card with explanation, Mermaid and HTML frame; wording after answering; Settings toggle; ja | ✓ except the card's status line (see "Not verified"); no recording (ffmpeg missing) |

## Setup

1. `npm run build`.
2. `node dist/cli.js install --settings <tmp>/settings.json --data-dir <tmp>/D --server http://127.0.0.1:4919 --no-autostart --claude`.
3. `<tmp>/mod-dev/`: `.claude-plugin/plugin.json`, `hooks/claude.json` = `{"modules":["./mod/register.ts"]}`, `hooks/mod/{core,register}.ts` copied from the branch, `hooks/mod/config.json` = `{"server":"http://127.0.0.1:4919","dataDir":"<tmp>/D"}`. **`plugin.json` must name the hooks file** (`"hooks": "./hooks/claude.json"`); without it Claude Code loads the plugin but not the module, and the first trial ran as an ordinary long-poll (finding 1). `claude plugin validate` passes and reports `./mod/register.ts env writes: UKAGAI_MOD_OWNER`.
4. A session per run: `claude --setting-sources project,local --settings <tmp>/settings.json --plugin-dir <tmp>/mod-dev --model <m> --debug-file …`, started in its own herdr pane (auto permission mode, as the machine's policy resolved it).

Prompt of every question run: "Make one fork for a human to decide (a small script in Python or Shell), write the explanation file, ask with AskUserQuestion, then carry on without waiting (start with hello.txt)."

## 1. Three models, three sessions each (release condition b)

"Followed" = after the async deny the agent (1) calls no other tool (a call that the enforcement denies is not counted), (2) does not call AskUserQuestion again (same `tool_use` id; the transcript also holds an `api-request-blob` copy of each line, which is not a second call), (3) does not repeat the question in prose (`escaped_question` of the Stop event is false/absent). Lines are transcript lines of the session.

| Model | Run | Session | AskUserQuestion denied (line) | Other tool after the deny | Ended turn (line, `stop_reason`) | Stop `escaped_question` | Followed | Delivery |
|---|---|---|---|---|---|---|---|---|
| sonnet | 1 | 40ba5665 | 67/72 (one id) | none | 76 `end_turn` | absent | ✓ | message → `answered` |
| sonnet | 2 | 56ccfe7d | 81 | none | 85 `end_turn` | absent | ✓ | message → `answered` |
| sonnet | 3 | 97868f03 | 70 | none | 74 `end_turn` | absent | ✓ | message → `answered` |
| haiku | 1 | 7c043c19 | 90 | none | 95 `end_turn` | absent | ✓ | message → `answered` |
| haiku | 2 | 394d9c06 | 81 | none | 86 `end_turn` | absent | ✓ | message → `answered` |
| haiku | 3 | 0e70126e | 88 | none | 93 `end_turn` | absent | ✓ | message → `answered` |
| opus | 1 | a2f52ed1 | 73 | Bash, denied by the enforcement (76) | 81 `end_turn` | absent | ✓ | message → `answered` |
| opus | 2 | d4d9027a | 78 | Bash, denied by the enforcement (81) | 87 `end_turn` | absent | ✓ | message → `answered` |
| opus | 3 | 8eabc2fe | 68 | Bash, denied by the enforcement (71) | 77 `end_turn` | absent | ✓ | message → `answered` |

- In every run the decision was registered with `delivery: "message"` and no `lease_until`, and the answer arrived as a user line `The ukagai-mod-dev plugin sent a message: [ukagai] (ref <8 hex>) The human answered …` within about 1–3 s of the answer (opus 2 later set `escaped_question: true` on the Stop of the turn after the delivery; that is an unrelated "shall I delete the leftovers?" question, not the async question).
- No tool was called after the deny except the opus Bash calls below.
- Opus tried one Bash call right after the deny every time (3 of 3, and again in section 5). The branch's checkpoint hook denied it (`Your question in ukagai is not answered yet: end your turn, the answer arrives as a message (see hook context).`) and the agent then ended its turn. Sonnet and haiku did not try.

## 2. The enforcement (release condition a)

Opus 1–3 and the section 5 opus run: `PreToolUse:Bash hook error: [ukagai, not a failure] Your question in ukagai is not answered yet: end your turn, the answer arrives as a message (see hook context).` (transcript lines in the table above; a request for a hold-back that the model made by itself, no prompt hint). In the drop run (section 4) the same hook denied a `Write` right after the question (line 68 of session cad4d219) and let the human's typed turns run.

`GET /api/sessions/:id/instruction?main=1` gave `200 {"waiting":{"decision_id":…,"kind":"answer_question"}}` while the question was open and the mod polled; `404` once the mod was stopped.

## 3. Answer flow

Sonnet 1: question → the model ends its turn with one message (line 76) → answer at 07:10:3x → line 87 `[ukagai] (ref 8b7e70af) …` as a plugin message → the agent wrote `hello.py` and ran it (lines 90–98). `answered` within the 30 s window in every answered run. History (`GET /api/decisions/:id/history`) of that session has `total: 1`: the plugin message is not counted as a human instruction.

## 4. Breakages

- **Dropped delivery** (`<tmp>/block-ukagai.mjs` as a UserPromptSubmit hook blocks prompts that start with `[ukagai] (ref `): the first delivery was dropped (`delivery_attempts: 1`, `delivery_note: "UserPromptSubmit operation blocked by hook: test …"`). It stayed at 1 for 60 s: the next attempt starts only after the next turn completes. Five typed turns (`Bash で echo typed-N`) all ran their Bash call (no hold-back, `human_prompt_at` set); the attempts went 2, 3, 4, 5 and the decision became `answer_lost` / `undeliverable`.
- **Mod stopped**: `hooks/mod/config.json` `server` → `:4999`, `register.ts` touched, `/reload-plugins` (a changed `config.json` alone is not re-read: "hooks modules unchanged, kept as loaded"). After the reload the mod polled `:4999`, failed, and kept quiet. The instruction endpoint answered `404` from the first sample 3 s after the last successful poll, and the decision got `delivery_flag: "no_agent"` about 2 min later (16:35:52). The human then typed `Bash で echo hi を実行して`: the tool ran, the decision became `cancelled`.
- **Server stopped** before the session: the hook failed open and Claude Code showed its native AskUserQuestion dialog; the mod's 18 failed polls produced no UI output.
- **Esc in the delivery turn** (the agent ran a 60 s loop after the message): Esc at 16:53:31 → `[Request interrupted by user for tool use]`, the decision stayed `answered`, one plugin message in the transcript over the next 35 s.

## 5. Copy of the user's settings

`cp ~/.claude/settings.json <tmp>/settings-user.json`, then `install --settings <tmp>/settings-user.json …` (it replaced the ukagai hooks with the dev build, 0 old references left). One run per model with the same prompt:

| Model | Session | Result | Stop hook runs | Stop hooks that blocked | Forced denies |
|---|---|---|---|---|---|
| sonnet | 1c82b8b8 | followed, delivered | 2 (3 hooks each) | 0 | 0 |
| haiku | 56239472 | followed, delivered | 2 | 0 | 0 |
| opus | 8633c081 | followed, delivered | 2 | 0 | 1 (Bash, line 75) |

Other plugins' Stop hooks never blocked the stop (`preventedContinuation` false), so the question costs one Stop per turn, 0 extra round trips; the risk of more than 3 round trips did not show up.

## 6. Other modes

- `UKAGAI_MOD=0` (env): ordinary decision, `lease_until` set, no `delivery`; the AskUserQuestion tool result was `Your questions have been answered: …`.
- `claude.message_delivery: false` (`PUT /api/settings`, restored afterwards): same as above.
- Irreversible question outside plan mode (`explanation.reversibility: irreversible`, `permission_mode: auto`): ordinary decision with a lease, answered through the long-poll.
- `claude -p`: the mod loads but logs `session.start: raised (surface none, not interactive)` and made 0 polls. Claude Code's `-p` run offers no AskUserQuestion, so the agent asked in prose and no decision was registered; the hook's long-poll path could not be exercised this way.
- Plan mode (`--permission-mode plan`, `permission_mode: "plan"`): the question was registered as `delivery: "message"`; `GET /api/plans` showed `ready: false` for the session's plan file while the answer was pending and for the first seconds after `answered`, and `ready: true` only after the agent finished editing it. (The plan file went to `~/.claude/plans/cli-hello-json-zesty-cocke.md`: `plansDirectory` is not honoured, as in the earlier spike.)
- Progress checkpoint: an `away_summary` line was appended to the transcript of a session with an open async decision: no card, `serve.log` `checkpoint_skipped … decision_pending`. A second `away_summary` line after the delivery produced a `checkpoint` card.
- Session end: `/exit` with a pending async decision → `cancelled`, `status_reason: session_end` 12 s after `SessionEnd`. `/clear` of the session with the open decision → `session_end` about 10 s later. A `claude -p "say hi"` run by hand (another process, same settings) did not close the open decision of the other session.
- `--resume` of one session in two panes: both mods polled the session (34 and 28 polls); the decision got `mod_owner` of the pane that asked; the `[ukagai]` message appeared once, in that pane only.
- Skills-dir: `HOME=<tmp>/home node dist/cli.js install --claude` placed `ukagai-mod/` (with `.claude-plugin/plugin.json` naming `hooks/claude.json`, no `config.json`); `HOME=<tmp>/home claude plugin list` printed `ukagai-mod@skills-dir`, `Status: ✔ loaded`. A copy of that folder under `<tmp>/cwd2/.claude/skills/` with a `config.json` pointing at the dev server logged `hooks module ukagai-mod@skills-dir loaded` and polled.

## Findings

1. **Dev set-up (plan step, not a product bug).** A mod-only plugin needs `"hooks": "./hooks/claude.json"` in `plugin.json`; the staged plugin and the skills-dir copy have it, a hand-made folder without it silently runs as an ordinary hook (first trial: decision with a lease and no `delivery`).
2. **After `/clear` the mod stayed off for the rest of the process (medium). Fixed in `4a58371`.** Claude Code sent `session.end` to the mod and then `SessionStart:clear` to the hooks, but no new `session.start` reached the mod, which had stopped its tick on `session.end`. The debug log of the run shows 76 polls, the last at 07:48:41, then none. Questions asked after `/clear` were registered as ordinary long-polls (decision d746a269: no `delivery`), and `/exit` then ended the hook through its signal (`cancelled` without `status_reason`). Nothing breaks, but the async path is gone until Claude Code restarts. Before `4a58371` the spec said `/clear` makes the mod poll under a new session id, but it did not. Repro: start a session with the mod, `/clear`, ask a question, check `delivery` of the decision.
   Re-check on `4a58371` (sonnet, one session, `/clear`, then the same question): polls went to the old session `9d1ca1b9` (12 polls) and, after `/clear` at 08:21:4x, to the new session `17301b54` (73 polls to the end). Decision `80b4fa06`: `delivery: "message"`, `mod_owner: 1615413f5d54c773`, `lease_until: null`; after the answer `response.delivered_via: "message"`, `answered`; transcript line 89 is the `[ukagai] (ref …)` plugin message after the deny at line 77. A second question in the same session (`605557c4`, same `mod_owner`) closed as `cancelled` / `session_end` at 08:23:57, 12 s after `SessionEnd` (08:23:45.338); the last poll was at 08:23:45.367 and none followed.
3. **A dropped delivery is retried only after the next turn completes (low).** With a blocking UserPromptSubmit hook the card stays at attempt 1 until the human types; this matches the note ("continues after your next prompt in the terminal").
4. **Opus calls a tool right after the deny every time (info).** It relies on the enforcement; with the enforcement off, opus would carry on. The enforcement worked in all four opus runs.
5. **`claude -p` has no AskUserQuestion**, so "`-p` is the long-poll" cannot be shown for questions; only that the mod stays off.

## Not verified

- Esc while a delivery is queued: the mod submits only when the agent is idle, so the queue window is a few milliseconds; the race (answer + Esc at once) landed on an idle prompt, and the delivery had already happened.
- The nested `claude -p` was run as a separate process, not from the agent's Bash (the agent's Bash is held back while the question is open).
- A herdr-typed reply not being typed while an async decision is open.
- GUI (agent-browser, dev server `http://127.0.0.1:4919`, 1280x900; the Claude in Chrome extension was not connected). Verified: a card with an explanation shows its sections, the options as cards, a Mermaid sequence diagram (`div.mermaid-ok` with an `svg`) and an embedded HTML page as a sandboxed frame (`iframe.doc-frame-view`, `sandbox="allow-scripts"`, with the table readable, "Open in new tab" and "Full screen" buttons); an `![表](x.html)` placed inside the Options section is dropped from the page (only the option cards show), placed in "Why this decision is needed now" it renders. Answering with the GUI (click on the option) sends it, shows the toast "Will reach the agent as a message when it is idle" (ja: "エージェントの手が空いたらメッセージで届けます"), and about 2 s later the live region says "<title> delivered" (ja "… 届きました") when the decision becomes `answered`. Settings: "Deliver answers as messages" off → the next question is an ordinary decision (`delivery` absent, `lease_until` set), on again → `delivery: "message"` with a `mod_owner`; the language switch to ja and back to en works. Not verified: the card's own status line "Delivered as a message" (`statusLine` in `public/app.js`): a shown card that becomes non-pending is replaced by the next one (toast, then `advance()`), and the pending list holds no answered decisions, so no screen showed it; and no recording was made (`agent-browser record` needs ffmpeg, which is not installed). Screenshots are in the scratchpad, not in the repository. No comparison with a `main` build.
- The plan-approval path (PR-2b) is out of scope.
