// "The plan was approved but auto mode was not switched on": the flag comes after the plan's card closed, so a toast says it, once, whatever
// is on screen, and never for the list a page load starts with. A real server (temp HOME) and a real browser (agent-browser).
// Skipped when agent-browser is not on PATH.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HAS_BROWSER = spawnSync("agent-browser", ["--version"], { stdio: "ignore" }).status === 0;
const NOTE = "The plan was approved but auto mode was not switched on";
const OWNER = "0123456789abcdef";
const PLAN = "# Plan: add the cache\n\n## Scope and reversibility\nReversibility: reversible\nScope: repo\n";

let home = "";
let dataDir = "";
let base = "";
let token = "";
let serve: ChildProcess | undefined;
let opened = false;
let seq = 0;
const session = `ukagai-auto-note-${process.pid}-${Date.now().toString(36)}`;

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

async function api(path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

/** Every toast the page adds from now on (they remove themselves after a few seconds) */
const recordToasts = () =>
  ev(`(() => { window.__toasts = []; if (!window.__toastObs) { window.__toastObs = new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.classList?.contains("toast")) window.__toasts.push(n.textContent); }); window.__toastObs.observe(document.body, { childList: true, subtree: true }); } return "ok"; })()`);
const toasts = () => ev<string[]>(`JSON.stringify(window.__toasts)`);
const notes = async () => (await toasts()).filter((x) => x === NOTE).length;

/** A plan registered for message delivery (the mod polled the session just before), approved with "and auto" */
async function approvedAutoPlan(): Promise<{ id: string; sid: string; transcript: string; fingerprint: string }> {
  const n = ++seq;
  const sid = `auto-note-${process.pid}-${n}`;
  const transcript = join(home, ".claude", "projects", "p", `${sid}.jsonl`);
  writeFileSync(transcript, "");
  assert.equal((await api(`/api/sessions/${sid}/inbox/poll`, { owner: OWNER, idle: false })).status, 204);
  const plan = `${PLAN}\nversion ${n}\n`;
  const d = (await api("/api/decisions", {
    tool_use_id: `toolu_auto_note_${process.pid}_${n}`,
    kind: "approve_plan",
    session: { session_id: sid, cwd: ROOT, transcript_path: transcript, permission_mode: "plan" },
    request: { plan, planFilePath: join(home, ".claude", "plans", `auto-note-${n}.md`) },
    mod_owner: OWNER,
  })).json;
  assert.equal(d.delivery, "message", JSON.stringify(d));
  await waitFor("the plan card", `document.querySelector("#decision .btn")`);
  assert.equal((await api(`/api/decisions/${d.id}/answer`, { approve: true, set_mode_auto: true })).status, 200);
  return { id: d.id, sid, transcript, fingerprint: d.fingerprint };
}

before(async () => {
  if (!HAS_BROWSER) return;
  home = mkdtempSync(join(tmpdir(), "ukagai-auto-note-"));
  dataDir = join(home, "data");
  mkdirSync(join(home, ".claude", "projects", "p"), { recursive: true });
  mkdirSync(join(home, ".claude", "plans"), { recursive: true });
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  serve = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "serve", "--port", String(port), "--data-dir", dataDir], { cwd: ROOT, stdio: "ignore", env: { ...process.env, HOME: home, UKAGAI_DISABLE: "1", UKAGAI_TERMINAL: "none" } });
  const end = Date.now() + 20000;
  for (;;) {
    try { if ((await fetch(base + "/healthz")).ok) break; } catch {}
    assert.ok(Date.now() < end, "serve did not start");
    await sleep(100);
  }
  token = readFileSync(join(dataDir, "token"), "utf8").trim();
  ab("open", base + "/", "--viewport", "1440x900");
  opened = true;
  await waitFor("the page", `document.getElementById("empty")`);
});

after(async () => {
  if (opened) { try { ab("close"); } catch {} }
  serve?.kill();
  if (home) rmSync(home, { recursive: true, force: true });
});

