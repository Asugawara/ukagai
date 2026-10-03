import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { start, type ServeHandle } from "../../src/serve/index.js";
import { codexAnswerReason, codexInput, toAskUserQuestion } from "../../src/hook/codex.js";
import { CodexRequestUserInputInput, isAllowedExplanationPath, isAllowedTranscriptPath } from "../../src/contract.js";
import { dataDirWithToken, fakeServer, json, runHook, spawnHook, tmpDir, writeFile, type Fake, type Handler } from "./helpers.js";

const lines = (n: string): any[] =>
  readFileSync(fileURLToPath(new URL(`../fixtures/codex/${n}.jsonl`, import.meta.url)), "utf8")
    .split("\n")
    .filter((l) => l.startsWith("{") && l.includes('"hook_event_name"'))
    .map((l) => JSON.parse(l));
const rui = () => lines("rui-default-hooks").find((e) => e.hook_event_name === "PreToolUse");
const stops = () => lines("stop-block-hooks");
const Q = "A or B?";
const NOW = () => new Date().toISOString();

const explanationFor = (q: string) => `---
ukagai: 1
question: ${q}
title: Choose A or B
reversibility: reversible
scope: file
recommended: A
---
## Why this decision is needed now
It has to be decided.
## Options
| Option | What happens if chosen | Risks and how to undo |
|---|---|---|
| A (Recommended) | a | Revert it |
| B | a | Revert it |
## Recommendation
I recommend A. If C, choose B.
`;

const handles: ServeHandle[] = [];
after(async () => {
  for (const h of handles) await h.close();
});

