// Checks the GUI (public/app.js) key handling against a real server and a real browser (agent-browser).
// Skipped when agent-browser is not on PATH.
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
const SEED_JA_MD = readFileSync(new URL("./fixtures/seed.ja.md", import.meta.url), "utf8"); // Japanese headings and table
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

/** Parse the stdout of eval (a JSON string). A JSON.stringify'd value comes out wrapped twice */
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
    assert.ok(Date.now() < end, `condition not met in time: ${what}`);
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
type Seed = { title?: string; options?: Opt[]; multiSelect?: boolean; explain?: boolean; markdown?: string; noneReason?: string; jaSeed?: boolean };

/** Seed a decision. Defaults to a single-select with a v2 explanation (A / B(Recommended) / C) */
async function seedQuestion(s: Seed = {}): Promise<{ id: string; title: string }> {
  const n = ++seq;
  const title = s.title ?? `Key check ${n}`;
  const fmQuestion = s.markdown ? /^question: (.+)$/m.exec(s.markdown)![1]! : undefined;
  const question = fmQuestion ?? `Test question ${n}: A, B or C?`;
  const options = s.options ?? [{ label: "A", description: "About A" }, { label: "B (Recommended)", description: "About B" }, { label: "C", description: "About C" }];
  const explain = s.explain ?? true;
  const body: Record<string, unknown> = {
    tool_use_id: `toolu_gui_${process.pid}_${n}`,
    kind: "answer_question",
    session: { session_id: `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`, cwd: ROOT, transcript_path: join(home, ".claude", "projects", "p", "none.jsonl") },
    request: { questions: [{ question, header: "Check", options, multiSelect: s.multiSelect ?? false }] },
  };
  if (s.noneReason) {
    body.explanation = { path: "", markdown: "", has: { mermaid: false, table: false, diff: false }, match: "question", attached_via: "none", none_reason: s.noneReason };
  } else if (explain) {
    body.explanation = {
      path: "", title, question, reversibility: "reversible", scope: "file",
      markdown: s.markdown ?? (s.jaSeed ? SEED_JA_MD : SEED_MD).replace("__QUESTION__", question).replace("__TITLE__", title),
      has: { mermaid: false, table: true, diff: false }, match: "question", attached_via: "first_call",
    };
  }
  const d = await api("/api/decisions", body);
  assert.ok(d.id, `cannot create decision: ${JSON.stringify(d)}`);
  return { id: d.id, title };
}

/** Seed a blocker (waiting for human work). The explanation is test/explain-fixtures/pass-blocker.md; option labels come from its table's first column */
async function seedBlocker(): Promise<{ id: string; title: string; labels: string[]; whyHeading: string; todoHeading: string }> {
  const n = ++seq;
  const markdown = readFileSync(new URL("../explain-fixtures/pass-blocker.md", import.meta.url), "utf8");
  const fm = (k: string) => new RegExp(`^${k}: (.+)$`, "m").exec(markdown)![1]!;
  const question = fm("question");
  const title = fm("title");
  const [whyHeading, todoHeading] = [...markdown.matchAll(/^## (.+)$/gm)].map((m) => m[1]!);
  const blockerLabels = [...markdown.matchAll(/^\| ([^|]+?) \|/gm)].map((m) => m[1]!).filter((l) => !/^-+$/.test(l)).slice(1); // skip the header row
  const d = await api("/api/decisions", {
    tool_use_id: `toolu_gui_${process.pid}_${n}`,
    kind: "answer_question",
    session: { session_id: `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`, cwd: ROOT, transcript_path: join(home, ".claude", "projects", "p", "none.jsonl") },
    request: { questions: [{ question, header: "Blocked", multiSelect: false, options: [
      { label: `${blockerLabels[0]} (Recommended)`, description: "Retry" },
      { label: blockerLabels[1]!, description: "Skip" },
      { label: blockerLabels[2]!, description: "Stop" },
    ] }] },
    explanation: {
      path: "", type: "blocker", title, question, reversibility: "reversible", scope: "machine", markdown,
      has: { mermaid: false, table: true, diff: false }, match: "question", attached_via: "first_call",
    },
  });
  assert.ok(d.id, `cannot create decision: ${JSON.stringify(d)}`);
  return { id: d.id, title, labels: blockerLabels, whyHeading: whyHeading!, todoHeading: todoHeading! };
}

async function seedPlan(plan = "# Plan\n\nStep 1"): Promise<{ id: string }> {
  const n = ++seq;
  const d = await api("/api/decisions", {
    tool_use_id: `toolu_gui_${process.pid}_${n}`,
    kind: "approve_plan",
    session: { session_id: `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`, cwd: ROOT, transcript_path: join(home, ".claude", "projects", "p", "none.jsonl") },
    request: { plan, planFilePath: "/tmp/plan.md" },
  });
  assert.ok(d.id, `cannot create decision: ${JSON.stringify(d)}`);
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
    assert.ok(Date.now() < end, `status never became ${status} (now ${d.status})`);
    await sleep(100);
  }
}

/** Reopen the page with decisions already seeded and wait until something to operate on appears */
async function reopen(ready = "document.querySelector('#decision .opt, #decision .btn')") {
  ab("open", base + "/");
  await waitFor("screen render", ready);
}

const cards = `[...document.querySelectorAll("#decision .opt")]`;
const view = () => ev<{ cursor: number; checked: number }>(
  `JSON.stringify({ cursor: ${cards}.findIndex(e => e.classList.contains("cursor")), checked: ${cards}.findIndex(e => e.querySelector("input").checked) })`,
);
const fire = (code: string) => ev(
  `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Process", code: "${code}", keyCode: 229, bubbles: true, cancelable: true })), "ok"`,
);

/** Start serve and wait until healthz passes (port / dataDir are fixed; also used for restarts) */
async function startServe() {
  serve = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "serve", "--port", String(port), "--data-dir", dataDir], { cwd: ROOT, stdio: "ignore", env: { ...process.env, HOME: home } });
  const end = Date.now() + 20000;
  for (;;) {
    try { if ((await fetch(base + "/healthz")).ok) break; } catch {}
    assert.ok(Date.now() < end, "serve did not start");
    await sleep(100);
  }
  token = readFileSync(join(dataDir, "token"), "utf8").trim();
}

