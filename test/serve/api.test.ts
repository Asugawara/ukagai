import { after, test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bodyHash, decisionFingerprint } from "../../src/contract.js";
import { start, type ServeHandle } from "../../src/serve/index.js";

const tmpRoots: string[] = [];
const handles: ServeHandle[] = [];

after(async () => {
  for (const h of handles) await h.close();
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "ukagai-test-"));
  tmpRoots.push(d);
  return d;
}

type Env = { h: ServeHandle; home: string; dataDir: string; url: string };

async function setup(opts: { leaseGraceMs?: number; handoffGraceMs?: number; dataDir?: string; home?: string } = {}): Promise<Env> {
  const home = opts.home ?? tmp();
  const dataDir = opts.dataDir ?? tmp();
  const h = await start({ port: 0, dataDir, home, leaseGraceMs: opts.leaseGraceMs, handoffGraceMs: opts.handoffGraceMs });
  handles.push(h);
  return { h, home, dataDir, url: `http://127.0.0.1:${h.port}` };
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

function decisionBody(env: Env, toolUseId: string, extra: Record<string, unknown> = {}) {
  return {
    tool_use_id: toolUseId,
    kind: "answer_question",
    session: {
      session_id: "sess-1",
      cwd: "/nonexistent-ukagai-cwd",
      transcript_path: join(env.home, ".claude", "projects", "p", "sess-1.jsonl"),
    },
    request: {
      questions: [
        { question: "Which do you choose, A or B?", header: "Choice", options: [{ label: "A" }, { label: "B" }], multiSelect: false },
      ],
    },
    ...extra,
  };
}

/** A request whose question differs per `n`: a second open decision of the same session must not look like a re-call */
const distinct = (n: number) => ({
  request: { questions: [{ question: `Another question ${n}?`, header: "Choice", options: [{ label: "A" }, { label: "B" }], multiSelect: false }] },
});

async function register(env: Env, toolUseId: string, extra: Record<string, unknown> = {}) {
  const r = await api(env, "/api/decisions", { body: decisionBody(env, toolUseId, extra) });
  assert.ok(r.status === 200 || r.status === 201, `register status ${r.status}`);
  return (await r.json()) as { id: string; status: string; [k: string]: any };
}

async function getDecision(env: Env, id: string) {
  return (await (await api(env, `/api/decisions/${id}`)).json()) as { status: string; response?: any; lease_until?: string };
}

async function waitForStatus(env: Env, id: string, status: string, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const d = await getDecision(env, id);
    if (d.status === status) return d;
    assert.ok(Date.now() < end, `status never became ${status} (now ${d.status})`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function answerFlow(env: Env, toolUseId: string) {
  const d = await register(env, toolUseId);
  await api(env, `/api/decisions/${d.id}/answer`, { body: { answers: { "Which do you choose, A or B?": "B" } } });
  const w = await api(env, `/api/decisions/${d.id}/wait?timeout_ms=100`);
  assert.equal(w.status, 200);
  return d.id;
}

test("register -> wait 204 -> answer -> wait 200 -> ack gives answered", async () => {
  const env = await setup();
  const d = await register(env, "toolu_1");
  assert.equal(d.status, "pending");

  const w1 = await api(env, `/api/decisions/${d.id}/wait?timeout_ms=100`);
  assert.equal(w1.status, 204);

  const a = await api(env, `/api/decisions/${d.id}/answer`, { body: { answers: { "Which do you choose, A or B?": "B" } } });
  assert.equal(a.status, 200);
  assert.equal(((await a.json()) as { status: string }).status, "answer_submitted");

  const w2 = await api(env, `/api/decisions/${d.id}/wait?timeout_ms=100`);
  assert.equal(w2.status, 200);
  const body = (await w2.json()) as { response: { via: string; answers: Record<string, string>; decided_at: string } };
  assert.equal(body.response.via, "gui");
  assert.deepEqual(body.response.answers, { "Which do you choose, A or B?": "B" });
  assert.equal((await getDecision(env, d.id)).status, "answer_submitted");

  const ack = await api(env, `/api/decisions/${d.id}/ack`, { body: {} });
  assert.equal(ack.status, 200);
  const acked = (await ack.json()) as { status: string; response: { delivered_at?: string } };
  assert.equal(acked.status, "answered");
  assert.ok(acked.response.delivered_at);

  // answer to an answered decision and a double ack are 409
  const again = await api(env, `/api/decisions/${d.id}/answer`, { body: { answers: { x: "y" } } });
  assert.equal(again.status, 409);
  assert.equal((await api(env, `/api/decisions/${d.id}/ack`, { body: {} })).status, 409);
});

test("ack on pending is 409; sending answers to approve_plan is 400", async () => {
  const env = await setup();
  const d = await register(env, "toolu_2");
  assert.equal((await api(env, `/api/decisions/${d.id}/ack`, { body: {} })).status, 409);
  const bad = await api(env, `/api/decisions/${d.id}/answer`, { body: { approve: true } });
  assert.equal(bad.status, 400);
  const mixed = await api(env, `/api/decisions/${d.id}/answer`, { body: { answers: {}, fallback: true } });
  assert.equal(mixed.status, 400);
  assert.equal((await api(env, "/api/decisions/nope")).status, 404);
});

test("lease expiry without ack -> answer_lost", async () => {
  const env = await setup({ leaseGraceMs: 150 });
  const id = await answerFlow(env, "toolu_3");
  const d = await waitForStatus(env, id, "answer_lost");
  assert.equal(d.status, "answer_lost");
  assert.equal((await api(env, `/api/decisions/${id}/ack`, { body: {} })).status, 409);
});

test("lease expiry when polling stops -> hook_disconnected", async () => {
  const env = await setup({ leaseGraceMs: 150 });
  const d = await register(env, "toolu_4");
  assert.equal((await api(env, `/api/decisions/${d.id}/wait?timeout_ms=100`)).status, 204);
  const after = await waitForStatus(env, d.id, "hook_disconnected");
  assert.equal(after.status, "hook_disconnected");
});

test("lease does not expire while polling", async () => {
  const env = await setup({ leaseGraceMs: 100 });
  const d = await register(env, "toolu_5");
  const w = await api(env, `/api/decisions/${d.id}/wait?timeout_ms=600`);
  assert.equal(w.status, 204);
  assert.equal((await getDecision(env, d.id)).status, "pending");
});

test("Stop within 10 s of lease expiry gives cancelled", async () => {
  const env = await setup({ leaseGraceMs: 100 });
  const d = await register(env, "toolu_6");
  await api(env, `/api/decisions/${d.id}/wait?timeout_ms=50`);
  await waitForStatus(env, d.id, "hook_disconnected");
  const ev = await api(env, "/api/events", {
    body: {
      session_id: "sess-1",
      transcript_path: join(env.home, ".claude", "projects", "p", "sess-1.jsonl"),
      cwd: "/x",
      hook_event_name: "Stop",
      received_at: new Date().toISOString(),
    },
  });
  assert.equal(ev.status, 204);
  assert.equal((await getDecision(env, d.id)).status, "cancelled");
});

test("re-registering the same tool_use_id returns the same id (200)", async () => {
  const env = await setup();
  const r1 = await api(env, "/api/decisions", { body: decisionBody(env, "toolu_7") });
  const r2 = await api(env, "/api/decisions", { body: decisionBody(env, "toolu_7") });
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 200);
  assert.equal(((await r1.json()) as { id: string }).id, ((await r2.json()) as { id: string }).id);
  const list = (await (await api(env, "/api/decisions?status=pending")).json()) as unknown[];
  assert.equal(list.length, 1);
});

test("{fallback:true} -> wait returns 200 with via: terminal", async () => {
  const env = await setup();
  const d = await register(env, "toolu_8");
  const a = await api(env, `/api/decisions/${d.id}/answer`, { body: { fallback: true } });
  assert.equal(((await a.json()) as { status: string }).status, "fallback");
  const w = await api(env, `/api/decisions/${d.id}/wait?timeout_ms=100`);
  assert.equal(w.status, 200);
  const body = (await w.json()) as { response: { via: string } };
  assert.equal(body.response.via, "terminal");
});

test("authorization and input validation: bad Host 400 / no token 401 / no Content-Type 415 / invalid path 400 / nonexistent cwd still 201", async () => {
  const env = await setup();
  const d = await register(env, "toolu_9");

  // bad Host (fetch cannot override Host, so use http directly)
  const status = await new Promise<number>((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port: env.h.port, path: "/healthz", headers: { host: "evil.example:80" } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(status, 400);

  assert.equal((await fetch(env.url + "/healthz")).status, 200);

  const noAuth = await api(env, `/api/decisions/${d.id}/answer`, { body: { fallback: true }, auth: false });
  assert.equal(noAuth.status, 401);
  const wrongToken = await fetch(`${env.url}/api/decisions/${d.id}/answer`, {
    method: "POST",
    headers: { authorization: "Bearer wrong", "content-type": "application/json" },
    body: JSON.stringify({ fallback: true }),
  });
  assert.equal(wrongToken.status, 401);
  assert.equal((await api(env, "/api/decisions", { auth: false })).status, 401);
  // wait accepts Bearer only
  assert.equal((await api(env, `/api/decisions/${d.id}/wait?timeout_ms=10`, { auth: false })).status, 401);

  const noCt = await api(env, `/api/decisions/${d.id}/answer`, { body: { fallback: true }, contentType: null });
  assert.equal(noCt.status, 415);
  const textCt = await api(env, `/api/decisions/${d.id}/answer`, { body: { fallback: true }, contentType: "text/plain" });
  assert.equal(textCt.status, 415);

  const badPath = decisionBody(env, "toolu_bad", distinct(1));
  badPath.session.transcript_path = "/etc/passwd";
  const bp = await api(env, "/api/decisions", { body: badPath });
  assert.equal(bp.status, 400);

  const badExplain = await api(env, "/api/decisions", {
    body: decisionBody(env, "toolu_bad2", {
      explanation: {
        path: "/etc/passwd",
        markdown: "x",
        has: { mermaid: false, table: false, diff: false },
        match: "question",
        attached_via: "first_call",
      },
    }),
  });
  assert.equal(badExplain.status, 400);

  const invalid = await api(env, "/api/decisions", { body: { tool_use_id: 1 } });
  assert.equal(invalid.status, 400);
  assert.ok(Array.isArray(((await invalid.json()) as { issues: unknown[] }).issues));

  const ok = await api(env, "/api/decisions", { body: decisionBody(env, "toolu_nocwd", distinct(7)) });
  assert.equal(ok.status, 201);
  assert.deepEqual(((await ok.json()) as { context: unknown }).context, {});
});

test("answer works with the GUI cookie (issued by GET /, not valid for wait)", async () => {
  const env = await setup();
  const d = await register(env, "toolu_cookie");
  const page = await fetch(env.url + "/");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /ukagai/);
  const setCookie = page.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /ukagai_session=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  const cookie = setCookie.split(";")[0]!;
  assert.notEqual(cookie.split("=")[1], env.h.token);

  const a = await fetch(`${env.url}/api/decisions/${d.id}/answer`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ fallback: true }),
  });
  assert.equal(a.status, 200);
  const w = await fetch(`${env.url}/api/decisions/${d.id}/wait?timeout_ms=10`, { headers: { cookie } });
  assert.equal(w.status, 401);
});

