// A plan approved while it waited for message delivery: the re-called ExitPlanMode uses its grant (PreToolUse for a plain approval,
// PermissionRequest for "approve and auto"). A plan the waiting hook took with "approve and auto" leaves its grant to the PermissionRequest.
// Every miss or failure leaves today's flow (PreToolUse) or Claude Code's dialog (PermissionRequest)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PermissionRequestAllowExitPlan, PreToolUseAllow, decisionFingerprint, type Decision } from "../../src/contract.js";
import { start } from "../../src/serve/index.js";
import { dataDirWithToken, fakeServer, json, runHook, type Fake, type Handler } from "./helpers.js";

const fx = (n: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/${n}`, import.meta.url)), "utf8"));
const OWNER = "0123456789abcdef";
const PERM = fx("permission-request-exit-plan-stdin.json");
const SID = PERM.session_id as string;
const TOOL_INPUT = PERM.tool_input as { plan: string; planFilePath: string };
const FP = decisionFingerprint("approve_plan", TOOL_INPUT);
/** The same plan, as the PreToolUse of the re-called ExitPlanMode */
const PRE = { ...fx("t5-stdin.json"), tool_input: TOOL_INPUT, tool_use_id: "toolu_again" };

const PLAN_ASYNC_LINE = "[ukagai, not a failure] Plan sent to the human in ukagai: stay in plan mode and end your turn, the decision arrives as a message (see hook context).";
const PLAN_ASYNC_CONTEXT =
  "[ukagai] The plan is open for the human's review in the ukagai GUI. It is NOT approved. Stay in plan mode and do not implement. End your turn now. The human's decision will arrive later as a message that starts with [ukagai].";

async function withServer<T>(handler: Handler, fn: (f: Fake, dataDir: string) => Promise<T>): Promise<T> {
  const f = await fakeServer(handler);
  try {
    return await fn(f, dataDirWithToken());
  } finally {
    await f.close();
  }
}
const args = (f: Fake, dataDir: string) => ["--server", f.url, "--data-dir", dataDir];
const GRANT_PATH = `/api/sessions/${SID}/plan-grant?fingerprint=${FP}`;
const CONSUME_PATH = `/api/sessions/${SID}/plan-grant/consume`;
const HAND_PATH = `/api/sessions/${SID}/plan-grant/hand`;

/**
 * A server that holds one grant for the plan (mode none / auto) until it is consumed, and records the rest. An auto grant is consumed only
 * once handed (`handed: true` starts it handed, as the waiting hook's ack does); a second hand writes it off
 */
function granting(mode?: "auto", opts: { handed?: boolean } = {}): Handler {
  let used = false;
  let handed = opts.handed === true;
  return (req, res) => {
    if (req.method === "GET" && req.path.startsWith(`/api/sessions/${SID}/plan-grant?`)) {
      return req.path === GRANT_PATH && !used ? json(res, 200, { grant: { decision_id: "dec-plan", ...(mode ? { mode } : {}) } }) : json(res, 404, { error: "no grant" });
    }
    if (req.method === "POST" && req.path === HAND_PATH) {
      if (used || mode !== "auto" || req.body?.fingerprint !== FP) return json(res, 200, { handed: false });
      if (handed) {
        used = true;
        return json(res, 200, { handed: false });
      }
      handed = true;
      return json(res, 200, { handed: true });
    }
    if (req.method === "POST" && req.path === CONSUME_PATH) {
      if (used || req.body?.fingerprint !== FP || (mode === "auto" && !handed)) return json(res, 200, { consumed: false });
      used = true;
      return json(res, 200, { consumed: true, ...(mode ? { mode } : {}) });
    }
    return false;
  };
}

// ---- PreToolUse ----

test("PreToolUse: a plain grant → consumed, allow + updatedInput (the plan as sent); nothing registered, nothing awaited", async () => {
  await withServer(granting(), async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(PRE), undefined, { UKAGAI_MOD_OWNER: OWNER });
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out, { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: TOOL_INPUT } });
    assert.ok(PreToolUseAllow.safeParse(out).success);
    assert.deepEqual(f.calls.find((c) => c.path === CONSUME_PATH)?.body, { fingerprint: FP });
    assert.ok(!f.calls.some((c) => c.path === "/api/decisions" || c.path.includes("/open?") || c.path.includes("/wait")));
  });
});

test("PreToolUse: a grant with auto → handed to the PermissionRequest, no output; that PermissionRequest then answers allow + setMode auto", async () => {
  await withServer(granting("auto"), async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(PRE), undefined, { UKAGAI_MOD_OWNER: OWNER });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.ok(f.calls.some((c) => c.path === GRANT_PATH));
    assert.deepEqual(f.calls.filter((c) => c.path === HAND_PATH).map((c) => c.body), [{ fingerprint: FP }]);
    assert.ok(!f.calls.some((c) => c.path === CONSUME_PATH || c.path === "/api/decisions" || c.path.includes("/open?")));
    assert.deepEqual(JSON.parse((await runHook(args(f, d), JSON.stringify(PERM))).stdout), fx("permission-request-exit-plan-stdout.json"));
  });
});

test("PreToolUse: an auto grant handed before (its PermissionRequest did not use it; the human may have said no in Claude Code's dialog) → written off, the plan goes to the human (registered)", async () => {
  for (const owner of [{ UKAGAI_MOD_OWNER: OWNER }, undefined]) {
    await withServer(granting("auto", { handed: true }), async (f, d) => {
      const r = await runHook([...args(f, d), "--budget", "30"], JSON.stringify(PRE), undefined, owner);
      assert.equal(r.code, 0);
      assert.equal(f.calls.filter((c) => c.path === HAND_PATH).length, 1);
      assert.ok(f.calls.some((c) => c.path.includes("/open?")));
      assert.equal(f.calls.find((c) => c.method === "POST" && c.path === "/api/decisions")?.body.kind, "approve_plan", "a new card for the human");
      assert.equal((await runHook(args(f, d), JSON.stringify(PERM))).stdout, "", "the written-off grant lets nothing through");
    });
  }
});

test("PreToolUse: a hand that fails (server gone in between) → today's flow, never an output that skips the human", async () => {
  const h: Handler = (req, res) =>
    req.path === GRANT_PATH ? json(res, 200, { grant: { decision_id: "dec-plan", mode: "auto" } }) : req.path === HAND_PATH ? json(res, 500, { error: "boom" }) : false;
  await withServer(h, async (f, d) => {
    await runHook([...args(f, d), "--budget", "30"], JSON.stringify(PRE), undefined, { UKAGAI_MOD_OWNER: OWNER });
    assert.ok(f.calls.some((c) => c.method === "POST" && c.path === "/api/decisions"));
  });
});

test("PreToolUse: no grant, or a consume that misses → today's flow (look for the open decision, then register)", async () => {
  for (const h of [() => false, ((req, res) => (req.path === GRANT_PATH ? json(res, 200, { grant: { decision_id: "x" } }) : req.path === CONSUME_PATH ? json(res, 200, { consumed: false }) : false)) as Handler]) {
    await withServer(h, async (f, d) => {
      await runHook([...args(f, d), "--budget", "30"], JSON.stringify(PRE), undefined, { UKAGAI_MOD_OWNER: OWNER });
      assert.ok(f.calls.some((c) => c.path.includes("/open?")));
      const create = f.calls.find((c) => c.method === "POST" && c.path === "/api/decisions");
      assert.equal(create?.body.kind, "approve_plan");
      assert.equal(create?.body.mod_owner, OWNER, "a plan asks for message delivery too");
    });
  }
});

test("PreToolUse: a subagent's ExitPlanMode never looks for a grant", async () => {
  await withServer(granting(), async (f, d) => {
    await runHook([...args(f, d), "--budget", "30"], JSON.stringify({ ...PRE, agent_id: "sub-1", agent_type: "Plan" }), undefined, { UKAGAI_MOD_OWNER: OWNER });
    assert.ok(!f.calls.some((c) => c.path.includes("/plan-grant")));
  });
});

test("PreToolUse: with a mod, an ExitPlanMode outside plan mode is not ukagai's (no output, nothing looked up or registered); without one it is handled as today (R4)", async () => {
  for (const mode of ["default", "acceptEdits", "auto", undefined]) {
    await withServer(granting(), async (f, d) => {
      const input = { ...PRE, permission_mode: mode };
      const r = await runHook(args(f, d), JSON.stringify(input), undefined, { UKAGAI_MOD_OWNER: OWNER });
      assert.equal(r.stdout, "", String(mode));
      assert.deepEqual(f.calls, [], String(mode));
    });
  }
  await withServer(() => false, async (f, d) => {
    await runHook([...args(f, d), "--budget", "30"], JSON.stringify({ ...PRE, permission_mode: "default" }));
    assert.ok(f.calls.some((c) => c.method === "POST" && c.path === "/api/decisions"), "no mod: registered as before");
  });
});

test("PreToolUse: a plan registered for message delivery is denied with the plan wording at once, and a re-call while it is delivered is too", async () => {
  const registered: Handler = (req, res) => (req.method === "POST" && req.path === "/api/decisions" ? json(res, 201, { id: "dec-plan", status: "pending", delivery: "message" }) : false);
  await withServer(registered, async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(PRE), undefined, { UKAGAI_MOD_OWNER: OWNER });
    assert.deepEqual(JSON.parse(r.stdout), {
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: PLAN_ASYNC_LINE, additionalContext: PLAN_ASYNC_CONTEXT },
    });
    assert.ok(PLAN_ASYNC_LINE.length <= 160);
    assert.ok(!f.calls.some((c) => c.path.includes("/wait")));
  });
  const delivering: Handler = (req, res) => (req.path.includes("/open?") ? json(res, 200, { delivering: { decision_id: "dec-plan" } }) : false);
  await withServer(delivering, async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(PRE), undefined, { UKAGAI_MOD_OWNER: OWNER });
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, PLAN_ASYNC_LINE);
    assert.ok(!f.calls.some((c) => c.method === "POST" && c.path === "/api/decisions"));
  });
});

test("PreToolUse: server absent → no output, exit 0 (fail open)", async () => {
  const f = await fakeServer();
  const port = f.port;
  await f.close();
  const r = await runHook(["--server", `http://127.0.0.1:${port}`, "--data-dir", dataDirWithToken()], JSON.stringify(PRE), undefined, { UKAGAI_MOD_OWNER: OWNER });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
});

