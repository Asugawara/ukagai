// Instruct from a plan card: the approval answer { instruct, text }, the plan file -> session lookup, POST /api/plans/:name/instruct, presets.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slugOfHead } from "../../src/serve/plan-session.js";
import { PLAN_INSTRUCT_PREFIX, DEFAULT_SETTINGS, type Decision, type Settings } from "../../src/contract.js";
import { start, type ServeHandle } from "../../src/serve/index.js";
import type { Terminal, TerminalFound, TerminalRef, TerminalStatus } from "../../src/serve/terminal.js";

const roots: string[] = [];
const handles: ServeHandle[] = [];
after(async () => {
  for (const h of handles) await h.close();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "ukagai-pli-"));
  roots.push(d);
  return d;
};

class FakeTerminal implements Terminal {
  typed: string[] = [];
  constructor(private status_: TerminalStatus | "none" = "none") {}
  async find(): Promise<TerminalFound | undefined> {
    return this.status_ === "none" ? undefined : { ref: { kind: "herdr", pane_id: "w1:p1" }, status: this.status_ };
  }
  async status(): Promise<TerminalStatus> {
    return this.status_ === "none" ? "unknown" : this.status_;
  }
  async type(_ref: TerminalRef, text: string): Promise<void> {
    this.typed.push(text);
  }
}

type Env = { h: ServeHandle; home: string; url: string; term: FakeTerminal };

async function boot(term = new FakeTerminal()): Promise<Env> {
  const home = tmp();
  mkdirSync(join(home, ".claude", "plans"), { recursive: true });
  mkdirSync(join(home, ".claude", "projects", "p"), { recursive: true });
  const h = await start({ port: 0, dataDir: tmp(), home, terminal: term, terminalPollMs: 5, recapPollMs: 60000 });
  handles.push(h);
  return { h, home, url: `http://127.0.0.1:${h.port}`, term };
}

