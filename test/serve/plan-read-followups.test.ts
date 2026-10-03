import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlanSummary } from "../../src/contract.js";
import { start, type ServeHandle } from "../../src/serve/index.js";

const roots: string[] = [];
const handles: ServeHandle[] = [];
const aborts: AbortController[] = [];
after(async () => {
  for (const a of aborts) a.abort();
  for (const h of handles) await h.close();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "ukagai-pread-"));
  roots.push(d);
  return d;
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(20);
  assert.ok(cond(), "condition not met in time");
}

type Env = { base: string; headers: Record<string, string>; home: string; dir: string; dataDir: string; events: { event: string; data: any }[]; seq: number };

async function setup(opts: { leaseGraceMs?: number; files?: Record<string, string>; dataDir?: string } = {}): Promise<Env> {
  const home = tmp();
  const dir = join(home, ".claude", "plans");
  mkdirSync(dir, { recursive: true });
  for (const [n, t] of Object.entries(opts.files ?? {})) writeFileSync(join(dir, n), t);
  const dataDir = opts.dataDir ?? tmp();
  const h = await start({ port: 0, dataDir, home, leaseGraceMs: opts.leaseGraceMs, planPollMs: 60000 });
  handles.push(h);
  const env: Env = { base: `http://127.0.0.1:${h.port}`, headers: { authorization: `Bearer ${h.token}`, "content-type": "application/json" }, home, dir, dataDir, events: [], seq: 0 };
  const ac = new AbortController();
  aborts.push(ac);
  const res = await fetch(`${env.base}/api/stream`, { headers: env.headers, signal: ac.signal });
  void (async () => {
    const dec = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (ev && data) env.events.push({ event: ev, data: JSON.parse(data) });
        }
      }
    } catch {}
  })();
  await sleep(100);
  return env;
}

async function call(env: Env, path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  const res = await fetch(env.base + path, { method, headers: env.headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json().catch(() => undefined)) as any };
}

async function plans(env: Env): Promise<PlanSummary[]> {
  return (await call(env, "/api/plans")).json.plans;
}

