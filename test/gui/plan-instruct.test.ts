// Instruct from a plan card in the real GUI: the approval card (the Instruct box is always there like a question's free-text card and takes the
// focus when the selection lands on it; presets as chips, Esc keeps the text, Enter sends { instruct, text }), the early plan file card
// (box only when a session maps), and the presets textarea on /settings.
// A real server (temp HOME) and a real browser (agent-browser). Skipped when agent-browser is not on PATH.
import { after, before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HAS_BROWSER = spawnSync("agent-browser", ["--version"], { stdio: "ignore" }).status === 0;
const SHOTS = process.env.UKAGAI_SHOTS_DIR ?? join(tmpdir(), "ukagai-shots");
mkdirSync(SHOTS, { recursive: true });
const PLAN = "# Export retry\n\n## Context\n\nThe export job fails on a flaky upload.\n\n## Scope and reversibility\n\nReversibility: reversible\nScope: file\n\n## Steps\n\n- [ ] add retry\n";

let home = "";
let dataDir = "";
let port = 0;
let token = "";
let serve: ChildProcess | undefined;
let base = "";
let opened = false;
let seq = 0;
const session = `ukagai-plin-${process.pid}-${Date.now().toString(36)}`;
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
/** Put text in the instruction box the way typing does */
const typeInto = (text: string) => ev(`(() => { const t = document.querySelector("#instruct"); t.focus(); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);

async function api(path: string, body?: unknown, method?: string) {
  const go = () => fetch(base + path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await go().catch(() => go()); // a kept-alive socket may have been reset while the browser worked
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as any;
}
async function setPresets(presets: string[]) {
  const s = await api("/api/settings");
  s.plans.instruction_presets = presets;
  await api("/api/settings", s, "PUT");
}
async function seedPlan(sid?: string, transcriptPath?: string): Promise<{ id: string }> {
  const n = ++seq;
  const d = await api("/api/decisions", {
    tool_use_id: `toolu_pli_${process.pid}_${n}`,
    kind: "approve_plan",
    session: { session_id: sid ?? `00000000-0000-0000-0002-${String(n).padStart(12, "0")}`, cwd: ROOT, transcript_path: transcriptPath ?? join(home, ".claude", "projects", "p", "none.jsonl") },
    request: { plan: PLAN, planFilePath: "/Users/someone/.claude/plans/export-retry.md" },
  });
  assert.ok(d.id, JSON.stringify(d));
  return { id: d.id };
}
async function cancelAll() {
  for (const d of (await api("/api/decisions?status=pending")) as { id: string }[]) await api(`/api/decisions/${d.id}/cancel`, {});
}
async function reopen(ready: string) {
  ab("open", base + "/");
  await waitFor("screen render", ready);
}

before(async () => {
  if (!HAS_BROWSER) return;
  home = mkdtempSync(join(tmpdir(), "ukagai-plin-"));
  dataDir = join(home, "data");
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
  if (home) rmSync(home, { recursive: true, force: true });
});

function gui(name: string, fn: (t: TestContext) => Promise<void>) {
  test(`GUI plan instruct: ${name}`, { skip: HAS_BROWSER ? false : "agent-browser is not installed" }, async (t) => {
    await cancelAll();
    await setPresets([]);
    ab("set", "viewport", "1280", "800");
    try { await fn(t); } finally { await cancelAll(); }
  });
}

const active = () => ev<string>(`document.activeElement?.id ?? document.activeElement?.tagName ?? ""`);
const onCard = () => ev<boolean>(`!!document.querySelector("#decision .instruct-card.cursor")`);

gui("the box is there from the start (no Instruct button), the selection landing on it focuses it, Enter sends { instruct, text } and the history reads Instructed", async () => {
  const { id } = await seedPlan();
  await reopen("document.querySelector('#decision .btn')");
  assert.equal(ev(`!!document.querySelector("#instruct")`), true, "the box is shown on the first render");
  assert.equal(ev(`!!document.querySelector("#instruct-open")`), false, "no Instruct button");
  assert.equal(ev(`[...document.querySelectorAll("#decision button")].some(b => b.textContent === "Instruct")`), false);
  assert.deepEqual(ev(`JSON.stringify([...document.querySelectorAll("#decision .actions > .opt")].map(o => o.dataset.card))`), ["approve", "instruct", "reject"], "one option list: Approve, Instruct, Reject");
  assert.notEqual(active(), "instruct", "the first render does not steal the focus");
  assert.equal(onCard(), false);
  assert.match(ev<string>(`document.querySelector("#foot").textContent`), /i Instruct box/);
  assert.doesNotMatch(ev<string>(`document.querySelector("#foot").textContent`), /i Instruct ·/);
  // ↓ from Approve (the first selection) lands on the card: focus follows
  key("ArrowDown");
  await waitFor("box focused", `document.activeElement?.id === "instruct"`);
  assert.equal(onCard(), true);
  assert.equal(ev(`document.querySelector("#instruct-send").disabled`), true, "empty text cannot be sent");
  key("Enter", "#instruct");
  assert.equal((await api(`/api/decisions/${id}`)).status, "pending", "Enter on an empty box sends nothing");
  // ↑ ↓ in an empty box leave it and blur; ↑ goes back to Approve
  key("ArrowUp", "#instruct");
  assert.notEqual(active(), "instruct");
  assert.equal(onCard(), false);
  assert.equal(ev(`document.querySelector("#decision .opt.cursor")?.dataset.card`), "approve");
  key("ArrowDown");
  await waitFor("box focused again", `document.activeElement?.id === "instruct"`);
  // with text the arrows stay in the box
  typeInto("have Fable review it");
  assert.equal(ev(`document.querySelector("#instruct-send").disabled`), false);
  key("ArrowDown", "#instruct");
  key("ArrowUp", "#instruct");
  assert.equal(active(), "instruct");
  assert.equal(onCard(), true);
  // Esc blurs and keeps the text; typed shortcuts are text while focused
  key("Escape", "#instruct");
  assert.notEqual(active(), "instruct");
  assert.equal(ev(`document.querySelector("#instruct").value`), "have Fable review it", "Esc kept the text");
  assert.equal((await api(`/api/decisions/${id}`)).status, "pending");
  key("y", "#instruct");
  assert.equal((await api(`/api/decisions/${id}`)).status, "pending", "y typed in the box is text, not Approve");
  // i lands on the card from anywhere and focuses it
  key("ArrowDown");
  assert.equal(onCard(), false);
  key("i");
  await waitFor("i focuses the box", `document.activeElement?.id === "instruct"`);
  assert.equal(onCard(), true);
  key("Enter", "#instruct", ", shiftKey: true");
  assert.equal((await api(`/api/decisions/${id}`)).status, "pending", "Shift+Enter does not send");
  key("Enter", "#instruct");
  const done = await (async () => {
    const end = Date.now() + 5000;
    for (;;) {
      const d = await api(`/api/decisions/${id}`);
      if (d.status === "answer_submitted") return d;
      assert.ok(Date.now() < end, `not answered: ${d.status}`);
      await sleep(100);
    }
  })();
  assert.deepEqual({ instruct: done.response.instruct, text: done.response.text, approve: done.response.approve }, { instruct: true, text: "have Fable review it", approve: undefined });
  await waitFor("toast says Instructed", `document.body.textContent.includes("Instructed: have Fable review it")`);
});

gui("a click anywhere on the card focuses the box; y / n outside the box still approve / reject", async () => {
  const { id } = await seedPlan();
  await reopen("document.querySelector('#decision .btn')");
  ev(`document.querySelector("#decision .instruct-card .lab").click(), "ok"`);
  await waitFor("box focused by a click on the label", `document.activeElement?.id === "instruct"`);
  assert.equal(onCard(), true);
  key("Escape", "#instruct");
  key("n");
  await waitFor("reject field", `document.querySelector("#reason")`);
  key("Escape", "#reason");
  key("y");
  const end = Date.now() + 5000;
  for (;;) {
    const d = await api(`/api/decisions/${id}`);
    if (d.status === "answer_submitted") { assert.equal(d.response.approve, true); break; }
    assert.ok(Date.now() < end, `not answered: ${d.status}`);
    await sleep(100);
  }
});

gui("history: an instructed approval reads Instructed and carries no 'not delivered yet' mark", async () => {
  const tpath = join(home, ".claude", "projects", "p", "s-hist.jsonl");
  writeFileSync(tpath, JSON.stringify({ type: "user", timestamp: "2026-10-05T00:00:00.000Z", message: { role: "user", content: "make the export retry" } }) + "\n");
  const first = await seedPlan("s-hist", tpath);
  await seedPlan("s-hist", tpath);
  await reopen("document.querySelector('#decision .btn')");
  // answer the first decision through the API: the second one stays on screen
  await api(`/api/decisions/${first.id}/answer`, { instruct: true, text: "have Fable review it" });
  const end = Date.now() + 10000;
  while (!ev<boolean>(`!!document.querySelector(".hist-row")`) && Date.now() < end) { key("s"); await sleep(300); } // the history loads lazily
  assert.ok(ev<boolean>(`!!document.querySelector(".hist-row")`), "history overlay did not open");
  const rows = ev<string[]>(`JSON.stringify([...document.querySelectorAll(".hist-row")].map(r => r.textContent))`);
  const row = rows.find((r) => r.includes("Instructed: have Fable review it"));
  assert.ok(row, JSON.stringify(rows));
  assert.ok(!/not delivered/i.test(row!), row);
});

gui("two rapid Enters send exactly one instruction request", async () => {
  const { id } = await seedPlan();
  await reopen("document.querySelector('#decision .btn')");
  typeInto("only once");
  ev(`(() => { const t = document.querySelector("#instruct"); for (let i = 0; i < 2; i++) t.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); return "ok"; })()`);
  const end = Date.now() + 5000;
  for (;;) {
    const d = await api(`/api/decisions/${id}`);
    if (d.status === "answer_submitted") break;
    assert.ok(Date.now() < end, "not answered");
    await sleep(100);
  }
  await sleep(500);
  assert.equal((await api(`/api/decisions/${id}`)).response.text, "only once");
});

gui("plan file card: two rapid Enters queue the instruction once", async () => {
  writeFileSync(join(home, ".claude", "plans", "quick-fox.md"), PLAN);
  const tpath = join(home, ".claude", "projects", "p", "s-quick.jsonl");
  writeFileSync(tpath, '{"type":"user","slug":"quick-fox"}\n');
  await api("/api/events", { session_id: "s-quick", transcript_path: tpath, cwd: ROOT, hook_event_name: "UserPromptSubmit", received_at: new Date().toISOString() });
  await reopen("document.querySelector('#decision .done-reading')");
  const pick = () => ev<string>(`document.querySelector("#head .plan-file")?.textContent ?? ""`);
  for (let i = 0; i < 6 && pick() !== "quick-fox.md"; i++) { key("l"); await sleep(300); }
  assert.equal(pick(), "quick-fox.md");
  await waitFor("box focused on the first render of the plan file card", `document.activeElement?.id === "instruct"`);
  typeInto("only once");
  ev(`(() => { const t = document.querySelector("#instruct"); for (let i = 0; i < 2; i++) t.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); return "ok"; })()`);
  await waitFor("sent toast", `document.body.textContent.includes("Sent to the agent")`);
  await sleep(300);
  const ins = await api("/api/sessions/s-quick/instruction");
  assert.equal(ins.instruction.text, "only once", "a second send would have joined the text twice");
  rmSync(join(home, ".claude", "plans", "quick-fox.md"), { force: true });
});

gui("chips: a click fills the box, the same chip again sends; the presets update live from the settings", async () => {
  const { id } = await seedPlan();
  await setPresets(["Review adversarially", "Add a rollback plan"]);
  await reopen("document.querySelector('#decision .btn')");
  await waitFor("two chips", `document.querySelectorAll("#decision .instruct-chips .chip").length === 2`);
  assert.equal(ev(`document.activeElement.id === "instruct"`), false);
  ev(`document.querySelectorAll("#decision .chip")[1].click(), "ok"`);
  assert.equal(ev(`document.querySelector("#instruct").value`), "Add a rollback plan");
  assert.equal(ev(`document.activeElement.id`), "instruct");
  assert.equal(onCard(), true, "the chip click put the selection on the card");
  ab("screenshot", join(SHOTS, "PL2-approval.png"));
  assert.equal((await api(`/api/decisions/${id}`)).status, "pending", "the first click only fills the box");
  // a change of the presets shows without a reload
  await setPresets(["Only this one"]);
  await waitFor("chips replaced", `[...document.querySelectorAll("#decision .chip")].map(c => c.textContent).join("|") === "Only this one"`);
  ev(`document.querySelector("#decision .chip").click(), "ok"`);
  assert.equal(ev(`document.querySelector("#instruct").value`), "Only this one");
  ev(`document.querySelector("#decision .chip").click(), "ok"`);
  const end = Date.now() + 5000;
  for (;;) {
    const d = await api(`/api/decisions/${id}`);
    if (d.status === "answer_submitted") { assert.equal(d.response.text, "Only this one"); break; }
    assert.ok(Date.now() < end, `not answered: ${d.status}`);
    await sleep(100);
  }
});

gui("plan file card: the box shows only when a session maps, and sends to the plan endpoint", async () => {
  writeFileSync(join(home, ".claude", "plans", "swift-otter.md"), PLAN);
  writeFileSync(join(home, ".claude", "plans", "lonely.md"), PLAN.replace("Export retry", "Lonely"));
  const tpath = join(home, ".claude", "projects", "p", "s-early.jsonl");
  writeFileSync(tpath, '{"type":"user","slug":"swift-otter"}\n');
  await api("/api/events", { session_id: "s-early", transcript_path: tpath, cwd: ROOT, hook_event_name: "UserPromptSubmit", received_at: new Date().toISOString() });
  await setPresets(["Review adversarially"]);
  await reopen("document.querySelector('#decision .done-reading')");
  // two new plan files: show swift-otter (has a session) first, then lonely
  const title = () => ev<string>(`document.querySelector("#head .v2-title")?.textContent ?? ""`);
  if (title() !== "Export retry") { key("l"); await waitFor("swift-otter shown", `document.querySelector("#head .v2-title")?.textContent === "Export retry"`); }
  assert.equal(ev(`!!document.querySelector("#instruct")`), true, "the box is shown without pressing anything");
  assert.equal(ev(`!!document.querySelector("#instruct-open")`), false);
  assert.equal(ev(`!!document.querySelector("#plan-no-session")`), false);
  await waitFor("box focused on the first render", `document.activeElement?.id === "instruct"`);
  ab("screenshot", join(SHOTS, "PL2-planfile.png"));
  typeInto("add a rollback section");
  key("Enter", "#instruct");
  await waitFor("sent toast", `document.body.textContent.includes("Sent to the agent")`);
  const ins = await api("/api/sessions/s-early/instruction");
  assert.equal(ins.instruction.text, "add a rollback section");
  assert.equal(ins.instruction.about, "plan");
  // the plan without a session: it never came up by itself; opened by hand from the drawer it has no box, and the hint says why
  ev(`document.querySelector('.plan-row[data-name="lonely.md"]').click(), "ok"`);
  await waitFor("lonely shown", `document.querySelector("#head .v2-title")?.textContent === "Lonely"`);
  assert.equal(ev(`!!document.querySelector("#instruct")`), false);
  assert.equal(ev(`document.querySelector("#plan-no-session").textContent`), "The agent's session was not found");
  key("i");
  assert.equal(ev(`!!document.querySelector("#instruct")`), false);
});

gui("long plan file card: starts in the plan zone, → lands on the Instruct card with the box focused, ← (empty box) goes back; a live update keeps the zone", async () => {
  const LONG = readFileSync(new URL("./fixtures/long-plan.md", import.meta.url), "utf8");
  writeFileSync(join(home, ".claude", "plans", "long-fox.md"), LONG);
  const tpath = join(home, ".claude", "projects", "p", "s-long.jsonl");
  writeFileSync(tpath, '{"type":"user","slug":"long-fox"}\n');
  await api("/api/events", { session_id: "s-long", transcript_path: tpath, cwd: ROOT, hook_event_name: "UserPromptSubmit", received_at: new Date().toISOString() });
  await reopen("document.querySelector('#decision .done-reading')");
  await waitFor("the long plan is shown", `document.querySelector("#background details.plan-sec") && document.querySelector("#instruct")`);
  const zone = () => ev<string>(`document.getElementById("background").classList.contains("zone-on") ? "plan" : document.getElementById("decision").classList.contains("zone-on") ? "opts" : "none"`);
  assert.equal(zone(), "plan");
  assert.equal(onCard(), false);
  assert.notEqual(active(), "instruct", "the box does not take the focus while a long plan waits to be read");
  assert.match(ev<string>(`document.querySelector("#foot .hint").textContent`), /^↑↓ Section · Enter Open · o All · → Options/);
  key("ArrowRight");
  await waitFor("box focused", `document.activeElement?.id === "instruct"`);
  assert.equal(zone(), "opts");
  assert.equal(onCard(), true);
  assert.match(ev<string>(`document.querySelector("#foot .hint").textContent`), /^↑↓ Pick · Enter Decide · ← Plan/);
  // a live update of the plan file re-renders the screen: the zone and the focus stay
  writeFileSync(join(home, ".claude", "plans", "long-fox.md"), LONG.replace("Three pieces change; each is described below.", "Three pieces change; each is described below, once more."));
  await waitFor("updated section", `document.querySelector("#background .ps-upd:not([hidden])")`, 15000);
  assert.equal(zone(), "opts");
  assert.equal(active(), "instruct");
  key("ArrowLeft", "#instruct");
  assert.equal(zone(), "plan");
  assert.notEqual(active(), "instruct");
  assert.equal(onCard(), false);
  // with text in the box ← stays a text key
  key("ArrowRight");
  typeInto("keep me");
  key("ArrowLeft", "#instruct");
  assert.equal(zone(), "opts");
  rmSync(join(home, ".claude", "plans", "long-fox.md"), { force: true });
});

gui("settings: the presets textarea saves on change and the chips on the main page follow", async () => {
  ab("open", base + "/settings");
  await waitFor("settings page", `document.querySelector("#plan-presets")`);
  ev(`(() => { const t = document.querySelector("#plan-presets"); t.value = "  First one  \\n\\n Second one "; t.dispatchEvent(new Event("change", { bubbles: true })); return "ok"; })()`);
  const end = Date.now() + 5000;
  for (;;) {
    const s = await api("/api/settings");
    if (s.plans.instruction_presets.length) { assert.deepEqual(s.plans.instruction_presets, ["First one", "Second one"]); break; }
    assert.ok(Date.now() < end, "presets not saved");
    await sleep(100);
  }
  await waitFor("textarea shows the saved lines", `document.querySelector("#plan-presets").value === "First one\\nSecond one"`);
  await seedPlan();
  await reopen("document.querySelector('#decision .approve-card')"); // the approval (the plan file cards have no Approve option)
  await waitFor("chips", `[...document.querySelectorAll("#decision .chip")].map(c => c.textContent).join("|") === "First one|Second one"`);
});

gui("plan file card: a queued stop answers 409 and the toast is the translated text, not the server's English message", async () => {
  writeFileSync(join(home, ".claude", "plans", "stopped-fox.md"), PLAN.replace("Export retry", "Stopped fox"));
  const tpath = join(home, ".claude", "projects", "p", "s-stop.jsonl");
  writeFileSync(tpath, '{"type":"user","slug":"stopped-fox"}\n');
  await api("/api/events", { session_id: "s-stop", transcript_path: tpath, cwd: ROOT, hook_event_name: "UserPromptSubmit", received_at: new Date().toISOString() });
  const at = new Date().toISOString();
  const cp = await api("/api/decisions", { tool_use_id: `checkpoint:s-stop:${at}`, kind: "checkpoint", session: { session_id: "s-stop", cwd: ROOT, transcript_path: tpath }, request: { recap: "recap", recap_at: at } });
  await api(`/api/decisions/${cp.id}/answer`, { kind: "stop" });
  await reopen("document.querySelector('#decision .done-reading')");
  await waitFor("stopped fox shown", `document.querySelector("#head .v2-title")?.textContent === "Stopped fox"`);
  typeInto("add a section");
  key("Enter", "#instruct");
  await waitFor("translated toast", `document.body.textContent.includes("A stop is queued for this session; answer that first")`);
  assert.equal(ev(`document.body.textContent.includes("a stop is queued for this session")`), false, "the server's lower-case message is not shown");
});
