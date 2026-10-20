// A plan approved while it waited for message delivery: its grant lets the same plan's re-called ExitPlanMode through once.
// One the waiting hook took with "approve and auto": its grant lets the PermissionRequest of the same ExitPlanMode switch to auto
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MOD_CLAIM_STALE_MS, MOD_END_GRACE_MS, MOD_FRESH_MS, PLAN_GRANT_HAND_WINDOW_MS, PLAN_GRANT_RECALL_MS, PLAN_GRANT_TTL_MS, decisionFingerprint, type CreateDecisionRequest, type Decision } from "../../src/contract.js";
import { start, type ServeHandle } from "../../src/serve/index.js";
import { Store } from "../../src/serve/store.js";

const roots: string[] = [];
const stores: Store[] = [];
const handles: ServeHandle[] = [];
after(async () => {
  for (const s of stores) s.close();
  for (const h of handles) await h.close();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

const A = "a".repeat(16);
const SID = "sess-plan";
const PLAN = "# Plan: add the cache\n\n## Scope and reversibility\nReversibility: reversible\nScope: repo\n";
const FP = decisionFingerprint("approve_plan", { plan: PLAN, planFilePath: "/p/plan.md" });

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "ukagai-plan-grant-"));
  roots.push(d);
  return d;
}

function setup(opts: { dir?: string; start?: number } = {}) {
  const dir = opts.dir ?? tmp();
  const transcript = join(dir, "t.jsonl");
  if (!opts.dir) writeFileSync(transcript, "");
  let t = opts.start ?? Date.parse("2026-01-01T00:00:00.000Z");
  const store = new Store({ dir, leaseGraceMs: 60_000, now: () => t, broadcast: () => {} });
  store.load();
  stores.push(store);
  const h = {
    dir,
    store,
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    poll(owner = A, idle = false, session = SID) {
      return store.inboxPoll(session, owner, idle);
    },
    req(toolUseId: string, plan = PLAN, extra: Partial<CreateDecisionRequest> = {}): CreateDecisionRequest {
      return {
        tool_use_id: toolUseId,
        kind: "approve_plan",
        session: { session_id: SID, cwd: "/w/proj", transcript_path: transcript, permission_mode: "plan" },
        request: { plan, planFilePath: "/p/plan.md" },
        mod_owner: A,
        ...extra,
      };
    },
    /** A plan registered for message delivery (its owner polled just before) */
    plan(toolUseId = "toolu_p", plan = PLAN, extra: Partial<CreateDecisionRequest> = {}): Decision {
      store.inboxPoll(SID, A, false);
      return store.create(h.req(toolUseId, plan, extra), {}).decision;
    },
    approve(d: Decision, auto = false): void {
      store.submitAnswer(d.id, { kind: "approve", ...(auto ? { set_mode_auto: true } : {}) });
    },
    event(name: string, extra: Record<string, unknown> = {}, session = SID): void {
      store.addEvent({ session_id: session, transcript_path: transcript, cwd: "/w/proj", hook_event_name: name, received_at: new Date(t + 1).toISOString(), ...extra } as never);
    },
  };
  return h;
}
type H = ReturnType<typeof setup>;
const get = (h: H, d: Decision): Decision => h.store.get(d.id)!;

// ---- registration ----

test("a plan is registered for message delivery like a question; an empty plan is not (its fingerprint would be the file path)", () => {
  const h = setup();
  const d = h.plan();
  assert.equal(d.delivery, "message");
  assert.equal(d.lease_until, undefined);
  assert.deepEqual(h.store.waitingFor(SID), { decision_id: d.id, kind: "approve_plan" }, "the agent's tools are held back while it waits");
  const empty = h.plan("toolu_empty", " \n\t");
  assert.equal(empty.delivery, undefined);
  assert.equal(h.store.planGrant(SID, empty.fingerprint!), undefined);
});

// ---- derivation ----

test("an approval derives a grant (no mode / auto); a rejection, an instruction or a classic approval its hook has not taken derive none", () => {
  const h = setup();
  const plain = h.plan("toolu_plain");
  assert.equal(h.store.planGrant(SID, FP), undefined, "not answered yet");
  h.approve(plain);
  assert.deepEqual(h.store.planGrant(SID, FP), { decision_id: plain.id });

  const auto = setup();
  const a = auto.plan("toolu_auto");
  auto.approve(a, true);
  assert.deepEqual(auto.store.planGrant(SID, FP), { decision_id: a.id, mode: "auto" });

  const other = setup();
  const rejected = other.plan("toolu_r");
  other.store.submitAnswer(rejected.id, { kind: "reject", reason: "too broad" });
  assert.equal(other.store.planGrant(SID, FP), undefined);
  const instructed = other.plan("toolu_i", PLAN + "\nmore\n");
  other.store.submitAnswer(instructed.id, { kind: "instruct_plan", text: "check the tests first" });
  assert.equal(other.store.planGrant(SID, instructed.fingerprint!), undefined);

  const classic = setup();
  const c = classic.store.create(classic.req("toolu_c", PLAN, { mod_owner: undefined }), {}).decision;
  assert.equal(c.delivery, undefined);
  classic.approve(c, true);
  assert.equal(classic.store.planGrant(SID, FP), undefined, "a classic approval goes back through the waiting hook first");
});

test("only the same session and the same plan can use the grant, only once, and only a re-call soon after the approval (PLAN_GRANT_RECALL_MS)", () => {
  const h = setup();
  const d = h.plan();
  h.approve(d);
  const otherFp = decisionFingerprint("approve_plan", { plan: PLAN + "\nchanged\n", planFilePath: "/p/plan.md" });
  assert.deepEqual(h.store.consumePlanGrant(SID, otherFp), { consumed: false }, "another plan");
  assert.deepEqual(h.store.consumePlanGrant("another-session", FP), { consumed: false }, "another session");
  assert.equal(get(h, d).grant_used_at, undefined);
  assert.deepEqual(h.store.consumePlanGrant(SID, FP), { consumed: true });
  assert.deepEqual(h.store.consumePlanGrant(SID, FP), { consumed: false }, "once");
  assert.equal(h.store.planGrant(SID, FP), undefined);

  const late = setup();
  const l = late.plan();
  late.approve(l);
  late.advance(PLAN_GRANT_RECALL_MS);
  assert.ok(late.store.planGrant(SID, FP), "undelivered: still within the deadline after the human decided");
  late.advance(1);
  assert.equal(late.store.planGrant(SID, FP), undefined);
  assert.deepEqual(late.store.consumePlanGrant(SID, FP), { consumed: false });
  assert.ok(PLAN_GRANT_RECALL_MS < PLAN_GRANT_TTL_MS, "12 hours stays the outer bound");
});

