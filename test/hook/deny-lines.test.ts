import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDirWithToken, fakeServer, json, runHook, tmpDir, writeFile, type Fake, type Handler } from "./helpers.js";

const fx = (n: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/${n}`, import.meta.url)), "utf8"));
const Q = "Which do you choose, A or B?";
const NOW = () => new Date().toISOString();
const TAG = "[ukagai, not a failure] ";
const END = "(see hook context).";

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

const t1 = (scratchpad: string, extra: Record<string, unknown> = {}) => ({ ...fx("t1-stdin.json"), scratchpad_dir: scratchpad, ...extra });
const planWith = (plan: string) => ({ ...fx("t5-stdin.json"), tool_input: { ...fx("t5-stdin.json").tool_input, plan } });
const GOOD_PLAN = "# Plan\n\n## Steps\n1. x\n\n## Scope and reversibility\nReversibility: reversible\nScope: file\nOne file only. A revert undoes it.\n";

async function withServer<T>(handler: Handler, fn: (f: Fake, dataDir: string) => Promise<T>): Promise<T> {
  const f = await fakeServer(handler);
  try {
    return await fn(f, dataDirWithToken());
  } finally {
    await f.close();
  }
}
const args = (f: Fake, dataDir: string, ...rest: string[]) => ["--server", f.url, "--data-dir", dataDir, ...rest];
const waitWith = (response: object): Handler => (req, res) =>
  req.path.includes("/wait") ? json(res, 200, { response: { via: "gui", decided_at: NOW(), ...response } }) : false;

interface Out {
  permissionDecision: string;
  permissionDecisionReason: string;
  additionalContext: string;
}
const outOf = (stdout: string): Out => JSON.parse(stdout).hookSpecificOutput;

/** The shape every Claude Code deny shares: one short tagged red line, the instructions in the hook context */
function assertLine(out: Out, wantLine: RegExp, wantContext: RegExp): void {
  assert.equal(out.permissionDecision, "deny");
  const line = out.permissionDecisionReason;
  assert.ok(!line.includes("\n"), line);
  assert.ok(line.length <= 160, `${line.length}: ${line}`);
  assert.ok(line.startsWith(TAG), line);
  assert.ok(line.endsWith(END), line);
  assert.match(line, wantLine);
  assert.ok(out.additionalContext.length > 0);
  assert.ok(out.additionalContext.startsWith("[ukagai"), out.additionalContext);
  assert.match(out.additionalContext, wantContext);
}

// ---- plan-mode helper (a temp HOME with a plan file and a transcript naming it) ----
const BLOCK_OPEN = "<!-- ukagai-explain -->";
const BLOCK_CLOSE = "<!-- /ukagai-explain -->";
function planEnv(planText: string) {
  const home = tmpDir("ukagai-planhome-");
  const planPath = join(home, ".claude", "plans", "my-plan.md");
  writeFile(planPath, planText);
  const transcript = join(home, ".claude", "projects", "p", "s.jsonl");
  const reminder = `Plan mode is active. You should create your plan at ${planPath} using the Write tool. You should build your plan incrementally.`;
  writeFile(transcript, JSON.stringify({ type: "user", isMeta: true, message: { role: "user", content: [{ type: "text", text: reminder }] } }) + "\n");
  return { home, planPath: realpathSync(planPath), transcript };
}
const planInput = (e: { transcript: string }) => ({ ...t1(tmpDir()), permission_mode: "plan", transcript_path: e.transcript });

// ---- 1: several questions ----
test("deny line, several questions", async () => {
  const sp = tmpDir();
  const base = t1(sp) as { tool_input: { questions: unknown[] } };
  const q2 = { question: "C or D?", header: "Choice 2", options: [{ label: "C", description: "c" }, { label: "D", description: "d" }], multiSelect: false };
  const input = { ...base, tool_input: { questions: [...base.tool_input.questions, q2] } };
  await withServer(() => false, async (f, d) => {
    const out = outOf((await runHook(args(f, d), JSON.stringify(input))).stdout);
    assertLine(out, /^\[ukagai, not a failure\] Questions not shown to the human yet: ask one per call \(this call had 2\) /, /Ask one question per AskUserQuestion call/);
  });
});

// ---- 2a / 2b / 2c: the explanation file ----
test("deny line, no explanation file (2a) names no file and the context holds the template", async () => {
  const sp = tmpDir();
  await withServer(() => false, async (f, d) => {
    const out = outOf((await runHook(args(f, d), JSON.stringify(t1(sp)))).stdout);
    assert.equal(out.permissionDecisionReason, `${TAG}Question not shown to the human yet: it has no explanation file ${END}`);
    assertLine(out, /it has no explanation file/, /Save to: .*explain\.md/);
  });
});

test("deny line, file used by an earlier ask (2b): the context names the .used.md file; another question's used file stays 2a", async () => {
  const sp = tmpDir();
  writeFile(join(sp, "ukagai", "old.used.md"), explanationFor(Q));
  await withServer(() => false, async (f, d) => {
    const out = outOf((await runHook(args(f, d), JSON.stringify(t1(sp)))).stdout);
    assertLine(out, /its explanation file was used by the earlier ask /, /a new explanation file: old\.used\.md was used by the earlier ask of this question; write a new one/);
    assert.doesNotMatch(out.additionalContext, /copying it/);
    assert.deepEqual(f.calls.find((c) => c.method === "POST" && c.path === "/api/decisions")?.body.missing, ["file"]);
  });
  const sp2 = tmpDir();
  writeFile(join(sp2, "ukagai", "other.used.md"), explanationFor("Another question?"));
  await withServer(() => false, async (f, d) => {
    const out = outOf((await runHook(args(f, d), JSON.stringify(t1(sp2)))).stdout);
    assert.match(out.permissionDecisionReason, /it has no explanation file/);
    assert.doesNotMatch(out.additionalContext, /was used by the earlier ask/);
  });
});

test("deny line, file used in the data-dir fallback directory (2b)", async () => {
  const sp = tmpDir();
  const d = dataDirWithToken();
  const input = t1(sp);
  writeFile(join(d, "explain", input.session_id, "old.used.md"), explanationFor(Q));
  const f = await fakeServer();
  try {
    const out = outOf((await runHook(args(f, d), JSON.stringify(input))).stdout);
    assertLine(out, /was used by the earlier ask /, /old\.used\.md was used by the earlier ask/);
  } finally {
    await f.close();
  }
});

test("deny line, invalid file (2c) names the count and the codes", async () => {
  const sp = tmpDir();
  // no title, and a Why section over 600 characters
  const md = explanationFor(Q).replace("title: Choose A or B\n", "").replace("It has to be decided.", "It has to be decided. ".repeat(40));
  writeFile(join(sp, "ukagai", "e.md"), md);
  await withServer(() => false, async (f, d) => {
    const out = outOf((await runHook(args(f, d), JSON.stringify(t1(sp)))).stdout);
    assertLine(out, /its explanation file needs 2 fixes: (title, why_long|why_long, title) \(see hook context\)\.$/, /Missing: /);
    const missing = f.calls.find((c) => c.method === "POST" && c.path === "/api/decisions")?.body.missing as string[];
    assert.deepEqual([...missing].sort(), ["title", "why_long"]);
  });
  const sp1 = tmpDir();
  writeFile(join(sp1, "ukagai", "e.md"), explanationFor(Q).replace("title: Choose A or B\n", ""));
  await withServer(() => false, async (f, d) => {
    const out = outOf((await runHook(args(f, d), JSON.stringify(t1(sp1)))).stdout);
    assert.match(out.permissionDecisionReason, /its explanation file needs 1 fix: title \(see hook context\)\.$/);
  });
});

// ---- 2d: plan mode ----
test("deny line, plan mode without a block / with an invalid block (2d)", async () => {
  const e = planEnv("# Plan\n");
  await withServer(() => false, async (f, d) => {
    const out = outOf((await runHook(args(f, d), JSON.stringify(planInput(e)), e.home)).stdout);
    assertLine(out, /the plan file has no explanation block for it /, /In plan mode the explanation goes into your plan file/);
  });
  const e2 = planEnv(`# Plan\n${BLOCK_OPEN}\n${explanationFor(Q).replace("title: Choose A or B\n", "")}${BLOCK_CLOSE}\n`);
  await withServer(() => false, async (f, d) => {
    const out = outOf((await runHook(args(f, d), JSON.stringify(planInput(e2)), e2.home)).stdout);
    assertLine(out, /its explanation block in the plan file needs 1 fix: title \(see hook context\)\.$/, /In plan mode the explanation goes into your plan file/);
  });
});

