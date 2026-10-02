import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, TuiApi, type StreamEvent } from "../../src/tui/api.js";
import { App } from "../../src/tui/app.js";
import { renderMermaid, padArrows } from "../../src/tui/mermaid.js";
import { buildModel } from "../../src/tui/model.js";
import { reconnectDelay, refetch, streamLoop, type SyncApi } from "../../src/tui/sync.js";
import { renderFrame } from "../../src/tui/render.js";
import { stripAnsi, wrap } from "../../src/tui/width.js";
import type { Decision } from "../../src/contract.js";
import type { Key } from "../../src/tui/keys.js";
import { V2_MD, decision, withExplanation } from "./helpers.js";

const ch = (c: string): Key => ({ name: "char", ch: c });
const NOW = Date.parse("2026-10-02T00:00:30.000Z");

// ---- Q1-02: re-reading the token ----

test("on 401 the token is re-read and the request retried once (recovers when a server restart changes the token)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ukagai-tui-"));
  await writeFile(join(dir, "token"), "old\n");
  let accept = "old";
  const seen: string[] = [];
  const srv: Server = createServer((req, res) => {
    seen.push(req.headers.authorization ?? "");
    if (req.headers.authorization !== `Bearer ${accept}`) {
      res.writeHead(401).end("{}");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end("[]");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const { port } = srv.address() as { port: number };
    const api = new TuiApi(`http://127.0.0.1:${port}`, dir);
    assert.deepEqual(await api.listPending(), []);
    // Server restart: the token is regenerated
    accept = "new";
    await writeFile(join(dir, "token"), "new\n");
    seen.length = 0;
    assert.deepEqual(await api.listPending(), []);
    assert.deepEqual(seen, ["Bearer old", "Bearer new"]);
    // If it is still 401 after re-reading, give up (no endless retry)
    accept = "other";
    await writeFile(join(dir, "token"), "bad\n");
    seen.length = 0;
    await assert.rejects(api.listPending(), (e: unknown) => e instanceof ApiError && e.status === 401);
    assert.equal(seen.length, 2);
  } finally {
    srv.close();
  }
});

test("recovers when the token file is missing at first but readable later (null is not cached)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ukagai-tui-"));
  const srv = createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end("[]"));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const { port } = srv.address() as { port: number };
    const api = new TuiApi(`http://127.0.0.1:${port}`, dir);
    await assert.rejects(api.listPending(), ApiError);
    await writeFile(join(dir, "token"), "t");
    assert.deepEqual(await api.listPending(), []);
  } finally {
    srv.close();
  }
});

// ---- Q1-02 / Q1-19: SSE reconnection, sync and connection state ----

class FakeApi implements SyncApi {
  server: Decision[] = [];
  /** Behavior per stream() call: "fail" fails to connect, "open" connects and then drops */
  script: ("fail" | "open")[] = [];
  calls = 0;
  gone = new Set<string>();
  /** Called right after connecting (after onOpen, before the drop) */
  opened: () => void = () => {};
  async listPending() {
    return this.server.filter((d) => d.status === "pending");
  }
  async get(id: string): Promise<Decision> {
    const d = this.server.find((x) => x.id === id);
    if (!d || this.gone.has(id)) throw new ApiError("HTTP 404", 404);
    return d;
  }
  async stream(_on: (e: StreamEvent) => void, _signal: AbortSignal, onOpen?: () => void) {
    const step = this.script[this.calls++];
    if (step === "fail" || step === undefined) throw new Error("fetch failed");
    onOpen?.();
    this.opened();
  }
}

test("reconnect delay doubles from 2 seconds, capped at 5 seconds", () => {
  assert.deepEqual([1, 2, 3, 4, 9].map(reconnectDelay), [2000, 4000, 5000, 5000, 5000]);
});

