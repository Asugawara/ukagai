// GUI(public/app.js)のキー操作を、実 server + 実ブラウザ(agent-browser)で確かめる。
// agent-browser が PATH に無い環境では skip する。
import { after, before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SEED_MD = readFileSync(new URL("./fixtures/seed.md", import.meta.url), "utf8");
const HAS_BROWSER = spawnSync("agent-browser", ["--version"], { stdio: "ignore" }).status === 0;
const SEP = ", "; // MULTI_SELECT_SEPARATOR

let home = "";
let dataDir = "";
let port = 0;
let token = "";
let serve: ChildProcess | undefined;
let base = "";
let opened = false;
let seq = 0;
const session = `ukagai-gui-${process.pid}-${Date.now().toString(36)}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

function ab(...args: string[]): string {
  return execFileSync("agent-browser", args, {
    env: { ...process.env, AGENT_BROWSER_SESSION: session },
    encoding: "utf8",
    timeout: 30000,
  }).trim();
}

/** eval の標準出力(JSON 文字列)を parse する。JSON.stringify した値は二重に包まれて出る */
function ev<T = any>(js: string): T {
  const out = ab("eval", js).split("\n").at(-1)!;
  let v: unknown = JSON.parse(out);
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch {}
  }
  return v as T;
}

async function waitFor(what: string, js: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    let ok = false;
    try { ok = ev(`!!(${js})`) === true; } catch {}
    if (ok) return;
    assert.ok(Date.now() < end, `待っても満たされない: ${what}`);
    await sleep(100);
  }
}

const press = (...keys: string[]) => { for (const k of keys) ab("press", k); };

async function api(path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json() as Promise<any>;
}

type Opt = { label: string; description?: string };
type Seed = { title?: string; options?: Opt[]; multiSelect?: boolean; explain?: boolean; markdown?: string; noneReason?: string };

/** 判断を投入する。既定は v2 の説明付きの単一選択(A / B(Recommended) / C) */
async function seedQuestion(s: Seed = {}): Promise<{ id: string; title: string }> {
  const n = ++seq;
  const title = s.title ?? `キー操作の確認 ${n}`;
  const fmQuestion = s.markdown ? /^question: (.+)$/m.exec(s.markdown)![1]! : undefined;
  const question = fmQuestion ?? `テスト用の質問 ${n}: A と B と C のどれにしますか？`;
  const options = s.options ?? [{ label: "A", description: "A の説明" }, { label: "B (Recommended)", description: "B の説明" }, { label: "C", description: "C の説明" }];
  const explain = s.explain ?? true;
  const body: Record<string, unknown> = {
    tool_use_id: `toolu_gui_${process.pid}_${n}`,
    kind: "answer_question",
    session: { session_id: `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`, cwd: ROOT, transcript_path: join(home, ".claude", "projects", "p", "none.jsonl") },
    request: { questions: [{ question, header: "確認", options, multiSelect: s.multiSelect ?? false }] },
  };
  if (s.noneReason) {
    body.explanation = { path: "", markdown: "", has: { mermaid: false, table: false, diff: false }, match: "question", attached_via: "none", none_reason: s.noneReason };
  } else if (explain) {
    body.explanation = {
      path: "", title, question, reversibility: "reversible", scope: "file",
      markdown: s.markdown ?? SEED_MD.replace("__QUESTION__", question).replace("__TITLE__", title),
      has: { mermaid: false, table: true, diff: false }, match: "question", attached_via: "first_call",
    };
  }
  const d = await api("/api/decisions", body);
  assert.ok(d.id, `decision を作れない: ${JSON.stringify(d)}`);
  return { id: d.id, title };
}

/** blocker(人の作業待ち)を投入する。説明は test/explain-fixtures/pass-blocker.md */
async function seedBlocker(): Promise<{ id: string; title: string }> {
  const n = ++seq;
  const markdown = readFileSync(new URL("../explain-fixtures/pass-blocker.md", import.meta.url), "utf8");
  const fm = (k: string) => new RegExp(`^${k}: (.+)$`, "m").exec(markdown)![1]!;
  const question = fm("question");
  const title = fm("title");
  const d = await api("/api/decisions", {
    tool_use_id: `toolu_gui_${process.pid}_${n}`,
    kind: "answer_question",
    session: { session_id: `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`, cwd: ROOT, transcript_path: join(home, ".claude", "projects", "p", "none.jsonl") },
    request: { questions: [{ question, header: "作業待ち", multiSelect: false, options: [
      { label: "対応した。続けて (Recommended)", description: "再試行する" },
      { label: "この手順は飛ばして続けて", description: "飛ばす" },
      { label: "ここで中断", description: "止める" },
    ] }] },
    explanation: {
      path: "", type: "blocker", title, question, reversibility: "reversible", scope: "machine", markdown,
      has: { mermaid: false, table: true, diff: false }, match: "question", attached_via: "first_call",
    },
  });
  assert.ok(d.id, `decision を作れない: ${JSON.stringify(d)}`);
  return { id: d.id, title };
}

async function seedPlan(plan = "# 計画\n\n手順 1"): Promise<{ id: string }> {
  const n = ++seq;
  const d = await api("/api/decisions", {
    tool_use_id: `toolu_gui_${process.pid}_${n}`,
    kind: "approve_plan",
    session: { session_id: `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`, cwd: ROOT, transcript_path: join(home, ".claude", "projects", "p", "none.jsonl") },
    request: { plan, planFilePath: "/tmp/plan.md" },
  });
  assert.ok(d.id, `decision を作れない: ${JSON.stringify(d)}`);
  return { id: d.id };
}

async function cancelAll() {
  const list = (await api("/api/decisions?status=pending")) as { id: string }[];
  for (const d of list) await api(`/api/decisions/${d.id}/cancel`, {});
}

async function waitStatus(id: string, status: string, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const d = await api(`/api/decisions/${id}`);
    if (d.status === status) return d;
    assert.ok(Date.now() < end, `status が ${status} にならない(現在 ${d.status})`);
    await sleep(100);
  }
}

/** 判断を投入済みの画面を開き直し、操作対象が出るまで待つ */
async function reopen(ready = "document.querySelector('#decision .opt, #decision .btn')") {
  ab("open", base + "/");
  await waitFor("画面の描画", ready);
}

const cards = `[...document.querySelectorAll("#decision .opt")]`;
const view = () => ev<{ cursor: number; checked: number }>(
  `JSON.stringify({ cursor: ${cards}.findIndex(e => e.classList.contains("cursor")), checked: ${cards}.findIndex(e => e.querySelector("input").checked) })`,
);
const fire = (code: string) => ev(
  `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Process", code: "${code}", keyCode: 229, bubbles: true, cancelable: true })), "ok"`,
);