// ---- PermissionRequest ----

test("PermissionRequest × ExitPlanMode × an auto grant handed to it → allow + updatedInput + setMode auto (fixture), consumed once", async () => {
  await withServer(granting("auto", { handed: true }), async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(PERM));
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out, fx("permission-request-exit-plan-stdout.json"));
    assert.ok(PermissionRequestAllowExitPlan.safeParse(out).success);
    assert.deepEqual(f.calls.filter((c) => c.path === CONSUME_PATH).map((c) => c.body), [{ fingerprint: FP }]);
    // used: a second prompt is Claude Code's
    assert.equal((await runHook(args(f, d), JSON.stringify(PERM))).stdout, "");
  });
});

test("PermissionRequest × ExitPlanMode: explanation blocks in the plan do not change which grant it is", async () => {
  const withBlock = { ...PERM, tool_input: { ...TOOL_INPUT, plan: `${TOOL_INPUT.plan}\n<!-- ukagai-explain -->\n---\nquestion: q\n---\nbody\n<!-- /ukagai-explain -->\n` } };
  await withServer(granting("auto", { handed: true }), async (f, d) => {
    const out = JSON.parse((await runHook(args(f, d), JSON.stringify(withBlock))).stdout);
    assert.equal(out.hookSpecificOutput.decision.behavior, "allow");
    assert.deepEqual(out.hookSpecificOutput.decision.updatedInput, withBlock.tool_input, "the plan goes back as Claude Code sent it");
  });
});

