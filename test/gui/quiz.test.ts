// The GUI: a quiz card (explanation type quiz): the Quiz band, the title, the sections, the options as given and no recommendation.
// A real server (temp HOME) and a real browser (agent-browser). Skipped when agent-browser is not on PATH.
import { after, before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SEED_MD = readFileSync(new URL("./fixtures/seed.md", import.meta.url), "utf8");
const HAS_BROWSER = spawnSync("agent-browser", ["--version"], { stdio: "ignore" }).status === 0;
const SHOTS = process.env.UKAGAI_SHOTS_DIR ?? join(tmpdir(), "ukagai-shots");
mkdirSync(SHOTS, { recursive: true });

let home = "";
let dataDir = "";
let port = 0;
let token = "";
let serve: ChildProcess | undefined;
let base = "";
let opened = false;
let seq = 0;
const session = `ukagai-quiz-${process.pid}-${Date.now().toString(36)}`;
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
  const go = () => fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await go().catch(() => go());
  return res.json() as Promise<any>;
}

const transcript = () => join(home, ".claude", "projects", "p", "none.jsonl");

const QUESTION = "Subject: parse_retry_after\n\nWhat does it return for \"120\"?";
const QUIZ_MD = `---
ukagai: 1
type: quiz
question: |
  Subject: parse_retry_after

  What does it return for "120"?
title: Comprehension quiz on parse_retry_after
reversibility: reversible
scope: file
---

## Why this question now

The agent edited this function 12 times.

## Premise

src/http/retry.rs reads the Retry-After header.

## How to answer

Pick with the arrow keys and press Enter.
`;

async function seedQuiz(question = QUESTION): Promise<{ id: string }> {
  const n = ++seq;
  const d = await api("/api/decisions", {
    tool_use_id: `toolu_quiz_${process.pid}_${n}`,
    kind: "answer_question",
    session: { session_id: `00000000-0000-0000-0006-${String(n).padStart(12, "0")}`, cwd: ROOT, transcript_path: transcript() },
    request: { questions: [{ question, header: "Quiz", multiSelect: false, options: [
      { label: "Some(120s)", description: "Seconds" }, { label: "None (Recommended)", description: "No value" }, { label: "An error", description: "Rejected" },
    ] }] },
    explanation: { path: "", type: "quiz", title: "Comprehension quiz on parse_retry_after", question, reversibility: "reversible", scope: "file", markdown: QUIZ_MD, has: { mermaid: false, table: false, diff: false }, match: "question", attached_via: "first_call" },
  });
  assert.ok(d.id, `cannot create quiz: ${JSON.stringify(d)}`);
  return { id: d.id };
}

async function cancelAll() {
  const list = (await api("/api/decisions?status=pending")) as { id: string }[];
  for (const d of list) await api(`/api/decisions/${d.id}/cancel`, {});
}

async function reopen(ready = "document.querySelector('#decision .opt, #decision .btn')") {
  ab("open", base + "/");
  await waitFor("screen render", ready);
}

async function status(id: string): Promise<string> { return (await api(`/api/decisions/${id}`)).status; }

const cardsJs = `[...document.querySelectorAll("#decision .opt")]`;
const cursor = () => ev<number>(`${cardsJs}.findIndex(e => e.classList.contains("cursor"))`);

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
  home = mkdtempSync(join(tmpdir(), "ukagai-focus-"));
  dataDir = join(home, "data");
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  await startServe();
  ab("open", base + "/", "--viewport", "1280x800");
  opened = true;
});

after(async () => {
  if (opened) { try { ab("close"); } catch {} }
  serve?.kill();
  if (home) rmSync(home, { recursive: true, force: true });
});

function gui(name: string, fn: (t: TestContext) => Promise<void>) {
  test(`GUI quiz: ${name}`, { skip: HAS_BROWSER ? false : "agent-browser is not installed" }, async (t) => {
    await cancelAll();
    try { await fn(t); } finally { await cancelAll(); }
  });
}


gui("a quiz shows the band, the title, the three sections and the options as given, with no recommendation", async () => {
  await seedQuiz();
  await reopen();
  assert.equal(ev<string>(`document.querySelector("#head .quiz-band").textContent`), "Quiz");
  assert.match(ev<string>(`document.querySelector("#head .v2-title").textContent`), /Comprehension quiz on parse_retry_after/);
  const left = ev<string>(`document.querySelector("#background").innerText`);
  for (const s of ["Why this question now", "The agent edited this function 12 times.", "Premise", "src/http/retry.rs reads", "How to answer"]) assert.ok(left.includes(s), `missing in the background: ${s}`);
  assert.ok(!/Assumptions|Recommendation/.test(left), "no recommendation / assumptions heading");
  assert.deepEqual(ev<string[]>(`JSON.stringify(${cardsJs}.filter(e => !e.classList.contains("free") && !e.dataset.card).map(e => e.querySelector(".lab").textContent.trim()))`).slice(0, 3), ["Some(120s)", "None (Recommended)", "An error"]);
  assert.equal(ev<number>(`document.querySelectorAll("#decision .rec-badge, #decision .opt.recommended").length`), 0, "no recommended highlight");
  assert.equal(cursor(), 0, "starts on the first option");
});

gui("a quiz answers with the arrows and Enter, and the value sent is the label as given", async () => {
  const { id } = await seedQuiz();
  await reopen();
  press("ArrowDown");
  assert.equal(cursor(), 1);
  press("Enter");
  for (let i = 0; i < 20 && (await status(id)) === "pending"; i++) await sleep(100);
  assert.equal(await status(id), "answer_submitted");
  const d = await api(`/api/decisions/${id}`);
  assert.ok(JSON.stringify(d).includes("None (Recommended)"));
});

gui("a multi-line quiz question: the head shows only the last paragraph, un-clamped, and the premise is not repeated", async () => {
  const last = "What does parse_retry_after return\nfor the header value \"120\"?";
  await seedQuiz(`Subject: parse_retry_after\nWhy now: edited 12 times\nPremise: src/http/retry.rs reads the Retry-After header.\n\n${last}`);
  await reopen();
  const head = ev<string>(`document.querySelector("#head .headline").innerText`);
  assert.equal(head, last);
  assert.ok(!head.includes("Premise:"), "the premise lines are not in the head");
  assert.equal(ev<boolean>(`!document.querySelector("#head .headline").classList.contains("clampable")`), true, "not clamped");
  assert.equal(ev<string>(`getComputedStyle(document.querySelector("#head .headline")).whiteSpace`), "pre-line");
  ab("screenshot", "/tmp/scratchpad/ukagai-quiz-head.png");
});
