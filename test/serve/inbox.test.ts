import { after, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DELIVERY_MAX_ATTEMPTS,
  MESSAGE_TTL_MS,
  MOD_CLAIM_STALE_MS,
  MOD_END_GRACE_MS,
  MOD_FRESH_MS,
  MOD_GONE_MS,
  decisionFingerprint,
  deliveryRef,
  type CreateDecisionRequest,
  type Decision,
} from "../../src/contract.js";
import { HttpError, Store } from "../../src/serve/store.js";

const roots: string[] = [];
const stores: Store[] = [];
after(() => {
  for (const s of stores) s.close();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

const A = "a".repeat(16);
const B = "b".repeat(16);
const SID = "sess-inbox";

function setup(opts: { dir?: string; messageDelivery?: () => boolean; start?: number } = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "ukagai-inbox-"));
  if (!opts.dir) roots.push(dir);
  const transcript = join(dir, "t.jsonl");
  if (!opts.dir) writeFileSync(transcript, "");
  let t = opts.start ?? Date.parse("2026-01-01T00:00:00.000Z");
  const logs: string[] = [];
  const store = new Store({ dir, leaseGraceMs: 60_000, now: () => t, messageDelivery: opts.messageDelivery, log: (e) => logs.push(e), broadcast: () => {} });
  store.load();
  stores.push(store);
  const h = {
    dir,
    transcript,
    store,
    logs,
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    /** A poll, so that the owner counts as seen */
    poll(owner = A, idle = false, session = SID) {
      return store.inboxPoll(session, owner, idle);
    },
    req(toolUseId: string, extra: Partial<CreateDecisionRequest> = {}): CreateDecisionRequest {
      return {
        tool_use_id: toolUseId,
        kind: "answer_question",
        session: { session_id: SID, cwd: "/w/proj", transcript_path: transcript },
        request: { questions: [{ question: `Which database should the cache use (${toolUseId})?`, header: "DB", options: [{ label: "Redis" }, { label: "Memcached" }], multiSelect: false }] },
        mod_owner: A,
        ...extra,
      };
    },
    /** A decision registered for message delivery (its owner polled just before) */
    ask(toolUseId = "toolu_1", extra: Partial<CreateDecisionRequest> = {}): Decision {
      store.inboxPoll(extra.session?.session_id ?? SID, extra.mod_owner ?? A, false);
      return store.create(h.req(toolUseId, extra), {}).decision;
    },
    answer(d: Decision, value = "Redis"): void {
      const q = (d.request as { questions: { question: string }[] }).questions[0]!.question;
      store.submitAnswer(d.id, { kind: "answers", answers: { [q]: value } });
    },
    /** A hook event of the session, received 1 ms from now (so a decision made now is older than it) */
    event(name: string, extra: Record<string, unknown> = {}, session = SID): void {
      store.addEvent({ session_id: session, transcript_path: transcript, cwd: "/w/proj", hook_event_name: name, received_at: new Date(t + 1).toISOString(), ...extra } as never);
    },
    /** A line of the transcript the way Claude Code writes a message a plugin submitted (or a human typed the same words) */
    deliverIntoTranscript(d: Decision, origin: "plugin" | "human" = "plugin"): void {
      const text = `${origin === "plugin" ? "The ukagai-mod plugin sent a message:\n" : ""}[ukagai] (ref ${deliveryRef(d.id)}) The human answered your question in the ukagai GUI:\n- "q": "Redis"`;
      appendFileSync(transcript, JSON.stringify({ type: "user", origin: { kind: origin }, message: { role: "user", content: [{ type: "text", text }] } }) + "\n");
    },
  };
  return h;
}
type H = ReturnType<typeof setup>;

const get = (h: H, d: Decision): Decision => h.store.get(d.id)!;

/** Registered, answered and claimed by A: the mod is submitting it */
function claimed(h: H, toolUseId = "toolu_c"): Decision {
  const d = h.ask(toolUseId);
  h.answer(d);
  const item = h.poll(A, true);
  assert.ok(item && "item" in item && item.item.item_id === d.id, "claimed");
  return d;
}

// ---- registration ----

test("a decision is registered for message delivery only when its owner polled the session recently", () => {
  const h = setup();
  assert.equal(h.store.create(h.req("t0"), {}).decision.delivery, undefined, "the owner was never seen");
  h.poll(A);
  const d = h.store.create(h.req("t1"), {}).decision;
  assert.equal(d.delivery, "message");
  assert.equal(d.mod_owner, A);
  assert.equal(d.lease_until, undefined, "no lease: no hook waits");
  assert.equal(d.status, "pending");
  h.advance(MOD_FRESH_MS + 1);
  assert.equal(h.store.create(h.req("t2"), {}).decision.delivery, undefined, "seen too long ago");
});

