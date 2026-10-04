import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bodyHash, decisionFingerprint } from "../../src/contract.js";
import { contextText, isEscapedQuestion } from "../../src/hook/context-hooks.js";
import { dataDirWithToken, fakeServer, json, runHook, tmpDir, writeFile, type Fake, type Handler } from "./helpers.js";

const fx = (n: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/${n}`, import.meta.url)), "utf8"));
const Q = "Which do you choose, A or B?";
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
| A | a | Revert it |
| B | a | Revert it |
## Recommendation
I recommend A. If C, choose B.
`;

function t1(scratchpad: string, extra: Record<string, unknown> = {}) {
  return { ...fx("t1-stdin.json"), scratchpad_dir: scratchpad, ...extra };
}

const answerHandler = (answers: unknown): Handler => (req, res) => {
  if (req.method === "GET" && req.path.includes("/wait")) {
    return json(res, 200, { response: { via: "gui", answers, decided_at: NOW() } });
  }
  return false;
};

async function withServer<T>(handler: Handler, fn: (f: Fake, dataDir: string) => Promise<T>): Promise<T> {
  const f = await fakeServer(handler);
  try {
    return await fn(f, dataDirWithToken());
  } finally {
    await f.close();
  }
}

const args = (f: Fake, dataDir: string, ...rest: string[]) => ["--server", f.url, "--data-dir", dataDir, ...rest];

test("T1: the GUI answer matches t1-stdout.json and ack is called; the explanation file becomes .used.md", async () => {
  const sp = tmpDir();
  writeFile(join(sp, "ukagai", "e.md"), explanationFor(Q));
  await withServer(answerHandler({ [Q]: "B" }), async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(t1(sp)));
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.stdout), fx("t1-stdout.json"));
    const create = f.calls.find((c) => c.method === "POST" && c.path === "/api/decisions");
    assert.equal(create?.auth, "Bearer test-token");
    assert.equal(create?.body.explanation.attached_via, "first_call");
    assert.equal(create?.body.explanation.match, "question");
    assert.equal(create?.body.kind, "answer_question");
    const ack = f.calls.find((c) => c.method === "POST" && c.path === "/api/decisions/dec-1/ack");
    assert.ok(ack);
    assert.deepEqual(ack.body, {});
    assert.ok(f.calls.filter((c) => c.method === "POST").every((c) => c.ctype === "application/json"));
    // ack comes before the output (wait → ack)
    const order = f.calls.map((c) => c.path);
    assert.ok(order.findIndex((p) => p.includes("/wait")) < order.indexOf("/api/decisions/dec-1/ack"));
  });
  assert.deepEqual(readdirSync(join(sp, "ukagai")), ["e.used.md"]);
});

test("fails open and still outputs when multiSelect is absent from stdin", async () => {
  const sp = tmpDir();
  writeFile(join(sp, "ukagai", "e.md"), explanationFor(Q));
  const input = t1(sp);
  delete input.tool_input.questions[0].multiSelect;
  await withServer(answerHandler({ [Q]: "A" }), async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(input));
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "allow");
  });
});

test("server absent (closed port): empty stdout, exit 0, within 1.5 seconds", async () => {
  const f = await fakeServer();
  const port = f.port;
  await f.close();
  const sp = tmpDir();
  writeFile(join(sp, "ukagai", "e.md"), explanationFor(Q));
  const r = await runHook(["--server", `http://127.0.0.1:${port}`, "--data-dir", dataDirWithToken()], JSON.stringify(t1(sp)));
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
  // the real work, excluding node + tsx startup, is short (1.5 seconds including startup)
  assert.ok(r.ms < 1500, `ms=${r.ms}`);
});

test("without a token it is treated as unreachable and stdout is empty", async () => {
  await withServer(() => false, async (f) => {
    const sp = tmpDir();
    writeFile(join(sp, "ukagai", "e.md"), explanationFor(Q));
    const r = await runHook(args(f, tmpDir()), JSON.stringify(t1(sp)));
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.equal(f.calls.length, 0);
  });
});

test("--budget 30 (default poll timeout) hands off without polling: deny asking for the same call, no fallback", async () => {
  const sp = tmpDir();
  writeFile(join(sp, "ukagai", "e.md"), explanationFor(Q));
  await withServer(() => false, async (f, d) => {
    const r = await runHook(args(f, d, "--budget", "30"), JSON.stringify(t1(sp)));
    assert.equal(r.code, 0);
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "deny");
    assert.equal(
      out.permissionDecisionReason,
      "[ukagai, not a failure] The human has not answered yet; the question stays open in ukagai. Call AskUserQuestion again now with exactly the same question and options to keep waiting for the answer. Do not ask in prose and do not change the question.",
    );
    assert.ok(!f.calls.some((c) => c.path.includes("/wait")));
    const ho = f.calls.find((c) => c.method === "POST" && c.path === "/api/decisions/dec-1/handoff");
    assert.deepEqual(ho?.body, { session_id: t1(sp).session_id });
    assert.ok(!f.calls.some((c) => c.path.endsWith("/answer")));
  });
});

test("handoff: logged as `handoff` (not fallback_budget) with decision_id", async () => {
  const sp = tmpDir();
  writeFile(join(sp, "ukagai", "e.md"), explanationFor(Q));
  await withServer(() => false, async (f, d) => {
    await runHook(args(f, d, "--budget", "30"), JSON.stringify(t1(sp)));
    const log = readFileSync(join(d, "hook.log"), "utf8");
    assert.match(log, /"event":"handoff"[^\n]*"decision_id":"dec-1"/);
    assert.doesNotMatch(log, /fallback_budget/);
  });
});

test("handoff that the server cannot record is a real failure: fallback and empty stdout", async () => {
  const sp = tmpDir();
  writeFile(join(sp, "ukagai", "e.md"), explanationFor(Q));
  const h: Handler = (req, res) => (req.path.endsWith("/handoff") ? (res.writeHead(409).end(), true) : false);
  await withServer(h, async (f, d) => {
    const r = await runHook(args(f, d, "--budget", "30"), JSON.stringify(t1(sp)));
    assert.equal(r.stdout, "");
    assert.deepEqual(f.calls.find((c) => c.path.endsWith("/answer"))?.body, { fallback: true });
  });
});

test("handoff of an ExitPlanMode names ExitPlanMode", async () => {
  const plan = "# Plan\n\n## Steps\n\n1. Fix it.\n\n## Scope and reversibility\n\nOne file only. Revertable with git revert.\n";
  const input = { ...t1(tmpDir()), tool_name: "ExitPlanMode", tool_input: { plan, planFilePath: "/x/plan.md" }, permission_mode: "plan" };
  await withServer(() => false, async (f, d) => {
    const r = await runHook(args(f, d, "--budget", "30"), JSON.stringify(input));
    const reason = JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason;
    assert.match(reason, /Call ExitPlanMode again now with the same plan to keep waiting/);
    assert.ok(f.calls.some((c) => c.path.endsWith("/handoff")));
  });
});

