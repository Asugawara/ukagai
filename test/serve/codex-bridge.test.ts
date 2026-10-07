import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { startCodexBridge } from "../../src/serve/codex-bridge/index.js";
import { run, start, type ServeHandle } from "../../src/serve/index.js";

const THREAD = "00000000-0000-4000-8000-000000000026";
const CWD = "/work/proj";
const PLAN = "# Create `hello.txt`\n\n1. Add `hello.txt` at the project root.\n2. Read it back.\n\n## Scope and reversibility\n\nReversibility: reversible\nScope: file\n";

const cleanup: (() => Promise<void> | void)[] = [];
after(async () => {
  for (const fn of cleanup.reverse()) await fn();
});

/** A stand-in for the Codex daemon: a WebSocket server on a unix socket that records every request */
class FakeServer {
  sockets = new Set<WebSocket>();
  received: any[] = [];
  connections = 0;
  loadedList: string[] = [THREAD];
  resumeError: string | undefined;
  mode = "default";
  private http: Server;
  private wss: WebSocketServer;

  constructor(public socketPath: string) {
    this.http = createServer();
    this.wss = new WebSocketServer({ server: this.http });
    this.wss.on("connection", (ws) => {
      this.connections++;
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
    switch (m.method) {
      case "initialize":
        return reply({ userAgent: "codex-tui/0.159.3 (fake)", codexHome: "/fake", platformFamily: "unix", platformOs: "macos" });
      case "thread/loaded/list":
        return reply({ data: this.loadedList, nextCursor: null });
      case "thread/resume":
        if (this.resumeError) return void ws.send(JSON.stringify({ id: m.id, error: { code: -32600, message: this.resumeError } }));
        return reply({
          thread: { id: m.params.threadId, preview: "Run the shell command: echo hi", name: "Run echo hi", ephemeral: false, cwd: CWD },
          model: "gpt-5.6-sol",
          cwd: CWD,
          reasoningEffort: "low",
          collaborationMode: { mode: this.mode, settings: { model: "gpt-5.6-sol", reasoning_effort: "low", developer_instructions: "x" } },
        });
      default:
        return reply({ turn: { id: "t-new" } });
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

  /** The events of a finished plan turn (D1's c1.jsonl: settings → turn/started → plan item → turn/completed) */
  planTurn(turnId: string, text = PLAN, mode = "plan"): void {
    this.settings(mode);
    this.push("turn/started", { threadId: THREAD, turn: { id: turnId, items: [], status: "inProgress" } });
    this.push("item/started", { threadId: THREAD, turnId, item: { type: "plan", id: `${turnId}-plan`, text: "" } });
    this.push("item/completed", { threadId: THREAD, turnId, item: { type: "plan", id: `${turnId}-plan`, text } });
    this.push("thread/status/changed", { threadId: THREAD, status: { type: "idle" } });
    this.push("turn/completed", { threadId: THREAD, turn: { id: turnId, items: [], status: "completed" } });
  }

  methods(name: string): any[] {
    return this.received.filter((m) => m.method === name);
  }

  dropClients(): void {
    for (const ws of this.sockets) ws.terminate();
  }

  close(): Promise<void> {
    this.dropClients();
    this.wss.close();
    return new Promise((r) => {
      this.http.close(() => r());
      this.http.closeAllConnections();
    });
  }
}

type Env = { fake: FakeServer; h: ServeHandle; url: string; codexHome: string; dataDir: string };

/** `codexHome/app-server-control/app-server-control.sock` is a symlink to a short real socket, like the real daemon */
async function setup(opts: { fake?: boolean; bridge?: boolean; lang?: "en" | "ja"; resumeError?: string } = {}): Promise<Env> {
  const root = mkdtempSync(join(tmpdir(), "ukagai-cb-"));
  const short = mkdtempSync("/tmp/ukcb-");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  cleanup.push(() => rmSync(short, { recursive: true, force: true }));
  const codexHome = join(root, "codex");
  const dataDir = join(root, "data");
  mkdirSync(join(codexHome, "app-server-control"), { recursive: true });
  const fake = new FakeServer(join(short, "s.sock"));
  fake.resumeError = opts.resumeError;
  if (opts.fake !== false) {
    await fake.listen();
    symlinkSync(join(short, "s.sock"), join(codexHome, "app-server-control", "app-server-control.sock"));
  }
  cleanup.push(() => fake.close());
  if (opts.lang) {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ lang: opts.lang }));
  }
  const h = await start({ port: 0, dataDir, home: root, codexBridge: opts.bridge ?? true, codexHome });
  cleanup.push(() => h.close());
  return { fake, h, url: `http://127.0.0.1:${h.port}`, codexHome, dataDir };
}

function call(env: Env, path: string, body?: unknown) {
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
    await new Promise((r) => setTimeout(r, 20));
  }
}

