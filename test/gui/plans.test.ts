// The plan browser in the GUI (`p`): the list of ~/.claude/plans and the read-only plan view, against a real server (temp HOME) and a real
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

const SHORT_A = "# Short plan A\n\n## One\n\nText with `src/a.ts`.\n";
const SHORT_C = "# Short plan C\n\n## One\n\nText.\n\n## Two\n\nMore.\n";

function writePlans(names: Record<string, [string, number]>) {
  const dir = join(home, ".claude", "plans");
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) rmSync(join(dir, f), { force: true });
  for (const [name, [text, ageMs]] of Object.entries(names)) {
    writeFileSync(join(dir, name), text);
    const t = new Date(Date.now() - ageMs);
    utimesSync(join(dir, name), t, t);
  }
}
const THREE = () => writePlans({ "a.md": [SHORT_A, 3 * 3600_000], "b.md": [LONG, 3600_000], "c.md": [SHORT_C, 5 * 60_000] });

before(async () => {
  if (!HAS_BROWSER) return;
  home = mkdtempSync(join(tmpdir(), "ukagai-plans-"));
  dataDir = join(home, "data");
  THREE();
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
    THREE();
    ab("set", "viewport", "1440", "900");
    try { await fn(t); } finally { await cancelAll(); }
  });
}

const rows = () => ev<string[]>(`JSON.stringify([...document.querySelectorAll(".overlay.plans .hist-row")].map(r => r.textContent))`);
const selRow = () => ev<string>(`document.querySelector(".overlay.plans .hist-row.sel .hist-text")?.textContent ?? ""`);
const listOpen = `document.querySelector(".overlay.plans")`;
const openCount = `document.querySelectorAll("#background details.plan-sec[open]").length`;
const countPosts = () => ev<number>(`window.__posts.length`);
const spyPosts = () => ev(`(() => { window.__posts = []; if (!window.__spied) { window.__spied = true; const f = window.fetch; window.fetch = (u, i) => { if (i && i.method === "POST") window.__posts.push(String(u)); return f(u, i); }; } return "ok"; })()`);

async function openLong() {
  key("p");
  await waitFor("list", `document.querySelectorAll(".overlay.plans .hist-row").length === 3`);
  key("j");
  key("Enter");
  await waitFor("long plan shown", `document.querySelectorAll("#background details.plan-sec").length === 9`);
}

gui("p on the idle screen lists the three plans newest first with section and line counts; j k move, Esc closes", async () => {
  await reopen("document.getElementById('empty') && !document.getElementById('empty').hidden");
  key("p");
  await waitFor("list", `document.querySelectorAll(".overlay.plans .hist-row").length === 3`);
  const r = rows();
  assert.ok(r[0]!.startsWith("Short plan C") && r[0]!.includes("5m ago") && r[0]!.includes("2 sections · 9 lines"), r[0]);
  assert.ok(r[1]!.startsWith("Plan: add retry to the export job") && r[1]!.includes("1h ago") && r[1]!.includes("9 sections · 200 lines"), r[1]);
  assert.ok(r[2]!.startsWith("Short plan A") && r[2]!.includes("3h ago") && r[2]!.includes("1 section · 5 lines"), r[2]);
  assert.equal(selRow(), "Short plan C");
  key("j");
  assert.equal(selRow(), "Plan: add retry to the export job");
  key("ArrowDown");
  key("ArrowDown");
  assert.equal(selRow(), "Short plan A");
  key("k");
  assert.equal(selRow(), "Plan: add retry to the export job");
  key("Escape");
  assert.equal(ev(`!!${listOpen}`), false);
  key("p");
  await waitFor("list again", listOpen);
  key("p");
  assert.equal(ev(`!!${listOpen}`), false);
  // the idle hint
  assert.ok(ev<string>(`document.querySelector("#foot .hint").textContent`).includes("p Plans"));
});