const openDecision = (id: string) => ({ decision: { id, status: "pending", handoffs: 1 } });

test("re-attach: an open decision with the same fingerprint skips the explanation and delivers the answer", async () => {
  const sp = tmpDir(); // no explanation file at all
  const h: Handler = (req, res) => {
    if (req.method === "GET" && req.path.startsWith("/api/sessions/")) return json(res, 200, openDecision("dec-open"));
    if (req.path.includes("/wait")) return json(res, 200, { response: { via: "gui", answers: { [Q]: "B" }, decided_at: NOW() } });
    return false;
  };
  await withServer(h, async (f, d) => {
    const input = t1(sp, { tool_use_id: "toolu_second" });
    const r = await runHook(args(f, d), JSON.stringify(input));
    assert.deepEqual(JSON.parse(r.stdout).hookSpecificOutput.updatedInput.answers, { [Q]: "B" });
    const open = f.calls.find((c) => c.path.startsWith(`/api/sessions/${input.session_id}/open?`));
    const q = new URLSearchParams(open!.path.split("?")[1]);
    assert.equal(q.get("tool_use_id"), "toolu_second");
    assert.equal(q.get("fingerprint"), decisionFingerprint("answer_question", input.tool_input));
    assert.ok(f.calls.some((c) => c.path === "/api/decisions/dec-open/wait?timeout_ms=25000"));
    assert.ok(f.calls.some((c) => c.path === "/api/decisions/dec-open/ack"));
    assert.ok(!f.calls.some((c) => c.method === "POST" && c.path === "/api/decisions"));
    assert.match(readFileSync(join(d, "hook.log"), "utf8"), /"event":"reattach"[^\n]*"decision_id":"dec-open"/);
  });
});

test("re-attach: /open answering 404 falls through to today's path (the explanation is required)", async () => {
  const sp = tmpDir();
  await withServer(() => false, async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(t1(sp)));
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
    assert.ok(f.calls.some((c) => c.path.startsWith("/api/sessions/") && c.path.includes("/open?")));
    const create = f.calls.find((c) => c.method === "POST" && c.path === "/api/decisions");
    assert.equal(create?.body.status, "denied_explain");
  });
});

test("server that always returns 204: hands off once less than poll + 5 seconds remain", async () => {
  const sp = tmpDir();
  writeFile(join(sp, "ukagai", "e.md"), explanationFor(Q));
  const h: Handler = (req, res) => {
    if (req.path.includes("/wait")) {
      setTimeout(() => res.writeHead(204).end(), 400);
      return true;
    }
    return false;
  };
  await withServer(h, async (f, d) => {
    const r = await runHook(args(f, d, "--budget", "6.3", "--poll-timeout-ms", "1000"), JSON.stringify(t1(sp)));
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
    assert.equal(f.calls.filter((c) => c.path.includes("/wait")).length, 1);
    assert.ok(f.calls.at(-1)?.path.endsWith("/handoff"));
  });
});

test("wait returning 404: empty stdout, exit 0", async () => {
  const sp = tmpDir();
  writeFile(join(sp, "ukagai", "e.md"), explanationFor(Q));
  await withServer((req, res) => (req.path.includes("/wait") ? (res.writeHead(404).end(), true) : false), async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(t1(sp)));
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.ok(!f.calls.some((c) => c.path.endsWith("/ack")));
  });
});

test("via: terminal (answered in the terminal from the GUI): empty stdout and no ack", async () => {
  const sp = tmpDir();
  writeFile(join(sp, "ukagai", "e.md"), explanationFor(Q));
  const h: Handler = (req, res) =>
    req.path.includes("/wait") ? json(res, 200, { response: { via: "terminal", decided_at: NOW() } }) : false;
  await withServer(h, async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(t1(sp)));
    assert.equal(r.stdout, "");
    assert.ok(!f.calls.some((c) => c.path.endsWith("/ack")));
  });
});

test("no explanation file → deny (absolute save path and verbatim question) and denied_explain is registered", async () => {
  const sp = tmpDir();
  await withServer(() => false, async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(t1(sp)));
    assert.equal(r.code, 0);
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "deny");
    assert.ok(out.permissionDecisionReason.includes(join(sp, "ukagai", "explain.md")));
    assert.ok(out.permissionDecisionReason.includes(Q));
    const create = f.calls.find((c) => c.method === "POST" && c.path === "/api/decisions");
    assert.equal(create?.body.status, "denied_explain");
    assert.deepEqual(create?.body.missing, ["file"]);
    assert.ok(!f.calls.some((c) => c.path.includes("/wait")));
  });
});

test("malformed explanation → the deny reason names the missing items", async () => {
  const sp = tmpDir();
  writeFile(join(sp, "ukagai", "e.md"), explanationFor(Q).replace(/\| B .*\n/, ""));
  await withServer(() => false, async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(t1(sp)));
    const reason = JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason;
    assert.match(reason, /options table/);
  });
  assert.ok(existsSync(join(sp, "ukagai", "e.md")), "a defective file is not renamed");
});

test("--deny-template B gives the variant B wording", async () => {
  const sp = tmpDir();
  await withServer(() => false, async (f, d) => {
    const r = await runHook(args(f, d, "--deny-template", "B"), JSON.stringify(t1(sp)));
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, /Could you write/);
  });
});

const deniedRecord = (createdAt: string, extra: Record<string, unknown> = {}) => ({
  id: "old",
  kind: "answer_question",
  status: "denied_explain",
  created_at: createdAt,
  session: { session_id: "00000000-0000-4000-8000-000000000001", cwd: "/", transcript_path: "/" },
  request: { questions: [{ question: Q }] },
  ...extra,
});

test("denied_explain within 2 minutes + no file → no deny; registered as none / loop_guard", async () => {
  const sp = tmpDir();
  const h: Handler = (req, res) =>
    req.method === "GET" && req.path.startsWith("/api/decisions?")
      ? json(res, 200, [deniedRecord(new Date(Date.now() - 30_000).toISOString())])
      : req.path.includes("/wait")
        ? json(res, 200, { response: { via: "gui", answers: { [Q]: "A" }, decided_at: NOW() } })
        : false;
  await withServer(h, async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(t1(sp)));
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "allow");
    const create = f.calls.find((c) => c.method === "POST" && c.path === "/api/decisions");
    assert.equal(create?.body.explanation.attached_via, "none");
    assert.equal(create?.body.explanation.none_reason, "loop_guard");
    assert.equal(create?.body.status, undefined);
  });
});

