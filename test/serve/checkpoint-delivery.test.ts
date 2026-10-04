// Delivery of a checkpoint reply to a Claude Code session: an idle agent calls no tool, so the reply is typed into its terminal
// (a fake Terminal is injected); a working agent gets it at its next tool call (the hook polls GET /api/sessions/:id/instruction).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHECKPOINT_TTL_MS, type Decision } from "../../src/contract.js";
import { start, type ServeHandle } from "../../src/serve/index.js";
import { TerminalTypeError, type Terminal, type TerminalFound, type TerminalRef, type TerminalStatus } from "../../src/serve/terminal.js";

const roots: string[] = [];
const handles: ServeHandle[] = [];
after(async () => {
  for (const h of handles) await h.close();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "ukagai-cd-"));
  roots.push(d);
  return d;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(20);
  assert.ok(cond(), "condition not met in time");
}

class FakeTerminal implements Terminal {
  found = true;
  /** The status `find` reports first, then each `status()` call; the last one repeats */
  seq: TerminalStatus[] = ["idle"];
  finds: string[] = [];
  typed: string[] = [];
  /** The next `type` throws this */
  typeFails: TerminalTypeError | undefined;
  /** `find` waits for this before answering (a test acts while the lookup is in flight) */
  gate: Promise<void> | undefined;
  private next(): TerminalStatus {
    return this.seq.length > 1 ? this.seq.shift()! : this.seq[0]!;
  }
  async find(sessionId: string): Promise<TerminalFound | undefined> {
    this.finds.push(sessionId);
    const found = this.found;
    const status = this.next();
    await this.gate;
    return found ? { ref: { kind: "herdr", pane_id: "w1:p1" }, status } : undefined;
  }
  async status(): Promise<TerminalStatus> {
    return this.next();
  }
  async type(_ref: TerminalRef, text: string): Promise<void> {
    if (this.typeFails) {
      const e = this.typeFails;
      this.typeFails = undefined;
      throw e;
    }
    this.typed.push(text);
  }
}

type Env = { h: ServeHandle; url: string; transcript: string; term: FakeTerminal; sse: string[] };

async function setup(): Promise<Env> {
  const home = tmp();
  const dir = join(home, ".claude", "projects", "p");
  mkdirSync(dir, { recursive: true });
  const transcript = join(dir, "sess-1.jsonl");
  writeFileSync(transcript, '{"type":"user"}\n');
  const term = new FakeTerminal();
  const h = await start({ port: 0, dataDir: tmp(), home, terminal: term, terminalPollMs: 10 });
  handles.push(h);
  const sse: string[] = [];
  const res = await fetch(`http://127.0.0.1:${h.port}/api/stream`, { headers: { authorization: `Bearer ${h.token}` } });
  const reader = res.body!.getReader();
  void (async () => {
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) return;
      sse.push(dec.decode(value));
    }
  })();
  await sleep(50);
  return { h, url: `http://127.0.0.1:${h.port}`, transcript, term, sse };
}