const plans = (env: Env) => env.h.store.list().filter((d) => d.kind === "approve_plan");

async function ready(env: Env): Promise<void> {
  await until(() => env.fake.methods("thread/resume").length > 0, "thread/resume");
}

test("a plan turn registers one approve_plan decision, even if the turn is replayed", async () => {
  const env = await setup();
  await ready(env);
  env.fake.planTurn("turn-1");
  const d = await until(() => plans(env)[0], "approve_plan decision");
  assert.equal(d.status, "pending");
  assert.equal((d.request as any).plan, PLAN);
  assert.equal(d.session.agent, "codex");
  assert.equal(d.session.session_id, THREAD);
  assert.equal(d.session.cwd, CWD);
  assert.equal(d.session.transcript_path, "");
  assert.equal(d.session.title, "Run echo hi");
  assert.equal(d.explanation?.reversibility, "reversible");
  assert.equal(d.explanation?.scope, "file");
  assert.match(d.explanation!.markdown, /No, stay in Plan mode/);
  // protocol: initialize → initialized → thread/loaded/list → thread/resume {excludeTurns}
  assert.deepEqual(env.fake.received.slice(0, 4).map((m) => m.method), ["initialize", "initialized", "thread/loaded/list", "thread/resume"]);
  assert.equal(env.fake.methods("thread/resume")[0].params.excludeTurns, true);
  // the same turn again: still one decision
  env.fake.push("turn/completed", { threadId: THREAD, turn: { id: "turn-1" } });
  env.fake.push("item/completed", { threadId: THREAD, turnId: "turn-1", item: { type: "plan", text: PLAN } });
  env.fake.push("turn/completed", { threadId: THREAD, turn: { id: "turn-1" } });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(plans(env).length, 1);
});

test("the note is Japanese when the display language is ja", async () => {
  const env = await setup({ lang: "ja" });
  await ready(env);
  env.fake.planTurn("turn-ja");
  const d = await until(() => plans(env)[0], "decision");
  assert.match(d.explanation!.markdown, /No, stay in Plan mode/);
  assert.match(d.explanation!.markdown, /端末に残ります/);
});

test("a plan item in Default mode is not registered", async () => {
  const env = await setup();
  await ready(env);
  env.fake.planTurn("turn-d", PLAN, "default");
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(plans(env).length, 0);
});

test("Approve sends turn/start in default mode with the thread's model / effort, then the decision is answered", async () => {
  const env = await setup();
  await ready(env);
  env.fake.planTurn("turn-a");
  const d = await until(() => plans(env)[0], "decision");
  const r = await call(env, `/api/decisions/${d.id}/answer`, { approve: true });
  assert.equal(r.status, 200);
  const ts = await until(() => env.fake.methods("turn/start")[0], "turn/start");
  assert.deepEqual(ts.params, {
    threadId: THREAD,
    input: [{ type: "text", text: "Implement the plan.", text_elements: [] }],
    collaborationMode: { mode: "default", settings: { model: "gpt-5.6-sol", reasoning_effort: "medium", developer_instructions: null } },
  });
  await until(() => env.h.store.get(d.id)?.status === "answered", "answered");
  assert.ok(env.h.store.get(d.id)?.response?.delivered_at);
});

test("Approve and auto sends the same turn/start", async () => {
  const env = await setup();
  await ready(env);
  env.fake.planTurn("turn-auto");
  const d = await until(() => plans(env)[0], "decision");
  await call(env, `/api/decisions/${d.id}/answer`, { approve: true, set_mode_auto: true });
  const ts = await until(() => env.fake.methods("turn/start")[0], "turn/start");
  assert.equal(ts.params.input[0].text, "Implement the plan.");
  assert.equal(ts.params.collaborationMode.mode, "default");
});