// ---- using it ----

test("using the grant answers the decision (delivered_via grant) and ends the mod's claim; the mod's late ack or release changes nothing (R4)", () => {
  const h = setup();
  const d = h.plan();
  h.approve(d, true);
  const item = h.poll(A, true);
  assert.ok(item && "item" in item, "the mod holds the approval");
  assert.match(item.item.text, /The human approved your plan in the ukagai GUI\. Call ExitPlanMode once more with the same plan/);
  assert.deepEqual(h.store.handPlanGrant(SID, FP), { handed: true });
  assert.deepEqual(h.store.consumePlanGrant(SID, FP), { consumed: true, mode: "auto" });
  const done = get(h, d);
  assert.equal(done.status, "answered");
  assert.equal(done.response?.delivered_via, "grant");
  assert.ok(done.response?.delivered_at);
  assert.ok(done.grant_used_at);
  assert.equal(done.claim, undefined);
  assert.deepEqual(h.store.inboxAck(SID, A, d.id), { http: 200, status: "answered" });
  assert.deepEqual(h.store.inboxRelease(SID, A, d.id, "dropped"), { http: 200, status: "answered" });
  assert.equal(get(h, d).response?.delivered_via, "grant");
  assert.equal(h.store.waitingFor(SID), undefined);
});

test("a grant whose approval was already delivered as a message is still used once; the delivery stays the message's", () => {
  const h = setup();
  const d = h.plan();
  h.approve(d);
  h.poll(A, true);
  h.store.inboxAck(SID, A, d.id);
  assert.equal(get(h, d).response?.delivered_via, "message");
  assert.deepEqual(h.store.planGrant(SID, FP), { decision_id: d.id });
  assert.deepEqual(h.store.consumePlanGrant(SID, FP), { consumed: true });
  assert.equal(get(h, d).response?.delivered_via, "message");
  assert.ok(get(h, d).grant_used_at);
});

test("the grant comes back from the decision record after a restart, and a used one does not (m5)", () => {
  const h = setup();
  const d = h.plan();
  h.approve(d, true);
  h.store.close();
  const again = setup({ dir: h.dir, start: h.now() + 60_000 });
  assert.deepEqual(again.store.planGrant(SID, FP), { decision_id: d.id, mode: "auto" });
  assert.deepEqual(again.store.handPlanGrant(SID, FP), { handed: true });
  assert.deepEqual(again.store.consumePlanGrant(SID, FP), { consumed: true, mode: "auto" });
  again.store.close();
  const third = setup({ dir: h.dir, start: h.now() + 120_000 });
  assert.equal(third.store.planGrant(SID, FP), undefined);
  assert.equal(third.store.get(d.id)?.status, "answered");
});

// ---- PostToolUse (m4) ----

test("PostToolUse of the main agent's ExitPlanMode uses up the session's grant; an auto one is flagged auto_not_applied (m4)", () => {
  const h = setup();
  const d = h.plan();
  h.approve(d, true);
  h.event("PostToolUse", { tool_name: "ExitPlanMode", agent_id: "sub-1" });
  h.event("PostToolUse", { tool_name: "Edit" });
  h.event("PostToolUse", { tool_name: "ExitPlanMode" }, "another-session");
  assert.ok(h.store.planGrant(SID, FP), "a subagent, another tool or another session leave it");
  h.event("PostToolUse", { tool_name: "ExitPlanMode" });
  const done = get(h, d);
  assert.equal(h.store.planGrant(SID, FP), undefined);
  assert.equal(done.status, "answered");
  assert.equal(done.response?.delivered_via, "grant");
  assert.equal(done.delivery_flag, "auto_not_applied");

  const plain = setup();
  const p = plain.plan();
  plain.approve(p);
  plain.event("PostToolUse", { tool_name: "ExitPlanMode" });
  assert.equal(get(plain, p).delivery_flag, undefined, "no auto was asked for");
  assert.ok(get(plain, p).grant_used_at);

  const used = setup();
  const u = used.plan();
  used.approve(u, true);
  used.store.handPlanGrant(SID, FP);
  used.store.consumePlanGrant(SID, FP);
  used.event("PostToolUse", { tool_name: "ExitPlanMode" });
  assert.equal(get(used, u).delivery_flag, undefined, "the PermissionRequest switched the mode");
});

// ---- closing ----

test("SessionEnd: after the grace, the session's grants are gone, delivered or not", () => {
  const h = setup();
  const delivered = h.plan("toolu_1");
  h.approve(delivered);
  h.poll(A, true);
  h.store.inboxAck(SID, A, delivered.id);
  h.event("SessionEnd");
  h.advance(MOD_END_GRACE_MS + 1000);
  h.store.checkLeases();
  assert.equal(h.store.planGrant(SID, FP), undefined);
  assert.ok(get(h, delivered).grant_used_at);
  assert.equal(get(h, delivered).status, "answered", "a delivered approval stays answered");

  const queued = setup();
  const q = queued.plan();
  queued.approve(q);
  queued.event("SessionEnd");
  queued.advance(MOD_END_GRACE_MS + 1000);
  queued.store.checkLeases();
  assert.equal(get(queued, q).status, "answer_lost");
  assert.equal(get(queued, q).status_reason, "session_end");
  assert.equal(queued.store.planGrant(SID, FP), undefined);
});

test("a new plan for message delivery supersedes the session's earlier ones; one the mod is submitting waits, but its grant is gone at once", () => {
  const h = setup();
  const pending = h.plan("toolu_1", PLAN + "\nv1\n");
  const second = h.plan("toolu_2", PLAN + "\nv2\n");
  assert.equal(get(h, pending).status, "cancelled");
  assert.equal(get(h, pending).status_reason, "superseded");
  assert.equal(get(h, second).status, "pending");

  h.approve(second);
  h.poll(A, true); // the mod holds the approval of v2
  const third = h.plan("toolu_3", PLAN + "\nv3\n");
  const held = get(h, second);
  assert.equal(held.status, "answer_submitted", "the claim is alive: its ack or release closes it");
  assert.equal(held.close_reason, "superseded");
  assert.ok(held.grant_used_at);
  assert.equal(h.store.planGrant(SID, second.fingerprint!), undefined);
  assert.deepEqual(h.store.inboxRelease(SID, A, second.id, "the turn was interrupted"), { http: 200, status: "answer_lost" });
  assert.equal(get(h, second).status_reason, "superseded");

  h.approve(third);
  h.poll(A, true);
  h.store.inboxAck(SID, A, third.id);
  assert.ok(h.store.planGrant(SID, third.fingerprint!), "delivered, not used yet");
  h.plan("toolu_4", PLAN + "\nv4\n");
  assert.equal(h.store.planGrant(SID, third.fingerprint!), undefined, "a delivered approval of an older plan lets nothing through either");
  assert.equal(get(h, third).status, "answered");

  const q = setup();
  q.store.inboxPoll(SID, A, false);
  const question = q.store.create(
    { ...q.req("toolu_q"), kind: "answer_question", request: { questions: [{ question: "Which?", header: "Q", options: [{ label: "A" }, { label: "B" }] }] } },
    {},
  ).decision;
  q.plan("toolu_p");
  assert.equal(get(q, question).status, "pending", "a question is not superseded by a plan");
});

