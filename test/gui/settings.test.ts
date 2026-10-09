// The settings page (/settings) and what the settings do in the main GUI: language, theme, hint line, plan auto-show, the `,` key,
// repository colours, browser notifications. A real server (temp HOME) and a real browser (agent-browser). Skipped when agent-browser is not on PATH.
import { after, before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SETTINGS, type Settings } from "../../src/contract.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HAS_BROWSER = spawnSync("agent-browser", ["--version"], { stdio: "ignore" }).status === 0;

let home = "";
let dataDir = "";
let port = 0;
let token = "";
let serve: ChildProcess | undefined;
let base = "";
let opened = false;
let seq = 0;
const session = `ukagai-settings-${process.pid}-${Date.now().toString(36)}`;
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

async function waitFor(what: string, js: string, ms = 20000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    let ok = false;
    try { ok = ev(`!!(${js})`) === true; } catch {}
    if (ok) return;
    assert.ok(Date.now() < end, `condition not met in time: ${what}`);
    await sleep(100);
  }
}

async function api(path: string, body?: unknown, method?: string) {
  const go = () => fetch(base + path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await go().catch(() => go());
  return res.json() as Promise<any>;
}

const getSettings = (): Promise<Settings> => api("/api/settings");
const putSettings = (f: (s: Settings) => void = () => {}) => {
  // The light theme unless a test says otherwise: the browser's own scheme would move every colour under the assertions
  const s = structuredClone({ ...DEFAULT_SETTINGS, theme: "light" as const });
  f(s);
  return api("/api/settings", s, "PUT");
};
/** A character key as a real KeyboardEvent on the document */
const key = (k: string) => ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true })), "ok"`);
/** Set a control's value and fire the events a user's change fires */
const setControl = (sel: string, v: string, ...events: string[]) =>
  ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(v)}; for (const t of ${JSON.stringify(events)}) e.dispatchEvent(new Event(t, { bubbles: true })); return "ok"; })()`);
