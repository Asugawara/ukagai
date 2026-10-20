// A plan approved while it waited for message delivery: the re-called ExitPlanMode uses its grant (PreToolUse for a plain approval,
// PermissionRequest for "approve and auto"). Every miss or failure leaves today's flow (PreToolUse) or Claude Code's dialog (PermissionRequest)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PermissionRequestAllowExitPlan, PreToolUseAllow, decisionFingerprint } from "../../src/contract.js";
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

/** A server that holds one grant for the plan (mode none / auto) until it is consumed, and records the rest */
function granting(mode?: "auto", opts: { pendingModeSwitch?: boolean } = {}): Handler {
  let used = false;
  return (req, res) => {
    if (req.method === "GET" && req.path.startsWith(`/api/sessions/${SID}/plan-grant?`)) {
      return req.path === GRANT_PATH && !used ? json(res, 200, { grant: { decision_id: "dec-plan", ...(mode ? { mode } : {}) } }) : json(res, 404, { error: "no grant" });
    }
    if (req.method === "POST" && req.path === CONSUME_PATH) {
      if (used || req.body?.fingerprint !== FP) return json(res, 200, { consumed: false });
      used = true;
      return json(res, 200, { consumed: true, ...(mode ? { mode } : {}) });
    }
    if (req.method === "GET" && req.path.endsWith("/pending-mode-switch")) return json(res, 200, { pending: opts.pendingModeSwitch === true });
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

test("PreToolUse: a grant with auto → no output and the grant is left for the PermissionRequest", async () => {
  await withServer(granting("auto"), async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(PRE), undefined, { UKAGAI_MOD_OWNER: OWNER });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.ok(f.calls.some((c) => c.path === GRANT_PATH));
    assert.ok(!f.calls.some((c) => c.path === CONSUME_PATH || c.path === "/api/decisions" || c.path.includes("/open?")));
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

test("PermissionRequest × ExitPlanMode × an auto grant → allow + updatedInput + setMode auto (fixture), consumed once", async () => {
  await withServer(granting("auto"), async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify(PERM));
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out, fx("permission-request-exit-plan-stdout.json"));
    assert.ok(PermissionRequestAllowExitPlan.safeParse(out).success);
    assert.deepEqual(f.calls.filter((c) => c.path === CONSUME_PATH).map((c) => c.body), [{ fingerprint: FP }]);
    assert.ok(!f.calls.some((c) => c.path.includes("pending-mode-switch")));
    // used: a second prompt is Claude Code's
    assert.equal((await runHook(args(f, d), JSON.stringify(PERM))).stdout, "");
  });
});

test("PermissionRequest × ExitPlanMode: explanation blocks in the plan do not change which grant it is", async () => {
  const withBlock = { ...PERM, tool_input: { ...TOOL_INPUT, plan: `${TOOL_INPUT.plan}\n<!-- ukagai-explain -->\n---\nquestion: q\n---\nbody\n<!-- /ukagai-explain -->\n` } };
  await withServer(granting("auto"), async (f, d) => {
    const out = JSON.parse((await runHook(args(f, d), JSON.stringify(withBlock))).stdout);
    assert.equal(out.hookSpecificOutput.decision.behavior, "allow");
    assert.deepEqual(out.hookSpecificOutput.decision.updatedInput, withBlock.tool_input, "the plan goes back as Claude Code sent it");
  });
});

test("PermissionRequest × ExitPlanMode: no grant, a plain grant, a subagent or an empty plan → no output; the pending mode switch is neither asked nor used", async () => {
  const cases: [Handler, Record<string, unknown>][] = [
    [granting(undefined, { pendingModeSwitch: true }), { tool_input: { ...TOOL_INPUT, plan: "changed" } }],
    [granting(undefined, { pendingModeSwitch: true }), {}],
    [granting("auto", { pendingModeSwitch: true }), { agent_id: "sub-1" }],
    [granting("auto", { pendingModeSwitch: true }), { tool_input: { plan: "  ", planFilePath: TOOL_INPUT.planFilePath } }],
  ];
  for (const [h, extra] of cases) {
    await withServer(h, async (f, d) => {
      const r = await runHook(args(f, d), JSON.stringify({ ...PERM, ...extra }));
      assert.equal(r.stdout, "", JSON.stringify(extra));
      assert.ok(!f.calls.some((c) => c.path === CONSUME_PATH || c.path.includes("pending-mode-switch")), JSON.stringify(extra));
    });
  }
});

test("PermissionRequest × ExitPlanMode: server absent → no output (Claude Code's dialog), exit 0", async () => {
  const f = await fakeServer();
  const port = f.port;
  await f.close();
  const r = await runHook(["--server", `http://127.0.0.1:${port}`, "--data-dir", dataDirWithToken()], JSON.stringify(PERM));
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
});

test("PermissionRequest of another tool still uses the pending mode switch, never a plan grant", async () => {
  await withServer(granting("auto", { pendingModeSwitch: true }), async (f, d) => {
    const r = await runHook(args(f, d), JSON.stringify({ session_id: SID, transcript_path: "/t", cwd: "/c", hook_event_name: "PermissionRequest", tool_name: "Edit" }));
    assert.deepEqual(JSON.parse(r.stdout).hookSpecificOutput.decision, { behavior: "allow", updatedPermissions: [{ type: "setMode", mode: "auto", destination: "session" }] });
    assert.ok(!f.calls.some((c) => c.path.includes("/plan-grant")));
  });
});
