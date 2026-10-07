// Plan versions in the real GUI: the approval card (the Instruct box is always there like a question's free-text card and takes the
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
const FILL = "- filler line 1\n- filler line 2\n- filler line 3\n- filler line 4\n- filler line 5\n- filler line 6\n- filler line 7\n- filler line 8\n- filler line 9\n- filler line 10\n- filler line 11\n- filler line 12\n- filler line 13\n- filler line 14\n- filler line 15\n- filler line 16\n- filler line 17\n- filler line 18\n- filler line 19\n- filler line 20\n- filler line 21\n- filler line 22\n- filler line 23\n- filler line 24\n- filler line 25\n- filler line 26\n- filler line 27\n- filler line 28\n- filler line 29\n- filler line 30";
const mk = (goal: string, extra: string) => `# Export retry\n\n## Goal\n\n${goal}\n\n## Steps\n\n- [ ] add retry\n- [ ] add backoff\n\n## Old\n\ngone soon\n\n## Notes\n\n${FILL}\n${extra}`;
const V1 = mk("Retry the export on failure.", "");
const V2 = mk("Retry the export on failure, with a cap.", "").replace("## Old\n\ngone soon\n\n", "") + "\n## Risks\n\nnone known\n";

let home = "";
let dataDir = "";
let port = 0;
let token = "";
let serve: ChildProcess | undefined;
let base = "";
let opened = false;
let seq = 0;
const session = `ukagai-plv-${process.pid}-${Date.now().toString(36)}`;
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
async function cancelAll() {
  for (const d of (await api("/api/decisions?status=pending")) as { id: string }[]) await api(`/api/decisions/${d.id}/cancel`, {});
}
async function reopen(ready: string) {
  ab("open", base + "/");
  await waitFor("screen render", ready);
}