/** serve を起動して healthz が通るまで待つ(port / dataDir は固定。再起動にも使う) */
async function startServe() {
  serve = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "serve", "--port", String(port), "--data-dir", dataDir], { cwd: ROOT, stdio: "ignore", env: { ...process.env, HOME: home } });
  const end = Date.now() + 20000;
  for (;;) {
    try { if ((await fetch(base + "/healthz")).ok) break; } catch {}
    assert.ok(Date.now() < end, "serve が起動しない");
    await sleep(100);
  }
  token = readFileSync(join(dataDir, "token"), "utf8").trim();
}

before(async () => {
  if (!HAS_BROWSER) return;
  // HOME を一時ディレクトリにして、~/.ukagai と実セッションに触れない(transcript_path の許可範囲もここが基準)
  home = mkdtempSync(join(tmpdir(), "ukagai-gui-"));
  dataDir = join(home, "data");
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  // dist/ が古いと server の挙動がずれるので、常に src を tsx で動かす
  await startServe();
  ab("open", base + "/", "--viewport", "1440x900");
  opened = true;
});

after(async () => {
  if (opened) { try { ab("close"); } catch {} }
  serve?.kill();
  if (home) rmSync(home, { recursive: true, force: true });
});

function gui(name: string, fn: (t: TestContext) => Promise<void>) {
  test(`GUI: ${name}`, { skip: HAS_BROWSER ? false : "agent-browser が無い" }, async (t) => {
    await cancelAll();
    try { await fn(t); } finally { await cancelAll(); }
  });
}

gui("単一選択: j / k / G / gg / 矢印で動き、推奨が初期選択", async () => {
  await seedQuestion();
  await reopen();
  assert.deepEqual(view(), { cursor: 1, checked: 1 }); // B (Recommended)
  press("j");
  assert.deepEqual(view(), { cursor: 2, checked: 2 });
  press("k");
  assert.deepEqual(view(), { cursor: 1, checked: 1 });
  press("G");
  assert.deepEqual(view(), { cursor: 3, checked: 3 }); // 自由記述
  press("g", "g");
  assert.deepEqual(view(), { cursor: 0, checked: 0 });
  press("ArrowDown");
  assert.deepEqual(view(), { cursor: 1, checked: 1 });
  press("ArrowUp");
  assert.deepEqual(view(), { cursor: 0, checked: 0 });
});

gui("IME 風(key=Process, keyCode=229)でも j / k が効く", async () => {
  await seedQuestion();
  await reopen();
  assert.equal(view().cursor, 1);
  fire("KeyJ");
  assert.deepEqual(view(), { cursor: 2, checked: 2 });
  fire("KeyK");
  assert.deepEqual(view(), { cursor: 1, checked: 1 });
});

gui("Enter で送信すると answer_submitted、answers は元の label", async () => {
  const { id } = await seedQuestion();
  await reopen();
  press("j", "Enter");
  const d = await waitStatus(id, "answer_submitted");
  const [v] = Object.values(d.response.answers);
  assert.equal(v, "C");
});

gui("推奨ラベル(Recommended)付きの選択肢は元の label で返る", async () => {
  const { id } = await seedQuestion();
  await reopen();
  press("Enter");
  const d = await waitStatus(id, "answer_submitted");
  assert.equal(Object.values(d.response.answers)[0], "B (Recommended)");
});