test("Reject with feedback sends turn/start in plan mode with the feedback", async () => {
  const env = await setup();
  await ready(env);
  env.fake.planTurn("turn-r");
  const d = await until(() => plans(env)[0], "decision");
  await call(env, `/api/decisions/${d.id}/answer`, { approve: false, reason: "Add a third step: run the tests." });
  const ts = await until(() => env.fake.methods("turn/start")[0], "turn/start");
  assert.equal(ts.params.collaborationMode.mode, "plan");
  assert.equal(ts.params.input[0].text, "Add a third step: run the tests.");
  await until(() => env.h.store.get(d.id)?.status === "answered", "answered");
});

test("Instruct sends turn/start in plan mode with the text and acks the decision", async () => {
  const env = await setup();
  await ready(env);
  env.fake.planTurn("turn-i");
  const d = await until(() => plans(env)[0], "decision");
  const r = await call(env, `/api/decisions/${d.id}/answer`, { instruct: true, text: "Review the plan for gaps first." });
  assert.equal(r.status, 200);
  const ts = await until(() => env.fake.methods("turn/start")[0], "turn/start");
  assert.equal(ts.params.collaborationMode.mode, "plan");
  assert.match(ts.params.input[0].text, /^The human has not approved the plan yet and asks you to do this first: Review the plan for gaps first\.\n/);
  await until(() => env.h.store.get(d.id)?.status === "answered", "answered");
  assert.ok(env.h.store.get(d.id)?.response?.delivered_at);
});

test("Reject without feedback (no reason, or whitespace only) sends nothing", async () => {
  const env = await setup();
  await ready(env);
  env.fake.planTurn("turn-r0");
  const d = await until(() => plans(env)[0], "decision");
  await call(env, `/api/decisions/${d.id}/answer`, { approve: false, reason: " " });
  await until(() => env.h.store.get(d.id)?.status === "answered", "answered");
  assert.equal(env.fake.methods("turn/start").length, 0);
});

test("Reject without a reason ({ approve: false }) takes the no-feedback ack: answered, no turn", async () => {
  const env = await setup();
  await ready(env);
  env.fake.planTurn("turn-r00");
  const d = await until(() => plans(env)[0], "decision");
  await call(env, `/api/decisions/${d.id}/answer`, { approve: false });
  await until(() => env.h.store.get(d.id)?.status === "answered", "answered");
  assert.equal(env.fake.methods("turn/start").length, 0);
});

test("the terminal's own 'Implement the plan.' cancels the pending decision as answered_elsewhere", async () => {
  const env = await setup();
  await ready(env);
  env.fake.planTurn("turn-t");
  const d = await until(() => plans(env)[0], "decision");
  env.fake.push("turn/started", { threadId: THREAD, turn: { id: "turn-next" } });
  env.fake.push("item/started", {
    threadId: THREAD,
    turnId: "turn-next",
    item: { type: "userMessage", id: "u1", clientId: "tui", content: [{ type: "text", text: "Implement the plan.", text_elements: [] }] },
  });
  await until(() => env.h.store.get(d.id)?.status === "cancelled", "cancelled");
  assert.equal(env.h.store.get(d.id)?.status_reason, "answered_elsewhere");
  assert.equal(env.fake.methods("turn/start").length, 0);
});

test("any next turn cancels the pending decision, but the plan's own turn does not", async () => {
  const env = await setup();
  await ready(env);
  env.fake.planTurn("turn-p");
  const d = await until(() => plans(env)[0], "decision");
  // a late replay of the plan turn's own turn/started is not "the terminal moved on"
  env.fake.push("turn/started", { threadId: THREAD, turn: { id: "turn-p" } });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(env.h.store.get(d.id)?.status, "pending");
  env.fake.push("turn/started", { threadId: THREAD, turn: { id: "turn-other" } });
  await until(() => env.h.store.get(d.id)?.status === "cancelled", "cancelled");
});

test("a dropped socket reconnects and starts again from thread/loaded/list", async () => {
  const env = await setup();
  await ready(env);
  assert.equal(env.fake.connections, 1);
  env.fake.dropClients();
  await until(() => env.fake.connections === 2, "reconnect", 8000);
  await until(() => env.fake.methods("thread/loaded/list").length === 2 && env.fake.methods("thread/resume").length === 2, "resume again");
  env.fake.planTurn("turn-after");
  assert.ok(await until(() => plans(env)[0], "decision after reconnect"));
});