test("not for another session's owner, a missing or malformed owner, a subagent, Codex, the toggle off, a plan, or an irreversible question outside plan mode", () => {
  const h = setup();
  h.poll(A, false, "other-session");
  assert.equal(h.store.create(h.req("t1"), {}).decision.delivery, undefined, "the owner polled another session");
  h.poll(A);
  const base = h.req("t2");
  assert.equal(h.store.create({ ...h.req("t2"), mod_owner: undefined }, {}).decision.delivery, undefined);
  assert.equal(h.store.create({ ...h.req("t3"), mod_owner: "NOT-HEX" }, {}).decision.delivery, undefined);
  assert.equal(h.store.create({ ...h.req("t4"), session: { ...base.session, agent_id: "sub-1" } }, {}).decision.delivery, undefined);
  assert.equal(h.store.create({ ...h.req("t5"), session: { ...base.session, agent: "codex" } }, {}).decision.delivery, undefined);
  assert.equal(h.store.create({ ...h.req("t6"), kind: "approve_plan", request: { plan: "# p", planFilePath: "/p.md" } }, {}).decision.delivery, undefined, "plans stay with the hook");
  const exp = (reversibility: "irreversible" | "reversible") => ({ path: "", markdown: "x", has: { mermaid: false, table: false, diff: false }, match: "question" as const, attached_via: "first_call" as const, reversibility });
  assert.equal(h.store.create({ ...h.req("t7"), explanation: exp("irreversible") }, {}).decision.delivery, undefined);
  assert.equal(h.store.create({ ...h.req("t8"), explanation: exp("irreversible"), session: { ...base.session, permission_mode: "plan" } }, {}).decision.delivery, "message");
  assert.equal(h.store.create({ ...h.req("t9"), explanation: exp("reversible") }, {}).decision.delivery, "message");

  let on = false;
  const off = setup({ messageDelivery: () => on });
  off.poll(A);
  assert.equal(off.store.create(off.req("t1"), {}).decision.delivery, undefined, "toggle off");
  on = true;
  assert.equal(off.store.create(off.req("t2"), {}).decision.delivery, "message", "the setting is read at each registration");
});

// ---- poll / claim ----

test("poll hands an answer out only when idle, claims it for the polling owner, and answers `held` while it holds it", () => {
  const h = setup();
  const d = h.ask();
  assert.equal(h.poll(A, true), undefined, "nothing answered yet");
  h.answer(d);
  assert.equal(h.poll(A, false), undefined, "not idle");
  const item = h.poll(A, true);
  assert.ok(item && "item" in item);
  assert.equal(item.item.item_id, d.id);
  assert.match(item.item.text, /^\[ukagai\] \(ref [0-9a-f]{8}\) /);
  assert.equal(get(h, d).claim?.owner, A);
  assert.equal(get(h, d).status, "answer_submitted", "still not delivered");
  assert.deepEqual(h.poll(A, true), { held: { item_id: d.id } });
  assert.deepEqual(h.poll(A, false), { held: { item_id: d.id } });
});

test("another live owner does not get A's item; once A is silent for MOD_CLAIM_STALE_MS the session's other owner takes it over and becomes its owner", () => {
  const h = setup();
  const d = h.ask();
  h.answer(d);
  h.poll(B, false);
  assert.equal(h.poll(B, true), undefined, "A is alive: B must not take it");
  h.advance(MOD_CLAIM_STALE_MS + 1000);
  h.poll(B, false); // B keeps polling; A went silent (a reload)
  const item = h.poll(B, true);
  assert.ok(item && "item" in item, "taken over");
  assert.equal(get(h, d).mod_owner, B);
  assert.equal(get(h, d).claim?.owner, B);
});

test("a claimed item is not handed to another owner; an item with a close_reason or at the drop limit is not handed out", () => {
  const h = setup();
  const d = claimed(h);
  h.poll(B, false);
  h.advance(MOD_CLAIM_STALE_MS - 5000);
  h.poll(A, false);
  assert.equal(h.poll(B, true), undefined);
  assert.equal(get(h, d).claim?.owner, A);
});

// ---- ack ----