test("GUI auto note: the flag set after the plan went through (ExitPlanMode's PostToolUse) is toasted once, whatever is shown; a page load does not toast it", { skip: HAS_BROWSER ? false : "agent-browser is not installed" }, async () => {
  const p = await approvedAutoPlan();
  await recordToasts();
  // Claude Code's own dialog let the plan through: the PostToolUse of ExitPlanMode uses the grant up and flags it
  const post = await api("/api/events", { session_id: p.sid, transcript_path: p.transcript, cwd: ROOT, hook_event_name: "PostToolUse", tool_name: "ExitPlanMode", permission_mode: "default", received_at: new Date().toISOString() });
  assert.equal(post.status, 204);
  assert.equal((await api(`/api/decisions/${p.id}`)).json.delivery_flag, "auto_not_applied");
  await waitFor("the note toast", `window.__toasts.includes(${JSON.stringify(NOTE)})`);
  assert.equal(await notes(), 1);
  assert.ok(ev<boolean>(`[...document.querySelectorAll(".toast")].some((t) => t.textContent === ${JSON.stringify(NOTE)})`), "on screen");

  // A reload: the list it starts with does not toast it again
  ab("open", base + "/");
  await waitFor("the page after the reload", `document.getElementById("empty")`);
  await recordToasts();
  await sleep(1500);
  assert.equal(await notes(), 0);
});

test("GUI auto note: a plan switched back to the hook's wait is not flagged; an ack that keeps the grant for the PermissionRequest toasts nothing, one that uses it up toasts once", { skip: HAS_BROWSER ? false : "agent-browser is not installed" }, async () => {
  const kept = await approvedAutoPlan();
  await recordToasts();
  // The re-called ExitPlanMode missed the grant: the decision goes back to the long-poll, and "approve and auto" still switches through the PermissionRequest
  const open = await api(`/api/sessions/${kept.sid}/open?fingerprint=${kept.fingerprint}&tool_use_id=toolu_again_${seq}`);
  assert.equal(open.status, 200);
  assert.equal(open.json.decision.delivery_flag, undefined);
  assert.equal((await api(`/api/decisions/${kept.id}/wait?timeout_ms=1000`)).status, 200);
  assert.equal((await api(`/api/decisions/${kept.id}/ack`, { keep_plan_grant: true })).status, 200);
  assert.deepEqual((await api(`/api/sessions/${kept.sid}/plan-grant/consume`, { fingerprint: kept.fingerprint })).json, { consumed: true, mode: "auto" });
  await sleep(1000);
  assert.equal((await api(`/api/decisions/${kept.id}`)).json.delivery_flag, undefined);
  assert.equal(await notes(), 0, "auto mode was switched on");

  // The waiting hook let the plan through itself (a subagent's, or outside plan mode): its ack uses the grant up and flags it, once
  const used = await approvedAutoPlan();
  await recordToasts();
  assert.equal((await api(`/api/sessions/${used.sid}/open?fingerprint=${used.fingerprint}&tool_use_id=toolu_again_${seq}`)).status, 200);
  assert.equal((await api(`/api/decisions/${used.id}/wait?timeout_ms=1000`)).status, 200);
  assert.equal((await api(`/api/decisions/${used.id}/ack`, {})).status, 200);
  assert.equal((await api(`/api/decisions/${used.id}`)).json.delivery_flag, "auto_not_applied");
  await waitFor("the note toast", `window.__toasts.includes(${JSON.stringify(NOTE)})`);
  const post = await api("/api/events", { session_id: used.sid, transcript_path: used.transcript, cwd: ROOT, hook_event_name: "PostToolUse", tool_name: "ExitPlanMode", permission_mode: "default", received_at: new Date().toISOString() });
  assert.equal(post.status, 204);
  await sleep(1000);
  assert.equal(await notes(), 1, "once for the same decision");
});

test("GUI lost note: an approval a newer plan kept from the agent (superseded before delivery) is toasted, not closed silently", { skip: HAS_BROWSER ? false : "agent-browser is not installed" }, async () => {
  const p = await approvedAutoPlan();
  await recordToasts();
  // The agent's next plan arrives before the mod delivered the approval: the approval closes without delivery
  const next = (await api("/api/decisions", {
    tool_use_id: `toolu_auto_note_next_${process.pid}_${seq}`,
    kind: "approve_plan",
    session: { session_id: p.sid, cwd: ROOT, transcript_path: p.transcript, permission_mode: "plan" },
    request: { plan: `${PLAN}\nnewer ${seq}\n`, planFilePath: join(home, ".claude", "plans", `auto-note-next-${seq}.md`) },
    mod_owner: OWNER,
  })).json;
  assert.equal(next.delivery, "message", JSON.stringify(next));
  const old = (await api(`/api/decisions/${p.id}`)).json;
  assert.equal(old.status, "answer_lost");
  assert.equal(old.status_reason, "superseded");
  const LOST = "your answer was not delivered: a newer plan replaced it, or the time to call the plan again ran out";
  await waitFor("the lost toast", `window.__toasts.some((x) => x.includes(${JSON.stringify(LOST)}))`);
  assert.equal(await notes(), 0, "not the auto note");
});