gui("Enter on the long plan: 9 sections with only the first open, 15 contents rows, the read-only header, no buttons; y does not POST", async () => {
  await reopen("document.getElementById('empty') && !document.getElementById('empty').hidden");
  await spyPosts();
  await openLong();
  assert.equal(ev(openCount), 1);
  assert.equal(ev(`document.querySelector("#background details.plan-sec").open`), true);
  assert.equal(ev(`document.querySelectorAll("#decision .toc-row").length`), 15);
  assert.equal(ev(`document.querySelector("#head .v2-title").textContent`), "Plan: add retry to the export job");
  assert.equal(ev(`document.querySelector("#head .hd-line2 .headline").textContent`), "Plan (read only)");
  assert.equal(ev(`document.querySelector("#head .plan-stats").textContent`), "9 sections · 200 lines · 12 files");
  assert.equal(ev(`document.querySelector("#head .plan-file").textContent`), "b.md");
  assert.equal(ev(`document.querySelectorAll(".approve, .reject, .btn, .free-text, .none-btn, .cannot-btn").length`), 0);
  const text = ev<string>(`document.getElementById("main").textContent`);
  for (const w of ["Approve", "Reject", "Answer", "None of these", "Can't answer"]) assert.ok(!text.includes(w), w);
  assert.equal(ev(`document.querySelector("#foot .hint").textContent`), "↑↓ Contents · Enter Open · o All · [ ] Section · Esc Back");
  for (const k of ["y", "a", "n"]) key(k);
  assert.equal(await countPosts(), 0);
  assert.equal(ev(openCount), 1);
  // o opens all, o again closes all; j then Enter opens the second row's section
  key("o");
  assert.equal(ev(openCount), 9);
  key("o");
  assert.equal(ev(openCount), 0);
  key("j");
  key("Enter");
  assert.equal(ev(`document.querySelectorAll("#background details[open]").length`), 1);
  assert.equal(await countPosts(), 0);
  // Esc back to the list, Esc again to the idle screen
  key("Escape");
  await waitFor("list back", listOpen);
  assert.equal(ev(`document.getElementById("main").hidden`), true);
  key("Escape");
  assert.equal(ev(`!!${listOpen}`), false);
  assert.equal(ev(`document.getElementById("empty").hidden`), false);
  assert.equal(ev(`document.getElementById("head").hidden`), true);
});

gui("ja: list rows, header and hint use Japanese words", async () => {
  await reopen("document.getElementById('empty') && !document.getElementById('empty').hidden");
  await setLang("ja", `document.querySelector("#foot .hint")?.textContent.includes("p 計画")`);
  try {
    key("p");
    await waitFor("list", `document.querySelectorAll(".overlay.plans .hist-row").length === 3`);
    const r = rows();
    assert.ok(r[1]!.includes("1時間前") && r[1]!.includes("9 節 · 200 行"), r[1]);
    assert.equal(ev(`document.querySelector(".overlay.plans .overlay-title").textContent`), "計画");
    key("j");
    key("Enter");
    await waitFor("plan", `document.querySelectorAll("#background details.plan-sec").length === 9`);
    assert.equal(ev(`document.querySelector("#head .hd-line2 .headline").textContent`), "計画(読むだけ)");
    assert.equal(ev(`document.querySelector("#head .plan-stats").textContent`), "9 節 · 200 行 · 12 ファイル");
    assert.ok(ev<string>(`document.querySelector("#foot .hint").textContent`).endsWith("Esc 戻る"));
  } finally {
    key("Escape");
    key("Escape");
    await setLang("en", `document.querySelector("#foot .hint")?.textContent.includes("p Plans")`);
  }
});

gui("a short plan shows the whole document with no contents", async () => {
  await reopen("document.getElementById('empty') && !document.getElementById('empty').hidden");
  key("p");
  await waitFor("list", `document.querySelectorAll(".overlay.plans .hist-row").length === 3`);
  key("Enter"); // Short plan C
  await waitFor("short plan", `document.querySelector("#background .md")?.textContent.includes("More.")`);
  assert.equal(ev(`document.querySelectorAll("#decision .toc-row").length`), 0);
  assert.equal(ev(`document.querySelectorAll("#background details").length`), 0);
  assert.equal(ev(`document.querySelector("#head .plan-stats")`), null);
  assert.equal(ev(`document.querySelector("#foot .hint").textContent`), "Esc Back");
});

gui("an empty plans directory shows the dim line", async () => {
  writePlans({});
  await reopen("document.getElementById('empty') && !document.getElementById('empty').hidden");
  key("p");
  await waitFor("empty line", `document.querySelector(".overlay.plans .plan-empty")`);
  assert.equal(ev(`document.querySelector(".overlay.plans .plan-empty").textContent`), "No plans in ~/.claude/plans");
  assert.equal(ev(`document.querySelectorAll(".overlay.plans .hist-row[data-i]").length`), 0);
  key("Escape");
});

