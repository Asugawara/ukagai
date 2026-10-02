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
type Seed = { title?: string; options?: Opt[]; multiSelect?: boolean; explain?: boolean };

/** 判断を投入する。既定は v2 の説明付きの単一選択(A / B(Recommended) / C) */
async function seedQuestion(s: Seed = {}): Promise<{ id: string; title: string }> {
  const n = ++seq;
  const title = s.title ?? `キー操作の確認 ${n}`;
  const question = `テスト用の質問 ${n}: A と B と C のどれにしますか？`;
  const options = s.options ?? [{ label: "A", description: "A の説明" }, { label: "B (Recommended)", description: "B の説明" }, { label: "C", description: "C の説明" }];
  const explain = s.explain ?? true;
  const body: Record<string, unknown> = {
    tool_use_id: `toolu_gui_${process.pid}_${n}`,
    kind: "answer_question",
    session: { session_id: `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`, cwd: ROOT, transcript_path: join(home, ".claude", "projects", "p", "none.jsonl") },
    request: { questions: [{ question, header: "確認", options, multiSelect: s.multiSelect ?? false }] },
  };
  if (explain) {
    body.explanation = {
      path: "", title, question, reversibility: "reversible", scope: "file",
      markdown: SEED_MD.replace("__QUESTION__", question).replace("__TITLE__", title),
      has: { mermaid: false, table: true, diff: false }, match: "question", attached_via: "first_call",
    };
  }
  const d = await api("/api/decisions", body);
  assert.ok(d.id, `decision を作れない: ${JSON.stringify(d)}`);
  return { id: d.id, title };
}

async function seedPlan(): Promise<{ id: string }> {
  const n = ++seq;
  const d = await api("/api/decisions", {
    tool_use_id: `toolu_gui_${process.pid}_${n}`,
    kind: "approve_plan",
    session: { session_id: `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`, cwd: ROOT, transcript_path: join(home, ".claude", "projects", "p", "none.jsonl") },
    request: { plan: "# 計画\n\n手順 1", planFilePath: "/tmp/plan.md" },
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

before(async () => {
  if (!HAS_BROWSER) return;
  // HOME を一時ディレクトリにして、~/.ukagai と実セッションに触れない(transcript_path の許可範囲もここが基準)
  home = mkdtempSync(join(tmpdir(), "ukagai-gui-"));
  dataDir = join(home, "data");
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  // dist/ が古いと server の挙動がずれるので、常に src を tsx で動かす
  serve = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "serve", "--port", String(port), "--data-dir", dataDir], { cwd: ROOT, stdio: "ignore", env: { ...process.env, HOME: home } });
  const end = Date.now() + 20000;
  for (;;) {
    try { if ((await fetch(base + "/healthz")).ok) break; } catch {}
    assert.ok(Date.now() < end, "serve が起動しない");
    await sleep(100);
  }
  token = readFileSync(join(dataDir, "token"), "utf8").trim();
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