before(async () => {
  if (!HAS_BROWSER) return;
  // Point HOME at a temp directory so ~/.ukagai and real sessions are untouched (the allowed range of transcript_path is based here too)
  home = mkdtempSync(join(tmpdir(), "ukagai-gui-"));
  dataDir = join(home, "data");
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  // A stale dist/ would skew server behavior, so always run src through tsx
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
  test(`GUI: ${name}`, { skip: HAS_BROWSER ? false : "agent-browser is not installed" }, async (t) => {
    await cancelAll();
    try { await fn(t); } finally { await cancelAll(); }
  });
}

gui("single select: j / k / G / gg / arrows move, the recommended option is preselected", async () => {
  await seedQuestion();
  await reopen();
  assert.deepEqual(view(), { cursor: 1, checked: 1 }); // B (Recommended)
  press("j");
  assert.deepEqual(view(), { cursor: 2, checked: 2 });
  press("k");
  assert.deepEqual(view(), { cursor: 1, checked: 1 });
  press("G");
  assert.deepEqual(view(), { cursor: 3, checked: 3 }); // free text
  press("g", "g");
  assert.deepEqual(view(), { cursor: 0, checked: 0 });
  press("ArrowDown");
  assert.deepEqual(view(), { cursor: 1, checked: 1 });
  press("ArrowUp");
  assert.deepEqual(view(), { cursor: 0, checked: 0 });
});

gui("j / k work with IME-style keys (key=Process, keyCode=229)", async () => {
  await seedQuestion();
  await reopen();
  assert.equal(view().cursor, 1);
  fire("KeyJ");
  assert.deepEqual(view(), { cursor: 2, checked: 2 });
  fire("KeyK");
  assert.deepEqual(view(), { cursor: 1, checked: 1 });
});

gui("Enter submits as answer_submitted, with the original label as the answer", async () => {
  const { id } = await seedQuestion();
  await reopen();
  press("j", "Enter");
  const d = await waitStatus(id, "answer_submitted");
  const [v] = Object.values(d.response.answers);
  assert.equal(v, "C");
});

gui("an option with the (Recommended) suffix is returned with its original label", async () => {
  const { id } = await seedQuestion();
  await reopen();
  press("Enter");
  const d = await waitStatus(id, "answer_submitted");
  assert.equal(Object.values(d.response.answers)[0], "B (Recommended)");
});

gui("multi select: Space toggles, Enter submits A, C", async () => {
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

gui("free text: i focuses the field, Esc leaves it and keeps the value, i then Enter submits", async () => {
  const { id } = await seedQuestion();
  await reopen();
  press("i");
  assert.equal(ev(`document.activeElement.classList.contains("free-text")`), true);
  ab("keyboard", "type", "foo");
  press("Escape");
  assert.equal(ev(`document.activeElement.classList.contains("free-text")`), false);
  assert.equal(ev(`document.querySelector(".free-text").value`), "foo");
  press("i", "Enter");
  const d = await waitStatus(id, "answer_submitted");
  assert.equal(Object.values(d.response.answers)[0], "foo");
});

gui("j works even when a button has focus", async () => {
  await seedQuestion();
  await reopen();
  assert.equal(ev(`document.getElementById("submit").focus(), document.activeElement.id`), "submit");
  press("j");
  assert.deepEqual(view(), { cursor: 2, checked: 2 });
});

gui("two pending: l / h switch, b opens the drawer, j Enter switches and closes", async () => {
  const a = await seedQuestion({ title: "First decision" });
  const b = await seedQuestion({ title: "Second decision" });
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

gui("plan: n opens the reason field, Esc cancels, y sends approve: true", async () => {
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

gui("there is no \"answer in the terminal\" button", async () => {
  await seedQuestion();
  await reopen();
  assert.equal(ev(`/terminal/i.test([...document.querySelectorAll("#decision button")].map(b => b.textContent).join(" "))`), false);
});

gui("?v= of GET / matches the build <v> on screen (with a decision and when empty)", async () => {
  const html = await (await fetch(base + "/")).text();
  const v = /\/public\/app\.js\?v=([0-9a-z]+)"/.exec(html)?.[1];
  assert.ok(v, "app.js gets ?v=");
  const mtime = Math.floor(statSync(join(ROOT, "public", "app.js")).mtimeMs).toString(36);
  assert.equal(v, mtime);
  assert.ok(new RegExp(`/public/app\\.css\\?v=[0-9a-z]+"`).test(html));
  await reopen("document.getElementById('empty') && !document.getElementById('empty').hidden");
  assert.equal(ev(`document.querySelector("#empty .build").textContent`), `build ${v}`);
  await seedQuestion();
  await reopen();
  assert.equal(ev(`document.body.innerText.includes("build ${v}")`), true);
});

gui("arrows: ← / → switch pending decisions (question), Home / End jump to first / last", async () => {
  const a = await seedQuestion({ title: "First decision" });
  const b = await seedQuestion({ title: "Second decision" });
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

gui("arrows: ← / → switch pending decisions (plan); buttons move with ↑ / ↓", async () => {
  const q = await seedQuestion({ title: "Question decision" });
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

gui("arrows: → inside the free-text field does not leave it", async () => {
  await seedQuestion();
  await seedQuestion();
  await reopen();
  press("End", "Enter"); // free-text card; empty, so focus goes to the field
  const onFree = () => ev<boolean>(`document.activeElement.classList.contains("free-text")`);
  assert.equal(onFree(), true);
  const t = () => ev<string>(`document.querySelector("#decision .v2-title").textContent`);
  const before = t();
  press("ArrowRight", "ArrowLeft");
  assert.equal(onFree(), true);
  assert.equal(t(), before);
});

gui("arrows: ← closes the drawer", async () => {
  await seedQuestion();
  await seedQuestion();
  await reopen();
  const drawer = () => ev<boolean>(`document.getElementById("drawer").classList.contains("open")`);
  press("b");
  assert.equal(drawer(), true);
  press("ArrowLeft");
  assert.equal(drawer(), false);
});

gui("arrows: the hint line says ↑↓ and not j/k; the pending button chips are ← →", async () => {
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

gui("blocker: the orange band and the what-you-need-to-do section are in the right column, and Enter alone sends the \"Done. Continue\" option", async () => {
  const { id, title, labels: blockerLabels, whyHeading: blockerWhyHeading, todoHeading: blockerTodoHeading } = await seedBlocker();
  await reopen();
  const right = (sel: string) => ev<boolean>(`!!document.querySelector("#decision ${sel}")`);
  assert.equal(right(".blocker-band"), true);
  assert.equal(ev<string>(`document.querySelector("#decision .blocker-band").textContent`), "Waiting for you");
  assert.equal(ev<string>(`document.querySelector("#decision .v2-title").textContent`), title);
  assert.equal(ev<string>(`document.querySelector("#decision .todo-cap").textContent`), blockerTodoHeading);
  assert.equal(ev<boolean>(`document.querySelector("#decision .todo").textContent.includes("gcloud auth login")`), true);
  assert.equal(right(".todo .copy-btn"), true);
  assert.equal(ev<boolean>(`document.querySelector("#background").textContent.includes(${JSON.stringify(blockerTodoHeading)})`), false); // not in the left column
  assert.equal(ev<boolean>(`document.querySelector("#background").textContent.includes(${JSON.stringify(blockerWhyHeading)})`), true);
  assert.equal(right(".rec-cap"), false); // no recommendation section, so no box either
  assert.equal(ev<string>(`document.title`), "(1) ukagai · Waiting for you");
  assert.equal(view().cursor, 0);
  press("Enter");
  const d = await waitStatus(id, "answer_submitted");
  assert.equal(Object.values(d.response.answers)[0], `${blockerLabels[0]} (Recommended)`);
});

gui("a long recommendation folds at 6 lines, the option cards and submit button stay on screen, and `.` shows the full text", async () => {
  const sentence = "This sentence reproduces a long recommendation and is used to check folding. ";
  const markdown = SEED_MD.replace("I recommend B because this is only a check.", sentence.repeat(10) + "The final sentence.");
  await seedQuestion({ markdown });
  ab("set", "viewport", "1440", "900");
  await reopen();
  const rect = (sel: string) => ev<{ top: number; bottom: number }>(`JSON.stringify((r => ({ top: r.top, bottom: r.bottom }))(document.querySelector("${sel}").getBoundingClientRect()))`);
  const vh = ev<number>(`window.innerHeight`);
  const inView = (sel: string) => { const r = rect(sel); return r.top >= 0 && r.bottom <= vh; };
  assert.equal(inView("#decision .opt:last-of-type"), true);
  assert.equal(inView("#submit"), true);
  assert.equal(ev<boolean>(`document.querySelector("#decision .rec-body").scrollHeight > document.querySelector("#decision .rec-body").clientHeight + 1`), true); // folded
  assert.equal(ev<string>(`document.querySelector("#decision .rec .more-chip").textContent`), "Show all .");
  press(".");
  assert.equal(ev<boolean>(`document.querySelector("#decision .rec-body").scrollHeight <= document.querySelector("#decision .rec-body").clientHeight + 1`), true); // full text visible
  assert.equal(ev<boolean>(`document.querySelector("#decision .rec-body").textContent.includes("The final sentence.")`), true);
  const r = rect("#decision .rec-body");
  assert.ok(r.bottom - r.top > 6 * 1.6 * 13, "expanding makes it taller than 6 lines");
  press(".");
  assert.equal(ev<boolean>(`document.querySelector("#decision .rec-body").scrollHeight > document.querySelector("#decision .rec-body").clientHeight + 1`), true); // . again folds it
});

gui("an explanation within the hook limits (pass-design.md) does not clamp and the right column fits in 900px", async () => {
  const markdown = readFileSync(new URL("../explain-fixtures/pass-design.md", import.meta.url), "utf8");
  await seedQuestion({ markdown, options: [{ label: "SSE (Recommended)", description: "SSE" }, { label: "WebSocket", description: "WS" }] });
  ab("set", "viewport", "1440", "900");
  await reopen();
  assert.equal(ev<number>(`document.querySelectorAll("#decision .more-chip").length`), 0);
  assert.equal(ev<boolean>(`document.getElementById("decision").scrollHeight <= document.getElementById("decision").clientHeight`), true);
  assert.equal(ev<boolean>(`document.getElementById("decision").clientHeight <= 900`), true);
});

// ---- Q1 fixes (FA) ----

/** A v2 explanation. rows are [label (first table column), what happens, risks] */
function v2md(question: string, title: string, rows: string[][], extra = "", rec = "I recommend B."): string {
  const table = rows.map((r) => `| ${r.join(" | ")} |`).join("\n");
  return `---\nukagai: 1\nquestion: ${question}\ntitle: ${title}\nrecommended: B\nreversibility: reversible\nscope: file\n---\n\n## Why this decision is needed now\n\nFor verification.\n\n${extra}## Options\n\n| Option | What happens if chosen | Risks and how to undo |\n|---|---|---|\n${table}\n\n## Recommendation\n\n${rec}\n`;
}
const ROWS = [["A", "A happens", "None"], ["B", "B happens", "None"], ["C", "C happens", "None"]];

gui("recovery after 401: new decisions show up within 10 seconds of a server restart", async () => {
  const a = await seedQuestion({ title: "Decision before restart" });
  await reopen();
  assert.equal(ev(`document.querySelector("#decision .v2-title").textContent`), a.title);
  const old = serve!;
  old.kill();
  await new Promise((r) => (old.exitCode !== null ? r(null) : old.once("exit", r)));
  await sleep(1500);
  await startServe(); // same port / data-dir; the cookie expires
  const b = await seedQuestion({ title: "Decision after restart" });
  await waitFor("the decision after restart appears in the list", `document.getElementById("pending-list").textContent.includes(${JSON.stringify(b.title)}) || document.querySelector("#decision .v2-title")?.textContent === ${JSON.stringify(b.title)}`, 10000);
  assert.equal(ev(`document.getElementById("banner").hidden`), true);
});

gui("while the server is down: a \"Cannot connect\" banner and empty state; after restart they clear, a \"Reconnected\" toast shows and new decisions appear", async () => {
  await reopen("document.getElementById('empty') && !document.getElementById('empty').hidden");
  assert.equal(ev(`document.getElementById("banner").hidden`), true);
  const old = serve!;
  old.kill();
  await new Promise((r) => (old.exitCode !== null ? r(null) : old.once("exit", r)));
  await waitFor("the cannot-connect banner", `!document.getElementById("banner").hidden && document.getElementById("banner").textContent.includes("Cannot connect") && document.getElementById("banner").textContent.includes(location.origin)`, 3000);
  assert.equal(ev(`document.getElementById("empty-title").textContent`), "Cannot connect");
  await sleep(1000);
  await startServe();
  await waitFor("the Reconnected toast", `[...document.querySelectorAll(".toast.ok")].some(t => t.textContent === "Reconnected")`, 12000);
  assert.equal(ev(`document.getElementById("banner").hidden`), true);
  const b = await seedQuestion({ title: "Decision after stop" });
  await waitFor("new decision", `document.querySelector("#decision .v2-title")?.textContent === ${JSON.stringify(b.title)}`, 10000);
  assert.equal(ev(`document.getElementById("empty").hidden`), true);
});

// ---- Q3 fixes (FG) ----

gui("a CAUTION callout stays fully visible inside the frame even when the recommendation is folded", async () => {
  const sentence = "This choice affects where settings are stored and the order they are loaded in for a long time, so review it carefully including its interaction with other features. ";
  const rec = `I recommend B. ${sentence.repeat(8)}\n\n> [!CAUTION]\n> This cannot be undone. Running it is irreversible, so be careful.`;
  const question = "A callout question?";
  await seedQuestion({ markdown: v2md(question, "Callout decision", ROWS, "", rec), options: [{ label: "A" }, { label: "B (Recommended)" }, { label: "C" }] });
  ab("set", "viewport", "1440", "900");
  await reopen();
  await waitFor("folding (show-all chip)", `document.querySelector("#decision .rec-main.has-more")`);
  const r = ev<{ h: number; inBody: boolean; top: number; bottom: number; recTop: number; recBottom: number; bodyBottom: number }>(`JSON.stringify((() => {
    const c = document.querySelector("#decision .rec .callout"), rec = document.querySelector("#decision .rec").getBoundingClientRect(), b = document.querySelector("#decision .rec-body").getBoundingClientRect(), r = c.getBoundingClientRect();
    return { h: r.height, inBody: !!c.closest(".rec-body"), top: r.top, bottom: r.bottom, recTop: rec.top, recBottom: rec.bottom, bodyBottom: b.bottom };
  })())`);
  assert.ok(r.h > 0 && !r.inBody, JSON.stringify(r));
  assert.ok(r.top >= r.bodyBottom - 1 && r.top >= r.recTop && r.bottom <= r.recBottom + 1, `the callout is visible inside the recommendation frame, below the fold: ${JSON.stringify(r)}`);
  assert.equal(ev<boolean>(`document.querySelector("#decision .rec .callout").textContent.includes("irreversible")`), true);
  assert.equal(ev<boolean>(`!document.getElementById("decision").classList.contains("expanded")`), true); // still folded
});

gui("long inline code wraps at the column width and --port is not split", async () => {
  const path = "src/serve/handlers/some-very-long-directory-name/another-quite-long-segment-name/file-name-long.ts-x";
  const long = `src/${"a-long-dir-name/".repeat(7)}file.ts`;
  assert.ok(long.length >= 120);
  const rec = `Start with \`--port\`. The target path is \`${long}\`.${path.length > 0 ? "" : ""}`;
  await seedQuestion({ markdown: v2md("A code question?", "Code decision", ROWS, "", rec), options: [{ label: "A" }, { label: "B (Recommended)" }, { label: "C" }] });
  ab("set", "viewport", "1440", "900");
  await reopen();
  const r = ev<{ over: number; lines: number; port: string; cw: number; sw: number }>(`JSON.stringify((() => {
    const body = document.querySelector("#decision .rec-body"), br = body.getBoundingClientRect();
    const codes = [...body.querySelectorAll("code")];
    const over = Math.max(...codes.flatMap(c => [...c.getClientRects()].map(x => x.right - br.right)));
    const port = codes.find(c => c.textContent.includes("port"));
    return { over, lines: port.getClientRects().length, port: port.textContent, cw: body.clientWidth, sw: body.scrollWidth };
  })())`);
  assert.ok(r.over <= 1, `code exceeds the column width: ${JSON.stringify(r)}`);
  assert.ok(r.sw <= r.cw, `scrollWidth <= clientWidth: ${JSON.stringify(r)}`);
  assert.equal(r.lines, 1, JSON.stringify(r)); // --port stays on one line
  assert.equal(r.port, "--port");
});

gui("cancelling a decision that is not shown gives a red toast (at most 3, above the submit button)", async () => {
  await seedQuestion({ title: "Shown decision" });
  const others = [await seedQuestion({ title: "Background decision 1" }), await seedQuestion({ title: "Background decision 2" }), await seedQuestion({ title: "Background decision 3" }), await seedQuestion({ title: "Background decision 4" })];
  await reopen();
  for (const o of others) await api(`/api/decisions/${o.id}/cancel`, {});
  await waitFor("toast", `document.querySelectorAll(".toast.lost").length === 3`);
  const text = ev<string>(`document.querySelector(".toast.lost").textContent`);
  assert.ok(text.includes("was cancelled") && !text.includes("did not reach"), text); // cancel of an unanswered decision
  const r = ev<{ t: number; b: number }>(`JSON.stringify((() => { const t = document.querySelector(".toasts").getBoundingClientRect(), s = document.getElementById("submit").getBoundingClientRect(); return { t: t.bottom, b: s.top }; })())`);
  assert.ok(r.t <= r.b, `toasts do not overlap the submit button: ${JSON.stringify(r)}`);
});

gui("plan: the heading is plain text and \"Scope and reversibility\" is in the right column (absent when missing)", async () => {
  await seedPlan("# Fix `src/foo.ts` **now** plan\n\n## Work\n\n1. a\n\n## Scope and reversibility\n\nInside one file. Revert with git.\n");
  await reopen("document.querySelector('#decision .btn')");
  assert.equal(ev<string>(`document.querySelector("#decision .v2-title").textContent`), "Fix src/foo.ts now plan");
  assert.equal(ev<boolean>(`document.querySelector("#decision .impact").textContent.includes("Revert with git")`), true);
  assert.equal(ev<string>(`document.querySelector("#decision .impact-cap").textContent`), "Scope and reversibility");
  await cancelAll();
  await seedPlan("# Plan\n\n## Work\n\n1. a\n");
  await reopen("document.querySelector('#decision .btn')");
  assert.equal(ev<boolean>(`!!document.querySelector("#decision .impact")`), false);
});

gui("wide diagram: f goes full width (hides the decision column), Enter is disabled, Esc returns", async () => {
  const wide = "## Diagram\n\n```mermaid\nflowchart LR\n" + Array.from({ length: 14 }, (_, i) => `  N${i}[Node ${i} has a long label] --> N${i + 1}[Node ${i + 1} has a long label]`).join("\n") + "\n```\n\n";
  const question = "A wide diagram question?";
  const { id } = await seedQuestion({ markdown: v2md(question, "Wide diagram decision", ROWS, wide), options: [{ label: "A" }, { label: "B (Recommended)" }, { label: "C" }] });
  ab("set", "viewport", "1440", "900");
  await reopen();
  await waitFor("full-width chip", `document.querySelector("#background .wide-chip")`, 10000);
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
  ab("click", ".wide-chip"); // a click also enters it
  assert.equal(full(), true);
  press("f");
  assert.equal(full(), false);
});

gui("no explanation: (Recommended) is stripped into a recommended badge and the reason is plain text", async () => {
  await seedQuestion({ explain: false, noneReason: "loop_guard", options: [{ label: "A (Recommended)" }, { label: "B" }] });
  await reopen();
  assert.equal(ev<string>(`document.querySelector("#decision .opt .lab").textContent`), "ARecommended");
  assert.equal(ev<boolean>(`!!document.querySelector("#decision .opt .rec-badge")`), true);
  const note = ev<string>(`document.querySelector("#background .bg-note").textContent`);
  assert.ok(note.includes("did not follow the rewrite instruction") && !note.includes("loop_guard"), note);
  assert.deepEqual(view(), { cursor: 0, checked: 0 });
  press("Enter");
  const list = (await api("/api/decisions?status=answer_submitted")) as any[];
  assert.equal(Object.values(list.at(-1).response.answers)[0], "A (Recommended)");
});

gui("external and relative img in an explanation are removed, data: stays", async () => {
  const imgs = `<img src="https://example.invalid/a.png">\n\n<img src="//example.invalid/b.png">\n\n<img src="x">\n\n<img src="/x">\n\n<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">\n\n`;
  await seedQuestion({ markdown: v2md("An image question?", "Image decision", ROWS, imgs) });
  await reopen();
  assert.equal(ev<number>(`document.querySelectorAll("#background img").length`), 1);
  assert.equal(ev<boolean>(`document.querySelector("#background img").src.startsWith("data:")`), true);
});

gui("v2 cards still render when a label contains <b> (only options that do not match are filled in raw)", async () => {
  const label = '<b>A</b> "quoted"';
  await seedQuestion({
    markdown: v2md("An HTML label question?", "HTML label decision", [[label, "A happens", "None"], ["B", "B happens", "None"]]),
    options: [{ label, description: "Raw description A" }, { label: "B (Recommended)", description: "Raw description B" }, { label: "Z", description: "Raw description Z" }],
  });
  await reopen();
  const labs = ev<string[]>(`JSON.stringify([...document.querySelectorAll("#decision .opt .lab")].map(e => e.firstChild.textContent))`);
  assert.deepEqual(labs.slice(0, 3), ['A "quoted"', "B", "Z"]);
  assert.equal(ev<boolean>(`document.querySelector("#decision .opt .desc").textContent.includes("A happens")`), true); // from the table
  assert.equal(ev<boolean>(`document.body.innerText.includes("Raw description Z")`), true); // an option that does not match stays raw
  assert.equal(ev<boolean>(`document.body.innerText.includes("Raw description A")`), false);
  assert.equal(ev<boolean>(`!!document.querySelector("#decision .rec-cap")`), true);
});

gui("1000x700 with two pending: →, answering and cancel do not blank the screen or throw", async () => {
  ab("set", "viewport", "1000", "700");
  try {
    const a = await seedQuestion({ title: "Switch first" });
    const b = await seedQuestion({ title: "Switch second" });
    await reopen();
    ev(`window.__errs = [], window.addEventListener("error", (e) => window.__errs.push(String(e.message))), window.addEventListener("unhandledrejection", (e) => window.__errs.push(String(e.reason))), "ok"`);
    const title = () => ev<string>(`document.querySelector("#decision .v2-title")?.textContent ?? ""`);
    assert.equal(title(), a.title);
    assert.equal(ev<boolean>(`!!document.querySelector("#decision .title-row #pending-btn")`), true); // the pending pill is in the heading row
    press("ArrowRight");
    assert.equal(title(), b.title); // the next decision shows instead of an empty view
    assert.equal(ev<boolean>(`!!document.getElementById("pending-btn")`), true);
    press("ArrowLeft");
    assert.equal(title(), a.title);
    press("Enter"); // answer a, then the rest (b) shows
    await waitFor("the remaining decision", `document.querySelector("#decision .v2-title")?.textContent === ${JSON.stringify(b.title)}`);
    await api(`/api/decisions/${b.id}/cancel`, {});
    await waitFor("the empty state", `!document.getElementById("empty").hidden && document.getElementById("main").hidden`);
    assert.deepEqual(ev<string[]>(`JSON.stringify(window.__errs)`), []);
  } finally {
    ab("set", "viewport", "1440", "900");
  }
});

gui("a background decision that fell back (not counted as answered) says \"did not reach\"", async () => {
  await seedQuestion({ title: "Shown decision" });
  const o = await seedQuestion({ title: "Background decision F" });
  await reopen();
  await api(`/api/decisions/${o.id}/answer`, { fallback: true });
  await waitFor("toast", `document.querySelector(".toast.lost")`);
  const text = ev<string>(`document.querySelector(".toast.lost").textContent`);
  assert.ok(text.includes("did not reach"), text);
});

gui("inline code wraps at the column width (not nowrap), words with `-` are a nowrap span + wbr, U+2060 is not used, and code blocks are unchanged", async () => {
  await seedQuestion({ markdown: v2md("A code question?", "Code decision", ROWS, "`some-very-long-inline-code-identifier`\n\n```\nblock\n```\n\n") });
  await reopen();
  const cs = ev<{ ws: string; wrap: string }>(`JSON.stringify((() => { const s = getComputedStyle(document.querySelector("#background :not(pre) > code")); return { ws: s.whiteSpace, wrap: s.overflowWrap }; })())`);
  assert.deepEqual(cs, { ws: "normal", wrap: "anywhere" });
  assert.equal(ev<string>(`document.querySelector("#background :not(pre) > code").textContent`), "some-very-long-inline-code-identifier");
  assert.equal(ev<number>(`document.querySelectorAll("#background :not(pre) > code wbr").length`), 5);
  assert.equal(ev<string>(`getComputedStyle(document.querySelector("#background :not(pre) > code .nb")).whiteSpace`), "nowrap");
  assert.equal(ev<string>(`getComputedStyle(document.querySelector("#background pre code")).whiteSpace`), "pre");
});

gui("copying selected inline code does not include U+2060", async () => {
  await seedQuestion({ markdown: v2md("A code question?", "Code decision", ROWS, "Start with `--port`.", "") });
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

gui("the connection banner does not cover the top of the decision screen and no vertical scroll appears (1440x900 / 1000x700)", async () => {
  for (const [w, h] of [["1440", "900"], ["1000", "700"]]) {
    await seedQuestion({ title: "Decision under the banner" });
    ab("set", "viewport", w, h);
    await reopen();
    const old = serve!;
    old.kill();
    await new Promise((r) => (old.exitCode !== null ? r(null) : old.once("exit", r)));
    await waitFor("the cannot-connect banner", `!document.getElementById("banner").hidden`, 5000);
    const r = ev<{ bannerBottom: number; titleTop: number; bgTop: number; sh: number; ih: number }>(`JSON.stringify({
      bannerBottom: document.getElementById("banner").getBoundingClientRect().bottom,
      titleTop: document.querySelector("#decision .v2-title").getBoundingClientRect().top,
      bgTop: document.getElementById("background").getBoundingClientRect().top,
      sh: document.documentElement.scrollHeight, ih: innerHeight })`);
    assert.ok(r.titleTop >= r.bannerBottom, `${w}x${h}: ${JSON.stringify(r)}`);
    assert.ok(r.bgTop >= r.bannerBottom, `${w}x${h}: ${JSON.stringify(r)}`);
    assert.ok(r.sh <= r.ih, `${w}x${h}: ${JSON.stringify(r)}`);
    await startServe();
    await waitFor("the banner disappears", `document.getElementById("banner").hidden`, 12000);
  }
});

// ---- Display language (en / ja) ----

/** Switch the display language of the open page the way the server injection would, and wait for the re-render. */
async function setLang(lang: "en" | "ja", ready: string) {
  ev(`document.documentElement.dataset.lang = ${JSON.stringify(lang)}, "ok"`);
  await waitFor(`language ${lang} applied`, ready);
}

test("i18n: en and ja have the same key set, and no value is empty", async () => {
  const { MESSAGES } = (await import(new URL("../../public/i18n.js", import.meta.url).href)) as { MESSAGES: Record<"en" | "ja", Record<string, string>> };
  assert.deepEqual(Object.keys(MESSAGES.ja).sort(), Object.keys(MESSAGES.en).sort());
  for (const lang of ["en", "ja"] as const) {
    for (const [k, v] of Object.entries(MESSAGES[lang])) assert.ok(v.length > 0, `${lang}.${k} is empty`);
  }
  const vars = (v: string) => [...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const k of Object.keys(MESSAGES.en)) assert.deepEqual(vars(MESSAGES.ja[k]!), vars(MESSAGES.en[k]!), `placeholders of ${k}`);
});

gui("ja: main UI strings are Japanese after data-lang is set to ja", async () => {
  await seedQuestion();
  await seedQuestion();
  await reopen();
  assert.equal(ev<string>(`document.getElementById("submit").textContent`).startsWith("Answer"), true);
  assert.equal(ev<string>(`document.getElementById("pending-btn").textContent`).startsWith("Pending"), true);
  try {
    await setLang("ja", `document.getElementById("submit")?.textContent.startsWith("回答する")`);
    assert.equal(ev<boolean>(`document.getElementById("pending-btn").textContent.startsWith("保留")`), true);
    assert.equal(ev<boolean>(`document.getElementById("drawer").getAttribute("aria-label") === "保留一覧"`), true);
    assert.equal(ev<boolean>(`document.querySelector("#decision .rec-badge").textContent === "推奨"`), true);
    assert.equal(ev<boolean>(`document.querySelector("#decision .hint").textContent.includes("次の保留")`), true);
    assert.equal(ev<boolean>(`document.querySelector(".free-text").placeholder === "自由記述"`), true);
    assert.equal(ev<string>(`document.documentElement.lang`), "ja");
    // The headings shown in the right column are the file's own (English here), not translated
    assert.equal(ev<string>(`document.querySelector("#decision .rec-cap").textContent`), "Recommendation");
  } finally {
    ev(`document.documentElement.dataset.lang = "en", "ok"`);
  }
});

gui("ja: blocker band, title and badges follow the display language", async () => {
  await seedBlocker();
  await reopen();
  try {
    await setLang("ja", `document.querySelector("#decision .blocker-band")?.textContent === "人の作業待ち"`);
    assert.equal(ev<string>(`document.title`), "(1) ukagai · 作業待ち");
    assert.equal(ev<boolean>(`document.querySelector("#decision .todo .copy-btn").textContent === "コピー"`), true);
  } finally {
    ev(`document.documentElement.dataset.lang = "en", "ok"`);
  }
});

gui("ja: the connection banner and empty state are Japanese", async () => {
  await reopen("document.getElementById('empty') && !document.getElementById('empty').hidden");
  await setLang("ja", `document.getElementById("empty-title").textContent === "判断待ちはありません"`);
  const old = serve!;
  old.kill();
  await new Promise((r) => (old.exitCode !== null ? r(null) : old.once("exit", r)));
  try {
    await waitFor("the Japanese banner", `!document.getElementById("banner").hidden && document.getElementById("banner").textContent.includes("接続できません")`, 5000);
    assert.equal(ev(`document.getElementById("empty-title").textContent`), "接続できません");
  } finally {
    await startServe();
    await waitFor("the banner disappears", `document.getElementById("banner").hidden`, 12000);
    ev(`document.documentElement.dataset.lang = "en", "ok"`);
  }
});

gui("a Japanese-headed explanation renders the same card as an English one", async () => {
  await seedQuestion({ jaSeed: true });
  await reopen();
  // Same structure as the English seed: 3 option cards + free text, B preselected, recommendation box present
  assert.deepEqual(view(), { cursor: 1, checked: 1 });
  assert.equal(ev<number>(`document.querySelectorAll("#decision .opt").length`), 4);
  assert.equal(ev<string>(`document.querySelector("#decision .rec-cap").textContent`), "推奨"); // the file's own heading
  assert.equal(ev<boolean>(`document.querySelector("#decision .opt .desc").textContent === "A が選ばれる"`), true);
  assert.equal(ev<boolean>(`document.querySelector("#background").textContent.includes("なぜ今この判断が要るか")`), true);
  assert.equal(ev<boolean>(`!document.querySelector("#background").textContent.includes("選択肢")`), true); // the options section moved to the right
});

gui("an English-headed explanation puts the options table on the cards, not in the left column", async () => {
  await seedQuestion();
  await reopen();
  assert.equal(ev<string>(`document.querySelector("#decision .rec-cap").textContent`), "Recommendation");
  assert.equal(ev<boolean>(`document.querySelector("#decision .opt .desc").textContent === "A is selected"`), true);
  assert.equal(ev<boolean>(`!document.querySelector("#background").textContent.includes("Options")`), true);
  assert.equal(ev<boolean>(`document.querySelector("#background").textContent.includes("Why this decision is needed now")`), true);
});