// ---- HTTP ----

async function serve() {
  const home = tmp();
  const dataDir = tmp();
  const h = await start({ port: 0, dataDir, home });
  handles.push(h);
  const transcript = join(home, ".claude", "projects", "p", `${SID}.jsonl`);
  mkdirSync(join(home, ".claude", "projects", "p"), { recursive: true });
  writeFileSync(transcript, "");
  const url = `http://127.0.0.1:${h.port}`;
  const api = (path: string, init: { body?: unknown; auth?: boolean } = {}) =>
    fetch(url + path, {
      method: init.body === undefined ? "GET" : "POST",
      headers: { ...(init.auth === false ? {} : { authorization: `Bearer ${h.token}` }), "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  return { h, api, transcript };
}

test("HTTP: GET plan-grant looks without using; POST plan-grant/consume uses it once; both need the bearer token and a fingerprint", async () => {
  const { api, transcript } = await serve();
  assert.equal((await api(`/api/sessions/${SID}/inbox/poll`, { body: { owner: A, idle: false } })).status, 204);
  const created = await api("/api/decisions", {
    body: { tool_use_id: "toolu_http", kind: "approve_plan", session: { session_id: SID, cwd: "/nonexistent-ukagai-cwd", transcript_path: transcript, permission_mode: "plan" }, request: { plan: PLAN, planFilePath: "/p/plan.md" }, mod_owner: A },
  });
  const d = (await created.json()) as Decision;
  assert.equal(d.delivery, "message");
  const q = `/api/sessions/${SID}/plan-grant?fingerprint=${FP}`;
  assert.equal((await api(q)).status, 404, "not approved yet");
  assert.equal((await api(`/api/decisions/${d.id}/answer`, { body: { approve: true, set_mode_auto: true } })).status, 200);
  assert.equal((await api(q, { auth: false })).status, 401);
  assert.equal((await api(`/api/sessions/${SID}/plan-grant`)).status, 400);
  assert.equal((await api(`/api/sessions/${SID}/plan-grant?fingerprint=nothex`)).status, 400);
  assert.deepEqual(await (await api(q)).json(), { grant: { decision_id: d.id, mode: "auto" } });
  assert.deepEqual(await (await api(q)).json(), { grant: { decision_id: d.id, mode: "auto" } }, "looking does not use it");
  assert.equal((await api(`/api/sessions/${SID}/plan-grant/consume`, { body: { fingerprint: FP }, auth: false })).status, 401);
  assert.equal((await api(`/api/sessions/${SID}/plan-grant/consume`, { body: {} })).status, 400);
  assert.deepEqual(await (await api(`/api/sessions/other/plan-grant/consume`, { body: { fingerprint: FP } })).json(), { consumed: false });
  assert.deepEqual(await (await api(`/api/sessions/${SID}/plan-grant/consume`, { body: { fingerprint: FP } })).json(), { consumed: false }, "an auto grant nobody handed to a PermissionRequest");
  assert.equal((await api(`/api/sessions/${SID}/plan-grant/hand`, { body: { fingerprint: FP }, auth: false })).status, 401);
  assert.equal((await api(`/api/sessions/${SID}/plan-grant/hand`, { body: {} })).status, 400);
  assert.deepEqual(await (await api(`/api/sessions/other/plan-grant/hand`, { body: { fingerprint: FP } })).json(), { handed: false });
  assert.deepEqual(await (await api(`/api/sessions/${SID}/plan-grant/hand`, { body: { fingerprint: FP } })).json(), { handed: true });
  assert.deepEqual(await (await api(`/api/sessions/${SID}/plan-grant/consume`, { body: { fingerprint: FP } })).json(), { consumed: true, mode: "auto" });
  assert.deepEqual(await (await api(`/api/sessions/${SID}/plan-grant/consume`, { body: { fingerprint: FP } })).json(), { consumed: false });
  assert.equal((await api(q)).status, 404);
  const after = (await (await api(`/api/decisions/${d.id}`)).json()) as Decision;
  assert.equal(after.status, "answered");
  assert.equal(after.response?.delivered_via, "grant");
});

// ---- audit R2b fixes ----

const P1 = PLAN + "\nv1\n";
const P2 = PLAN + "\nv2\n";
const FP1 = decisionFingerprint("approve_plan", { plan: P1, planFilePath: "/p/plan.md" });

test("S1: a newer plan registered for the waiting hook (the mod not fresh) writes off the older plan's grant; P1 called again after the human rejected P2 does not pass", () => {
  const h = setup();
  const d1 = h.plan("toolu_1", P1);
  h.approve(d1);
  h.poll(A, true);
  h.store.inboxAck(SID, A, d1.id);
  h.advance(MOD_FRESH_MS + 1000); // the mod went quiet: the next plan is classic
  const d2 = h.store.create(h.req("toolu_2", P2), {}).decision;
  assert.equal(d2.delivery, undefined, "P2 waits for the hook");
  h.store.submitAnswer(d2.id, { kind: "reject", reason: "no" });
  assert.equal(h.store.planGrant(SID, FP1), undefined);
  assert.deepEqual(h.store.consumePlanGrant(SID, FP1), { consumed: false });
  assert.ok(get(h, d1).grant_used_at);
  assert.equal(get(h, d1).status, "answered", "a delivered approval stays answered");
});

test("S1: with the setting off (no mod_owner) a newer plan closes the older one still waiting for delivery, auto grant included", () => {
  const h = setup();
  const d1 = h.plan("toolu_1", P1);
  h.approve(d1, true);
  const d2 = h.store.create(h.req("toolu_2", P2, { mod_owner: undefined }), {}).decision;
  assert.equal(d2.delivery, undefined);
  assert.equal(h.store.planGrant(SID, FP1), undefined);
  assert.equal(get(h, d1).status, "answer_lost");
  assert.equal(get(h, d1).status_reason, "superseded");
  assert.equal(h.poll(A, true), undefined, "nothing left to deliver");
});

test("M1: a main-agent event out of plan mode after the approval writes the grant off; plan-mode events, subagents, unknown modes and events built before the decision do not", () => {
  const h = setup();
  const d = h.plan();
  h.approve(d, true);
  const before = new Date(h.now() - 1000).toISOString();
  h.store.addEvent({ session_id: SID, transcript_path: "/t", cwd: "/w/proj", hook_event_name: "UserPromptSubmit", received_at: before, permission_mode: "default" } as never);
  h.event("Stop", { permission_mode: "plan" });
  h.event("Notification", { permission_mode: "plan", notification_type: "idle_prompt" });
  h.event("UserPromptSubmit", { permission_mode: "plan", delivered_ref: d.id.slice(0, 8) });
  h.event("PostToolUse", { tool_name: "Edit", permission_mode: "acceptEdits", agent_id: "sub-1" });
  h.event("Stop");
  h.event("UserPromptSubmit", { permission_mode: "default" }, "another-session");
  assert.deepEqual(h.store.planGrant(SID, FP), { decision_id: d.id, mode: "auto" }, "the regular re-call in plan mode still finds it");
  assert.deepEqual(h.store.handPlanGrant(SID, FP), { handed: true });
  assert.deepEqual(h.store.consumePlanGrant(SID, FP), { consumed: true, mode: "auto" });

  for (const mode of ["default", "acceptEdits", "auto", "bypassPermissions"]) {
    const x = setup();
    const p = x.plan();
    x.approve(p);
    x.event("UserPromptSubmit", { permission_mode: mode });
    assert.equal(x.store.planGrant(SID, FP), undefined, mode);
    assert.equal(x.poll(A, true), undefined, `${mode}: the approval ("it will be allowed") is not delivered`);
    assert.equal(get(x, p).status, "answer_lost", mode);
    assert.equal(get(x, p).status_reason, "superseded", mode);
  }
});

test("M2: a re-call that misses the grant goes back to the waiting hook; an auto approval then switches through the PermissionRequest like any classic one", () => {
  const h = setup();
  const d = h.plan();
  h.approve(d, true);
  const open = h.store.openFor(SID, undefined, FP, "toolu_again");
  assert.ok(open && "decision" in open, "classic re-attach: the approved plan goes through the hook");
  const after = get(h, d);
  assert.equal(after.delivery, undefined);
  assert.equal(after.delivery_flag, undefined);
  assert.equal(h.store.planGrant(SID, FP), undefined, "nothing passes before the waiting hook takes the answer");
  h.store.ack(d.id, true);
  assert.deepEqual(h.store.planGrant(SID, FP), { decision_id: d.id, mode: "auto" });
  assert.deepEqual(h.store.consumePlanGrant(SID, FP), { consumed: true, mode: "auto" });
  assert.equal(get(h, d).delivery_flag, undefined);

  const plain = setup();
  const p = plain.plan();
  plain.approve(p);
  plain.store.openFor(SID, undefined, FP, "toolu_again");
  assert.equal(get(plain, p).delivery_flag, undefined, "no auto was asked for");
});

test("M4: SessionEnd writes off a delivered approval at once, so a restart within the grace does not keep it; one still waiting keeps the grace", () => {
  const h = setup();
  const delivered = h.plan("toolu_1", P1);
  h.approve(delivered, true);
  h.poll(A, true);
  h.store.inboxAck(SID, A, delivered.id);
  h.event("SessionEnd");
  assert.equal(h.store.planGrant(SID, FP1), undefined);
  h.store.close();
  const again = setup({ dir: h.dir, start: h.now() + 2000 });
  again.advance(MOD_END_GRACE_MS + 60_000);
  again.store.checkLeases();
  assert.equal(again.store.planGrant(SID, FP1), undefined);

  const queued = setup();
  const q = queued.plan();
  queued.approve(q);
  queued.event("SessionEnd");
  assert.ok(queued.store.planGrant(SID, FP), "undelivered: the grace decides (a --resume may keep polling)");
  queued.advance(MOD_END_GRACE_MS + 1000);
  queued.store.checkLeases();
  assert.equal(queued.store.planGrant(SID, FP), undefined);
});

test("M5: a superseded approval the mod already submitted is not counted as answered: its ack is 409 answer_lost, and so is the transcript check", () => {
  const h = setup();
  const d1 = h.plan("toolu_1", P1);
  h.approve(d1);
  h.poll(A, true);
  h.plan("toolu_2", P2);
  assert.equal(get(h, d1).close_reason, "superseded");
  assert.deepEqual(h.store.inboxAck(SID, A, d1.id), { http: 409, status: "answer_lost" });
  assert.equal(get(h, d1).status_reason, "superseded");
  assert.equal(get(h, d1).response?.delivered_via, undefined);
});

test("M5: calling a plan again whose approval was written off goes back to the human (a new card), not through the waiting hook", () => {
  const h = setup();
  const d = h.plan();
  h.approve(d);
  h.event("UserPromptSubmit", { permission_mode: "default" }); // written off; the mod has not polled since
  assert.equal(h.store.openFor(SID, undefined, FP, "toolu_again"), undefined);
  assert.equal(get(h, d).status, "answer_lost");
});

// ---- with the inbox instructions (a plan instruction that has no decision) ----

test("a plan instruction sent while the approval waits for delivery waits behind it: the approval goes first, the instruction after the agent's next stop", async () => {
  const h = setup();
  const d = h.plan();
  h.approve(d);
  h.event("Stop", { permission_mode: "plan" }); // the agent ended its turn after the deny: idle
  assert.equal(await h.store.queuePlanInstruction(SID, "also check the tests"), "hook", "held back: an approval is on its way");
  const first = h.poll(A, true);
  assert.ok(first && "item" in first && first.item.item_id === d.id, "the approval first");
  assert.match(first.item.text, /The human approved your plan/);
  assert.deepEqual(h.poll(A, true), { held: { item_id: d.id } });
  assert.deepEqual(h.store.inboxAck(SID, A, d.id), { http: 200, status: "answered" });
  assert.ok(h.store.planGrant(SID, FP), "the grant is still there for the re-call");
  h.event("Stop", { permission_mode: "plan" }); // the delivery turn ended
  const next = h.poll(A, true);
  assert.ok(next && "item" in next && next.item.item_id !== d.id, "then the instruction");
  assert.match(next.item.text, /^\[ukagai\] \(ref [0-9a-f]{8}\) About the plan you are writing: also check the tests$/);
});

test("an approval whose grant was written off while an instruction waited behind it: the poll closes the approval and hands out the instruction at once", async () => {
  const h = setup();
  const d = h.plan();
  h.approve(d);
  h.event("Stop", { permission_mode: "plan" });
  assert.equal(await h.store.queuePlanInstruction(SID, "note"), "hook");
  h.event("Stop", { permission_mode: "default" }); // the human left plan mode by hand: the grant is written off, the approval is still queued
  assert.equal(h.store.planGrant(SID, FP), undefined);
  assert.equal(get(h, d).status, "answer_submitted");
  const r = h.poll(A, true);
  assert.ok(r && "item" in r && r.item.item_id !== d.id, "not the approval: the instruction");
  assert.match(r.item.text, /About the plan you are writing: note$/);
  assert.equal(get(h, d).status, "answer_lost");
  assert.equal(get(h, d).status_reason, "superseded");
});

// ---- re-audit L1 / L2 ----

test("L1: a subagent's plan does not supersede the main agent's plans: a pending one stays, an approved one keeps its grant and is still delivered", () => {
  const sub = (h: H, n: number) =>
    h.store.create(h.req(`toolu_sub_${n}`, P2, { mod_owner: undefined, session: { session_id: SID, cwd: "/w/proj", transcript_path: join(h.dir, "t.jsonl"), permission_mode: "plan", agent_id: "sub-1", agent_type: "Plan" } }), {}).decision;
  const h = setup();
  const pending = h.plan("toolu_main", P1);
  assert.equal(sub(h, 1).delivery, undefined);
  assert.equal(get(h, pending).status, "pending");
  assert.equal(get(h, pending).status_reason, undefined);
  assert.deepEqual(h.store.waitingFor(SID), { decision_id: pending.id, kind: "approve_plan" }, "the main agent still waits for it");

  const a = setup();
  const approved = a.plan("toolu_main", P1);
  a.approve(approved, true);
  sub(a, 2);
  assert.equal(get(a, approved).status, "answer_submitted");
  assert.deepEqual(a.store.planGrant(SID, FP1), { decision_id: approved.id, mode: "auto" });
  const item = a.poll(A, true);
  assert.ok(item && "item" in item && item.item.item_id === approved.id, "the approval is still delivered");

  const d = setup();
  const delivered = d.plan("toolu_main", P1);
  d.approve(delivered);
  d.poll(A, true);
  d.store.inboxAck(SID, A, delivered.id);
  sub(d, 3);
  assert.ok(d.store.planGrant(SID, FP1), "a delivered approval keeps its grant too");
});

test("L2: an approval the mod is already submitting when an event writes its grant off closes as lost: ack 409 answer_lost, and the re-call registers anew", () => {
  const h = setup();
  const d = h.plan("toolu_1", P1);
  h.advance(1000);
  h.approve(d, true);
  const item = h.poll(A, true);
  assert.ok(item && "item" in item);
  h.event("UserPromptSubmit", { permission_mode: "default" });
  assert.equal(h.store.planGrant(SID, FP1), undefined);
  assert.equal(get(h, d).close_reason, "superseded");
  assert.deepEqual(h.store.inboxAck(SID, A, d.id), { http: 409, status: "answer_lost" });
  assert.equal(get(h, d).status_reason, "superseded");
  assert.equal(h.store.openFor(SID, undefined, FP1, "toolu_again"), undefined);
});

test("L2: the same when the claiming mod went away and the transcript shows its submit", () => {
  const h = setup();
  const d = h.plan("toolu_1", P1);
  h.advance(1000);
  h.approve(d);
  h.poll(A, true);
  h.event("Stop", { permission_mode: "default" });
  appendFileSync(join(h.dir, "t.jsonl"), JSON.stringify({ type: "user", origin: { kind: "plugin" }, message: { content: [{ type: "text", text: `[ukagai] (ref ${d.id.slice(0, 8)}) The human approved your plan` }] } }) + "\n");
  h.advance(MOD_CLAIM_STALE_MS + 1000);
  h.store.checkLeases();
  assert.equal(get(h, d).status, "answer_lost");
  assert.equal(get(h, d).status_reason, "superseded");
});

// ---- the waiting hook (classic): "approve and auto" goes through the PermissionRequest of the same ExitPlanMode ----

/** A plan waited for by the hook (no mod), answered; `take` is the hook's ack (true: it leaves an auto grant to the PermissionRequest) */
function classicPlan(h: H, opts: { toolUseId?: string; plan?: string; auto?: boolean; take?: boolean; keep?: boolean; agentId?: string } = {}): Decision {
  const extra: Partial<CreateDecisionRequest> = { mod_owner: undefined };
  const req = h.req(opts.toolUseId ?? "toolu_c", opts.plan ?? PLAN, extra);
  if (opts.agentId) req.session = { ...req.session, agent_id: opts.agentId };
  const d = h.store.create(req, {}).decision;
  assert.equal(d.delivery, undefined);
  h.approve(d, opts.auto ?? true);
  if (opts.take !== false) h.store.ack(d.id, opts.keep ?? true);
  return d;
}

test("classic: approve and auto derives an auto grant only once the hook took it and left it (ack with keep_plan_grant); the PermissionRequest uses it once", () => {
  const h = setup();
  const d = classicPlan(h, { take: false });
  assert.equal(h.store.planGrant(SID, FP), undefined, "answer_submitted: the waiting hook has not taken it");
  h.store.ack(d.id, true);
  assert.deepEqual(h.store.planGrant(SID, FP), { decision_id: d.id, mode: "auto" });
  assert.equal(get(h, d).grant_used_at, undefined);
  assert.equal(get(h, d).response?.delivered_via, "hook");
  assert.deepEqual(h.store.consumePlanGrant(SID, FP), { consumed: true, mode: "auto" });
  assert.deepEqual(h.store.consumePlanGrant(SID, FP), { consumed: false }, "once");
  const done = get(h, d);
  assert.ok(done.grant_used_at);
  assert.equal(done.status, "answered");
  assert.equal(done.response?.delivered_via, "hook", "the hook delivered it; the grant only switched the mode");
  assert.equal(done.delivery_flag, undefined);
});

test("classic: an approval the hook let through itself leaves no grant — a plain one, auto without keep_plan_grant (flagged), and a subagent's (flagged)", () => {
  const plain = setup();
  const p = classicPlan(plain, { auto: false });
  assert.equal(plain.store.planGrant(SID, FP), undefined, "the PreToolUse allow used it");
  assert.ok(get(plain, p).grant_used_at);
  assert.equal(get(plain, p).delivery_flag, undefined);

  const noKeep = setup();
  const n = classicPlan(noKeep, { keep: false });
  assert.equal(noKeep.store.planGrant(SID, FP), undefined);
  assert.ok(get(noKeep, n).grant_used_at);
  assert.equal(get(noKeep, n).delivery_flag, "auto_not_applied");

  const sub = setup();
  const s = classicPlan(sub, { agentId: "sub-1" });
  assert.equal(sub.store.planGrant(SID, FP), undefined);
  assert.ok(get(sub, s).grant_used_at, "a subagent's ExitPlanMode never gets the grant: keep_plan_grant is ignored");
  assert.equal(get(sub, s).delivery_flag, "auto_not_applied");

  const rejected = setup();
  const r = rejected.store.create(rejected.req("toolu_r", PLAN, { mod_owner: undefined }), {}).decision;
  rejected.store.submitAnswer(r.id, { kind: "reject", reason: "no" });
  rejected.store.ack(r.id, true);
  assert.equal(rejected.store.planGrant(SID, FP), undefined);
  assert.equal(get(rejected, r).grant_used_at, undefined);
});

test("classic: the grant needs the same session and plan, and lasts only the hand window after the ack", () => {
  const h = setup();
  classicPlan(h);
  const otherFp = decisionFingerprint("approve_plan", { plan: PLAN + "\nchanged\n", planFilePath: "/p/plan.md" });
  assert.deepEqual(h.store.consumePlanGrant(SID, otherFp), { consumed: false });
  assert.deepEqual(h.store.consumePlanGrant("another-session", FP), { consumed: false });
  h.advance(PLAN_GRANT_HAND_WINDOW_MS);
  assert.ok(h.store.planGrant(SID, FP), "still in the window");
  h.advance(1);
  assert.equal(h.store.planGrant(SID, FP), undefined);
  assert.deepEqual(h.store.consumePlanGrant(SID, FP), { consumed: false });
});

test("classic: PostToolUse of ExitPlanMode, a main-agent event out of plan mode, SessionEnd and a newer main-agent plan write the grant off; a subagent's plan does not", () => {
  const post = setup();
  const p = classicPlan(post);
  post.event("PostToolUse", { tool_name: "ExitPlanMode", agent_id: "sub-1" });
  assert.ok(post.store.planGrant(SID, FP), "a subagent's PostToolUse leaves it");
  post.event("PostToolUse", { tool_name: "ExitPlanMode" });
  assert.equal(post.store.planGrant(SID, FP), undefined);
  assert.equal(get(post, p).delivery_flag, "auto_not_applied", "the plan went through without the switch");

  const mode = setup();
  classicPlan(mode);
  mode.event("Notification", { permission_mode: "plan" });
  mode.event("Stop", { permission_mode: "acceptEdits", agent_id: "sub-1" });
  assert.ok(mode.store.planGrant(SID, FP), "plan-mode and subagent events leave it");
  mode.event("UserPromptSubmit", { permission_mode: "default" });
  assert.equal(mode.store.planGrant(SID, FP), undefined);

  const end = setup();
  classicPlan(end);
  end.event("SessionEnd");
  assert.equal(end.store.planGrant(SID, FP), undefined, "a taken (answered) approval is written off at once");

  const newer = setup();
  classicPlan(newer);
  newer.advance(1000);
  newer.store.create(newer.req("toolu_sub", PLAN + "\nsub\n", { mod_owner: undefined, session: { ...newer.req("x").session, agent_id: "sub-1" } }), {});
  assert.ok(newer.store.planGrant(SID, FP), "a subagent's plan is not the main agent's next plan");
  newer.store.create(newer.req("toolu_next", PLAN + "\nnext\n", { mod_owner: undefined }), {});
  assert.equal(newer.store.planGrant(SID, FP), undefined, "the human decides again");
});

test("classic: a grant left to the PermissionRequest survives a restart; an approval recorded before this kind of grant existed holds none", () => {
  const h = setup();
  const d = classicPlan(h);
  h.store.close();
  const again = setup({ dir: h.dir, start: h.now() + 1000 });
  assert.deepEqual(again.store.planGrant(SID, FP), { decision_id: d.id, mode: "auto" });

  // An older server acked classic approvals without the hook mark (and without grant_used_at): such a record lets nothing through
  const old = setup();
  const o = classicPlan(old, { take: false });
  const legacy = { ...get(old, o), status: "answered", response: { ...get(old, o).response!, delivered_at: new Date(old.now()).toISOString() } };
  old.store.close();
  appendFileSync(join(old.dir, "decisions.jsonl"), JSON.stringify(legacy) + "\n");
  const restarted = setup({ dir: old.dir, start: old.now() + 1000 });
  assert.equal(restarted.store.get(o.id)?.status, "answered");
  assert.equal(restarted.store.planGrant(SID, FP), undefined);
});

test("HTTP: the waiting hook's ack with keep_plan_grant leaves an auto grant; a plain ack uses it up; a malformed ack body is 400", async () => {
  const { api, transcript } = await serve();
  const register = async (toolUseId: string) => {
    const r = await api("/api/decisions", {
      body: { tool_use_id: toolUseId, kind: "approve_plan", session: { session_id: SID, cwd: "/nonexistent-ukagai-cwd", transcript_path: transcript, permission_mode: "plan" }, request: { plan: PLAN, planFilePath: "/p/plan.md" } },
    });
    const d = (await r.json()) as Decision;
    assert.equal(d.delivery, undefined);
    assert.equal((await api(`/api/decisions/${d.id}/answer`, { body: { approve: true, set_mode_auto: true } })).status, 200);
    return d;
  };
  const q = `/api/sessions/${SID}/plan-grant?fingerprint=${FP}`;
  const kept = await register("toolu_keep");
  assert.equal((await api(`/api/decisions/${kept.id}/ack`, { body: { keep_plan_grant: "yes" } })).status, 400);
  assert.equal((await api(`/api/decisions/${kept.id}/ack`, { body: { keep_plan_grant: true } })).status, 200);
  assert.deepEqual(await (await api(q)).json(), { grant: { decision_id: kept.id, mode: "auto" } });
  assert.deepEqual(await (await api(`/api/sessions/${SID}/plan-grant/consume`, { body: { fingerprint: FP } })).json(), { consumed: true, mode: "auto" });

  const plain = await register("toolu_plain_ack");
  assert.equal((await api(`/api/decisions/${plain.id}/ack`, { body: {} })).status, 200);
  assert.equal((await api(q)).status, 404);
  const after = (await (await api(`/api/decisions/${plain.id}`)).json()) as Decision;
  assert.equal(after.delivery_flag, "auto_not_applied");
});

// ---- audit R4 S1: an auto grant is handed to one PermissionRequest, once, for PLAN_GRANT_HAND_WINDOW_MS ----

test("hand: an auto grant for message delivery is handed once; the PermissionRequest uses it inside the window; nobody can use it unhanded", () => {
  const h = setup();
  const d = h.plan();
  h.approve(d, true);
  assert.deepEqual(h.store.consumePlanGrant(SID, FP), { consumed: false }, "not handed: no PermissionRequest was left it");
  assert.deepEqual(h.store.handPlanGrant("another-session", FP), { handed: false });
  assert.deepEqual(h.store.handPlanGrant(SID, FP), { handed: true });
  assert.equal(get(h, d).grant_handed_at, new Date(h.now()).toISOString(), "the store's clock");
  h.advance(PLAN_GRANT_HAND_WINDOW_MS);
  assert.deepEqual(h.store.consumePlanGrant(SID, FP), { consumed: true, mode: "auto" });

  const plain = setup();
  const p = plain.plan();
  plain.approve(p);
  assert.deepEqual(plain.store.handPlanGrant(SID, FP), { handed: false }, "a grant without mode is the PreToolUse's own");
  assert.equal(get(plain, p).grant_handed_at, undefined);
  assert.deepEqual(plain.store.consumePlanGrant(SID, FP), { consumed: true });
});

test("hand: a second hand (the PermissionRequest did not use the first) writes the grant off; the plan goes back to the human", () => {
  const h = setup();
  const d = h.plan();
  h.approve(d, true);
  h.poll(A, true);
  h.store.inboxAck(SID, A, d.id);
  assert.deepEqual(h.store.handPlanGrant(SID, FP), { handed: true });
  // Claude Code's own dialog asked (the PermissionRequest missed the server); the agent calls the same plan again
  assert.deepEqual(h.store.handPlanGrant(SID, FP), { handed: false });
  assert.ok(get(h, d).grant_used_at);
  assert.equal(h.store.planGrant(SID, FP), undefined);
  assert.deepEqual(h.store.consumePlanGrant(SID, FP), { consumed: false });
  assert.equal(h.store.openFor(SID, undefined, FP, "toolu_again"), undefined, "nothing open: the re-call registers anew");
  const fresh = h.plan("toolu_again");
  assert.notEqual(fresh.id, d.id);
  assert.equal(fresh.status, "pending");
});

test("hand: past the window a handed auto grant is gone, hours later and after a restart too (audit R1, R1b); the plan-mode events in between change nothing", () => {
  const h = setup();
  classicPlan(h);
  h.event("Stop", { permission_mode: "plan" });
  h.event("Notification", { permission_mode: "plan" });
  h.advance(PLAN_GRANT_HAND_WINDOW_MS + 1);
  assert.equal(h.store.planGrant(SID, FP), undefined);
  assert.deepEqual(h.store.consumePlanGrant(SID, FP), { consumed: false });
  assert.deepEqual(h.store.handPlanGrant(SID, FP), { handed: false });
  h.advance(3 * 3600 * 1000);
  h.event("UserPromptSubmit", { permission_mode: "plan" });
  assert.deepEqual(h.store.consumePlanGrant(SID, FP), { consumed: false });

  const r = setup();
  const kept = classicPlan(r);
  r.store.close();
  const within = setup({ dir: r.dir, start: r.now() + 1000 });
  assert.deepEqual(within.store.planGrant(SID, FP), { decision_id: kept.id, mode: "auto" }, "a quick restart keeps the window");
  within.store.close();
  const late = setup({ dir: r.dir, start: r.now() + 60_001 });
  assert.equal(late.store.planGrant(SID, FP), undefined);
  assert.equal(late.store.get(kept.id)?.status, "answered");
});

test("hand: a classic auto grant was handed by the ack, so a re-call's hand writes it off (audit Q1)", () => {
  const h = setup();
  const d = classicPlan(h);
  assert.ok(get(h, d).grant_handed_at);
  assert.deepEqual(h.store.handPlanGrant(SID, FP), { handed: false });
  assert.ok(get(h, d).grant_used_at);
  assert.deepEqual(h.store.consumePlanGrant(SID, FP), { consumed: false });
});

test("hand: the plan went through Claude Code's own dialog after its window: PostToolUse still flags auto_not_applied", () => {
  const h = setup();
  const d = classicPlan(h);
  h.advance(PLAN_GRANT_HAND_WINDOW_MS + 5000);
  h.event("PostToolUse", { tool_name: "ExitPlanMode", permission_mode: "plan" });
  assert.equal(get(h, d).delivery_flag, "auto_not_applied");
  assert.ok(get(h, d).grant_used_at);
});

test("the waiting hook's ack writes delivered_at with the store's clock", () => {
  const h = setup();
  const d = classicPlan(h, { take: false });
  h.advance(5000);
  h.store.ack(d.id, true);
  assert.equal(get(h, d).response?.delivered_at, new Date(h.now()).toISOString());
  assert.equal(get(h, d).grant_handed_at, new Date(h.now()).toISOString());
});

test("audit L1: the Codex bridge's ack of a plan approved with auto keeps the record as before: no hook mark, no flag, no grant", () => {
  const h = setup();
  const req = h.req("toolu_codex", PLAN, { mod_owner: undefined });
  req.session = { ...req.session, agent: "codex" };
  const d = h.store.create(req, {}).decision;
  h.approve(d, true);
  h.store.ack(d.id);
  const after = get(h, d);
  assert.equal(after.status, "answered");
  assert.equal(after.response?.delivered_via, undefined);
  assert.equal(after.delivery_flag, undefined);
  assert.equal(after.grant_handed_at, undefined);
  assert.equal(h.store.planGrant(SID, FP), undefined);
  // and with keep_plan_grant (no Codex caller sends it) nothing is handed either
  const k = setup();
  const kreq = k.req("toolu_codex_k", PLAN, { mod_owner: undefined });
  kreq.session = { ...kreq.session, agent: "codex" };
  const kd = k.store.create(kreq, {}).decision;
  k.approve(kd, true);
  k.store.ack(kd.id, true);
  assert.equal(k.store.planGrant(SID, FP), undefined);
});

// ---- re-audit S1': a grant for message delivery is for the re-call right after delivery; a human prompt after a hand writes it off ----

test("recall deadline: the grant lasts PLAN_GRANT_RECALL_MS from the delivery; a delivered approval re-called at once still passes (auto and without mode)", () => {
  const h = setup();
  const d = h.plan();
  h.approve(d, true);
  h.advance(PLAN_GRANT_RECALL_MS - 60_000);
  assert.ok(h.poll(A, true), "delivered late but within the deadline");
  h.store.inboxAck(SID, A, d.id);
  h.advance(PLAN_GRANT_RECALL_MS);
  assert.deepEqual(h.store.planGrant(SID, FP), { decision_id: d.id, mode: "auto" }, "counted from the delivery");
  h.advance(1);
  assert.equal(h.store.planGrant(SID, FP), undefined);

  const now = setup();
  const n = now.plan();
  now.approve(n, true);
  now.poll(A, true);
  now.store.inboxAck(SID, A, n.id);
  now.advance(5000);
  assert.deepEqual(now.store.handPlanGrant(SID, FP), { handed: true });
  now.advance(2000);
  assert.deepEqual(now.store.consumePlanGrant(SID, FP), { consumed: true, mode: "auto" });

  const plain = setup();
  const p = plain.plan();
  plain.approve(p);
  plain.poll(A, true);
  plain.store.inboxAck(SID, A, p.id);
  plain.advance(5000);
  assert.deepEqual(plain.store.consumePlanGrant(SID, FP), { consumed: true });
});

test("recall deadline (audit T7): the first re-call never reached the server; hours later the same plan is not handed and goes to the human", () => {
  const h = setup();
  const d = h.plan();
  h.approve(d, true);
  h.poll(A, true);
  h.store.inboxAck(SID, A, d.id);
  // outage: nothing of the first re-call reaches the server; Claude Code's own dialog asks and the human says no
  h.advance(2 * 3600 * 1000);
  h.poll(A, false);
  h.event("UserPromptSubmit", { permission_mode: "plan" });
  assert.equal(h.store.planGrant(SID, FP), undefined);
  assert.deepEqual(h.store.handPlanGrant(SID, FP), { handed: false });
  assert.deepEqual(h.store.consumePlanGrant(SID, FP), { consumed: false });
  assert.equal(h.store.openFor(SID, undefined, FP, "toolu_again"), undefined, "nothing open: the re-call registers anew");
  const fresh = h.plan("toolu_again");
  assert.notEqual(fresh.id, d.id);
  assert.equal(fresh.status, "pending", "a new card for the human");
});

test("recall deadline (audit T1): an auto grant an old PreToolUse never handed is gone after the deadline, so a newer hook starts from nothing", () => {
  const h = setup();
  const d = h.plan();
  h.approve(d, true);
  h.poll(A, true);
  h.store.inboxAck(SID, A, d.id);
  assert.deepEqual(h.store.consumePlanGrant(SID, FP), { consumed: false }, "an old hook: unhanded, refused");
  h.advance(PLAN_GRANT_RECALL_MS + 1);
  assert.deepEqual(h.store.handPlanGrant(SID, FP), { handed: false });
  assert.equal(get(h, d).status, "answered");
});

test("recall deadline: an approval still undelivered past it is not delivered ('it will be allowed' would be wrong) and closes; a re-call of it registers anew", () => {
  const h = setup();
  const d = h.plan();
  h.approve(d, true);
  h.advance(PLAN_GRANT_RECALL_MS + 1);
  assert.equal(h.poll(A, true), undefined, "poll does not hand it out");
  assert.equal(get(h, d).status, "answer_lost");
  assert.equal(get(h, d).status_reason, "superseded");

  const r = setup();
  const rd = r.plan();
  r.approve(rd, true);
  r.advance(PLAN_GRANT_RECALL_MS + 1);
  assert.equal(r.store.openFor(SID, undefined, FP, "toolu_again"), undefined, "openFor closes it and answers 404");
  assert.equal(get(r, rd).status, "answer_lost");
});

test("human prompt (audit T3): after a hand, the human's UserPromptSubmit (plan mode too) writes the handed grant off; the mod's delivery, a wake-up and a prompt built before the hand do not", () => {
  const h = setup();
  const d = h.plan();
  h.approve(d, true);
  h.poll(A, true);
  h.store.inboxAck(SID, A, d.id);
  h.advance(1000);
  assert.deepEqual(h.store.handPlanGrant(SID, FP), { handed: true });
  h.store.addEvent({ session_id: SID, transcript_path: "/t", cwd: "/w/proj", hook_event_name: "UserPromptSubmit", received_at: new Date(h.now() - 500).toISOString(), permission_mode: "plan" } as never);
  h.event("UserPromptSubmit", { permission_mode: "plan", delivered_ref: d.id.slice(0, 8) });
  h.event("UserPromptSubmit", { permission_mode: "plan", wakeup: true });
  h.event("Stop", { permission_mode: "plan" });
  assert.deepEqual(h.store.planGrant(SID, FP), { decision_id: d.id, mode: "auto" }, "none of these is the human after the hand");
  h.advance(5000);
  h.event("UserPromptSubmit", { permission_mode: "plan" });
  assert.equal(h.store.planGrant(SID, FP), undefined);
  assert.deepEqual(h.store.consumePlanGrant(SID, FP), { consumed: false });
  assert.ok(get(h, d).grant_used_at);

  const unhanded = setup();
  const u = unhanded.plan();
  unhanded.approve(u, true);
  unhanded.poll(A, true);
  unhanded.store.inboxAck(SID, A, u.id);
  unhanded.event("UserPromptSubmit", { permission_mode: "plan" });
  assert.ok(unhanded.store.planGrant(SID, FP), "a grant not handed yet is left (the human may ask for the re-call)");
});

test("human prompt: a classic grant handed by the ack is written off by the human typing too; the classic flow (ack → PermissionRequest) is unchanged", () => {
  const h = setup();
  classicPlan(h);
  h.advance(1000);
  h.event("UserPromptSubmit", { permission_mode: "plan" });
  assert.equal(h.store.planGrant(SID, FP), undefined);

  const c = setup();
  classicPlan(c);
  c.advance(2000);
  assert.deepEqual(c.store.consumePlanGrant(SID, FP), { consumed: true, mode: "auto" });
});