gui("複数選択: Space で切替、Enter で A, C", async () => {
  const { id } = await seedQuestion({
    multiSelect: true, explain: false,
    options: [{ label: "A" }, { label: "B" }, { label: "C" }],
  });
  await reopen();
  const checks = `JSON.stringify(${cards}.map(e => e.querySelector("input").checked))`;
  press("Space");
  assert.deepEqual(ev(checks), [true, false, false, false]);
  press("Space");
  assert.deepEqual(ev(checks), [false, false, false, false]);
  press("Space", "j", "j", "Space");
  assert.deepEqual(ev(checks), [true, false, true, false]);
  press("Enter");
  const d = await waitStatus(id, "answer_submitted");
  assert.equal(Object.values(d.response.answers)[0], ["A", "C"].join(SEP));
});

gui("自由記述: i で欄へ、Esc で外れ値は残り、i → Enter で送信", async () => {
  const { id } = await seedQuestion();
  await reopen();
  press("i");
  assert.equal(ev(`document.activeElement.classList.contains("free-text")`), true);
  ab("keyboard", "type", "ほげ");
  press("Escape");
  assert.equal(ev(`document.activeElement.classList.contains("free-text")`), false);
  assert.equal(ev(`document.querySelector(".free-text").value`), "ほげ");
  press("i", "Enter");
  const d = await waitStatus(id, "answer_submitted");
  assert.equal(Object.values(d.response.answers)[0], "ほげ");
});

gui("ボタンにフォーカスがあっても j が効く", async () => {
  await seedQuestion();
  await reopen();
  assert.equal(ev(`document.getElementById("submit").focus(), document.activeElement.id`), "submit");
  press("j");
  assert.deepEqual(view(), { cursor: 2, checked: 2 });
});

gui("保留 2 件: l / h で切替、b でドロワー、j Enter で切替えて閉じる", async () => {
  const a = await seedQuestion({ title: "1 件目の判断" });
  const b = await seedQuestion({ title: "2 件目の判断" });
  assert.notEqual(a.id, b.id);
  await reopen();
  const title = () => ev<string>(`document.querySelector("#decision .v2-title").textContent`);
  const drawer = () => ev<boolean>(`document.getElementById("drawer").classList.contains("open")`);
  assert.equal(title(), a.title);
  press("l");
  assert.equal(title(), b.title);
  press("h");
  assert.equal(title(), a.title);
  press("b");
  assert.equal(drawer(), true);
  press("j", "Enter");
  assert.equal(title(), b.title);
  assert.equal(drawer(), false);
});

gui("計画: n で理由欄、Esc で取りやめ、y で approve: true", async () => {
  const { id } = await seedPlan();
  await reopen("document.querySelector('#decision .btn')");
  press("n");
  assert.equal(ev(`document.activeElement.id`), "reason");
  press("Escape");
  assert.equal(ev(`!document.getElementById("reason")`), true);
  press("y");
  const d = await waitStatus(id, "answer_submitted");
  assert.equal(d.response.approve, true);
});

gui("「ターミナルで答える」は無い", async () => {
  await seedQuestion();
  await reopen();
  assert.equal(ev(`document.body.innerText.includes("ターミナルで答える")`), false);
});

gui("GET / の ?v= と画面の build <v> が一致する(判断あり・空状態とも)", async () => {
  const html = await (await fetch(base + "/")).text();
  const v = /\/public\/app\.js\?v=([0-9a-z]+)"/.exec(html)?.[1];
  assert.ok(v, "app.js に ?v= が付く");
  const mtime = Math.floor(statSync(join(ROOT, "public", "app.js")).mtimeMs).toString(36);
  assert.equal(v, mtime);
  assert.ok(new RegExp(`/public/app\\.css\\?v=[0-9a-z]+"`).test(html));
  await reopen("document.getElementById('empty') && !document.getElementById('empty').hidden");
  assert.equal(ev(`document.querySelector("#empty .build").textContent`), `build ${v}`);
  await seedQuestion();
  await reopen();
  assert.equal(ev(`document.body.innerText.includes("build ${v}")`), true);
});

gui("矢印: ← / → で保留が切り替わる(質問)、Home / End で先頭 / 末尾", async () => {
  const a = await seedQuestion({ title: "1 件目の判断" });
  const b = await seedQuestion({ title: "2 件目の判断" });
  await reopen();
  const title = () => ev<string>(`document.querySelector("#decision .v2-title").textContent`);
  assert.equal(title(), a.title);
  press("ArrowRight");
  assert.equal(title(), b.title);
  press("ArrowLeft");
  assert.equal(title(), a.title);
  press("End");
  assert.deepEqual(view(), { cursor: 3, checked: 3 });
  press("Home");
  assert.deepEqual(view(), { cursor: 0, checked: 0 });
});

