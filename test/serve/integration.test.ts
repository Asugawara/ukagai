import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start, type ServeHandle } from "../../src/serve/index.js";
import { runHook, spawnHook } from "../hook/helpers.js";

const tmpRoots: string[] = [];
const handles: ServeHandle[] = [];

after(async () => {
  for (const h of handles) await h.close();
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "ukagai-int-"));
  tmpRoots.push(d);
  return d;
}

type Env = { h: ServeHandle; home: string; url: string; hookArgs: string[] };

async function setup(): Promise<Env> {
  const home = tmp();
  const dataDir = tmp();
  const h = await start({ port: 0, dataDir, home });
  handles.push(h);
  const url = `http://127.0.0.1:${h.port}`;
  return { h, home, url, hookArgs: ["--server", url, "--data-dir", dataDir] };
}

function call(env: Env, path: string, body?: unknown) {
  return fetch(env.url + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${env.h.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function waitForPending(env: Env): Promise<any> {
  for (let i = 0; i < 100; i++) {
    const list = (await (await call(env, "/api/decisions?status=pending")).json()) as any[];
    if (list.length > 0) return list[0];
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("decision was not registered");
}

const QUESTION = "Which do you choose, A or B?";
const askInput = {
  questions: [{ question: QUESTION, header: "Choice", options: [{ label: "A" }, { label: "B" }], multiSelect: false }],
};

function stdin(env: Env, scratch: string, toolName: string, toolInput: unknown, mode: string, toolUseId: string): string {
  return JSON.stringify({
    session_id: "sess-int",
    transcript_path: join(env.home, ".claude", "projects", "p", "sess-int.jsonl"),
    cwd: "/nonexistent-ukagai-cwd",
    scratchpad_dir: scratch,
    permission_mode: mode,
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseId,
  });
}

test("(a) AskUserQuestion in plan mode is registered without explanation as none / plan_mode", async () => {
  const env = await setup();
  const hook = runHook(env.hookArgs, stdin(env, tmp(), "AskUserQuestion", askInput, "plan", "tu-a"));
  const d = await waitForPending(env);
  assert.equal(d.explanation.attached_via, "none");
  assert.equal(d.explanation.none_reason, "plan_mode");
  const r = await call(env, `/api/decisions/${d.id}/answer`, { answers: { [QUESTION]: "A" } });
  assert.equal(r.status, 200);
  const out = await hook;
  assert.equal(out.code, 0);
  const j = JSON.parse(out.stdout);
  assert.equal(j.hookSpecificOutput.permissionDecision, "allow");
  assert.deepEqual(j.hookSpecificOutput.updatedInput.answers, { [QUESTION]: "A" });
});

test("(b) ExitPlanMode (with a scope and reversibility section) is registered and allowed on GUI approval", async () => {
  const env = await setup();
  const plan = "# Plan\n\n## Steps\n\n1. Fix it.\n\n## Scope and reversibility\n\nOne file only. Revertable with git revert.\n";
  const hook = runHook(env.hookArgs, stdin(env, tmp(), "ExitPlanMode", { plan, planFilePath: "/x/plan.md" }, "plan", "tu-b"));
  const d = await waitForPending(env);
  assert.equal(d.kind, "approve_plan");
  assert.equal(d.explanation.attached_via, "first_call");
  const r = await call(env, `/api/decisions/${d.id}/answer`, { approve: true });
  assert.equal(r.status, 200);
  const out = await hook;
  assert.equal(out.code, 0);
  assert.equal(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision, "allow");
});

test("(c) a denied_explain within 2 minutes and no explanation file registers as none / loop_guard", async () => {
  const env = await setup();
  const scratch = tmp();
  const session = {
    session_id: "sess-int",
    cwd: "/nonexistent-ukagai-cwd",
    transcript_path: join(env.home, ".claude", "projects", "p", "sess-int.jsonl"),
    scratchpad_dir: scratch,
    permission_mode: "default",
  };
  const seeded = await call(env, "/api/decisions", {
    tool_use_id: "tu-c0",
    kind: "answer_question",
    session,
    request: askInput,
    status: "denied_explain",
  });
  assert.equal(seeded.status, 201);
  const hook = runHook(env.hookArgs, stdin(env, scratch, "AskUserQuestion", askInput, "default", "tu-c"));
  const d = await waitForPending(env);
  assert.equal(d.explanation.attached_via, "none");
  assert.equal(d.explanation.none_reason, "loop_guard");
  await call(env, `/api/decisions/${d.id}/answer`, { fallback: true });
  const out = await hook;
  assert.equal(out.code, 0);
  assert.equal(out.stdout, "");
});

test("(restart) the server restarts (same port, same data-dir) while the hook waits: the hook resumes and allow is emitted", async () => {
  const env = await setup();
  const dataDir = env.hookArgs[3]!;
  const hook = runHook(env.hookArgs, stdin(env, tmp(), "AskUserQuestion", askInput, "plan", "tu-restart"));
  const d = await waitForPending(env);
  await new Promise((r) => setTimeout(r, 300));
  const port = env.h.port;
  await env.h.close();
  const h2 = await start({ port, dataDir, home: env.home });
  handles.push(h2);
  const env2: Env = { ...env, h: h2 };
  const again = (await (await call(env2, `/api/decisions/${d.id}`)).json()) as any;
  assert.equal(again.status, "pending");
  // the hook's retry (1 s backoff) reconnects; answer through the API once it waits again
  await new Promise((r) => setTimeout(r, 1500));
  const r = await call(env2, `/api/decisions/${d.id}/answer`, { answers: { [QUESTION]: "B" } });
  assert.equal(r.status, 200);
  const out = await hook;
  assert.equal(out.code, 0);
  let log = "";
  try { log = readFileSync(join(dataDir, "hook.log"), "utf8"); } catch {}
  assert.notEqual(out.stdout, "", log);
  const j = JSON.parse(out.stdout);
  assert.equal(j.hookSpecificOutput.permissionDecision, "allow");
  assert.deepEqual(j.hookSpecificOutput.updatedInput.answers, { [QUESTION]: "B" });
});

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  test(`(cancel) ${sig} to a waiting hook -> no output, exit 0, decision cancelled`, async () => {
    const env = await setup();
    const hook = spawnHook(env.hookArgs, stdin(env, tmp(), "AskUserQuestion", askInput, "plan", `tu-cancel-${sig}`));
    const d = await waitForPending(env);
    // the signal handler may not be installed right after registration, so wait until it is waiting
    await new Promise((r) => setTimeout(r, 300));
    hook.signal(sig);
    const out = await hook.result;
    assert.equal(out.code, 0);
    assert.equal(out.stdout, "");
    const cur = (await (await call(env, `/api/decisions/${d.id}`)).json()) as any;
    assert.equal(cur.status, "cancelled");
  });
}

test("(cancel) POST /cancel: answer_submitted is answer_lost, terminal is 409, no token is 401", async () => {
  const env = await setup();
  const hook = runHook(env.hookArgs, stdin(env, tmp(), "AskUserQuestion", askInput, "plan", "tu-cancel-api"));
  const d = await waitForPending(env);
  const noAuth = await fetch(`${env.url}/api/decisions/${d.id}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(noAuth.status, 401);
  const c1 = await call(env, `/api/decisions/${d.id}/cancel`, {});
  assert.equal(c1.status, 200);
  assert.equal(((await c1.json()) as any).status, "cancelled");
  const c2 = await call(env, `/api/decisions/${d.id}/cancel`, {});
  assert.equal(c2.status, 409);
  await hook; // wait ends with 410 and the hook exits too

  // register without hook -> answer -> cancel gives answer_lost
  const created = await call(env, "/api/decisions", {
    tool_use_id: "tu-cancel-api2",
    kind: "answer_question",
    session: {
      session_id: "sess-int",
      cwd: "/nonexistent-ukagai-cwd",
      transcript_path: join(env.home, ".claude", "projects", "p", "sess-int.jsonl"),
      permission_mode: "plan",
    },
    request: askInput,
  });
  const d2 = (await created.json()) as any;
  await call(env, `/api/decisions/${d2.id}/answer`, { answers: { [QUESTION]: "A" } });
  const c3 = await call(env, `/api/decisions/${d2.id}/cancel`, {});
  assert.equal(c3.status, 200);
  assert.equal(((await c3.json()) as any).status, "answer_lost");
});

test("(handoff) budget end hands off with a deny; the second hook run re-attaches to the same decision and gets the answer", async () => {
  const env = await setup();
  const planned = ["--budget", "8", "--poll-timeout-ms", "1000"];
  // plan mode: no explanation file is needed for the first leg
  const first = await runHook([...env.hookArgs, ...planned], stdin(env, tmp(), "AskUserQuestion", askInput, "plan", "tu-h1"));
  assert.equal(first.code, 0);
  const deny = JSON.parse(first.stdout).hookSpecificOutput;
  assert.equal(deny.permissionDecision, "deny");
  assert.match(deny.permissionDecisionReason, /^\[ukagai, not a failure\] The human has not answered yet/);
  const pending = (await (await call(env, "/api/decisions?status=pending")).json()) as any[];
  assert.equal(pending.length, 1);
  const id = pending[0].id;
  assert.equal(pending[0].handoffs, 1);

  // The agent calls the tool again (new tool_use_id, and no explanation anywhere): the same decision is waited for
  const second = runHook([...env.hookArgs, ...planned], stdin(env, tmp(), "AskUserQuestion", askInput, "default", "tu-h2"));
  for (let i = 0; i < 100; i++) {
    const d = (await (await call(env, `/api/decisions/${id}`)).json()) as any;
    if (d.tool_use_id === "tu-h2") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const cur = (await (await call(env, `/api/decisions/${id}`)).json()) as any;
  assert.equal(cur.tool_use_id, "tu-h2");
  assert.deepEqual(cur.previous_tool_use_ids, ["tu-h1"]);
  assert.equal(((await (await call(env, "/api/decisions?status=pending")).json()) as any[]).length, 1);
  assert.equal((await call(env, `/api/decisions/${id}/answer`, { answers: { [QUESTION]: "B" } })).status, 200);
  const out = await second;
  const j = JSON.parse(out.stdout);
  assert.equal(j.hookSpecificOutput.permissionDecision, "allow");
  assert.deepEqual(j.hookSpecificOutput.updatedInput.answers, { [QUESTION]: "B" });
  assert.equal(((await (await call(env, `/api/decisions/${id}`)).json()) as any).status, "answered");
});
