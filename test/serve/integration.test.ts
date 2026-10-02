import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start, type ServeHandle } from "../../src/serve/index.js";
import { runHook } from "../hook/helpers.js";

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

const QUESTION = "A と B のどちらにしますか？";
const askInput = {
  questions: [{ question: QUESTION, header: "選択", options: [{ label: "A" }, { label: "B" }], multiSelect: false }],
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

test("(a) plan mode の AskUserQuestion は説明なしで登録され none / plan_mode", async () => {
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

test("(b) ExitPlanMode(影響範囲と可逆性の節あり)は登録され、GUI の承認で allow", async () => {
  const env = await setup();
  const plan = "# 計画\n\n## 手順\n\n1. 直す。\n\n## 影響範囲と可逆性\n\n1 ファイルだけ。git revert で戻せる。\n";
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

test("(c) 2 分以内の denied_explain があり説明ファイルが無いと none / loop_guard で登録", async () => {
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
