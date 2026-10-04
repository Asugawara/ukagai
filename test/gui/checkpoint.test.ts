// Progress checkpoints (a recap of the agent's progress): a non-blocking card with three one-press answers. A real server (temp HOME) and a real
// browser (agent-browser). Skipped when agent-browser is not on PATH. Keys are sent as KeyboardEvents (eval), not with `press`.
import { after, before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
const TERM_SID = `ck-term-${process.pid}`;
const session = `ukagai-ck-${process.pid}-${Date.now().toString(36)}`;

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



const CWD = "/work/ukagai-ck-demo";
const RECAP = "Added the retry to the uploader and the tests pass. Next I would wire it into the CLI and update the README.";

async function seedCheckpoint(sid = `ck-sess-${process.pid}`, recap = RECAP, transcript = join(home, ".claude", "projects", "p", "none.jsonl")): Promise<{ id: string }> {
  const n = ++seq;
  const at = new Date(Date.now() + n).toISOString();
  const d = await api("/api/decisions", {
    tool_use_id: `checkpoint:${sid}:${at}`,
    kind: "checkpoint",
    session: { session_id: sid, cwd: CWD, transcript_path: transcript },
    request: { recap, recap_at: at },
  });
  assert.ok(d.id, `cannot create checkpoint: ${JSON.stringify(d)}`);
  return { id: d.id };
}

async function seedQuestion(): Promise<{ id: string }> {
  const n = ++seq;
  const d = await api("/api/decisions", {
    tool_use_id: `toolu_ck_${process.pid}_${n}`,
    kind: "answer_question",
    session: { session_id: `00000000-0000-0000-0004-${String(n).padStart(12, "0")}`, cwd: ROOT, transcript_path: join(home, ".claude", "projects", "p", "none.jsonl") },
    request: { questions: [{ question: `Checkpoint order ${n}: A or B?`, header: "Check", multiSelect: false, options: [{ label: "A", description: "About A" }, { label: "B (Recommended)", description: "About B" }] }] },
  });
  assert.ok(d.id, `cannot create decision: ${JSON.stringify(d)}`);
  return { id: d.id };
}

async function stopEvent(sid: string) {
  const res = await fetch(base + "/api/events", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ session_id: sid, transcript_path: join(home, ".claude", "projects", "p", "none.jsonl"), cwd: CWD, hook_event_name: "Stop", received_at: new Date().toISOString() }),
  });
  assert.equal(res.status, 204);
}

const PLANS = () => join(home, ".claude", "plans");
function writePlan(name: string, text: string) {
  mkdirSync(PLANS(), { recursive: true });
  writeFileSync(join(PLANS(), name), text);
}
function cleanPlans() {
  mkdirSync(PLANS(), { recursive: true });
  for (const f of readdirSync(PLANS())) rmSync(join(PLANS(), f), { force: true });
}

before(async () => {
  if (!HAS_BROWSER) return;
  home = mkdtempSync(join(tmpdir(), "ukagai-ck-"));
  dataDir = join(home, "data");
  mkdirSync(PLANS(), { recursive: true });
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  // A fake `herdr` first on PATH: one pane (working, so nothing is typed) for the session TERM_SID, none for the others
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "herdr"), `#!/bin/sh\nif [ "$2" = list ]; then echo '{"result":{"panes":[{"pane_id":"w9:p9","agent":"claude","agent_status":"working","agent_session":{"value":"${TERM_SID}"}}]}}'; fi\n`, { mode: 0o755 });
  serve = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "serve", "--port", String(port), "--data-dir", dataDir], { cwd: ROOT, stdio: "ignore", env: { ...process.env, HOME: home, UKAGAI_DISABLE: "1", UKAGAI_TERMINAL: "herdr", PATH: `${bin}:${process.env.PATH}` } });
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
  test(`GUI checkpoint: ${name}`, { skip: HAS_BROWSER ? false : "agent-browser is not installed" }, async (t) => {
    await cancelAll();
    cleanPlans();
    ab("set", "viewport", "1440", "900");
    try { await fn(t); } finally { await cancelAll(); cleanPlans(); }
  });
}

const IDLE = "document.getElementById('empty') && !document.getElementById('empty').hidden";
const SEC = `document.querySelectorAll("#background details.plan-sec")`;
const openCount = `document.querySelectorAll("#background details.plan-sec[open]").length`;
const spyPosts = () => ev(`(() => { window.__posts = []; if (!window.__spied) { window.__spied = true; const f = window.fetch; window.fetch = (u, i) => { if (i && i.method === "POST") window.__posts.push(String(u)); return f(u, i); }; } else window.__posts = []; return "ok"; })()`);
const posts = () => ev<string[]>(`JSON.stringify(window.__posts)`);
const line2 = () => ev<string>(`document.querySelector("#head .hd-line2 .headline").textContent`);
const marks = () => ev<string[]>(`JSON.stringify([...document.querySelectorAll("#background details.plan-sec > summary > .ps-mark")].map((m) => m.textContent))`);
const planRead = async (name: string) => ((await api("/api/plans")).plans as { name: string; read: boolean }[]).find((p) => p.name === name)?.read;