gui("矢印: ← / → で保留が切り替わる(計画)。ボタン移動は ↑ / ↓", async () => {
  const q = await seedQuestion({ title: "質問の判断" });
  const p = await seedPlan();
  assert.ok(q.id && p.id);
  await reopen();
  const isPlan = () => ev<boolean>(`!!document.querySelector("#decision #submit") === false`);
  assert.equal(isPlan(), false);
  press("ArrowRight");
  assert.equal(isPlan(), true);
  const cur = () => ev<number>(`[...document.querySelectorAll("#decision button.btn")].findIndex(b => b.classList.contains("cursor"))`);
  assert.equal(cur(), 0);
  press("ArrowDown");
  assert.equal(cur(), 1);
  press("ArrowUp");
  assert.equal(cur(), 0);
  press("ArrowLeft");
  assert.equal(isPlan(), false);
});

gui("矢印: 自由記述の欄内で → を押しても欄から出ない", async () => {
  await seedQuestion();
  await seedQuestion();
  await reopen();
  press("End", "Enter"); // 自由記述カード、空なので欄へ
  const onFree = () => ev<boolean>(`document.activeElement.classList.contains("free-text")`);
  assert.equal(onFree(), true);
  const t = () => ev<string>(`document.querySelector("#decision .v2-title").textContent`);
  const before = t();
  press("ArrowRight", "ArrowLeft");
  assert.equal(onFree(), true);
  assert.equal(t(), before);
});

gui("矢印: ドロワーで ← が閉じる", async () => {
  await seedQuestion();
  await seedQuestion();
  await reopen();
  const drawer = () => ev<boolean>(`document.getElementById("drawer").classList.contains("open")`);
  press("b");
  assert.equal(drawer(), true);
  press("ArrowLeft");
  assert.equal(drawer(), false);
});

gui("矢印: ヒント行は ↑↓ で j/k を書かない。保留ボタンのチップは ← →", async () => {
  await seedQuestion();
  await seedQuestion();
  await reopen();
  const hint = ev<string>(`document.querySelector("#decision .hint").textContent`);
  assert.ok(hint.includes("↑↓"), hint);
  assert.ok(!hint.includes("j/k"), hint);
  const keys = ev<string>(`document.querySelector("#decision .keys").textContent`);
  assert.ok(keys.includes("↑") && keys.includes("↓"), keys);
  const chips = ev<string[]>(`JSON.stringify([...document.querySelectorAll("#pending-btn .kbd")].map(k => k.textContent))`);
  assert.deepEqual(chips, ["←", "→"]);
});

gui("blocker: 橙の帯と「人にしてほしいこと」が右列にあり、Enter だけで「対応した。続けて」が送られる", async () => {
  const { id, title } = await seedBlocker();
  await reopen();
  const right = (sel: string) => ev<boolean>(`!!document.querySelector("#decision ${sel}")`);
  assert.equal(right(".blocker-band"), true);
  assert.equal(ev<string>(`document.querySelector("#decision .blocker-band").textContent`), "人の作業待ち");
  assert.equal(ev<string>(`document.querySelector("#decision .v2-title").textContent`), title);
  assert.equal(ev<string>(`document.querySelector("#decision .todo-cap").textContent`), "人にしてほしいこと");
  assert.equal(ev<boolean>(`document.querySelector("#decision .todo").textContent.includes("gcloud auth login")`), true);
  assert.equal(right(".todo .copy-btn"), true);
  assert.equal(ev<boolean>(`document.querySelector("#background").textContent.includes("人にしてほしいこと")`), false); // 左列には無い
  assert.equal(ev<boolean>(`document.querySelector("#background").textContent.includes("なぜ止まったか")`), true);
  assert.equal(right(".rec-cap"), false); // 推奨の節が無いのでボックスも出さない
  assert.equal(ev<string>(`document.title`), "(1) ukagai · 作業待ち");
  assert.equal(view().cursor, 0);
  press("Enter");
  const d = await waitStatus(id, "answer_submitted");
  assert.equal(Object.values(d.response.answers)[0], "対応した。続けて (Recommended)");
});

gui("長い推奨は 6 行で折りたたまれ、選択肢カードと送信ボタンは画面内。`.` で全文が見える", async () => {
  const sentence = "この説明は長い推奨を再現するための一文で、折りたたみの確認に使います。";
  const markdown = SEED_MD.replace("B を推します。理由は確認用だからです。", sentence.repeat(10) + "末尾の一文です。");
  await seedQuestion({ markdown });
  ab("set", "viewport", "1440", "900");
  await reopen();
  const rect = (sel: string) => ev<{ top: number; bottom: number }>(`JSON.stringify((r => ({ top: r.top, bottom: r.bottom }))(document.querySelector("${sel}").getBoundingClientRect()))`);
  const vh = ev<number>(`window.innerHeight`);
  const inView = (sel: string) => { const r = rect(sel); return r.top >= 0 && r.bottom <= vh; };
  assert.equal(inView("#decision .opt:last-of-type"), true);
  assert.equal(inView("#submit"), true);
  assert.equal(ev<boolean>(`document.querySelector("#decision .rec-body").scrollHeight > document.querySelector("#decision .rec-body").clientHeight + 1`), true); // 折りたたまれている
  assert.equal(ev<string>(`document.querySelector("#decision .rec .more-chip").textContent`), "全文 .");
  press(".");
  assert.equal(ev<boolean>(`document.querySelector("#decision .rec-body").scrollHeight <= document.querySelector("#decision .rec-body").clientHeight + 1`), true); // 全文が見える
  assert.equal(ev<boolean>(`document.querySelector("#decision .rec-body").textContent.includes("末尾の一文です。")`), true);
  const r = rect("#decision .rec-body");
  assert.ok(r.bottom - r.top > 6 * 1.6 * 13, "展開で 6 行より高くなる");
  press(".");
  assert.equal(ev<boolean>(`document.querySelector("#decision .rec-body").scrollHeight > document.querySelector("#decision .rec-body").clientHeight + 1`), true); // もう一度 . で折りたたむ
});