test("denied_explain within 2 minutes and an explanation attached → after_deny + first_denied_at", async () => {
  const sp = tmpDir();
  writeFile(join(sp, "ukagai", "e.md"), explanationFor(Q));
  const at = new Date(Date.now() - 30_000).toISOString();
  const h: Handler = (req, res) =>
    req.method === "GET" && req.path.startsWith("/api/decisions?")
      ? json(res, 200, [deniedRecord(at)])
      : answerHandler({ [Q]: "A" })(req, res);
  await withServer(h, async (f, d) => {
    await runHook(args(f, d), JSON.stringify(t1(sp)));
    const create = f.calls.find((c) => c.method === "POST" && c.path === "/api/decisions");
    assert.equal(create?.body.explanation.attached_via, "after_deny");
    assert.equal(create?.body.first_denied_at, undefined, "first_denied_at is set by the server");
  });
});

test("a denied_explain older than 2 minutes is outside the loop guard (deny again)", async () => {
  const sp = tmpDir();
  const h: Handler = (req, res) =>
    req.method === "GET" && req.path.startsWith("/api/decisions?")
      ? json(res, 200, [deniedRecord(new Date(Date.now() - 200_000).toISOString())])
      : false;
  await withServer(h, async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(t1(sp)));
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
  });
});

test("permission_mode: plan → no deny even without a file; none / plan_mode", async () => {
  const sp = tmpDir();
  await withServer(answerHandler({ [Q]: "A" }), async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(t1(sp, { permission_mode: "plan" })));
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "allow");
    const create = f.calls.find((c) => c.method === "POST" && c.path === "/api/decisions");
    assert.equal(create?.body.explanation.attached_via, "none");
    assert.equal(create?.body.explanation.none_reason, "plan_mode");
  });
});

// ---- plan mode: the explanation is a block inside the plan file ----

const BLOCK_OPEN = "<!-- ukagai-explain -->";
const BLOCK_CLOSE = "<!-- /ukagai-explain -->";
const blockFor = (q: string, explanation = explanationFor(q)) => `${BLOCK_OPEN}\n${explanation}${BLOCK_CLOSE}\n`;

/** A temp HOME with a plan file and a transcript that names it in the plan-mode reminder */
function planEnv(planText: string) {
  const home = tmpDir("ukagai-planhome-");
  const planPath = join(home, ".claude", "plans", "my-plan.md");
  writeFile(planPath, planText);
  const transcript = join(home, ".claude", "projects", "p", "s.jsonl");
  const reminder = `Plan mode is active. You should create your plan at ${planPath} using the Write tool. You should build your plan incrementally.`;
  writeFile(transcript, JSON.stringify({ type: "user", isMeta: true, message: { role: "user", content: [{ type: "text", text: reminder }] } }) + "\n");
  return { home, planPath: realpathSync(planPath), transcript };
}
const planInput = (e: { transcript: string }, extra: Record<string, unknown> = {}) => ({
  ...t1(tmpDir()),
  permission_mode: "plan",
  transcript_path: e.transcript,
  ...extra,
});

test("plan mode + plan file without a block → deny with the plan-mode text and the plan file path", async () => {
  const e = planEnv("# Plan\n");
  await withServer(() => false, async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(planInput(e)), e.home);
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "deny");
    const reason: string = out.permissionDecisionReason;
    assert.ok(reason.includes(e.planPath));
    assert.match(reason, /In plan mode the explanation goes into your plan file/);
    assert.ok(reason.includes(BLOCK_OPEN) && reason.includes(BLOCK_CLOSE));
    assert.ok(reason.includes(Q));
    assert.ok(reason.length <= 1600);
    const create = f.calls.find((c) => c.method === "POST" && c.path === "/api/decisions");
    assert.equal(create?.body.status, "denied_explain");
    assert.deepEqual(create?.body.missing, ["file"]);
  });
});

test("plan mode + valid block → registered with the block as the explanation; the plan file is untouched", async () => {
  const text = "# Plan\n\n## Steps\n1. x\n\n" + blockFor(Q);
  const e = planEnv(text);
  const before = readdirSync(join(e.home, ".claude", "plans"));
  await withServer(answerHandler({ [Q]: "A" }), async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(planInput(e)), e.home);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "allow");
    const create = f.calls.find((c) => c.method === "POST" && c.path === "/api/decisions");
    const ex = create?.body.explanation;
    assert.equal(ex.markdown, explanationFor(Q).trim());
    assert.ok(ex.path.endsWith("#ukagai-explain"));
    assert.ok(ex.path.startsWith(e.planPath));
    assert.equal(ex.match, "question");
    assert.equal(ex.attached_via, "first_call");
    assert.equal(ex.none_reason, undefined);
  });
  assert.deepEqual(readdirSync(join(e.home, ".claude", "plans")), before);
  assert.equal(readFileSync(e.planPath, "utf8"), text);
});

test("plan mode + invalid block (no Options table) → deny names the missing item", async () => {
  const e = planEnv("# Plan\n" + blockFor(Q, explanationFor(Q).replace(/\| .*\|\n/g, "")));
  await withServer(() => false, async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(planInput(e)), e.home);
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "deny");
    assert.match(out.permissionDecisionReason, /In plan mode the explanation goes into your plan file/);
    const create = f.calls.find((c) => c.method === "POST" && c.path === "/api/decisions");
    assert.ok(create?.body.missing.includes("table"));
    assert.match(out.permissionDecisionReason, /Missing: [^.]*(table|Options)/i);
  });
});

test("plan mode + a block for another question only → deny", async () => {
  const e = planEnv("# Plan\n" + blockFor("Something else?"));
  await withServer(() => false, async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(planInput(e)), e.home);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
  });
});

test("plan mode without any plan file → today's behaviour (none / plan_mode)", async () => {
  const home = tmpDir("ukagai-planhome-");
  const transcript = join(home, ".claude", "projects", "p", "s.jsonl");
  writeFile(transcript, JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n");
  await withServer(answerHandler({ [Q]: "A" }), async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(planInput({ transcript })), home);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "allow");
    const create = f.calls.find((c) => c.method === "POST" && c.path === "/api/decisions");
    assert.equal(create?.body.explanation.attached_via, "none");
    assert.equal(create?.body.explanation.none_reason, "plan_mode");
  });
});

test("plan mode: a denied_explain within 2 minutes → loop guard (no explanation, none_reason loop_guard)", async () => {
  const e = planEnv("# Plan\n");
  const h: Handler = (req, res) =>
    req.method === "GET" && req.path.startsWith("/api/decisions?")
      ? json(res, 200, [deniedRecord(new Date(Date.now() - 30_000).toISOString())])
      : answerHandler({ [Q]: "A" })(req, res);
  await withServer(h, async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(planInput(e)), e.home);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "allow");
    const create = f.calls.find((c) => c.method === "POST" && c.path === "/api/decisions");
    assert.equal(create?.body.explanation.none_reason, "loop_guard");
  });
});

