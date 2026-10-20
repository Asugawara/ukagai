import { after, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decisionFingerprint, deliveryRef, DEFAULT_CLAUDE_SETTINGS, DEFAULT_SETTINGS } from "../../src/contract.js";
import { start, type ServeHandle } from "../../src/serve/index.js";

const tmpRoots: string[] = [];
const handles: ServeHandle[] = [];

after(async () => {
  for (const h of handles) await h.close();
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "ukagai-inbox-api-"));
  tmpRoots.push(d);
  return d;
}

const OWNER = "0123456789abcdef";
const OTHER = "fedcba9876543210";
const SID = "sess-1";

type Env = { h: ServeHandle; home: string; dataDir: string; url: string; transcript: string };

async function setup(): Promise<Env> {
  const home = tmp();
  const dataDir = tmp();
  const h = await start({ port: 0, dataDir, home });
  handles.push(h);
  const transcript = join(home, ".claude", "projects", "p", `${SID}.jsonl`);
  mkdirSync(join(home, ".claude", "projects", "p"), { recursive: true });
  writeFileSync(transcript, "");
  return { h, home, dataDir, url: `http://127.0.0.1:${h.port}`, transcript };
}

function api(env: Env, path: string, init: { method?: string; body?: unknown; auth?: boolean; contentType?: string | null } = {}) {
  const headers: Record<string, string> = {};
  if (init.auth !== false) headers.authorization = `Bearer ${env.h.token}`;
  if (init.contentType !== null) headers["content-type"] = init.contentType ?? "application/json";
  return fetch(env.url + path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

const inbox = (env: Env, what: "poll" | "ack" | "release", body: unknown, session = SID) => api(env, `/api/sessions/${session}/inbox/${what}`, { body });

const QUESTION = "Which database should the cache use?";
const questionRequest = {
  questions: [{ question: QUESTION, header: "DB", options: [{ label: "Redis" }, { label: "Memcached" }], multiSelect: false }],
};

function decisionBody(env: Env, toolUseId: string, extra: Record<string, unknown> = {}) {
  return {
    tool_use_id: toolUseId,
    kind: "answer_question",
    session: { session_id: SID, cwd: "/nonexistent-ukagai-cwd", transcript_path: env.transcript },
    request: questionRequest,
    ...extra,
  };
}

async function register(env: Env, toolUseId: string, extra: Record<string, unknown> = {}) {
  const r = await api(env, "/api/decisions", { body: decisionBody(env, toolUseId, extra) });
  assert.ok(r.status === 200 || r.status === 201, `register status ${r.status}`);
  return (await r.json()) as { id: string; status: string; delivery?: string; lease_until?: string; [k: string]: any };
}

async function getDecision(env: Env, id: string) {
  return (await (await api(env, `/api/decisions/${id}`)).json()) as { status: string; delivery?: string; response?: any; claim?: any; ref_seen_at?: string; lease_until?: string; delivery_attempts?: number };
}

const answer = (env: Env, id: string) => api(env, `/api/decisions/${id}/answer`, { body: { answers: { [QUESTION]: "Redis" } } });

async function asyncDecision(env: Env, toolUseId = "toolu_1") {
  assert.equal((await inbox(env, "poll", { owner: OWNER, idle: false })).status, 204);
  const d = await register(env, toolUseId, { mod_owner: OWNER });
  assert.equal(d.delivery, "message");
  return d;
}

// ---- the three inbox endpoints ----

test("inbox: bearer token only, JSON only, a 16-hex owner and a boolean idle", async () => {
  const env = await setup();
  const ok = { owner: OWNER, idle: false };
  assert.equal((await api(env, `/api/sessions/${SID}/inbox/poll`, { body: ok, auth: false })).status, 401);
  assert.equal((await api(env, `/api/sessions/${SID}/inbox/poll`, { body: ok, contentType: "text/plain" })).status, 415);
  assert.equal((await inbox(env, "poll", { owner: "not-hex", idle: false })).status, 400);
  assert.equal((await inbox(env, "poll", { owner: OWNER.toUpperCase(), idle: false })).status, 400);
  assert.equal((await inbox(env, "poll", { owner: OWNER, idle: "yes" })).status, 400);
  assert.equal((await inbox(env, "ack", { owner: OWNER })).status, 400);
  assert.equal((await inbox(env, "ack", { owner: OWNER, item_id: "" })).status, 400);
  assert.equal((await inbox(env, "release", { owner: OWNER, item_id: "x", drop: "" })).status, 400);
  assert.equal((await inbox(env, "release", { owner: OWNER, item_id: "x", drop: "y".repeat(501) })).status, 400);
  assert.equal((await inbox(env, "poll", ok)).status, 204);
  const item = { owner: OWNER, item_id: "x" };
  for (const what of ["ack", "release"]) {
    assert.equal((await api(env, `/api/sessions/${SID}/inbox/${what}`, { body: item, auth: false })).status, 401, what);
    assert.equal((await api(env, `/api/sessions/${SID}/inbox/${what}`, { body: item, contentType: "text/plain" })).status, 415, what);
  }
});

test("message delivery end to end: register -> answer -> poll(item) -> ref event -> ack (twice) -> answered", async () => {
  const env = await setup();
  const d = await asyncDecision(env);
  assert.equal(d.status, "pending");
  assert.equal(d.lease_until, undefined);

  assert.equal((await inbox(env, "poll", { owner: OWNER, idle: true })).status, 204, "nothing answered yet");
  assert.equal((await answer(env, d.id)).status, 200);
  assert.equal((await inbox(env, "poll", { owner: OWNER, idle: false })).status, 204, "not idle");

  const p = await inbox(env, "poll", { owner: OWNER, idle: true });
  assert.equal(p.status, 200);
  const item = ((await p.json()) as { item: { item_id: string; text: string } }).item;
  assert.equal(item.item_id, d.id);
  assert.equal(item.text, `[ukagai] (ref ${deliveryRef(d.id)}) The human answered your question in the ukagai GUI:\n- ${JSON.stringify(QUESTION)}: "Redis"`);

  const held = await inbox(env, "poll", { owner: OWNER, idle: true });
  assert.deepEqual(await held.json(), { held: { item_id: d.id } });

  // the hook saw the prompt: a record only
  const ev = await api(env, "/api/events", {
    body: { session_id: SID, transcript_path: env.transcript, cwd: "/w", hook_event_name: "UserPromptSubmit", received_at: new Date().toISOString(), delivered_ref: deliveryRef(d.id) },
  });
  assert.equal(ev.status, 204);
  const mid = await getDecision(env, d.id);
  assert.equal(mid.status, "answer_submitted");
  assert.ok(mid.ref_seen_at);

  const ack = await inbox(env, "ack", { owner: OWNER, item_id: d.id });
  assert.equal(ack.status, 200);
  assert.deepEqual(await ack.json(), { status: "answered" });
  assert.equal((await inbox(env, "ack", { owner: OWNER, item_id: d.id })).status, 200);
  const done = await getDecision(env, d.id);
  assert.equal(done.status, "answered");
  assert.equal(done.response.delivered_via, "message");
});

test("a dropped delivery: release with a drop puts the item back; ack and release answer 404 for an unknown item and 409 for a classic decision", async () => {
  const env = await setup();
  const d = await asyncDecision(env);
  await answer(env, d.id);
  await inbox(env, "poll", { owner: OWNER, idle: true });
  const rel = await inbox(env, "release", { owner: OWNER, item_id: d.id, drop: "the turn was interrupted while the prompt was checked" });
  assert.deepEqual(await rel.json(), { status: "answer_submitted" });
  const dec = await getDecision(env, d.id);
  assert.equal(dec.delivery_attempts, 1);
  assert.equal(dec.claim, undefined);
  const again = await inbox(env, "poll", { owner: OWNER, idle: true });
  assert.equal(again.status, 200);

  assert.equal((await inbox(env, "ack", { owner: OWNER, item_id: "no-such-item" })).status, 404);
  assert.equal((await inbox(env, "release", { owner: OWNER, item_id: d.id }, "another-session")).status, 404);
  const classic = await register(env, "toolu_classic", { request: { questions: [{ ...questionRequest.questions[0], question: "A classic one?" }] } });
  assert.equal(classic.delivery, undefined);
  const r409 = await inbox(env, "ack", { owner: OWNER, item_id: classic.id });
  assert.equal(r409.status, 409);
  assert.deepEqual(await r409.json(), { status: "pending" });
});

// ---- registration ----

test("a decision gets `delivery: message` only for an owner that polled the session; the toggle and a malformed owner keep the long-poll", async () => {
  const env = await setup();
  const unseen = await register(env, "toolu_unseen", { mod_owner: OTHER });
  assert.equal(unseen.delivery, undefined);
  assert.ok(unseen.lease_until, "a hook waits for this one");

  await inbox(env, "poll", { owner: OWNER, idle: false });
  const sub = await register(env, "toolu_sub", { mod_owner: OWNER, request: { questions: [{ ...questionRequest.questions[0], question: "From a subagent?" }] }, session: { session_id: SID, cwd: "/w", transcript_path: env.transcript, agent_id: "sub-1" } });
  assert.equal(sub.delivery, undefined);
  const bad = await register(env, "toolu_bad", { mod_owner: "ZZ", request: { questions: [{ ...questionRequest.questions[0], question: "Malformed owner?" }] } });
  assert.equal(bad.delivery, undefined);

  const settings = (await (await api(env, "/api/settings")).json()) as typeof DEFAULT_SETTINGS;
  assert.deepEqual(settings.claude, DEFAULT_CLAUDE_SETTINGS);
  assert.equal(DEFAULT_CLAUDE_SETTINGS.message_delivery, true);
  const off = await api(env, "/api/settings", { method: "PUT", body: { ...settings, claude: { message_delivery: false } } });
  assert.equal(off.status, 200);
  const withToggleOff = await register(env, "toolu_off", { mod_owner: OWNER, request: { questions: [{ ...questionRequest.questions[0], question: "Toggle off?" }] } });
  assert.equal(withToggleOff.delivery, undefined, "the setting applies without a restart");
});

test("settings: a PUT without the `claude` group keeps the default, and a missing group in config.json reads as the default", async () => {
  const env = await setup();
  const settings = (await (await api(env, "/api/settings")).json()) as Record<string, unknown>;
  const { claude: _claude, ...withoutClaude } = settings;
  const put = await api(env, "/api/settings", { method: "PUT", body: withoutClaude });
  assert.equal(put.status, 200);
  assert.deepEqual(((await put.json()) as { claude: unknown }).claude, DEFAULT_CLAUDE_SETTINGS);
});

// ---- the hook calls the tool again ----

test("GET /open: a waiting decision switches to the long-poll (200 decision), a decision being delivered answers `delivering`, nothing open is 404", async () => {
  const env = await setup();
  const d = await asyncDecision(env);
  const fp = decisionFingerprint("answer_question", questionRequest);
  const q = (tool: string) => `/api/sessions/${SID}/open?fingerprint=${fp}&tool_use_id=${tool}`;

  await answer(env, d.id);
  await inbox(env, "poll", { owner: OWNER, idle: true }); // claimed
  const delivering = await api(env, q("toolu_2"));
  assert.equal(delivering.status, 200);
  assert.deepEqual(await delivering.json(), { delivering: { decision_id: d.id } });
  assert.equal((await getDecision(env, d.id)).delivery, "message", "left alone");

  await inbox(env, "release", { owner: OWNER, item_id: d.id, drop: "interrupted" });
  const open = await api(env, q("toolu_3"));
  assert.equal(open.status, 200);
  const body = (await open.json()) as { decision: { id: string; delivery?: string; tool_use_id: string; lease_until?: string } };
  assert.equal(body.decision.id, d.id);
  assert.equal(body.decision.delivery, undefined);
  assert.equal(body.decision.tool_use_id, "toolu_3");
  assert.ok(body.decision.lease_until);
  const w = await api(env, `/api/decisions/${d.id}/wait?timeout_ms=100`);
  assert.equal(w.status, 200, "the answer is there at once");

  assert.equal((await api(env, `/api/sessions/${SID}/open?fingerprint=nope&tool_use_id=t`)).status, 404);
});

test("hook cancel and hand-off cannot close a message-delivery decision", async () => {
  const env = await setup();
  const d = await asyncDecision(env);
  assert.equal((await api(env, `/api/decisions/${d.id}/cancel`, { body: {} })).status, 409);
  assert.equal((await api(env, `/api/decisions/${d.id}/handoff`, { body: { session_id: SID } })).status, 409);
  assert.equal((await getDecision(env, d.id)).status, "pending");
  const fb = await api(env, `/api/decisions/${d.id}/answer`, { body: { fallback: true } });
  assert.equal(fb.status, 200);
  assert.equal(((await fb.json()) as { status: string }).status, "fallback", "the human can still choose the terminal");
});

// ---- instruction / waiting ----

test("instruction?main=1 answers `waiting` while a live mod owes an answer, and a checkpoint reply wins over it", async () => {
  const env = await setup();
  const none = await api(env, `/api/sessions/${SID}/instruction?main=1`);
  assert.equal(none.status, 404);
  const d = await asyncDecision(env);
  assert.equal((await api(env, `/api/sessions/${SID}/instruction`)).status, 404, "a subagent (no main=1) is never held back");
  const w = await api(env, `/api/sessions/${SID}/instruction?main=1`);
  assert.equal(w.status, 200);
  assert.deepEqual(await w.json(), { waiting: { decision_id: d.id, kind: "answer_question" } });
  assert.equal((await api(env, `/api/sessions/${SID}/instruction?main=1`)).status, 200, "waiting is not consumed");

  const cp = await api(env, "/api/decisions", {
    body: { tool_use_id: "cp-1", kind: "checkpoint", session: { session_id: SID, cwd: "/w", transcript_path: env.transcript }, request: { recap: "doing things", recap_at: "2026-01-01T00:00:00.000Z" } },
  });
  const cpId = ((await cp.json()) as { id: string }).id;
  await api(env, `/api/decisions/${cpId}/answer`, { body: { kind: "instruct", text: "please also run the tests" } });
  const ins = await api(env, `/api/sessions/${SID}/instruction?main=1`);
  const body = (await ins.json()) as { instruction?: { text: string }; waiting?: unknown };
  assert.equal(body.instruction?.text, "please also run the tests");
  assert.equal(body.waiting, undefined);
  assert.deepEqual(await (await api(env, `/api/sessions/${SID}/instruction?main=1`)).json(), { waiting: { decision_id: d.id, kind: "answer_question" } }, "then waiting again");
});

// ---- a typed prompt (m8) ----

test("a typed prompt cancels the pending message decision of its turn but not one registered after the prompt was built", async () => {
  const env = await setup();
  const d = await asyncDecision(env, "toolu_old");
  const built = new Date(Date.now() - 60_000).toISOString(); // an event that reaches the server late
  await inbox(env, "poll", { owner: OWNER, idle: false });
  const newer = await register(env, "toolu_new", { mod_owner: OWNER, request: { questions: [{ ...questionRequest.questions[0], question: "Asked after the prompt?" }] } });
  const ev = (received_at: string) => api(env, "/api/events", { body: { session_id: SID, transcript_path: env.transcript, cwd: "/w", hook_event_name: "UserPromptSubmit", received_at } });
  await ev(built);
  assert.equal((await getDecision(env, d.id)).status, "pending", "created after the prompt was built");
  assert.equal((await getDecision(env, newer.id)).status, "pending");
  appendFileSync(env.transcript, "");
  await ev(new Date(Date.now() + 1000).toISOString());
  assert.equal((await getDecision(env, d.id)).status, "cancelled");
});

test("poll for a session the server has never heard of is 204 (never 404) and still counts as seen: the first poll comes before any decision", async () => {
  const env = await setup();
  const fresh = "brand-new-session";
  assert.equal((await inbox(env, "poll", { owner: OWNER, idle: true }, fresh)).status, 204);
  const r = await api(env, "/api/decisions", { body: { ...decisionBody(env, "toolu_fresh", { mod_owner: OWNER }), session: { session_id: fresh, cwd: "/w", transcript_path: env.transcript } } });
  assert.equal(((await r.json()) as { delivery?: string }).delivery, "message", "the poll made the owner seen on that session");
  // ack / release 404 only when the session has no such id
  assert.equal((await inbox(env, "ack", { owner: OWNER, item_id: "nope" }, fresh)).status, 404);
});