const clickEl = (sel: string) => ev(`(document.querySelector(${JSON.stringify(sel)}).click(), "ok")`);
const text = (sel: string): string => String(ev(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`));

async function cancelAll() {
  const list = (await api("/api/decisions?status=pending")) as { id: string }[];
  for (const d of list) await api(`/api/decisions/${d.id}/cancel`, {});
}

const transcript = () => join(home, ".claude", "projects", "p", "none.jsonl");
async function seedQuestion(cwd = ROOT): Promise<{ id: string }> {
  const n = ++seq;
  const q = `Settings check ${n}: A, B or C?`;
  const d = await api("/api/decisions", {
    tool_use_id: `toolu_set_${process.pid}_${n}`,
    kind: "answer_question",
    session: { session_id: `00000000-0000-0000-0007-${String(n).padStart(12, "0")}`, cwd, transcript_path: transcript() },
    request: { questions: [{ question: q, header: "Check", multiSelect: false, options: [{ label: "A", description: "About A" }, { label: "B (Recommended)", description: "About B" }, { label: "C", description: "About C" }] }] },
  });
  assert.ok(d.id, `cannot create decision: ${JSON.stringify(d)}`);
  return { id: d.id };
}


/** A live session whose transcript carries `slug`: a plan file `<slug>.md` pops up only when its session is known */
async function planSession(slug: string): Promise<void> {
  const tpath = join(home, ".claude", "projects", "p", `${slug}.jsonl`);
  mkdirSync(join(home, ".claude", "projects", "p"), { recursive: true });
  writeFileSync(tpath, `{"type":"user","slug":"${slug}"}\n`);
  await fetch(base + "/api/events", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ session_id: `s-${slug}`, transcript_path: tpath, cwd: ROOT, hook_event_name: "Stop", received_at: new Date().toISOString() }),
  });
}

const PLANS = () => join(home, ".claude", "plans");
function writePlan(name: string, body: string) {
  mkdirSync(PLANS(), { recursive: true });
  writeFileSync(join(PLANS(), name), body);
  const t = new Date();
  utimesSync(join(PLANS(), name), t, t);
}
function cleanPlans() {
  mkdirSync(PLANS(), { recursive: true });
  for (const f of readdirSync(PLANS())) rmSync(join(PLANS(), f), { force: true });
}

const MAIN_READY = "document.querySelector('#decision .opt, #decision .btn')";
const IDLE = "document.getElementById('empty') && !document.getElementById('empty').hidden";
const SET_READY = "document.querySelector('#form fieldset')";
async function openMain(ready = MAIN_READY) {
  ab("open", base + "/");
  await waitFor("main screen", ready);
}
async function openSettings() {
  ab("open", base + "/settings");
  await waitFor("settings page", SET_READY);
}

before(async () => {
  if (!HAS_BROWSER) return;
  home = mkdtempSync(join(tmpdir(), "ukagai-settings-"));
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
  ab("open", base + "/settings", "--viewport", "1280x800");
  opened = true;
});

after(async () => {
  if (opened) { try { ab("close"); } catch {} }
  serve?.kill();
  if (home) rmSync(home, { recursive: true, force: true });
});

function gui(name: string, fn: (t: TestContext) => Promise<void>) {
  test(`GUI settings: ${name}`, { skip: HAS_BROWSER ? false : "agent-browser is not installed" }, async (t) => {
    await cancelAll();
    cleanPlans();
    await putSettings();
    try { await fn(t); } finally { await cancelAll(); cleanPlans(); await putSettings(); }
  });
}

const PANE_IDS = ["general", "notifications", "plans", "checkpoints", "skill"];
const FIELDSET_PANE: Record<string, string> = { general: "Display", notifications: "Notifications", plans: "Plans", checkpoints: "Progress checkpoints (recap)" };
/** Which panes are visible: the visible fieldset legends plus whether the skill section shows */
const visiblePane = () => ev<{ legends: string[]; skill: boolean; hash: string; current: string | null }>(`JSON.stringify({
  legends: [...document.querySelectorAll("#form fieldset")].filter((f) => !f.hidden).map((f) => f.querySelector("legend").textContent),
  skill: !document.getElementById("pane-skill").hidden,
  hash: location.hash,
  current: document.querySelector('#set-nav [aria-current="page"]')?.dataset.pane ?? null,
})`);

gui("the sidebar: items in order, each with a Lucide icon; clicking one shows only its pane and sets the hash", async () => {
  await openSettings();
  assert.deepEqual(ev<string[]>(`JSON.stringify([...document.querySelectorAll("#set-nav .set-nav-item")].map((a) => a.dataset.pane))`), PANE_IDS);
  assert.deepEqual(ev<string[]>(`JSON.stringify([...document.querySelectorAll("#set-nav .set-nav-item")].map((a) => a.textContent))`), ["General", "Notifications", "Plans", "Progress checkpoints", "Skill"]);
  assert.equal(text("#set-nav .set-nav-group"), "Agent");
  assert.deepEqual(ev<string[]>(`JSON.stringify([...document.querySelectorAll("#set-nav .set-nav-item")].map((a) => a.querySelector("svg")?.dataset.icon))`), ["settings", "bell", "file-text", "clock", "book-open"]);
  assert.equal(ev<string>(`document.querySelector("#back svg")?.dataset.icon`), "chevron-left");
  // General is the default pane, and the other fieldsets stay in the DOM
  assert.deepEqual(visiblePane(), { legends: ["Display"], skill: false, hash: "", current: "general" });
  assert.equal(ev<number>(`document.querySelectorAll("#form fieldset").length`), 4);
  for (const id of PANE_IDS) {
    clickEl(`#set-nav [data-pane="${id}"]`);
    await waitFor(`hash #${id}`, `location.hash === "#${id}"`);
    assert.deepEqual(visiblePane(), { legends: id === "skill" ? [] : [FIELDSET_PANE[id]!], skill: id === "skill", hash: `#${id}`, current: id });
    assert.ok(text("#pane-title") !== "" || id === "skill");
  }
  // The pane survives a re-render (a save re-renders #form)
  clickEl(`#set-nav [data-pane="plans"]`);
  await waitFor("plans pane", `location.hash === "#plans"`);
  clickEl("#opt-0");
  await waitFor("saved", `document.querySelector("#status").textContent === "Saved"`);
  assert.deepEqual(visiblePane().legends, ["Plans"]);
});