test("SSE drop, wait, reconnect, sync; vanished decisions leave the list and the connection state is shown", async () => {
  const api = new FakeApi();
  const a = decision({ id: "a", created_at: "2026-10-02T00:00:00.000Z" });
  const b = decision({ id: "b", created_at: "2026-10-02T00:00:01.000Z" });
  const c = decision({ id: "c", created_at: "2026-10-02T00:00:02.000Z" });
  api.server = [a, b];
  const app = new App();
  app.server = "http://127.0.0.1:4999";
  app.replacePending(await api.listPending(), NOW);
  assert.deepEqual(app.pending().map((d) => d.id), ["a", "b"]);

  // Simulate a server restart: a is 404 (gone), b is answered, c is new. The connection fails once, then recovers
  api.server = [{ ...b, status: "answered" } as Decision, c];
  api.gone.add("a");
  api.script = ["fail", "open"];
  const ac = new AbortController();
  const sleeps: number[] = [];
  const states: (string | undefined)[] = [];
  const size = { cols: 140, rows: 24 };
  const footer = () => stripAnsi(renderFrame(app.view(NOW), size).lines.at(-1)!);
  api.opened = () => states.push(footer()); // right after connecting
  await streamLoop(api, app, ac.signal, {
    now: () => NOW,
    sleep: async (ms) => {
      sleeps.push(ms);
      if (sleeps.length === 1) states.push(footer()); // right after the first failure
      if (sleeps.length === 2) ac.abort();
    },
    onChange: () => {},
  });
  await new Promise((r) => setTimeout(r, 10)); // wait for the (async) sync in onOpen
  assert.deepEqual(sleeps, [2000, 2000], "failure: 2 seconds; connected, so the count restarts: 2 seconds");
  assert.match(states[0]!, /^Cannot connect \(http:\/\/127\.0\.0\.1:4999\)\. Reconnecting…/);
  assert.match(states[1]!, /^Reconnected/);
  assert.deepEqual(app.pending().map((d) => d.id), ["c"], "a is removed, b leaves as answered, c comes in");
  assert.equal(app.decisions.has("a"), false);
  assert.equal(app.shownId, "c");
});

test("the Reconnected message disappears after 2 seconds; the disconnected banner is red while down", () => {
  const app = new App();
  app.server = "http://x";
  app.upsert(decision(withExplanation(V2_MD)), NOW);
  app.setConnected(false, NOW);
  const raw = renderFrame(app.view(NOW), { cols: 140, rows: 24 }).lines.at(-1)!;
  assert.ok(raw.includes("\x1b[1m\x1b[31mCannot connect"), "red");
  app.setConnected(true, NOW);
  const restored = (now: number) => stripAnsi(renderFrame(app.view(now), { cols: 140, rows: 24 }).lines.at(-1)!);
  assert.match(restored(NOW + 1900), /^Reconnected/);
  assert.ok(!restored(NOW + 2100).includes("Reconnected"));
});

test("refetch: a 404 removes the decision, but other failures (500 etc.) keep it", async () => {
  const api = new FakeApi();
  const a = decision({ id: "a" });
  const app = new App();
  app.upsert(a, NOW);
  api.server = [];
  api.get = async () => {
    throw new ApiError("HTTP 500", 500);
  };
  await refetch(api, app, () => NOW);
  assert.equal(app.decisions.has("a"), true);
  api.get = async () => {
    throw new ApiError("HTTP 404", 404);
  };
  await refetch(api, app, () => NOW);
  assert.equal(app.decisions.has("a"), false);
  assert.equal(app.shownId, null);
});

// ---- Q1-08: focus does not carry over between decisions ----

const LONG = V2_MD + "\n" + Array.from({ length: 80 }, (_, i) => `- row ${i}`).join("\n") + "\n";
const SIZE = { cols: 140, rows: 24 };
let t = 1000;
const press = (app: App, ...keys: Key[]) => keys.flatMap((k) => app.handle(k, (t += 10)));

