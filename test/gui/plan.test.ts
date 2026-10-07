// Checks the long-plan screen (public/app.js: folding sections, the plan / options zones, read marks, unread line) against a real server and a
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
const secOf = (title: string) => `[...document.querySelectorAll("#background details.plan-sec, #background details.plan-sub")].find(d => d.querySelector(":scope > summary .ps-title").textContent.startsWith(${JSON.stringify(title)}))`;
const mark = (title: string) => ev<string>(`${secOf(title)}.querySelector(":scope > summary .ps-mark").textContent`);
/** The title of the selected section (the summary row with .sel) */
const selTitle = () => ev<string>(`document.querySelector("#background details > summary.sel .ps-title").textContent`);
/** Index of a section among all <details> of the plan column, and of the selected one */
const indexOf = (title: string) => ev<number>(`[...document.querySelectorAll("#background details.plan-sec, #background details.plan-sub")].indexOf(${secOf(title)})`);
const selIndex = () => ev<number>(`[...document.querySelectorAll("#background details.plan-sec, #background details.plan-sub")].findIndex(d => d.firstElementChild.classList.contains("sel"))`);
/** Walk the selection to a section with j / k */
function goTo(title: string) {
  const n = indexOf(title) - selIndex();
  if (n) keyN(n > 0 ? "j" : "k", Math.abs(n));
}
const zone = () => ev<string>(`document.getElementById("background").classList.contains("zone-on") ? "plan" : document.getElementById("decision").classList.contains("zone-on") ? "opts" : "none"`);
const cards = () => ev<string[]>(`JSON.stringify([...document.querySelectorAll("#decision .actions > .opt")].map(o => o.dataset.card))`);
const cardCursor = () => ev<string>(`document.querySelector("#decision .opt.cursor")?.dataset.card ?? ""`);
const hint = () => ev<string>(`document.querySelector("#foot .hint").textContent`);