gui("with a pending decision: p overlays it, and Esc restores it with the cursor where it was", async () => {
  await seedQuestion();
  await reopen("document.querySelector('#decision .opt')");
  key("ArrowDown");
  const cursor = ev<number>(`[...document.querySelectorAll("#decision .opt")].findIndex(o => o.classList.contains("cursor"))`);
  const hint = ev<string>(`document.querySelector("#foot .hint").textContent`);
  assert.ok(cursor >= 0);
  key("p");
  await waitFor("list", `document.querySelectorAll(".overlay.plans .hist-row").length === 3`);
  key("Enter");
  await waitFor("plan", `document.querySelector("#head .hd-line2 .headline")?.textContent === "Plan (read only)"`);
  key("Escape");
  await waitFor("list", listOpen);
  key("Escape");
  await waitFor("decision back", `document.querySelector("#decision .opt")`);
  assert.equal(ev<number>(`[...document.querySelectorAll("#decision .opt")].findIndex(o => o.classList.contains("cursor"))`), cursor);
  assert.equal(ev<string>(`document.querySelector("#foot .hint").textContent`), hint);
  assert.equal(ev(`document.querySelector("#head .v2-title").textContent`).includes("Plans check"), true);
});

gui("a decision that arrives while a plan is open does not steal the screen; the pending indicator shows and Esc reaches it", async () => {
  await reopen("document.getElementById('empty') && !document.getElementById('empty').hidden");
  await openLong();
  await seedQuestion();
  await waitFor("pending indicator", `!document.getElementById("pending-btn").hidden`);
  assert.equal(ev(`document.querySelector("#head .hd-line2 .headline").textContent`), "Plan (read only)");
  assert.equal(ev(`document.querySelectorAll("#background details.plan-sec").length`), 9);
  assert.equal(ev(`document.querySelector("#head .hd-meta #pending-btn") !== null`), true);
  key("Escape");
  key("Escape");
  await waitFor("decision shown", `document.querySelector("#decision .opt")`);
});

gui("at 1000x700 the hint and the contents cursor row stay visible", async () => {
  await reopen("document.getElementById('empty') && !document.getElementById('empty').hidden");
  ab("set", "viewport", "1000", "700");
  await openLong();
  keyN("j", 14);
  const vis = ev<{ hint: boolean; row: boolean }>(`(() => {
    const inView = (e) => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; };
    return JSON.stringify({ hint: inView(document.querySelector("#foot .hint")), row: inView(document.querySelector("#decision .toc-row.cursor")) });
  })()`);
  assert.deepEqual(vis, { hint: true, row: true });
  assert.equal(ev(`document.documentElement.scrollWidth <= innerWidth`), true);
});

gui("the shown plan re-fetches on change (open state kept when the headings are the same, reset when they change); the list refreshes", async () => {
  await reopen("document.getElementById('empty') && !document.getElementById('empty').hidden");
  await openLong();
  key("o");
  assert.equal(ev(openCount), 9);
  const file = join(home, ".claude", "plans", "b.md");
  writeFileSync(file, LONG.replace("## Context", "## Background"));
  // the poll is 10 s: wait for the change to arrive
  await waitFor("plan reloaded with new headings", `document.querySelector("#background details.plan-sec > summary .ps-title")?.textContent === "Background"`, 15000);
  assert.equal(ev(openCount), 1, "a changed outline starts over: only the first section is open");
  key("o");
  assert.equal(ev(openCount), 9);
  writeFileSync(file, LONG.replace("## Context", "## Background") + "\nOne more line.\n");
  await waitFor("same headings, new text", `document.querySelector("#background")?.textContent.includes("One more line.")`, 15000);
  assert.equal(ev(openCount), 9, "same headings: the open state is kept");
  key("Escape");
  await waitFor("list", listOpen);
  writePlans({ "a.md": [SHORT_A, 3 * 3600_000], "d.md": ["# Brand new\n\n## Only\n\nx\n", 1000] });
  await waitFor("list refreshed", `document.querySelectorAll(".overlay.plans .hist-row[data-i]").length === 2 && document.querySelector(".overlay.plans .hist-text").textContent === "Brand new"`, 15000);
  key("Escape");
});

gui("screenshots: the list and the long plan at 1440x900", async () => {
  await reopen("document.getElementById('empty') && !document.getElementById('empty').hidden");
  key("p");
  await waitFor("list", `document.querySelectorAll(".overlay.plans .hist-row").length === 3`);
  key("j");
  ab("screenshot", join(SHOTS, "PL2b-list.png"));
  key("Enter");
  await waitFor("long plan", `document.querySelectorAll("#background details.plan-sec").length === 9`);
  ab("screenshot", join(SHOTS, "PL2b-plan.png"));
  key("Escape");
  key("Escape");
});