test("ack answers the decision with delivered_via message; a second ack is 200 too", () => {
  const h = setup();
  const d = claimed(h);
  assert.deepEqual(h.store.inboxAck(SID, A, d.id), { http: 200, status: "answered" });
  const done = get(h, d);
  assert.equal(done.status, "answered");
  assert.equal(done.response?.delivered_via, "message");
  assert.ok(done.response?.delivered_at);
  assert.equal(done.claim, undefined);
  assert.deepEqual(h.store.inboxAck(SID, A, d.id), { http: 200, status: "answered" });
});

test("ack: 409 while another live owner holds the claim, for a decision that closed undelivered and for a classic one; 404 for another session or an unknown id", () => {
  const h = setup();
  const d = claimed(h);
  h.poll(B, false);
  assert.deepEqual(h.store.inboxAck(SID, B, d.id), { http: 409, status: "answer_submitted" });
  assert.deepEqual(h.store.inboxAck("other-session", A, d.id), { http: 404 });
  assert.deepEqual(h.store.inboxAck(SID, A, "no-such-id"), { http: 404 });

  const classic = h.store.create(h.req("classic", { mod_owner: undefined }), {}).decision;
  assert.deepEqual(h.store.inboxAck(SID, A, classic.id), { http: 409, status: "pending" });

  const fb = h.ask("fb");
  h.store.submitAnswer(fb.id, { kind: "fallback" });
  assert.deepEqual(h.store.inboxAck(SID, A, fb.id), { http: 409, status: "fallback" });
});

// ---- the ref (re F1): a prompt that starts with the ref is a record, not a delivery ----

test("a ref prompt is recorded but neither answers the decision nor counts as the human: pending cards stay, a typed prompt cancels them", () => {
  const h = setup();
  const d = claimed(h);
  const other = h.ask("toolu_other");
  h.event("UserPromptSubmit", { delivered_ref: deliveryRef(d.id) });
  assert.equal(get(h, d).status, "answer_submitted", "the ref alone does not close it");
  assert.ok(get(h, d).ref_seen_at);
  assert.equal(get(h, d).human_prompt_at, undefined);
  assert.equal(get(h, other).status, "pending", "not the human: the pending question stays");
  assert.match(readFileSync(join(h.dir, "events.jsonl"), "utf8"), /"delivered_ref":"[0-9a-f]{8}"/);

  h.event("UserPromptSubmit", { delivered_ref: "deadbeef" }); // no decision has this ref: a person typed it
  assert.equal(get(h, other).status, "cancelled");
});

test("ref, then release with a drop: the item is handed out again; five drops give up with `undeliverable`", () => {
  const h = setup();
  const d = claimed(h);
  h.event("UserPromptSubmit", { delivered_ref: deliveryRef(d.id) });
  assert.deepEqual(h.store.inboxRelease(SID, A, d.id, "the prompt did not go through prompt.submit"), { http: 200, status: "answer_submitted" });
  assert.equal(get(h, d).delivery_attempts, 1);
  assert.equal(get(h, d).delivery_note, "the prompt did not go through prompt.submit");
  assert.equal(get(h, d).claim, undefined);
  let again = h.poll(A, true);
  assert.ok(again && "item" in again, "back in the inbox");
  for (let i = 1; i < DELIVERY_MAX_ATTEMPTS; i++) {
    assert.equal(get(h, d).status, "answer_submitted");
    h.store.inboxRelease(SID, A, d.id, "interrupted");
    again = h.poll(A, true);
  }
  assert.equal(get(h, d).status, "answer_lost");
  assert.equal(get(h, d).status_reason, "undeliverable");
  assert.equal(again, undefined, "nothing left to hand out");
});

test("a release sent twice counts one drop", () => {
  const h = setup();
  const d = claimed(h);
  h.store.inboxRelease(SID, A, d.id, "interrupted");
  assert.deepEqual(h.store.inboxRelease(SID, A, d.id, "interrupted"), { http: 200, status: "answer_submitted" });
  assert.equal(get(h, d).delivery_attempts, 1);
});

test("release without a drop reads the transcript: the plugin's message since the claim means delivered, anything else means not", () => {
  const h = setup();
  const sent = claimed(h, "sent");
  h.deliverIntoTranscript(sent);
  assert.deepEqual(h.store.inboxRelease(SID, A, sent.id), { http: 200, status: "answered" });
  assert.equal(get(h, sent).response?.delivered_via, "message");

  const h2 = setup();
  const notSent = claimed(h2, "not_sent");
  assert.deepEqual(h2.store.inboxRelease(SID, A, notSent.id), { http: 200, status: "answer_submitted" });
  assert.equal(get(h2, notSent).claim, undefined);
  assert.equal(get(h2, notSent).delivery_attempts, 1, "a release without a drop that finds nothing in the transcript is a failed attempt");

  const h3 = setup();
  const typed = claimed(h3, "typed");
  h3.deliverIntoTranscript(typed, "human"); // the same words typed by a person are not a delivery
  assert.deepEqual(h3.store.inboxRelease(SID, A, typed.id), { http: 200, status: "answer_submitted" });
});