gui("hook の上限内の説明(pass-design.md)ではクランプが発動せず、右列が 900px に収まる", async () => {
  const markdown = readFileSync(new URL("../explain-fixtures/pass-design.md", import.meta.url), "utf8");
  await seedQuestion({ markdown, options: [{ label: "SSE (Recommended)", description: "SSE" }, { label: "WebSocket", description: "WS" }] });
  ab("set", "viewport", "1440", "900");
  await reopen();
  assert.equal(ev<number>(`document.querySelectorAll("#decision .more-chip").length`), 0);
  assert.equal(ev<boolean>(`document.getElementById("decision").scrollHeight <= document.getElementById("decision").clientHeight`), true);
  assert.equal(ev<boolean>(`document.getElementById("decision").clientHeight <= 900`), true);
});

// ---- Q1 の修正(FA) ----

/** v2 説明。rows は [ラベル(表の先頭列), 起きること, リスク] */
function v2md(question: string, title: string, rows: string[][], extra = "", rec = "B を推します。"): string {
  const table = rows.map((r) => `| ${r.join(" | ")} |`).join("\n");
  return `---\nukagai: 1\nquestion: ${question}\ntitle: ${title}\nrecommended: B\nreversibility: reversible\nscope: file\n---\n\n## なぜ今この判断が要るか\n\n確認用です。\n\n${extra}## 選択肢\n\n| 選択肢 | 選ぶと起きること | リスクと戻し方 |\n|---|---|---|\n${table}\n\n## 推奨\n\n${rec}\n`;
}
const ROWS = [["A", "A になる", "なし"], ["B", "B になる", "なし"], ["C", "C になる", "なし"]];

gui("401 後の自動復旧: server を再起動しても、新着が 10 秒以内に出る", async () => {
  const a = await seedQuestion({ title: "再起動前の判断" });
  await reopen();
  assert.equal(ev(`document.querySelector("#decision .v2-title").textContent`), a.title);
  const old = serve!;
  old.kill();
  await new Promise((r) => (old.exitCode !== null ? r(null) : old.once("exit", r)));
  await sleep(1500);
  await startServe(); // 同じ port / data-dir。cookie は失効する
  const b = await seedQuestion({ title: "再起動後の判断" });
  await waitFor("再起動後の判断が一覧に出る", `document.getElementById("pending-list").textContent.includes(${JSON.stringify(b.title)}) || document.querySelector("#decision .v2-title")?.textContent === ${JSON.stringify(b.title)}`, 10000);
  assert.equal(ev(`document.getElementById("banner").hidden`), true);
});

gui("server 停止中は「接続できません」バナーと空状態、再起動で消えて「再接続しました」、新着も出る", async () => {
  await reopen("document.getElementById('empty') && !document.getElementById('empty').hidden");
  assert.equal(ev(`document.getElementById("banner").hidden`), true);
  const old = serve!;
  old.kill();
  await new Promise((r) => (old.exitCode !== null ? r(null) : old.once("exit", r)));
  await waitFor("接続できないバナー", `!document.getElementById("banner").hidden && document.getElementById("banner").textContent.includes("接続できません") && document.getElementById("banner").textContent.includes(location.origin)`, 3000);
  assert.equal(ev(`document.getElementById("empty-title").textContent`), "接続できません");
  await sleep(1000);
  await startServe();
  await waitFor("「再接続しました」のトースト", `[...document.querySelectorAll(".toast.ok")].some(t => t.textContent === "再接続しました")`, 12000);
  assert.equal(ev(`document.getElementById("banner").hidden`), true);
  const b = await seedQuestion({ title: "停止後の判断" });
  await waitFor("新着", `document.querySelector("#decision .v2-title")?.textContent === ${JSON.stringify(b.title)}`, 10000);
  assert.equal(ev(`document.getElementById("empty").hidden`), true);
});

// ---- Q3 の修正(FG) ----

