// The settings page (/settings) and what the settings do in the main GUI: language, theme, hint line, plan auto-show, the `,` key,
// repository colours, browser notifications. A real server (temp HOME) and a real browser (agent-browser). Skipped when agent-browser is not on PATH.
import { after, before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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

gui("the page renders in en and ja; the language select re-renders it and saves", async () => {
  await openSettings();
  assert.equal(ev<string>("document.documentElement.dataset.lang"), "en");
  assert.equal(text("#set-title"), "Settings");
  assert.equal(ev<string>("document.title"), "ukagai · Settings");
  assert.deepEqual(ev<string[]>(`JSON.stringify([...document.querySelectorAll("#form legend")].map((l) => l.textContent))`), ["Display", "Progress checkpoints (recap)", "Plans", "Notifications"]);
  assert.equal(text("#back"), "← Back");
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