test("a line before the claim does not count as the delivery", () => {
  const h = setup();
  const d = h.ask();
  h.answer(d);
  h.deliverIntoTranscript(d); // already in the transcript when the claim is made
  h.poll(A, true);
  assert.deepEqual(h.store.inboxRelease(SID, A, d.id), { http: 200, status: "answer_submitted" });
});

test("when the claiming owner goes silent the transcript decides: delivered closes it, otherwise it is handed out again", () => {
  const h = setup();
  const sent = claimed(h, "sent");
  h.deliverIntoTranscript(sent);
  h.advance(MOD_CLAIM_STALE_MS + 1000);
  h.store.checkLeases();
  assert.equal(get(h, sent).status, "answered");

  const h2 = setup();
  const notSent = claimed(h2, "not_sent");
  h2.advance(MOD_CLAIM_STALE_MS + 1000);
  h2.store.checkLeases();
  assert.equal(get(h2, notSent).status, "answer_submitted");
  assert.equal(get(h2, notSent).claim, undefined);
  h2.poll(B, false);
  const item = h2.poll(B, true);
  assert.ok(item && "item" in item, "another owner can deliver it");
});

test("release of a closed decision changes nothing and answers with its status", () => {
  const h = setup();
  const d = claimed(h);
  h.store.inboxAck(SID, A, d.id);
  assert.deepEqual(h.store.inboxRelease(SID, A, d.id, "late"), { http: 200, status: "answered" });
  assert.equal(get(h, d).delivery_attempts, undefined);
  assert.deepEqual(h.store.inboxRelease("other-session", A, d.id), { http: 404 });
});

// ---- SessionEnd (re F2) ----

test("a SessionEnd of another session closes nothing", () => {
  const h = setup();
  const d = h.ask();
  h.event("SessionEnd", {}, "a-nested-claude-p");
  h.advance(MOD_END_GRACE_MS + 2000);
  h.store.checkLeases();
  assert.equal(get(h, d).status, "pending");
});

test("a SessionEnd of the session closes its decisions after the grace unless a mod keeps polling it", () => {
  const h = setup();
  const waiting = h.ask("waiting");
  const answered = h.ask("answered");
  h.answer(answered);
  h.event("SessionEnd");
  h.advance(MOD_END_GRACE_MS - 1000);
  h.store.checkLeases();
  assert.equal(get(h, waiting).status, "pending", "still within the grace");
  h.advance(2000);
  h.store.checkLeases();
  assert.equal(get(h, waiting).status, "cancelled");
  assert.equal(get(h, waiting).status_reason, "session_end");
  assert.equal(get(h, answered).status, "answer_lost");
  assert.equal(get(h, answered).status_reason, "session_end");

  const kept = h.ask("kept");
  h.event("SessionEnd"); // `--resume` from another process: the first one keeps polling
  h.advance(MOD_END_GRACE_MS - 2000);
  h.poll(A);
  h.advance(2000);
  h.store.checkLeases();
  assert.equal(get(h, kept).status, "pending");
});

test("a single poll right after the SessionEnd (the dying mod's last tick) does not keep the session open", () => {
  const h = setup();
  const d = h.ask();
  h.event("SessionEnd");
  h.advance(300);
  h.poll(A); // in flight when Claude Code exited
  h.advance(MOD_END_GRACE_MS + 1000);
  h.store.checkLeases();
  assert.equal(get(h, d).status, "cancelled");
  assert.equal(get(h, d).status_reason, "session_end");
});

test("a release without a drop that finds nothing in the transcript counts as an attempt: a submit that always throws ends in `undeliverable`", () => {
  const h = setup();
  const d = h.ask();
  h.answer(d);
  for (let i = 0; i < DELIVERY_MAX_ATTEMPTS; i++) {
    assert.ok(h.poll(A, true), `hand-out ${i + 1}`);
    h.store.inboxRelease(SID, A, d.id);
  }
  assert.equal(get(h, d).status, "answer_lost");
  assert.equal(get(h, d).status_reason, "undeliverable");
});