test("ExitPlanMode with explanation blocks in plan → the registered plan has none and still passes the Scope check", async () => {
  const plan = GOOD_PLAN_FOR_BLOCKS + blockFor(Q) + blockFor("Second?");
  const h: Handler = (req, res) =>
    req.path.includes("/wait") ? json(res, 200, { response: { via: "gui", approve: true, decided_at: NOW() } }) : false;
  await withServer(h, async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(planWith(plan)));
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "allow");
    const create = f.calls.find((c) => c.method === "POST" && c.path === "/api/decisions");
    assert.equal(create?.body.kind, "approve_plan");
    assert.equal(create?.body.status, undefined);
    assert.equal(create?.body.request.plan, GOOD_PLAN_FOR_BLOCKS);
    assert.ok(!create?.body.explanation.markdown.includes("ukagai-explain"));
    assert.equal(create?.body.explanation.attached_via, "first_call");
  });
});

const planWith = (extra: string) => ({ ...fx("t5-stdin.json"), tool_input: { ...fx("t5-stdin.json").tool_input, plan: extra } });
const GOOD_PLAN_FOR_BLOCKS = "# Plan\n\n## Steps\n1. x\n\n## Scope and reversibility\nReversibility: reversible\nScope: file\nOne file only. A revert undoes it.\n\n";
const GOOD_PLAN = "# Plan\n\n## Scope and reversibility\nOne file only. A revert undoes it.\n";

test("T5: ExitPlanMode approve matches t5-stdout.json (a defective plan is denied the first time, so use a plan with the section)", async () => {
  const input = fx("t5-stdin.json");
  const withImpact = { ...input, tool_input: { ...input.tool_input, plan: input.tool_input.plan + "\n## Scope and reversibility\nNone.\n" } };
  const h: Handler = (req, res) =>
    req.path.includes("/wait") ? json(res, 200, { response: { via: "gui", approve: true, decided_at: NOW() } }) : false;
  await withServer(h, async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(withImpact));
    const expected = fx("t5-stdout.json");
    expected.hookSpecificOutput.updatedInput = withImpact.tool_input;
    assert.deepEqual(JSON.parse(r.stdout), expected);
    const create = f.calls.find((c) => c.method === "POST" && c.path === "/api/decisions");
    assert.equal(create?.body.kind, "approve_plan");
    assert.equal(create?.body.explanation.attached_via, "first_call");
    assert.ok(f.calls.some((c) => c.path.endsWith("/ack")));
  });
});

test("plan: Reversibility / Scope lines in the section are attached to the explanation; without them nothing is", async () => {
  const h: Handler = (req, res) =>
    req.path.includes("/wait") ? json(res, 200, { response: { via: "gui", approve: true, decided_at: NOW() } }) : false;
  const create = async (plan: string) =>
    withServer(h, async (f, d) => {
      await runHook(args(f, d), JSON.stringify(planWith(plan)));
      return f.calls.find((c) => c.method === "POST" && c.path === "/api/decisions")?.body.explanation;
    });
  const withMeta = await create("# Plan\n\n## Scope and reversibility\n- Reversibility: costly\n- Scope: repo\nA revert undoes it.\n");
  assert.equal(withMeta.reversibility, "costly");
  assert.equal(withMeta.scope, "repo");
  const without = await create(GOOD_PLAN);
  assert.ok(!("reversibility" in without) && !("scope" in without));
});

test("UKAGAI_DISABLE=1: no output, no server calls, exit 0", async () => {
  const sp = tmpDir();
  writeFile(join(sp, "ukagai", "e.md"), explanationFor(Q));
  await withServer(answerHandler({ [Q]: "B" }), async (f, d) => {
    const prev = process.env["UKAGAI_DISABLE"];
    process.env["UKAGAI_DISABLE"] = "1";
    try {
      const r = await runHook(args(f, d), JSON.stringify(t1(sp)));
      assert.equal(r.code, 0);
      assert.equal(r.stdout, "");
      assert.equal(f.calls.length, 0);
    } finally {
      if (prev === undefined) delete process.env["UKAGAI_DISABLE"];
      else process.env["UKAGAI_DISABLE"] = prev;
    }
  });
});

test("T5 real fixture (no scope section): denied the first time; the second (with denied_explain) is registered as loop_guard and matches t5-stdout.json", async () => {
  const input = fx("t5-stdin.json");
  await withServer(() => false, async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(input));
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "deny");
    assert.match(out.permissionDecisionReason, /Scope and reversibility/);
    assert.equal(f.calls.find((c) => c.method === "POST")?.body.status, "denied_explain");
  });
  const h: Handler = (req, res) =>
    req.method === "GET" && req.path.startsWith("/api/decisions?")
      ? json(res, 200, [deniedRecord(new Date(Date.now() - 600_000).toISOString(), { kind: "approve_plan", request: { plan: "x" }, session: { session_id: input.session_id, cwd: "/", transcript_path: "/" } })])
      : req.path.includes("/wait")
        ? json(res, 200, { response: { via: "gui", approve: true, decided_at: NOW() } })
        : false;
  await withServer(h, async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(input));
    assert.deepEqual(JSON.parse(r.stdout), fx("t5-stdout.json"));
    const create = f.calls.find((c) => c.method === "POST" && c.path === "/api/decisions");
    assert.equal(create?.body.explanation.none_reason, "loop_guard");
  });
});

test("ExitPlanMode rejection → deny + reason; approval with set_mode_auto is allow (the hook does nothing)", async () => {
  const h = (response: object): Handler => (req, res) =>
    req.path.includes("/wait") ? json(res, 200, { response: { via: "gui", decided_at: NOW(), ...response } }) : false;
  await withServer(h({ approve: false, reason: "x" }), async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(planWith(GOOD_PLAN)));
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "deny");
    assert.equal(out.permissionDecisionReason, "x");
  });
  await withServer(h({ approve: true, set_mode_auto: true }), async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(planWith(GOOD_PLAN)));
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "allow");
    assert.equal(f.calls.filter((c) => c.path.includes("pending-mode-switch")).length, 0);
  });
});

const perm = (extra = {}) => ({
  session_id: "s1",
  transcript_path: "/t",
  cwd: "/c",
  hook_event_name: "PermissionRequest",
  tool_name: "Write",
  ...extra,
});