/** A new plan arrives while the GUI is idle and takes the screen by itself (no key) */
async function arrive(name: string, text = LONG, ageMs = 0) {
  await reopen(IDLE);
  await spyPosts();
  writePlan(name, text, ageMs);
  await waitFor("plan screen", `document.querySelector("#head .hd-line2 .headline")?.textContent.includes("updated") && document.querySelector("#background .md")`, 4000);
}

async function seedPlanDecision(file: string, plan: string): Promise<{ id: string }> {
  const n = ++seq;
  const d = await api("/api/decisions", {
    tool_use_id: `toolu_plans_ap_${process.pid}_${n}`,
    kind: "approve_plan",
    session: { session_id: `00000000-0000-0000-0003-${String(n).padStart(12, "0")}`, cwd: ROOT, transcript_path: join(home, ".claude", "projects", "p", "none.jsonl") },
    request: { plan, planFilePath: join(PLANS(), file) },
  });
  assert.ok(d.id, `cannot create decision: ${JSON.stringify(d)}`);
  return { id: d.id };
}


const CARD = "document.querySelector('#decision .opt[data-card]')";
const text = (sel: string) => String(ev<string>(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? ""`));
const cards = () => ev<string[]>(`JSON.stringify([...document.querySelectorAll("#decision .opt[data-card]")].map((c) => c.dataset.card))`);
const spyBodies = () => ev(`(() => { window.__bodies = []; if (!window.__spiedB) { window.__spiedB = true; const f = window.fetch; window.fetch = (u, i) => { if (i && i.method === "POST") window.__bodies.push({ url: String(u), body: i.body }); return f(u, i); }; } else window.__bodies = []; return "ok"; })()`);
const bodies = () => ev<{ url: string; body: string }[]>(`JSON.stringify(window.__bodies)`);
const rowTexts = () => ev<string[]>(`JSON.stringify([...document.querySelectorAll("#pending-list .row")].map((r) => r.textContent))`);

async function show(id: string) {
  ab("open", base + "/");
  await waitFor("checkpoint card", CARD);
  await spyBodies();
  return id;
}

gui("the card: title, row 2 first sentence, optional line, the recap, three cards, no None / Can't answer", async () => {
  const c = await seedCheckpoint();
  await show(c.id);
  assert.match(text("#head .v2-title"), /^Progress check · ukagai-ck-demo$/);
  assert.equal(text("#head .hd-line2 .headline"), "Added the retry to the uploader and the tests pass.");
  assert.equal(text("#head .cp-optional"), "The agent keeps working if you do not answer");
  assert.equal(text("#background .cp-recap"), RECAP);
  assert.deepEqual(await cards(), ["continue", "instruct", "stop"]);
  assert.match(text("#decision .opt[data-card=continue]"), /Continue.*Recommended/);
  assert.equal(text("#decision .opt[data-card=instruct] .lab"), "Give an instruction…");
  assert.equal(text("#decision .opt[data-card=stop]"), "3Stop here");
  assert.equal(ev(`!!document.querySelector("#decision .none-card, #decision .cannot-card, #decision .opt.free")`), false);
  assert.equal(ev(`document.querySelector("#decision .cp-idle").hidden`), true);
  // The origin still comes first on row 1
  assert.equal(ev(`document.querySelector("#head .hd-top").firstElementChild.className`), "origin");
  ab("screenshot", join(SHOTS, "CK-U-checkpoint.png"));
});

gui("1 sends {kind: continue} at once", async () => {
  const c = await seedCheckpoint();
  await show(c.id);
  key("1");
  const d = await waitStatus(c.id, "answered");
  assert.equal(d.response.kind, "continue");
  assert.equal(d.response.text, undefined);
  assert.deepEqual(JSON.parse((await bodies()).find((p) => p.url.includes("/answer"))!.body), { kind: "continue" });
  await waitFor("idle after the answer", IDLE);
});

gui("2 opens the text box; text + Enter sends {kind: instruct, text}; an empty box sends nothing", async () => {
  const c = await seedCheckpoint();
  await show(c.id);
  key("2");
  await waitFor("box focused", `document.activeElement?.classList.contains("free-text")`);
  ev(`document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })), "ok"`);
  assert.equal((await bodies()).filter((p) => p.url.includes("/answer")).length, 0);
  ev(`(() => { const i = document.activeElement; i.value = "also bump the version"; i.dispatchEvent(new Event("input", { bubbles: true })); i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); return "ok"; })()`);
  const d = await waitStatus(c.id, "answered");
  assert.equal(d.response.kind, "instruct");
  assert.equal(d.response.text, "also bump the version");
  assert.deepEqual(JSON.parse((await bodies()).find((p) => p.url.includes("/answer"))!.body), { kind: "instruct", text: "also bump the version" });
});

gui("3 sends {kind: stop} with one press", async () => {
  const c = await seedCheckpoint();
  await show(c.id);
  key("3");
  const d = await waitStatus(c.id, "answered");
  assert.equal(d.response.kind, "stop");
  assert.deepEqual(JSON.parse((await bodies()).find((p) => p.url.includes("/answer"))!.body), { kind: "stop" });
});

gui("a click on Stop here sends at once; a click on the instruction card only opens the box", async () => {
  const c = await seedCheckpoint();
  await show(c.id);
  ev(`document.querySelector("#decision .opt[data-card=instruct] .lab").click(), "ok"`);
  await waitFor("box focused", `document.activeElement?.classList.contains("free-text")`);
  assert.equal((await bodies()).filter((p) => p.url.includes("/answer")).length, 0);
  ev(`document.querySelector("#decision .opt[data-card=stop]").click(), "ok"`);
  assert.equal((await waitStatus(c.id, "answered")).response.kind, "stop");
});

gui("precedence: a question outranks a checkpoint, a checkpoint outranks a plan file; the count includes it; the drawer says recap", async () => {
  writePlan("ck-plan.md", "# A plan file\n\n## One\n\nText.\n");
  const c = await seedCheckpoint();
  const q = await seedQuestion();
  ab("open", base + "/");
  await waitFor("first screen", `document.querySelector("#decision .opt")`);
  assert.match(text("#head .v2-title") + text("#head .hd-line2"), /Checkpoint order/);
  assert.equal(text("#pending-count"), "3"); // question + checkpoint + the new plan file
  const rows = await rowTexts();
  assert.equal(rows.length, 3);
  assert.match(rows[0]!, /Checkpoint order|Check/);
  assert.match(rows[1]!, /Progress check · ukagai-ck-demo/);
  assert.match(rows[1]!, /recap/);
  assert.match(rows[2]!, /A plan file/);
  // With the question answered the checkpoint is next, then the plan file
  await api(`/api/decisions/${q.id}/cancel`, {});
  await waitFor("checkpoint takes over", CARD);
  void c;
});

gui("idle note: hidden while the session works, shown once it is idle", async () => {
  const sid = `ck-idle-${process.pid}`;
  const c = await seedCheckpoint(sid);
  await show(c.id);
  assert.equal(ev(`document.querySelector("#decision .cp-idle").hidden`), true);
  await stopEvent(sid);
  await waitFor("idle note", `document.querySelector("#decision .cp-idle") && !document.querySelector("#decision .cp-idle").hidden`);
  assert.equal(text("#decision .cp-idle"), "The agent is idle; your reply arrives at its next tool call");
});

const toastTexts = () => ev<string[]>(`JSON.stringify([...document.querySelectorAll(".toast")].map((t) => t.textContent))`);
const hookGet = (sid: string) => fetch(`${base}/api/sessions/${sid}/instruction`, { headers: { authorization: `Bearer ${token}` } });

gui("idle note with a terminal: the reply will be typed into it (en and ja)", async () => {
  const c = await seedCheckpoint(TERM_SID);
  await show(c.id);
  await stopEvent(TERM_SID);
  await waitFor("terminal on the session", `[...document.querySelectorAll("#decision .cp-idle")].some((n) => n.textContent === "The agent is idle; your reply will be typed into its terminal (an unsent draft there goes with it)")`);
  ev(`document.documentElement.dataset.lang = "ja", "ok"`);
  await waitFor("ja note", `document.querySelector("#decision .cp-idle")?.textContent === "エージェントは待機中。返事はエージェントの端末に入力されます（未送信の下書きがあれば一緒に送られます）"`);
  ev(`document.documentElement.dataset.lang = "en", "ok"`);
});

gui("answering a checkpoint toasts Reply sent; delivery toasts Reply delivered later", async () => {
  const sid = `ck-toast-${process.pid}`;
  const c = await seedCheckpoint(sid);
  await show(c.id);
  key("2");
  await waitFor("box focused", `document.activeElement?.classList.contains("free-text")`);
  ev(`(() => { const i = document.activeElement; i.value = "ship it"; i.dispatchEvent(new Event("input", { bubbles: true })); i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); return "ok"; })()`);
  await waitStatus(c.id, "answered");
  await waitFor("sent toast", `[...document.querySelectorAll(".toast")].some((t) => t.textContent === "Reply sent")`);
  assert.ok(!(await toastTexts()).some((x) => /deliver/i.test(x)), "answered is not delivered: no delivered toast yet");
  assert.equal((await hookGet(sid)).status, 200); // the agent's next tool call
  await waitFor("delivered toast", `[...document.querySelectorAll(".toast")].some((t) => t.textContent === "Reply delivered")`);
});

gui("history drawer: an answered checkpoint is marked not delivered yet, then delivered; continue shows nothing", async () => {
  const sid = `ck-hist-${process.pid}`;
  const dir = join(home, ".claude", "projects", "p");
  const transcript = join(dir, `${sid}.jsonl`);
  const t0 = Date.now() - 3 * 3600_000;
  mkdirSync(dir, { recursive: true });
  writeFileSync(transcript, ["first prompt", "second prompt"].map((x, i) => JSON.stringify({ type: "user", message: { role: "user", content: x }, timestamp: new Date(t0 + i * 1800_000).toISOString() })).join("\n") + "\n");
  // The page is open while the checkpoints are answered, so it sees the answers through SSE
  const x = await seedCheckpoint(sid, "recap X", transcript);
  await show(x.id);
  assert.equal((await api(`/api/decisions/${x.id}/answer`, { kind: "instruct", text: "reply that waits" })).status, "answered");
  await waitFor("idle after the answer", IDLE);
  const z = await seedCheckpoint(sid, "recap Z", transcript);
  await waitFor("next card", CARD);
  assert.equal((await api(`/api/decisions/${z.id}/answer`, { kind: "continue" })).status, "answered");
  await waitFor("idle again", IDLE);
  await seedCheckpoint(sid, "recap Y", transcript);
  await waitFor("last card", CARD);
  await waitFor("history loaded", `document.querySelector("#head .hd-goal")`);
  key("s");
  await waitFor("drawer", `document.querySelector(".hist-row")`);
  const rows = () => ev<string[]>(`JSON.stringify([...document.querySelectorAll(".hist-row")].map((r) => r.textContent))`);
  assert.ok((await rows()).some((r) => r.includes("reply that waits") && r.includes("not delivered yet")), JSON.stringify(await rows()));
  assert.equal((await rows()).length, 3, "two prompts and the one instruct; the continue answer shows nothing");
  key("Escape");
  assert.equal((await hookGet(sid)).status, 200);
  await waitFor("delivered toast", `[...document.querySelectorAll(".toast")].some((t) => t.textContent === "Reply delivered")`);
  key("s");
  await waitFor("drawer", `document.querySelector(".hist-row")`);
  assert.ok((await rows()).some((r) => r.includes("reply that waits") && /delivered$/.test(r) && !r.includes("not delivered")), JSON.stringify(await rows()));
});

gui("Japanese: every word of the card, and English again", async () => {
  const sid = `ck-ja-${process.pid}`;
  const c = await seedCheckpoint(sid);
  await show(c.id);
  await stopEvent(sid);
  ev(`document.documentElement.dataset.lang = "ja", "ok"`);
  await waitFor("ja applied", `document.querySelector("#head .cp-optional")?.textContent === "答えなくてもエージェントは進みます"`);
  assert.match(text("#head .v2-title"), /^進捗確認 · ukagai-ck-demo$/);
  assert.match(text("#decision .opt[data-card=continue]"), /このまま続ける/);
  assert.equal(text("#decision .opt[data-card=instruct] .lab"), "指示を出す…");
  assert.match(text("#decision .opt[data-card=stop]"), /ここで止める/);
  await waitFor("idle note ja", `document.querySelector("#decision .cp-idle")?.textContent === "エージェントは待機中。返事は次のツール実行時に届きます"`);
  ev(`document.querySelector("#pending-btn").hidden = false, document.querySelector("#pending-btn").click(), "ok"`);
  assert.match((await rowTexts())[0]!, /進捗/);
  ev(`document.documentElement.dataset.lang = "en", "ok"`);
  await waitFor("en applied", `document.querySelector("#head .cp-optional")?.textContent === "The agent keeps working if you do not answer"`);
});

gui("a cancelled update removes the card silently (no toast)", async () => {
  const c = await seedCheckpoint();
  await show(c.id);
  await api(`/api/decisions/${c.id}/cancel`, {});
  await waitFor("idle", IDLE);
  assert.equal(ev(`document.querySelectorAll(".toast").length`), 0);
});
