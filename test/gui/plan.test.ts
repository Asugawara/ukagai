// Checks the long-plan screen (public/app.js: folding sections, contents, read marks, unread confirmation) against a real server and a
// real browser (agent-browser). Skipped when agent-browser is not on PATH. Keys are sent as KeyboardEvents (eval), not with `press`.
import { after, before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
// A synthetic plan: 200 lines, 9 H2, 6 H3, 2 code blocks, 12 distinct backticked paths (the TUI test reads the same file)
const LONG = readFileSync(new URL("./fixtures/long-plan.md", import.meta.url), "utf8");
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
const session = `ukagai-plan-${process.pid}-${Date.now().toString(36)}`;

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

/** A character key as a real KeyboardEvent on the document (not `press`: the IME-independent path the handler reads event.key from) */
const key = (k: string) => ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true })), "ok"`);

/** The same key n times in one eval (fewer browser round trips) */
const keyN = (k: string, n: number) => ev(`(() => { for (let i = 0; i < ${n}; i++) document.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true })); return "ok"; })()`);

async function api(path: string, body?: unknown) {
  const go = () => fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await go().catch(() => go());
  return res.json() as Promise<any>;
}

async function seedPlan(plan: string, explanation?: Record<string, unknown>): Promise<{ id: string }> {
  const n = ++seq;
  const d = await api("/api/decisions", {
    tool_use_id: `toolu_plan_${process.pid}_${n}`,
    kind: "approve_plan",
    session: { session_id: `00000000-0000-0000-0001-${String(n).padStart(12, "0")}`, cwd: ROOT, transcript_path: join(home, ".claude", "projects", "p", "none.jsonl") },
    request: { plan, planFilePath: "/Users/someone/.claude/plans/export-retry.md" },
    ...(explanation ? { explanation } : {}),
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

async function reopen(ready = "document.querySelector('#decision .btn')") {
  ab("open", base + "/");
  await waitFor("screen render", ready);
}

async function setLang(lang: "en" | "ja", ready: string) {
  ev(`document.documentElement.dataset.lang = ${JSON.stringify(lang)}, "ok"`);
  await waitFor(`language ${lang} applied`, ready);
}

before(async () => {
  if (!HAS_BROWSER) return;
  home = mkdtempSync(join(tmpdir(), "ukagai-plan-"));
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
  test(`GUI plan: ${name}`, { skip: HAS_BROWSER ? false : "agent-browser is not installed" }, async (t) => {
    await cancelAll();
    ab("set", "viewport", "1440", "900");
    try { await fn(t); } finally { await cancelAll(); }
  });
}

const openCount = `document.querySelectorAll("#background details.plan-sec[open]").length`;
const tocRow = (title: string) => `[...document.querySelectorAll("#decision .toc-row")].find(r => r.querySelector(".toc-title").textContent.startsWith(${JSON.stringify(title)}))`;
const secOf = (title: string) => `[...document.querySelectorAll("#background details.plan-sec, #background details.plan-sub")].find(d => d.querySelector(":scope > summary .ps-title").textContent.startsWith(${JSON.stringify(title)}))`;
const mark = (title: string) => ev<string>(`${tocRow(title)}.querySelector(".toc-mark").textContent`);
const confirmText = () => ev<string>(`document.querySelector("#decision .confirm-bar").hidden ? "" : document.querySelector("#decision .confirm-bar").textContent`);

gui("a long plan folds into one <details> per H2 (only the first open), the contents lists 15 rows, the header counts 9 sections · 200 lines · 12 files", async () => {
  await seedPlan(LONG);
  await reopen("document.querySelector('#background details.plan-sec')");
  assert.equal(ev(`document.querySelectorAll("#background details.plan-sec").length`), 9);
  assert.equal(ev(`document.querySelectorAll("#background details.plan-sub").length`), 6);
  assert.equal(ev(openCount), 1);
  assert.equal(ev(`document.querySelector("#background details.plan-sec").open`), true);
  assert.equal(ev(`document.querySelector("#background details.plan-sec > summary .ps-title").textContent`), "Context");
  assert.equal(ev(`document.querySelectorAll("#decision .toc-row").length`), 15);
  assert.equal(ev(`document.querySelectorAll("#decision .toc-row.l2").length`), 9);
  assert.equal(ev(`document.querySelectorAll("#decision .toc-row.l3").length`), 6);
  assert.equal(ev(`document.querySelector("#head .plan-stats").textContent`), "9 sections · 200 lines · 12 files");
  assert.equal(ev(`document.querySelector("#head .plan-file").textContent`), "export-retry.md");
  assert.equal(ev(`document.querySelector("#head .plan-file").title`), "/Users/someone/.claude/plans/export-retry.md");
  // the summary says lines and files; the Context section has 16 lines and 2 files in its prose
  assert.equal(ev(`document.querySelector("#background details.plan-sec > summary .ps-meta").textContent`), "16 lines · 2 files");
  // the scope section is folded on the left (it is in the right column) and the right column still shows it
  assert.equal(ev(`${secOf("Scope and reversibility")}.open`), false);
  assert.equal(ev(`document.querySelector("#decision .impact-cap").textContent`), "Scope and reversibility");
  // a closed section's body is not visible
  assert.equal(ev(`${secOf("Rollout")}.querySelector("p").checkVisibility()`), false);
});

gui("ja: the summary, contents and header use Japanese words", async () => {
  await seedPlan(LONG);
  await reopen("document.querySelector('#background details.plan-sec')");
  await setLang("ja", `document.querySelector("#head .plan-stats")?.textContent === "9 節 · 200 行 · 12 ファイル"`);
  assert.equal(ev(`document.querySelector("#decision .plan-toc .impact-cap").textContent`), "目次");
  assert.equal(ev(`document.querySelector("#background details.plan-sec > summary .ps-meta").textContent`), "16 行 · 2 ファイル");
  assert.ok(ev<string>(`document.querySelector("#foot .hint").textContent`).startsWith("↑↓ 目次"));
  await setLang("en", `document.querySelector("#head .plan-stats")?.textContent === "9 sections · 200 lines · 12 files"`);
});

gui("clicking a contents row opens the section, marks it read and scrolls the left column to it", async () => {
  await seedPlan(LONG);
  await reopen("document.querySelector('#background details.plan-sec')");
  assert.equal(mark("Verification"), "☐");
  assert.equal(mark("Context"), "☑");
  assert.equal(ev(`document.getElementById("background").scrollTop`), 0);
  ev(`${tocRow("Verification")}.click(), "ok"`);
  await waitFor("Verification open", `${secOf("Verification")}.open`);
  assert.equal(mark("Verification"), "☑");
  assert.equal(ev(`${secOf("Verification")}.querySelector(":scope > summary .ps-mark").textContent`), "☑");
  assert.ok(ev<number>(`document.getElementById("background").scrollTop`) > 0, "scrolled");
  // its heading row is at the top of the left column
  const gap = ev<number>(`${secOf("Verification")}.querySelector("summary").getBoundingClientRect().top - document.getElementById("background").getBoundingClientRect().top`);
  assert.ok(gap >= -2 && gap < 40, `summary near the top (gap ${gap})`);
  // an H3 row opens its H2 as well
  ev(`${tocRow("Unit tests")}.click(), "ok"`);
  await waitFor("Unit tests open", `${secOf("Unit tests")}.open && ${secOf("Verification")}.open`);
  assert.equal(mark("Unit tests"), "☑");
});

gui("clicking a section's summary folds and unfolds it, and a section opened once keeps ☑", async () => {
  await seedPlan(LONG);
  await reopen("document.querySelector('#background details.plan-sec')");
  ev(`${secOf("Rollout")}.querySelector("summary").click(), "ok"`);
  await waitFor("Rollout open", `${secOf("Rollout")}.open`);
  assert.equal(ev(openCount), 2);
  ev(`${secOf("Rollout")}.querySelector("summary").click(), "ok"`);
  await waitFor("Rollout closed", `!${secOf("Rollout")}.open`);
  assert.equal(mark("Rollout"), "☑");
  assert.equal(ev(`${secOf("Rollout")}.querySelector(":scope > summary .ps-mark").textContent`), "☑");
});

gui("o opens everything and o again folds everything", async () => {
  await seedPlan(LONG);
  await reopen("document.querySelector('#background details.plan-sec')");
  key("o");
  await waitFor("all open", `document.querySelectorAll("#background details[open]").length === 15`);
  assert.equal(ev(`document.querySelectorAll("#decision .toc-mark").length`), 15);
  assert.equal(ev(`[...document.querySelectorAll("#decision .toc-mark")].every(m => m.textContent === "☑")`), true);
  key("o");
  await waitFor("all closed", `document.querySelectorAll("#background details[open]").length === 0`);
  assert.equal(mark("Rollout"), "☑", "read marks stay");
});

gui("an open section's heading row sticks to the top of the left column while its body scrolls, and an open H3's under it", async () => {
  await seedPlan(LONG);
  await reopen("document.querySelector('#background details.plan-sec')");
  key("o");
  await waitFor("all open", `document.querySelectorAll("#background details[open]").length === 15`);
  // scroll into the middle of Changes (55 lines with its H3 children open)
  ev(`document.getElementById("background").scrollTop = ${secOf("Changes")}.offsetTop + 200, "ok"`);
  const top = (sel: string) => ev<number>(`${sel}.getBoundingClientRect().top - document.getElementById("background").getBoundingClientRect().top`);
  const h2 = top(`${secOf("Changes")}.querySelector(":scope > summary")`);
  assert.ok(Math.abs(h2) <= 2, `the H2 summary is at the top (${h2})`);
  const sub = ev<string>(`(() => { const bg = document.getElementById("background").getBoundingClientRect().top; const s = [...document.querySelectorAll("#background details.plan-sub[open] > summary")].find(x => { const r = x.getBoundingClientRect(); return r.top - bg > 0 && r.top - bg < 40; }); return s ? s.textContent : ""; })()`);
  assert.ok(sub.includes("Backend usecase") || sub.includes("HTTP handler") || sub.includes("Worker"), `an H3 summary sits under the H2 summary: ${sub}`);
});

gui("j / k move the contents cursor, Enter and Space fold the section under it", async () => {
  await seedPlan(LONG);
  await reopen("document.querySelector('#background details.plan-sec')");
  const cur = () => ev<string>(`document.querySelector("#decision .toc-row.cursor .toc-title").textContent`);
  assert.equal(cur(), "Context");
  key("j");
  assert.equal(cur(), "Changes");
  key("ArrowDown");
  assert.ok(cur().startsWith("1. Backend usecase"));
  key("k");
  assert.equal(cur(), "Changes");
  key("Enter");
  await waitFor("Changes open", `${secOf("Changes")}.open`);
  key(" ");
  await waitFor("Changes closed", `!${secOf("Changes")}.open`);
  key("Enter");
  await waitFor("Changes open again", `${secOf("Changes")}.open`);
  // Enter did not approve anything
  assert.equal(ev(`!!document.querySelector("#decision .btn.primary") && document.querySelector("#decision .confirm-bar").hidden`), true);
});

gui("[ and ] open and go to the previous / next section (H3 rows included)", async () => {
  await seedPlan(LONG);
  await reopen("document.querySelector('#background details.plan-sec')");
  const cur = () => ev<string>(`document.querySelector("#decision .toc-row.cursor .toc-title").textContent`);
  key("]");
  await waitFor("Changes open", `${secOf("Changes")}.open`);
  assert.equal(cur(), "Changes");
  key("]");
  await waitFor("first H3 open", `${secOf("1. Backend usecase")}.open`);
  assert.ok(cur().startsWith("1. Backend usecase"));
  key("]");
  assert.ok(cur().startsWith("2. HTTP handler"));
  await waitFor("second H3 open", `${secOf("2. HTTP handler")}.open`);
  key("[");
  assert.ok(cur().startsWith("1. Backend usecase"));
  assert.equal(ev(openCount), 2);
  // [ at the first row and ] at the last row stay put
  keyN("]", 20);
  assert.equal(cur(), "Scope and reversibility");
  keyN("[", 20);
  assert.equal(cur(), "Context");
});

gui("y with unread sections names them on the confirmation bar and does not send; the second y sends", async () => {
  const { id } = await seedPlan(LONG);
  await reopen("document.querySelector('#background details.plan-sec')");
  key("y");
  await waitFor("confirm bar", `!document.querySelector("#decision .confirm-bar").hidden`);
  assert.equal(confirmText(), "Unread sections (7): Changes, Split and owners, Commit granularity, Verification, Observation path +2 · Press the same key or click again (3s)");
  assert.equal((await api(`/api/decisions/${id}`)).status, "pending");
  key("y");
  const d = await waitStatus(id, "answer_submitted");
  assert.equal(d.response.approve, true);
  assert.ok(!d.response.set_mode_auto);
});

gui("reading a section shortens the unread list; with everything read y and a send at once", async () => {
  const { id } = await seedPlan(LONG);
  await reopen("document.querySelector('#background details.plan-sec')");
  ev(`${tocRow("Changes")}.click(), "ok"`);
  await waitFor("Changes open", `${secOf("Changes")}.open`);
  key("a");
  await waitFor("confirm bar", `!document.querySelector("#decision .confirm-bar").hidden`);
  assert.ok(confirmText().startsWith("Unread sections (6): Split and owners, Commit granularity"), confirmText());
  // opening one more while the bar is up updates it
  ev(`${tocRow("Split and owners")}.click(), "ok"`);
  await waitFor("bar updated", `document.querySelector("#decision .confirm-bar").textContent.includes("(5)")`);
  key("o");
  await waitFor("all open", `document.querySelectorAll("#background details[open]").length === 15`);
  assert.equal((await api(`/api/decisions/${id}`)).status, "pending");
  key("y"); // everything is read now: the first press that finds nothing unread sends
  const d = await waitStatus(id, "answer_submitted");
  assert.equal(d.response.approve, true);
});

gui("an irreversible long plan still needs two presses with everything read (the two rules share one bar)", async () => {
  const explanation = { path: "", title: "Drop the store", reversibility: "irreversible", scope: "machine", markdown: LONG, has: { mermaid: false, table: false, diff: false }, match: "recency", attached_via: "first_call" };
  const { id } = await seedPlan(LONG, explanation);
  await reopen("document.querySelector('#background details.plan-sec')");
  key("y");
  await waitFor("confirm bar", `!document.querySelector("#decision .confirm-bar").hidden`);
  assert.ok(confirmText().startsWith("Unread sections (7)"), confirmText());
  key("o");
  key("y");
  const d = await waitStatus(id, "answer_submitted");
  assert.equal(d.response.approve, true);
});

gui("clicking an Approve button with unread sections arms the bar, the second click sends", async () => {
  const { id } = await seedPlan(LONG);
  await reopen("document.querySelector('#background details.plan-sec')");
  ev(`document.querySelector("#decision .btn.primary").click(), "ok"`);
  await waitFor("bar", `!document.querySelector("#decision .confirm-bar").hidden`);
  assert.equal((await api(`/api/decisions/${id}`)).status, "pending");
  ev(`document.querySelector("#decision .btn.primary").click(), "ok"`);
  await waitStatus(id, "answer_submitted");
});

gui("a short plan (two H2, or 40 lines or fewer) stays one open document with no contents", async () => {
  await seedPlan("# Short\n\n## Work\n\nalpha body\n\n## More\n\nbeta body\n\n## Scope and reversibility\n\nReversibility: reversible\nScope: file\n");
  await reopen();
  assert.equal(ev(`document.querySelectorAll("#decision .plan-toc").length`), 0);
  assert.equal(ev(`document.querySelectorAll("#background details.plan-sec").length`), 0);
  assert.equal(ev(`document.getElementById("background").innerText.includes("alpha body") && document.getElementById("background").innerText.includes("beta body")`), true);
  assert.equal(ev(`!!document.querySelector("#head .plan-stats")`), false);
  // 3 H2 but only 12 lines is still short, and a 60-line plan with 2 H2 as well
  await cancelAll();
  await seedPlan("# P\n\n## A\n\nx\n\n## B\n\ny\n\n## C\n\nz\n");
  await reopen();
  assert.equal(ev(`document.querySelectorAll("#decision .plan-toc, #background details.plan-sec").length`), 0);
  await cancelAll();
  await seedPlan("# P\n\n## A\n\n" + "line\n\n".repeat(30) + "## B\n\ny\n");
  await reopen();
  assert.equal(ev(`document.querySelectorAll("#decision .plan-toc, #background details.plan-sec").length`), 0);
});

gui("a short plan: y sends at once, and the arrows still move between the buttons", async () => {
  const { id } = await seedPlan("# Short\n\nStep 1");
  await reopen();
  key("ArrowDown");
  assert.equal(ev(`[...document.querySelectorAll("#decision .actions .btn")].findIndex(b => b.classList.contains("cursor"))`), 1);
  key("y");
  const d = await waitStatus(id, "answer_submitted");
  assert.equal(d.response.approve, true);
});

gui("at 1000x700 the approve buttons and the hint are on screen, and the contents scroll inside their own box", async () => {
  await seedPlan(LONG);
  ab("set", "viewport", "1000", "700");
  await reopen("document.querySelector('#background details.plan-sec')");
  const visible = (sel: string) => ev<boolean>(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.width > 0; })()`);
  assert.equal(visible("#decision .btn.primary"), true);
  assert.equal(visible("#decision .btn.danger"), true);
  assert.equal(visible("#foot .hint"), true);
  // moving the cursor to the last row keeps the buttons where they are and scrolls the contents box
  keyN("j", 14);
  assert.equal(ev(`document.querySelector("#decision .toc-row.cursor .toc-title").textContent`), "Scope and reversibility");
  assert.equal(visible("#decision .btn.primary"), true);
  assert.equal(visible("#decision .toc-row.cursor"), true);
});

