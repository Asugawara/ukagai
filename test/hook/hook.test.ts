import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
| A | a | b |
| B | a | b |
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

test("--budget 30 (default poll timeout) sends the fallback without polling and stdout is empty", async () => {
  const sp = tmpDir();
  writeFile(join(sp, "ukagai", "e.md"), explanationFor(Q));
  await withServer(() => false, async (f, d) => {
    const r = await runHook(args(f, d, "--budget", "30"), JSON.stringify(t1(sp)));
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.ok(!f.calls.some((c) => c.path.includes("/wait")));
    const ans = f.calls.find((c) => c.path === "/api/decisions/dec-1/answer");
    assert.deepEqual(ans?.body, { fallback: true });
  });
});

test("server that always returns 204: falls back once less than poll + 5 seconds remain", async () => {
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
    assert.equal(r.stdout, "");
    assert.equal(f.calls.filter((c) => c.path.includes("/wait")).length, 1);
    assert.deepEqual(f.calls.at(-1)?.body, { fallback: true });
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

const planWith = (extra: string) => ({ ...fx("t5-stdin.json"), tool_input: { ...fx("t5-stdin.json").tool_input, plan: extra } });
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
  assert.ok(!ctx.includes("Write the explanation file in English."));
  assert.equal(ctx.split("\n").length, 5);
  assert.doesNotMatch(ctx, /[ぁ-んァ-ン一-龥]/);
});

test("contextText: en and ja differ only by the language sentence", () => {
  const en = contextText("/d", "en");
  const ja = contextText("/d", "ja");
  assert.equal(en.split("\n").length, 5);
  assert.equal(ja.split("\n").length, 5);
  assert.equal(contextText("/d"), en);
  assert.equal(
    ja.replace("Write the explanation file in Japanese (the human reads it in Japanese); section headings may be English or Japanese.", "Write the explanation file in English."),
    en,
  );
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