test("serving /public/* and rejecting path traversal", async () => {
  const env = await setup();
  const r = await fetch(env.url + "/public/index.html");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /text\/html/);
  const t = await fetch(env.url + "/public/..%2fpackage.json");
  assert.equal(t.status, 404);
});

test("GET / adds an mtime version (?v=) to app.js / app.css, and /public/* ignores the query", async () => {
  const env = await setup();
  const html = await (await fetch(env.url + "/")).text();
  for (const name of ["app.js", "app.css"]) {
    const v = Math.floor(statSync(join(process.cwd(), "public", name)).mtimeMs).toString(36);
    assert.ok(html.includes(`"/public/${name}?v=${v}"`), `${name} gets ?v=${v}`);
    const r = await fetch(`${env.url}/public/${name}?v=${v}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "no-cache");
  }
  assert.ok(html.includes('"/public/vendor/marked.umd.js"'), "vendor is left unchanged");
});

test("token file is 0600", async () => {
  const env = await setup();
  assert.equal(statSync(join(env.dataDir, "token")).mode & 0o777, 0o600);
});

test("restart keeps pending / answer_submitted live with a fresh lease; they expire to hook_disconnected / answer_lost afterwards", async () => {
  const home = tmp();
  const dataDir = tmp();
  const env1 = await setup({ home, dataDir });
  const p = await register(env1, "toolu_r1");
  const s = await register(env1, "toolu_r2", distinct(2));
  await api(env1, `/api/decisions/${s.id}/answer`, { body: { answers: { q: "A" } } });
  await env1.h.close();

  const env2 = await setup({ home, dataDir, leaseGraceMs: 300 });
  assert.equal((await getDecision(env2, p.id)).status, "pending");
  assert.equal((await getDecision(env2, s.id)).status, "answer_submitted");
  assert.ok(Date.parse((await getDecision(env2, p.id)).lease_until) > Date.now());
  // the same tool_use_id returns the restored decision
  const again = await register(env2, "toolu_r1");
  assert.equal(again.id, p.id);
  // no hook comes back: the lease runs out
  await waitForStatus(env2, p.id, "hook_disconnected");
  await waitForStatus(env2, s.id, "answer_lost");
});

test("restart: a resumed wait keeps the restored decision alive past the grace", async () => {
  const home = tmp();
  const dataDir = tmp();
  const env1 = await setup({ home, dataDir });
  const p = await register(env1, "toolu_r3");
  await env1.h.close();
  const env2 = await setup({ home, dataDir, leaseGraceMs: 300 });
  const r = await api(env2, `/api/decisions/${p.id}/wait?timeout_ms=1000`);
  assert.equal(r.status, 204);
  assert.equal((await getDecision(env2, p.id)).status, "pending");
});

test("/api/metrics: (a') answered 2 / fallback 1 -> 2/3", async () => {
  const env = await setup();
  for (const id of ["m1", "m2"]) {
    const did = await answerFlow(env, id);
    await api(env, `/api/decisions/${did}/ack`, { body: {} });
  }
  const f = await register(env, "m3");
  await api(env, `/api/decisions/${f.id}/answer`, { body: { fallback: true } });
  // pending is not in the denominator
  await register(env, "m4");

  const m = (await (await api(env, "/api/metrics")).json()) as any;
  assert.equal(m.a.answered, 2);
  assert.equal(m.a.fallback, 1);
  assert.equal(m.a.total, 3);
  assert.ok(Math.abs(m.a.rate - 2 / 3) < 1e-9);
  assert.equal(m.b.human.count, 2);
  // all 4 without explanation are none
  assert.equal(m.d.none, 4);
  assert.equal(m.d.attach_rate, 0);
});

test("/api/metrics: (b) baseline, (d) after_deny / plan_mode exclusion, escaped_question", async () => {
  const env = await setup();
  const base = { session_id: "s", transcript_path: join(env.home, ".claude", "projects", "p", "s.jsonl"), cwd: "/x" };
  const ev = (extra: Record<string, unknown>) => api(env, "/api/events", { body: { ...base, ...extra } });
  await ev({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_use_id: "t1", received_at: "2026-10-02T00:00:00.000Z", observe: { phase: "start" } });
  await ev({ hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_use_id: "t1", received_at: "2026-10-02T00:00:10.000Z", observe: { phase: "end" } });
  await ev({ hook_event_name: "PreToolUse", tool_name: "ExitPlanMode", tool_use_id: "t2", received_at: "2026-10-02T00:01:00.000Z", observe: { phase: "start" } });
  await ev({ hook_event_name: "PostToolUse", tool_name: "ExitPlanMode", tool_use_id: "t2", received_at: "2026-10-02T00:01:30.000Z", observe: { phase: "end" } });
  await ev({ hook_event_name: "Stop", received_at: new Date().toISOString(), escaped_question: true });

  const expl = (attached_via: string, none_reason?: string) => ({
    path: join(env.home, ".ukagai", "explain", "x.md"),
    markdown: "x",
    has: { mermaid: false, table: true, diff: false },
    match: "question",
    attached_via,
    ...(none_reason ? { none_reason } : {}),
  });
  // deny without explanation -> re-register the same question with an explanation
  const denied = await api(env, "/api/decisions", { body: decisionBody(env, "d0", { status: "denied_explain" }) });
  assert.equal(((await denied.json()) as { status: string }).status, "denied_explain");
  const after = await register(env, "d1", { explanation: expl("after_deny") });
  assert.ok(after.first_denied_at);
  await register(env, "d2", { ...distinct(3), explanation: expl("first_call") });
  await register(env, "d3", { ...distinct(4), explanation: expl("none", "plan_mode") });
  await register(env, "d4", { ...distinct(5), explanation: expl("none", "loop_guard") });

  // denied_explain is not listed
  const list = (await (await api(env, "/api/decisions")).json()) as unknown[];
  assert.equal(list.length, 4);

  const m = (await (await api(env, "/api/metrics")).json()) as any;
  assert.deepEqual(m.b.baseline, { count: 2, median_ms: 20000, mean_ms: 20000 });
  assert.equal(m.b.agent.count, 1);
  assert.deepEqual({ ...m.d }, { first_call: 1, after_deny: 1, none: 1, total: 3, attach_rate: 2 / 3 });
  assert.equal(m.a.escaped_question, 1);
  assert.equal(m.a.total, 1);
});

test("session state and pending-mode-switch", async () => {
  const env = await setup();
  const base = { session_id: "sess-1", transcript_path: join(env.home, ".claude", "projects", "p", "s.jsonl"), cwd: "/x" };
  const ev = (name: string) => api(env, "/api/events", { body: { ...base, hook_event_name: name, received_at: new Date().toISOString() } });
  const state = async () => ((await (await api(env, "/api/sessions")).json()) as { session_id: string; state: string }[]).find((s) => s.session_id === "sess-1")?.state;

  await ev("SessionStart");
  assert.equal(await state(), "working");
  const d = await register(env, "toolu_plan", { kind: "approve_plan", request: { plan: "p", planFilePath: "/x/plan.md" } });
  assert.equal(await state(), "waiting_decision");
  await ev("Stop");
  assert.equal(await state(), "idle");
  const pms = () => api(env, "/api/sessions/sess-1/pending-mode-switch").then((r) => r.json()) as Promise<{ pending: boolean }>;
  assert.equal((await pms()).pending, false);
  const a = await api(env, `/api/decisions/${d.id}/answer`, { body: { approve: true, set_mode_auto: true } });
  assert.equal(a.status, 200);
  await ev("UserPromptSubmit");
  assert.equal(await state(), "working");
  await ev("SessionEnd");
  assert.equal(await state(), "ended");
  assert.equal((await pms()).pending, true);
  const c1 = await api(env, "/api/sessions/sess-1/pending-mode-switch/consume", { body: {} });
  assert.deepEqual(await c1.json(), { consumed: true });
  const c2 = await api(env, "/api/sessions/sess-1/pending-mode-switch/consume", { body: {} });
  assert.deepEqual(await c2.json(), { consumed: false });
  assert.equal((await pms()).pending, false);
});

test("decision.created arrives over SSE", async () => {
  const env = await setup();
  const res = await fetch(env.url + "/api/stream", { headers: { authorization: `Bearer ${env.h.token}` } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const timer = setTimeout(() => reader.cancel(), 4000);
  await register(env, "toolu_sse");
  while (!buf.includes("event: decision.created")) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value);
  }
  clearTimeout(timer);
  await reader.cancel();
  assert.match(buf, /event: decision\.created\ndata: \{.*"tool_use_id":"toolu_sse"/);
  assert.match(buf, /event: session\.updated/);
});

test("context: collect recent text, tools and title from an allowed transcript (subagent first)", async () => {
  const env = await setup();
  const dir = join(env.home, ".claude", "projects", "p");
  mkdirSync(join(dir, "sess-1", "subagents"), { recursive: true });
  const line = (o: unknown) => JSON.stringify(o) + "\n";
  writeFileSync(
    join(dir, "sess-1.jsonl"),
    line({ type: "ai-title", aiTitle: "parent title" }) +
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "parent text" }] } }),
  );
  writeFileSync(
    join(dir, "sess-1", "subagents", "agent-a1.jsonl"),
    "broken line\n" +
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "child text" }, { type: "tool_use", name: "Edit", input: { file_path: "/a/b.ts" } }] } }) +
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "x".repeat(200) } }] } }),
  );
  const body = decisionBody(env, "toolu_ctx");
  (body.session as Record<string, unknown>).agent_id = "a1";
  const r = await api(env, "/api/decisions", { body });
  const d = (await r.json()) as { context: any };
  assert.equal(d.context.last_assistant_text, "child text");
  assert.deepEqual(d.context.recent_tools, [
    { name: "Edit", summary: "/a/b.ts" },
    { name: "Bash", summary: "x".repeat(80) },
  ]);

  const body2 = decisionBody(env, "toolu_ctx2", distinct(6));
  const d2 = (await (await api(env, "/api/decisions", { body: body2 })).json()) as { context: any; session: { title?: string } };
  assert.equal(d2.context.last_assistant_text, "parent text");
  assert.equal(d2.context.ai_title, "parent title");
  assert.equal(d2.session.title, "parent title");
});

test("F2: wait on a hook_disconnected decision returns 410 within 50ms", async () => {
  const env = await setup({ leaseGraceMs: 30 });
  const created = (await (await api(env, "/api/decisions", { body: decisionBody(env, "tu-f2") })).json()) as { id: string };
  for (let i = 0; i < 100; i++) {
    const d = (await (await api(env, `/api/decisions/${created.id}`)).json()) as { status: string };
    if (d.status === "hook_disconnected") break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const t0 = Date.now();
  const r = await api(env, `/api/decisions/${created.id}/wait?timeout_ms=5000`);
  assert.equal(r.status, 410);
  assert.ok(Date.now() - t0 < 50);
  assert.deepEqual(await r.json(), { error: "decision is closed", status: "hook_disconnected" });
});

test("F3: events.jsonl does not store raw input such as tool_input", async () => {
  const env = await setup();
  const r = await api(env, "/api/events", {
    body: {
      session_id: "s",
      transcript_path: "/x",
      cwd: "/c",
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { content: "SECRET-CONTENT" },
      tool_response: { x: "SECRET-RESPONSE" },
      prompt: "SECRET-PROMPT",
      received_at: new Date().toISOString(),
    },
  });
  assert.equal(r.status, 204);
  const text = readFileSync(join(env.dataDir, "events.jsonl"), "utf8");
  assert.ok(!text.includes("SECRET"));
  assert.ok(text.includes("PostToolUse"));
});

test("Q2-06: blocker_detected is saved to events.jsonl and counted in metrics.a.blocker_detected (not in total)", async () => {
  const env = await setup();
  const base = { session_id: "s", transcript_path: "/x", cwd: "/c", hook_event_name: "Stop" };
  await api(env, "/api/events", { body: { ...base, received_at: new Date().toISOString(), blocker_detected: true } });
  await api(env, "/api/events", { body: { ...base, received_at: new Date().toISOString() } });
  const lines = readFileSync(join(env.dataDir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].blocker_detected, true);
  assert.equal(lines[1].blocker_detected, undefined);
  const m = (await (await api(env, "/api/metrics")).json()) as any;
  assert.equal(m.a.blocker_detected, 1);
  assert.equal(m.a.total, 0);
});

test("F5: UserPromptSubmit on a pending decision gives cancelled", async () => {
  const env = await setup();
  const created = (await (await api(env, "/api/decisions", { body: decisionBody(env, "tu-f5") })).json()) as { id: string };
  const r = await api(env, "/api/events", {
    body: { session_id: "sess-1", transcript_path: "/x", cwd: "/c", hook_event_name: "UserPromptSubmit", received_at: new Date().toISOString() },
  });
  assert.equal(r.status, 204);
  const d = (await (await api(env, `/api/decisions/${created.id}`)).json()) as { status: string };
  assert.equal(d.status, "cancelled");
});

test("F6: cookie-only POST /api/events is 403 except session_panel_open", async () => {
  const env = await setup();
  const home = await fetch(env.url + "/");
  const cookie = (home.headers.get("set-cookie") ?? "").split(";")[0]!;
  const post = (name: string) =>
    fetch(env.url + "/api/events", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ session_id: "s", transcript_path: "/x", cwd: "/c", hook_event_name: name, received_at: new Date().toISOString() }),
    });
  assert.equal((await post("UserPromptSubmit")).status, 403);
  assert.equal((await post("ukagai.session_panel_open")).status, 204);
});

test("M1: /public/% is 404", async () => {
  const env = await setup();
  assert.equal((await fetch(env.url + "/public/%")).status, 404);
});

test("M3: a real registration with the same tool_use_id as denied_explain creates a new decision", async () => {
  const env = await setup();
  const denied = await api(env, "/api/decisions", { body: decisionBody(env, "tu-m3", { status: "denied_explain" }) });
  assert.equal(denied.status, 201);
  const real = await api(env, "/api/decisions", { body: decisionBody(env, "tu-m3") });
  assert.equal(real.status, 201);
  const d = (await real.json()) as { status: string };
  assert.equal(d.status, "pending");
});

test("denied_explain missing is saved and returned by list and reload; not attached to normal decisions", async () => {
  const env = await setup();
  const res = await api(env, "/api/decisions", {
    body: decisionBody(env, "tu-miss", { status: "denied_explain", missing: ["table", "recommend_cond"] }),
  });
  assert.equal(res.status, 201);
  const d = (await res.json()) as { id: string; missing?: string[] };
  assert.deepEqual(d.missing, ["table", "recommend_cond"]);
  const list = (await (await api(env, "/api/decisions?status=denied_explain")).json()) as { id: string; missing?: string[] }[];
  assert.deepEqual(list.find((x) => x.id === d.id)?.missing, ["table", "recommend_cond"]);
  const real = await api(env, "/api/decisions", { body: decisionBody(env, "tu-miss2", { missing: ["x"] }) });
  assert.equal(((await real.json()) as { missing?: string[] }).missing, undefined);
});

// ---- "Cannot answer" memo ----

const CANNOT_Q = "Which do you choose, A or B?";
const MD = "---\nukagai: 1\nquestion: x\n---\n## Why this decision is needed now\nBody.\n";

const registerWithExplanation = (env: Env, toolUseId: string, sessionId = "sess-1") => {
  const b = decisionBody(env, toolUseId, {
    explanation: { path: "", markdown: MD, has: { mermaid: false, table: false, diff: false }, match: "question", attached_via: "first_call" },
  });
  b.session.session_id = sessionId;
  return api(env, "/api/decisions", { body: b }).then((r) => r.json() as Promise<{ id: string }>);
};
const rewrite = (env: Env, sid = "sess-1") => api(env, `/api/sessions/${sid}/pending-rewrite`).then((r) => r.json());

test("Cannot answer: the answer is memoized per session, consumed once, and does not leak to other sessions", async () => {
  const env = await setup();
  assert.equal(await rewrite(env), null);
  const d = await registerWithExplanation(env, "toolu_c1");
  const a = await api(env, `/api/decisions/${d.id}/answer`, { body: { answers: { [CANNOT_Q]: "Cannot answer — Undefined terms: W-T2, FT4" } } });
  assert.equal(a.status, 200);
  const memo = (await rewrite(env)) as any;
  assert.equal(memo.question, CANNOT_Q);
  assert.equal(memo.reason, "Undefined terms");
  assert.deepEqual(memo.terms, ["W-T2", "FT4"]);
  assert.equal(memo.body_hash, bodyHash(MD));
  assert.equal(typeof memo.at, "number");
  assert.equal(await rewrite(env, "sess-other"), null);

  const c1 = await api(env, "/api/sessions/sess-1/pending-rewrite/consume", { body: {} });
  assert.deepEqual(await c1.json(), { consumed: true });
  assert.equal(await rewrite(env), null);
  const c2 = await api(env, "/api/sessions/sess-1/pending-rewrite/consume", { body: {} });
  assert.deepEqual(await c2.json(), { consumed: false });
});

test("Cannot answer: a later one overwrites; a normal answer and an empty-detail Unclear are handled", async () => {
  const env = await setup();
  const d1 = await registerWithExplanation(env, "toolu_c2");
  await api(env, `/api/decisions/${d1.id}/answer`, { body: { answers: { [CANNOT_Q]: "A" } } });
  assert.equal(await rewrite(env), null);
  const d2 = await registerWithExplanation(env, "toolu_c3");
  await api(env, `/api/decisions/${d2.id}/answer`, { body: { answers: { [CANNOT_Q]: "Cannot answer — Unclear" } } });
  assert.deepEqual(((await rewrite(env)) as any).terms, []);
  assert.equal(((await rewrite(env)) as any).reason, "Unclear");
  const d3 = await registerWithExplanation(env, "toolu_c4");
  await api(env, `/api/decisions/${d3.id}/answer`, { body: { answers: { [CANNOT_Q]: "Cannot answer — Too much at once: two things" } } });
  assert.equal(((await rewrite(env)) as any).reason, "Too much at once");
});

test("Cannot answer: the pending-rewrite endpoints need the bearer token, and metrics count it", async () => {
  const env = await setup();
  assert.equal((await api(env, "/api/sessions/sess-1/pending-rewrite", { auth: false })).status, 401);
  const d = await registerWithExplanation(env, "toolu_c5");
  await api(env, `/api/decisions/${d.id}/answer`, { body: { answers: { [CANNOT_Q]: "Cannot answer — Unclear" } } });
  const m = (await (await api(env, "/api/metrics")).json()) as any;
  assert.equal(m.a.cannot_answer, 1);
  assert.equal(m.a.total, 0);
});

// ---- hand-off and re-attach ----

const open = (env: Env, fp: string, toolUseId = "tu-new", session = "sess-1", agentId?: string) =>
  api(env, `/api/sessions/${session}/open?${new URLSearchParams({ fingerprint: fp, tool_use_id: toolUseId, ...(agentId ? { agent_id: agentId } : {}) })}`);
const FP = decisionFingerprint("answer_question", decisionBody({ home: "" } as Env, "x").request);

test("fingerprint: stable across key order and option descriptions, different for a changed label or plan", () => {
  const q = (o: object[]) => ({ questions: [{ question: "Q?", header: "H", options: o }] });
  const a = decisionFingerprint("answer_question", q([{ label: "A", description: "one" }, { label: "B" }]));
  assert.equal(a, decisionFingerprint("answer_question", q([{ description: "other", label: "A" }, { label: "B" }])));
  assert.notEqual(a, decisionFingerprint("answer_question", q([{ label: "A" }, { label: "C" }])));
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(decisionFingerprint("approve_plan", { plan: " P\n", planFilePath: "/a" }), decisionFingerprint("approve_plan", { plan: "P", planFilePath: "/b" }));
  assert.equal(decisionFingerprint("approve_plan", { plan: "", planFilePath: "/a" }), decisionFingerprint("approve_plan", { planFilePath: "/a" }));
  assert.notEqual(decisionFingerprint("approve_plan", { plan: "P" }), decisionFingerprint("approve_plan", { plan: "Q" }));
});

test("create stores fingerprint and handoffs: 0", async () => {
  const env = await setup();
  const d = await register(env, "tu-1");
  assert.equal(d.fingerprint, FP);
  assert.equal(d.handoffs, 0);
});

test("handoff: 200 keeps pending, counts, re-arms the lease with handoffGraceMs; 409 when not pending; 401; 403 for another session", async () => {
  const env = await setup({ handoffGraceMs: 60_000 });
  const d = await register(env, "tu-1");
  assert.equal((await api(env, `/api/decisions/${d.id}/handoff`, { body: { session_id: "sess-1" }, auth: false })).status, 401);
  assert.equal((await api(env, `/api/decisions/${d.id}/handoff`, { body: { session_id: "other" } })).status, 403);
  assert.equal((await api(env, "/api/decisions/nope/handoff", { body: { session_id: "sess-1" } })).status, 404);
  const before = Date.now();
  const r = await api(env, `/api/decisions/${d.id}/handoff`, { body: { session_id: "sess-1" } });
  assert.equal(r.status, 200);
  const j = (await r.json()) as any;
  assert.equal(j.status, "pending");
  assert.equal(j.handoffs, 1);
  assert.ok(Date.parse(j.lease_until) >= before + 59_000);
  await api(env, `/api/decisions/${d.id}/answer`, { body: { answers: { "Which do you choose, A or B?": "A" } } });
  assert.equal((await api(env, `/api/decisions/${d.id}/handoff`, { body: { session_id: "sess-1" } })).status, 409);
});

test("open: hit on a pending decision swaps tool_use_id, keeps the old one, re-arms the lease", async () => {
  const env = await setup({ handoffGraceMs: 60_000 });
  const d = await register(env, "tu-1");
  await api(env, `/api/decisions/${d.id}/handoff`, { body: { session_id: "sess-1" } });
  const r = await open(env, FP, "tu-2");
  assert.equal(r.status, 200);
  const got = ((await r.json()) as any).decision;
  assert.equal(got.id, d.id);
  assert.equal(got.tool_use_id, "tu-2");
  assert.deepEqual(got.previous_tool_use_ids, ["tu-1"]);
  assert.equal(got.status, "pending");
  assert.ok(Date.parse(got.lease_until) < Date.now() + 15_000);
  // both ids map to the same decision: a register with the old id returns it
  const again = await register(env, "tu-1");
  assert.equal(again.id, d.id);
  // a hook that crashed before handing off can also re-attach (pending, not handed off)
  const r3 = await open(env, FP, "tu-3");
  assert.deepEqual((((await r3.json()) as any).decision).previous_tool_use_ids, ["tu-1", "tu-2"]);
});

test("open: hook_disconnected is revived to pending; metrics count the decision once", async () => {
  const env = await setup({ leaseGraceMs: 60 });
  const d = await register(env, "tu-1");
  await waitForStatus(env, d.id, "hook_disconnected");
  const r = await open(env, FP, "tu-2");
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as any).decision.status, "pending");
  assert.equal((await getDecision(env, d.id)).status, "pending");
  await api(env, `/api/decisions/${d.id}/answer`, { body: { answers: { "Which do you choose, A or B?": "A" } } });
  await api(env, `/api/decisions/${d.id}/ack`, { body: {} });
  const m = (await (await api(env, "/api/metrics")).json()) as any;
  assert.equal(m.a.answered, 1);
  assert.equal(m.a.hook_disconnected, 0);
  assert.equal(m.a.total, 1);
  assert.equal(m.a.reattached, 1);
});

test("open: miss for another fingerprint, another session, a closed decision; 400 without parameters; 401", async () => {
  const env = await setup();
  const d = await register(env, "tu-1");
  assert.equal((await open(env, "0".repeat(64))).status, 404);
  assert.equal((await open(env, FP, "tu-2", "sess-other")).status, 404);
  assert.equal((await api(env, "/api/sessions/sess-1/open")).status, 400);
  assert.equal((await api(env, `/api/sessions/sess-1/open?fingerprint=${FP}&tool_use_id=x`, { auth: false })).status, 401);
  await api(env, `/api/decisions/${d.id}/cancel`, { body: {} });
  assert.equal((await open(env, FP)).status, 404);
});

test("create never merges: the same fingerprint registered under a new tool_use_id is a second decision", async () => {
  const env = await setup();
  const d = await register(env, "tu-1");
  const r = await api(env, "/api/decisions", { body: decisionBody(env, "tu-2") });
  assert.equal(r.status, 201);
  assert.notEqual(((await r.json()) as any).id, d.id);
  assert.equal(((await (await api(env, "/api/decisions")).json()) as any[]).length, 2);
});

test("open: the key includes the agent, so two subagents asking the same question do not collapse", async () => {
  const env = await setup();
  const a = await register(env, "tu-a", { session: { ...decisionBody(env, "x").session, agent_id: "agent-a" } });
  const b = await register(env, "tu-b", { session: { ...decisionBody(env, "x").session, agent_id: "agent-b" } });
  assert.notEqual(a.id, b.id);
  assert.equal(((await (await open(env, FP, "tu-a2", "sess-1", "agent-a")).json()) as any).decision.id, a.id);
  assert.equal(((await (await open(env, FP, "tu-b2", "sess-1", "agent-b")).json()) as any).decision.id, b.id);
  assert.equal((await open(env, FP, "tu-c", "sess-1", "agent-c")).status, 404);
  assert.equal((await open(env, FP, "tu-d")).status, 404);
});

test("lease expiry after a hand-off without a re-attach: hook_disconnected as usual; metrics sum handoffs", async () => {
  const env = await setup({ leaseGraceMs: 10_000, handoffGraceMs: 80 });
  const d = await register(env, "tu-1");
  await api(env, `/api/decisions/${d.id}/handoff`, { body: { session_id: "sess-1" } });
  await waitForStatus(env, d.id, "hook_disconnected");
  const m = (await (await api(env, "/api/metrics")).json()) as any;
  assert.equal(m.a.handoffs, 1);
  assert.equal(m.a.reattached, 0);
});