gui("a long plan folds into one <details> per H2 (only the first open), there is no contents list, the header counts 9 sections · 200 lines · 12 files", async () => {
  await seedPlan(LONG);
  await reopen("document.querySelector('#background details.plan-sec')");
  assert.equal(ev(`document.querySelectorAll("#background details.plan-sec").length`), 9);
  assert.equal(ev(`document.querySelectorAll("#background details.plan-sub").length`), 6);
  assert.equal(ev(openCount), 1);
  assert.equal(ev(`document.querySelector("#background details.plan-sec").open`), true);
  assert.equal(ev(`document.querySelector("#background details.plan-sec > summary .ps-title").textContent`), "Context");
  assert.equal(ev(`document.querySelectorAll("#decision .toc-row, #decision .plan-toc").length`), 0);
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

gui("ja: the summary, hint and header use Japanese words", async () => {
  await seedPlan(LONG);
  await reopen("document.querySelector('#background details.plan-sec')");
  await setLang("ja", `document.querySelector("#head .plan-stats")?.textContent === "9 節 · 200 行 · 12 ファイル"`);
  assert.equal(ev(`document.querySelector("#background details.plan-sec > summary .ps-meta").textContent`), "16 行 · 2 ファイル");
  assert.ok(ev<string>(`document.querySelector("#foot .hint").textContent`).startsWith("↑↓ 節 · Enter 開閉"));
  await setLang("en", `document.querySelector("#head .plan-stats")?.textContent === "9 sections · 200 lines · 12 files"`);
});

gui("Enter on the selected section opens it, marks it read and scrolls the left column to it", async () => {
  await seedPlan(LONG);
  await reopen("document.querySelector('#background details.plan-sec')");
  assert.equal(mark("Verification"), "☐");
  assert.equal(mark("Context"), "☑");
  assert.equal(ev(`document.getElementById("background").scrollTop`), 0);
  goTo("Verification");
  assert.equal(selTitle(), "Verification");
  assert.equal(ev(`${secOf("Verification")}.open`), false, "moving does not open");
  key("Enter");
  await waitFor("Verification open", `${secOf("Verification")}.open`);
  assert.equal(mark("Verification"), "☑");
  assert.ok(ev<number>(`document.getElementById("background").scrollTop`) > 0, "scrolled");
  // its heading row is at the top of the left column
  const gap = ev<number>(`${secOf("Verification")}.querySelector("summary").getBoundingClientRect().top - document.getElementById("background").getBoundingClientRect().top`);
  assert.ok(gap >= -2 && gap < 40, `summary near the top (gap ${gap})`);
  // an H3 opens its H2 as well
  goTo("Unit tests");
  key("Enter");
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
  assert.equal(ev(`[...document.querySelectorAll("#background details > summary .ps-mark")].every(m => m.textContent === "☑")`), true);
  key("o");
  await waitFor("all closed", `document.querySelectorAll("#background details[open]").length === 0`);
  assert.equal(mark("Rollout"), "☑", "read marks stay");
});

gui("an open section's heading row sticks to the top of the left column while its body scrolls, and an open H3's under it", async () => {
  await seedPlan(LONG);
  await reopen("document.querySelector('#background details.plan-sec')");
  key("o");
  await waitFor("all open", `document.querySelectorAll("#background details[open]").length === 15`);
  // scroll into the middle of Steps (55 lines with its H3 children open)
  ev(`document.getElementById("background").scrollTop = ${secOf("Steps")}.offsetTop + 200, "ok"`);
  const top = (sel: string) => ev<number>(`${sel}.getBoundingClientRect().top - document.getElementById("background").getBoundingClientRect().top`);
  const h2 = top(`${secOf("Steps")}.querySelector(":scope > summary")`);
  assert.ok(Math.abs(h2) <= 2, `the H2 summary is at the top (${h2})`);
  const sub = ev<string>(`(() => { const bg = document.getElementById("background").getBoundingClientRect().top; const s = [...document.querySelectorAll("#background details.plan-sub[open] > summary")].find(x => { const r = x.getBoundingClientRect(); return r.top - bg > 0 && r.top - bg < 40; }); return s ? s.textContent : ""; })()`);
  assert.ok(sub.includes("Backend usecase") || sub.includes("HTTP handler") || sub.includes("Worker"), `an H3 summary sits under the H2 summary: ${sub}`);
});

gui("j / k / ↑ / ↓ move the section selection, Home End gg G jump, Enter and Space fold the section under it", async () => {
  await seedPlan(LONG);
  await reopen("document.querySelector('#background details.plan-sec')");
  assert.equal(selTitle(), "Context");
  key("j");
  assert.equal(selTitle(), "Steps");
  key("ArrowDown");
  assert.ok(selTitle().startsWith("1. Backend usecase"));
  key("k");
  assert.equal(selTitle(), "Steps");
  key("ArrowUp");
  assert.equal(selTitle(), "Context");
  key("ArrowUp");
  assert.equal(selTitle(), "Context", "stays at the first");
  key("End");
  assert.equal(selTitle(), "Scope and reversibility");
  key("j");
  assert.equal(selTitle(), "Scope and reversibility", "stays at the last");
  key("Home");
  assert.equal(selTitle(), "Context");
  key("G");
  assert.equal(selTitle(), "Scope and reversibility");
  key("g");
  key("g");
  assert.equal(selTitle(), "Context");
  goTo("Steps");
  key("Enter");
  await waitFor("Steps open", `${secOf("Steps")}.open`);
  key(" ");
  await waitFor("Steps closed", `!${secOf("Steps")}.open`);
  key("Enter");
  await waitFor("Steps open again", `${secOf("Steps")}.open`);
  assert.equal(selTitle(), "Steps", "the selection stays on the section it folded");
  // Enter did not approve anything
  assert.equal(count("#decision .confirm-bar"), 0);
  assert.equal(ev(`document.querySelectorAll("#decision .approve-card").length`), 1);
});

gui("the selected section is visible: moving the selection scrolls it into view", async () => {
  await seedPlan(LONG);
  await reopen("document.querySelector('#background details.plan-sec')");
  key("o");
  await waitFor("all open", `document.querySelectorAll("#background details[open]").length === 15`);
  ev(`document.getElementById("background").scrollTop = 0, "ok"`);
  key("End");
  await sleep(200);
  const inView = ev<boolean>(`(() => { const r = document.querySelector("#background summary.sel").getBoundingClientRect(); const b = document.getElementById("background").getBoundingClientRect(); return r.top >= b.top - 1 && r.bottom <= b.bottom + 1; })()`);
  assert.equal(inView, true);
});

gui("the plan zone is where a long plan starts (section 1 selected, ring on the plan column); → goes to the options, ← back, and the hint follows the zone", async () => {
  await seedPlan(LONG);
  await reopen("document.querySelector('#background details.plan-sec')");
  assert.equal(zone(), "plan");
  assert.equal(selTitle(), "Context");
  assert.equal(cardCursor(), "", "no option is under the cursor in the plan zone");
  assert.equal(hint().startsWith("↑↓ Section · Enter Open · o All · → Options"), true, hint());
  key("ArrowRight");
  assert.equal(zone(), "opts");
  assert.equal(cardCursor(), "approve");
  assert.equal(hint().startsWith("↑↓ Pick · Enter Decide · ← Plan"), true, hint());
  // in the options zone ↑ ↓ do not move the section selection
  key("ArrowDown");
  assert.equal(selTitle(), "Context");
  assert.equal(cardCursor(), "instruct");
  key("ArrowLeft");
  assert.equal(zone(), "plan");
  assert.equal(cardCursor(), "");
  assert.equal(ev(`document.activeElement === document.getElementById("instruct")`), false, "the box lost the focus");
  key("l");
  assert.equal(zone(), "opts");
  assert.equal(cardCursor(), "instruct", "the option cursor is remembered");
  key("h");
  assert.equal(zone(), "plan");
  await setLang("ja", `document.querySelector("#foot .hint")?.textContent.startsWith("↑↓ 節")`);
  key("ArrowRight");
  assert.equal(hint().startsWith("↑↓ 選ぶ · Enter 決定 · ← 計画"), true, hint());
  await setLang("en", `document.querySelector("#foot .hint")?.textContent.startsWith("↑↓ Pick")`);
});

gui("← and → no longer cycle between pending items on a long plan, but Tab and [ ] still do", async () => {
  await seedPlan(LONG);
  await seedPlan(LONG.replace(/^# .*/m, "# Another plan"));
  await reopen("document.querySelector('#background details.plan-sec')");
  const shown = () => ev<string>(`document.querySelector("#head .v2-title")?.textContent ?? ""`);
  const first = shown();
  keyN("ArrowRight", 1);
  key("ArrowLeft");
  key("l");
  key("h");
  assert.equal(shown(), first, "still the same item");
  key("]");
  await waitFor("another item", `document.querySelector("#head .v2-title").textContent !== ${JSON.stringify(first)}`);
  key("[");
  await waitFor("back", `document.querySelector("#head .v2-title").textContent === ${JSON.stringify(first)}`);
  key("Tab");
  await waitFor("Tab cycles", `document.querySelector("#head .v2-title").textContent !== ${JSON.stringify(first)}`);
});

gui("the option list is Approve (auto) / Instruct / Reject in that order; Approve is first, primary and says auto mode", async () => {
  await seedPlan(LONG);
  await reopen("document.querySelector('#background details.plan-sec')");
  assert.deepEqual(cards(), ["approve", "instruct", "reject"]);
  assert.equal(ev(`document.querySelector("#decision .actions > .opt:first-of-type, #decision .actions > .opt").dataset.card`), "approve");
  assert.equal(ev(`document.querySelector("#decision .opt.approve-card").classList.contains("recommended")`), true);
  assert.equal(ev(`document.querySelector("#decision .approve-card .lab > span").textContent`), "Approve (continue in auto mode)");
  assert.deepEqual(ev(`JSON.stringify([...document.querySelectorAll("#decision .opt .cardkey")].map(k => k.textContent))`), ["1", "2", "3"]);
  await setLang("ja", `document.querySelector("#decision .approve-card .lab > span")?.textContent === "承認（auto モードで続行）"`);
  await setLang("en", `document.querySelector("#decision .approve-card .lab > span")?.textContent === "Approve (continue in auto mode)"`);
});

gui("Enter on Approve in the options zone sends {approve: true, set_mode_auto: true}", async () => {
  const { id } = await seedPlan(LONG);
  await reopen("document.querySelector('#background details.plan-sec')");
  key("Enter"); // the plan zone: this folds Context, it does not approve
  await waitFor("Context folded", `!${secOf("Context")}.open`);
  assert.equal((await api(`/api/decisions/${id}`)).status, "pending");
  key("ArrowRight");
  assert.equal(cardCursor(), "approve");
  key("Enter");
  const d = await waitStatus(id, "answer_submitted");
  assert.equal(d.response.approve, true);
  assert.equal(d.response.set_mode_auto, true);
});

gui("Instruct card: landing on it focuses the box; ↑ ↓ leave an empty box, stay with text; Esc blurs keeping the text; Enter in the box sends the instruction", async () => {
  const { id } = await seedPlan(LONG);
  await reopen("document.querySelector('#background details.plan-sec')");
  const focused = () => ev<boolean>(`document.activeElement === document.getElementById("instruct")`);
  key("ArrowRight");
  assert.equal(focused(), false, "Approve is under the cursor");
  key("ArrowDown");
  assert.equal(cardCursor(), "instruct");
  assert.equal(focused(), true);
  // typing text: ↑ ↓ stay in the box
  ev(`(() => { const t = document.getElementById("instruct"); t.value = "run the review"; t.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
  ev(`document.getElementById("instruct").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })), "ok"`);
  assert.equal(cardCursor(), "instruct");
  assert.equal(focused(), true);
  // Esc blurs and keeps the text
  ev(`document.getElementById("instruct").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })), "ok"`);
  assert.equal(focused(), false);
  assert.equal(ev(`document.getElementById("instruct").value`), "run the review");
  // i jumps back to the card
  key("i");
  assert.equal(focused(), true);
  // empty box: ↑ leaves it for Approve
  ev(`(() => { const t = document.getElementById("instruct"); t.value = ""; t.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
  ev(`document.getElementById("instruct").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true })), "ok"`);
  assert.equal(cardCursor(), "approve");
  assert.equal(focused(), false);
  // Enter in the box sends the instruction (no approval)
  key("i");
  ev(`(() => { const t = document.getElementById("instruct"); t.value = "run the review"; t.dispatchEvent(new Event("input", { bubbles: true })); t.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); return "ok"; })()`);
  const d = await waitStatus(id, "answer_submitted");
  assert.equal(d.response.instruct, true);
  assert.equal(d.response.text, "run the review");
});

gui("Reject: landing on it opens the reason box focused; Enter with a reason sends the rejection; an empty box lets ↑ leave", async () => {
  const { id } = await seedPlan(LONG);
  await reopen("document.querySelector('#background details.plan-sec')");
  const focusedReason = () => ev<boolean>(`document.activeElement === document.getElementById("reason")`);
  const reasonShown = () => ev<boolean>(`!document.querySelector("#decision .reject-box").hidden`);
  assert.equal(reasonShown(), false);
  key("ArrowRight");
  keyN("ArrowDown", 2);
  assert.equal(cardCursor(), "reject");
  assert.equal(reasonShown(), true);
  assert.equal(focusedReason(), true);
  // an empty reason box: ↑ goes back to Instruct and the box closes again
  ev(`document.getElementById("reason").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true })), "ok"`);
  assert.equal(cardCursor(), "instruct");
  assert.equal(reasonShown(), false, "nothing typed: the box closes");
  key("ArrowDown");
  assert.equal(focusedReason(), true);
  // with a reason, Enter in the box sends the rejection
  ev(`(() => { const t = document.getElementById("reason"); t.value = "wrong approach"; t.dispatchEvent(new Event("input", { bubbles: true })); t.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); return "ok"; })()`);
  const d = await waitStatus(id, "answer_submitted");
  assert.equal(d.response.approve, false);
  assert.equal(d.response.reason, "wrong approach");
});

gui("Reject without a reason: Enter in the empty box sends { approve: false } and the response has no reason; the button is enabled while empty", async () => {
  const { id } = await seedPlan(LONG);
  await reopen("document.querySelector('#background details.plan-sec')");
  key("n");
  assert.equal(ev(`document.activeElement === document.getElementById("reason")`), true);
  assert.equal(ev(`document.getElementById("reason").value`), "");
  assert.equal(ev(`document.getElementById("reason").placeholder`), "Reason (optional; Enter sends, Esc cancels)");
  assert.equal(ev(`document.querySelector("#decision .reject-box .btn").disabled`), false, "Send rejection is enabled with an empty box");
  ev(`document.getElementById("reason").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })), "ok"`);
  const d = await waitStatus(id, "answer_submitted");
  assert.equal(d.response.approve, false);
  assert.equal("reason" in d.response, false);
});

gui("y approves, n opens the reason box, i the instruction box, 2 / 3 select Instruct / Reject, from either zone", async () => {
  const { id } = await seedPlan(LONG);
  await reopen("document.querySelector('#background details.plan-sec')");
  assert.equal(zone(), "plan");
  key("i");
  assert.equal(zone(), "opts");
  assert.equal(cardCursor(), "instruct");
  assert.equal(ev(`document.activeElement === document.getElementById("instruct")`), true);
  key("ArrowLeft"); // in an empty box
  assert.equal(zone(), "plan");
  key("n");
  assert.equal(zone(), "opts");
  assert.equal(cardCursor(), "reject");
  assert.equal(ev(`document.activeElement === document.getElementById("reason")`), true);
  ev(`document.getElementById("reason").blur(), "ok"`);
  key("2");
  assert.equal(cardCursor(), "instruct");
  ev(`document.getElementById("instruct").blur(), "ok"`);
  key("3");
  assert.equal(cardCursor(), "reject");
  ev(`document.getElementById("reason").blur(), "ok"`);
  key("ArrowLeft");
  assert.equal(zone(), "plan");
  key("y");
  const d = await waitStatus(id, "answer_submitted");
  assert.equal(d.response.approve, true);
  assert.equal(d.response.set_mode_auto, true);
});

const count = (sel: string) => ev<number>(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const unreadLine = () => ev<string>(`(() => { const e = document.querySelector("#decision .plan-unread"); return !e || e.hidden ? "" : e.textContent; })()`);

gui("one y sends at once with set_mode_auto: true, even with unread sections; the decision has three options (Approve / Instruct / Reject) and no confirm bar", async () => {
  const { id } = await seedPlan(LONG);
  await reopen("document.querySelector('#background details.plan-sec')");
  assert.equal(count("#decision .actions > .opt"), 3);
  assert.equal(count("#decision .confirm-bar"), 0);
  key("y");
  const d = await waitStatus(id, "answer_submitted");
  assert.equal(d.response.approve, true);
  assert.equal(d.response.set_mode_auto, true);
});

gui("a does nothing on a plan", async () => {
  const { id } = await seedPlan(LONG);
  await reopen("document.querySelector('#background details.plan-sec')");
  key("a");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await api(`/api/decisions/${id}`)).status, "pending");
});