test("PermissionRequest: pending-mode-switch present → emits setMode auto and consumes it", async () => {
  const h: Handler = (req, res) =>
    req.method === "GET" && req.path === "/api/sessions/s1/pending-mode-switch" ? json(res, 200, { pending: true }) : false;
  await withServer(h, async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(perm()));
    assert.deepEqual(JSON.parse(r.stdout), {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow", updatedPermissions: [{ type: "setMode", mode: "auto", destination: "session" }] },
      },
    });
    assert.ok(f.calls.some((c) => c.method === "POST" && c.path === "/api/sessions/s1/pending-mode-switch/consume"));
  });
});

test("PermissionRequest: absent → empty; tools other than Write / Edit are empty too", async () => {
  await withServer(() => false, async (f, d) => {
    assert.equal((await runHook(args(f, d), JSON.stringify(perm()))).stdout, "");
    assert.equal((await runHook(args(f, d), JSON.stringify(perm({ tool_name: "Bash" })))).stdout, "");
    assert.ok(!f.calls.some((c) => c.path.endsWith("/consume")));
  });
});

for (const ev of ["SessionStart", "SubagentStart"]) {
  test(`${ev} → additionalContext contains the scratchpad path (no server needed)`, async () => {
    const sp = "/private/tmp/x/scratchpad";
    const r = await runHook(
      ["--data-dir", tmpDir(), "--no-autostart"],
      JSON.stringify({ session_id: "s1", transcript_path: "/t", cwd: "/c", scratchpad_dir: sp, hook_event_name: ev }),
    );
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, ev);
    assert.ok(out.additionalContext.includes(`${sp}/ukagai/`));
    assert.doesNotMatch(out.additionalContext, /https?:|\/api\//);
    assert.equal(out.additionalContext.split("\n").length, 5);
    assert.ok(out.additionalContext.includes("reversibility is reversible / costly / irreversible, scope is file / repo / machine / external"));
    assert.doesNotMatch(out.additionalContext, /[ぁ-んァ-ン一-龥]/);
    assert.ok(out.additionalContext.includes("Write the explanation file in English."));
    assert.ok(out.additionalContext.includes('Explanations and plans are written in ukagai Markdown (callouts, task lists, details, Mermaid, badges, columns, images); the palette is in skill ukagai-explain, section "Rich Markdown".'));
  });
}

test("SessionStart with lang: ja in config.json adds the Japanese instruction (still 5 lines, English text)", async () => {
  const dd = tmpDir();
  writeFile(join(dd, "config.json"), JSON.stringify({ lang: "ja" }));
  const r = await runHook(
    ["--data-dir", dd, "--no-autostart"],
    JSON.stringify({ session_id: "s1", transcript_path: "/t", cwd: "/c", hook_event_name: "SessionStart" }),
  );
  const ctx: string = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes("Write the explanation file in Japanese (the human reads it in Japanese); section headings may be English or Japanese."));
  assert.ok(ctx.includes("(推奨)") && ctx.includes("完了。続けて / この手順を飛ばして続けて / ここで止める"));
  assert.ok(!ctx.includes("Write the explanation file in English."));
  assert.equal(ctx.split("\n").length, 5);
});

test("contextText: en and ja differ only by the language sentence", () => {
  const en = contextText("/d", "en");
  const ja = contextText("/d", "ja");
  assert.equal(en.split("\n").length, 5);
  assert.equal(ja.split("\n").length, 5);
  assert.equal(contextText("/d"), en);
  const sentence = /Write the explanation file in Japanese[^\n]*?ここで止める\./;
  assert.ok(sentence.test(ja));
  assert.equal(ja.replace(sentence, "Write the explanation file in English."), en);
});

test("SessionStart without scratchpad_dir uses data-dir/explain/<session_id>", async () => {
  const dd = tmpDir();
  const r = await runHook(
    ["--data-dir", dd, "--no-autostart"],
    JSON.stringify({ session_id: "s9", transcript_path: "/t", cwd: "/c", hook_event_name: "SessionStart" }),
  );
  assert.ok(JSON.parse(r.stdout).hookSpecificOutput.additionalContext.includes(join(dd, "explain", "s9")));
});

const stop = (msg: string) => ({
  session_id: "s1",
  transcript_path: "/t",
  cwd: "/c",
  hook_event_name: "Stop",
  last_assistant_message: msg,
});

test("Stop: a question like \"Which one?\" → event with escaped_question: true; a plain sentence does not get it", async () => {
  await withServer(() => false, async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(stop("A と B のどちらにしますか？")));
    assert.equal(r.stdout, "");
    const ev = f.calls.find((c) => c.path === "/api/events");
    assert.equal(ev?.body.escaped_question, true);
    assert.equal(ev?.body.hook_event_name, "Stop");
    assert.ok(typeof ev?.body.received_at === "string");
    await runHook(args(f, d), JSON.stringify(stop("Done.")));
    const evs = f.calls.filter((c) => c.path === "/api/events");
    assert.equal(evs[1]?.body.escaped_question, undefined);
  });
});

test("Stop: blocker vocabulary + stop_hook_active: false → decision: block, event has blocker_detected: true", async () => {
  await withServer(() => false, async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(stop("gcloud の認証がないため進められません。")));
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, "block");
    assert.ok(out.reason.includes("ukagai-explain"));
    assert.ok(out.reason.length <= 600);
    const ev = f.calls.find((c) => c.path === "/api/events");
    assert.equal(ev?.body.blocker_detected, true);
  });
});

test("Stop: stop_hook_active: true / no vocabulary match / plan mode / --observe produce no output", async () => {
  await withServer(() => false, async (f, d) => {
    const msg = "gcloud の認証がないため進められません。";
    const run = async (input: Record<string, unknown>, ...more: string[]) =>
      (await runHook(args(f, d, ...more), JSON.stringify(input))).stdout;
    assert.equal(await run({ ...stop(msg), stop_hook_active: true }), "");
    // Q3-05: a Stop that did not block does not get blocker_detected
    assert.equal(f.calls.filter((c) => c.path === "/api/events").at(-1)?.body.blocker_detected, undefined);
    assert.equal(await run(stop("The implementation is finished.")), "");
    assert.equal(await run({ ...stop(msg), permission_mode: "plan" }), "");
    assert.equal(await run(stop(msg), "--observe"), "");
    assert.equal(f.calls.filter((c) => c.path === "/api/events").at(-1)?.body.blocker_detected, undefined);
    assert.equal(await run({ ...stop(msg), last_assistant_message: undefined }), "");
  });
});

test("Stop: still returns block when the server is absent (event failures are swallowed)", async () => {
  const r = await runHook(["--server", "http://127.0.0.1:1", "--data-dir", dataDirWithToken()], JSON.stringify(stop("Permission denied, so I cannot proceed.")));
  assert.equal(JSON.parse(r.stdout).decision, "block");
  assert.ok(r.ms < 2500);
});