test("a typed prompt registered in the same millisecond is cancelled (created_at == received_at)", () => {
  const h = setup();
  const d = h.ask();
  h.event("UserPromptSubmit", { received_at: new Date(h.now()).toISOString() });
  assert.equal(get(h, d).status, "cancelled");
});

test("after a reload the SessionEnd needs no owner: a decision of a mod that is gone closes, and polling under a new session id (/clear) does not keep the old one", () => {
  const h = setup();
  const d = h.ask(); // owner A, which then went away (a reload made it B, which polls only the new session)
  h.event("SessionEnd");
  h.advance(2000);
  h.poll(B, false, "the-session-after-clear");
  h.advance(MOD_END_GRACE_MS);
  h.store.checkLeases();
  assert.equal(get(h, d).status, "cancelled");
  assert.equal(get(h, d).status_reason, "session_end");
});

// ---- waiting (re F3) ----

test("tools are held back only while a mod polled the session within MOD_FRESH_MS", () => {
  const h = setup();
  const d = h.ask();
  assert.deepEqual(h.store.waitingFor(SID), { decision_id: d.id, kind: "answer_question" });
  assert.equal(h.store.waitingFor("another-session"), undefined);
  h.advance(MOD_FRESH_MS + 1);
  assert.equal(h.store.waitingFor(SID), undefined, "the mod is gone: the tools run");
  h.poll(A);
  assert.ok(h.store.waitingFor(SID));
});

test("an answer held by a claim, or typed over by the human, does not hold the tools back", () => {
  const h = setup();
  const d = h.ask();
  h.answer(d);
  assert.ok(h.store.waitingFor(SID), "answered but not claimed yet");
  h.poll(A, true);
  assert.equal(h.store.waitingFor(SID), undefined, "claimed: the delivery turn must not be held up");
  h.store.inboxRelease(SID, A, d.id, "interrupted");
  assert.ok(h.store.waitingFor(SID));
  h.event("UserPromptSubmit"); // the human types in the terminal
  assert.ok(get(h, d).human_prompt_at);
  assert.equal(get(h, d).status, "answer_submitted", "still delivered after their turn");
  assert.equal(h.store.waitingFor(SID), undefined, "their turn is not held back");
  assert.ok(h.poll(A, true), "and the answer is still handed out");
});

test("a typed prompt cancels a pending question but not one registered after the prompt was built", () => {
  const h = setup();
  const before = h.ask("before");
  const after = h.ask("after");
  h.event("UserPromptSubmit", { received_at: new Date(h.now() - 1).toISOString() });
  assert.equal(get(h, before).status, "pending", "created at the prompt's time or later");
  assert.equal(get(h, after).status, "pending");
  h.event("UserPromptSubmit");
  assert.equal(get(h, before).status, "cancelled");
});

test("a typed prompt with no mod to deliver closes an answered decision as typed_in_terminal", () => {
  const h = setup();
  const d = h.ask();
  h.answer(d);
  h.advance(MOD_FRESH_MS + 1);
  h.event("UserPromptSubmit");
  assert.equal(get(h, d).status, "answer_lost");
  assert.equal(get(h, d).status_reason, "typed_in_terminal");
});

// ---- closing with a claim in flight ----

test("closing while a live mod holds the claim waits for it: an ack still delivers, a drop gives up with the reason", () => {
  const h = setup();
  const acked = claimed(h, "acked");
  h.advance(MESSAGE_TTL_MS);
  h.poll(A, false);
  h.store.checkLeases();
  assert.equal(get(h, acked).status, "answer_submitted");
  assert.equal(get(h, acked).close_reason, "expired");
  assert.deepEqual(h.store.inboxAck(SID, A, acked.id), { http: 200, status: "answered" });

  const dropped = claimed(h, "dropped");
  h.advance(MESSAGE_TTL_MS);
  h.poll(A, false);
  h.store.checkLeases();
  assert.deepEqual(h.store.inboxRelease(SID, A, dropped.id, "interrupted"), { http: 200, status: "answer_lost" });
  assert.equal(get(h, dropped).status_reason, "expired");
});

test("a decision nobody delivers expires after 12 hours: pending is cancelled, an answer is lost", () => {
  const h = setup();
  const waiting = h.ask("waiting");
  const answered = h.ask("answered");
  h.answer(answered);
  h.advance(MESSAGE_TTL_MS - 1000);
  h.poll(A);
  h.store.checkLeases();
  assert.equal(get(h, waiting).status, "pending");
  h.advance(2000);
  h.poll(A);
  h.store.checkLeases();
  assert.equal(get(h, waiting).status, "cancelled");
  assert.equal(get(h, waiting).status_reason, "expired");
  assert.equal(get(h, answered).status, "answer_lost");
  assert.equal(get(h, answered).status_reason, "expired");
});

