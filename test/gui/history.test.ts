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

async function cancelAll() {
  const list = (await api("/api/decisions?status=pending")) as { id: string }[];
  for (const d of list) await api(`/api/decisions/${d.id}/cancel`, {});
}

async function reopen(ready = "document.querySelector('#decision .opt, #decision .btn')") {
  ab("open", base + "/");
  await waitFor("screen render", ready);
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

function gui(name: string, fn: (t: TestContext) => Promise<void>) {
  test(`GUI history: ${name}`, { skip: HAS_BROWSER ? false : "agent-browser is not installed" }, async (t) => {
    await cancelAll();
    try { await fn(t); } finally { await cancelAll(); }
  });
}

const GOAL = "document.querySelector('#head .hd-goal')";
const PANEL = "document.querySelector('.overlay.history')";

gui("the Goal row is the third header row: first instruction on one line, `· N instructions`, no extra boxes", async () => {
  await seed();
  await reopen(GOAL);
  const rows = ev<string[]>(`JSON.stringify([...document.querySelector("#head").children].map(e => e.className.split(" ")[0]))`);
  assert.deepEqual(rows, ["hd-top", "hd-line2", "hd-goal"]);
  // whitespace and newlines are folded to single spaces
  assert.equal(q1("#head .goal-text"), "Goal: Add a history panel to the decision screen, please. Keep the layout calm.");
  assert.equal(q1("#head .goal-n"), "· 3 instructions");
  // one line, dim
  assert.ok(ev<number>(`document.querySelector("#head .goal-text").getBoundingClientRect().height`) < 24);
  assert.equal(ev<string>(`getComputedStyle(document.querySelector("#head .goal-text")).whiteSpace`), "nowrap");
  // no Session box, no History chip; boxed things on the screen stay at 2 or fewer
  assert.equal(count("[class*='session-box'], .history-chip"), 0);
  assert.ok(count(".chip, .badge, .pill") <= 2);
});

gui("a long first instruction is cut with … on one line", async () => {
  await seed({ transcript: writeTranscript("long", ["x".repeat(900) + " tail", "y"]) });
  await reopen(GOAL);
  assert.ok(ev<number>(`document.querySelector("#head .goal-text").getBoundingClientRect().height`) < 24);
  assert.equal(ev<boolean>(`(() => { const e = document.querySelector("#head .goal-text"); return e.scrollWidth > e.clientWidth; })()`), true);
  assert.equal(ev<string>(`getComputedStyle(document.querySelector("#head .goal-text")).textOverflow`), "ellipsis");
});

gui("a single instruction shows the Goal without the count", async () => {
  await seed({ transcript: writeTranscript("single", ["only one"]) });
  await reopen(GOAL);
  assert.equal(q1("#head .goal-text"), "Goal: only one");
  assert.equal(count("#head .goal-n"), 0);
  assert.equal(ev<boolean>(`!!document.querySelector("#decision .hint .hs:not([hidden])")`), false); // no `s` hint with one instruction
});

gui("`s` opens the panel in time order; Enter shows the full text with pre-wrap; Esc steps back, then closes", async () => {
  await seed();
  await reopen(GOAL);
  assert.equal(ev<boolean>(`!!${PANEL}`), false);
  press("s");
  assert.equal(ev<boolean>(`!!${PANEL}`), true);
  assert.equal(q1(".overlay.history .overlay-title"), "This session's instructions");
  const rows = ev<{ first: string; text: string }[]>(`JSON.stringify([...document.querySelectorAll(".overlay.history .hist-row")].map(r => ({ first: r.querySelector(".hist-first").textContent, text: r.querySelector(".hist-text").textContent })))`);
  assert.deepEqual(rows.map((r) => r.first), ["first", "", ""]);
  assert.deepEqual(rows.map((r) => r.text), ["Add a history panel to the decision screen, please. Keep the layout calm.", "second: make it dark", "third: line one line two"]);
  assert.match(q1(".overlay.history .hist-row .hist-at"), /^3h ago$/);
  // ↓ moves, Enter shows the full text with the line breaks kept
  press("ArrowDown", "ArrowDown", "Enter");
  assert.equal(ev<boolean>(`document.querySelector(".hist-full").hidden`), false);
  assert.equal(ev<string>(`document.querySelector(".hist-full").textContent`), INSTRUCTIONS[2]);
  assert.equal(ev<string>(`getComputedStyle(document.querySelector(".hist-full")).whiteSpace`), "pre-wrap");
  assert.ok(ev<number>(`document.querySelector(".hist-full").getBoundingClientRect().height`) > 40); // several lines
  // Esc: back to the list (still open), `.` opens the first one in full, Esc, Esc closes
  press("Escape");
  assert.equal(ev<boolean>(`!!${PANEL} && document.querySelector(".hist-full").hidden`), true);
  press("Home", ".");
  assert.equal(ev<string>(`document.querySelector(".hist-full").textContent`), FIRST);
  press("Escape", "Escape");
  assert.equal(ev<boolean>(`!!${PANEL}`), false);
  // a click on the Goal row opens it too
  ab("click", "#head .hd-goal");
  assert.equal(ev<boolean>(`!!${PANEL}`), true);
  press("s");
  assert.equal(ev<boolean>(`!!${PANEL}`), false);
});

gui("inside the panel digits, x and n do nothing; the decision stays pending", async () => {
  const { id } = await seed();
  await reopen(GOAL);
  press("s", "1", "2", "x", "n");
  assert.equal(ev<boolean>(`!!${PANEL}`), true);
  assert.equal(count("#decision .cannot-panel, #decision .none-type"), 0);
  assert.equal((await api(`/api/decisions/${id}`)).status, "pending");
});

gui("`s` is a letter in the free-text field", async () => {
  await seed();
  await reopen(GOAL);
  press("i", "s");
  assert.equal(ev<string>(`document.activeElement.value`), "s");
  assert.equal(ev<boolean>(`!!${PANEL}`), false);
});

gui("`s` is off while Can't answer / None of these is open", async () => {
  await seed();
  await reopen(GOAL);
  press("x");
  assert.equal(count("#decision .cannot-panel"), 1);
  press("s");
  assert.equal(ev<boolean>(`!!${PANEL}`), false);
  assert.equal(count("#decision .cannot-panel"), 1); // still open
  press("n"); // switches to None of these
  assert.equal(count("#decision .none-type"), 4);
  press("s");
  assert.equal(ev<boolean>(`!!${PANEL}`), false);
  assert.equal(count("#decision .none-type"), 4);
});

gui("after the panel closes the other keys work again (n opens None of these)", async () => {
  await seed();
  await reopen(GOAL);
  press("s", "Escape");
  assert.equal(ev<boolean>(`!!${PANEL}`), false);
  press("n");
  assert.equal(count("#decision .none-type"), 4);
});

gui("the Terms list and the history panel never open together", async () => {
  await seed({ rich: true });
  await reopen("document.querySelector('#head .headline') && document.querySelector('#head .hd-goal')");
  press("?");
  assert.equal(count(".overlay"), 1);
  assert.equal(count(".overlay.terms"), 1);
  press("s");
  assert.equal(count(".overlay"), 1);
  assert.equal(count(".overlay.history"), 1);
  press("?");
  assert.equal(count(".overlay"), 1);
  assert.equal(count(".overlay.terms"), 1);
});

gui("the hint line gains `s History`; the short line gets the letter", async () => {
  await seed();
  await reopen(GOAL);
  assert.match(q1("#decision .hint-full"), /s History · ←→/);
  assert.match(q1("#decision .hint-short"), /\bs\b.*more/);
  // one line at 1000x700 (short hint)
  ab("set", "viewport", "1000", "700");
  await sleep(300);
  assert.ok(ev<number>(`document.querySelector("#decision .hint-short").getBoundingClientRect().height`) < 24);
  ab("set", "viewport", "1440", "900");
});

gui("a plan screen shows the Goal and opens the panel with `s`", async () => {
  await seed({ plan: true });
  await reopen(GOAL);
  press("s");
  assert.equal(count(".overlay.history .hist-row"), 3);
});

gui("no history (missing transcript) leaves the header at two rows and `s` does nothing", async () => {
  await seed({ transcript: join(home, ".claude", "projects", "p", "missing.jsonl") });
  await reopen();
  await sleep(500);
  const rows = ev<string[]>(`JSON.stringify([...document.querySelector("#head").children].map(e => e.className.split(" ")[0]))`);
  assert.deepEqual(rows, ["hd-top", "hd-line2"]);
  press("s");
  assert.equal(ev<boolean>(`!!${PANEL}`), false);
  assert.ok(ev<boolean>(`!!document.querySelector("#decision .opt")`)); // the screen is intact
});

gui("a failed fetch (HTTP 500) is ignored, nothing breaks, and the next time the decision is shown it retries", async () => {
  await seed();
  await seed();
  await reopen();
  ev(`(window.__fetch = window.fetch, window.__fail = 1, window.__hf = 0, window.fetch = (...a) => { if (String(a[0]).endsWith("/history")) { window.__hf++; if (window.__fail) return Promise.resolve(new Response("{}", { status: 500 })); } return window.__fetch(...a); }, "ok")`);
  press("Tab"); // show the other decision: its history request fails
  await waitFor("history requested", "window.__hf >= 1");
  await sleep(300);
  assert.equal(count("#head .hd-goal"), 0);
  press("s");
  assert.equal(ev<boolean>(`!!${PANEL}`), false);
  assert.ok(ev<boolean>(`!!document.querySelector("#decision .opt")`));
  // recovery: the next time it is shown, it fetches again and the Goal appears
  ev(`(window.__fail = 0, "ok")`);
  press("Tab", "Tab");
  await waitFor("goal after retry", GOAL);
});

gui("the second decision of the same session does not fetch again; another session does", async () => {
  const sid = "11111111-1111-1111-1111-111111111111";
  const transcript = writeTranscript("shared", INSTRUCTIONS);
  await seed({ sessionId: sid, transcript });
  await reopen(GOAL);
  ev(`(window.__hf = 0, window.__fetch = window.fetch, window.fetch = (...a) => { if (String(a[0]).endsWith("/history")) window.__hf++; return window.__fetch(...a); }, "ok")`);
  await seed({ sessionId: sid, transcript });
  await waitFor("two pending", `document.querySelector("#pending-btn:not([hidden])")`);
  press("Tab"); // the other decision of the same session
  await waitFor("goal on the other decision", GOAL);
  press("Tab");
  press("Tab");
  assert.equal(ev<number>(`window.__hf`), 0);
  // a decision of another session fetches once
  await seed({ transcript: writeTranscript("other", ["other session goal", "b"]) });
  await waitFor("goal of the other session", `[...document.querySelectorAll("#head .goal-text")].some(e => e.textContent.includes("other session goal")) || (document.querySelector("#pending-btn") && document.querySelector("#pending-count").textContent === "3")`);
  press("Tab");
  press("Tab");
  await waitFor("fetched once", `window.__hf === 1`);
  await sleep(300);
  press("Tab");
  press("Tab");
  press("Tab");
  assert.equal(ev<number>(`window.__hf`), 1);
});

gui("ja: Goal label, count, panel title and hint are translated", async () => {
  await seed();
  await reopen(GOAL);
  ev(`document.documentElement.dataset.lang = "ja", "ok"`);
  await waitFor("ja goal", `document.querySelector("#head .goal-text").textContent.startsWith("目的:")`);
  assert.equal(q1("#head .goal-n"), "· 3 件");
  assert.match(q1("#decision .hint-full"), /s 履歴/);
  press("s");
  assert.equal(q1(".overlay.history .overlay-title"), "このセッションの指示");
  assert.equal(q1(".overlay.history .hist-first"), "最初");
  assert.match(q1(".overlay.history .hist-at"), /^3時間前$/);
  press("Escape");
  ev(`document.documentElement.dataset.lang = "en", "ok"`);
});