test("PermissionRequest × ExitPlanMode: no grant, a plain grant, a subagent or an empty plan → no output, nothing used", async () => {
  const cases: [Handler, Record<string, unknown>][] = [
    [granting(), { tool_input: { ...TOOL_INPUT, plan: "changed" } }],
    [granting(), {}],
    [granting("auto", { handed: true }), { agent_id: "sub-1" }],
    [granting("auto"), { tool_input: { plan: "  ", planFilePath: TOOL_INPUT.planFilePath } }],
  ];
  for (const [h, extra] of cases) {
    await withServer(h, async (f, d) => {
      const r = await runHook(args(f, d), JSON.stringify({ ...PERM, ...extra }));
      assert.equal(r.stdout, "", JSON.stringify(extra));
      assert.ok(!f.calls.some((c) => c.path === CONSUME_PATH), JSON.stringify(extra));
    });
  }
});

test("PermissionRequest × ExitPlanMode × an auto grant nobody handed to it (no PreToolUse of this call left it) → no output: the consume is refused", async () => {
  await withServer(granting("auto"), async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(PERM));
    assert.equal(r.stdout, "");
    assert.equal(f.calls.filter((c) => c.path === CONSUME_PATH).length, 1);
  });
});

test("PermissionRequest × ExitPlanMode: server absent → no output (Claude Code's dialog), exit 0", async () => {
  const f = await fakeServer();
  const port = f.port;
  await f.close();
  const r = await runHook(["--server", `http://127.0.0.1:${port}`, "--data-dir", dataDirWithToken()], JSON.stringify(PERM));
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
});

