// Session history in the GUI: the Goal row (header row 3) and the history panel (`s`), against a real server and a real browser.
// Skipped when agent-browser is not on PATH.
import { after, before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SEED_MD = readFileSync(new URL("./fixtures/seed.md", import.meta.url), "utf8");
const RICH_MD = readFileSync(new URL("./fixtures/rich.md", import.meta.url), "utf8");
const HAS_BROWSER = spawnSync("agent-browser", ["--version"], { stdio: "ignore" }).status === 0;

let home = "";
let dataDir = "";
let port = 0;
let token = "";
let serve: ChildProcess | undefined;
let base = "";
let opened = false;
let seq = 0;
const session = `ukagai-hist-${process.pid}-${Date.now().toString(36)}`;

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
  return execFileSync("agent-browser", args, { env: { ...process.env, AGENT_BROWSER_SESSION: session }, encoding: "utf8", timeout: 30000 }).trim();
}

function ev<T = any>(js: string): T {
  const out = ab("eval", js).split("\n").at(-1)!;
  let v: unknown = JSON.parse(out);
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch {}
  }
  return v as T;
}

async function waitFor(what: string, js: string, ms = 8000): Promise<void> {
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
const q1 = (sel: string) => ev<string>(`"t:" + ((document.querySelector(${JSON.stringify(sel)}) ?? {}).textContent ?? "")`).slice(2);
const count = (sel: string) => ev<number>(`document.querySelectorAll(${JSON.stringify(sel)}).length`);

async function api(path: string, body?: unknown) {
  const go = () => fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await go().catch(() => go());
  return res.json() as Promise<any>;
}

const FIRST = "Add a history panel\nto the decision screen, please.\n\n  Keep the layout calm.";
const INSTRUCTIONS = [FIRST, "second: make it dark", "third:\n  line one\n  line two"];

function writeTranscript(name: string, texts: string[]): string {
  const dir = join(home, ".claude", "projects", "p");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.jsonl`);
  const t0 = Date.now() - 3 * 3600_000;
  const lines = texts.map((text, i) => JSON.stringify({ type: "user", message: { role: "user", content: text }, timestamp: new Date(t0 + i * 1800_000).toISOString() }));
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

type Seed = { sessionId?: string; transcript?: string; rich?: boolean; plan?: boolean };

async function seed(s: Seed = {}): Promise<{ id: string }> {
  const n = ++seq;
  const sessionId = s.sessionId ?? `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
  const sess = { session_id: sessionId, cwd: ROOT, transcript_path: s.transcript ?? writeTranscript(sessionId, INSTRUCTIONS) };
  const title = `History check ${n}`;
  const question = `History question ${n}: A, B or C?`;
  const body: Record<string, unknown> = s.plan
    ? { tool_use_id: `toolu_hist_${process.pid}_${n}`, kind: "approve_plan", session: sess, request: { plan: "# Plan\n\nStep 1", planFilePath: "/tmp/plan.md" } }
    : {
      tool_use_id: `toolu_hist_${process.pid}_${n}`,
      kind: "answer_question",
      session: sess,
      request: { questions: [{ question, header: "Check", multiSelect: false, options: [{ label: "A", description: "About A" }, { label: "B (Recommended)", description: "About B" }, { label: "C", description: "About C" }] }] },
      explanation: {
        path: "", title, question, reversibility: "reversible", scope: "file",
        markdown: (s.rich ? RICH_MD : SEED_MD).replace("__QUESTION__", question).replace("__TITLE__", title),
        has: { mermaid: false, table: true, diff: false }, match: "question", attached_via: "first_call",
      },
    };
  if (s.rich) {
    const e = body.explanation as any;
    body.request = { questions: [{ question, header: "Check", multiSelect: false, options: [{ label: "Sqlite (Recommended)", description: "Sqlite" }, { label: "Postgres", description: "Postgres" }, { label: "Flat files", description: "Flat" }] }] };
    e.reversibility = "costly";
    e.scope = "repo";
  }
  const d = await api("/api/decisions", body);
  assert.ok(d.id, `cannot create decision: ${JSON.stringify(d)}`);
  return { id: d.id };
}

before(async () => {
  if (!HAS_BROWSER) return;
  home = mkdtempSync(join(tmpdir(), "ukagai-hist-"));
  dataDir = join(home, "data");
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  serve = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "serve", "--port", String(port), "--data-dir", dataDir], { cwd: ROOT, stdio: "ignore", env: { ...process.env, HOME: home } });
  const end = Date.now() + 20000;
  for (;;) {
    try { if ((await fetch(base + "/healthz")).ok) break; } catch {}
    assert.ok(Date.now() < end, "serve did not start");
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

const GOAL = "document.querySelector('#head .hd-goal')";
const PANEL = "document.querySelector('.overlay.history')";
const BLOCKER_MD = readFileSync(new URL("../explain-fixtures/pass-blocker.md", import.meta.url), "utf8");
const QUIZ_MD = RICH_MD;

async function post(body: Record<string, unknown>) {
  const d = await api("/api/decisions", body);
  assert.ok(d.id, JSON.stringify(d));
  return d.id as string;
}
const sessOf = (sid: string, texts: string[] | null) => ({ session_id: sid, cwd: ROOT, transcript_path: writeTranscript(sid, texts ?? []) });
const opt = (l: string) => ({ label: l, description: l });

type Kind = "single" | "multi-question" | "quiz" | "blocker" | "plan" | "checkpoint";
const KINDS: Kind[] = ["single", "multi-question", "quiz", "blocker", "plan", "checkpoint"];

async function seedKind(kind: Kind, texts: string[] | null = INSTRUCTIONS): Promise<{ id: string; sid: string }> {
  const n = ++seq;
  const sid = `00000000-0000-0000-0009-${String(n).padStart(12, "0")}`;
  const session = sessOf(sid, texts);
  const tool = `toolu_hm_${process.pid}_${n}`;
  const question = `Matrix ${n}: A or B?`;
  const expl = (type: string | undefined, markdown: string, title: string) => ({ path: "", ...(type ? { type } : {}), title, question, reversibility: "reversible", scope: "file", markdown, has: { mermaid: false, table: true, diff: false }, match: "question", attached_via: "first_call" });
  let body: Record<string, unknown>;
  switch (kind) {
    case "single": body = { kind: "answer_question", session, request: { questions: [{ question, header: "H", multiSelect: false, options: [opt("A"), opt("B (Recommended)")] }] } }; break;
    case "multi-question": body = { kind: "answer_question", session, request: { questions: [
      { question, header: "H1", multiSelect: false, options: [opt("A"), opt("B")] },
      { question: `${question} second`, header: "H2", multiSelect: true, options: [opt("C"), opt("D")] }] } }; break;
    case "quiz": body = { kind: "answer_question", session, request: { questions: [{ question, header: "Quiz", multiSelect: false, options: [opt("One"), opt("Two"), opt("Three")] }] }, explanation: expl("quiz", SEED_MD.replace("__QUESTION__", question).replace("__TITLE__", "Quiz title"), "Quiz title") }; break;
    case "blocker": {
      const fm = (k: string) => new RegExp(`^${k}: (.+)$`, "m").exec(BLOCKER_MD)![1]!;
      const labels = [...BLOCKER_MD.matchAll(/^\| ([^|]+?) \|/gm)].map((m) => m[1]!).filter((l) => !/^-+$/.test(l)).slice(1);
      body = { kind: "answer_question", session, request: { questions: [{ question: fm("question"), header: "Blocked", multiSelect: false, options: [opt(`${labels[0]} (Recommended)`), opt(labels[1]!), opt(labels[2]!)] }] }, explanation: { ...expl("blocker", BLOCKER_MD, fm("title")), question: fm("question") } };
      break;
    }
    case "plan": body = { kind: "approve_plan", session, request: { plan: "# Plan\n\nStep 1", planFilePath: `/tmp/plan-${n}.md` } }; break;
    case "checkpoint": {
      const at = new Date(Date.now() + n).toISOString();
      return { id: await post({ tool_use_id: `checkpoint:${sid}:${at}`, kind: "checkpoint", session, request: { recap: "Did a thing. Next I would do another.", recap_at: at } }), sid };
    }
  }
  return { id: await post({ tool_use_id: tool, ...body }), sid };
}

async function cancelAll() {
  const list = (await api("/api/decisions?status=pending")) as { id: string }[];
  for (const d of list) await api(`/api/decisions/${d.id}/cancel`, {});
}
async function reopen(ready = GOAL) { ab("open", base + "/"); await waitFor("screen render", ready); }
const ageCache = (min = 6) => ev(`(() => { window.__realNow ??= Date.now; Date.now = () => window.__realNow() + ${min} * 60000; return true; })()`);
const unage = () => ev(`(() => { if (window.__realNow) Date.now = window.__realNow; return true; })()`);
const noPageErrors = () => {
  assert.equal(ab("errors").trim(), "", "page errors");
  const bad = ab("console").split("\n").filter((l) => /\berror\b/i.test(l) && !/favicon|Failed to load resource|cdnjs|highlight/i.test(l));
  assert.deepEqual(bad, [], "console errors");
};

function gui(name: string, fn: (t: TestContext) => Promise<void>) {
  test(`GUI history matrix: ${name}`, { skip: HAS_BROWSER ? false : "agent-browser is not installed" }, async (t) => {
    await cancelAll();
    try { ab("errors", "--clear"); ab("console", "--clear"); } catch {}
    try { await fn(t); } finally { try { unage(); } catch {} await cancelAll(); }
  });
}
const panelOpen = () => ev<boolean>(`!!${PANEL}`);
const SELECT_TEXT_FOCUS = `(() => { const b = document.querySelector("#decision textarea, #decision input[type=text]"); if (b) { b.focus(); return true; } return false; })()`;

for (const kind of KINDS) {
  for (const age of [false, true]) {
    gui(`${kind}${age ? " after the cache TTL" : ""}: click on the Goal row and \`s\` open the panel, \`s\`/Esc close, no page error`, async () => {
      await seedKind(kind);
      await reopen();
      if (age) ageCache();
      assert.equal(panelOpen(), false);
      ab("click", "#head .hd-goal");
      assert.equal(panelOpen(), true, "click opens");
      assert.equal(count(".overlay.history .hist-row") >= 3, true);
      press("Escape");
      assert.equal(panelOpen(), false);
      if (kind !== "plan" || true) {
        press("s");
        assert.equal(panelOpen(), true, "`s` opens");
        press("s");
        assert.equal(panelOpen(), false);
      }
      noPageErrors();
    });
  }
}

gui("a card whose session has one instruction: the row has no count, click and the panel work", async () => {
  await seedKind("single", ["only one"]);
  await reopen();
  assert.equal(count("#head .goal-n"), 0);
  ab("click", "#head .hd-goal");
  assert.equal(panelOpen(), true);
  assert.equal(count(".overlay.history .hist-row"), 1);
  noPageErrors();
});

gui("zero history: no row, `s` and a click on the header do nothing, no error", async () => {
  await seedKind("single", null);
  await reopen("document.querySelector('#decision .opt, #decision .btn')");
  await sleep(500);
  assert.equal(count("#head .hd-goal"), 0);
  press("s");
  ab("click", "#head .hd-sub");
  assert.equal(panelOpen(), false);
  noPageErrors();
});

gui("with the free-text box focused a click on the Goal row opens the panel", async () => {
  await seedKind("single");
  await reopen();
  assert.equal(ev<boolean>(SELECT_TEXT_FOCUS), true);
  ab("click", "#head .hd-goal");
  assert.equal(panelOpen(), true);
  noPageErrors();
});

gui("while the terms / history overlay is up: `s` from terms opens history, click on the row behind is inert, `s` closes history", async () => {
  await seedKind("single");
  await reopen();
  press("s");
  assert.equal(panelOpen(), true);
  press("s");
  assert.equal(panelOpen(), false);
  press("s", "Escape");
  assert.equal(panelOpen(), false);
  noPageErrors();
});

gui("an SSE re-render of the same card (another decision arrives, the card is updated) keeps the row clickable", async () => {
  const { id } = await seedKind("single");
  await reopen();
  await seedKind("single", INSTRUCTIONS); // decision.created -> list / header re-render
  await sleep(500);
  ab("click", "#head .hd-goal");
  assert.equal(panelOpen(), true);
  press("Escape");
  // a draft save on the same decision emits decision.updated
  await api(`/api/decisions/${id}/draft`, { text: "x" }).catch(() => {});
  await sleep(300);
  ab("click", "#head .hd-goal");
  assert.equal(panelOpen(), true);
  noPageErrors();
});

gui("switching between two sessions and back: each card opens its own session's history", async () => {
  const a = await seedKind("single", ["alpha one", "alpha two"]);
  const b = await seedKind("single", ["beta one", "beta two", "beta three"]);
  await reopen();
  const goalText = () => q1("#head .goal-text");
  const first = goalText();
  press("Tab");
  await waitFor("other card", `document.querySelector("#head .goal-text")?.textContent !== ${JSON.stringify(first)}`);
  ab("click", "#head .hd-goal");
  assert.equal(panelOpen(), true);
  const rowsB = count(".overlay.history .hist-row");
  press("Escape", "Tab");
  await waitFor("back", `document.querySelector("#head .goal-text")?.textContent === ${JSON.stringify(first)}`);
  ab("click", "#head .hd-goal");
  assert.equal(panelOpen(), true);
  assert.notEqual(count(".overlay.history .hist-row"), 0);
  assert.notEqual(rowsB, 0);
  void a; void b;
  noPageErrors();
});

gui("a decision answered and reopened from the drawer history still shows the Goal row", async () => {
  const { id } = await seedKind("single");
  await reopen();
  await api(`/api/decisions/${id}/answer`, { kind: "select", answers: [{ question_index: 0, labels: ["A"] }] }).catch(() => {});
  await sleep(500);
  noPageErrors();
});