test("switching decisions returns focus to the decision column (h / l / list / auto-advance after answering)", () => {
  const mk = () => {
    const app = new App();
    app.upsert(decision({ id: "d1", created_at: "2026-10-02T00:00:00.000Z", ...withExplanation(LONG) }), t);
    app.upsert(decision({ id: "d2", created_at: "2026-10-02T00:00:01.000Z", ...withExplanation(LONG) }), t);
    app.syncFrame(renderFrame(app.view(t), SIZE));
    return app;
  };
  for (const keys of [[ch("l")], [ch("h")], [ch("b"), ch("j"), { name: "enter" } as Key]]) {
    const app = mk();
    press(app, { name: "tab" });
    assert.equal(app.focus, "background");
    press(app, ...keys);
    assert.equal(app.focus, "decision", JSON.stringify(keys));
    const before = app.view(t).cursor;
    press(app, ch("j"));
    assert.notEqual(app.view(t).cursor, before, "j moves the decision cursor");
  }
  // Answer, then auto-advance
  const app = mk();
  press(app, { name: "tab" });
  app.answered({ ...app.decisions.get("d1")!, status: "answer_submitted" } as Decision, t);
  assert.equal(app.shownId, "d2");
  assert.equal(app.focus, "decision");
});

test("headings: the focused column is ▶ + inverted, the other is dim without ▶ (readable without color)", () => {
  const app = new App();
  app.upsert(decision(withExplanation(LONG)), t);
  const head = (focus: "background" | "decision") => {
    const f = renderFrame({ ...app.view(t), focus }, SIZE);
    return f.lines.find((l) => l.includes("Background") && l.includes("Decision"))!;
  };
  const d = head("decision");
  assert.match(stripAnsi(d), /Background.*▶ Decision/);
  assert.ok(!stripAnsi(d).includes("▶ Background"));
  assert.ok(d.includes("\x1b[7m ▶ Decision"));
  assert.ok(d.includes("\x1b[2m   Background"));
  const b = head("background");
  assert.match(stripAnsi(b), /▶ Background.*Decision/);
  assert.ok(!stripAnsi(b).includes("▶ Decision"));
});

// ---- Q1-03: A-->B ----

test("A-->B (no spaces) becomes 2 nodes, as do the other arrow notations", () => {
  const nodes = (src: string) => {
    const r = renderMermaid(src);
    assert.ok(r.ok);
    return r.ok ? r.lines.join("\n") : "";
  };
  for (const arrow of ["-->", "---", "-.->", "==>", "<-->", "--x", "--o"]) {
    const text = nodes(`flowchart LR\n  A${arrow}B`);
    assert.ok(/│ A\s.*│ B /.test(text) || (text.includes("│ A ") && text.includes("│ B ")), `${arrow}\n${text}`);
    assert.ok(!text.includes("A--"), arrow);
  }
  assert.equal(nodes("flowchart LR\n  A-->B"), nodes("flowchart LR\n  A --> B"));
  assert.equal(nodes("flowchart LR\n  A[x]-->|t|B[y]"), nodes("flowchart LR\n  A[x] -->|t| B[y]"));
  assert.equal(nodes("graph TD\n  A-->B-->C"), nodes("graph TD\n  A --> B --> C"));
});

test("padArrows: leaves arrows inside labels / quotes / edge labels alone, and leaves sequenceDiagram alone", () => {
  assert.equal(padArrows("flowchart LR\n  A[a-->b]-->B"), "flowchart LR\n  A[a-->b] --> B");
  assert.equal(padArrows('flowchart LR\n  A["x-->y"]-->B'), 'flowchart LR\n  A["x-->y"] --> B');
  assert.equal(padArrows("flowchart LR\n  A-->|a-->b|B"), "flowchart LR\n  A -->|a-->b| B");
  assert.equal(padArrows("sequenceDiagram\n  A-->>B: hi"), "sequenceDiagram\n  A-->>B: hi");
  assert.equal(padArrows("flowchart LR\n  A --> B"), "flowchart LR\n  A --> B");
});

// ---- Q1-17: no scrollbar when everything fits ----

const wideChain = (n: number) => Array.from({ length: n }, (_, i) => `N${i}[調査${i}]`).join(" --> ");
const FIG = `${V2_MD.split("## Diagram")[0]}## Diagram\n\n\`\`\`mermaid\nflowchart LR\n  ${wideChain(9)}\n\`\`\`\n`;

