/**
 * The mod against the real server (plan 2.3.5): a wrong path, body or response shape on either side fails here.
 * It needs the server side of the async delivery (inbox routes, `mod_owner`, `delivery: "message"`, `delivered_ref`); until that
 * lands these tests fail at the first request, which is the point of an integration test.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { start, type ServeHandle } from "../../src/serve/index.js";
import { createSession, type Host } from "../../hooks/mod/core.js";

const OWNER = "0123456789abcdef";
const SESSION = "sess-mod";
const QUESTION = "Which do you choose, A or B?";

const dirs: string[] = [];
const handles: ServeHandle[] = [];
after(async () => {
  for (const h of handles) await h.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "ukagai-mod-"));
  dirs.push(d);
  return d;
};

async function setup() {
  const home = tmp();
  const dataDir = tmp();
  const h = await start({ port: 0, dataDir, home });
  handles.push(h);
  writeFileSync(join(dataDir, "token"), h.token);
  const url = `http://127.0.0.1:${h.port}`;
  const submits: string[] = [];
  const result: { next: () => { ok: true } | { drop: string } } = { next: () => ({ ok: true }) };
  const host: Host = {
    // the real fetch: only the Host-level shape is faked
    fetch: async (u, init) => {
      const r = await fetch(u, init);
      return { status: r.status, text: await r.text() };
    },
    submit: async (text) => {
      submits.push(text);
      return result.next();
    },
    sessionId: () => SESSION,
    now: () => Date.now(),
    readFile: (p) => (p === join(dataDir, "token") ? h.token : undefined),
    getEnv: () => undefined,
    setEnv: () => undefined,
  };
  const mod = createSession(host, { server: url, dataDir }, () => OWNER);
  await mod.start();
  const api = (path: string, body?: unknown) =>
    fetch(url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${h.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  // a tick that is never held back by a backoff, followed by the fire-and-forget delivery settling
  const tick = async (): Promise<void> => {
    await mod.tick();
    await new Promise((r) => setImmediate(r));
  };
  const session = { session_id: SESSION, cwd: "/nonexistent-ukagai-cwd", transcript_path: join(home, ".claude", "projects", "p", `${SESSION}.jsonl`) };
  const ask = async (toolUseId: string) => {
    const r = await api("/api/decisions", {
      tool_use_id: toolUseId,
      kind: "answer_question",
      mod_owner: OWNER,
      session,
      request: { questions: [{ question: QUESTION, header: "Choice", options: [{ label: "A" }, { label: "B" }], multiSelect: false }] },
    });
    return (await r.json()) as { id: string; delivery?: string; status: string };
  };
  const decision = async (id: string) => (await (await api(`/api/decisions/${id}`)).json()) as { status: string; response?: { delivered_via?: string }; claim?: unknown };
  const inbox = (action: string, body: object) => api(`/api/sessions/${SESSION}/inbox/${action}`, body);
  const event = (extra: Record<string, unknown>) =>
    api("/api/events", { ...session, hook_event_name: "UserPromptSubmit", received_at: new Date().toISOString(), ...extra });
  return { mod, tick, ask, decision, inbox, event, api, submits, result };
}

test("poll -> register -> answer -> poll -> submit -> ref event -> ack", async () => {
  const e = await setup();
  await e.tick(); // the owner is seen in the session: an empty poll is 204
  const d = await e.ask("toolu_1");
  assert.equal(d.delivery, "message", "registered as an async decision");
  assert.equal((await e.api(`/api/decisions/${d.id}/answer`, { answers: { [QUESTION]: "B" } })).status, 200);

  await e.tick(); // claim + submit
  assert.equal(e.submits.length, 1);
  const text = e.submits[0]!;
  const ref = d.id.slice(0, 8);
  assert.ok(text.startsWith(`[ukagai] (ref ${ref}) `), text);
  assert.ok(text.includes(`- ${JSON.stringify(QUESTION)}: "B"`), text);
  assert.equal((await e.decision(d.id)).status, "answer_submitted");

  // the settings hook sees the message: recorded, but it does not close the decision
  assert.equal((await e.event({ delivered_ref: ref })).status, 204);
  assert.equal((await e.decision(d.id)).status, "answer_submitted");

  await e.tick(); // ack
  const done = await e.decision(d.id);
  assert.equal(done.status, "answered");
  assert.equal(done.response?.delivered_via, "message");
  // the ack is idempotent
  const again = await e.inbox("ack", { owner: OWNER, item_id: d.id });
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { status: "answered" });
});

test("a drop is released, the decision stays deliverable, and the next poll hands out the same item", async () => {
  const e = await setup();
  await e.tick();
  const d = await e.ask("toolu_2");
  await e.api(`/api/decisions/${d.id}/answer`, { answers: { [QUESTION]: "A" } });

  e.result.next = () => ({ drop: "the turn was interrupted while the prompt was checked" });
  await e.tick();
  assert.equal(e.submits.length, 1);
  assert.equal((await e.event({ delivered_ref: d.id.slice(0, 8) })).status, 204);
  await e.tick(); // release with the drop reason
  assert.equal((await e.decision(d.id)).status, "answer_submitted");
  assert.equal((await e.decision(d.id)).claim, undefined);

  e.mod.turnStart(undefined);
  e.mod.turnComplete(undefined); // the next turn.complete lifts the hold
  e.result.next = () => ({ ok: true });
  await e.tick();
  assert.equal(e.submits.length, 2);
  assert.equal(e.submits[1], e.submits[0]);
  await e.tick();
  assert.equal((await e.decision(d.id)).status, "answered");
});

test("the wire shapes of the three routes", async () => {
  const e = await setup();
  const poll = await e.inbox("poll", { owner: OWNER, idle: true });
  assert.equal(poll.status, 204);
  assert.equal((await e.inbox("poll", { owner: "short", idle: true })).status, 400);
  assert.equal((await e.inbox("poll", { owner: OWNER })).status, 400);
  assert.equal((await e.inbox("ack", { owner: OWNER, item_id: "nope" })).status, 404);
  assert.equal((await e.inbox("release", { owner: OWNER, item_id: "nope" })).status, 404);
  const noAuth = await fetch(`http://127.0.0.1:${handles.at(-1)!.port}/api/sessions/${SESSION}/inbox/poll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner: OWNER, idle: true }),
  });
  assert.equal(noAuth.status, 401);
});