gui("/settings#skill opens the Skill pane, a reload keeps it, and an unknown hash falls back to General", async () => {
  ab("open", base + "/settings#skill");
  await waitFor("settings page", SET_READY);
  assert.deepEqual(visiblePane(), { legends: [], skill: true, hash: "#skill", current: "skill" });
  assert.equal(text("#skill-title"), "Skill");
  ab("reload");
  await waitFor("settings page after reload", SET_READY);
  assert.deepEqual(visiblePane(), { legends: [], skill: true, hash: "#skill", current: "skill" });
  ab("open", base + "/settings#nope");
  await waitFor("settings page", SET_READY);
  assert.deepEqual(visiblePane(), { legends: ["Display"], skill: false, hash: "#nope", current: "general" });
  // Back/forward (hashchange) follows too
  ev(`(location.hash = "#checkpoints", "ok")`);
  await waitFor("checkpoints pane", `document.querySelector('#set-nav [aria-current="page"]')?.dataset.pane === "checkpoints"`);
  assert.deepEqual(visiblePane().legends, ["Progress checkpoints (recap)"]);
  ab("open", base + "/settings");
});

// ---- the Skill pane ----
const SKILL_FILE = () => join(dataDir, "skill", "SKILL.md");
const SKILL_READY = `(() => { const a = document.getElementById("skill-text"); return !!a && !a.disabled && a.value.length > 0; })()`;
async function openSkill() {
  ab("open", base + "/settings#skill");
  await waitFor("skill pane loaded", SKILL_READY);
}
/** Type into the editor the way a user does: set the value and fire `input` */
const typeSkill = (v: string) => setControl("#skill-text", v, "input");
const skillVisible = (sel: string) => ev<boolean>(`!document.querySelector(${JSON.stringify(sel)}).hidden`);
/** Leave no draft and no saved version behind: a dirty page would stop the next navigation with a beforeunload prompt */
async function cleanSkill() {
  try { ev(`(document.getElementById("skill-discard")?.click(), "ok")`); } catch {}
  await api("/api/skill", undefined, "DELETE");
}

gui("Skill pane: edit and save writes <data-dir>/skill/SKILL.md; the unsaved indicator appears and clears; the badge shows; Ctrl+S saves too", async () => {
  try {
    await openSkill();
    assert.equal(skillVisible("#skill-unsaved"), false);
    assert.equal(skillVisible("#skill-badge"), false);
    assert.equal(ev<boolean>(`document.getElementById("skill-save").disabled`), true);
    const def = ev<string>(`document.getElementById("skill-text").value`);
    assert.match(def, /ukagai-explain/);
    typeSkill(def + "\nExtra line from the test.\n");
    assert.equal(skillVisible("#skill-unsaved"), true);
    assert.equal(text("#skill-unsaved"), "Unsaved changes");
    clickEl("#skill-save");
    await waitFor("file written", `!document.getElementById("skill-save") || document.getElementById("skill-unsaved").hidden`);
    assert.equal(readFileSync(SKILL_FILE(), "utf8"), def + "\nExtra line from the test.\n");
    assert.equal(skillVisible("#skill-badge"), true);
    assert.match(text("#skill-badge"), /^Changed from default · \d+ lines$/);
    assert.match(text("#skill-file"), /SKILL\.md/);
    assert.match(text("#skill-file"), /Last saved/);
    // Ctrl+S saves while the pane is shown (and the browser's own save is prevented)
    typeSkill(def + "\nSecond edit.\n");
    const prevented = ev<boolean>(`(() => { const e = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true }); document.dispatchEvent(e); return e.defaultPrevented; })()`);
    assert.equal(prevented, true);
    await waitFor("second save", `document.getElementById("skill-unsaved").hidden`);
    assert.equal(readFileSync(SKILL_FILE(), "utf8"), def + "\nSecond edit.\n");
    // Discard restores the last loaded text
    typeSkill("scribble");
    assert.equal(skillVisible("#skill-unsaved"), true);
    clickEl("#skill-discard");
    assert.equal(ev<string>(`document.getElementById("skill-text").value`), def + "\nSecond edit.\n");
    assert.equal(skillVisible("#skill-unsaved"), false);
    // an empty text is refused by the server and kept as a draft
    typeSkill("   ");
    clickEl("#skill-save");
    await waitFor("save error", `document.getElementById("skill-error").textContent !== ""`);
    assert.equal(readFileSync(SKILL_FILE(), "utf8"), def + "\nSecond edit.\n");
  } finally { await cleanSkill(); }
});

