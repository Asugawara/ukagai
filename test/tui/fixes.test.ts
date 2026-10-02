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

// ---- Q1-02: token の読み直し ----

test("401 なら token を読み直して 1 度だけやり直す(server 再起動で token が変わっても復帰する)", async () => {
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
    // server 再起動: token が作り直される
    accept = "new";
    await writeFile(join(dir, "token"), "new\n");
    seen.length = 0;
    assert.deepEqual(await api.listPending(), []);
    assert.deepEqual(seen, ["Bearer old", "Bearer new"]);
    // 読み直しても 401 なら諦める(無限に繰り返さない)
    accept = "other";
    await writeFile(join(dir, "token"), "bad\n");
    seen.length = 0;
    await assert.rejects(api.listPending(), (e: unknown) => e instanceof ApiError && e.status === 401);
    assert.equal(seen.length, 2);
  } finally {
    srv.close();
  }
});

test("token ファイルが一時的に無くても、あとで読めれば復帰する(null を覚えない)", async () => {
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

// ---- Q1-02 / Q1-19: SSE の再接続と同期、接続状態 ----

class FakeApi implements SyncApi {
  server: Decision[] = [];
  /** stream() の呼び出しごとの振る舞い。"fail" は接続失敗、"open" はつながって切れる */
  script: ("fail" | "open")[] = [];
  calls = 0;
  gone = new Set<string>();
  /** つながった直後(onOpen のあと、切れる前)に呼ぶ */
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

test("再接続の待ちは 2 秒から倍々で 5 秒が上限", () => {
  assert.deepEqual([1, 2, 3, 4, 9].map(reconnectDelay), [2000, 4000, 5000, 5000, 5000]);
});

test("SSE 切断 → 待って再接続 → つながったら同期し、消えた判断は一覧から除かれる。接続状態が表に出る", async () => {
  const api = new FakeApi();
  const a = decision({ id: "a", created_at: "2026-10-02T00:00:00.000Z" });
  const b = decision({ id: "b", created_at: "2026-10-02T00:00:01.000Z" });
  const c = decision({ id: "c", created_at: "2026-10-02T00:00:02.000Z" });
  api.server = [a, b];
  const app = new App();
  app.server = "http://127.0.0.1:4999";
  app.replacePending(await api.listPending(), NOW);
  assert.deepEqual(app.pending().map((d) => d.id), ["a", "b"]);

  // server 再起動を模す: a は 404(消えた)、b は answered、c は新着。接続は 1 回失敗してから戻る
  api.server = [{ ...b, status: "answered" } as Decision, c];
  api.gone.add("a");
  api.script = ["fail", "open"];
  const ac = new AbortController();
  const sleeps: number[] = [];
  const states: (string | undefined)[] = [];
  const size = { cols: 140, rows: 24 };
  const footer = () => stripAnsi(renderFrame(app.view(NOW), size).lines.at(-1)!);
  api.opened = () => states.push(footer()); // つながった直後
  await streamLoop(api, app, ac.signal, {
    now: () => NOW,
    sleep: async (ms) => {
      sleeps.push(ms);
      if (sleeps.length === 1) states.push(footer()); // 1 回目の失敗の直後
      if (sleeps.length === 2) ac.abort();
    },
    onChange: () => {},
  });
  await new Promise((r) => setTimeout(r, 10)); // onOpen の同期(非同期)を待つ
  assert.deepEqual(sleeps, [2000, 2000], "失敗 → 2 秒、つながったので数え直し → 2 秒");
  assert.match(states[0]!, /^接続できません\(http:\/\/127\.0\.0\.1:4999\) 再接続中…/);
  assert.match(states[1]!, /^再接続しました/);
  assert.deepEqual(app.pending().map((d) => d.id), ["c"], "a は除かれ、b は answered で外れ、c が入る");
  assert.equal(app.decisions.has("a"), false);
  assert.equal(app.shownId, "c");
});

test("再接続しました は 2 秒で消える。切れている間は赤", () => {
  const app = new App();
  app.server = "http://x";
  app.upsert(decision(withExplanation(V2_MD)), NOW);
  app.setConnected(false, NOW);
  const raw = renderFrame(app.view(NOW), { cols: 140, rows: 24 }).lines.at(-1)!;
  assert.ok(raw.includes("\x1b[1m\x1b[31m接続できません"), "赤");
  app.setConnected(true, NOW);
  const restored = (now: number) => stripAnsi(renderFrame(app.view(now), { cols: 140, rows: 24 }).lines.at(-1)!);
  assert.match(restored(NOW + 1900), /^再接続しました/);
  assert.ok(!restored(NOW + 2100).includes("再接続しました"));
});

test("refetch: 404 は除くが、別の失敗(500 など)では残す", async () => {
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

// ---- Q1-08: フォーカスは判断をまたがない ----

const LONG = V2_MD + "\n" + Array.from({ length: 80 }, (_, i) => `- 行 ${i}`).join("\n") + "\n";
const SIZE = { cols: 140, rows: 24 };
let t = 1000;
const press = (app: App, ...keys: Key[]) => keys.flatMap((k) => app.handle(k, (t += 10)));

test("判断を切り替えるとフォーカスが判断列に戻る(h / l / 一覧 / 回答後の自動遷移)", () => {
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
    assert.notEqual(app.view(t).cursor, before, "j は判断のカーソルを動かす");
  }
  // 回答 → 自動遷移
  const app = mk();
  press(app, { name: "tab" });
  app.answered({ ...app.decisions.get("d1")!, status: "answer_submitted" } as Decision, t);
  assert.equal(app.shownId, "d2");
  assert.equal(app.focus, "decision");
});

test("見出し: フォーカス中の列は ▶ + 反転、もう一方は dim で ▶ なし(色なしでも分かる)", () => {
  const app = new App();
  app.upsert(decision(withExplanation(LONG)), t);
  const head = (focus: "background" | "decision") => {
    const f = renderFrame({ ...app.view(t), focus }, SIZE);
    return f.lines.find((l) => l.includes("背景") && l.includes("判断"))!;
  };
  const d = head("decision");
  assert.match(stripAnsi(d), /背景.*▶ 判断/);
  assert.ok(!stripAnsi(d).includes("▶ 背景"));
  assert.ok(d.includes("\x1b[7m ▶ 判断"));
  assert.ok(d.includes("\x1b[2m   背景"));
  const b = head("background");
  assert.match(stripAnsi(b), /▶ 背景.*判断/);
  assert.ok(!stripAnsi(b).includes("▶ 判断"));
});

// ---- Q1-03: A-->B ----

test("A-->B(空白なし)が 2 ノードになる。他の矢印記法も", () => {
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

test("padArrows: ラベル / 引用符 / 辺ラベルの中の矢印は触らない。sequenceDiagram は触らない", () => {
  assert.equal(padArrows("flowchart LR\n  A[a-->b]-->B"), "flowchart LR\n  A[a-->b] --> B");
  assert.equal(padArrows('flowchart LR\n  A["x-->y"]-->B'), 'flowchart LR\n  A["x-->y"] --> B');
  assert.equal(padArrows("flowchart LR\n  A-->|a-->b|B"), "flowchart LR\n  A -->|a-->b| B");
  assert.equal(padArrows("sequenceDiagram\n  A-->>B: hi"), "sequenceDiagram\n  A-->>B: hi");
  assert.equal(padArrows("flowchart LR\n  A --> B"), "flowchart LR\n  A --> B");
});

// ---- Q1-17: 収まるときはバー無し ----

const wideChain = (n: number) => Array.from({ length: n }, (_, i) => `N${i}[調査${i}]`).join(" --> ");
const FIG = `${V2_MD.split("## 図")[0]}## 図\n\n\`\`\`mermaid\nflowchart LR\n  ${wideChain(9)}\n\`\`\`\n`;

test("背景が縦に収まるなら、幅超過の図があってもスクロールバーも ▲▼ の位置行も出さない。収まらないときは出る", () => {
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

// ---- Q1-18: 禁則 ----

test("折り返しで行頭に句読点・閉じ括弧が来ない(直前の 1 文字を一緒に送る)", () => {
  const src = "あいうえお。かきくけこ、さしすせそ）たちつてと」なにぬねの";
  for (let w = 4; w <= 14; w++) {
    const lines = wrap(src, w).map(stripAnsi);
    for (const l of lines.slice(1)) assert.ok(!/^[。、）」』】,.!?]/.test(l), `w=${w}: ${JSON.stringify(lines)}`);
    assert.equal(lines.join(""), src, "文字は欠けない");
    for (const l of lines) assert.ok(Array.from(l).length * 1 <= w * 2);
  }
  assert.deepEqual(wrap("ああ。い", 4).map(stripAnsi), ["あ", "あ。", "い"]);
  // ANSI を含んでいても欠けない
  const sty = wrap("\x1b[1mあいう\x1b[0m。えお", 6);
  assert.ok(!stripAnsi(sty[1]!).startsWith("。"));
  assert.equal(sty.map(stripAnsi).join(""), "あいう。えお");
});

// ---- (Recommended) と none_reason ----

test("説明なし: none_reason は平文、(Recommended) は一覧にも出ない", () => {
  const none = (reason: string, over: Record<string, unknown> = {}) =>
    decision({ explanation: { path: "", markdown: "", has: { mermaid: false, table: false, diff: false }, match: "recency", attached_via: "none", none_reason: reason }, ...over } as never);
  const note = (r: string) => buildModel(none(r)).backgroundNote;
  assert.match(note("loop_guard")!, /理由: 書き直しの指示に従わなかったため/);
  assert.match(note("plan_mode")!, /理由: plan mode のため/);
  assert.match(note("not_required")!, /理由: 説明を要求していないため/);
  for (const r of ["loop_guard", "plan_mode", "not_required"]) assert.ok(!note(r)!.includes(r));

  const app = new App();
  app.upsert(none("loop_guard", { session: { session_id: "s", cwd: "/x", transcript_path: "/x", title: "どちらにしますか (Recommended)" } }), NOW);
  app.upsert(
    decision({
      id: "d2",
      created_at: "2026-10-02T00:00:01.000Z",
      explanation: { path: "", markdown: "", has: { mermaid: false, table: false, diff: false }, match: "recency", attached_via: "none" },
      request: { questions: [{ question: "どれ？ （推奨）", header: "h", multiSelect: false, options: [{ label: "A (Recommended)" }, { label: "B" }] }] },
    } as never),
    NOW,
  );
  press(app, ch("b"));
  const out = stripAnsi(renderFrame(app.view(NOW), { cols: 100, rows: 20 }).text);
  assert.ok(!out.includes("Recommended") && !out.includes("推奨"), out);
  assert.ok(out.includes("どちらにしますか") && out.includes("どれ？"));
  press(app, { name: "esc" }, ch("l"));
  const card = stripAnsi(renderFrame(app.view(NOW), { cols: 100, rows: 30 }).text);
  assert.ok(!card.includes("Recommended"), card);
});
