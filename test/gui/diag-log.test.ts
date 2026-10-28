// The GUI's diagnostics (POST /api/gui/log): a question that is registered while a page is open reaches serve.log as seen (via the SSE)
// and shown, with its lag. A real server (temp HOME) and a real browser (agent-browser).
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

let home = "";
let dataDir = "";
let base = "";
let token = "";
let serve: ChildProcess | undefined;
let opened = false;
const session = `ukagai-diag-log-${process.pid}-${Date.now().toString(36)}`;

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

/** The JSON lines of serve.log that match, polled up to `ms` */
async function waitForLog(what: string, match: (l: any) => boolean, ms = 5000): Promise<any> {
  const end = Date.now() + ms;
  for (;;) {
    let lines: any[] = [];
    try { lines = readFileSync(join(dataDir, "serve.log"), "utf8").trim().split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)); } catch {} // not written yet
    const found = lines.find(match);
    if (found) return found;
    assert.ok(Date.now() < end, `serve.log has no ${what}`);
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

before(async () => {
  if (!HAS_BROWSER) return;
  home = mkdtempSync(join(tmpdir(), "ukagai-diag-log-"));
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

test("GUI diagnostics: a question registered while the page is open is logged to serve.log as seen (via the SSE) and shown, with its lag", { skip: HAS_BROWSER ? false : "agent-browser is not installed" }, async () => {
  await waitForLog("gui_sse_open", (l) => l.event === "gui_sse_open");
  const pid = process.pid;
  const transcript = join(home, ".claude", "projects", "p", `diag-${pid}.jsonl`);
  writeFileSync(transcript, "");
  const created = await api("/api/decisions", {
    tool_use_id: `toolu_diag_${pid}`,
    kind: "answer_question",
    session: { session_id: `diag-${pid}`, cwd: ROOT, transcript_path: transcript },
    request: { questions: [{ question: "Diag?", header: "Diag", multiSelect: false, options: [{ label: "Yes", description: "y" }, { label: "No", description: "n" }] }] },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const id = created.json.id;
  const seen = await waitForLog("gui_decision_seen", (l) => l.event === "gui_decision_seen" && l.decision === id && l.via === "sse");
  const shown = await waitForLog("gui_decision_shown", (l) => l.event === "gui_decision_shown" && l.decision === id);
  assert.equal(typeof seen.lag_ms, "number");
  assert.ok(seen.lag_ms < 5000, JSON.stringify(seen));
  assert.equal(typeof shown.lag_ms, "number");
  assert.ok(shown.lag_ms < 5000, JSON.stringify(shown));
});