test("PermissionRequest of another tool → no output and no request, even with an auto grant for the session", async () => {
  await withServer(granting("auto"), async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify({ session_id: SID, transcript_path: "/t", cwd: "/c", hook_event_name: "PermissionRequest", tool_name: "Edit", permission_mode: "plan" }));
    assert.equal(r.stdout, "");
    assert.deepEqual(f.calls, []);
  });
});

// ---- audit R2b fixes ----

test("M1: PermissionRequest × ExitPlanMode outside plan mode → no output and no request, even with an auto grant (Claude Code's dialog asks the human)", async () => {
  for (const mode of ["default", "acceptEdits", "bypassPermissions", "auto", undefined]) {
    await withServer(granting("auto"), async (f, d) => {
      const r = await runHook(args(f, d), JSON.stringify({ ...PERM, permission_mode: mode }), undefined, { UKAGAI_MOD_OWNER: OWNER });
      assert.equal(r.code, 0);
      assert.equal(r.stdout, "", String(mode));
      assert.deepEqual(f.calls, [], String(mode));
    });
  }
});

test("M3: with a mod, a subagent's ExitPlanMode outside plan mode is handled as before (registered), never looked up for a grant", async () => {
  const sub = { ...PRE, permission_mode: "default", agent_id: "sub-1", agent_type: "general-purpose" };
  await withServer(() => false, async (f, d) => {
    await runHook([...args(f, d), "--budget", "30"], JSON.stringify(sub), undefined, { UKAGAI_MOD_OWNER: OWNER });
    const create = f.calls.find((c) => c.method === "POST" && c.path === "/api/decisions");
    assert.equal(create?.body.kind, "approve_plan");
    assert.equal(create?.body.mod_owner, undefined, "a subagent never asks for message delivery");
    assert.ok(!f.calls.some((c) => c.path.includes("/plan-grant")));
  });
});

// ---- the waiting hook (classic) with the real server: "approve and auto" goes through the PermissionRequest of the same ExitPlanMode ----