function api(env: Env, path: string, body?: unknown) {
  return fetch(env.url + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${env.h.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const event = (env: Env, name: string, sid = "sess-1") =>
  api(env, "/api/events", { session_id: sid, transcript_path: env.transcript, cwd: "/w/proj", hook_event_name: name, received_at: new Date().toISOString() });

async function checkpoint(env: Env, agent?: "codex", recapAt = "2026-10-04T01:00:00.000Z"): Promise<Decision> {
  const r = await api(env, "/api/decisions", {
    tool_use_id: `checkpoint:sess-1:${recapAt}`,
    kind: "checkpoint",
    session: { session_id: "sess-1", cwd: "/w/proj", transcript_path: env.transcript, ...(agent ? { agent } : {}) },
    request: { recap: "recap", recap_at: recapAt },
  });
  return (await r.json()) as Decision;
}

const answer = async (env: Env, d: Decision, body: unknown): Promise<Decision> => (await (await api(env, `/api/decisions/${d.id}/answer`, body)).json()) as Decision;
const get = async (env: Env, id: string): Promise<Decision> => (await (await api(env, `/api/decisions/${id}`)).json()) as Decision;
const updates = (env: Env) => env.sse.join("").split("event: decision.updated").length - 1;

test("idle + terminal found: the reply is typed as one line, delivered via terminal, queue empty, decision.updated carries delivered_at", async () => {
  const env = await setup();
  await event(env, "Stop");
  const d = await checkpoint(env);
  const before = updates(env);
  await answer(env, d, { kind: "instruct", text: "run the e2e first\r\nthen   the lint" });
  await until(() => env.term.typed.length === 1);
  assert.equal(env.term.typed[0], "[ukagai] Reply to your progress recap: run the e2e first then the lint");
  await until(() => !!env.h.store.list().find((x) => x.id === d.id)?.response?.delivered_at);
  const got = await get(env, d.id);
  assert.equal(got.response?.delivered_via, "terminal");
  assert.equal((await api(env, "/api/sessions/sess-1/instruction")).status, 404);
  await until(() => updates(env) >= before + 2);
  assert.ok(env.sse.join("").includes('"delivered_via":"terminal"'));
});

test("idle + no terminal: stays queued; the hook GET delivers it (delivered_via hook) and emits decision.updated", async () => {
  const env = await setup();
  env.term.found = false;
  await event(env, "Stop");
  const d = await checkpoint(env);
  await answer(env, d, { kind: "instruct", text: "go on" });
  await sleep(150);
  assert.equal(env.term.typed.length, 0);
  assert.equal((await get(env, d.id)).response?.delivered_at, undefined);
  const before = updates(env);
  const r = await api(env, "/api/sessions/sess-1/instruction");
  assert.equal(r.status, 200);
  const got = await get(env, d.id);
  assert.equal(got.response?.delivered_via, "hook");
  assert.ok(got.response?.delivered_at);
  await until(() => updates(env) > before);
});

test("working + instruct: queued; a later Stop event types it", async () => {
  const env = await setup();
  await event(env, "UserPromptSubmit");
  const d = await checkpoint(env);
  await answer(env, d, { kind: "instruct", text: "after the turn" });
  await sleep(150);
  assert.equal(env.term.typed.length, 0);
  await event(env, "Stop");
  await until(() => env.term.typed.length === 1);
  await until(() => !!env.h.store.list().find((x) => x.id === d.id)?.response?.delivered_at);
  assert.equal((await get(env, d.id)).response?.delivered_via, "terminal");
  assert.equal((await api(env, "/api/sessions/sess-1/instruction")).status, 404);
});

for (const status of ["blocked", "working"] as const) {
  test(`idle session but the pane is ${status}: stays queued for the hook`, async () => {
    const env = await setup();
    env.term.seq = [status];
    await event(env, "Stop");
    const d = await checkpoint(env);
    await answer(env, d, { kind: "instruct", text: "wait" });
    await sleep(150);
    assert.equal(env.term.typed.length, 0);
    assert.equal((await get(env, d.id)).response?.delivered_at, undefined);
    assert.equal((await api(env, "/api/sessions/sess-1/instruction")).status, 200);
  });
}

test("stop + idle: delivered at once as noop, nothing queued", async () => {
  const env = await setup();
  await event(env, "Stop");
  const d = await checkpoint(env);
  const got = await answer(env, d, { kind: "stop" });
  assert.equal(got.response?.delivered_via, "noop");
  assert.ok(got.response?.delivered_at);
  assert.equal((await api(env, "/api/sessions/sess-1/instruction")).status, 404);
  assert.equal(env.term.typed.length, 0);
});

test("stop + working: queued for the hook's deny", async () => {
  const env = await setup();
  await event(env, "UserPromptSubmit");
  const d = await checkpoint(env);
  await answer(env, d, { kind: "stop" });
  const r = await api(env, "/api/sessions/sess-1/instruction");
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { instruction: { kind: string } }).instruction.kind, "stop");
});

test("a queued stop is dropped by UserPromptSubmit; a queued instruct stays", async () => {
  const env = await setup();
  await event(env, "UserPromptSubmit");
  const stop = await checkpoint(env);
  await answer(env, stop, { kind: "stop" });
  await event(env, "UserPromptSubmit");
  assert.equal((await api(env, "/api/sessions/sess-1/instruction")).status, 404);

  const ins = await checkpoint(env, undefined, "2026-10-04T02:00:00.000Z");
  await answer(env, ins, { kind: "instruct", text: "keep me" });
  await event(env, "UserPromptSubmit");
  assert.equal((await api(env, "/api/sessions/sess-1/instruction")).status, 200);
});

test("a checkpoint looks the terminal up once when it is created and puts it on the session", async () => {
  const env = await setup();
  await event(env, "UserPromptSubmit");
  await checkpoint(env);
  await until(() => env.h.store.listSessions().find((s) => s.session_id === "sess-1")?.terminal === "herdr:w1:p1");
  assert.equal(env.term.finds.length, 1);
  const sessions = (await (await api(env, "/api/sessions")).json()) as { session_id: string; terminal?: string }[];
  assert.equal(sessions.find((s) => s.session_id === "sess-1")?.terminal, "herdr:w1:p1");
});

test("a Codex session is untouched: the terminal is never asked", async () => {
  const env = await setup();
  await event(env, "Stop");
  const d = await checkpoint(env, "codex");
  await answer(env, d, { kind: "instruct", text: "codex text" });
  await sleep(200);
  assert.deepEqual(env.term.finds, []);
  assert.deepEqual(env.term.typed, []);
  assert.equal((await get(env, d.id)).response?.delivered_via, undefined);
});

test("after a delivered stop no new checkpoint is made until the next UserPromptSubmit", async () => {
  const env = await setup();
  await event(env, "Stop");
  const d = await checkpoint(env);
  assert.equal((await answer(env, d, { kind: "stop" })).response?.delivered_via, "noop");
  const skipped = env.h.store.createCheckpoint({ session_id: "sess-1", state: "idle", last_event_at: "", cwd: "/w/proj" }, "later recap", "2026-10-04T03:00:00.000Z");
  assert.equal(skipped.created, false);
  assert.equal(skipped.skipped, "after_stop");
  assert.equal(skipped.decision, undefined);
  assert.equal(env.h.store.list().filter((x) => x.kind === "checkpoint").length, 1);
  await event(env, "UserPromptSubmit");
  const again = env.h.store.createCheckpoint({ session_id: "sess-1", state: "working", last_event_at: "", cwd: "/w/proj" }, "next recap", "2026-10-04T04:00:00.000Z");
  assert.equal(again.created, true);
});

test("a stop delivered through the hook also blocks new checkpoints", async () => {
  const env = await setup();
  await event(env, "UserPromptSubmit");
  const d = await checkpoint(env);
  await answer(env, d, { kind: "stop" });
  assert.equal((await api(env, "/api/sessions/sess-1/instruction")).status, 200);
  const r = env.h.store.createCheckpoint({ session_id: "sess-1", state: "idle", last_event_at: "", cwd: "/w/proj" }, "x", "2026-10-04T03:00:00.000Z");
  assert.equal(r.skipped, "after_stop");
});

// ---- status polling, safety checks, races ----

test("working then idle: the answer path re-polls and types", async () => {
  const env = await setup();
  env.term.seq = ["working", "working", "idle"];
  await event(env, "Stop");
  const d = await checkpoint(env);
  await answer(env, d, { kind: "instruct", text: "retry me" });
  await until(() => env.term.typed.length === 1);
  assert.equal((await get(env, d.id)).response?.delivered_via, "terminal");
});

test("working then idle: the Stop path re-polls and types", async () => {
  const env = await setup();
  await event(env, "UserPromptSubmit");
  const d = await checkpoint(env);
  await answer(env, d, { kind: "instruct", text: "after the turn" });
  env.term.seq = ["working", "idle"];
  await event(env, "Stop");
  await until(() => env.term.typed.length === 1);
});

test("always working: gives up after the polls and leaves it for the hook", async () => {
  const env = await setup();
  env.term.seq = ["working"];
  await event(env, "Stop");
  const d = await checkpoint(env);
  await answer(env, d, { kind: "instruct", text: "never" });
  await sleep(300);
  assert.equal(env.term.typed.length, 0);
  assert.equal((await api(env, "/api/sessions/sess-1/instruction")).status, 200);
  const log = readFileSync(join(env.h.dataDir, "serve.log"), "utf8");
  assert.match(log, /terminal_busy/);
});

test("unknown status is never typed into", async () => {
  const env = await setup();
  env.term.seq = ["unknown"];
  await event(env, "Stop");
  const d = await checkpoint(env);
  await answer(env, d, { kind: "instruct", text: "no" });
  await sleep(150);
  assert.equal(env.term.typed.length, 0);
  assert.equal((await get(env, d.id)).response?.delivered_at, undefined);
});

test("terminal not found is logged and clears the session's terminal", async () => {
  const env = await setup();
  await event(env, "Stop");
  const d = await checkpoint(env);
  await until(() => env.h.store.listSessions().find((s) => s.session_id === "sess-1")?.terminal === "herdr:w1:p1");
  env.term.found = false;
  await answer(env, d, { kind: "instruct", text: "x" });
  await until(() => env.h.store.listSessions().find((s) => s.session_id === "sess-1")?.terminal === undefined);
  assert.match(readFileSync(join(env.h.dataDir, "serve.log"), "utf8"), /terminal_not_found/);
});

test("the terminal is looked up again at answer time (a failed first lookup does not stick)", async () => {
  const env = await setup();
  env.term.found = false;
  await event(env, "Stop");
  const d = await checkpoint(env);
  await sleep(100);
  assert.equal(env.h.store.listSessions().find((s) => s.session_id === "sess-1")?.terminal, undefined);
  env.term.found = true;
  await answer(env, d, { kind: "instruct", text: "now it is there" });
  await until(() => env.term.typed.length === 1);
  assert.equal(env.h.store.listSessions().find((s) => s.session_id === "sess-1")?.terminal, "herdr:w1:p1");
});

test("the hook takes the instruction while the terminal is being looked up: nothing is typed, delivered via hook", async () => {
  const env = await setup();
  await event(env, "Stop");
  const d = await checkpoint(env);
  let open!: () => void;
  env.term.gate = new Promise((r) => (open = r));
  await answer(env, d, { kind: "instruct", text: "raced" });
  await until(() => env.term.finds.length >= 2);
  assert.equal((await api(env, "/api/sessions/sess-1/instruction")).status, 200);
  open();
  await sleep(100);
  assert.equal(env.term.typed.length, 0);
  assert.equal((await get(env, d.id)).response?.delivered_via, "hook");
});

test("a UserPromptSubmit during the lookup stops the typing (the agent is no longer idle)", async () => {
  const env = await setup();
  await event(env, "Stop");
  const d = await checkpoint(env);
  let open!: () => void;
  env.term.gate = new Promise((r) => (open = r));
  await answer(env, d, { kind: "instruct", text: "too late" });
  await until(() => env.term.finds.length >= 2);
  await event(env, "UserPromptSubmit");
  open();
  await sleep(100);
  assert.equal(env.term.typed.length, 0);
  assert.equal((await api(env, "/api/sessions/sess-1/instruction")).status, 200); // the instruct stays for the hook
});

test("an answer and a Stop event at the same time type once", async () => {
  const env = await setup();
  await event(env, "Stop");
  const d = await checkpoint(env);
  let open!: () => void;
  env.term.gate = new Promise((r) => (open = r));
  await answer(env, d, { kind: "instruct", text: "once" });
  await event(env, "Stop");
  await until(() => env.term.finds.length >= 3);
  open();
  await until(() => env.term.typed.length >= 1);
  await sleep(100);
  assert.equal(env.term.typed.length, 1);
});

test("typing fails: the instruction goes back on the queue and the hook delivers it", async () => {
  const env = await setup();
  env.term.typeFails = new TerminalTypeError("send-text failed", false);
  await event(env, "Stop");
  const d = await checkpoint(env);
  await answer(env, d, { kind: "instruct", text: "retry via hook" });
  await sleep(150);
  assert.equal(env.term.typed.length, 0);
  assert.equal((await api(env, "/api/sessions/sess-1/instruction")).status, 200);
  assert.equal((await get(env, d.id)).response?.delivered_via, "hook");
});

test("send-text worked but Enter failed: not requeued (it would be typed twice)", async () => {
  const env = await setup();
  env.term.typeFails = new TerminalTypeError("send-keys failed", true);
  await event(env, "Stop");
  const d = await checkpoint(env);
  await answer(env, d, { kind: "instruct", text: "half" });
  await sleep(150);
  assert.equal((await api(env, "/api/sessions/sess-1/instruction")).status, 404);
  assert.match(readFileSync(join(env.h.dataDir, "serve.log"), "utf8"), /terminal_enter_failed/);
});

test("an old reply is not typed (queue age cap)", async () => {
  const env = await setup();
  env.term.found = false;
  await event(env, "Stop");
  const d = await checkpoint(env);
  await answer(env, d, { kind: "instruct", text: "stale" });
  await sleep(30);
  assert.equal(env.h.store.claimInstruction(d.id, 5), undefined);
  assert.ok(env.h.store.claimInstruction(d.id, CHECKPOINT_TTL_MS));
});

test("a stop queued mid-turn is noop when the agent stops by itself, and when the human sends a prompt", async () => {
  const env = await setup();
  await event(env, "UserPromptSubmit");
  const a = await checkpoint(env);
  await answer(env, a, { kind: "stop" });
  await event(env, "Stop");
  const ga = await get(env, a.id);
  assert.equal(ga.response?.delivered_via, "noop");
  assert.equal((await api(env, "/api/sessions/sess-1/instruction")).status, 404);

  await event(env, "UserPromptSubmit");
  const b = await checkpoint(env, undefined, "2026-10-04T02:00:00.000Z");
  await answer(env, b, { kind: "stop" });
  await event(env, "UserPromptSubmit");
  assert.equal((await get(env, b.id)).response?.delivered_via, "noop");
});

test("Codex: a Stop event after a Codex answer does not offer the instruction (store level)", async () => {
  const env = await setup();
  await event(env, "Stop");
  const offered: string[] = [];
  const d = await checkpoint(env, "codex");
  env.h.store.onCheckpointDeliverable = (x) => offered.push(x.id);
  await answer(env, d, { kind: "instruct", text: "codex text" });
  await event(env, "Stop");
  await sleep(100);
  assert.deepEqual(offered, []);
  assert.deepEqual(env.term.typed, []);
});