gui("Skill pane: Reset to default asks twice, then removes <data-dir>/skill/", async () => {
  try {
    await openSkill();
    assert.equal(ev<boolean>(`document.getElementById("skill-reset").disabled`), true, "nothing to reset yet");
    const def = ev<string>(`document.getElementById("skill-text").value`);
    typeSkill(def + "\nmine\n");
    clickEl("#skill-save");
    await waitFor("saved", `document.getElementById("skill-unsaved").hidden && !document.getElementById("skill-badge").hidden`);
    assert.ok(existsSync(SKILL_FILE()));
    clickEl("#skill-reset");
    assert.equal(text("#skill-reset-label"), "Click again to reset");
    assert.ok(existsSync(SKILL_FILE()), "one click does not reset");
    clickEl("#skill-reset");
    await waitFor("reset", `document.getElementById("skill-badge").hidden`);
    assert.equal(existsSync(join(dataDir, "skill")), false);
    assert.equal(ev<string>(`document.getElementById("skill-text").value`), def);
    assert.equal(text("#skill-reset-label"), "Reset to default");
  } finally { await cleanSkill(); }
});

gui("Skill pane: a settings change from another client (theme, SSE settings.updated) does not touch the draft", async () => {
  try {
    await openSkill();
    typeSkill("a draft the test typed");
    await putSettings((s) => { s.theme = "dark"; });
    await waitFor("dark theme applied", `document.documentElement.dataset.theme === "dark"`);
    assert.equal(ev<string>(`document.getElementById("skill-text").value`), "a draft the test typed");
    assert.equal(skillVisible("#skill-unsaved"), true);
    // the form was rebuilt meanwhile and the pane is still the Skill one
    assert.equal(ev<string>("location.hash"), "#skill");
  } finally { await cleanSkill(); }
});

gui("Skill pane: a PUT /api/skill from another client reloads a clean editor; a dirty draft stays and offers 'Load it'", async () => {
  try {
    await openSkill();
    const r1 = await api("/api/skill", { text: "saved elsewhere 1\n" }, "PUT");
    assert.equal(r1.custom, "saved elsewhere 1\n");
    await waitFor("clean editor follows", `document.getElementById("skill-text").value === ${JSON.stringify("saved elsewhere 1\n")}`);
    assert.equal(skillVisible("#skill-badge"), true);
    typeSkill("my unsaved draft");
    await api("/api/skill", { text: "saved elsewhere 2\n" }, "PUT");
    await waitFor("newer notice", `!document.getElementById("skill-newer").hidden`);
    assert.equal(ev<string>(`document.getElementById("skill-text").value`), "my unsaved draft");
    clickEl("#skill-load-newer");
    assert.equal(ev<string>(`document.getElementById("skill-text").value`), "saved elsewhere 2\n");
    assert.equal(skillVisible("#skill-unsaved"), false);
    assert.equal(skillVisible("#skill-newer"), false);
    // a reset from elsewhere brings the default back
    await api("/api/skill", undefined, "DELETE");
    await waitFor("default again", `document.getElementById("skill-badge").hidden && /ukagai-explain/.test(document.getElementById("skill-text").value)`);
  } finally { await cleanSkill(); }
});

gui("Skill pane: tabs have tab semantics and arrow keys; Preview renders a heading and drops images; Diff shows the saved diff", async () => {
  try {
    await openSkill();
    assert.equal(ev<string>(`document.getElementById("skill-tabs").getAttribute("role")`), "tablist");
    assert.deepEqual(ev<string[]>(`JSON.stringify([...document.querySelectorAll("#skill-tabs [role=tab]")].map((b) => b.getAttribute("aria-selected") + ":" + b.dataset.icon + ":" + b.querySelector("svg").dataset.icon))`), ["true:undefined:square-pen", "false:undefined:eye", "false:undefined:git-compare"]);
    ev(`document.getElementById("skill-tab-edit").focus(), "ok"`);
    // arrow keys act on the focused tab: dispatch on it
    ev(`(document.getElementById("skill-tab-edit").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })), "ok")`);
    await waitFor("preview tab", `document.getElementById("skill-tab-preview").getAttribute("aria-selected") === "true"`);
    assert.equal(skillVisible("#skill-view-preview"), true);
    assert.equal(skillVisible("#skill-view-edit"), false);
    assert.equal(ev<boolean>(`document.activeElement === document.getElementById("skill-tab-preview")`), true);
    // switch back, type markdown, preview it
    clickEl("#skill-tab-edit");
    typeSkill("# Heading from the test\n\nSome **bold** text ![pic](http://example.invalid/x.png) and <script>window.__x = 1</script>\n");
    clickEl("#skill-tab-preview");
    assert.equal(text("#skill-view-preview h1"), "Heading from the test");
    assert.equal(ev<number>(`document.querySelectorAll("#skill-view-preview img").length`), 0);
    assert.equal(ev<number>(`document.querySelectorAll("#skill-view-preview script").length`), 0);
    assert.equal(ev<boolean>(`window.__x === undefined`), true);
    // Diff: nothing saved, no difference; after a save the changed lines show
    clickEl("#skill-tab-diff");
    assert.match(text("#skill-diff"), /No difference/);
    assert.ok(text("#skill-diff-note").length > 0);
    clickEl("#skill-save");
    await waitFor("saved", `document.getElementById("skill-unsaved").hidden && !document.getElementById("skill-badge").hidden`);
    assert.equal(ev<number>(`document.querySelectorAll("#skill-diff .set-diff-add").length`) > 0, true);
    assert.equal(ev<number>(`document.querySelectorAll("#skill-diff .set-diff-del").length`) > 0, true);
  } finally { await cleanSkill(); }
});