async function approval(env: Env, planFilePath: string, session = `00000000-0000-0000-0007-${String(++env.seq).padStart(12, "0")}`): Promise<{ id: string; session: string }> {
  const r = await call(env, "/api/decisions", {
    tool_use_id: `toolu_pread_${process.pid}_${env.seq}_${Math.random()}`,
    kind: "approve_plan",
    session: { session_id: session, cwd: env.home, transcript_path: join(env.home, ".claude", "projects", "p", "none.jsonl") },
    request: { plan: "# P\n", planFilePath },
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return { id: r.json.id, session };
}

const readUpdates = (env: Env, name: string) => env.events.filter((e) => e.event === "plan.updated" && e.data.name === name && e.data.read === true);

async function expectMarked(env: Env, name: string, before: number) {
  await until(() => readUpdates(env, name).length > before);
  const p = (await plans(env)).find((x) => x.name === name)!;
  assert.equal(p.read, true);
}

// ---- 1. a resolved approval marks its plan read ----

for (const [label, finish] of [
  ["answered (approve)", (env: Env, id: string) => call(env, `/api/decisions/${id}/answer`, { approve: true })],
  ["answered (reject)", (env: Env, id: string) => call(env, `/api/decisions/${id}/answer`, { approve: false, reason: "no" })],
  ["answered in the terminal (fallback)", (env: Env, id: string) => call(env, `/api/decisions/${id}/answer`, { fallback: true })],
  ["cancelled", (env: Env, id: string) => call(env, `/api/decisions/${id}/cancel`, {})],
] as const) {
  test(`approval ${label} marks its plan read and broadcasts plan.updated`, async () => {
    const env = await setup();
    writeFileSync(join(env.dir, "a.md"), "# A\n## S\n");
    assert.equal((await plans(env))[0]!.read, false);
    const before = readUpdates(env, "a.md").length;
    const { id } = await approval(env, join(env.dir, "a.md"));
    assert.equal((await finish(env, id)).status, 200);
    await expectMarked(env, "a.md", before);
  });
}

test("approval that expires (hook gone) marks its plan read", async () => {
  const env = await setup({ leaseGraceMs: 150 });
  writeFileSync(join(env.dir, "e.md"), "# E\n");
  const { id } = await approval(env, join(env.dir, "e.md"));
  await until(() => env.events.some((e) => e.event === "decision.updated" && e.data.id === id && e.data.status === "hook_disconnected"));
  await expectMarked(env, "e.md", 0);
});

test("the human speaking in the terminal (UserPromptSubmit) cancels the approval and marks its plan read", async () => {
  const env = await setup();
  writeFileSync(join(env.dir, "t.md"), "# T\n");
  const { session } = await approval(env, join(env.dir, "t.md"));
  const r = await call(env, "/api/events", { session_id: session, transcript_path: join(env.home, ".claude", "projects", "p", "none.jsonl"), cwd: env.home, hook_event_name: "UserPromptSubmit", received_at: new Date().toISOString() });
  assert.equal(r.status, 204);
  await expectMarked(env, "t.md", 0);
});

test("the mark is at the current mtime; a later rewrite makes the plan unread again", async () => {
  const env = await setup();
  const p = join(env.dir, "m.md");
  writeFileSync(p, "# M\n");
  const { id } = await approval(env, p);
  utimesSync(p, new Date(), new Date(Date.now() + 5000)); // changed after the approval was requested
  await call(env, `/api/decisions/${id}/answer`, { approve: true });
  await expectMarked(env, "m.md", 0);
  const marked = (await plans(env))[0]!;
  assert.ok(Date.parse(marked.mtime) > Date.now() + 3000); // the mark is at the mtime after the touch
  utimesSync(p, new Date(), new Date(Date.now() + 9000));
  assert.equal((await plans(env))[0]!.read, false);
});

test("a planFilePath outside the plans dir, a subdirectory, a missing file or a symlink out: nothing is marked, no error", async () => {
  const env = await setup({ files: { "keep.md": "# Keep\n" } });
  const outside = join(env.home, "elsewhere.md");
  writeFileSync(outside, "# Out\n");
  mkdirSync(join(env.dir, "sub"));
  writeFileSync(join(env.dir, "sub", "nested.md"), "# Nested\n");
  symlinkSync(outside, join(env.dir, "link.md"));
  const targets = [outside, join(env.dir, "sub", "nested.md"), join(env.dir, "gone.md"), join(env.dir, "link.md"), "/definitely/not/here.md"];
  const baseline = env.events.length;
  for (const t of targets) {
    const { id } = await approval(env, t);
    const r = await call(env, `/api/decisions/${id}/answer`, { approve: true });
    assert.equal(r.status, 200);
  }
  await sleep(300);
  assert.equal(env.events.slice(baseline).filter((e) => e.event === "plan.updated").length, 0);
  assert.equal((await plans(env)).find((p) => p.name === "keep.md")!.read, true); // baseline-marked at start, untouched
});

test("an answer_question decision never marks plans", async () => {
  const env = await setup();
  writeFileSync(join(env.dir, "q.md"), "# Q\n");
  const r = await call(env, "/api/decisions", {
    tool_use_id: `toolu_pread_q_${process.pid}`,
    kind: "answer_question",
    session: { session_id: "00000000-0000-0000-0008-000000000001", cwd: env.home, transcript_path: join(env.home, ".claude", "projects", "p", "none.jsonl") },
    request: { questions: [{ question: "Q?", header: "Q", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }], multiSelect: false }] },
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  await call(env, `/api/decisions/${r.json.id}/answer`, { answers: { "Q?": "A" } });
  await sleep(200);
  assert.equal(readUpdates(env, "q.md").length, 0);
});

// ---- 1b. the mark is part of the close: plan.updated goes out before decision.updated ----

/** Events (from `from`) in the order they were broadcast: the plan's read mark, and the decision leaving pending */
const closeOrder = (env: Env, name: string, id: string, from: number): string[] =>
  env.events
    .slice(from)
    .filter((e) => (e.event === "plan.updated" && e.data.name === name && e.data.read === true) || (e.event === "decision.updated" && e.data.id === id && e.data.status !== "pending"))
    .map((e) => e.event);

for (const [label, finish] of [
  ["answer", (env: Env, id: string) => call(env, `/api/decisions/${id}/answer`, { approve: true })],
  ["cancel", (env: Env, id: string) => call(env, `/api/decisions/${id}/cancel`, {})],
] as const) {
  test(`order: on ${label} the read mark (plan.updated) is broadcast before decision.updated`, async () => {
    const env = await setup();
    writeFileSync(join(env.dir, "o.md"), "# O\n");
    const { id } = await approval(env, join(env.dir, "o.md"));
    const from = env.events.length;
    assert.equal((await finish(env, id)).status, 200);
    await until(() => closeOrder(env, "o.md", id, from).length >= 2);
    assert.deepEqual(closeOrder(env, "o.md", id, from).slice(0, 2), ["plan.updated", "decision.updated"]);
  });
}

test("order: on lease expiry the read mark is broadcast before decision.updated", async () => {
  const env = await setup({ leaseGraceMs: 150 });
  writeFileSync(join(env.dir, "x.md"), "# X\n");
  const { id } = await approval(env, join(env.dir, "x.md"));
  const from = env.events.length;
  await until(() => closeOrder(env, "x.md", id, from).length >= 2);
  assert.deepEqual(closeOrder(env, "x.md", id, from).slice(0, 2), ["plan.updated", "decision.updated"]);
});

test("order: on UserPromptSubmit the read mark is broadcast before decision.updated", async () => {
  const env = await setup();
  writeFileSync(join(env.dir, "u.md"), "# U\n");
  const { id, session } = await approval(env, join(env.dir, "u.md"));
  const from = env.events.length;
  await call(env, "/api/events", { session_id: session, transcript_path: join(env.home, ".claude", "projects", "p", "none.jsonl"), cwd: env.home, hook_event_name: "UserPromptSubmit", received_at: new Date().toISOString() });
  await until(() => closeOrder(env, "u.md", id, from).length >= 2);
  assert.deepEqual(closeOrder(env, "u.md", id, from).slice(0, 2), ["plan.updated", "decision.updated"]);
});

test("plan_name: set at create for a plan inside the dir, absent for a path outside it, and a missing file", async () => {
  const env = await setup();
  writeFileSync(join(env.dir, "n.md"), "# N\n");
  const outside = join(env.home, "elsewhere.md");
  writeFileSync(outside, "# Out\n");
  const inside = await approval(env, join(env.dir, "n.md"));
  assert.equal((await call(env, `/api/decisions/${inside.id}`)).json.plan_name, "n.md");
  const out = await approval(env, outside);
  assert.equal((await call(env, `/api/decisions/${out.id}`)).json.plan_name, undefined);
  const gone = await approval(env, join(env.dir, "gone.md"));
  assert.equal((await call(env, `/api/decisions/${gone.id}`)).json.plan_name, undefined);
  const from = env.events.length;
  await call(env, `/api/decisions/${out.id}/answer`, { approve: true });
  await sleep(200);
  assert.equal(env.events.slice(from).filter((e) => e.event === "plan.updated").length, 0);
});

// ---- 2. first-run baseline ----

test("no plans-read.json + 3 plans: all read on first start, file created", async () => {
  const env = await setup({ files: { "a.md": "# A\n", "b.md": "# B\n", "c.md": "# C\n" } });
  const list = await plans(env);
  assert.equal(list.length, 3);
  assert.ok(list.every((p) => p.read));
  assert.ok(existsSync(join(env.dataDir, "plans-read.json")));
});

test("no plans-read.json and no plans: the file is created empty, a later plan is new", async () => {
  const env = await setup();
  assert.deepEqual(JSON.parse(readFileSync(join(env.dataDir, "plans-read.json"), "utf8")), {});
  writeFileSync(join(env.dir, "later.md"), "# Later\n");
  assert.equal((await plans(env))[0]!.read, false);
});

test("existing plans-read.json ({}) + 3 plans: all unread, file untouched", async () => {
  const dataDir = tmp();
  writeFileSync(join(dataDir, "plans-read.json"), "{}");
  const env = await setup({ dataDir, files: { "a.md": "# A\n", "b.md": "# B\n", "c.md": "# C\n" } });
  const list = await plans(env);
  assert.equal(list.length, 3);
  assert.ok(list.every((p) => !p.read));
  assert.equal(readFileSync(join(dataDir, "plans-read.json"), "utf8"), "{}");
});