test("when the background fits vertically, neither the scrollbar nor the ▲▼ position row appears even with a wide diagram; both appear when it does not fit", () => {
  const app = new App();
  app.upsert(decision(withExplanation(FIG)), t);
  const f = renderFrame(app.view(t), { cols: 140, rows: 40 });
  assert.ok(f.hMax > 0 && f.scrollMax === 0);
  const text = f.lines.map(stripAnsi).join("\n");
  assert.ok(!text.includes("█") && !/\d+-\d+\/\d+/.test(text), text);
  const short = renderFrame(app.view(t), { cols: 140, rows: 14 });
  assert.ok(short.scrollMax > 0);
  assert.ok(short.lines.map(stripAnsi).join("\n").includes("█"));
});

// ---- Q1-18: line-breaking rules (kinsoku) ----

test("wrapping never starts a line with punctuation or a closing bracket (the previous character moves along)", () => {
  const src = "あいうえお。かきくけこ、さしすせそ）たちつてと」なにぬねの";
  for (let w = 4; w <= 14; w++) {
    const lines = wrap(src, w).map(stripAnsi);
    for (const l of lines.slice(1)) assert.ok(!/^[。、）」』】,.!?]/.test(l), `w=${w}: ${JSON.stringify(lines)}`);
    assert.equal(lines.join(""), src, "no characters are lost");
    for (const l of lines) assert.ok(Array.from(l).length * 1 <= w * 2);
  }
  assert.deepEqual(wrap("ああ。い", 4).map(stripAnsi), ["あ", "あ。", "い"]);
  // Still lossless with ANSI sequences
  const sty = wrap("\x1b[1mあいう\x1b[0m。えお", 6);
  assert.ok(!stripAnsi(sty[1]!).startsWith("。"));
  assert.equal(sty.map(stripAnsi).join(""), "あいう。えお");
});

// ---- (Recommended) and none_reason ----

test("without an explanation: none_reason is plain text and (Recommended) does not appear in the list", () => {
  const none = (reason: string, over: Record<string, unknown> = {}) =>
    decision({ explanation: { path: "", markdown: "", has: { mermaid: false, table: false, diff: false }, match: "recency", attached_via: "none", none_reason: reason }, ...over } as never);
  const note = (r: string) => buildModel(none(r)).backgroundNote;
  assert.match(note("loop_guard")!, /reason: it did not follow the instruction to rewrite\)/);
  assert.match(note("plan_mode")!, /reason: plan mode\)/);
  assert.match(note("not_required")!, /reason: explanations were not required\)/);
  for (const r of ["loop_guard", "plan_mode", "not_required"]) assert.ok(!note(r)!.includes(r));

  const app = new App();
  app.upsert(none("loop_guard", { session: { session_id: "s", cwd: "/x", transcript_path: "/x", title: "Which one? (Recommended)" } }), NOW);
  app.upsert(
    decision({
      id: "d2",
      created_at: "2026-10-02T00:00:01.000Z",
      explanation: { path: "", markdown: "", has: { mermaid: false, table: false, diff: false }, match: "recency", attached_via: "none" },
      request: { questions: [{ question: "Which? （推奨）", header: "h", multiSelect: false, options: [{ label: "A (Recommended)" }, { label: "B" }] }] },
    } as never),
    NOW,
  );
  press(app, ch("b"));
  const out = stripAnsi(renderFrame(app.view(NOW), { cols: 100, rows: 20 }).text);
  assert.ok(!out.includes("Recommended") && !out.includes("推奨"), out);
  assert.ok(out.includes("Which one?") && out.includes("Which?"));
  press(app, { name: "esc" }, ch("l"));
  const card = stripAnsi(renderFrame(app.view(NOW), { cols: 100, rows: 30 }).text);
  // The suffix is stripped from the label; the UI shows its own badge instead
  assert.ok(!card.includes("(Recommended)") && card.includes("A "), card);
});