test("isEscapedQuestion: true only when the end is ？/? (marks are ignored, keywords are not checked)", () => {
  assert.equal(isEscapedQuestion("A と B のどちらにしますか？"), true);
  assert.equal(isEscapedQuestion("次はどうしますか？**"), true);
  assert.equal(isEscapedQuestion("「どうしますか？」"), true);
  assert.equal(isEscapedQuestion("Which one?"), true);
  assert.equal(isEscapedQuestion("『A と B のどちらにしますか？』への回答は『A』でした。"), false);
  assert.equal(isEscapedQuestion("教えてください。"), false);
  assert.equal(isEscapedQuestion("Please tell me."), false);
  assert.equal(isEscapedQuestion(undefined), false);
});

test("SessionEnd / UserPromptSubmit send an event", async () => {
  await withServer(() => false, async (f, d) => {
    for (const name of ["SessionEnd", "UserPromptSubmit"]) {
      await runHook(args(f, d), JSON.stringify({ ...stop("x"), hook_event_name: name }));
    }
    assert.deepEqual(f.calls.map((c) => c.body.hook_event_name), ["SessionEnd", "UserPromptSubmit"]);
  });
});

test("--observe: PreToolUse sends start and PostToolUse sends end; stdout is empty (no deny, no decision registered)", async () => {
  const sp = tmpDir();
  await withServer(() => false, async (f, d) => {
    const pre = await runHook(args(f, d, "--observe"), JSON.stringify(t1(sp)));
    const post = await runHook(args(f, d, "--observe"), JSON.stringify(t1(sp, { hook_event_name: "PostToolUse" })));
    assert.equal(pre.stdout, "");
    assert.equal(post.stdout, "");
    assert.deepEqual(f.calls.map((c) => c.body.observe), [{ phase: "start" }, { phase: "end" }]);
    assert.ok(f.calls.every((c) => c.path === "/api/events"));
  });
});

test("broken JSON on stdin → empty, exit 0", async () => {
  const r = await runHook([], "{not json");
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
});

test("unrelated tools: empty stdout, exit 0 even without a server", async () => {
  const r = await runHook(["--server", "http://127.0.0.1:1", "--data-dir", tmpDir()], '{"tool_name":"Bash","hook_event_name":"PreToolUse"}');
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
});

const multiInput = (sp: string, extra: Record<string, unknown> = {}) => {
  const base = t1(sp, extra) as { tool_input: { questions: unknown[] } };
  const q2 = { question: "C と D のどちらにしますか？", header: "Choice 2", options: [{ label: "C", description: "c" }, { label: "D", description: "d" }], multiSelect: false };
  return { ...base, tool_input: { questions: [...base.tool_input.questions, q2] } };
};

test("multiple questions → deny even with an explanation file (one question per call) and denied_explain is registered", async () => {
  const sp = tmpDir();
  writeFile(join(sp, "ukagai", "e.md"), explanationFor(Q));
  await withServer(() => false, async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(multiInput(sp)));
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "deny");
    assert.match(out.permissionDecisionReason, /Ask one question per AskUserQuestion call \(this call had 2\)/);
    const create = f.calls.find((c) => c.method === "POST" && c.path === "/api/decisions");
    assert.equal(create?.body.status, "denied_explain");
    assert.deepEqual(create?.body.missing, ["multi"]);
    assert.equal(create?.body.explanation, undefined);
    assert.ok(!f.calls.some((c) => c.path.includes("/wait")));
  });
  assert.ok(existsSync(join(sp, "ukagai", "e.md")), "the explanation file is not consumed");
});

test("a multi-question deny within 2 minutes → no deny; registered as none / loop_guard (question text is not compared)", async () => {
  const sp = tmpDir();
  const rec = deniedRecord(new Date(Date.now() - 30_000).toISOString(), {
    request: { questions: [{ question: "another question" }, { question: "one more" }] },
  });
  const h: Handler = (req, res) =>
    req.method === "GET" && req.path.startsWith("/api/decisions?")
      ? json(res, 200, [rec])
      : req.path.includes("/wait")
        ? json(res, 200, { response: { via: "gui", answers: { [Q]: "A" }, decided_at: NOW() } })
        : false;
  await withServer(h, async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(multiInput(sp)));
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "allow");
    const create = f.calls.find((c) => c.method === "POST" && c.path === "/api/decisions");
    assert.equal(create?.body.explanation.attached_via, "none");
    assert.equal(create?.body.explanation.none_reason, "loop_guard");
  });
});

test("multiple questions in plan mode → none / plan_mode without any requirement", async () => {
  const sp = tmpDir();
  await withServer(answerHandler({ [Q]: "A" }), async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(multiInput(sp, { permission_mode: "plan" })));
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "allow");
    const create = f.calls.find((c) => c.method === "POST" && c.path === "/api/decisions");
    assert.equal(create?.body.explanation.none_reason, "plan_mode");
  });
});

// ---- "Cannot answer" memo enforcement ----

const rewriteHandler = (memo: unknown): Handler => (req, res) => {
  if (req.method === "GET" && req.path.endsWith("/pending-rewrite")) return json(res, 200, memo);
  return answerHandler({ [Q]: "A" })(req, res);
};

const memoOf = (over: Record<string, unknown>) => ({ question: "Another question?", reason: "Unclear", terms: [], body_hash: "0".repeat(64), at: Date.now(), ...over });

async function runWithMemo(md: string, memo: unknown) {
  const sp = tmpDir();
  writeFile(join(sp, "ukagai", "e.md"), md);
  return withServer(rewriteHandler(memo), async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(t1(sp)));
    return { r, f, out: r.stdout ? JSON.parse(r.stdout) : null };
  });
}

const reasonOf = (out: any): string => out.hookSpecificOutput.permissionDecisionReason;
const consumed = (f: Fake) => f.calls.some((c) => c.method === "POST" && c.path.endsWith("/pending-rewrite/consume"));
const withTerms = (defs: string) => explanationFor(Q).replace("It has to be decided.", "The step must be idempotent.") + defs;