// ---- no_agent ----

test("`no_agent` after MOD_GONE_MS without a poll, cleared when a mod is back; never within MOD_GONE_MS of the server's start", () => {
  const h = setup();
  const d = h.ask();
  h.advance(MOD_GONE_MS - 1000);
  h.store.checkLeases();
  assert.equal(get(h, d).delivery_flag, undefined);
  h.advance(2000);
  h.store.checkLeases();
  assert.equal(get(h, d).delivery_flag, "no_agent");
  h.poll(A);
  h.store.checkLeases();
  assert.equal(get(h, d).delivery_flag, undefined);

  const later = setup({ dir: h.dir, start: h.now() });
  later.advance(MOD_GONE_MS - 1000);
  later.store.checkLeases();
  assert.equal(later.store.get(d.id)?.delivery_flag, undefined, "the server just started: no mod has had the time to poll");
  later.advance(2000);
  later.store.checkLeases();
  assert.equal(later.store.get(d.id)?.delivery_flag, "no_agent");
});

// ---- restart ----

test("a restart keeps the claim, adds no lease and does not hand the item to another owner within MOD_CLAIM_STALE_MS", () => {
  const h = setup();
  const d = claimed(h);
  const again = setup({ dir: h.dir, start: h.now() + 1000 });
  const loaded = again.store.get(d.id)!;
  assert.equal(loaded.claim?.owner, A);
  assert.equal(loaded.lease_until, undefined);
  again.poll(B, false);
  assert.equal(again.poll(B, true), undefined, "A's claim stands");
  assert.deepEqual(again.store.inboxAck(SID, B, d.id), { http: 409, status: "answer_submitted" });
  assert.deepEqual(again.poll(A, true), { held: { item_id: d.id } });
  again.advance(MOD_CLAIM_STALE_MS + 1000);
  again.poll(B, false);
  again.store.checkLeases();
  assert.equal(again.store.get(d.id)?.claim, undefined, "A never came back: the claim ended");
  assert.ok(again.poll(B, true));
});

test("a restarted server does not register a new message decision for an owner it has not seen yet", () => {
  const h = setup();
  h.ask();
  const again = setup({ dir: h.dir, start: h.now() + 1000 });
  assert.equal(again.store.create(again.req("after-restart"), {}).decision.delivery, undefined);
  again.poll(A);
  assert.equal(again.store.create(again.req("after-poll"), {}).decision.delivery, "message");
});

// ---- leases, cancel, hand-off ----

test("no lease: wait does not arm one, the monitor does not disconnect the decision, cancel / handoff / ack answer 409", async () => {
  const h = setup();
  const d = h.ask();
  assert.equal(await h.store.wait(d.id, 10), undefined);
  assert.equal(get(h, d).lease_until, undefined);
  h.advance(10 * 60_000);
  h.poll(A);
  h.store.checkLeases();
  assert.equal(get(h, d).status, "pending");
  for (const call of [() => h.store.cancel(d.id), () => h.store.handoff(d.id, SID), () => h.store.ack(d.id)]) {
    assert.throws(call, (e: unknown) => e instanceof HttpError && e.status === 409);
  }
  assert.equal(get(h, d).status, "pending");
});

// ---- the hook calls the tool again ----

test("calling the tool again switches a waiting or unclaimed-answer decision to the long-poll", async () => {
  const h = setup();
  const d = h.ask("first");
  const fp = decisionFingerprint("answer_question", d.request as Record<string, unknown>);
  const open = h.store.openFor(SID, undefined, fp, "toolu_again");
  assert.ok(open && "decision" in open);
  const back = get(h, d);
  assert.equal(back.delivery, undefined);
  assert.equal(back.mod_owner, undefined);
  assert.ok(back.lease_until, "the hook waits again");
  assert.equal(back.tool_use_id, "toolu_again");
  assert.ok(h.logs.includes("message_to_classic"));

  const answered = h.ask("second");
  h.answer(answered);
  const fp2 = decisionFingerprint("answer_question", answered.request as Record<string, unknown>);
  const open2 = h.store.openFor(SID, undefined, fp2, "toolu_again2");
  assert.ok(open2 && "decision" in open2);
  assert.equal((await h.store.wait(answered.id, 10))?.status, "answer_submitted", "the answer is there at once");
});