gui("畳んだ推奨でも CAUTION の callout は枠の中で全文見える", async () => {
  const sentence = "この選択は設定の保存先と読み込みの順序に長く影響するため、他の機能との相互作用を含めて慎重に見てください。";
  const rec = `B を推します。${sentence.repeat(8)}\n\n> [!CAUTION]\n> 取り消せません。実行すると元には戻せないので注意。`;
  const question = "callout の質問です？";
  await seedQuestion({ markdown: v2md(question, "callout の判断", ROWS, "", rec), options: [{ label: "A" }, { label: "B (Recommended)" }, { label: "C" }] });
  ab("set", "viewport", "1440", "900");
  await reopen();
  await waitFor("畳み(全文チップ)", `document.querySelector("#decision .rec-main.has-more")`);
  const r = ev<{ h: number; inBody: boolean; top: number; bottom: number; recTop: number; recBottom: number; bodyBottom: number }>(`JSON.stringify((() => {
    const c = document.querySelector("#decision .rec .callout"), rec = document.querySelector("#decision .rec").getBoundingClientRect(), b = document.querySelector("#decision .rec-body").getBoundingClientRect(), r = c.getBoundingClientRect();
    return { h: r.height, inBody: !!c.closest(".rec-body"), top: r.top, bottom: r.bottom, recTop: rec.top, recBottom: rec.bottom, bodyBottom: b.bottom };
  })())`);
  assert.ok(r.h > 0 && !r.inBody, JSON.stringify(r));
  assert.ok(r.top >= r.bodyBottom - 1 && r.top >= r.recTop && r.bottom <= r.recBottom + 1, `callout が推奨の枠の中、畳みの下に見える: ${JSON.stringify(r)}`);
  assert.equal(ev<boolean>(`document.querySelector("#decision .rec .callout").textContent.includes("元には戻せない")`), true);
  assert.equal(ev<boolean>(`!document.getElementById("decision").classList.contains("expanded")`), true); // 畳んだまま
});

gui("長いインラインコードは列幅で折り返し、--port は割れない", async () => {
  const path = "src/serve/handlers/some-very-long-directory-name/another-quite-long-segment-name/file-name-long.ts-x";
  const long = `src/${"a-long-dir-name/".repeat(7)}file.ts`;
  assert.ok(long.length >= 120);
  const rec = `起動は \`--port\` を使います。対象のパスは \`${long}\` です。${path.length > 0 ? "" : ""}`;
  await seedQuestion({ markdown: v2md("コードの質問です？", "コードの判断", ROWS, "", rec), options: [{ label: "A" }, { label: "B (Recommended)" }, { label: "C" }] });
  ab("set", "viewport", "1440", "900");
  await reopen();
  const r = ev<{ over: number; lines: number; port: string; cw: number; sw: number }>(`JSON.stringify((() => {
    const body = document.querySelector("#decision .rec-body"), br = body.getBoundingClientRect();
    const codes = [...body.querySelectorAll("code")];
    const over = Math.max(...codes.flatMap(c => [...c.getClientRects()].map(x => x.right - br.right)));
    const port = codes.find(c => c.textContent.includes("port"));
    return { over, lines: port.getClientRects().length, port: port.textContent, cw: body.clientWidth, sw: body.scrollWidth };
  })())`);
  assert.ok(r.over <= 1, `コードが列幅を超える: ${JSON.stringify(r)}`);
  assert.ok(r.sw <= r.cw, `scrollWidth <= clientWidth: ${JSON.stringify(r)}`);
  assert.equal(r.lines, 1, JSON.stringify(r)); // --port は 1 行
  assert.equal(r.port, "--port");
});

gui("表示中でない判断の cancel で赤いトースト(最大 3 枚、送信ボタンの上)", async () => {
  await seedQuestion({ title: "表示中の判断" });
  const others = [await seedQuestion({ title: "裏の判断 1" }), await seedQuestion({ title: "裏の判断 2" }), await seedQuestion({ title: "裏の判断 3" }), await seedQuestion({ title: "裏の判断 4" })];
  await reopen();
  for (const o of others) await api(`/api/decisions/${o.id}/cancel`, {});
  await waitFor("トースト", `document.querySelectorAll(".toast.lost").length === 3`);
  const text = ev<string>(`document.querySelector(".toast.lost").textContent`);
  assert.ok(text.includes("取り消されました") && !text.includes("届きませんでした"), text); // 未回答の cancel
  const r = ev<{ t: number; b: number }>(`JSON.stringify((() => { const t = document.querySelector(".toasts").getBoundingClientRect(), s = document.getElementById("submit").getBoundingClientRect(); return { t: t.bottom, b: s.top }; })())`);
  assert.ok(r.t <= r.b, `トーストが送信ボタンに重ならない: ${JSON.stringify(r)}`);
});

gui("計画: 見出しは平文、「影響範囲と可逆性」が右列にある(無ければ出ない)", async () => {
  await seedPlan("# `src/foo.ts` を **直す** 計画\n\n## 作業\n\n1. a\n\n## 影響範囲と可逆性\n\nfile 内だけ。git で戻せる。\n");
  await reopen("document.querySelector('#decision .btn')");
  assert.equal(ev<string>(`document.querySelector("#decision .v2-title").textContent`), "src/foo.ts を 直す 計画");
  assert.equal(ev<boolean>(`document.querySelector("#decision .impact").textContent.includes("git で戻せる")`), true);
  assert.equal(ev<string>(`document.querySelector("#decision .impact-cap").textContent`), "影響範囲と可逆性");
  await cancelAll();
  await seedPlan("# 計画\n\n## 作業\n\n1. a\n");
  await reopen("document.querySelector('#decision .btn')");
  assert.equal(ev<boolean>(`!!document.querySelector("#decision .impact")`), false);
});