test("Cannot answer memo: an identical body is denied as coined_term; a new one passes and consumes the memo", async () => {
  const same = await runWithMemo(explanationFor(Q), memoOf({ body_hash: bodyHash(explanationFor(Q)) }));
  assert.equal(same.out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(reasonOf(same.out), /this one is identical\. Rewrite it/);
  assert.ok(!consumed(same.f));
  assert.deepEqual(same.f.calls.find((c) => c.path === "/api/decisions")?.body.missing, ["coined_term"]);

  const changed = await runWithMemo(explanationFor(Q).replace("It has to be decided.", "Pick one today."), memoOf({ body_hash: bodyHash(explanationFor(Q)) }));
  assert.equal(changed.out.hookSpecificOutput.permissionDecision, "allow");
  assert.ok(consumed(changed.f));
});

test("Cannot answer memo: Undefined terms still used undefined are denied; defined or removed ones pass", async () => {
  const memo = memoOf({ reason: "Undefined terms", terms: ["idempotent"], question: Q });
  const used = await runWithMemo(withTerms(""), memo);
  assert.equal(used.out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(reasonOf(used.out), /the human said they could not understand: idempotent\. Replace each with plain words or define it under Terms/);
  assert.ok(!consumed(used.f));

  const defined = await runWithMemo(withTerms("\n## Terms\n- **idempotent** — safe to run twice with the same result\n"), memo);
  assert.equal(defined.out.hookSpecificOutput.permissionDecision, "allow");
  assert.ok(consumed(defined.f));

  const stub = await runWithMemo(withTerms("\n## Terms\n- **idempotent** — see plan\n"), memo);
  assert.equal(stub.out.hookSpecificOutput.permissionDecision, "deny");

  const gone = await runWithMemo(explanationFor(Q), memo);
  assert.equal(gone.out.hookSpecificOutput.permissionDecision, "allow");
});

test("Cannot answer memo: after Unclear a Recommendation over 3 sentences is denied as recommend_long", async () => {
  const long = explanationFor(Q).replace("I recommend A. If C, choose B.", "I recommend A. It is simple. It is cheap. It is fast. If C, choose B.");
  const memo = memoOf({ reason: "Unclear" });
  const denied = await runWithMemo(long, memo);
  assert.equal(denied.out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(reasonOf(denied.out), /keep the Recommendation to 3 sentences/);
  assert.deepEqual(denied.f.calls.find((c) => c.path === "/api/decisions")?.body.missing, ["recommend_long"]);

  const ok = await runWithMemo(explanationFor(Q), memo);
  assert.equal(ok.out.hookSpecificOutput.permissionDecision, "allow");
  assert.ok(consumed(ok.f));
});

test("Cannot answer memo: after Too much at once the same question is denied as multi; another question passes", async () => {
  const same = await runWithMemo(explanationFor(Q), memoOf({ reason: "Too much at once", question: Q }));
  assert.equal(same.out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(reasonOf(same.out), /split it: ask the first decision only/);
  assert.deepEqual(same.f.calls.find((c) => c.path === "/api/decisions")?.body.missing, ["multi"]);

  const other = await runWithMemo(explanationFor(Q), memoOf({ reason: "Too much at once", question: "Something else entirely?" }));
  assert.equal(other.out.hookSpecificOutput.permissionDecision, "allow");
  assert.ok(consumed(other.f));
});

test("Cannot answer memo: an unreachable or broken memo endpoint changes nothing (fail-open); no memo still consumes nothing harmful", async () => {
  for (const memo of [null, "garbage", { reason: "nope" }]) {
    const r = await runWithMemo(explanationFor(Q), memo);
    assert.equal(r.out.hookSpecificOutput.permissionDecision, "allow");
  }
  const sp = tmpDir();
  writeFile(join(sp, "ukagai", "e.md"), explanationFor(Q));
  await withServer(
    (req, res) => (req.path.endsWith("/pending-rewrite") ? (res.writeHead(500).end(), true) : answerHandler({ [Q]: "A" })(req, res)),
    async (f, d) => {
      const r = await runHook(args(f, d), JSON.stringify(t1(sp)));
      assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "allow");
    },
  );
});

test("Cannot answer memo: plan mode without a plan file never reads it", async () => {
  const sp = tmpDir();
  writeFile(join(sp, "ukagai", "e.md"), explanationFor(Q));
  await withServer(rewriteHandler(memoOf({ body_hash: bodyHash(explanationFor(Q)) })), async (f, d) => {
    await runHook(args(f, d), JSON.stringify(t1(sp, { permission_mode: "plan" })));
    assert.ok(!f.calls.some((c) => c.path.includes("pending-rewrite")));
  });
});

test("Cannot answer memo: plan mode with a plan file and a block reads it like any explanation", async () => {
  const e = planEnv("# Plan\n" + blockFor(Q));
  await withServer(rewriteHandler(memoOf({})), async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(planInput(e)), e.home);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "allow");
    assert.ok(f.calls.some((c) => c.path.includes("pending-rewrite")));
  });
});

// ---- V3: loop guard vs. memo, deny text, language ----

const loopRecord = () => ({
  id: "d1",
  kind: "answer_question",
  status: "denied_explain",
  created_at: new Date(Date.now() - 30_000).toISOString(),
  session: { session_id: "00000000-0000-4000-8000-000000000001", cwd: "/", transcript_path: "/" },
  request: { questions: [{ question: Q }] },
});
const loopHandler = (memo: unknown): Handler => (req, res) =>
  req.method === "GET" && req.path.startsWith("/api/decisions?")
    ? json(res, 200, [loopRecord()])
    : req.method === "GET" && req.path.endsWith("/pending-rewrite")
      ? json(res, 200, memo)
      : answerHandler({ [Q]: "A" })(req, res);

test("H-1: with a Cannot answer memo the loop guard does not apply (second identical ask is still denied); without one it does", async () => {
  const sp = tmpDir();
  const md = withTerms("");
  writeFile(join(sp, "ukagai", "e.md"), md);
  const memo = memoOf({ reason: "Undefined terms", terms: ["idempotent"], question: Q });
  await withServer(loopHandler(memo), async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(t1(sp)));
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
  });
  // no memo, an undefined coined term: the guard lets it through
  const coined = explanationFor(Q).replace("It has to be decided.", "Gate W-T2 is open.");
  writeFile(join(sp, "ukagai", "e.md"), coined);
  await withServer(loopHandler(null), async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(t1(sp)));
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "allow");
    assert.equal(f.calls.find((c) => c.method === "POST" && c.path === "/api/decisions")?.body.explanation.none_reason, "loop_guard");
  });
});

test("H-3: coined_term and the memo sentence together say \"define it under Terms\" once", async () => {
  const md = explanationFor(Q).replace("It has to be decided.", "Gate W-T2 is open.");
  const r = await runWithMemo(md, memoOf({ reason: "Undefined terms", terms: ["W-T2"], question: Q }));
  const reason = reasonOf(r.out);
  assert.match(reason, /the human said they could not understand: W-T2/);
  assert.equal(reason.match(/define it under Terms/g)?.length, 1);
});