gui("Skill pane in ja: labels, badge and the reset confirmation are Japanese", async () => {
  try {
    await putSettings((s) => { s.lang = "ja"; });
    await openSkill();
    assert.equal(text("#skill-title"), "スキル");
    assert.equal(text("#skill-tab-edit"), "編集");
    assert.equal(text("#skill-save"), "保存");
    typeSkill("日本語の版\n");
    assert.equal(text("#skill-unsaved"), "保存していない変更があります");
    clickEl("#skill-save");
    await waitFor("saved", `document.getElementById("skill-unsaved").hidden && !document.getElementById("skill-badge").hidden`);
    assert.match(text("#skill-badge"), /^既定から変更あり · \d+ 行$/);
    clickEl("#skill-reset");
    assert.equal(text("#skill-reset-label"), "もう一度押すと既定に戻します");
  } finally { await cleanSkill(); await putSettings(); }
});

gui("the page renders in en and ja; the language select re-renders it and saves", async () => {
  await openSettings();
  assert.equal(ev<string>("document.documentElement.dataset.lang"), "en");
  assert.equal(text("#set-title"), "Settings");
  assert.equal(ev<string>("document.title"), "ukagai · Settings");
  assert.deepEqual(ev<string[]>(`JSON.stringify([...document.querySelectorAll("#form legend")].map((l) => l.textContent))`), ["Display", "Progress checkpoints (recap)", "Plans", "Notifications"]);
  assert.equal(text("#back"), "Back");
  assert.equal(ev<string>(`document.querySelector("#back").getAttribute("href")`), "/");
  setControl("#lang", "ja", "change");
  await waitFor("page in ja", `document.querySelector("#set-title").textContent === "設定"`);
  assert.equal(ev<string>("document.documentElement.dataset.lang"), "ja");
  assert.equal(ev<string>("document.documentElement.lang"), "ja");
  assert.deepEqual(ev<string[]>(`JSON.stringify([...document.querySelectorAll("#form legend")].map((l) => l.textContent))`), ["表示", "進捗チェック(recap)", "プラン", "通知"]);
  await waitFor("saved", `(async () => 1)() && document.querySelector("#status").textContent === "保存しました"`);
  assert.equal((await getSettings()).lang, "ja");
  // The server renders the next load in ja from the start, and the main GUI follows
  ab("open", base + "/settings");
  await waitFor("ja on reload", `document.documentElement.dataset.lang === "ja" && document.querySelector("#set-title")?.textContent === "設定"`);
  await openMain(IDLE);
  assert.equal(ev<string>("document.documentElement.dataset.lang"), "ja");
  assert.equal(text("#settings-link span"), "設定");
  await putSettings();
  await waitFor("main back to en", `document.documentElement.dataset.lang === "en"`);
});

gui("theme: dark / light / system set data-theme on both pages and the colours follow", async () => {
  await seedQuestion();
  await openSettings();
  const bg = () => ev<string>("getComputedStyle(document.body).backgroundColor");
  setControl("#theme", "dark", "change");
  await waitFor("dark applied at once", `document.documentElement.dataset.theme === "dark"`);
  assert.equal(bg(), "rgb(23, 23, 26)");
  await waitFor("saved", `document.querySelector("#status").textContent === "Saved"`);
  assert.equal((await getSettings()).theme, "dark");
  await openMain();
  assert.equal(ev<string>("document.documentElement.dataset.theme"), "dark");
  assert.equal(bg(), "rgb(23, 23, 26)");
  // Changed from the settings API while the main page is open: it follows live
  await putSettings((s) => (s.theme = "light"));
  await waitFor("light live", `document.documentElement.dataset.theme === "light"`);
  assert.equal(bg(), "rgb(250, 250, 250)");
  await openSettings();
  assert.equal(ev<string>("document.documentElement.dataset.theme"), "light");
  assert.equal(bg(), "rgb(250, 250, 250)");
  setControl("#theme", "system", "change");
  await waitFor("system: no data-theme", `document.documentElement.dataset.theme === undefined`);
});

