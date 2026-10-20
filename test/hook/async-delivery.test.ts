// A question registered for message delivery: the hook does not wait. It denies at once and the answer comes later as a `[ukagai]` message
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDirWithToken, fakeServer, json, runHook, tmpDir, writeFile, type Fake, type Handler } from "./helpers.js";

const fx = (n: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/${n}`, import.meta.url)), "utf8"));
const Q = "Which do you choose, A or B?";
const OWNER = "0123456789abcdef";

const explanation = `---
ukagai: 1
question: ${Q}
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

const ASYNC_REASON =
  "[ukagai] Your question is open in the ukagai GUI and is not answered yet. End your turn now: do not run other tools, do not call AskUserQuestion again and do not ask in prose. The human's answer will arrive later as a message that starts with [ukagai].";

function t1(scratchpad: string, extra: Record<string, unknown> = {}) {
  return { ...fx("t1-stdin.json"), scratchpad_dir: scratchpad, ...extra };
}
async function withServer<T>(handler: Handler, fn: (f: Fake, dataDir: string) => Promise<T>): Promise<T> {
  const f = await fakeServer(handler);
  try {
    return await fn(f, dataDirWithToken());
  } finally {
    await f.close();
  }
}
const args = (f: Fake, dataDir: string) => ["--server", f.url, "--data-dir", dataDir];
const asyncRegistered: Handler = (req, res) => (req.method === "POST" && req.path === "/api/decisions" ? json(res, 201, { id: "dec-async", status: "pending", delivery: "message" }) : false);

test("registered for message delivery: sends mod_owner, denies at once, never waits, acks or hands off", async () => {
  const sp = tmpDir();
  writeFile(join(sp, "ukagai", "e.md"), explanation);
  await withServer(asyncRegistered, async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(t1(sp)), undefined, { UKAGAI_MOD_OWNER: OWNER });
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.stdout), {
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: ASYNC_REASON },
    });
    const create = f.calls.find((c) => c.method === "POST" && c.path === "/api/decisions");
    assert.equal(create?.body.mod_owner, OWNER);
    assert.equal(create?.body.explanation.attached_via, "first_call");
    assert.ok(!f.calls.some((c) => c.path.includes("/wait") || c.path.endsWith("/ack") || c.path.endsWith("/handoff")));
    assert.match(readFileSync(join(d, "hook.log"), "utf8"), /"event":"async_registered"[^\n]*"decision_id":"dec-async"/);
  });
});

test("mod_owner is sent only when it is 16 lowercase hex characters, and not for a subagent", async () => {
  for (const [env, extra, expected] of [
    [{ UKAGAI_MOD_OWNER: "NOT-A-VALID-OWNER" }, {}, undefined],
    [{ UKAGAI_MOD_OWNER: OWNER.toUpperCase() }, {}, undefined],
    [{}, {}, undefined],
    [{ UKAGAI_MOD_OWNER: OWNER }, { agent_id: "sub-1", agent_type: "general-purpose" }, undefined],
    [{ UKAGAI_MOD_OWNER: OWNER }, {}, OWNER],
  ] as const) {
    const sp = tmpDir();
    writeFile(join(sp, "ukagai", "e.md"), explanation);
    await withServer(() => false, async (f, d) => {
      await runHook([...args(f, d), "--budget", "30"], JSON.stringify(t1(sp, extra)), undefined, env);
      const create = f.calls.find((c) => c.method === "POST" && c.path === "/api/decisions");
      assert.equal(create?.body.mod_owner, expected, JSON.stringify([env, extra]));
    });
  }
});

test("the server answers with an ordinary decision (no `delivery`): the hook waits as before", async () => {
  const sp = tmpDir();
  writeFile(join(sp, "ukagai", "e.md"), explanation);
  const h: Handler = (req, res) => (req.method === "GET" && req.path.includes("/wait") ? json(res, 200, { response: { via: "gui", answers: { [Q]: "B" }, decided_at: new Date().toISOString() } }) : false);
  await withServer(h, async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(t1(sp)), undefined, { UKAGAI_MOD_OWNER: OWNER });
    assert.deepEqual(JSON.parse(r.stdout), fx("t1-stdout.json"));
    assert.ok(f.calls.some((c) => c.path.includes("/wait")));
  });
});

test("the question is called again while a mod delivers its answer: deny, nothing registered, nothing awaited", async () => {
  const sp = tmpDir(); // no explanation file: the open decision needs none
  const h: Handler = (req, res) => (req.method === "GET" && req.path.startsWith("/api/sessions/") && req.path.includes("/open?") ? json(res, 200, { delivering: { decision_id: "dec-async" } }) : false);
  await withServer(h, async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(t1(sp, { tool_use_id: "toolu_again" })), undefined, { UKAGAI_MOD_OWNER: OWNER });
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, ASYNC_REASON);
    assert.ok(!f.calls.some((c) => c.method === "POST" && c.path === "/api/decisions"));
    assert.ok(!f.calls.some((c) => c.path.includes("/wait")));
  });
});

test("UserPromptSubmit: a prompt that starts with a delivery ref sends only the ref; any other prompt sends none, and never the text", async () => {
  const prompt = (text: string) => JSON.stringify({ session_id: "s-1", transcript_path: "/t.jsonl", hook_event_name: "UserPromptSubmit", cwd: "/w", prompt: text });
  await withServer(() => false, async (f, d) => {
    await runHook(args(f, d), prompt("[ukagai] (ref a1b2c3d4) The human answered your question in the ukagai GUI:\n- \"q\": \"x\""));
    await runHook(args(f, d), prompt("Please [ukagai] (ref a1b2c3d4) fix the bug"));
    await runHook(args(f, d), prompt("[ukagai] (ref A1B2C3D4) not a ref"));
    await runHook(args(f, d), prompt("just a prompt"));
    const events = f.calls.filter((c) => c.path === "/api/events").map((c) => c.body);
    assert.equal(events.length, 4);
    assert.deepEqual(events.map((e) => e.delivered_ref), ["a1b2c3d4", undefined, undefined, undefined]);
    assert.ok(events.every((e) => e.prompt === undefined));
  });
});