const api = (env: Env, path: string, body?: unknown, method?: string) =>
  fetch(env.url + path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${env.h.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** A Claude Code transcript whose lines carry the session slug (the plan file is named after it) */
function transcript(env: Env, sid: string, slug: string): string {
  const p = join(env.home, ".claude", "projects", "p", `${sid}.jsonl`);
  writeFileSync(p, [`{"type":"user","sessionId":"${sid}","slug":"${slug}"}`, `{"type":"assistant","slug":"${slug}"}`].join("\n") + "\n");
  return p;
}
const plan = (env: Env, name: string) => writeFileSync(join(env.home, ".claude", "plans", name), "# Plan\n\nbody\n");
const event = (env: Env, sid: string, path: string, name = "PreToolUse", at = new Date().toISOString()) =>
  api(env, "/api/events", { session_id: sid, transcript_path: path, cwd: "/w", hook_event_name: name, received_at: at });

// ---- the approval answer ----

async function planDecision(env: Env): Promise<Decision> {
  const r = await api(env, "/api/decisions", {
    tool_use_id: "toolu_plan",
    kind: "approve_plan",
    session: { session_id: "s1", cwd: "/w", transcript_path: join(env.home, ".claude", "projects", "p", "s1.jsonl") },
    request: { plan: "# P\n\nbody", planFilePath: join(env.home, ".claude", "plans", "x.md") },
  });
  assert.ok(r.status === 200 || r.status === 201);
  return (await r.json()) as Decision;
}

test("answer { instruct, text } on approve_plan: answered like a reject, response carries instruct + text and no approve", async () => {
  const env = await boot();
  const d = await planDecision(env);
  const r = await api(env, `/api/decisions/${d.id}/answer`, { instruct: true, text: "  have Fable review it  " });
  assert.equal(r.status, 200);
  const done = (await r.json()) as Decision;
  assert.equal(done.status, "answer_submitted");
  assert.equal(done.response?.instruct, true);
  assert.equal(done.response?.text, "have Fable review it");
  assert.equal(done.response?.approve, undefined);
  // the hook's wait returns the same response
  const w = await api(env, `/api/decisions/${d.id}/wait?timeout_ms=100`);
  assert.equal(w.status, 200);
  assert.equal(((await w.json()) as { response: { instruct?: boolean } }).response.instruct, true);
});

test("answer { instruct } validation: other kinds, empty text and 4001 characters are 400", async () => {
  const env = await boot();
  const q = await api(env, "/api/decisions", {
    tool_use_id: "toolu_q",
    kind: "answer_question",
    session: { session_id: "s1", cwd: "/w", transcript_path: join(env.home, ".claude", "projects", "p", "s1.jsonl") },
    request: { questions: [{ question: "Which one, A or B?", header: "Choice", options: [{ label: "A" }, { label: "B" }], multiSelect: false }] },
  });
  const qd = (await q.json()) as Decision;
  assert.equal((await api(env, `/api/decisions/${qd.id}/answer`, { instruct: true, text: "x" })).status, 400);
  const d = await planDecision(env);
  assert.equal((await api(env, `/api/decisions/${d.id}/answer`, { instruct: true, text: "   " })).status, 400);
  assert.equal((await api(env, `/api/decisions/${d.id}/answer`, { instruct: true, text: "x".repeat(4001) })).status, 400);
  assert.equal((await api(env, `/api/decisions/${d.id}/answer`, { instruct: true })).status, 400);
  assert.equal((await api(env, `/api/decisions/${d.id}/answer`, { instruct: true, text: "x", approve: true })).status, 400);
  assert.equal((await api(env, `/api/decisions/${d.id}/answer`, { instruct: true, text: "x".repeat(4000) })).status, 200);
});

// ---- plan file -> session ----

test("GET /api/plans/:name and the list carry session_id for a live session whose transcript has the slug", async () => {
  const env = await boot();
  plan(env, "swift-otter.md");
  plan(env, "other-plan.md");
  await event(env, "s-live", transcript(env, "s-live", "swift-otter"));
  const one = (await (await api(env, "/api/plans/swift-otter.md")).json()) as { session_id?: string };
  assert.equal(one.session_id, "s-live");
  assert.equal(((await (await api(env, "/api/plans/other-plan.md")).json()) as { session_id?: string }).session_id, undefined);
  const list = (await (await api(env, "/api/plans")).json()) as { plans: { name: string; session_id?: string }[] };
  assert.equal(list.plans.find((p) => p.name === "swift-otter.md")?.session_id, "s-live");
  assert.equal(list.plans.find((p) => p.name === "other-plan.md")?.session_id, undefined);
});

test("session_id is absent for an ended session and for one idle for more than 6 hours", async () => {
  const env = await boot();
  plan(env, "ended-plan.md");
  plan(env, "stale-plan.md");
  await event(env, "s-end", transcript(env, "s-end", "ended-plan"));
  await event(env, "s-end", transcript(env, "s-end", "ended-plan"), "SessionEnd");
  await event(env, "s-old", transcript(env, "s-old", "stale-plan"), "PreToolUse", new Date(Date.now() - 7 * 3600_000).toISOString());
  for (const n of ["ended-plan.md", "stale-plan.md"]) {
    assert.equal(((await (await api(env, `/api/plans/${n}`)).json()) as { session_id?: string }).session_id, undefined, n);
  }
});

// ---- POST /api/plans/:name/instruct ----

test("instruct: 404 when no session maps; bad body is 400", async () => {
  const env = await boot();
  plan(env, "lonely.md");
  assert.equal((await api(env, "/api/plans/lonely.md/instruct", { text: "do x" })).status, 404);
  assert.equal((await api(env, "/api/plans/lonely.md/instruct", { text: " " })).status, 400);
});

test("instruct: queued for the agent's next tool call with the plan prefix; no decision is created", async () => {
  const env = await boot();
  plan(env, "swift-otter.md");
  await event(env, "s-live", transcript(env, "s-live", "swift-otter"), "UserPromptSubmit");
  const r = await api(env, "/api/plans/swift-otter.md/instruct", { text: "add a rollback section" });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { delivered_via: "hook" });
  assert.equal(env.h.store.list().length, 0);
  const got = await api(env, "/api/sessions/s-live/instruction");
  assert.equal(got.status, 200);
  const ins = ((await got.json()) as { instruction: { kind: string; text: string; about?: string } }).instruction;
  assert.equal(ins.kind, "instruct");
  assert.equal(ins.text, "add a rollback section");
  assert.equal(ins.about, "plan");
  assert.equal((await api(env, "/api/sessions/s-live/instruction")).status, 404); // consumed
});

test("instruct: an idle agent gets it typed into its terminal, with the plan prefix", async () => {
  const env = await boot(new FakeTerminal("idle"));
  plan(env, "swift-otter.md");
  await event(env, "s-live", transcript(env, "s-live", "swift-otter"), "Stop");
  const r = await api(env, "/api/plans/swift-otter.md/instruct", { text: "review it" });
  assert.deepEqual(await r.json(), { delivered_via: "terminal" });
  assert.deepEqual(env.term.typed, [`${PLAN_INSTRUCT_PREFIX} review it`]);
  assert.equal((await api(env, "/api/sessions/s-live/instruction")).status, 404); // typed, not left for the hook
});

// ---- presets ----

test("settings: instruction_presets default [], blank lines dropped and trimmed, 11 items and 301 characters are 400", async () => {
  const env = await boot();
  assert.deepEqual(((await (await api(env, "/api/settings")).json()) as Settings).plans.instruction_presets, []);
  const put = (presets: string[]) => {
    const s = structuredClone(DEFAULT_SETTINGS);
    s.plans.instruction_presets = presets;
    return api(env, "/api/settings", s, "PUT");
  };
  const ok = await put(["  a  ", "", "   ", "b"]);
  assert.equal(ok.status, 200);
  assert.deepEqual(((await ok.json()) as Settings).plans.instruction_presets, ["a", "b"]);
  assert.deepEqual(((await (await api(env, "/api/settings")).json()) as Settings).plans.instruction_presets, ["a", "b"]);
  assert.equal((await put(Array.from({ length: 11 }, (_, i) => `p${i}`))).status, 400);
  assert.equal((await put(["x".repeat(301)])).status, 400);
  assert.equal((await put(["x".repeat(300)])).status, 200);
});

// ---- request validation ----

test("instruct endpoint: 4001 characters is 400, 4000 is 200, no credentials is 401, an invalid plan name is 404", async () => {
  const env = await boot();
  plan(env, "swift-otter.md");
  await event(env, "s-live", transcript(env, "s-live", "swift-otter"), "UserPromptSubmit");
  assert.equal((await api(env, "/api/plans/swift-otter.md/instruct", { text: "x".repeat(4001) })).status, 400);
  assert.equal((await api(env, "/api/plans/swift-otter.md/instruct", { text: "x".repeat(4000) })).status, 200);
  const bare = await fetch(`${env.url}/api/plans/swift-otter.md/instruct`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x" }) });
  assert.equal(bare.status, 401);
  for (const name of ["..%2F..%2Fetc%2Fpasswd.md", ".hidden.md", "no-extension"]) {
    assert.equal((await api(env, `/api/plans/${name}/instruct`, { text: "x" })).status, 404, name);
  }
});

// ---- the queue slot ----

test("a queued checkpoint stop is never replaced: 409, and the stop is still delivered", async () => {
  const env = await boot();
  plan(env, "swift-otter.md");
  await event(env, "s-live", transcript(env, "s-live", "swift-otter"), "UserPromptSubmit");
  const cp = await checkpoint(env, "s-live");
  assert.equal((await api(env, `/api/decisions/${cp.id}/answer`, { kind: "stop" })).status, 200);
  const r = await api(env, "/api/plans/swift-otter.md/instruct", { text: "add a section" });
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { error: "a stop is queued for this session" });
  const got = ((await (await api(env, "/api/sessions/s-live/instruction")).json()) as { instruction: { kind: string } }).instruction;
  assert.equal(got.kind, "stop");
});

test("a queued checkpoint reply and a plan instruction are joined; the reply's checkpoint is delivered when it is consumed", async () => {
  const env = await boot();
  plan(env, "swift-otter.md");
  await event(env, "s-live", transcript(env, "s-live", "swift-otter"), "UserPromptSubmit");
  const cp = await checkpoint(env, "s-live");
  await api(env, `/api/decisions/${cp.id}/answer`, { kind: "instruct", text: "run the tests" });
  assert.equal((await api(env, "/api/plans/swift-otter.md/instruct", { text: "add a rollback section" })).status, 200);
  const ins = ((await (await api(env, "/api/sessions/s-live/instruction")).json()) as { instruction: { decision_id: string; text: string } }).instruction;
  assert.equal(ins.text, "run the tests\nadd a rollback section");
  assert.equal(ins.decision_id, cp.id);
  assert.ok(env.h.store.get(cp.id)?.response?.delivered_at);
});

test("two plan instructions in a row are joined", async () => {
  const env = await boot();
  plan(env, "swift-otter.md");
  await event(env, "s-live", transcript(env, "s-live", "swift-otter"), "UserPromptSubmit");
  await api(env, "/api/plans/swift-otter.md/instruct", { text: "first" });
  await api(env, "/api/plans/swift-otter.md/instruct", { text: "second" });
  const ins = ((await (await api(env, "/api/sessions/s-live/instruction")).json()) as { instruction: { text: string; about?: string } }).instruction;
  assert.equal(ins.text, "first\nsecond");
  assert.equal(ins.about, "plan");
});

async function checkpoint(env: Env, sid: string): Promise<Decision> {
  const at = new Date().toISOString();
  const r = await api(env, "/api/decisions", {
    tool_use_id: `checkpoint:${sid}:${at}`,
    kind: "checkpoint",
    session: { session_id: sid, cwd: "/w", transcript_path: join(env.home, ".claude", "projects", "p", `${sid}.jsonl`) },
    request: { recap: "recap", recap_at: at },
  });
  return (await r.json()) as Decision;
}

test("an instruction queued while the agent works is typed when the agent goes idle", async () => {
  const env = await boot(new FakeTerminal("idle"));
  plan(env, "swift-otter.md");
  const tp = transcript(env, "s-live", "swift-otter");
  await event(env, "s-live", tp, "UserPromptSubmit");
  assert.deepEqual(await (await api(env, "/api/plans/swift-otter.md/instruct", { text: "review it" })).json(), { delivered_via: "hook" });
  assert.deepEqual(env.term.typed, []);
  await event(env, "s-live", tp, "Stop");
  const end = Date.now() + 2000;
  while (env.term.typed.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(env.term.typed, [`${PLAN_INSTRUCT_PREFIX} review it`]);
  assert.equal((await api(env, "/api/sessions/s-live/instruction")).status, 404);
});

test("a queued plan instruction is dropped when an approval is created for the session", async () => {
  const env = await boot();
  plan(env, "swift-otter.md");
  await event(env, "s-live", transcript(env, "s-live", "swift-otter"), "UserPromptSubmit");
  await api(env, "/api/plans/swift-otter.md/instruct", { text: "review it" });
  const r = await api(env, "/api/decisions", {
    tool_use_id: "toolu_exit",
    kind: "approve_plan",
    session: { session_id: "s-live", cwd: "/w", transcript_path: join(env.home, ".claude", "projects", "p", "s-live.jsonl") },
    request: { plan: "# P\n\nbody", planFilePath: join(env.home, ".claude", "plans", "swift-otter.md") },
  });
  assert.ok(r.status === 200 || r.status === 201);
  assert.equal((await api(env, "/api/sessions/s-live/instruction")).status, 404);
});

// ---- reading the slug ----

test("slugOfHead takes the top-level slug of a line, not a nested one", () => {
  const nested = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", input: { slug: "victim-plan" } }] } });
  const real = JSON.stringify({ type: "user", slug: "swift-otter", message: { content: "x" } });
  assert.equal(slugOfHead(`${nested}\n${real}\n`), "swift-otter");
  assert.equal(slugOfHead(`${nested}\n{"slug":"cut`), undefined);
});

test("a plan instruction joined onto a queued reply with no text of its own is worded as a plan instruction, and keeps the checkpoint's identity", async () => {
  const env = await boot();
  plan(env, "swift-otter.md");
  await event(env, "s-live", transcript(env, "s-live", "swift-otter"), "UserPromptSubmit");
  // A reply without text cannot be made through the API (instruct needs text, stop is 409): queue it the way a restart restores one
  (env.h.store as any).instructions.set("s-live", { decision_id: "d-cp", kind: "instruct", text: "", created_at: new Date().toISOString() });
  assert.equal((await api(env, "/api/plans/swift-otter.md/instruct", { text: "add a section" })).status, 200);
  const got = (await (await api(env, "/api/sessions/s-live/instruction")).json()) as { instruction: { text: string; about?: string; decision_id: string } };
  assert.equal(got.instruction.text, "add a section");
  assert.equal(got.instruction.about, "plan");
  assert.equal(got.instruction.decision_id, "d-cp");
});
