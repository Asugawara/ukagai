// Plans flow in like questions (PL3b): a new plan in ~/.claude/plans appears by itself, is read with Done reading, upgrades in place when its
// approval arrives, and is not listed anywhere afterwards. A real server (temp HOME) and a real browser (agent-browser). Skipped when agent-browser is not on PATH. Keys are sent as KeyboardEvents (eval), not with `press`.
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
const session = `ukagai-plans-${process.pid}-${Date.now().toString(36)}`;

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


async function seedQuestion(): Promise<{ id: string }> {
  const n = ++seq;
  const q = `Plans check ${n}: A, B or C?`;
  const d = await api("/api/decisions", {
    tool_use_id: `toolu_plans_${process.pid}_${n}`,
    kind: "answer_question",
    session: { session_id: `00000000-0000-0000-0002-${String(n).padStart(12, "0")}`, cwd: ROOT, transcript_path: join(home, ".claude", "projects", "p", "none.jsonl") },
    request: { questions: [{ question: q, header: "Check", multiSelect: false, options: [{ label: "A", description: "About A" }, { label: "B (Recommended)", description: "About B" }, { label: "C", description: "About C" }] }] },
  });
  assert.ok(d.id, `cannot create decision: ${JSON.stringify(d)}`);
  return { id: d.id };
}

/** A live session whose transcript carries `slug` (the plan file `<slug>.md` is then its plan); `withSlug: false` writes a transcript that has none yet */
async function registerSession(slug: string, withSlug = true): Promise<string> {
  const tpath = join(home, ".claude", "projects", "p", `${slug}.jsonl`);
  writeFileSync(tpath, withSlug ? `{"type":"user","slug":"${slug}"}\n` : '{"type":"user"}\n');
  await fetch(base + "/api/events", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ session_id: `s-${slug}`, transcript_path: tpath, cwd: ROOT, hook_event_name: "UserPromptSubmit", received_at: new Date().toISOString() }),
  });
  return tpath;
}

const PLANS = () => join(home, ".claude", "plans");
const SHORT_A = "# Short plan A\n\n## One\n\nText with `src/a.ts`.\n";

/** Write a plan file whose mtime is `ageMs` in the past (set in the same tick, so the server's debounced stat sees it) */
function writePlan(name: string, text: string, ageMs = 0) {
  mkdirSync(PLANS(), { recursive: true });
  writeFileSync(join(PLANS(), name), text);
  const t = new Date(Date.now() - ageMs);
  utimesSync(join(PLANS(), name), t, t);
}
function cleanPlans() {
  mkdirSync(PLANS(), { recursive: true });
  for (const f of readdirSync(PLANS())) rmSync(join(PLANS(), f), { force: true });
}

before(async () => {
  if (!HAS_BROWSER) return;
  home = mkdtempSync(join(tmpdir(), "ukagai-plans-"));
  dataDir = join(home, "data");
  mkdirSync(PLANS(), { recursive: true });
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  serve = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "serve", "--port", String(port), "--data-dir", dataDir], { cwd: ROOT, stdio: "ignore", env: { ...process.env, HOME: home, UKAGAI_DISABLE: "1" } });
  const end = Date.now() + 20000;
  for (;;) {
    try { if ((await fetch(base + "/healthz")).ok) break; } catch {}
    assert.ok(Date.now() < end, "serve did not start");
    await sleep(100);
  }
  token = readFileSync(join(dataDir, "token"), "utf8").trim();
  // A plan file pops up only when its agent session is known: the plans of these tests each have a live session whose transcript carries the slug
  mkdirSync(join(home, ".claude", "projects", "p"), { recursive: true });
  for (const slug of ["auto", "diff", "done", "gone", "ja", "live", "old", "prec", "r1", "up"]) await registerSession(slug);
  ab("open", base + "/", "--viewport", "1440x900");
  opened = true;
});

after(async () => {
  if (opened) { try { ab("close"); } catch {} }
  serve?.kill();
  if (home) rmSync(home, { recursive: true, force: true });
});