gui("backticked paths in the plan are click-to-copy badges, and clicking one inside a summary does not fold the section", async () => {
  await seedPlan(LONG);
  await reopen("document.querySelector('#background details.plan-sec')");
  ev(`window.__copied = [], navigator.clipboard.writeText = async (x) => { window.__copied.push(x); }, "ok"`);
  // Context is open: its prose names two paths
  assert.equal(ev(`document.querySelectorAll("#background details.plan-sec[open] > p .cbadge, #background details.plan-sec[open] > :not(summary) .cbadge").length`), 2);
  ev(`document.querySelector("#background details.plan-sec[open] .cbadge").click(), "ok"`);
  await waitFor("copied", `window.__copied.length === 1`);
  assert.equal(ev(`window.__copied[0]`), "src/export/usecase.ts");
  // open Changes: its H3 summaries carry paths
  ev(`${tocRow("Changes")}.click(), "ok"`);
  await waitFor("Changes open", `${secOf("Changes")}.open`);
  ev(`${secOf("1. Backend usecase")}.querySelector("summary .cbadge").click(), "ok"`);
  await waitFor("copied again", `window.__copied.length === 2`);
  assert.equal(ev(`window.__copied[1]`), "src/export/usecase.ts");
  assert.equal(ev(`${secOf("1. Backend usecase")}.open`), false, "the click copied; it did not open the section");
  // code that is not a path is not a badge
  ev(`${tocRow("Verification")}.click(), "ok"`);
  await waitFor("Verification open", `${secOf("Verification")}.open`);
  assert.equal(ev(`[...document.querySelectorAll("#background code.cbadge")].some(c => c.textContent === "npm test")`), false);
});

gui("screenshots: 1440x900 folded, and with one section open", async () => {
  await seedPlan(LONG);
  await reopen("document.querySelector('#background details.plan-sec')");
  await sleep(300);
  ab("screenshot", join(SHOTS, "PL1-plan-folded.png"));
  ev(`${tocRow("Verification")}.click(), "ok"`);
  await waitFor("Verification open", `${secOf("Verification")}.open`);
  await sleep(300);
  ab("screenshot", join(SHOTS, "PL1-plan-one-open.png"));
});