async function realServer(): Promise<{ h: ServeHandle; dataDir: string; url: string; api: (path: string, body?: unknown) => Promise<any> }> {
  const dataDir = tmpDir();
  const h = await start({ port: 0, dataDir, home: tmpDir() });
  handles.push(h);
  const url = `http://127.0.0.1:${h.port}`;
  const api = async (path: string, body?: unknown) => {
    const res = await fetch(url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${h.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res.json();
  };
  return { h, dataDir, url, api };
}

/** Answers the first pending decision through the API as the GUI would */
async function answerWhenPending(api: (p: string, b?: unknown) => Promise<any>, answers: Record<string, string>): Promise<any> {
  for (let i = 0; i < 100; i++) {
    const list = await api("/api/decisions?status=pending");
    if (list.length > 0) {
      await api(`/api/decisions/${list[0].id}/answer`, { answers });
      return list[0];
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("no pending decision");
}

const a = (url: string, dir: string, ...rest: string[]) => ["--agent", "codex", "--server", url, "--data-dir", dir, ...rest];

test("fixture stdin maps to the AskUserQuestion shape (id kept, transcript null → \"\", agent codex, permission_mode dropped)", () => {
  const raw = rui();
  const norm = codexInput(raw);
  assert.equal(norm["transcript_path"], "");
  assert.equal(norm["agent"], "codex");
  assert.equal("permission_mode" in norm, false);
  const parsed = CodexRequestUserInputInput.parse(norm);
  const mapped = toAskUserQuestion(parsed) as any;
  assert.deepEqual(mapped.questions[0].options, [
    { label: "A (Recommended)", description: "Choose option A." },
    { label: "B", description: "Choose option B." },
  ]);
  assert.equal(mapped.questions[0].question, Q);
  assert.equal(mapped.questions[0].header, "Choice");
  assert.equal(mapped.questions[0].id, "choice");
  assert.equal(mapped.questions[0].multiSelect, false);
});

test("codexAnswerReason: one question and several", () => {
  assert.equal(
    codexAnswerReason({ questions: [{ question: Q }] }, { [Q]: "B" }),
    "The human answered in the ukagai GUI: A or B? = B. Do not ask again; continue with this answer.",
  );
  const multi = codexAnswerReason({ questions: [{ question: "X?" }, { question: "Y?" }] }, { "X?": "1", "Y?": "2" });
  assert.match(multi, /- X\? = 1\n- Y\? = 2/);
});

test("no explanation file → deny with the explain save path under <data-dir>/explain/<session_id>/; denied_explain registered with agent codex", async () => {
  const s = await realServer();
  const input = rui();
  const r = await runHook(a(s.url, s.dataDir), JSON.stringify(input));
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.ok(out.hookSpecificOutput.permissionDecisionReason.includes(join(s.dataDir, "explain", input.session_id, "explain.md")));
  const denied = await s.api("/api/decisions?status=denied_explain");
  assert.equal(denied.length, 1);
  assert.equal(denied[0].session.agent, "codex");
  assert.equal(denied[0].session.transcript_path, "");
});

test("deny texts for Codex say request_user_input, never AskUserQuestion or the Claude skill", async () => {
  const s = await realServer();
  const input = rui();
  // no explanation file: first deny (template A)
  const r = await runHook(a(s.url, s.dataDir), JSON.stringify(input));
  const reason = JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason as string;
  assert.ok(reason.includes("request_user_input"), reason);
  assert.ok(!reason.includes("AskUserQuestion"), reason);
  assert.ok(!reason.includes("skill ukagai-explain"), reason);
  assert.ok(reason.includes("SessionStart context"), reason);
  // template B
  const r2 = await runHook([...a(s.url, s.dataDir), "--deny-template", "B"], JSON.stringify({ ...input, session_id: "other-session" }));
  const reason2 = JSON.parse(r2.stdout).hookSpecificOutput.permissionDecisionReason as string;
  assert.ok(reason2.includes("request_user_input") && !reason2.includes("AskUserQuestion") && !reason2.includes("skill ukagai-explain"), reason2);
  // several questions
  const multi = { ...input, session_id: "multi-session", tool_input: { questions: [...input.tool_input.questions, ...input.tool_input.questions] } };
  const r3 = await runHook(a(s.url, s.dataDir), JSON.stringify(multi));
  const reason3 = JSON.parse(r3.stdout).hookSpecificOutput.permissionDecisionReason as string;
  assert.ok(reason3.includes("request_user_input") && !reason3.includes("AskUserQuestion"), reason3);
});

test("explanation present + GUI answer through the API → deny whose reason carries `<question> = <answer>`", async () => {
  const s = await realServer();
  const input = rui();
  writeFile(join(s.dataDir, "explain", input.session_id, "e.md"), explanationFor(Q));
  const run = spawnHook(a(s.url, s.dataDir), JSON.stringify(input));
  const dec = await answerWhenPending(s.api, { [Q]: "B" });
  assert.equal(dec.session.agent, "codex");
  const r = await run.result;
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(
    out.hookSpecificOutput.permissionDecisionReason,
    "The human answered in the ukagai GUI: A or B? = B. Do not ask again; continue with this answer.",
  );
  assert.ok(readdirSync(join(s.dataDir, "explain", input.session_id)).some((f) => f.includes(".used")));
});

test("\"Cannot answer — …\" is carried as the answer", async () => {
  const s = await realServer();
  const input = rui();
  writeFile(join(s.dataDir, "explain", input.session_id, "e.md"), explanationFor(Q));
  const run = spawnHook(a(s.url, s.dataDir), JSON.stringify(input));
  await answerWhenPending(s.api, { [Q]: "Cannot answer — Unclear" });
  const out = JSON.parse((await run.result).stdout);
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /A or B\? = Cannot answer — Unclear\./);
});

test("fallback (budget ran out) prints nothing", async () => {
  const s = await realServer();
  const input = rui();
  writeFile(join(s.dataDir, "explain", input.session_id, "e.md"), explanationFor(Q));
  const r = await runHook(a(s.url, s.dataDir, "--budget", "30"), JSON.stringify(input));
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
});

test("Stop with stop_hook_active: true → no output, no decision", async () => {
  const s = await realServer();
  const active = stops().find((e) => e.stop_hook_active === true);
  const r = await runHook(a(s.url, s.dataDir), JSON.stringify({ ...active, last_assistant_message: "Which one?" }));
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
  assert.equal((await s.api("/api/decisions?status=pending")).length, 0);
});

test("Stop with a prose question + GUI answer → decision: block with the answer", async () => {
  const s = await realServer();
  const stop = stops().find((e) => e.stop_hook_active === false);
  const run = spawnHook(a(s.url, s.dataDir), JSON.stringify(stop));
  const dec = await answerWhenPending(s.api, { "Which do you want, A or B?": "B" });
  assert.equal(dec.session.agent, "codex");
  const r = await run.result;
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout), {
    decision: "block",
    reason: "The human answered your question in the ukagai GUI: B. Continue with it.",
  });
});

test("Stop with a prose question and no answer within the budget → no output", async () => {
  const s = await realServer();
  const stop = stops().find((e) => e.stop_hook_active === false);
  const r = await runHook(a(s.url, s.dataDir, "--budget", "30"), JSON.stringify(stop));
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
});

test("Stop with a plain sentence → no output and no decision", async () => {
  const s = await realServer();
  const r = await runHook(a(s.url, s.dataDir), JSON.stringify({ ...stops()[0], last_assistant_message: "Done." }));
  assert.equal(r.stdout, "");
  assert.equal((await s.api("/api/decisions?status=pending")).length, 0);
});

test("UKAGAI_DISABLE=1 → no output, no server calls", async () => {
  const f = await fakeServer();
  try {
    process.env["UKAGAI_DISABLE"] = "1";
    const r = await runHook(a(f.url, dataDirWithToken()), JSON.stringify(rui()));
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.equal(f.calls.length, 0);
  } finally {
    delete process.env["UKAGAI_DISABLE"];
    await f.close();
  }
});

test("server unreachable → no output, exit 0 (PreToolUse and Stop)", async () => {
  const f = await fakeServer();
  const url = f.url;
  await f.close();
  const d = dataDirWithToken();
  for (const input of [rui(), stops()[0]]) {
    const r = await runHook(a(url, d), JSON.stringify(input));
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  }
});

test("SessionStart gives additionalContext pointing at <data-dir>/explain/<session_id>; other events are observed with agent codex", async () => {
  const seen: any[] = [];
  const handler: Handler = (req, res) => {
    if (req.path.startsWith("/api/events")) {
      seen.push(req.body);
      res.writeHead(204).end();
      return true;
    }
    return false;
  };
  const f = await fakeServer(handler);
  try {
    const d = dataDirWithToken();
    const evs = lines("hooks-deny-run");
    const start = evs.find((e) => e.hook_event_name === "SessionStart");
    const r = await runHook(a(f.url, d, "--no-autostart"), JSON.stringify(start));
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
    assert.ok(out.hookSpecificOutput.additionalContext.includes(join(d, "explain", start.session_id)));
    const prompt = evs.find((e) => e.hook_event_name === "UserPromptSubmit");
    await runHook(a(f.url, d), JSON.stringify(prompt));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].agent, "codex");
    assert.equal(seen[0].transcript_path, "");
    assert.equal(seen[0].hook_event_name, "UserPromptSubmit");
  } finally {
    await f.close();
  }
});