function gui(name: string, fn: (t: TestContext) => Promise<void>) {
  test(`GUI plans: ${name}`, { skip: HAS_BROWSER ? false : "agent-browser is not installed" }, async (t) => {
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

gui("a new plan shows itself within 2 s: read-only, 9 sections with only the first open, no buttons; y a n do nothing", async () => {
  await reopen(IDLE);
  await spyPosts();
  const t0 = Date.now();
  writePlan("auto.md", LONG);
  await waitFor("plan screen", `document.querySelectorAll("#background details.plan-sec").length === 9`, 2000);
  assert.ok(Date.now() - t0 < 2500);
  assert.equal(ev(openCount), 1);
  assert.equal(ev(`document.querySelector("#background details.plan-sec").open`), true);
  assert.equal(ev(`document.querySelector("#head .v2-title").textContent`), "Plan: add retry to the export job");
  const l2 = line2();
  assert.ok(l2.startsWith("Plan") && l2.includes("updated"), l2);
  assert.equal(ev(`document.querySelector("#head .plan-stats").textContent`), "9 sections · 200 lines · 12 files");
  assert.equal(ev(`document.querySelector("#head .plan-file").textContent`), "auto.md");
  assert.equal(ev(`document.querySelectorAll(".btn:not(#instruct-send), .opt:not(.instruct-card), .free-text, .none-card, .cannot-card, .escape-row").length`), 0); // a plan file with a session carries the instruction card, nothing else
  const text = ev<string>(`document.getElementById("main").textContent`);
  for (const w of ["Approve", "Reject", "Answer", "None of these", "Can't answer", "read only"]) assert.ok(!text.includes(w), w);
  assert.equal(ev(`document.querySelector("#decision .done-reading").textContent`), "Done readingEsc");
  assert.equal(String(ev(`document.getElementById("pending-count").textContent`)), "1");
  assert.equal(ev(`document.getElementById("pending-btn").hidden`), true);
  assert.ok(ev<string>(`document.title`).startsWith("(1)"));
  for (const k of ["y", "a", "n", "p"]) key(k);
  assert.deepEqual(posts(), []);
  assert.equal(ev(openCount), 1);
});

gui("Esc is Done reading: POST read, then the plain idle screen with no plan on it; a reload stays idle", async () => {
  await arrive("done.md");
  key("Escape");
  await waitFor("idle", IDLE);
  await waitFor("read posted", `window.__posts.some((u) => u.endsWith("/api/plans/done.md/read"))`);
  assert.equal(ev(`document.getElementById("recent")`), null);
  assert.ok(!ev<string>(`document.getElementById("empty").textContent`).includes("Plan: add retry"));
  assert.equal(String(ev(`document.getElementById("pending-count").textContent`)), "0");
  assert.equal(await planRead("done.md"), true);
  await reopen(IDLE);
  await sleep(800);
  assert.equal(ev(`document.getElementById("empty").hidden`), false);
  assert.equal(ev(`document.getElementById("main").hidden`), true);
  assert.ok(!ev<string>(`document.body.textContent`).includes("Plan: add retry"));
});

gui("live update: unchanged sections keep their state, the changed and the new one are unread and say updated; scroll and age follow", async () => {
  await arrive("live.md", LONG, 120_000);
  assert.ok(line2().includes("2m ago"), line2());
  key("o");
  assert.equal(ev(openCount), 9);
  ev(`document.getElementById("background").scrollTop = 300, "ok"`);
  const top = ev<number>(`document.getElementById("background").scrollTop`);
  assert.ok(top > 100, `the left column should scroll (got ${top})`);
  writePlan("live.md", LONG.replace("Three pieces change; each is described below.", "Three pieces change; each is described below, and one more sentence.") .replace("## Scope and reversibility", "## Epilogue\n\nNew words here.\n\n## Scope and reversibility"));
  await waitFor("new section", `${SEC}.length === 10`, 4000);
  const m = marks();
  assert.equal(m.length, 10);
  assert.equal(m[0], "☑");
  assert.equal(m[1], "☐", "the changed section is unread");
  assert.equal(m[8], "☐", "the new section is unread");
  assert.ok([...m.slice(2, 8), m[9]].every((x) => x === "☑"), `unchanged sections stay read: ${m.join("")}`);
  const sec = (i: number) => `${SEC}[${i}]`;
  assert.equal(ev(`${sec(0)}.open`), true);
  assert.equal(ev(`${sec(1)}.open`), true, "the changed section that was open stays open");
  assert.equal(ev(`${sec(8)}.open`), false, "the new section arrives folded");
  assert.equal(ev(`${sec(8)}.querySelector(":scope > summary > .ps-title").textContent`), "Epilogue");
  assert.equal(ev(`${sec(1)}.querySelector(":scope > summary > .ps-upd").hidden`), false);
  assert.equal(ev(`${sec(1)}.querySelector(":scope > summary > .ps-upd").textContent`), "updated");
  assert.equal(ev(`${sec(8)}.querySelector(":scope > summary > .ps-upd").hidden`), false);
  assert.equal(ev(`${sec(9)}.querySelector(":scope > summary > .ps-upd").hidden`), true);
  assert.equal(ev(`${sec(0)}.querySelector(":scope > summary > .ps-upd").hidden`), true);
  assert.equal(ev(`${sec(5)}.querySelector(":scope > summary > .ps-upd").hidden`), true);
  assert.equal(ev(`document.getElementById("background").scrollTop`), top);
  assert.ok(line2().includes("0s ago"), line2());
  assert.equal(ev(`document.querySelectorAll("#decision .toc-row").length`), 16);
  ab("screenshot", join(SHOTS, "PL3b-plan-live.png"));
  // the updated section stayed open; folding it and opening it again clears the word and marks it read
  ev(`${sec(1)}.querySelector(":scope > summary").click(), "ok"`);
  assert.equal(ev(`${sec(1)}.open`), false);
  ev(`${sec(1)}.querySelector(":scope > summary").click(), "ok"`);
  assert.equal(ev(`${sec(1)}.open`), true);
  assert.equal(ev(`${sec(1)}.querySelector(":scope > summary > .ps-upd").hidden`), true);
  assert.equal(marks()[1], "☑");
  // a changed section that was folded stays folded (unread, updated)
  ev(`${sec(3)}.querySelector(":scope > summary").click(), "ok"`);
  assert.equal(ev(`${sec(3)}.open`), false);
  const title = ev<string>(`${sec(3)}.querySelector(":scope > summary > .ps-title").textContent`);
  const body = LONG.replace("Three pieces change; each is described below.", "Three pieces change; each is described below, and one more sentence.").replace("## Scope and reversibility", "## Epilogue\n\nNew words here.\n\n## Scope and reversibility");
  assert.ok(body.includes(`## ${title}\n`), title);
  writePlan("live.md", body.replace(`## ${title}\n`, `## ${title}\n\nA later note.\n`));
  await waitFor("folded section updated", `${SEC}[3]?.querySelector(":scope > summary > .ps-upd")?.hidden === false`, 4000);
  assert.equal(ev(`${sec(3)}.open`), false, "the changed section that was folded stays folded");
  assert.equal(marks()[3], "☐");
  assert.equal(ev(`${sec(1)}.open`), true);
  key("Escape"); // Done reading: the next test starts from the idle screen
  await waitFor("idle", IDLE);
});

gui("live update by text: an unchanged heading with changed text marks only that section; a changed heading is a new section", async () => {
  await arrive("diff.md", LONG);
  key("o");
  assert.equal(ev(openCount), 9);
  const sec = (i: number) => `${SEC}[${i}]`;
  const title = ev<string>(`${sec(3)}.querySelector(":scope > summary > .ps-title").textContent`);
  assert.ok(LONG.includes(`## ${title}\n`), title);
  writePlan("diff.md", LONG.replace(`## ${title}\n`, `## ${title}\n\nOne more line.\n`));
  await waitFor("changed section marked", `${SEC}[3]?.querySelector(":scope > summary > .ps-upd")?.hidden === false`, 4000);
  const m = marks();
  assert.equal(m.length, 9);
  assert.equal(m[3], "☐");
  assert.deepEqual(m.filter((x, i) => i !== 3 && x !== "☑"), [], `only section 3 is unread: ${m.join("")}`);
  assert.equal(ev(`[...${SEC}].filter((d) => !d.querySelector(":scope > summary > .ps-upd").hidden).length`), 1);
  assert.equal(ev(`${sec(3)}.open`), true, "a changed section that was open stays open");
  // a renamed heading is a new section: folded, unread, updated
  writePlan("diff.md", LONG.replace(`## ${title}\n`, `## ${title} renamed\n`));
  await waitFor("renamed section new", `${SEC}[3]?.querySelector(":scope > summary > .ps-title")?.textContent === ${JSON.stringify(`${title} renamed`)}`, 4000);
  assert.equal(ev(`${sec(3)}.open`), false, "a new section arrives folded");
  assert.equal(marks()[3], "☐");
  assert.equal(ev(`${sec(3)}.querySelector(":scope > summary > .ps-upd").hidden`), false);
  assert.equal(marks().filter((x) => x === "☐").length, 1);
  key("Escape");
  await waitFor("idle", IDLE);
});

gui("a decision takes the screen from a plan: count 2, ] goes to the plan, h back, answering returns to the plan", async () => {
  await arrive("prec.md");
  const { id } = await seedQuestion();
  await waitFor("decision screen", `document.querySelector("#decision .opt")`);
  assert.equal(String(ev(`document.getElementById("pending-count").textContent`)), "2");
  assert.equal(ev(`document.getElementById("pending-btn").hidden`), false);
  key("]");
  await waitFor("plan again", `${SEC}.length === 9`);
  assert.equal(ev(`document.querySelectorAll("#decision .opt:not(.instruct-card)").length`), 0);
  key("h");
  await waitFor("decision again", `document.querySelector("#decision .opt")`);
  key("[");
  await waitFor("plan via [", `${SEC}.length === 9`);
  key("ArrowLeft");
  await waitFor("decision via arrow", `document.querySelector("#decision .opt")`);
  key("Enter"); // answers the recommended card at once
  await waitStatus(id, "answer_submitted").catch(() => waitStatus(id, "answered"));
  await waitFor("plan after the answer", `${SEC}.length === 9`);
  assert.equal(String(ev(`document.getElementById("pending-count").textContent`)), "1");
});

gui("upgrade in place: the approval for the shown plan keeps the sections' state, has one drawer row, the unread line goes away with the sections, one y answers and reads the plan", async () => {
  await arrive("up.md");
  ev(`(() => { const s = document.querySelectorAll("#background details.plan-sec > summary"); s[1].click(); s[2].click(); return "ok"; })()`);
  const before = marks();
  assert.equal(before.filter((m) => m === "☑").length, 4, "the first section, the two clicked and the scope section");
  const openBefore = ev<number>(openCount);
  const { id } = await seedPlanDecision("up.md", LONG);
  await waitFor("approval screen", `document.querySelector("#decision .btn.primary")`);
  assert.deepEqual(marks(), before);
  assert.equal(ev(openCount), openBefore);
  assert.equal(line2(), "Approve this plan?");
  assert.equal(ev(`document.querySelectorAll("#decision .btn").length`), 3);
  assert.equal(ev(`document.querySelectorAll("#pending-list .row").length`), 1);
  assert.equal(String(ev(`document.getElementById("pending-count").textContent`)), "1");
  const line = () => ev<string>(`(() => { const e = document.querySelector("#decision .plan-unread"); return !e || e.hidden ? "" : e.textContent; })()`);
  assert.ok(line().startsWith("Unread sections (5):"), line());
  key("o");
  await waitFor("unread line gone", `document.querySelector("#decision .plan-unread").hidden`);
  assert.equal(line(), "");
  assert.equal(ev(`document.querySelectorAll("#decision .confirm-bar").length`), 0);
  key("y"); // once
  await waitStatus(id, "answer_submitted").catch(() => waitStatus(id, "answered"));
  // The server marks the plan read when the approval resolves (the GUI sends no read POST on answer), so wait on the server state.
  for (let i = 0; i < 50 && !(await planRead("up.md")); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(await planRead("up.md"), true, "plan is read");
  await waitFor("idle", IDLE);
});

gui("the idle screen shows no plan row: a read plan and a plan unread for 30 hours appear nowhere", async () => {
  writePlan("old.md", SHORT_A, 30 * 3600_000);
  await reopen(IDLE);
  await sleep(800);
  assert.equal(ev(`document.getElementById("main").hidden`), true);
  assert.equal(String(ev(`document.getElementById("pending-count").textContent`)), "0");
  assert.equal(ev(`document.getElementById("recent")`), null);
  assert.equal(ev(`document.querySelectorAll(".recent-row, .plan-row").length`), 0);
  // neither the 30 h old plan nor the plan read earlier (done.md) is named anywhere on the page
  const body = ev<string>(`document.body.textContent`);
  assert.ok(!body.includes("Text with") && !body.includes("Plan: add retry to the export job") && !body.includes("old.md"));
  assert.equal(ev(`document.getElementById("empty-title").textContent`), "Nothing to decide");
  key("Enter");
  key("j");
  await sleep(200);
  assert.equal(ev(`document.getElementById("main").hidden`), true);
});

gui("plan.removed while shown returns to idle; p does nothing", async () => {
  await arrive("gone.md");
  rmSync(join(PLANS(), "gone.md"));
  await waitFor("idle", IDLE, 4000);
  key("p");
  await sleep(200);
  assert.equal(ev(`document.querySelectorAll(".overlay").length`), 0);
  assert.equal(ev(`document.getElementById("main").hidden`), true);
  assert.equal(ev(`document.getElementById("foot").hidden`), true);
});

gui("ja words: row 2, Done reading, the drawer's plan word", async () => {
  await arrive("ja.md", LONG, 3 * 60_000);
  await setLang("ja", `document.querySelector("#decision .done-reading")?.textContent.startsWith("読んだ")`);
  try {
    const l2 = line2();
    assert.ok(l2.startsWith("計画") && l2.includes("更新") && l2.includes("3分前"), l2);
    assert.equal(ev(`document.querySelector("#head .plan-stats").textContent`), "9 節 · 200 行 · 12 ファイル");
    assert.ok(ev<string>(`document.querySelector("#foot .hint").textContent`).includes("Esc 読んだ"));
    const { id } = await seedQuestion();
    await waitFor("decision", `document.querySelector("#decision .opt")`);
    key("b");
    await waitFor("drawer", `document.querySelector("#pending-list .plan-row")`);
    assert.ok(ev<string>(`document.querySelector("#pending-list .plan-row .meta").textContent`).includes("計画"));
    key("Escape");
    ev(`document.querySelector("#pending-list .plan-row").click(), "ok"`);
    await waitFor("plan", `${SEC}.length === 9`);
    // update one section to see the ja word
    writePlan("ja.md", LONG.replace("Three pieces change; each is described below.", "Three pieces change; ja."));
    await waitFor("updated word", `${SEC}[1]?.querySelector(":scope > summary > .ps-upd")?.hidden === false`, 4000);
    assert.equal(ev(`${SEC}[1].querySelector(":scope > summary > .ps-upd").textContent`), "更新");
    await api(`/api/decisions/${id}/cancel`, {});
    key("Escape");
    await waitFor("idle", IDLE);
    assert.equal(ev(`document.getElementById("recent")`), null);
  } finally {
    await setLang("en", `document.getElementById("empty-title")?.textContent === "Nothing to decide"`);
  }
});

gui("screenshot: the idle screen at 1440x900 (no plan list)", async () => {
  writePlan("r1.md", LONG, 26 * 3600_000);
  await reopen(IDLE);
  await sleep(500);
  assert.equal(ev(`document.getElementById("recent")`), null);
  ab("screenshot", join(SHOTS, "PL3e-idle.png"));
});

gui("a plan file without a session is never shown by itself: no pop-up, not in Pending, listed in the drawer with the hint", async () => {
  await reopen(IDLE);
  writePlan("nosession.md", SHORT_A);
  await waitFor("plan known to the page", `document.getElementById("pending-btn") && !document.getElementById("pending-btn").hidden`, 4000);
  await sleep(800);
  assert.equal(ev(IDLE), true, "the idle screen stays");
  assert.equal(String(ev(`document.getElementById("pending-count").textContent`)), "0");
  assert.ok(!ev<string>(`document.title`).startsWith("(1)"));
  key("b");
  await waitFor("drawer row", `document.body.textContent.includes("Short plan A")`);
  key("Escape");
  await sleep(200);
});

gui("a plan file whose session is found later pops up as new once plan.updated carries session_id", async () => {
  await reopen(IDLE);
  const tpath = await registerSession("late", false);
  writePlan("late.md", SHORT_A);
  await waitFor("plan listed", `document.getElementById("pending-btn") && !document.getElementById("pending-btn").hidden`, 4000);
  await api("/api/plans"); // the lookup runs once with no slug on record
  await sleep(500);
  assert.equal(ev(IDLE), true, "no session yet: nothing pops up");
  writeFileSync(tpath, '{"type":"user"}\n{"type":"assistant","slug":"late"}\n'); // Claude Code assigns the slug lazily, later in the transcript
  await api("/api/plans"); // the next lookup finds it and announces it
  await waitFor("pop-up after the session is known", `document.querySelector("#head .plan-file")?.textContent === "late.md"`, 5000);
  assert.equal(String(ev(`document.getElementById("pending-count").textContent`)), "1");
  key("Escape");
  await waitFor("idle", IDLE);
});
