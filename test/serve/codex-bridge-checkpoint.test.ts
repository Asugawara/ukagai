import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { start, type ServeHandle } from "../../src/serve/index.js";
import { startCodexBridge } from "../../src/serve/codex-bridge/index.js";
import type { Store } from "../../src/serve/store.js";
import type { Decision } from "../../src/contract.js";

const THREAD = "00000000-0000-4000-8000-000000000026";
const CWD = "/work/proj";
const DELAY = 200;

const cleanup: (() => Promise<void> | void)[] = [];
after(async () => {
  for (const fn of cleanup.reverse()) await fn();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A stand-in for the Codex daemon (same idea as codex-bridge.test.ts) with switches for turn/interrupt and turn/start */
class FakeServer {
  sockets = new Set<WebSocket>();
  received: any[] = [];
  ephemeral = false;
  noInterrupt = false;
  /** What thread/loaded/list answers */
  loaded: string[] = [THREAD];
  /** thread/loaded/list answers after this many ms (0 = at once) */
  listDelay = 0;
  private sent = 0;
  failTurnStart = false;
  /** Pushed while thread/resume is being answered (a replay) */
  replayOnResume: (() => void) | undefined;
  private http: Server;
  private wss: WebSocketServer;

  constructor(public socketPath: string) {
    this.http = createServer();
    this.wss = new WebSocketServer({ server: this.http });
    this.wss.on("connection", (ws) => {
      this.sockets.add(ws);
      ws.on("close", () => this.sockets.delete(ws));
      ws.on("message", (raw) => this.onMessage(ws, JSON.parse(String(raw))));
    });
  }

  listen(): Promise<void> {
    return new Promise((r) => this.http.listen(this.socketPath, r));
  }

  private onMessage(ws: WebSocket, m: any): void {
    this.received.push(m);
    if (m.id === undefined) return;
    const reply = (result: unknown) => ws.send(JSON.stringify({ id: m.id, result }));
    const fail = (message: string, code = -32600) => ws.send(JSON.stringify({ id: m.id, error: { code, message } }));
    switch (m.method) {
      case "initialize":
        return reply({ userAgent: "codex-tui/0.159.3 (fake)", codexHome: "/fake", platformFamily: "unix", platformOs: "macos" });
      case "thread/loaded/list":
        {
          if (!this.listDelay) return reply({ data: this.loaded, nextCursor: null });
          setTimeout(() => {
            try {
              reply({ data: this.loaded, nextCursor: null });
            } catch {
              // the socket went meanwhile
            }
          }, this.listDelay);
          return;
        }
      case "thread/resume":
        this.replayOnResume?.();
        return reply({
          thread: { id: m.params.threadId, preview: "Run echo hi", name: "Run echo hi", ephemeral: this.ephemeral, cwd: CWD },
          model: "gpt-5.6-sol",
          cwd: CWD,
          reasoningEffort: "low",
          collaborationMode: { mode: "default", settings: { model: "gpt-5.6-sol", reasoning_effort: "low", developer_instructions: "x" } },
        });
      case "turn/interrupt":
        return this.noInterrupt ? fail("method not found", -32601) : reply({});
      case "turn/start":
        return this.failTurnStart ? fail("turn/start refused") : reply({ turn: { id: `sent-${++this.sent}` } });
      default:
        return reply({});
    }
  }

  push(method: string, params: unknown): void {
    for (const ws of this.sockets) ws.send(JSON.stringify({ method, params }));
  }

  settings(mode: string, effort = "medium"): void {
    this.push("thread/settings/updated", {
      threadId: THREAD,
      threadSettings: { cwd: CWD, model: "gpt-5.6-sol", effort, collaborationMode: { mode, settings: { model: "gpt-5.6-sol", reasoning_effort: effort, developer_instructions: "long" } } },
    });
  }

  started(turnId: string): void {
    this.push("turn/started", { threadId: THREAD, turn: { id: turnId, items: [], status: "inProgress" } });
  }

  message(turnId: string, text: string, phase = "final_answer"): void {
    this.push("item/completed", { threadId: THREAD, turnId, item: { type: "agentMessage", id: `${turnId}-m-${phase}`, text, phase } });
  }

  completed(turnId: string): void {
    this.push("turn/completed", { threadId: THREAD, turn: { id: turnId, items: [], status: "completed" } });
  }

  /** settings → turn/started → agent message → turn/completed (D1's event order) */
  turn(turnId: string, text: string, mode = "default", effort = "medium"): void {
    this.settings(mode, effort);
    this.started(turnId);
    this.message(turnId, text);
    this.completed(turnId);
  }

  methods(name: string): any[] {
    return this.received.filter((m) => m.method === name);
  }

  close(): Promise<void> {
    for (const ws of this.sockets) ws.terminate();
    this.wss.close();
    return new Promise((r) => {
      this.http.close(() => r());
      this.http.closeAllConnections();
    });
  }
}

type Env = { fake: FakeServer; h: ServeHandle; url: string; tui: { value: boolean | undefined; asked: string[]; gate?: Promise<void> }; dataDir: string };

async function setup(opts: { ephemeral?: boolean; replay?: (f: FakeServer) => void } = {}): Promise<Env> {
  const root = mkdtempSync(join(tmpdir(), "ukagai-cbc-"));
  const short = mkdtempSync("/tmp/ukcc-");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  cleanup.push(() => rmSync(short, { recursive: true, force: true }));
  const codexHome = join(root, "codex");
  mkdirSync(join(codexHome, "app-server-control"), { recursive: true });
  const fake = new FakeServer(join(short, "s.sock"));
  fake.ephemeral = opts.ephemeral === true;
  if (opts.replay) fake.replayOnResume = () => opts.replay!(fake);
  await fake.listen();
  symlinkSync(join(short, "s.sock"), join(codexHome, "app-server-control", "app-server-control.sock"));
  cleanup.push(() => fake.close());
  const dataDir = join(root, "data");
  // The bridge is started here (not by serve) so the TUI probe is a stub: the real one would look at this machine's processes
  const h = await start({ port: 0, dataDir, home: root, codexBridge: false });
  cleanup.push(() => h.close());
  const tui: Env["tui"] = { value: true, asked: [] };
  const bridge = startCodexBridge({
    store: h.store,
    dataDir,
    lang: "en",
    codexHome,
    checkpointDelayMs: DELAY,
    tuiRunningIn: async (cwd) => {
      tui.asked.push(cwd);
      await tui.gate;
      return tui.value;
    },
  });
  cleanup.push(() => bridge.close());
  const env: Env = { fake, h, url: `http://127.0.0.1:${h.port}`, tui, dataDir };
  await until(() => fake.methods("thread/resume").length > 0, "thread/resume");
  await sleep(30);
  return env;
}

function api(env: Env, path: string, body?: unknown) {
  return fetch(env.url + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${env.h.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function until<T>(fn: () => T | undefined | false, what: string, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(20);
  }
}

const checkpoints = (env: Env) => env.h.store.list().filter((d) => d.kind === "checkpoint");
const live = (env: Env) => checkpoints(env).filter((d) => d.status === "pending");

async function seedCheckpoint(env: Env, text = "Done with step 1. Next: step 2.", effort = "medium"): Promise<Decision> {
  env.fake.turn("turn-1", text, "default", effort);
  return until(() => live(env)[0], "checkpoint");
}

test("turn/completed + quiet delay creates one checkpoint with the last agent message", async () => {
  const env = await setup();
  env.fake.settings("default");
  env.fake.started("turn-1");
  env.fake.message("turn-1", "Working on it.", "commentary");
  env.fake.message("turn-1", "All done. Next I would add tests.");
  env.fake.message("turn-1", "late commentary", "commentary");
  env.fake.completed("turn-1");
  await sleep(DELAY / 2);
  assert.equal(checkpoints(env).length, 0, "not before the delay");
  const d = await until(() => checkpoints(env)[0], "checkpoint");
  assert.equal(d.status, "pending");
  assert.deepEqual(d.request, { recap: "All done. Next I would add tests.", recap_at: (d.request as any).recap_at });
  assert.equal(d.session.agent, "codex");
  assert.equal(d.session.session_id, THREAD);
  assert.equal(d.session.cwd, CWD);
  assert.equal(d.session.transcript_path, "");
  assert.equal(d.session.title, "Run echo hi");
  assert.match(d.tool_use_id, new RegExp(`^checkpoint:${THREAD}:`));
  await sleep(DELAY);
  assert.equal(checkpoints(env).length, 1);
});

test("a long message is capped at 2000 characters with an ellipsis", async () => {
  const env = await setup();
  const d = await seedCheckpoint(env, "x".repeat(2500));
  const recap = (d.request as any).recap as string;
  assert.equal(recap.length, 2000);
  assert.ok(recap.endsWith("…"));
});

test("a turn/started within the delay creates nothing; a pending checkpoint is cancelled as new_prompt", async () => {
  const env = await setup();
  env.fake.turn("turn-1", "first");
  await sleep(DELAY / 3);
  env.fake.started("turn-2");
  await sleep(DELAY * 2);
  assert.equal(checkpoints(env).length, 0);
  // and a checkpoint that already exists is closed by the next turn
  env.fake.message("turn-2", "second");
  env.fake.completed("turn-2");
  const d = await until(() => live(env)[0], "checkpoint");
  env.fake.started("turn-3");
  await until(() => env.h.store.get(d.id)!.status === "cancelled", "cancelled");
  assert.equal(env.h.store.get(d.id)!.status_reason, "new_prompt");
});

test("a second turn/completed supersedes the first checkpoint, with its own tool_use_id", async () => {
  const env = await setup();
  const a = await seedCheckpoint(env, "first recap");
  await sleep(5);
  // no turn/started in between (that would close the first one as new_prompt)
  env.fake.message("turn-2", "second recap");
  env.fake.completed("turn-2");
  await until(() => checkpoints(env).length === 2, "second checkpoint");
  assert.notEqual(checkpoints(env)[0]!.tool_use_id, checkpoints(env)[1]!.tool_use_id);
  const first = env.h.store.get(a.id)!;
  assert.equal(first.status, "cancelled");
  assert.equal(first.status_reason, "superseded");
});

test("a plan turn that became an approve_plan decision gets no checkpoint", async () => {
  const env = await setup();
  env.fake.settings("plan");
  env.fake.started("turn-p");
  env.fake.push("item/completed", { threadId: THREAD, turnId: "turn-p", item: { type: "plan", id: "p", text: "# Plan\n\n1. do it\n" } });
  env.fake.message("turn-p", "Here is the plan.");
  env.fake.completed("turn-p");
  await until(() => env.h.store.list().some((d) => d.kind === "approve_plan"), "approve_plan");
  await sleep(DELAY * 2);
  assert.equal(checkpoints(env).length, 0);
});

test("turns replayed while the bridge resumes a thread create nothing", async () => {
  const env = await setup({ replay: (f) => f.turn("turn-old", "old recap") });
  await sleep(DELAY * 2);
  assert.equal(checkpoints(env).length, 0);
});

test("an ephemeral thread creates nothing; neither does a turn without an agent message", async () => {
  const eph = await setup({ ephemeral: true });
  eph.fake.turn("turn-1", "title generation");
  await sleep(DELAY * 2);
  assert.equal(checkpoints(eph).length, 0);

  const env = await setup();
  env.fake.settings("default");
  env.fake.started("turn-1");
  env.fake.completed("turn-1");
  await sleep(DELAY * 2);
  assert.equal(checkpoints(env).length, 0);
});

test("instruct: turn/start with the text and the thread's model / effort; delivered; the hook route gets nothing", async () => {
  const env = await setup();
  const d = await seedCheckpoint(env, "Done.", "high");
  const r = await api(env, `/api/decisions/${d.id}/answer`, { kind: "instruct", text: "run the e2e first" });
  assert.equal(r.status, 200);
  const sent = await until(() => env.fake.methods("turn/start")[0], "turn/start");
  assert.equal(sent.params.threadId, THREAD);
  assert.deepEqual(sent.params.input, [{ type: "text", text: "run the e2e first", text_elements: [] }]);
  assert.deepEqual(sent.params.collaborationMode, { mode: "default", settings: { model: "gpt-5.6-sol", reasoning_effort: "high", developer_instructions: null } });
  assert.equal(env.fake.methods("turn/interrupt").length, 0, "idle thread: no interrupt");
  await until(() => env.h.store.get(d.id)!.response?.delivered_at, "delivered_at");
  assert.equal(env.h.store.get(d.id)!.status, "answered");
  // consumed by the bridge, not left for `hook --checkpoint`
  assert.equal((await api(env, `/api/sessions/${THREAD}/instruction`)).status, 404);
});

test("decision.updated is emitted when the instruction is delivered", async () => {
  const env = await setup();
  const d = await seedCheckpoint(env);
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
  await api(env, `/api/decisions/${d.id}/answer`, { kind: "instruct", text: "go" });
  await until(() => env.h.store.get(d.id)!.response?.delivered_at, "delivered_at");
  await until(() => events.join("").split("event: decision.updated").length >= 3, "two decision.updated events");
  await reader.cancel();
});

test("stop while a turn runs: turn/interrupt, then turn/start with the stop text and the human's text", async () => {
  const env = await setup();
  const d = await seedCheckpoint(env);
  env.fake.started("turn-run"); // closes the checkpoint (new_prompt)... so answer a fresh one below
  await until(() => env.h.store.get(d.id)!.status === "cancelled", "cancelled");
  env.fake.message("turn-run", "still going", "commentary");
  env.fake.received.length = 0;
  // a checkpoint of an earlier turn answered while turn-run is in flight: seed through the API
  const seeded = env.h.store.createCheckpoint(
    { session_id: THREAD, state: "idle", last_event_at: new Date().toISOString(), cwd: CWD, transcript_path: "", agent: "codex" },
    "recap",
    new Date().toISOString(),
  ).decision;
  await api(env, `/api/decisions/${seeded.id}/answer`, { kind: "stop", text: "the schema first" });
  await until(() => env.fake.methods("turn/start")[0], "turn/start");
  const order = env.fake.received.filter((m) => m.method === "turn/interrupt" || m.method === "turn/start").map((m) => m.method);
  assert.deepEqual(order, ["turn/interrupt", "turn/start"]);
  assert.deepEqual(env.fake.methods("turn/interrupt")[0].params, { threadId: THREAD, turnId: "turn-run" });
  const text = env.fake.methods("turn/start")[0].params.input[0].text as string;
  assert.match(text, /^The human asked you to stop\. Write a short status \(done \/ in progress \/ next\) and end your turn\./);
  assert.match(text, /the schema first/);
  await until(() => env.h.store.get(seeded.id)!.response?.delivered_at, "delivered_at");
});

test("stop while idle: turn/start only, with the stop text", async () => {
  const env = await setup();
  const d = await seedCheckpoint(env);
  await api(env, `/api/decisions/${d.id}/answer`, { kind: "stop" });
  const sent = await until(() => env.fake.methods("turn/start")[0], "turn/start");
  assert.equal(env.fake.methods("turn/interrupt").length, 0);
  assert.equal(sent.params.input[0].text, "The human asked you to stop. Write a short status (done / in progress / next) and end your turn.");
});

test("a daemon without turn/interrupt: the instruction waits for turn/completed", async () => {
  const env = await setup();
  env.fake.noInterrupt = true;
  const seeded = env.h.store.createCheckpoint(
    { session_id: THREAD, state: "idle", last_event_at: new Date().toISOString(), cwd: CWD, transcript_path: "", agent: "codex" },
    "recap",
    new Date().toISOString(),
  ).decision;
  env.fake.started("turn-run");
  await sleep(30);
  // started closed the checkpoint; seed again with the turn running
  const again = env.h.store.createCheckpoint(
    { session_id: THREAD, state: "idle", last_event_at: new Date().toISOString(), cwd: CWD, transcript_path: "", agent: "codex" },
    "recap 2",
    new Date(Date.now() + 1).toISOString(),
  ).decision;
  assert.notEqual(again.id, seeded.id);
  await api(env, `/api/decisions/${again.id}/answer`, { kind: "instruct", text: "after this turn" });
  await until(() => env.fake.methods("turn/interrupt").length === 1, "turn/interrupt tried");
  await sleep(100);
  assert.equal(env.fake.methods("turn/start").length, 0, "queued while the turn runs");
  assert.equal(env.h.store.get(again.id)!.response?.delivered_at, undefined);
  env.fake.message("turn-run", "finished");
  env.fake.completed("turn-run");
  const sent = await until(() => env.fake.methods("turn/start")[0], "turn/start after turn/completed");
  assert.equal(sent.params.input[0].text, "after this turn");
  await until(() => env.h.store.get(again.id)!.response?.delivered_at, "delivered_at");
});

test("continue sends nothing", async () => {
  const env = await setup();
  const d = await seedCheckpoint(env);
  await api(env, `/api/decisions/${d.id}/answer`, { kind: "continue" });
  await sleep(150);
  assert.equal(env.fake.methods("turn/start").length, 0);
  assert.equal(env.fake.methods("turn/interrupt").length, 0);
  assert.equal(env.h.store.get(d.id)!.status, "answered");
});

test("a failed turn/start makes the answer answer_lost", async () => {
  const env = await setup();
  env.fake.failTurnStart = true;
  const d = await seedCheckpoint(env);
  await api(env, `/api/decisions/${d.id}/answer`, { kind: "instruct", text: "do x" });
  await until(() => env.h.store.get(d.id)!.status === "answer_lost", "answer_lost");
  assert.equal(env.h.store.get(d.id)!.response?.delivered_at, undefined);
  assert.equal((await api(env, `/api/sessions/${THREAD}/instruction`)).status, 404);
});

test("SessionEnd of the thread (the TUI quit) before the timer fires: no checkpoint", async () => {
  const env = await setup();
  env.fake.turn("turn-1", "Done.");
  await sleep(DELAY / 4);
  await api(env, "/api/events", { session_id: THREAD, hook_event_name: "SessionEnd", cwd: CWD, transcript_path: "", agent: "codex", received_at: new Date().toISOString() });
  await sleep(DELAY * 2);
  assert.equal(checkpoints(env).length, 0);
});

test("the timer asks the daemon: a thread missing from thread/loaded/list gets no checkpoint", async () => {
  const env = await setup();
  env.fake.loaded = [];
  env.fake.turn("turn-1", "Done.");
  await sleep(DELAY * 2);
  assert.equal(checkpoints(env).length, 0);
  assert.ok(env.fake.methods("thread/loaded/list").length >= 2, "listed again at fire time");
});

test("a stop answer: the stop turn's turn/completed arms nothing; the next human turn arms normally", async () => {
  const env = await setup();
  const d = await seedCheckpoint(env);
  await api(env, `/api/decisions/${d.id}/answer`, { kind: "stop" });
  await until(() => env.fake.methods("turn/start")[0], "turn/start");
  // the bridge learns the stop turn's id from the turn/start reply: events of that turn must not overtake it
  await until(() => env.h.store.get(d.id)!.response?.delivered_at, "delivered");
  env.fake.started("sent-1");
  env.fake.message("sent-1", "Status: done.");
  env.fake.completed("sent-1");
  await sleep(DELAY * 2);
  assert.equal(checkpoints(env).filter((c) => c.status === "pending").length, 0);
  env.fake.turn("turn-2", "Human asked more; done.");
  const next = await until(() => live(env)[0], "checkpoint for the next turn");
  assert.equal((next.request as any).recap, "Human asked more; done.");
});

test("a stop queued behind a running turn (no turn/interrupt): its turn arms nothing either", async () => {
  const env = await setup();
  env.fake.noInterrupt = true;
  env.fake.started("turn-run");
  await sleep(30);
  const seeded = env.h.store.createCheckpoint(
    { session_id: THREAD, state: "idle", last_event_at: new Date().toISOString(), cwd: CWD, transcript_path: "", agent: "codex" },
    "recap",
    new Date().toISOString(),
  ).decision;
  await api(env, `/api/decisions/${seeded.id}/answer`, { kind: "stop" });
  await until(() => env.fake.methods("turn/interrupt").length === 1, "turn/interrupt tried");
  await sleep(100); // the bridge queues once the interrupt error is back
  env.fake.completed("turn-run"); // sends the queued stop; its own completion follows
  await until(() => env.fake.methods("turn/start")[0], "queued turn/start");
  await until(() => env.h.store.get(seeded.id)!.response?.delivered_at, "delivered");
  env.fake.started("sent-1");
  env.fake.message("sent-1", "Status.");
  env.fake.completed("sent-1");
  await sleep(DELAY * 2);
  assert.equal(live(env).length, 0);
});

const hookEvent = (env: Env, name: string) =>
  api(env, "/api/events", { session_id: THREAD, hook_event_name: name, cwd: CWD, transcript_path: "", agent: "codex", received_at: new Date().toISOString() });
const idleCheckpoint = (env: Env, recap = "recap") =>
  env.h.store.createCheckpoint({ session_id: THREAD, state: "idle", last_event_at: new Date().toISOString(), cwd: CWD, transcript_path: "", agent: "codex" }, recap, new Date().toISOString()).decision;

test("SessionEnd while thread/loaded/list is in flight: no checkpoint", async () => {
  const env = await setup();
  env.fake.listDelay = 200;
  env.fake.turn("turn-1", "Done.");
  await sleep(DELAY + 60);
  await hookEvent(env, "SessionEnd");
  await sleep(400);
  assert.equal(checkpoints(env).length, 0);
});

test("turn/started while thread/loaded/list is in flight: no checkpoint for the old turn", async () => {
  const env = await setup();
  env.fake.listDelay = 200;
  env.fake.turn("turn-1", "Done.");
  await sleep(DELAY + 60);
  env.fake.started("turn-2");
  await sleep(400);
  assert.equal(checkpoints(env).length, 0);
});

test("the socket closing while thread/loaded/list is in flight: skipped as not_connected, no checkpoint", async () => {
  const env = await setup();
  env.fake.listDelay = 400;
  env.fake.turn("turn-1", "Done.");
  await sleep(DELAY + 60);
  for (const ws of env.fake.sockets) ws.terminate();
  await sleep(150);
  assert.equal(checkpoints(env).length, 0);
});

test("a stop turn that never completes does not suppress the human's later turns", async () => {
  const env = await setup();
  const d = await seedCheckpoint(env);
  await api(env, `/api/decisions/${d.id}/answer`, { kind: "stop" });
  await until(() => env.fake.methods("turn/start")[0], "turn/start");
  env.fake.started("sent-1"); // no turn/completed for it ever arrives
  await sleep(50);
  env.fake.turn("turn-h1", "Human turn 1 done.");
  await until(() => live(env)[0], "checkpoint after human turn 1");
  env.fake.turn("turn-h2", "Human turn 2 done.");
  await until(() => live(env).some((c) => (c.request as any).recap === "Human turn 2 done."), "checkpoint after human turn 2");
});

test("a missed turn/started of the stop turn does not claim the human's next turn", async () => {
  const env = await setup();
  const d = await seedCheckpoint(env);
  await api(env, `/api/decisions/${d.id}/answer`, { kind: "stop" });
  await until(() => env.fake.methods("turn/start")[0], "turn/start");
  await sleep(50);
  env.fake.turn("turn-h1", "Human turn 1 done.");
  await until(() => live(env)[0], "checkpoint after human turn 1");
});

test("the interrupted turn completing after the stop turn completed arms nothing", async () => {
  const env = await setup();
  env.fake.started("turn-run");
  await sleep(30);
  const seeded = idleCheckpoint(env);
  await api(env, `/api/decisions/${seeded.id}/answer`, { kind: "stop" });
  await until(() => env.fake.methods("turn/start")[0], "turn/start");
  env.fake.started("sent-1");
  env.fake.message("sent-1", "Status.");
  env.fake.completed("sent-1");
  env.fake.message("turn-run", "partial", "commentary");
  env.fake.completed("turn-run");
  await sleep(DELAY * 2);
  assert.equal(live(env).length, 0);
});

test("late turn events after SessionEnd do not arm a checkpoint; the thread's next turn/started clears that", async () => {
  const env = await setup();
  await hookEvent(env, "SessionEnd");
  await sleep(30);
  env.fake.message("turn-1", "Done.");
  env.fake.completed("turn-1");
  await sleep(DELAY * 2);
  assert.equal(checkpoints(env).length, 0);
  env.fake.settings("default");
  env.fake.started("turn-2");
  env.fake.message("turn-2", "Back again.");
  env.fake.completed("turn-2");
  await until(() => live(env)[0], "checkpoint after a new turn");
});

test("SessionEnd and thread/closed cancel the pending card of the thread", async () => {
  const env = await setup();
  const d = await seedCheckpoint(env);
  env.fake.push("thread/closed", { threadId: THREAD });
  await until(() => env.h.store.get(d.id)!.status === "cancelled", "cancelled by thread/closed");
  assert.equal(env.h.store.get(d.id)!.status_reason, "thread_closed");

  const env2 = await setup();
  const d2 = await seedCheckpoint(env2);
  await hookEvent(env2, "SessionEnd");
  await until(() => env2.h.store.get(d2.id)!.status === "cancelled", "cancelled by SessionEnd");
});

test("startCodexBridge chains the session-event callback and restores it on close", () => {
  const root = mkdtempSync(join(tmpdir(), "ukagai-cbc-chain-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const seen: string[] = [];
  const store = { onSessionEvent: (id: string, ev: string) => void seen.push(`${id}:${ev}`) } as unknown as Store;
  const prev = store.onSessionEvent;
  const bridge = startCodexBridge({ store, dataDir: root, lang: "en", codexHome: join(root, "none"), log: () => {} });
  store.onSessionEvent!("claude-1", "UserPromptSubmit");
  assert.deepEqual(seen, ["claude-1:UserPromptSubmit"], "the recap watcher's callback still runs");
  assert.notEqual(store.onSessionEvent, prev);
  bridge.close();
  assert.equal(store.onSessionEvent, prev);
});

test("no Codex TUI in the thread's folder: skipped as tui_gone, no checkpoint", async () => {
  const env = await setup();
  env.tui.value = false;
  env.fake.turn("turn-1", "Done.");
  await until(() => env.tui.asked.length > 0, "probe asked");
  await sleep(DELAY / 2);
  assert.deepEqual(env.tui.asked, [CWD]);
  assert.equal(checkpoints(env).length, 0);
  const log = readFileSync(join(env.dataDir, "codex-bridge.log"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(log.some((e) => e.event === "checkpoint_skipped" && e.reason === "tui_gone" && e.thread === THREAD && e.turn === "turn-1" && e.cwd === CWD), "tui_gone logged with the cwd");
});

test("a TUI running in the folder: the checkpoint is created", async () => {
  const env = await setup();
  env.tui.value = true;
  env.fake.turn("turn-1", "Done.");
  await until(() => live(env)[0], "checkpoint");
  assert.deepEqual(env.tui.asked, [CWD]);
});

test("the probe cannot tell (undefined): the checkpoint is created", async () => {
  const env = await setup();
  env.tui.value = undefined;
  env.fake.turn("turn-1", "Done.");
  await until(() => live(env)[0], "checkpoint");
});

test("tui_gone is not sticky: the next turn (after codex resume) with a TUI creates a checkpoint", async () => {
  const env = await setup();
  env.tui.value = false;
  env.fake.turn("turn-1", "Done.");
  await until(() => env.tui.asked.length > 0, "probe asked");
  await sleep(DELAY / 2);
  assert.equal(checkpoints(env).length, 0);
  env.tui.value = true;
  env.fake.turn("turn-2", "Done again.");
  const d = await until(() => live(env)[0], "checkpoint");
  assert.match(JSON.stringify(d), /Done again/);
});

test("SessionEnd while the TUI probe is in flight: no checkpoint", async () => {
  const env = await setup();
  let release!: () => void;
  env.tui.gate = new Promise<void>((r) => (release = r));
  env.fake.turn("turn-1", "Done.");
  await until(() => env.tui.asked.length > 0, "probe asked");
  await hookEvent(env, "SessionEnd");
  await sleep(50);
  release();
  await sleep(200);
  assert.equal(checkpoints(env).length, 0);
});

test("turn/started while the TUI probe is in flight: no checkpoint for the old turn", async () => {
  const env = await setup();
  let release!: () => void;
  env.tui.gate = new Promise<void>((r) => (release = r));
  env.fake.turn("turn-1", "Done.");
  await until(() => env.tui.asked.length > 0, "probe asked");
  env.fake.started("turn-2");
  await sleep(50);
  release();
  await sleep(200);
  assert.equal(checkpoints(env).length, 0);
});

test("tui_gone does not forget the thread: a turn completing without a turn/started still arms", async () => {
  const env = await setup();
  env.tui.value = false;
  env.fake.turn("turn-1", "Done.");
  await until(() => env.tui.asked.length > 0, "probe asked");
  await sleep(DELAY / 2);
  assert.equal(checkpoints(env).length, 0);
  env.tui.value = true;
  env.fake.message("turn-2", "Second, no turn/started.");
  env.fake.completed("turn-2");
  const d = await until(() => live(env)[0], "checkpoint");
  assert.equal((d.request as any).recap, "Second, no turn/started.");
});