gui("hints=false hides the hint line of the main GUI (live and after a reload)", async () => {
  await seedQuestion();
  await openMain();
  const hintShown = () => ev<boolean>(`!document.getElementById("foot").hidden && getComputedStyle(document.getElementById("foot")).display !== "none"`);
  assert.equal(hintShown(), true);
  await putSettings((s) => (s.hints = false));
  await waitFor("hint hidden live", `getComputedStyle(document.getElementById("foot")).display === "none"`);
  ab("reload");
  await waitFor("main screen", MAIN_READY);
  assert.equal(hintShown(), false);
  await putSettings();
  await waitFor("hint back", `getComputedStyle(document.getElementById("foot")).display !== "none"`);
});

gui("the hint line lists `, Settings` (en and ja)", async () => {
  await seedQuestion();
  await openMain();
  assert.match(ev<string>(`document.querySelector("#foot .hint-full").textContent`), /, Settings/);
  await putSettings((s) => (s.lang = "ja"));
  await waitFor("ja", `document.documentElement.dataset.lang === "ja"`);
  assert.match(ev<string>(`document.querySelector("#foot .hint-full").textContent`), /, 設定/);
});

gui("plans.auto_show=false keeps a new plan out of Pending (still in the drawer list); on again shows it", async () => {
  await putSettings((s) => (s.plans.auto_show = false));
  await openMain(IDLE);
  await planSession("quiet-plan");
  writePlan("quiet-plan.md", "# Quiet plan\n\n## One\n\nText.\n");
  await sleep(2500);
  assert.equal(ev<boolean>(`document.getElementById("empty").hidden`), false, "the plan did not take the screen");
  assert.equal(ev<boolean>(`document.getElementById("head").hidden`), true);
  assert.equal(ev<string>("document.title"), "ukagai", "and it is not counted");
  // A question arrives: Pending counts it, not the plan; the drawer lists both
  await seedQuestion();
  await waitFor("question shown", MAIN_READY);
  assert.equal(text("#pending-count"), "1");
  assert.equal(ev<string>("document.title"), "(1) ukagai");
  key("b");
  await waitFor("drawer lists the plan", `document.querySelector("#pending-list .plan-row")`);
  assert.equal(ev<number>(`document.querySelectorAll("#pending-list .row").length`), 2);
  key("Escape");
  await cancelAll();
  await waitFor("idle again", IDLE);
  assert.equal(ev<boolean>(`document.getElementById("empty").hidden`), false);
  await putSettings();
  await waitFor("the plan takes the screen once auto-show is on", `document.querySelector("#head .hd-ctx")?.textContent.includes("updated") && document.querySelector("#background .md")`);
});

gui("title_badge=false keeps the (N) count out of the tab title", async () => {
  await seedQuestion();
  await openMain();
  assert.equal(ev<string>("document.title"), "(1) ukagai");
  await putSettings((s) => (s.notify.title_badge = false));
  await waitFor("no badge", `document.title === "ukagai"`);
});

gui("the `,` key opens /settings; Esc there goes back; the header carries a Settings link", async () => {
  await seedQuestion();
  await openMain();
  assert.equal(ev<string>(`document.querySelector("#head .hd-meta #settings-link").getAttribute("href")`), "/settings");
  assert.equal(text("#head .hd-meta #settings-link"), "Settings");
  key(",");
  await waitFor("settings page", `location.pathname === "/settings" && document.querySelector("#form fieldset")`);
  key("Escape");
  await waitFor("back on /", `location.pathname === "/"`);
  // Typing a comma in a text box is text, not navigation
  ab("open", base + "/");
  await waitFor("screen", MAIN_READY);
  assert.equal(ev<string>(`(() => { const t = document.createElement("input"); t.type = "text"; document.body.append(t); t.focus(); t.dispatchEvent(new KeyboardEvent("keydown", { key: ",", bubbles: true, cancelable: true })); t.remove(); return location.pathname; })()`), "/");
});

gui("a change made elsewhere (the API) shows on an open settings page", async () => {
  await openSettings();
  assert.equal(ev<boolean>(`document.querySelector("#opt-0").checked`), true); // hints
  await putSettings((s) => (s.hints = false));
  await waitFor("page follows", `document.querySelector("#opt-0").checked === false`);
});

