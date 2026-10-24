// The "Ask" panel (public/aside.js) in the real GUI: `a` / the header button / Esc, suggestions, the POST body, streaming through `aside.updated`,
// Send <-> Stop, Copy, regenerate chains, the error with Try again, the selection popover's Ask, and the overlay below 1200px.
// A real server (temp HOME) and a real browser (agent-browser). The aside routes are mocked in the page (window.fetch) and `aside.updated` is
// delivered the way the SSE listener does (the `aside:updated` event), so this does not depend on the server side. Skipped when agent-browser is not on PATH.
import { after, before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { optInPlanAutoShow } from "../support/plans-auto.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REQUIRE_BROWSER = process.env["UKAGAI_REQUIRE_BROWSER"] === "1";
const HAS_BROWSER = spawnSync("agent-browser", ["--version"], { stdio: "ignore" }).status === 0;
const SHOTS = process.env.UKAGAI_SHOTS_DIR ?? join(tmpdir(), "ukagai-shots");
mkdirSync(SHOTS, { recursive: true });
const PLAN = "# Export retry\n\n## Context\n\nThe export job fails on a flaky upload.\n\n## Scope and reversibility\n\nReversibility: reversible\nScope: file\n\n## Steps\n\n- [ ] add retry\n";
const SID = "00000000-0000-0000-00a5-000000000001";

let home = "";
let top = "";
let scratch = "";
let dataDir = "";
let port = 0;
let token = "";
let serve: ChildProcess | undefined;
let base = "";
let opened = false;
let seq = 0;
const session = `ukagai-aside-${process.pid}-${Date.now().toString(36)}`;
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
/** A key as a real KeyboardEvent; `target` is a CSS selector (default: the document) */
const key = (k: string, target = "", init = "") =>
  ev(`(${target ? `document.querySelector(${JSON.stringify(target)})` : "document"}).dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true${init} })), "ok"`);
const text = (sel: string) => String(ev(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? ""`));
const count = (sel: string) => ev<number>(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const panelOpen = () => ev<boolean>(`!document.getElementById("aside").hidden`);
const typeAside = (v: string) => ev(`(() => { const t = document.querySelector(".as-ta"); t.focus(); t.value = ${JSON.stringify(v)}; t.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
const calls = () => ev<{ method: string; url: string; body: any }[]>(`JSON.stringify(window.__aside.calls)`);
const posts = () => calls().filter((c) => c.method === "POST");

async function api(path: string, body?: unknown, method?: string) {
  const go = () => fetch(base + path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await go().catch(() => go());
  const t = await res.text();
  return (t ? JSON.parse(t) : null) as any;
}
const sessionOf = () => ({ session_id: SID, cwd: join(home, "export-service"), transcript_path: join(home, ".claude", "projects", "p", "none.jsonl") });
async function seedPlan(): Promise<{ id: string }> {
  const d = await api("/api/decisions", {
    tool_use_id: `toolu_as_plan_${process.pid}_${++seq}`,
    kind: "approve_plan",
    session: sessionOf(),
    request: { plan: PLAN, planFilePath: "/Users/someone/.claude/plans/export-retry.md" },
  });
  assert.ok(d.id, JSON.stringify(d));
  return { id: d.id };
}
/** A question with an explanation (so the left column takes a selection) */
async function seedQuestion(explained = true): Promise<{ id: string }> {
  const docPath = join(scratch, "ukagai", `ex${++seq}.md`);
  const markdown = "---\nukagai: 1\n---\n## Why this decision is needed now\n\nThe retry should live in the worker queue, not in the client.\n";
  writeFileSync(docPath, markdown);
  const d = await api("/api/decisions", {
    tool_use_id: `toolu_as_q_${process.pid}_${seq}`,
    kind: "answer_question",
    session: { ...sessionOf(), scratchpad_dir: scratch },
    request: { questions: [{ question: "Where should the retry live?", header: "Retry", multiSelect: false, options: [{ label: "Worker (Recommended)", description: "nack and redeliver" }, { label: "API server", description: "poll and requeue" }] }] },
    ...(explained ? { explanation: { path: docPath, markdown, has: { mermaid: false, table: false, diff: false }, match: "question", attached_via: "first_call" } } : {}),
  });
  assert.ok(d.id, JSON.stringify(d));
  void api(`/api/decisions/${d.id}/wait?timeout_ms=60000`).catch(() => {});
  return { id: d.id };
}
async function cancelAll() {
  for (const d of (await api("/api/decisions?status=pending")) as { id: string }[]) await api(`/api/decisions/${d.id}/cancel`, {});
}
/** Reload, forget the remembered open state, install the mock for the aside routes */
async function reopen(ready: string) {
  ab("open", base + "/");
  ev(`(() => { try { localStorage.removeItem("ukagai.aside.open"); } catch {} return "ok"; })()`);
  ab("open", base + "/"); // the remembered state is read at load: start closed
  await waitFor("screen render", ready);
  mock();
}
/** window.fetch answers the aside routes from window.__aside; `emit` delivers an entry the way the SSE listener does */
function mock(initial: unknown[] = []) {
  ev(`(() => {
    window.__aside = { calls: [], entries: ${JSON.stringify(initial)}, n: 0, copied: null };
    window.__fetch ??= window.fetch;
    const json = (o, status = 200) => Promise.resolve(new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } }));
    window.fetch = (u, i) => {
      const m = /\\/api\\/sessions\\/([^/]+)\\/aside(\\/running)?$/.exec(String(u));
      if (!m) return window.__fetch(u, i);
      const A = window.__aside;
      const method = i?.method ?? "GET";
      A.calls.push({ method, url: String(u), body: i?.body ? JSON.parse(i.body) : null });
      if (method === "GET") return json({ session_id: m[1], agent: "claude", available: true, entries: A.entries });
      if (method === "POST") {
        const b = JSON.parse(i.body);
        const src = b.regenerate_of ? A.entries.find((x) => x.id === b.regenerate_of) : null;
        const e = { id: "e" + (++A.n), decision_id: b.decision_id, decision_title: "T" + b.decision_id.slice(-4), question: src ? src.question : b.question, ...(src ? (src.quote ? { quote: src.quote } : {}) : b.quote ? { quote: b.quote } : {}), ...(b.regenerate_of ? { regenerate_of: b.regenerate_of } : {}), answer: "", trace: [], status: "running", created_at: new Date().toISOString() };
        A.entries.push(e);
        return json({ entry: e }, 202);
      }
      const run = A.entries.find((x) => x.status === "running");
      if (!run) return json({ error: "nothing running" }, 404);
      run.status = "cancelled";
      return json({ entry: run });
    };
    window.__emit = (patch) => {
      const A = window.__aside;
      const e = A.entries.find((x) => x.id === patch.id) ?? (A.entries.push(patch), patch);
      Object.assign(e, patch);
      document.dispatchEvent(new CustomEvent("aside:updated", { detail: { session_id: ${JSON.stringify(SID)}, entry: { ...e } } }));
    };
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (s) => { A_copied(s); } }, configurable: true });
    function A_copied(s) { window.__aside.copied = s; }
    return "ok";
  })()`);
}
const emit = (patch: object) => ev(`(window.__emit(${JSON.stringify(patch)}), "ok")`);
async function openByKey() {
  key("a");
  await waitFor("panel opens", `!document.getElementById("aside").hidden && document.querySelector(".as-ta")`);
}

before(async () => {
  if (!HAS_BROWSER) return;
  home = mkdtempSync(join(tmpdir(), "ukagai-asd-"));
  top = mkdtempSync(join(tmpdir(), "claude-ukagai-asd-"));
  scratch = join(top, "-proj", "sess-asd", "scratchpad");
  mkdirSync(join(scratch, "ukagai"), { recursive: true });
  dataDir = join(home, "data");
  optInPlanAutoShow(dataDir);
  mkdirSync(join(home, ".claude", "plans"), { recursive: true });
  mkdirSync(join(home, ".claude", "projects", "p"), { recursive: true });
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  serve = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "serve", "--port", String(port), "--data-dir", dataDir], { cwd: ROOT, stdio: "ignore", env: { ...process.env, HOME: home, UKAGAI_TERMINAL: "none" } });
  const end = Date.now() + 20000;
  for (;;) {
    try { if ((await fetch(base + "/healthz")).ok) break; } catch {}
    assert.ok(Date.now() < end, "serve did not start");
    await sleep(100);
  }
  token = readFileSync(join(dataDir, "token"), "utf8").trim();
  ab("open", base + "/", "--viewport", "1280x800");
  opened = true;
});
after(async () => {
  if (opened) { try { ab("close"); } catch {} }
  serve?.kill();
  for (const d of [home, top]) if (d) rmSync(d, { recursive: true, force: true });
});

function gui(name: string, fn: (t: TestContext) => Promise<void>) {
  test(`GUI aside: ${name}`, { skip: HAS_BROWSER ? false : "agent-browser is not installed" }, async (t) => {
    await cancelAll();
    ab("set", "viewport", "1280", "800");
    try { await fn(t); } finally { await cancelAll(); }
  });
}

gui("a and the header button open and close the panel; Esc closes it; the state is remembered; the footer names the key", async () => {
  await seedPlan();
  await reopen("document.querySelector('#decision .btn')");
  assert.equal(panelOpen(), false);
  assert.equal(ev(`document.getElementById("ask-btn").hidden`), false, "the header button is there");
  assert.equal(text("#ask-btn"), "Ask", "no count (and no 'null') while the thread is empty");
  assert.equal(count("#ask-btn .ask-count"), 0);
  assert.match(text("#foot"), /a Ask/);
  await openByKey();
  assert.equal(String(ev(`document.getElementById("ask-btn").getAttribute("aria-expanded")`)), "true");
  assert.equal(ev(`document.activeElement?.classList.contains("as-ta")`), true, "the question box has the focus");
  assert.equal(String(ev(`localStorage.getItem("ukagai.aside.open")`)), "1");
  key("Escape", ".as-ta");
  assert.equal(panelOpen(), false, "Esc in the box closes the panel");
  assert.equal(String(ev(`localStorage.getItem("ukagai.aside.open")`)), "0");
  ev(`document.getElementById("ask-btn").click(), "ok"`);
  await waitFor("opened by the button", `!document.getElementById("aside").hidden`);
  ev(`document.querySelector(".as-x").click(), "ok"`);
  assert.equal(panelOpen(), false, "the close button closes it");
  key("a");
  await waitFor("opened again", `!document.getElementById("aside").hidden`);
  key("a");
  assert.equal(panelOpen(), false, "a toggles");
  // remembered: a reload with the state "open" shows the panel again
  key("a");
  await waitFor("open", `!document.getElementById("aside").hidden`);
  ab("open", base + "/");
  await waitFor("screen render", "document.querySelector('#decision .btn')");
  await waitFor("panel back", `!document.getElementById("aside").hidden`);
});

gui("an empty thread greets and offers three suggestions; a click sends the question with decision_id", async () => {
  const { id } = await seedQuestion(false);
  await reopen("document.querySelector('#decision .opt')");
  await openByKey();
  assert.match(text(".as-greet"), /^Ask the export-service agent$|^Ask the .+ agent$/);
  assert.match(text(".as-greet-sub"), /nothing is added to its conversation/);
  const sugs = ev<string[]>(`JSON.stringify([...document.querySelectorAll(".as-sug")].map((b) => b.textContent))`);
  assert.deepEqual(sugs, ["Why the recommendation?", "What if I pick «API server»?", "What would change the recommendation?"]);
  assert.equal(ev(`document.querySelector(".as-send").disabled`), true, "Send is off with nothing typed");
  ab("screenshot", join(SHOTS, "ASIDE-empty.png"));
  ev(`document.querySelectorAll(".as-sug")[1].click(), "ok"`);
  await waitFor("posted", `window.__aside.calls.some((c) => c.method === "POST")`);
  const p = posts()[0]!;
  assert.equal(p.url.includes(`/api/sessions/${SID}/aside`), true);
  assert.deepEqual(p.body, { question: "What if I pick «API server»?", decision_id: id });
  await waitFor("the question is shown", `document.querySelector(".as-turn .as-q")?.textContent === "What if I pick «API server»?"`);
  assert.equal(count(".as-sug"), 0, "the greeting is gone");
});

gui("a plan screen has its own suggestions", async () => {
  await seedPlan();
  await reopen("document.querySelector('#decision .btn')");
  await openByKey();
  assert.deepEqual(ev<string[]>(`JSON.stringify([...document.querySelectorAll(".as-sug")].map((b) => b.textContent))`), ["Which step is the riskiest?", "What does this plan leave out?", "What is missing from the verification?"]);
});

gui("Enter sends, Shift+Enter and Enter during IME composition do not; the box and the quote are cleared after the send", async () => {
  await seedPlan();
  await reopen("document.querySelector('#decision .btn')");
  await openByKey();
  typeAside("first line");
  key("Enter", ".as-ta", ", shiftKey: true");
  key("Enter", ".as-ta", ", isComposing: true, keyCode: 229");
  assert.equal(posts().length, 0, "neither sends");
  assert.equal(ev(`document.querySelector(".as-send").disabled`), false);
  key("Enter", ".as-ta");
  await waitFor("posted once", `window.__aside.calls.filter((c) => c.method === "POST").length === 1`);
  assert.equal(posts()[0]!.body.question, "first line");
  await waitFor("box cleared", `document.querySelector(".as-ta").value === ""`);
});

gui("streaming: Thinking…, the trace line, text with the ● cursor, then usage and the action bar; Copy shows a ✓", async () => {
  await seedPlan();
  await reopen("document.querySelector('#decision .btn')");
  await openByKey();
  typeAside("Which step is risky?");
  key("Enter", ".as-ta");
  await waitFor("running entry", `document.querySelector(".as-turn.running")`);
  assert.match(text(".as-thinking"), /Thinking…/);
  assert.equal(ev(`document.querySelector(".as-send").classList.contains("stop")`), true, "Send became Stop");
  assert.equal(count(".as-bar"), 0, "no action bar while running");
  emit({ id: "e1", trace: [{ kind: "read", label: "src/serve/aside.ts" }, { kind: "read", label: "src/contract.ts" }] });
  await waitFor("trace line", `/Read 2 files/.test(document.querySelector(".as-trace summary")?.textContent ?? "")`);
  assert.equal(count(".as-thinking"), 0);
  ev(`document.querySelector(".as-trace").open = true, "ok"`);
  assert.match(text(".as-trace ul"), /src\/serve\/aside\.ts/);
  emit({ id: "e1", answer: "Step 2 is **riskiest**:\n\n- the migration" });
  await waitFor("text with cursor", `document.querySelector(".as-md strong")?.textContent === "riskiest" && document.querySelector(".as-md .as-cursor")`);
  assert.equal(ev(`document.querySelector(".as-trace").open`), true, "the trace stays open across updates");
  ab("screenshot", join(SHOTS, "ASIDE-streaming.png"));
  emit({ id: "e1", answer: "Step 2 is **riskiest**:\n\n- the migration\n- the rollback", status: "done", usage: { input_tokens: 30000, output_tokens: 2000, cost_usd: 0.0042 }, finished_at: new Date().toISOString() });
  await waitFor("done", `document.querySelector(".as-bar") && !document.querySelector(".as-cursor")`);
  assert.match(text(".as-usage"), /^32k tokens · \$0\.004$/);
  assert.equal(ev(`document.querySelector(".as-send").classList.contains("stop")`), false);
  ev(`document.querySelector(".as-copy").click(), "ok"`);
  await waitFor("copied", `window.__aside.copied !== null && document.querySelector(".as-copy").classList.contains("done")`);
  assert.equal(ev(`window.__aside.copied`), "Step 2 is **riskiest**:\n\n- the migration\n- the rollback");
  await waitFor("the ✓ goes back after 3 s", `!document.querySelector(".as-copy").classList.contains("done")`, 6000);
  ab("screenshot", join(SHOTS, "ASIDE-done.png"));
});

gui("Stop sends DELETE /running and shows Stopped; the header button counts the answers", async () => {
  await seedPlan();
  await reopen("document.querySelector('#decision .btn')");
  await openByKey();
  typeAside("slow one");
  key("Enter", ".as-ta");
  await waitFor("running", `document.querySelector(".as-send.stop")`);
  ev(`document.querySelector(".as-send").click(), "ok"`);
  await waitFor("deleted", `window.__aside.calls.some((c) => c.method === "DELETE" && c.url.endsWith("/aside/running"))`);
  await waitFor("stopped", `/Stopped/.test(document.querySelector(".as-stopped")?.textContent ?? "")`);
  assert.equal(ev(`document.querySelector(".as-send").classList.contains("stop")`), false);
  assert.equal(text("#ask-btn .ask-count"), "1");
});

gui("regenerate shows only the latest entry of the chain; an error shows Try again, which re-asks", async () => {
  const { id } = await seedPlan();
  await reopen("document.querySelector('#decision .btn')");
  await openByKey();
  typeAside("why?");
  key("Enter", ".as-ta");
  await waitFor("running", `document.querySelector(".as-turn.running")`);
  emit({ id: "e1", answer: "first answer", status: "done" });
  await waitFor("bar", `document.querySelector(".as-regen")`);
  ev(`document.querySelector(".as-regen").click(), "ok"`);
  await waitFor("regenerate posted", `window.__aside.calls.filter((c) => c.method === "POST").length === 2`);
  assert.deepEqual(posts()[1]!.body, { question: "why?", decision_id: id, regenerate_of: "e1" });
  await waitFor("chain collapsed", `document.querySelectorAll(".as-turn").length === 1 && document.querySelector(".as-turn").dataset.id === "e2"`);
  emit({ id: "e2", answer: "second answer", status: "done" });
  await waitFor("latest shown", `document.querySelector(".as-md")?.textContent.includes("second answer")`);
  assert.equal(count(".as-turn"), 1);
  assert.doesNotMatch(text(".as-thread, .as-viewport"), /first answer/);
  // an error on a new question
  typeAside("and then?");
  key("Enter", ".as-ta");
  await waitFor("e3 running", `document.querySelector('.as-turn[data-id="e3"].running')`);
  emit({ id: "e3", status: "error", error: "timed out after 180 s" });
  await waitFor("error with retry", `document.querySelector('.as-turn[data-id="e3"] .as-err .as-retry')`);
  assert.match(text(".as-err-msg"), /timed out after 180 s/);
  assert.equal(count('.as-turn[data-id="e3"] .as-bar'), 0);
  ev(`document.querySelector(".as-retry").click(), "ok"`);
  await waitFor("retry posted", `window.__aside.calls.filter((c) => c.method === "POST").length === 4`);
  assert.deepEqual(posts()[3]!.body, { question: "and then?", decision_id: id, regenerate_of: "e3" });
  ab("screenshot", join(SHOTS, "ASIDE-error.png"));
});

gui("the action bar of an earlier answer is hidden until hover; the last one is always shown; a new decision gets a separator", async () => {
  await seedPlan();
  await reopen("document.querySelector('#decision .btn')");
  const entry = (n: number, dec: string, title: string) => ({ id: `s${n}`, decision_id: dec, decision_title: title, question: `q${n}`, answer: `a${n}`, trace: [], status: "done", created_at: new Date(Date.now() + n).toISOString() });
  mock([entry(1, "d-one", "First decision"), entry(2, "d-two", "Second decision")]);
  await openByKey();
  await waitFor("two turns", `document.querySelectorAll(".as-turn").length === 2`);
  assert.match(text(".as-sep"), /Second decision/);
  assert.equal(count(".as-sep"), 1);
  const op = (i: number) => String(ev(`getComputedStyle(document.querySelectorAll(".as-bar")[${i}]).opacity`));
  assert.equal(op(0), "0");
  assert.equal(op(1), "1");
  assert.equal(text("#ask-btn .ask-count"), "2");
});

gui("a selection in the left column: the popover's Ask opens the panel with the quote; the send carries quote and source", async () => {
  const { id } = await seedQuestion(true);
  await reopen("document.querySelector('#background .md, #background p')");
  const sel = ev<string>(`(() => { const root = document.getElementById("background"); const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); for (let n = w.nextNode(); n; n = w.nextNode()) { const i = n.data.indexOf("worker queue"); if (i < 0) continue; const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 12); const s = getSelection(); s.removeAllRanges(); s.addRange(r); root.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); return "ok"; } return "none"; })()`);
  assert.equal(sel, "ok");
  await waitFor("popover with Ask", `document.querySelector(".cmt-pop .cmt-ask")`);
  ev(`document.querySelector(".cmt-pop .cmt-ask").click(), "ok"`);
  await waitFor("panel with the quote", `!document.getElementById("aside").hidden && !document.querySelector(".as-qprev").hidden`);
  assert.equal(text(".as-qprev i"), "worker queue");
  assert.equal(count(".cmt-pop"), 0, "the comment popover is gone");
  assert.equal(count("#decision .cmt-row"), 0, "no comment was made");
  typeAside("why not the client?");
  key("Enter", ".as-ta");
  await waitFor("posted", `window.__aside.calls.some((c) => c.method === "POST")`);
  assert.deepEqual(posts()[0]!.body, { question: "why not the client?", decision_id: id, quote: { source: "explanation", text: "worker queue" } });
  await waitFor("the bubble carries the quote", `document.querySelector(".as-turn .as-qb")?.textContent === "worker queue"`);
  assert.equal(ev(`document.querySelector(".as-qprev").hidden`), true, "the preview is cleared");
  // the quote can be dropped before sending
  ab("screenshot", join(SHOTS, "ASIDE-quote.png"));
});

gui("the × on the quote preview drops the quote", async () => {
  await seedQuestion(true);
  await reopen("document.querySelector('#background .md, #background p')");
  ev(`(() => { const root = document.getElementById("background"); const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); for (let n = w.nextNode(); n; n = w.nextNode()) { const i = n.data.indexOf("retry"); if (i < 0) continue; const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 5); const s = getSelection(); s.removeAllRanges(); s.addRange(r); root.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); return "ok"; } return "none"; })()`);
  await waitFor("Ask in the popover", `document.querySelector(".cmt-pop .cmt-ask")`);
  ev(`document.querySelector(".cmt-pop .cmt-ask").click(), "ok"`);
  await waitFor("quote preview", `!document.querySelector(".as-qprev").hidden`);
  ev(`document.querySelector(".as-qx").click(), "ok"`);
  assert.equal(ev(`document.querySelector(".as-qprev").hidden`), true);
  typeAside("plain question");
  key("Enter", ".as-ta");
  await waitFor("posted", `window.__aside.calls.some((c) => c.method === "POST")`);
  assert.equal("quote" in posts()[0]!.body, false);
});

gui("below 1200px the panel overlays the options column; at 1280px it is a column of its own; the dark theme reads", async () => {
  await seedPlan();
  await reopen("document.querySelector('#decision .btn')");
  await openByKey();
  const box = (sel: string) => ev<{ l: number; r: number; w: number }>(`JSON.stringify((() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { l: r.left, r: r.right, w: r.width }; })())`);
  let a = box("#aside");
  let d = box("#decision");
  assert.ok(a.w >= 400 && a.w <= 430, `about 420px wide: ${a.w}`);
  assert.ok(a.l >= d.r - 1, `a column of its own at 1280px: panel ${a.l} vs options ${d.r}`);
  ab("set", "viewport", "1100", "800");
  await sleep(300);
  a = box("#aside");
  d = box("#decision");
  assert.equal(ev(`getComputedStyle(document.getElementById("aside")).position`), "absolute");
  assert.ok(a.l < d.r - 100, `overlays the options column: panel ${a.l} vs options ${d.r}`);
  assert.ok(Math.abs(a.r - box("main").r) <= 1, "flush with the right edge");
  ab("screenshot", join(SHOTS, "ASIDE-narrow.png"));
  ab("set", "viewport", "1280", "800");
  ev(`(document.documentElement.dataset.theme = "dark", "ok")`);
  typeAside("dark?");
  key("Enter", ".as-ta");
  await waitFor("running", `document.querySelector(".as-turn.running")`);
  emit({ id: "e1", trace: [{ kind: "read", label: "README.md" }], answer: "Readable in the **dark** theme.", status: "done", usage: { input_tokens: 900, output_tokens: 100 } });
  await waitFor("done", `document.querySelector(".as-bar")`);
  ab("screenshot", join(SHOTS, "ASIDE-dark.png"));
  ev(`(delete document.documentElement.dataset.theme, "ok")`);
});

if (REQUIRE_BROWSER) {
  test("UKAGAI_REQUIRE_BROWSER=1: agent-browser is on PATH", () => {
    assert.ok(HAS_BROWSER, "agent-browser is not on PATH");
  });
}