test("'no rollout found' on resume is retried on the next active status", async () => {
  const env = await setup({ resumeError: "no rollout found for thread id " + THREAD });
  await until(() => env.fake.methods("thread/resume").length === 1, "failed resume");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(env.fake.methods("thread/resume").length, 1);
  env.fake.resumeError = undefined;
  env.fake.push("thread/status/changed", { threadId: THREAD, status: { type: "active", activeFlags: [] } });
  await until(() => env.fake.methods("thread/resume").length === 2, "retry on active");
  // once resumed, further active statuses do not resume again
  env.fake.push("thread/status/changed", { threadId: THREAD, status: { type: "active", activeFlags: [] } });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(env.fake.methods("thread/resume").length, 2);
});

test("an ephemeral thread is not resumed", async () => {
  const env = await setup();
  await ready(env);
  const before = env.fake.methods("thread/resume").length;
  env.fake.push("thread/started", { thread: { id: "eph-1", ephemeral: true, cwd: CWD, preview: "" } });
  env.fake.push("thread/status/changed", { threadId: "eph-1", status: { type: "active", activeFlags: [] } });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(env.fake.methods("thread/resume").length, before);
});

test("server requests (approval / question) are not answered", async () => {
  const env = await setup();
  await ready(env);
  for (const ws of env.fake.sockets) {
    ws.send(JSON.stringify({ id: 0, method: "item/commandExecution/requestApproval", params: { threadId: THREAD } }));
    ws.send(JSON.stringify({ id: 1, method: "item/tool/requestUserInput", params: { threadId: THREAD, questions: [] } }));
  }
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(env.fake.received.filter((m) => m.method === undefined).length, 0);
  assert.equal(plans(env).length, 0);
});

test("without a socket serve runs normally; the bridge connects once the socket appears", async () => {
  const env = await setup({ fake: false });
  assert.equal((await fetch(env.url + "/healthz")).status, 200);
  assert.equal(env.fake.connections, 0);
  // a bridge with a short poll interval picks the socket up when it shows up later
  await env.fake.listen();
  symlinkSync(env.fake.socketPath, join(env.codexHome, "app-server-control", "app-server-control.sock"));
  const bridge = startCodexBridge({ store: env.h.store, dataDir: env.dataDir, lang: "en", codexHome: env.codexHome, pollMs: 40 });
  cleanup.push(() => bridge.close());
  await until(() => env.fake.connections === 1, "late connect");
});

test("a broken socket path never takes serve down", async () => {
  const env = await setup({ fake: false });
  // a regular file where the socket should be: the connect fails, serve keeps answering
  writeFileSync(join(env.codexHome, "app-server-control", "app-server-control.sock"), "");
  const bridge = startCodexBridge({ store: env.h.store, dataDir: env.dataDir, lang: "en", codexHome: env.codexHome, pollMs: 40, backoffMs: 30 });
  cleanup.push(() => bridge.close());
  await until(() => {
    try {
      return /connect_failed/.test(readFileSync(join(env.dataDir, "codex-bridge.log"), "utf8"));
    } catch {
      return false;
    }
  }, "connect_failed in codex-bridge.log");
  assert.equal((await fetch(env.url + "/healthz")).status, 200);
});

test("with the bridge off nothing connects", async () => {
  const env = await setup({ bridge: false });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(env.fake.connections, 0);
  assert.equal(env.h.codexBridge, undefined);
});

async function runServe(extra: string[], fake: FakeServer, codexHome: string): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "ukagai-cb-run-"));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const out = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  const done = run(["--port", "0", "--data-dir", dataDir, "--codex-home", codexHome, ...extra]);
  try {
    await new Promise((r) => setTimeout(r, 500));
  } finally {
    process.stdout.write = out;
    process.emit("SIGINT");
  }
  assert.equal(await done, 0);
}

test("`serve --codex-home <dir>` connects; `--no-codex-bridge` does not", async () => {
  const on = await setup({ bridge: false });
  await runServe([], on.fake, on.codexHome);
  assert.equal(on.fake.connections, 1);
  const off = await setup({ bridge: false });
  await runServe(["--no-codex-bridge"], off.fake, off.codexHome);
  assert.equal(off.fake.connections, 0);
});