gui("invalid input shows an inline message and saves nothing (delay out of range)", async () => {
  await openSettings();
  setControl("#cp-delay", "5", "change");
  await waitFor("inline error", `document.querySelector("#cp-delay").closest(".set-row").querySelector(".set-err").textContent === "Enter a whole number from 30 to 3600"`);
  assert.equal((await getSettings()).checkpoints.codex_delay_s, 180);
  setControl("#cp-delay", "45", "change");
  await waitFor("saved", `document.querySelector("#status").textContent === "Saved"`);
  assert.equal((await getSettings()).checkpoints.codex_delay_s, 45);
  assert.equal(text("#cp-delay ~ .set-err"), "");
  // The checkbox toggles of the checkpoints group save too
  clickEl("#opt-1"); // "Create progress checkpoints"
  await waitFor("enabled saved", `document.querySelector("#status").textContent === "Saved"`);
  assert.equal((await getSettings()).checkpoints.enabled, false);
});

gui("browser notifications: the permission state is shown and a denied permission keeps the toggle off", async () => {
  await openSettings();
  const state = () => text("#perm-state")!;
  assert.match(state(), /Permission: (granted|denied|not asked yet)|no Notification API/);
  // Stand in for the browser's answer: denied
  ev(`(() => { class N { static permission = "default"; static async requestPermission() { N.permission = "denied"; return "denied"; } } window.Notification = N; return "ok"; })()`);
  const box = `document.querySelector("#perm-state").closest(".set-row").querySelector("input")`;
  ev(`(${box}.click(), "ok")`);
  await waitFor("denied message", `document.querySelector("#perm-state").textContent.startsWith("Permission: denied")`);
  assert.equal(ev<boolean>(`${box}.checked`), false, "the toggle stays off");
  assert.equal((await getSettings()).notify.browser, false);
  assert.match(ev<string>(`${box}.closest(".set-row").querySelector(".set-err").textContent`), /^Permission: denied/);
  // Granted: the toggle saves
  ev(`(() => { class N { static permission = "default"; static async requestPermission() { N.permission = "granted"; return "granted"; } } window.Notification = N; return "ok"; })()`);
  ev(`(${box}.click(), "ok")`);
  await waitFor("browser on saved", `document.querySelector("#status").textContent === "Saved"`);
  assert.equal((await getSettings()).notify.browser, true);
  assert.equal(ev<boolean>(`${box}.checked`), true);
});

gui("a new decision fires a browser notification only while the tab is hidden, and a beep only while it is not focused", async () => {
  await putSettings((s) => ((s.notify.browser = true), (s.notify.sound = true)));
  await openMain(IDLE);
  ev(`(() => {
    window.__notes = [];
    class N { static permission = "granted"; constructor(title, o) { window.__notes.push([title, o && o.body]); } close() {} }
    window.Notification = N;
    // A recording AudioContext: starts suspended like a real one made without a gesture; the beep body runs against it
    window.__audio = { made: 0, resumed: 0, calls: [] };
    window.AudioContext = class {
      constructor() { window.__audio.made++; this.state = "suspended"; this.currentTime = 1; this.destination = {}; }
      resume() { window.__audio.resumed++; this.state = "running"; return Promise.resolve(); }
      createOscillator() { window.__audio.calls.push("createOscillator"); const self = { frequency: {}, connect(x) { return x; }, start() { window.__audio.calls.push("start"); }, stop() { window.__audio.calls.push("stop"); } }; return self; }
      createGain() { window.__audio.calls.push("createGain"); return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect(x) { return x; } }; }
    };
    Object.defineProperty(document, "hidden", { configurable: true, get: () => window.__hidden === true });
    document.hasFocus = () => window.__focus === true;
    return "ok";
  })()`);
  // In front and focused: nothing
  ev(`(window.__hidden = false, window.__focus = true, "ok")`);
  await seedQuestion();
  await waitFor("shown", MAIN_READY);
  assert.deepEqual(ev(`JSON.stringify([window.__notes.length, window.__audio.calls.length])`), [0, 0]);
  await cancelAll();
  await waitFor("idle", IDLE);
  // Hidden and unfocused: both fire
  ev(`(window.__hidden = true, window.__focus = false, "ok")`);
  // The first key or click creates / resumes the one shared context (the toggle is on)
  key("Shift");
  assert.deepEqual(ev(`JSON.stringify([window.__audio.made, window.__audio.resumed])`), [1, 1]);
  await seedQuestion();
  await waitFor("notified", `window.__notes.length === 1 && window.__audio.calls.includes("stop")`);
  assert.deepEqual(ev(`JSON.stringify(window.__audio.calls)`), ["createOscillator", "createGain", "start", "stop"]);
  assert.equal(ev<number>(`window.__audio.made`), 1, "the beep reused the shared context");
  assert.match(ev<string>(`window.__notes[0][0]`), /^ukagai · .*Question$/);
  assert.match(ev<string>(`window.__notes[0][1]`), /^Settings check/);
});