test("PreToolUse for other Codex tools (Bash) prints nothing", async () => {
  const f = await fakeServer();
  try {
    const bash = lines("hooks-deny-run").find((e) => e.tool_name === "Bash");
    const r = await runHook(a(f.url, dataDirWithToken()), JSON.stringify(bash));
    assert.equal(r.stdout, "");
  } finally {
    await f.close();
  }
});

test("paths: Codex rollouts and <data-dir>/explain are allowed; \"\" transcript is accepted by the server for codex only", async () => {
  const home = tmpDir();
  assert.equal(isAllowedTranscriptPath(join(home, ".codex", "sessions", "2026", "r.jsonl"), home), true);
  assert.equal(isAllowedTranscriptPath("", home), false);
  assert.equal(isAllowedExplanationPath(join(home, "dd", "explain", "s", "a.md"), undefined, home, join(home, "dd")), true);
  assert.equal(isAllowedExplanationPath(join(home, "dd", "explain", "s", "a.md"), undefined, home), false);
  const s = await realServer();
  const base = { tool_use_id: "t1", kind: "answer_question", request: { questions: [{ question: "q?", header: "h", options: [] }] } };
  const post = (session: object) =>
    fetch(s.url + "/api/decisions", {
      method: "POST",
      headers: { authorization: `Bearer ${s.h.token}`, "content-type": "application/json" },
      body: JSON.stringify({ ...base, session }),
    });
  assert.equal((await post({ session_id: "x", cwd: "/", transcript_path: "", agent: "codex" })).status, 201);
  assert.equal((await post({ session_id: "y", cwd: "/", transcript_path: "" })).status, 400);
});