gui("the unread line sits above the buttons, updates as sections are opened and disappears at 0 (never blocks)", async () => {
  const { id } = await seedPlan(LONG);
  await reopen("document.querySelector('#background details.plan-sec')");
  assert.equal(unreadLine(), "Unread sections (7): Steps, Split and owners, Commit granularity, Verification, Observation path +2");
  assert.equal(ev(`document.querySelector("#decision .plan-unread").nextElementSibling.classList.contains("approve-card")`), true, "directly above the options");
  goTo("Steps");
  key("Enter");
  await waitFor("Steps open", `${secOf("Steps")}.open`);
  await waitFor("line updated", `document.querySelector("#decision .plan-unread").textContent.startsWith("Unread sections (6): Split and owners, Commit granularity")`);
  key("o");
  await waitFor("all open", `document.querySelectorAll("#background details[open]").length === 15`);
  assert.equal(unreadLine(), "");
  assert.equal((await api(`/api/decisions/${id}`)).status, "pending");
  key("y");
  const d = await waitStatus(id, "answer_submitted");
  assert.equal(d.response.set_mode_auto, true);
});

gui("ja: the unread line is 未読 n 節 and the options are 承認（auto モードで続行） / 指示 / 却下", async () => {
  await seedPlan(LONG);
  await reopen("document.querySelector('#background details.plan-sec')");
  await setLang("ja", `document.querySelector("#decision .plan-unread")?.textContent.startsWith("未読 7 節:")`);
  assert.equal(unreadLine(), "未読 7 節: Steps, Split and owners, Commit granularity, Verification, Observation path +2");
  assert.deepEqual(ev<string[]>(`JSON.stringify([...document.querySelectorAll("#decision .actions > .opt .lab")].map(l => l.firstChild.textContent))`), ["承認（auto モードで続行）", "指示", "却下"]);
  await setLang("en", `document.querySelector("#decision .plan-unread")?.textContent.startsWith("Unread sections (7)")`);
});

