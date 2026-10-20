// A plan approved while it waited for message delivery: its grant lets the same plan's re-called ExitPlanMode through once
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MOD_END_GRACE_MS, PLAN_GRANT_TTL_MS, decisionFingerprint, type CreateDecisionRequest, type Decision } from "../../src/contract.js";
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

test("an approval derives a grant (no mode / auto) and makes no pending mode switch; a rejection, an instruction or a classic approval derive none", () => {
  const h = setup();
  const plain = h.plan("toolu_plain");
  assert.equal(h.store.planGrant(SID, FP), undefined, "not answered yet");
  h.approve(plain);
  assert.deepEqual(h.store.planGrant(SID, FP), { decision_id: plain.id });
  assert.equal(h.store.getModeSwitch(SID).pending, false);

  const auto = setup();
  const a = auto.plan("toolu_auto");
  auto.approve(a, true);
  assert.deepEqual(auto.store.planGrant(SID, FP), { decision_id: a.id, mode: "auto" });
  assert.equal(auto.store.getModeSwitch(SID).pending, false, "the grant switches to auto, not the first edit");

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
  assert.equal(classic.store.planGrant(SID, FP), undefined, "a classic approval goes back through the waiting hook");
  assert.equal(classic.store.getModeSwitch(SID).pending, true, "classic keeps its pending mode switch");
});

test("only the same session and the same plan can use the grant, only once, and not more than 12 hours after the approval", () => {
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
  late.advance(PLAN_GRANT_TTL_MS - 1000);
  assert.ok(late.store.planGrant(SID, FP), "still within 12 hours");
  late.advance(2000);
  assert.equal(late.store.planGrant(SID, FP), undefined);
  assert.deepEqual(late.store.consumePlanGrant(SID, FP), { consumed: false });
});

// ---- using it ----

test("using the grant answers the decision (delivered_via grant) and ends the mod's claim; the mod's late ack or release changes nothing (R4)", () => {
  const h = setup();
  const d = h.plan();
  h.approve(d, true);
  const item = h.poll(A, true);
  assert.ok(item && "item" in item, "the mod holds the approval");
  assert.match(item.item.text, /The human approved your plan in the ukagai GUI\. Call ExitPlanMode once more with the same plan/);
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
  assert.deepEqual(await (await api(`/api/sessions/${SID}/plan-grant/consume`, { body: { fingerprint: FP } })).json(), { consumed: true, mode: "auto" });
  assert.deepEqual(await (await api(`/api/sessions/${SID}/plan-grant/consume`, { body: { fingerprint: FP } })).json(), { consumed: false });
  assert.equal((await api(q)).status, 404);
  const after = (await (await api(`/api/decisions/${d.id}`)).json()) as Decision;
  assert.equal(after.status, "answered");
  assert.equal(after.response?.delivered_via, "grant");
});