gui("広い図: f で全幅(判断列を隠す)、Enter は無効、Esc で戻る", async () => {
  const wide = "## 図\n\n```mermaid\nflowchart LR\n" + Array.from({ length: 14 }, (_, i) => `  N${i}[ノード ${i} の長いラベルです] --> N${i + 1}[ノード ${i + 1} の長いラベルです]`).join("\n") + "\n```\n\n";
  const question = "広い図の質問です？";
  const { id } = await seedQuestion({ markdown: v2md(question, "広い図の判断", ROWS, wide), options: [{ label: "A" }, { label: "B (Recommended)" }, { label: "C" }] });
  ab("set", "viewport", "1440", "900");
  await reopen();
  await waitFor("全幅で見るチップ", `document.querySelector("#background .wide-chip")`, 10000);
  const full = () => ev<boolean>(`document.body.classList.contains("fullwide")`);
  press("f");
  assert.equal(full(), true);
  assert.equal(ev<boolean>(`getComputedStyle(document.getElementById("decision")).display === "none"`), true);
  press("Enter");
  await sleep(400);
  assert.equal((await api(`/api/decisions/${id}`)).status, "pending");
  press("Escape");
  assert.equal(full(), false);
  press("f", "Tab");
  assert.equal(full(), false);
  ab("click", ".wide-chip"); // クリックでも入る
  assert.equal(full(), true);
  press("f");
  assert.equal(full(), false);
});

gui("説明なし: (Recommended) は外して推奨バッジ、理由は平文", async () => {
  await seedQuestion({ explain: false, noneReason: "loop_guard", options: [{ label: "A (Recommended)" }, { label: "B" }] });
  await reopen();
  assert.equal(ev<string>(`document.querySelector("#decision .opt .lab").textContent`), "A推奨");
  assert.equal(ev<boolean>(`!!document.querySelector("#decision .opt .rec-badge")`), true);
  const note = ev<string>(`document.querySelector("#background .bg-note").textContent`);
  assert.ok(note.includes("書き直しの指示に従わなかったため") && !note.includes("loop_guard"), note);
  assert.deepEqual(view(), { cursor: 0, checked: 0 });
  press("Enter");
  const list = (await api("/api/decisions?status=answer_submitted")) as any[];
  assert.equal(Object.values(list.at(-1).response.answers)[0], "A (Recommended)");
});

gui("説明内の外部・相対 img は除去、data: は残る", async () => {
  const imgs = `<img src="https://example.invalid/a.png">\n\n<img src="//example.invalid/b.png">\n\n<img src="x">\n\n<img src="/x">\n\n<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">\n\n`;
  await seedQuestion({ markdown: v2md("画像の質問です？", "画像の判断", ROWS, imgs) });
  await reopen();
  assert.equal(ev<number>(`document.querySelectorAll("#background img").length`), 1);
  assert.equal(ev<boolean>(`document.querySelector("#background img").src.startsWith("data:")`), true);
});

gui("ラベルに <b> があっても v2 のカードが出る(対応が取れない option だけ生で補う)", async () => {
  const label = '<b>A</b> "quoted"';
  await seedQuestion({
    markdown: v2md("HTML ラベルの質問です？", "HTML ラベルの判断", [[label, "A になる", "なし"], ["B", "B になる", "なし"]]),
    options: [{ label, description: "生の説明 A" }, { label: "B (Recommended)", description: "生の説明 B" }, { label: "Z", description: "生の説明 Z" }],
  });
  await reopen();
  const labs = ev<string[]>(`JSON.stringify([...document.querySelectorAll("#decision .opt .lab")].map(e => e.firstChild.textContent))`);
  assert.deepEqual(labs.slice(0, 3), ['A "quoted"', "B", "Z"]);
  assert.equal(ev<boolean>(`document.querySelector("#decision .opt .desc").textContent.includes("A になる")`), true); // 表から
  assert.equal(ev<boolean>(`document.body.innerText.includes("生の説明 Z")`), true); // 取れない option は生
  assert.equal(ev<boolean>(`document.body.innerText.includes("生の説明 A")`), false);
  assert.equal(ev<boolean>(`!!document.querySelector("#decision .rec-cap")`), true);
});