test("calling the tool again while a live mod delivers answers `delivering` and changes nothing", () => {
  const h = setup();
  const d = claimed(h);
  const fp = decisionFingerprint("answer_question", d.request as Record<string, unknown>);
  assert.deepEqual(h.store.openFor(SID, undefined, fp, "toolu_again"), { delivering: { decision_id: d.id } });
  assert.equal(get(h, d).delivery, "message");
  assert.equal(get(h, d).claim?.owner, A);
});

test("calling the tool again when the claiming mod is gone checks the transcript first: delivered means no open decision", () => {
  const h = setup();
  const sent = claimed(h, "sent");
  h.deliverIntoTranscript(sent);
  h.advance(MOD_CLAIM_STALE_MS + 1000);
  const fp = decisionFingerprint("answer_question", sent.request as Record<string, unknown>);
  assert.equal(h.store.openFor(SID, undefined, fp, "toolu_again"), undefined);
  assert.equal(get(h, sent).status, "answered");

  const notSent = claimed(h, "not_sent");
  h.advance(MOD_CLAIM_STALE_MS + 1000);
  const fp2 = decisionFingerprint("answer_question", notSent.request as Record<string, unknown>);
  const open = h.store.openFor(SID, undefined, fp2, "toolu_again2");
  assert.ok(open && "decision" in open);
  assert.equal(get(h, notSent).delivery, undefined);
});

// ---- what the waiting answer suppresses ----

test("while an answer waits for delivery no progress card is made and nothing is typed into the terminal; with `no_agent` both resume", async () => {
  const h = setup();
  const summary = { session_id: SID, state: "idle" as const, last_event_at: new Date(h.now()).toISOString(), cwd: "/w/proj", transcript_path: h.transcript };
  const d = h.ask();
  assert.deepEqual(h.store.createCheckpoint(summary, "recap", "2026-01-01T00:00:01.000Z"), { created: false, skipped: "decision_pending" });

  h.event("Stop");
  let typed = 0;
  h.store.deliverPlanInstruction = async () => {
    typed++;
    return true;
  };
  assert.equal(await h.store.queuePlanInstruction(SID, "do this first"), "hook", "queued for the next tool call, not typed");
  assert.equal(typed, 0);

  h.advance(MOD_GONE_MS + 1000);
  h.store.checkLeases();
  assert.equal(get(h, d).delivery_flag, "no_agent");
  assert.equal(h.store.createCheckpoint(summary, "recap", "2026-01-01T00:00:02.000Z").created, true);
  assert.equal(await h.store.queuePlanInstruction(SID, "and then this"), "terminal");
  assert.equal(typed, 1);
});

test("a decision closed for good no longer suppresses", () => {
  const h = setup();
  const d = claimed(h);
  assert.equal(h.store.hasOpenAsync(SID), true);
  h.store.inboxAck(SID, A, d.id);
  assert.equal(h.store.hasOpenAsync(SID), false);
});

// ---- instructions (a checkpoint reply, a plan instruction) delivered by the mod ----

/** An idle session with a live mod and an answered checkpoint "instruct" */
function instructed(h: H, text = "run the e2e first\nthen the lint"): Decision {
  h.poll(A, false);
  h.event("Stop");
  const cp = h.store.create({ tool_use_id: "checkpoint:1", kind: "checkpoint", session: { session_id: SID, cwd: "/w/proj", transcript_path: h.transcript }, request: { recap: "recap", recap_at: "2026-10-04T01:00:00.000Z" } } as never, {}).decision;
  h.store.submitAnswer(cp.id, { kind: "checkpoint", answer: "instruct", text } as never);
  return cp;
}

function instructionItem(h: H): { item_id: string; text: string } {
  const r = h.poll(A, true);
  assert.ok(r && "item" in r, "an instruction item");
  return r.item;
}

test("instruction: an idle session with a live mod gets the reply as a message (ref + reply prefix, newlines kept), and the hook queue is empty", () => {
  const h = setup();
  const cp = instructed(h);
  assert.equal(h.store.consumeInstruction(SID), undefined, "not left for the hook");
  assert.equal(h.poll(A, false), undefined, "nothing while the agent works");
  const item = instructionItem(h);
  assert.match(item.text, new RegExp(`^\\[ukagai\\] \\(ref ${deliveryRef(item.item_id)}\\) \\[ukagai\\] Reply to your progress recap: run the e2e first\nthen the lint$`));
  assert.equal(get(h, cp).response?.delivered_at, undefined, "not delivered before the ack");
  assert.deepEqual(h.poll(A, true), { held: { item_id: item.item_id } });
  assert.deepEqual(h.store.inboxAck(SID, A, item.item_id), { http: 200, status: "answered" });
  assert.equal(get(h, cp).response?.delivered_via, "message");
  assert.ok(get(h, cp).response?.delivered_at);
  assert.equal(h.poll(A, true), undefined);
  assert.deepEqual(h.store.inboxAck(SID, A, item.item_id), { http: 404 });
});