test("language: with lang ja an English title / question is denied; Japanese passes; en never checks", async () => {
  const jaMd = explanationFor(Q)
    .replace("title: Choose A or B", "title: AかBかを選ぶ")
    .replace("It has to be decided.", "今日決める必要がある。")
    .replace("recommended: A", "recommended: A (推奨)");
  const input = (q: string, desc: string) => {
    const base = t1(tmpDir());
    base.tool_input.questions[0].question = q;
    for (const o of base.tool_input.questions[0].options) o.description = desc;
    return base;
  };
  const run = async (lang: string, md: string, q: string, desc: string) => {
    const sp = tmpDir();
    writeFile(join(sp, "ukagai", "e.md"), md.replace(/question: .*/, `question: ${q}`));
    return withServer(answerHandler({ [q]: "A" }), async (f, d) => {
      writeFile(join(d, "config.json"), JSON.stringify({ lang }));
      const r = await runHook(args(f, d), JSON.stringify({ ...input(q, desc), scratchpad_dir: sp }));
      return { out: JSON.parse(r.stdout).hookSpecificOutput, f };
    });
  };
  const bad = await run("ja", explanationFor(Q), Q, "日本語の説明");
  assert.equal(bad.out.permissionDecision, "deny");
  assert.deepEqual(bad.f.calls.find((c) => c.path === "/api/decisions")?.body.missing, ["language"]);
  assert.equal((await run("ja", jaMd, "どちらを選びますか?", "日本語の説明")).out.permissionDecision, "allow");
  // question in English
  assert.equal((await run("ja", jaMd, Q, "日本語の説明")).out.permissionDecision, "deny");
  // every description in English
  assert.equal((await run("ja", jaMd, "どちらを選びますか?", "Option A")).out.permissionDecision, "deny");
  assert.equal((await run("en", explanationFor(Q), Q, "Option A")).out.permissionDecision, "allow");
});

// ---- wait retry and hook.log ----

const readLog = (d: string) =>
  existsSync(join(d, "hook.log"))
    ? readFileSync(join(d, "hook.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    : [];

function waitSeq(statuses: number[]): Handler {
  let n = 0;
  return (req, res) => {
    if (req.method === "GET" && req.path.includes("/wait")) {
      const st = statuses[Math.min(n++, statuses.length - 1)]!;
      if (st === 200) return json(res, 200, { response: { via: "gui", answers: { [Q]: "B" }, decided_at: NOW() } });
      res.writeHead(st).end();
      return true;
    }
    return false;
  };
}

test("wait: one 500 then 204 then an answer still produces allow (retry)", async () => {
  const sp = tmpDir();
  writeFile(join(sp, "ukagai", "e.md"), explanationFor(Q));
  await withServer(waitSeq([500, 204, 200]), async (f, d) => {
    const r = await runHook(args(f, d, "--poll-timeout-ms", "1000"), JSON.stringify(t1(sp)));
    assert.match(r.stdout, /"permissionDecision":"allow"/);
    assert.equal(f.calls.filter((c) => c.path.includes("/wait")).length, 3);
    const log = readLog(d);
    assert.deepEqual(log.map((l) => l.event), ["wait_retry"]);
    assert.equal(log[0].status, 500);
  });
});

test("wait: consecutive 500s past the retry window end with empty stdout and wait_error_final", async () => {
  const sp = tmpDir();
  writeFile(join(sp, "ukagai", "e.md"), explanationFor(Q));
  await withServer(waitSeq([500]), async (f, d) => {
    const r = await runHook(args(f, d, "--retry-window-ms", "2500"), JSON.stringify(t1(sp)));
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.ok(f.calls.filter((c) => c.path.includes("/wait")).length >= 3);
    assert.ok(r.ms >= 2400);
    const log = readLog(d);
    assert.equal(log.at(-1).event, "wait_error_final");
    assert.equal(log.at(-1).status, 500);
    assert.ok(log.some((l) => l.event === "wait_retry"));
  });
});

test("wait: 410 is final at once (one request, no retry) and is logged", async () => {
  const sp = tmpDir();
  writeFile(join(sp, "ukagai", "e.md"), explanationFor(Q));
  await withServer(waitSeq([410]), async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(t1(sp)));
    assert.equal(r.stdout, "");
    assert.equal(f.calls.filter((c) => c.path.includes("/wait")).length, 1);
    const log = readLog(d);
    assert.deepEqual(log.map((l) => [l.event, l.status]), [["wait_error_final", 410]]);
    assert.equal(log[0].decision_id, "dec-1");
  });
});

test("ack: one failure is retried and the answer is still delivered", async () => {
  const sp = tmpDir();
  writeFile(join(sp, "ukagai", "e.md"), explanationFor(Q));
  let acks = 0;
  const w = waitSeq([200]);
  const h: Handler = (req, res) => {
    if (req.path.endsWith("/ack") && acks++ === 0) {
      res.writeHead(500).end();
      return true;
    }
    return w(req, res);
  };
  await withServer(h, async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(t1(sp)));
    assert.match(r.stdout, /"permissionDecision":"allow"/);
    assert.equal(f.calls.filter((c) => c.path.endsWith("/ack")).length, 2);
    assert.deepEqual(readLog(d).map((l) => l.event), ["ack_retry"]);
  });
});

test("ack: two failures give no output and ack_failed is logged", async () => {
  const sp = tmpDir();
  writeFile(join(sp, "ukagai", "e.md"), explanationFor(Q));
  const w = waitSeq([200]);
  const h: Handler = (req, res) => (req.path.endsWith("/ack") ? (res.writeHead(500).end(), true) : w(req, res));
  await withServer(h, async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(t1(sp)));
    assert.equal(r.stdout, "");
    assert.equal(readLog(d).at(-1).event, "ack_failed");
  });
});

test("server killed while waiting: wait_error_final in hook.log, and no question / answer text in it", async () => {
  const sp = tmpDir();
  writeFile(join(sp, "ukagai", "e.md"), explanationFor(Q));
  const f = await fakeServer((req, res) => (req.path.includes("/wait") ? (void setTimeout(() => f.close(), 0), true) : false));
  const d = dataDirWithToken();
  try {
    const r = await runHook(args(f, d, "--retry-window-ms", "1500"), JSON.stringify(t1(sp)));
    assert.equal(r.stdout, "");
    const text = readFileSync(join(d, "hook.log"), "utf8");
    const log = readLog(d);
    assert.equal(log.at(-1).event, "wait_error_final");
    assert.equal(log.at(-1).session_id, t1(sp).session_id);
    assert.ok(!text.includes(Q));
    assert.ok(!text.includes("Choose A or B"));
  } finally {
    await f.close();
  }
});

test("hook.log rotates to hook.log.1 past 1 MB and never throws without a data dir", async () => {
  const { hookLog, initHookLog } = await import("../../src/hook/log.js");
  const d = tmpDir();
  writeFile(join(d, "hook.log"), "x".repeat(1024 * 1024 + 1));
  initHookLog(d);
  hookLog("t", { message: "m" });
  assert.ok(existsSync(join(d, "hook.log.1")));
  assert.equal(readLog(d).length, 1);
  initHookLog(join(d, "missing", "dir"));
  hookLog("t", {});
});