gui("1000x700 で保留 2 件: → / 回答 / cancel で画面が白くならず、例外が出ない", async () => {
  ab("set", "viewport", "1000", "700");
  try {
    const a = await seedQuestion({ title: "切替の 1 件目" });
    const b = await seedQuestion({ title: "切替の 2 件目" });
    await reopen();
    ev(`window.__errs = [], window.addEventListener("error", (e) => window.__errs.push(String(e.message))), window.addEventListener("unhandledrejection", (e) => window.__errs.push(String(e.reason))), "ok"`);
    const title = () => ev<string>(`document.querySelector("#decision .v2-title")?.textContent ?? ""`);
    assert.equal(title(), a.title);
    assert.equal(ev<boolean>(`!!document.querySelector("#decision .title-row #pending-btn")`), true); // 保留ピルは見出し行にある
    press("ArrowRight");
    assert.equal(title(), b.title); // 空でなく次の判断が出る
    assert.equal(ev<boolean>(`!!document.getElementById("pending-btn")`), true);
    press("ArrowLeft");
    assert.equal(title(), a.title);
    press("Enter"); // a に回答 → 残り(b)が出る
    await waitFor("残りの判断", `document.querySelector("#decision .v2-title")?.textContent === ${JSON.stringify(b.title)}`);
    await api(`/api/decisions/${b.id}/cancel`, {});
    await waitFor("空状態", `!document.getElementById("empty").hidden && document.getElementById("main").hidden`);
    assert.deepEqual(ev<string[]>(`JSON.stringify(window.__errs)`), []);
  } finally {
    ab("set", "viewport", "1440", "900");
  }
});

gui("fallback になった(回答済み扱いでない)裏の判断は「届きませんでした」", async () => {
  await seedQuestion({ title: "表示中の判断" });
  const o = await seedQuestion({ title: "裏の判断 F" });
  await reopen();
  await api(`/api/decisions/${o.id}/answer`, { fallback: true });
  await waitFor("トースト", `document.querySelector(".toast.lost")`);
  const text = ev<string>(`document.querySelector(".toast.lost").textContent`);
  assert.ok(text.includes("届きませんでした"), text);
});

gui("インラインコードは列幅で折り返す(nowrap でない)、`-` を含む語は nowrap の span + wbr、U+2060 は使わない、コードブロックは従来どおり", async () => {
  await seedQuestion({ markdown: v2md("コードの質問です？", "コードの判断", ROWS, "`some-very-long-inline-code-identifier`\n\n```\nblock\n```\n\n") });
  await reopen();
  const cs = ev<{ ws: string; wrap: string }>(`JSON.stringify((() => { const s = getComputedStyle(document.querySelector("#background :not(pre) > code")); return { ws: s.whiteSpace, wrap: s.overflowWrap }; })())`);
  assert.deepEqual(cs, { ws: "normal", wrap: "anywhere" });
  assert.equal(ev<string>(`document.querySelector("#background :not(pre) > code").textContent`), "some-very-long-inline-code-identifier");
  assert.equal(ev<number>(`document.querySelectorAll("#background :not(pre) > code wbr").length`), 5);
  assert.equal(ev<string>(`getComputedStyle(document.querySelector("#background :not(pre) > code .nb")).whiteSpace`), "nowrap");
  assert.equal(ev<string>(`getComputedStyle(document.querySelector("#background pre code")).whiteSpace`), "pre");
});

gui("インラインコードを選択してコピーしても U+2060 が混ざらない", async () => {
  await seedQuestion({ markdown: v2md("コードの質問です？", "コードの判断", ROWS, "起動は `--port` を使います。", "") });
  await reopen();
  const r = ev<{ sel: string; data: string }>(`JSON.stringify((() => {
    const code = [...document.querySelectorAll("#background code")].find(c => c.textContent.includes("port"));
    const range = document.createRange(); range.selectNodeContents(code);
    const s = getSelection(); s.removeAllRanges(); s.addRange(range);
    const dt = new DataTransfer();
    document.dispatchEvent(new ClipboardEvent("copy", { clipboardData: dt, bubbles: true, cancelable: true }));
    return { sel: s.toString(), data: dt.getData("text/plain") };
  })())`);
  assert.ok(!r.sel.includes("\u2060"), JSON.stringify(r));
  assert.ok(!r.data.includes("\u2060"), JSON.stringify(r));
});

gui("接続断のバナーは判断画面の最上部を隠さず、縦スクロールも出ない(1440x900 / 1000x700)", async () => {
  for (const [w, h] of [["1440", "900"], ["1000", "700"]]) {
    await seedQuestion({ title: "バナーの下の判断" });
    ab("set", "viewport", w, h);
    await reopen();
    const old = serve!;
    old.kill();
    await new Promise((r) => (old.exitCode !== null ? r(null) : old.once("exit", r)));
    await waitFor("接続できないバナー", `!document.getElementById("banner").hidden`, 5000);
    const r = ev<{ bannerBottom: number; titleTop: number; bgTop: number; sh: number; ih: number }>(`JSON.stringify({
      bannerBottom: document.getElementById("banner").getBoundingClientRect().bottom,
      titleTop: document.querySelector("#decision .v2-title").getBoundingClientRect().top,
      bgTop: document.getElementById("background").getBoundingClientRect().top,
      sh: document.documentElement.scrollHeight, ih: innerHeight })`);
    assert.ok(r.titleTop >= r.bannerBottom, `${w}x${h}: ${JSON.stringify(r)}`);
    assert.ok(r.bgTop >= r.bannerBottom, `${w}x${h}: ${JSON.stringify(r)}`);
    assert.ok(r.sh <= r.ih, `${w}x${h}: ${JSON.stringify(r)}`);
    await startServe();
    await waitFor("バナーが消える", `document.getElementById("banner").hidden`, 12000);
  }
});
