// The GUI: a message-delivery question can be withdrawn without an answer (Withdraw button or `w`, pressed twice).
// A real server (temp HOME) and a real browser (agent-browser). Skipped when agent-browser is not on PATH.
import { after, before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { optInPlanAutoShow } from "../support/plans-auto.js";

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
const session = `ukagai-withdraw-${process.pid}-${Date.now().toString(36)}`;
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
  const text = await res.text(); // the inbox poll answers 204 with no body
  return (text ? JSON.parse(text) : {}) as any;
}

const transcript = () => join(home, ".claude", "projects", "p", "none.jsonl");

const OWNER = "0123456789abcdef";

/** A question the ukagai mod answers as a message (delivery "message"), or an ordinary one (no mod owner registered) */
async function seedQuestion(message: boolean): Promise<{ id: string }> {
  const n = ++seq;
  const sid = `00000000-0000-0000-0006-${String(n).padStart(12, "0")}`;
  const question = `Withdraw question ${n}: A or B?`;
  if (message) await api(`/api/sessions/${sid}/inbox/poll`, { owner: OWNER, idle: false });
  const d = await api("/api/decisions", {
    tool_use_id: `toolu_withdraw_${process.pid}_${n}`,
    kind: "answer_question",
    ...(message ? { mod_owner: OWNER } : {}),
    session: { session_id: sid, cwd: ROOT, transcript_path: transcript() },
    request: { questions: [{ question, header: "Check", multiSelect: false, options: [{ label: "A", description: "About A" }, { label: "B", description: "About B" }] }] },
  });
  assert.ok(d.id, `cannot create decision: ${JSON.stringify(d)}`);
  assert.equal(d.delivery, message ? "message" : undefined);
  return { id: d.id };
}

async function cancelAll() {
  const list = (await api("/api/decisions?status=pending")) as { id: string }[];
  for (const d of list) await api(`/api/decisions/${d.id}/cancel`, {}).catch(() => {});
  for (const d of list) await api(`/api/decisions/${d.id}/withdraw`, {}).catch(() => {});
}

async function reopen() {
  ab("open", base + "/");
  await waitFor("screen render", "document.querySelector('#decision .opt, #decision .btn')");
}

const get = (id: string) => api(`/api/decisions/${id}`);
const confirmShown = () => ev<boolean>(`(() => { const e = document.querySelector('#decision .confirm-inline[data-key="withdraw"]'); return !!e && !e.hidden; })()`);
const hasButton = () => ev<boolean>(`!!document.querySelector("#decision #withdraw")`);

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
  optInPlanAutoShow(dataDir);
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
  test(`GUI withdraw: ${name}`, { skip: HAS_BROWSER ? false : "agent-browser is not installed" }, async (t) => {
    await cancelAll();
    try { await fn(t); } finally { await cancelAll(); }
  });
}

// ---- Withdraw ----

gui("the Withdraw button shows for a message-delivery question, not for an ordinary one", async () => {
  await seedQuestion(false);
  await reopen();
  assert.equal(hasButton(), false);
  await cancelAll();
  await seedQuestion(true);
  await reopen();
  assert.equal(hasButton(), true);
});

gui("the button: the first press asks to confirm and leaves it pending; the second one withdraws it", async () => {
  const { id } = await seedQuestion(true);
  await reopen();
  ab("click", "#withdraw");
  await waitFor("confirm text", "document.querySelector('#decision .confirm-inline[data-key=\"withdraw\"]') && !document.querySelector('#decision .confirm-inline[data-key=\"withdraw\"]').hidden");
  assert.match(ev<string>(`document.querySelector('#decision .confirm-inline[data-key="withdraw"]').textContent`), /withdraw the question without answering/);
  assert.equal((await get(id)).status, "pending");
  ab("click", "#withdraw");
  await waitFor("withdrawn", `!document.querySelector("#decision #withdraw")`);
  const d = await get(id);
  assert.equal(d.status, "cancelled");
  assert.equal(d.status_reason, "withdrawn");
});

gui("the w key twice does the same", async () => {
  const { id } = await seedQuestion(true);
  await reopen();
  press("w");
  await waitFor("confirm text", "document.querySelector('#decision .confirm-inline[data-key=\"withdraw\"]') && !document.querySelector('#decision .confirm-inline[data-key=\"withdraw\"]').hidden");
  assert.equal(confirmShown(), true);
  assert.equal((await get(id)).status, "pending");
  press("w");
  await waitFor("withdrawn", `!document.querySelector("#decision #withdraw")`);
  const d = await get(id);
  assert.equal(d.status, "cancelled");
  assert.equal(d.status_reason, "withdrawn");
});

gui("w on an ordinary question does nothing", async () => {
  const { id } = await seedQuestion(false);
  await reopen();
  press("w", "w");
  await sleep(500);
  assert.equal((await get(id)).status, "pending");
});