gui("an irreversible long plan is approved with one y too", async () => {
  const explanation = { path: "", title: "Drop the store", reversibility: "irreversible", scope: "machine", markdown: LONG, has: { mermaid: false, table: false, diff: false }, match: "recency", attached_via: "first_call" };
  const { id } = await seedPlan(LONG, explanation);
  await reopen("document.querySelector('#background details.plan-sec')");
  key("y");
  const d = await waitStatus(id, "answer_submitted");
  assert.equal(d.response.approve, true);
  assert.equal(d.response.set_mode_auto, true);
});

gui("clicking Approve sends at once", async () => {
  const { id } = await seedPlan(LONG);
  await reopen("document.querySelector('#background details.plan-sec')");
  ev(`document.querySelector("#decision .approve-card").click(), "ok"`);
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

gui("a short plan: y sends at once, the options zone is where it starts and the arrows move between the options (← → still cycle items)", async () => {
  const { id } = await seedPlan("# Short\n\nStep 1");
  await reopen();
  assert.equal(zone(), "none", "no zones on a short plan");
  assert.equal(cardCursor(), "approve");
  key("ArrowDown");
  assert.equal(cardCursor(), "instruct");
  key("ArrowDown");
  assert.equal(cardCursor(), "reject");
  key("y");
  const d = await waitStatus(id, "answer_submitted");
  assert.equal(d.response.approve, true);
});

gui("at 1000x700 the options and the hint are on screen, and the selected section stays in the plan column", async () => {
  await seedPlan(LONG);
  ab("set", "viewport", "1000", "700");
  await reopen("document.querySelector('#background details.plan-sec')");
  const visible = (sel: string) => ev<boolean>(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.width > 0; })()`);
  assert.equal(visible("#decision .approve-card"), true);
  assert.equal(visible("#decision .reject-card"), true);
  assert.equal(visible("#foot .hint"), true);
  // moving the selection to the last section keeps the options where they are
  keyN("j", 14);
  assert.equal(selTitle(), "Scope and reversibility");
  assert.equal(visible("#decision .approve-card"), true);
  assert.equal(visible("#background summary.sel"), true);
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
  // open Steps: its H3 summaries carry paths
  ev(`${secOf("Steps")}.querySelector("summary").click(), "ok"`);
  await waitFor("Steps open", `${secOf("Steps")}.open`);
  ev(`${secOf("1. Backend usecase")}.querySelector("summary .cbadge").click(), "ok"`);
  await waitFor("copied again", `window.__copied.length === 2`);
  assert.equal(ev(`window.__copied[1]`), "src/export/usecase.ts");
  assert.equal(ev(`${secOf("1. Backend usecase")}.open`), false, "the click copied; it did not open the section");
  // code that is not a path is not a badge
  ev(`${secOf("Verification")}.querySelector("summary").click(), "ok"`);
  await waitFor("Verification open", `${secOf("Verification")}.open`);
  assert.equal(ev(`[...document.querySelectorAll("#background code.cbadge")].some(c => c.textContent === "npm test")`), false);
});

gui("screenshots: 1440x900 folded, and with one section open", async () => {
  await seedPlan(LONG);
  await reopen("document.querySelector('#background details.plan-sec')");
  await sleep(300);
  ab("screenshot", join(SHOTS, "PL1-plan-folded.png"));
  goTo("Verification");
  key("Enter");
  await waitFor("Verification open", `${secOf("Verification")}.open`);
  await sleep(300);
  ab("screenshot", join(SHOTS, "PL1-plan-one-open.png"));
});

gui("screenshots for PL4: 1280 px, the plan zone with a section selected, and the options zone with the Instruct box focused", async () => {
  await seedPlan(LONG);
  ab("set", "viewport", "1280", "800");
  await reopen("document.querySelector('#background details.plan-sec')");
  goTo("Steps");
  key("Enter");
  await waitFor("Steps open", `${secOf("Steps")}.open`);
  key("j");
  await sleep(300);
  ab("screenshot", join(SHOTS, "PL4-plan-zone.png"));
  key("ArrowRight");
  key("ArrowDown");
  assert.equal(cardCursor(), "instruct");
  await sleep(300);
  ab("screenshot", join(SHOTS, "PL4-options.png"));
});