const hljsMedia = () => ev<Record<string, string>>(`JSON.stringify(Object.fromEntries([...document.querySelectorAll("link[data-hljs]")].map((l) => [l.dataset.hljs, l.media])))`);

gui("the highlight.js stylesheet follows the theme live: dark, light, system, with the page open", async () => {
  await putSettings((s) => (s.theme = "system"));
  await openMain(IDLE);
  assert.deepEqual(hljsMedia(), { light: "(prefers-color-scheme: light)", dark: "(prefers-color-scheme: dark)" });
  await putSettings((s) => (s.theme = "dark"));
  await waitFor("dark pinned", `document.querySelector('link[data-hljs="dark"]').media === "all"`);
  assert.deepEqual(hljsMedia(), { light: "not all", dark: "all" });
  await putSettings((s) => (s.theme = "light"));
  await waitFor("light pinned", `document.querySelector('link[data-hljs="light"]').media === "all"`);
  assert.deepEqual(hljsMedia(), { light: "all", dark: "not all" });
  await putSettings((s) => (s.theme = "system"));
  await waitFor("system restored", `document.querySelector('link[data-hljs="dark"]').media === "(prefers-color-scheme: dark)"`);
  assert.deepEqual(hljsMedia(), { light: "(prefers-color-scheme: light)", dark: "(prefers-color-scheme: dark)" });
});

gui("theme system follows an emulated dark OS (and light again)", async () => {
  try {
    ab("set", "media", "dark");
    await putSettings((s) => (s.theme = "system"));
    await openMain(IDLE);
    assert.equal(ev<string>("getComputedStyle(document.body).backgroundColor"), "rgb(23, 23, 26)");
    assert.equal(ev<boolean>(`document.documentElement.dataset.theme === undefined`), true);
    await openSettings();
    assert.equal(ev<string>("getComputedStyle(document.body).backgroundColor"), "rgb(23, 23, 26)");
    ab("set", "media", "light");
    await waitFor("light OS", `getComputedStyle(document.body).backgroundColor === "rgb(250, 250, 250)"`);
  } finally {
    ab("set", "media", "light");
  }
});

gui("plans.auto_show=false: a lone waiting plan keeps the Pending button; an arriving approval for a plan shows as the decision, once", async () => {
  await putSettings((s) => (s.plans.auto_show = false));
  await openMain(IDLE);
  writePlan("solo.md", "# Solo plan\n\n## One\n\nText.\n");
  await waitFor("pending button for the plan", `!document.getElementById("pending-btn").hidden && document.getElementById("pending-btn").getBoundingClientRect().width > 0`);
  assert.equal(ev<boolean>(`document.getElementById("empty").hidden`), false, "still no pop-up");
  // An approval for that plan arrives: it is a decision, shown at once; the plan is not a second row
  const n = ++seq;
  const d = await api("/api/decisions", {
    tool_use_id: `toolu_set_ap_${process.pid}_${n}`, kind: "approve_plan",
    session: { session_id: `00000000-0000-0000-0008-${String(n).padStart(12, "0")}`, cwd: ROOT, transcript_path: transcript() },
    request: { plan: "# Solo plan\n\n## One\n\nText.\n", planFilePath: join(PLANS(), "solo.md") },
  });
  assert.ok(d.id);
  await waitFor("approval on screen", `document.querySelector("#decision .btn, #decision .approve, #decision button")`);
  assert.equal(ev<string>("document.title"), "(1) ukagai");
  key("b");
  await waitFor("drawer", `document.querySelector("#pending-list .row")`);
  assert.equal(ev<number>(`document.querySelectorAll("#pending-list .row").length`), 1, "the plan is one item with its approval");
  assert.equal(ev<number>(`document.querySelectorAll("#pending-list .plan-row").length`), 0);
});