// ---- 3: ExitPlanMode incomplete ----
test("deny line, ExitPlanMode without the Scope and reversibility section", async () => {
  await withServer(() => false, async (f, d) => {
    const out = outOf((await runHook(args(f, d), JSON.stringify(fx("t5-stdin.json")))).stdout);
    assert.equal(out.permissionDecisionReason, `${TAG}Plan not shown to the human yet: it needs a "Scope and reversibility" section ${END}`);
    assertLine(out, /Scope and reversibility/, /Scope and reversibility/);
  });
});

// ---- 4: hand-off ----
test("deny line, hand-off (question and plan)", async () => {
  const sp = tmpDir();
  writeFile(join(sp, "ukagai", "e.md"), explanationFor(Q));
  await withServer(() => false, async (f, d) => {
    const out = outOf((await runHook(args(f, d, "--budget", "30"), JSON.stringify(t1(sp)))).stdout);
    assert.equal(out.permissionDecisionReason, `${TAG}Still waiting for the human in ukagai: call AskUserQuestion again, unchanged ${END}`);
    assertLine(out, /call AskUserQuestion again/, /The human has not answered yet/);
  });
  await withServer(() => false, async (f, d) => {
    const out = outOf((await runHook(args(f, d, "--budget", "30"), JSON.stringify(planWith(GOOD_PLAN)))).stdout);
    assert.equal(out.permissionDecisionReason, `${TAG}Still waiting for the human in ukagai: call ExitPlanMode again, unchanged ${END}`);
    assertLine(out, /call ExitPlanMode again/, /Call ExitPlanMode again now/);
  });
});

