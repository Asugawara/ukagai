import { after, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHECKPOINT_TTL_MS, checkpointFingerprint, type Decision } from "../../src/contract.js";
import { start, type ServeHandle } from "../../src/serve/index.js";

const roots: string[] = [];
const handles: ServeHandle[] = [];
after(async () => {
  for (const h of handles) await h.close();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "ukagai-ck-"));
  roots.push(d);
  return d;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(20);
  assert.ok(cond(), "condition not met in time");
}

type Env = { h: ServeHandle; home: string; url: string; transcript: string };

async function setup(): Promise<Env> {
  const home = tmp();
  const dir = join(home, ".claude", "projects", "p");
  mkdirSync(dir, { recursive: true });
  const transcript = join(dir, "sess-1.jsonl");
  writeFileSync(transcript, '{"type":"user"}\n');
  const h = await start({ port: 0, dataDir: tmp(), home, recapPollMs: 200 });
  handles.push(h);
  return { h, home, url: `http://127.0.0.1:${h.port}`, transcript };
}

function api(env: Env, path: string, init: { method?: string; body?: unknown } = {}) {
  return fetch(env.url + path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${env.h.token}`, "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

const event = (env: Env, name: string, sid = "sess-1") =>
  api(env, "/api/events", { body: { session_id: sid, transcript_path: env.transcript, cwd: "/w/proj", hook_event_name: name, received_at: new Date().toISOString() } });

const recapLine = (content: string, ts: string) =>
  JSON.stringify({ type: "system", subtype: "away_summary", content, timestamp: ts, sessionId: "sess-1", cwd: "/w/proj" }) + "\n";

const checkpoints = (env: Env): Decision[] => env.h.store.list().filter((d) => d.kind === "checkpoint");

/** A live session whose watcher has already seen the transcript once */
async function live(env: Env): Promise<void> {
  assert.equal((await event(env, "SessionStart")).status, 204);
  await sleep(250);
}

function seed(env: Env, recapAt: string, sid = "sess-1") {
  return api(env, "/api/decisions", {
    body: {
      tool_use_id: `checkpoint:${sid}:${recapAt}`,
      kind: "checkpoint",
      session: { session_id: sid, cwd: "/w/proj", transcript_path: env.transcript },
      request: { recap: `recap ${recapAt}`, recap_at: recapAt },
    },
  });
}

// ---- watcher ----

test("watcher: a new away_summary line creates a checkpoint within 1 s; the session state is untouched", async () => {
  const env = await setup();
  await live(env);
  appendFileSync(env.transcript, recapLine("Fixed the parser. Next: add tests.", "2026-10-04T01:00:00.000Z"));
  await until(() => checkpoints(env).length === 1, 1000);
  const d = checkpoints(env)[0]!;
  assert.equal(d.status, "pending");
  assert.deepEqual(d.request, { recap: "Fixed the parser. Next: add tests.", recap_at: "2026-10-04T01:00:00.000Z" });
  assert.equal(d.tool_use_id, "checkpoint:sess-1:2026-10-04T01:00:00.000Z");
  assert.equal(d.fingerprint, checkpointFingerprint("2026-10-04T01:00:00.000Z"));
  assert.equal(d.lease_until, undefined);
  assert.equal(d.explanation, undefined);
  const s = env.h.store.listSessions().find((x) => x.session_id === "sess-1")!;
  assert.equal(s.state, "working");
  assert.equal(s.transcript_path, env.transcript);
});

test("watcher: recaps written before the session was first seen are not replayed", async () => {
  const env = await setup();
  appendFileSync(env.transcript, recapLine("old recap", "2026-10-04T00:00:00.000Z"));
  await live(env);
  await sleep(500);
  assert.equal(checkpoints(env).length, 0);
});

test("watcher: a second recap supersedes the first", async () => {
  const env = await setup();
  await live(env);
  appendFileSync(env.transcript, recapLine("first", "2026-10-04T01:00:00.000Z"));
  await until(() => checkpoints(env).length === 1);
  appendFileSync(env.transcript, recapLine("second", "2026-10-04T02:00:00.000Z"));
  await until(() => checkpoints(env).length === 2);
  const [a, b] = checkpoints(env);
  assert.equal(a!.status, "cancelled");
  assert.equal(a!.status_reason, "superseded");
  assert.equal(b!.status, "pending");
});

test("watcher: other system lines and partial lines do nothing; a partial line completes later", async () => {
  const env = await setup();
  await live(env);
  appendFileSync(env.transcript, JSON.stringify({ type: "system", subtype: "turn_duration", content: "x" }) + "\n");
  appendFileSync(env.transcript, JSON.stringify({ type: "user", message: "mentions \"away_summary\"" }) + "\n");
  await sleep(500);
  assert.equal(checkpoints(env).length, 0);
  const line = recapLine("split recap", "2026-10-04T03:00:00.000Z");
  appendFileSync(env.transcript, line.slice(0, 40));
  await sleep(500);
  assert.equal(checkpoints(env).length, 0);
  appendFileSync(env.transcript, line.slice(40));
  await until(() => checkpoints(env).length === 1);
});

test("watcher: a truncated file resets to the end", async () => {
  const env = await setup();
  await live(env);
  appendFileSync(env.transcript, "x".repeat(2000) + "\n");
  await sleep(500);
  truncateSync(env.transcript, 10);
  await sleep(500);
  appendFileSync(env.transcript, "\n" + recapLine("after truncation", "2026-10-04T04:00:00.000Z"));
  await until(() => checkpoints(env).length === 1);
  assert.equal((checkpoints(env)[0]!.request as { recap: string }).recap, "after truncation");
});

test("watcher: ended sessions and transcripts outside ~/.claude/projects are not read", async () => {
  const env = await setup();
  await live(env);
  await event(env, "SessionEnd");
  appendFileSync(env.transcript, recapLine("late", "2026-10-04T05:00:00.000Z"));
  const outside = join(tmp(), "x.jsonl");
  writeFileSync(outside, "{}\n");
  await api(env, "/api/events", { body: { session_id: "sess-2", transcript_path: outside, cwd: "/w", hook_event_name: "SessionStart", received_at: new Date().toISOString() } });
  await sleep(300);
  appendFileSync(outside, recapLine("outside", "2026-10-04T05:00:00.000Z"));
  await sleep(600);
  assert.equal(checkpoints(env).length, 0);
});

// ---- store / routes ----

test("POST /api/decisions accepts a checkpoint; repeating returns the same one; the session state is untouched", async () => {
  const env = await setup();
  await live(env);
  const r = await seed(env, "2026-10-04T01:00:00.000Z");
  assert.equal(r.status, 201);
  const again = await seed(env, "2026-10-04T01:00:00.000Z");
  assert.equal(again.status, 200);
  assert.equal(env.h.store.listSessions()[0]!.state, "working");
  const bad = await api(env, "/api/decisions", {
    body: { tool_use_id: "x", kind: "checkpoint", session: { session_id: "sess-1", cwd: "/", transcript_path: env.transcript }, request: { questions: [] } },
  });
  assert.equal(bad.status, 400);
});

test("answer continue: answered, no instruction", async () => {
  const env = await setup();
  const d = (await (await seed(env, "2026-10-04T01:00:00.000Z")).json()) as Decision;
  const r = await api(env, `/api/decisions/${d.id}/answer`, { body: { kind: "continue" } });
  assert.equal(r.status, 200);
  const got = (await r.json()) as Decision;
  assert.equal(got.status, "answered");
  assert.equal(got.response?.kind, "continue");
  assert.equal(got.response?.via, "gui");
  assert.equal((await api(env, "/api/sessions/sess-1/instruction")).status, 404);
});

test("answer instruct: delivered once, then 404; delivered_at set and decision.updated emitted", async () => {
  const env = await setup();
  const d = (await (await seed(env, "2026-10-04T01:00:00.000Z")).json()) as Decision;
  const events: string[] = [];
  const sse = await fetch(env.url + "/api/stream", { headers: { authorization: `Bearer ${env.h.token}` } });
  const reader = sse.body!.getReader();
  void (async () => {
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      events.push(dec.decode(value));
    }
  })();
  await sleep(50);
  await api(env, `/api/decisions/${d.id}/answer`, { body: { kind: "instruct", text: "run the e2e first" } });
  const before = events.join("").split("event: decision.updated").length;
  const r = await api(env, "/api/sessions/sess-1/instruction");
  assert.equal(r.status, 200);
  const body = (await r.json()) as { instruction: { decision_id: string; kind: string; text: string; created_at: string } };
  assert.equal(body.instruction.decision_id, d.id);
  assert.equal(body.instruction.kind, "instruct");
  assert.equal(body.instruction.text, "run the e2e first");
  assert.ok(body.instruction.created_at);
  assert.equal((await api(env, "/api/sessions/sess-1/instruction")).status, 404);
  assert.ok(env.h.store.get(d.id)!.response!.delivered_at);
  await until(() => events.join("").split("event: decision.updated").length > before);
  await reader.cancel();
});

test("answer stop: instruction kind stop; text optional", async () => {
  const env = await setup();
  const d = (await (await seed(env, "2026-10-04T01:00:00.000Z")).json()) as Decision;
  await api(env, `/api/decisions/${d.id}/answer`, { body: { kind: "stop" } });
  const r = await api(env, "/api/sessions/sess-1/instruction");
  assert.equal(r.status, 200);
  const { instruction } = (await r.json()) as { instruction: { kind: string; text: string } };
  assert.equal(instruction.kind, "stop");
  assert.equal(instruction.text, "");
  assert.ok(env.h.store.get(d.id)!.response!.delivered_at);
});

test("answer validation: instruct needs text; an answered checkpoint cannot be answered again; question shapes do not fit", async () => {
  const env = await setup();
  const d = (await (await seed(env, "2026-10-04T01:00:00.000Z")).json()) as Decision;
  assert.equal((await api(env, `/api/decisions/${d.id}/answer`, { body: { kind: "instruct" } })).status, 400);
  assert.equal((await api(env, `/api/decisions/${d.id}/answer`, { body: { kind: "instruct", text: "  " } })).status, 400);
  assert.equal((await api(env, `/api/decisions/${d.id}/answer`, { body: { answers: { q: "a" } } })).status, 400);
  assert.equal((await api(env, `/api/decisions/${d.id}/answer`, { body: { fallback: true } })).status, 400);
  assert.equal((await api(env, `/api/decisions/${d.id}/answer`, { body: { kind: "continue" } })).status, 200);
  assert.equal((await api(env, `/api/decisions/${d.id}/answer`, { body: { kind: "continue" } })).status, 409);
});

test("a newer instruct replaces an undelivered older one", async () => {
  const env = await setup();
  const a = (await (await seed(env, "2026-10-04T01:00:00.000Z")).json()) as Decision;
  await api(env, `/api/decisions/${a.id}/answer`, { body: { kind: "instruct", text: "old" } });
  const b = (await (await seed(env, "2026-10-04T02:00:00.000Z")).json()) as Decision;
  await api(env, `/api/decisions/${b.id}/answer`, { body: { kind: "instruct", text: "new" } });
  const { instruction } = (await (await api(env, "/api/sessions/sess-1/instruction")).json()) as { instruction: { text: string; decision_id: string } };
  assert.equal(instruction.text, "new");
  assert.equal(instruction.decision_id, b.id);
  assert.equal((await api(env, "/api/sessions/sess-1/instruction")).status, 404);
});

test("a new checkpoint supersedes the pending one", async () => {
  const env = await setup();
  const a = (await (await seed(env, "2026-10-04T01:00:00.000Z")).json()) as Decision;
  await seed(env, "2026-10-04T02:00:00.000Z");
  assert.equal(env.h.store.get(a.id)!.status, "cancelled");
  assert.equal(env.h.store.get(a.id)!.status_reason, "superseded");
});

test("UserPromptSubmit cancels a pending checkpoint as new_prompt; SessionEnd as session_end", async () => {
  const env = await setup();
  await live(env);
  const a = (await (await seed(env, "2026-10-04T01:00:00.000Z")).json()) as Decision;
  await event(env, "UserPromptSubmit");
  assert.equal(env.h.store.get(a.id)!.status, "cancelled");
  assert.equal(env.h.store.get(a.id)!.status_reason, "new_prompt");
  const b = (await (await seed(env, "2026-10-04T02:00:00.000Z")).json()) as Decision;
  await event(env, "SessionEnd");
  assert.equal(env.h.store.get(b.id)!.status_reason, "session_end");
});

test("a recap written before the prompt is dropped when UserPromptSubmit arrives first", async () => {
  const env = await setup();
  await live(env);
  appendFileSync(env.transcript, recapLine("stale", "2026-10-04T01:00:00.000Z"));
  await event(env, "UserPromptSubmit");
  await sleep(600);
  assert.equal(checkpoints(env).length, 0);
});

test("the 12 h sweep expires a pending checkpoint", async () => {
  const env = await setup();
  const d = (await (await seed(env, "2026-10-04T01:00:00.000Z")).json()) as Decision;
  env.h.store.checkLeases(Date.now() + CHECKPOINT_TTL_MS - 60000);
  assert.equal(env.h.store.get(d.id)!.status, "pending");
  env.h.store.checkLeases(Date.now() + CHECKPOINT_TTL_MS + 60000);
  assert.equal(env.h.store.get(d.id)!.status, "cancelled");
  assert.equal(env.h.store.get(d.id)!.status_reason, "expired");
});

test("checkpoints do not disturb re-attach, and the instruction needs the bearer token", async () => {
  const env = await setup();
  const d = (await (await seed(env, "2026-10-04T01:00:00.000Z")).json()) as Decision;
  const r = await api(env, `/api/sessions/sess-1/open?fingerprint=${d.fingerprint}&tool_use_id=toolu_x`);
  assert.equal(r.status, 404);
  const noAuth = await fetch(env.url + "/api/sessions/sess-1/instruction");
  assert.equal(noAuth.status, 401);
});

test("metrics: checkpoint counts, total unchanged", async () => {
  const env = await setup();
  const m0 = (await (await api(env, "/api/metrics")).json()) as { a: { total: number }; d: { total: number }; c: { checkpoints: unknown } };
  assert.deepEqual(m0.c.checkpoints, { created: 0, answered: 0, delivered: 0 });
  const a = (await (await seed(env, "2026-10-04T01:00:00.000Z")).json()) as Decision;
  await api(env, `/api/decisions/${a.id}/answer`, { body: { kind: "instruct", text: "go" } });
  const b = (await (await seed(env, "2026-10-04T02:00:00.000Z")).json()) as Decision;
  await api(env, `/api/decisions/${b.id}/answer`, { body: { kind: "continue" } });
  await seed(env, "2026-10-04T03:00:00.000Z");
  await api(env, "/api/sessions/sess-1/instruction");
  const m = (await (await api(env, "/api/metrics")).json()) as typeof m0 & { b: { human: { count: number } } };
  assert.deepEqual(m.c.checkpoints, { created: 3, answered: 2, delivered: 1 });
  assert.equal(m.a.total, m0.a.total);
  assert.equal(m.d.total, m0.d.total);
  assert.equal(m.b.human.count, 0);
});

test("restart: a pending checkpoint stays pending (no lease) and an undelivered instruction survives", async () => {
  const home = tmp();
  const dataDir = tmp();
  mkdirSync(join(home, ".claude", "projects", "p"), { recursive: true });
  const transcript = join(home, ".claude", "projects", "p", "sess-1.jsonl");
  const h1 = await start({ port: 0, dataDir, home, leaseGraceMs: 50 });
  const env1: Env = { h: h1, home, url: `http://127.0.0.1:${h1.port}`, transcript };
  const a = (await (await seed(env1, "2026-10-04T01:00:00.000Z")).json()) as Decision;
  await api(env1, `/api/decisions/${a.id}/answer`, { body: { kind: "stop" } });
  const b = (await (await seed(env1, "2026-10-04T02:00:00.000Z", "sess-2")).json()) as Decision;
  await h1.close();
  const h2 = await start({ port: 0, dataDir, home, leaseGraceMs: 50 });
  handles.push(h2);
  const env2: Env = { h: h2, home, url: `http://127.0.0.1:${h2.port}`, transcript };
  await sleep(300);
  assert.equal(h2.store.get(b.id)!.status, "pending");
  assert.equal(h2.store.get(b.id)!.lease_until, undefined);
  assert.equal((await api(env2, "/api/sessions/sess-1/instruction")).status, 200);
});