before(async () => {
  if (!HAS_BROWSER) return;
  home = mkdtempSync(join(tmpdir(), "ukagai-plv-"));
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
  test(`GUI plan versions: ${name}`, { skip: HAS_BROWSER ? false : "agent-browser is not installed" }, async (t) => {
    await cancelAll();
    ab("set", "viewport", "1280", "800");
    try { await fn(t); } finally { await cancelAll(); }
  });
}


async function seed(sid: string, tool: string, plan: string): Promise<{ id: string }> {
  const d = await api("/api/decisions", {
    tool_use_id: `toolu_plv_${process.pid}_${++seq}_${tool}`,
    kind: "approve_plan",
    session: { session_id: sid, cwd: ROOT, transcript_path: join(home, ".claude", "projects", "p", `${sid}.jsonl`) },
    request: { plan, planFilePath: "/Users/someone/.claude/plans/export-retry.md" },
  });
  assert.ok(d.id, JSON.stringify(d));
  return { id: d.id };
}
const tabs = () => ev<string[]>(`JSON.stringify([...document.querySelectorAll("#background .ver-tab")].map(b => b.textContent))`);
const sel = () => String(ev(`document.querySelector("#background .ver-tab.sel")?.dataset.n ?? ""`));
const sum = () => ev<string>(`document.querySelector("#background .ver-sum")?.textContent ?? ""`);
const note = () => ev<string>(`document.querySelector("#background .ver-note")?.textContent ?? ""`);
const badges = () => ev<string[]>(`JSON.stringify([...document.querySelectorAll("#background .ver-badge")].map(b => b.closest(".ver-added, .ver-changed").classList.contains("ver-added") ? "added:" + b.textContent : "changed:" + b.textContent))`);
const heading = () => ev<string>(`document.querySelector("#head .v2-title")?.textContent ?? ""`);

gui("two versions: tabs, the summary line, badges, the struck old line and the highlighted new one; < shows v1 with the note, > comes back", async () => {
  const d1 = await seed("s-v", "1", V1);
  await api(`/api/decisions/${d1.id}/answer`, { instruct: true, text: "cap the retries" });
  await sleep(20);
  await seed("s-v", "2", V2);
  await reopen("document.querySelector('#background .ver-tab')");
  assert.deepEqual(await tabs(), ["v1", "v2"]);
  assert.equal(sel(), "2", "the current version is selected on show");
  assert.equal(sum(), "v1 → v2: 1 section added · 1 changed · 1 removed · Instruction: cap the retries");
  assert.deepEqual(await badges(), ["changed:Changed", "added:New"]);
  assert.equal(ev(`document.querySelectorAll("#background .ver-chg").length`), 1);
  assert.equal(ev(`document.querySelector("#background .ver-chg").textContent`), "Retry the export on failure, with a cap.");
  assert.equal(ev(`document.querySelector("#background .ver-chg").previousElementSibling.classList.contains("ver-old")`), true);
  assert.equal(ev(`getComputedStyle(document.querySelector("#background .ver-old s")).textDecorationLine`), "line-through");
  assert.equal(ev(`document.querySelector("#background .ver-old").textContent.replace(/^−/, "")`), "Retry the export on failure.");
  assert.equal(ev(`document.querySelector("#background details.ver-changed").open && document.querySelector("#background details.ver-added").open`), true, "new and changed sections start open");
  assert.equal(ev(`!!document.querySelector("#background details.plan-sec:not(.ver-added):not(.ver-changed) .ver-chg")`), false, "unchanged sections carry no marker");
  assert.equal(ev(`[...document.querySelectorAll("#background details.ver-added, #background details.ver-changed")].every((d) => parseFloat(getComputedStyle(d).borderLeftWidth) === 0 && !!d.querySelector(".ver-badge"))`), true, "new / changed sections have no left bar and keep their badge");
  assert.equal(ev(`document.querySelector("#foot .vh:not([hidden])")?.textContent`), "< > Version · ");
  key("<");
  await waitFor("v1 shown", `document.querySelector("#background .ver-tab.sel")?.dataset.n === "1"`);
  assert.equal(sum(), "v1: first version");
  assert.equal(note(), "Showing v1 (the decision is on v2)");
  assert.equal(ev(`!!document.querySelector("#background .ver-badge")`), false);
  assert.equal(ev(`document.querySelector("#background").textContent.includes("gone soon")`), true, "the removed section is visible in the earlier version");
  assert.equal(ev(`!!document.querySelector("#decision .btn")`), true, "the options stay for the current decision");
  key(">");
  await waitFor("v2 shown", `document.querySelector("#background .ver-tab.sel")?.dataset.n === "2"`);
  assert.equal(note(), "");
  ev(`document.querySelector('#background .ver-tab[data-n="1"]').click(), "ok"`);
  await waitFor("click shows v1", `document.querySelector("#background .ver-tab.sel")?.dataset.n === "1"`);
  // Japanese
  ev(`document.documentElement.dataset.lang = "ja", "ok"`);
  await waitFor("ja", `document.querySelector("#background .ver-note")?.textContent.includes("を表示中")`);
  assert.equal(note(), "v1 を表示中（承認対象は v2）");
  assert.deepEqual(await tabs(), ["v1", "v2"]);
  key(">");
  await waitFor("v2 in ja", `document.querySelector("#background .ver-sum")?.textContent.startsWith("v1 → v2")`);
  assert.equal(sum(), "v1 → v2: 1 節追加 · 1 節変更 · 1 節削除 · 指示: cap the retries");
  ev(`document.documentElement.dataset.lang = "en", "ok"`);
  key(">");
  await waitFor("v2 in en", `document.querySelector("#background .ver-tab.sel")?.dataset.n === "2"`);
  if (process.env.UKAGAI_SHOTS_DIR) { ev(`document.documentElement.dataset.theme = "light", "ok"`); ab("set", "viewport", "1100", "800"); ab("screenshot", join(SHOTS, "sections.png")); }
});

gui("the selected version tab is inverted (background --fg, text --panel, weight 600) in light and dark; the other tab is outlined", async () => {
  const d1 = await seed("s-inv", "1", V1);
  await api(`/api/decisions/${d1.id}/answer`, { instruct: true, text: "cap the retries" });
  await sleep(20);
  await seed("s-inv", "2", V2);
  await reopen("document.querySelector('#background .ver-tab')");
  const probe = (theme: string, n: string) => ev<{ bg: string; fg: string; w: string; fgVar: string; panelVar: string; otherBg: string }>(`(() => {
    document.documentElement.dataset.theme = ${JSON.stringify(theme)};
    const col = (v) => { const p = document.createElement("i"); p.style.background = "var(" + v + ")"; document.body.append(p); const c = getComputedStyle(p).backgroundColor; p.remove(); return c; };
    const t = document.querySelector('#background .ver-tab[data-n="${n}"]');
    const o = document.querySelector('#background .ver-tab:not(.sel)');
    const cs = getComputedStyle(t);
    return JSON.stringify({ bg: cs.backgroundColor, fg: cs.color, w: cs.fontWeight, fgVar: col("--fg"), panelVar: col("--panel"), otherBg: getComputedStyle(o).backgroundColor });
  })()`);
  for (const theme of ["light", "dark"]) {
    const c = probe(theme, "2");
    assert.equal(c.bg, c.fgVar, `${theme}: selected background is --fg`);
    assert.equal(c.fg, c.panelVar, `${theme}: selected text is --panel`);
    assert.equal(c.w, "600");
    assert.notEqual(c.otherBg, c.bg, `${theme}: the unselected tab is not filled like the selected one`);
    ab("screenshot", join(SHOTS, `tabs-${theme}.png`));
  }
  ev(`delete document.documentElement.dataset.theme, "ok"`);
});

gui("a rejection reason is labelled Rejection; one version shows no tabs", async () => {
  const d1 = await seed("s-rej", "1", V1);
  await api(`/api/decisions/${d1.id}/answer`, { approve: false, reason: "narrow it" });
  await sleep(20);
  await seed("s-rej", "2", V2);
  await reopen("document.querySelector('#background .ver-tab')");
  assert.match(sum(), /Rejection: narrow it$/);
  await cancelAll();
  await seed("s-one", "1", V1);
  await reopen("document.querySelector('#decision .btn')");
  await sleep(500);
  assert.equal(ev(`!!document.querySelector("#background .ver-bar")`), false, "one version: nothing changes");
  assert.equal(ev(`!!document.querySelector("#background .ver-badge")`), false);
  key("<");
  assert.equal(ev(`!!document.querySelector("#background .ver-bar")`), false);
});

gui("a plan file card: the snapshot taken by Instruct becomes v1, the file now is v2", async () => {
  writeFileSync(join(home, ".claude", "plans", "pv-fox.md"), V1);
  const tpath = join(home, ".claude", "projects", "p", "s-pv.jsonl");
  writeFileSync(tpath, '{"type":"user","slug":"pv-fox"}\n');
  await api("/api/events", { session_id: "s-pv", transcript_path: tpath, cwd: ROOT, hook_event_name: "Stop", received_at: new Date().toISOString() });
  const r = await api("/api/plans/pv-fox.md/instruct", { text: "add a cap" });
  assert.ok(r.delivered_via, JSON.stringify(r));
  writeFileSync(join(home, ".claude", "plans", "pv-fox.md"), V2);
  await reopen("document.querySelector('#decision .done-reading')");
  const pick = () => ev<string>(`document.querySelector("#head .plan-file")?.textContent ?? ""`);
  for (let i = 0; i < 6 && pick() !== "pv-fox.md"; i++) { key("l"); await sleep(300); }
  assert.equal(pick(), "pv-fox.md");
  await waitFor("tabs", `document.querySelector("#background .ver-tab")`);
  assert.deepEqual(await tabs(), ["v1", "v2"]);
  assert.equal(sum(), "v1 → v2: 1 section added · 1 changed · 1 removed · Instruction: add a cap");
  assert.equal(ev(`document.querySelectorAll("#background .ver-chg").length`), 1);
  rmSync(join(home, ".claude", "plans", "pv-fox.md"), { force: true });
});

gui("a short plan (no folding) is marked too", async () => {
  const S1 = "## A\n\nold line\n\n## B\n\nkept\n";
  const S2 = "## A\n\nnew line\n\n## B\n\nkept\n\n## C\n\nadded\n";
  const d1 = await seed("s-short", "1", S1);
  await api(`/api/decisions/${d1.id}/answer`, { instruct: true, text: "go" });
  await sleep(20);
  await seed("s-short", "2", S2);
  await reopen("document.querySelector('#background .ver-tab')");
  await waitFor("marks", `document.querySelector("#background .ver-badge")`);
  assert.deepEqual(await badges(), ["changed:Changed", "added:New"]);
  assert.equal(ev(`document.querySelector("#background .ver-chg").textContent`), "new line");
  assert.equal(ev(`document.querySelector("#background .ver-old").textContent.replace(/^−/, "")`), "old line");
});