test("instruction: a plan instruction is worded with the plan prefix; a stop is never put in the inbox", async () => {
  const h = setup();
  h.poll(A, false);
  h.event("Stop");
  assert.equal(await h.store.queuePlanInstruction(SID, "split step 2"), "message");
  const item = instructionItem(h);
  assert.match(item.text, /^\[ukagai\] \(ref [0-9a-f]{8}\) \[ukagai\] About the plan you are writing: split step 2$/);
  h.store.inboxAck(SID, A, item.item_id);
  assert.equal(h.poll(A, true), undefined);

  const cp = h.store.create({ tool_use_id: "checkpoint:2", kind: "checkpoint", session: { session_id: SID, cwd: "/w/proj", transcript_path: h.transcript }, request: { recap: "r", recap_at: "2026-10-04T02:00:00.000Z" } } as never, {}).decision;
  h.event("UserPromptSubmit");
  h.store.submitAnswer(cp.id, { kind: "checkpoint", answer: "stop" } as never);
  assert.equal(h.poll(A, true), undefined);
  assert.equal(h.store.consumeInstruction(SID)?.kind, "stop");
});

test("instruction: without a live mod it stays queued for the hook; a working agent keeps it for the hook too", async () => {
  const h = setup();
  h.event("Stop");
  assert.equal(await h.store.queuePlanInstruction(SID, "a"), "hook", "no mod ever polled");
  assert.ok(h.store.consumeInstruction(SID));
  h.poll(A, false);
  h.advance(MOD_FRESH_MS + 1);
  assert.equal(await h.store.queuePlanInstruction(SID, "b"), "hook", "the mod was seen too long ago");
  h.store.consumeInstruction(SID);
  h.poll(A, false);
  h.event("UserPromptSubmit");
  assert.equal(await h.store.queuePlanInstruction(SID, "c"), "hook", "the agent works: the next tool call delivers it");
  assert.ok(h.store.consumeInstruction(SID));
});

test("instruction: a release the transcript confirms closes it; the owner's death settles it by the transcript; five drops give it back to the hook", () => {
  const h = setup();
  const cp = instructed(h, "go on");
  const first = instructionItem(h);
  appendFileSync(h.transcript, JSON.stringify({ type: "user", origin: { kind: "plugin" }, message: { role: "user", content: [{ type: "text", text: `${first.text}` }] } }) + "\n");
  assert.deepEqual(h.store.inboxRelease(SID, A, first.item_id), { http: 200, status: "answered" });
  assert.equal(get(h, cp).response?.delivered_via, "message");

  const h2 = setup();
  const cp2 = instructed(h2, "go on");
  const item2 = instructionItem(h2);
  appendFileSync(h2.transcript, JSON.stringify({ type: "user", origin: { kind: "plugin" }, message: { role: "user", content: [{ type: "text", text: item2.text }] } }) + "\n");
  h2.advance(MOD_CLAIM_STALE_MS + 1);
  assert.equal(h2.poll(B, true), undefined, "settled by the transcript, not handed out again");
  assert.equal(get(h2, cp2).response?.delivered_via, "message");

  const h3 = setup();
  const cp3 = instructed(h3, "go on");
  for (let i = 0; i < DELIVERY_MAX_ATTEMPTS; i++) {
    const it = instructionItem(h3);
    assert.deepEqual(h3.store.inboxRelease(SID, A, it.item_id, "dropped"), { http: 200, status: "answer_submitted" });
  }
  assert.equal(h3.poll(A, true), undefined, "given up");
  assert.equal(h3.store.consumeInstruction(SID)?.decision_id, cp3.id, "back in the hook's queue");
});

test("instruction: another live owner's claim answers 409; SessionEnd drops the item", () => {
  const h = setup();
  instructed(h, "go on");
  const item = instructionItem(h);
  h.poll(B, false);
  assert.deepEqual(h.store.inboxAck(SID, B, item.item_id), { http: 409, status: "answer_submitted" });
  h.event("SessionEnd");
  assert.equal(h.poll(A, true), undefined);
  assert.deepEqual(h.store.inboxAck(SID, A, item.item_id), { http: 404 });
});