async function realServer() {
  const home = mkdtempSync(join(tmpdir(), "ukagai-pg-home-"));
  const dataDir = mkdtempSync(join(tmpdir(), "ukagai-pg-data-"));
  const tdir = join(home, ".claude", "projects", "p");
  mkdirSync(tdir, { recursive: true });
  const transcript_path = join(tdir, `${SID}.jsonl`);
  writeFileSync(transcript_path, "");
  const h = await start({ port: 0, dataDir, home });
  const url = `http://127.0.0.1:${h.port}`;
  const api = (path: string, body?: unknown) =>
    fetch(url + path, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${h.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const hargs = ["--server", url, "--data-dir", dataDir, "--poll-timeout-ms", "500"];
  const session = { session_id: SID, transcript_path, cwd: home };
  /** The PreToolUse hook waits; the human answers in the GUI; the hook's result */
  const answerWaiting = async (answer: object, toolUseId = PRE.tool_use_id as string) => {
    const hook = runHook(hargs, JSON.stringify({ ...PRE, ...session, tool_use_id: toolUseId }));
    let id: string | undefined;
    for (let i = 0; i < 100 && !id; i++) {
      const list = (await (await api("/api/decisions?status=pending")).json()) as Decision[];
      id = list.find((d) => d.session.session_id === SID && d.kind === "approve_plan" && d.tool_use_id === toolUseId)?.id;
      if (!id) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(id, "the plan was registered for the waiting hook");
    assert.equal((await api(`/api/decisions/${id}/answer`, answer)).status, 200);
    return { id, result: await hook };
  };
  const decision = async (id: string) => (await (await api(`/api/decisions/${id}`)).json()) as Decision;
  const permission = () => runHook(hargs, JSON.stringify({ ...PERM, ...session }));
  const cleanup = async () => {
    await h.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  };
  return { h, api, hargs, session, answerWaiting, decision, permission, cleanup };
}

test("classic, real server: approve and auto → the PreToolUse hook prints nothing; the PermissionRequest answers allow + updatedInput + setMode auto, once", async () => {
  const s = await realServer();
  try {
    const { id, result } = await s.answerWaiting({ approve: true, set_mode_auto: true });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    const taken = await s.decision(id);
    assert.equal(taken.status, "answered");
    assert.equal(taken.grant_used_at, undefined, "left to the PermissionRequest");
    const out = JSON.parse((await s.permission()).stdout);
    assert.deepEqual(out, fx("permission-request-exit-plan-stdout.json"));
    assert.ok(PermissionRequestAllowExitPlan.safeParse(out).success);
    const used = await s.decision(id);
    assert.ok(used.grant_used_at);
    assert.equal(used.delivery_flag, undefined);
    assert.equal((await s.permission()).stdout, "", "used: a second prompt is Claude Code's");
  } finally {
    await s.cleanup();
  }
});

test("classic, real server: a plain approval → the PreToolUse hook allows; the grant is used up, so the PermissionRequest answers nothing", async () => {
  const s = await realServer();
  try {
    const { id, result } = await s.answerWaiting({ approve: true });
    assert.deepEqual(JSON.parse(result.stdout), { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: TOOL_INPUT } });
    assert.ok((await s.decision(id)).grant_used_at);
    assert.equal((await s.permission()).stdout, "");
  } finally {
    await s.cleanup();
  }
});

test("classic, real server: approve and auto, then the server is gone → the PermissionRequest prints nothing, exit 0 (Claude Code's dialog asks)", async () => {
  const s = await realServer();
  try {
    const { result } = await s.answerWaiting({ approve: true, set_mode_auto: true });
    assert.equal(result.stdout, "");
    await s.h.close();
    const r = await s.permission();
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  } finally {
    await s.cleanup();
  }
});

test("classic, real server: a re-call after the PermissionRequest missed the handed grant (Claude Code's dialog asked) → not let through: a new card for the human", async () => {
  const s = await realServer();
  try {
    const { id, result } = await s.answerWaiting({ approve: true, set_mode_auto: true });
    assert.equal(result.stdout, "");
    // The PermissionRequest never reached the server; the human answered Claude Code's own dialog. The agent calls the same plan again
    const again = await s.answerWaiting({ approve: false, reason: "not this one" }, "toolu_recall");
    assert.notEqual(again.id, id, "registered anew");
    assert.equal(JSON.parse(again.result.stdout).hookSpecificOutput.permissionDecision, "deny");
    assert.ok((await s.decision(id)).grant_used_at, "the first grant is written off");
    assert.equal((await s.permission()).stdout, "");
  } finally {
    await s.cleanup();
  }
});

test("message delivery, real server: approve and auto → the re-called ExitPlanMode's PreToolUse hands the grant and prints nothing; its PermissionRequest answers allow + setMode auto", async () => {
  const s = await realServer();
  try {
    assert.equal((await s.api(`/api/sessions/${SID}/inbox/poll`, { owner: OWNER, idle: false })).status, 204);
    const created = (await (await s.api("/api/decisions", {
      tool_use_id: "toolu_async", kind: "approve_plan", session: { ...s.session, permission_mode: "plan" }, request: TOOL_INPUT, mod_owner: OWNER,
    })).json()) as Decision;
    assert.equal(created.delivery, "message");
    assert.equal((await s.api(`/api/decisions/${created.id}/answer`, { approve: true, set_mode_auto: true })).status, 200);
    const pre = await runHook(s.hargs, JSON.stringify({ ...PRE, ...s.session }), undefined, { UKAGAI_MOD_OWNER: OWNER });
    assert.equal(pre.code, 0);
    assert.equal(pre.stdout, "");
    assert.ok((await s.decision(created.id)).grant_handed_at);
    assert.deepEqual(JSON.parse((await s.permission()).stdout), fx("permission-request-exit-plan-stdout.json"));
    const used = await s.decision(created.id);
    assert.ok(used.grant_used_at);
    assert.equal(used.response?.delivered_via, "grant");
  } finally {
    await s.cleanup();
  }
});