// ---- 5 / 6: the human's plan reply ----
test("deny line, plan instruction and plan rejection (with and without a reason)", async () => {
  await withServer(waitWith({ instruct: true, text: "check the tests first" }), async (f, d) => {
    const out = outOf((await runHook(args(f, d), JSON.stringify(planWith(GOOD_PLAN)))).stdout);
    assertLine(out, /Plan not approved yet: the human asked for something first /, /check the tests first[\s\S]*still in plan mode/);
  });
  await withServer(waitWith({ approve: false, reason: "too vague" }), async (f, d) => {
    const out = outOf((await runHook(args(f, d), JSON.stringify(planWith(GOOD_PLAN)))).stdout);
    assertLine(out, /^\[ukagai, not a failure\] The human rejected the plan /, /^\[ukagai\] The human rejected the plan and wrote: too vague$/);
  });
  await withServer(waitWith({ approve: false }), async (f, d) => {
    const out = outOf((await runHook(args(f, d), JSON.stringify(planWith(GOOD_PLAN)))).stdout);
    assertLine(out, /The human rejected the plan /, /without giving a reason/);
  });
});

// ---- 7: checkpoint stop ----
test("deny line, checkpoint stop", async () => {
  const h: Handler = (req, res) =>
    req.path.startsWith("/api/sessions/s-1/instruction")
      ? json(res, 200, { instruction: { decision_id: "d1", kind: "stop", text: "wait", created_at: NOW() } })
      : false;
  await withServer(h, async (f, d) => {
    const input = JSON.stringify({ session_id: "s-1", hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: {}, cwd: "/w" });
    const out = outOf((await runHook(["--checkpoint", "--server", f.url, "--data-dir", d], input)).stdout);
    assertLine(out, /The human read your progress recap and asked you to stop /, /asked you to stop\.[\s\S]*The human adds: wait$/);
  });
});

// ---- message delivery: the question is on its way, and the main agent is held back ----
test("deny line, waiting for a message-delivery answer", async () => {
  const input = JSON.stringify({ session_id: "s-1", hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: {}, cwd: "/w" });
  const h: Handler = (req, res) => (req.path.startsWith("/api/sessions/s-1/instruction") ? json(res, 200, { waiting: { decision_id: "d1", kind: "answer_question" } }) : false);
  await withServer(h, async (f, d) => {
    const out = outOf((await runHook(["--checkpoint", "--server", f.url, "--data-dir", d], input)).stdout);
    assertLine(out, /Your question in ukagai is not answered yet:/, /answer has not reached you yet/);
  });
});

// ---- 8: open guard ----
test("deny line, open of a file", async () => {
  const input = JSON.stringify({ session_id: "s-1", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "open /tmp/x.html" }, cwd: "/w" });
  const out = outOf((await runHook(["--checkpoint", "--server", "http://127.0.0.1:1", "--data-dir", dataDirWithToken()], input)).stdout);
  assertLine(out, /Not opened: the human reads files in ukagai, not in a viewer /, /Reference the file from the explanation instead/);
});

// ---- the file lookup ----
test("data-dir fallback: scratchpad empty, valid file in <data-dir>/explain/<sid>/ → registered, no deny, renamed .used.md there", async () => {
  const sp = tmpDir();
  const d = dataDirWithToken();
  const input = t1(sp);
  writeFile(join(d, "explain", input.session_id, "e.md"), explanationFor(Q));
  const f = await fakeServer(waitWith({ answers: { [Q]: "B" } }));
  try {
    const r = await runHook(args(f, d), JSON.stringify(input));
    assert.equal(outOf(r.stdout).permissionDecision, "allow");
    const create = f.calls.find((c) => c.method === "POST" && c.path === "/api/decisions");
    assert.notEqual(create?.body.status, "denied_explain");
    assert.ok(create?.body.explanation.path.startsWith(join(d, "explain", input.session_id)));
  } finally {
    await f.close();
  }
  assert.deepEqual(readdirSync(join(d, "explain", input.session_id)), ["e.used.md"]);
  assert.ok(!existsSync(join(sp, "ukagai", "e.md")));
});

test("explainDenyLine: a long list of codes is cut with an ellipsis and stays one line of at most 160 characters", async () => {
  const { explainDenyLine } = await import("../../src/hook/explain.js");
  const codes = ["undo", "diagram", "coined_term", "recommend_long", "recommend_cond", "recommend_name", "against_weak", "assumptions_long", "cell_long", "why_long"];
  const line = explainDenyLine({ codes });
  assert.ok(line.length <= 160, line);
  assert.ok(line.includes("needs 10 fixes: undo, diagram"), line);
  assert.match(line, /…\s\(see hook context\)\.$/);
  assert.ok(line.startsWith(TAG));
});
