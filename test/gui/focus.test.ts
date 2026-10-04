// The GUI: a header colour per repository, and a card with a text box takes the focus as soon as the cursor lands on it.
// A real server (temp HOME) and a real browser (agent-browser). Skipped when agent-browser is not on PATH.
import { after, before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
const session = `ukagai-focus-${process.pid}-${Date.now().toString(36)}`;
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
  return res.json() as Promise<any>;
}

const transcript = () => join(home, ".claude", "projects", "p", "none.jsonl");

async function seedQuestion(cwd = ROOT, multiSelect = false): Promise<{ id: string }> {
  const n = ++seq;
  const question = `Focus question ${n}: A, B or C?`;
  const title = `Focus check ${n}`;
  const d = await api("/api/decisions", {
    tool_use_id: `toolu_focus_${process.pid}_${n}`,
    kind: "answer_question",
    session: { session_id: `00000000-0000-0000-0005-${String(n).padStart(12, "0")}`, cwd, transcript_path: transcript() },
    request: { questions: [{ question, header: "Check", multiSelect, options: [{ label: "A", description: "About A" }, { label: "B (Recommended)", description: "About B" }, { label: "C", description: "About C" }] }] },
    explanation: {
      path: "", title, question, reversibility: "reversible", scope: "file",
      markdown: SEED_MD.replace("__QUESTION__", question).replace("__TITLE__", title),
      has: { mermaid: false, table: true, diff: false }, match: "question", attached_via: "first_call",
    },
  });
  assert.ok(d.id, `cannot create decision: ${JSON.stringify(d)}`);
  return { id: d.id };
}

async function seedBlocker(cwd: string): Promise<{ id: string }> {
  const n = ++seq;
  const markdown = readFileSync(new URL("../explain-fixtures/pass-blocker.md", import.meta.url), "utf8");
  const fm = (k: string) => new RegExp(`^${k}: (.+)$`, "m").exec(markdown)![1]!;
  const labels = [...markdown.matchAll(/^\| ([^|]+?) \|/gm)].map((m) => m[1]!).filter((l) => !/^-+$/.test(l)).slice(1);
  const d = await api("/api/decisions", {
    tool_use_id: `toolu_focus_${process.pid}_${n}`,
    kind: "answer_question",
    session: { session_id: `00000000-0000-0000-0005-${String(n).padStart(12, "0")}`, cwd, transcript_path: transcript() },
    request: { questions: [{ question: fm("question"), header: "Blocked", multiSelect: false, options: [
      { label: `${labels[0]} (Recommended)`, description: "Retry" }, { label: labels[1]!, description: "Skip" }, { label: labels[2]!, description: "Stop" },
    ] }] },
    explanation: { path: "", type: "blocker", title: fm("title"), question: fm("question"), reversibility: "reversible", scope: "machine", markdown, has: { mermaid: false, table: true, diff: false }, match: "question", attached_via: "first_call" },
  });
  assert.ok(d.id, `cannot create blocker: ${JSON.stringify(d)}`);
  return { id: d.id };
}

async function seedCheckpoint(cwd = ROOT): Promise<{ id: string }> {
  const n = ++seq;
  const sid = `focus-sess-${process.pid}-${n}`;
  const at = new Date(Date.now() + n).toISOString();
  const d = await api("/api/decisions", {
    tool_use_id: `checkpoint:${sid}:${at}`, kind: "checkpoint",
    session: { session_id: sid, cwd, transcript_path: transcript() },
    request: { recap: "Added the retry. Next I would wire it into the CLI.", recap_at: at },
  });
  assert.ok(d.id, `cannot create checkpoint: ${JSON.stringify(d)}`);
  return { id: d.id };
}

async function cancelAll() {
  const list = (await api("/api/decisions?status=pending")) as { id: string }[];
  for (const d of list) await api(`/api/decisions/${d.id}/cancel`, {});
}

async function reopen(ready = "document.querySelector('#decision .opt, #decision .btn')") {
  ab("open", base + "/");
  await waitFor("screen render", ready);
}

async function status(id: string): Promise<string> { return (await api(`/api/decisions/${id}`)).status; }

const cardsJs = `[...document.querySelectorAll("#decision .opt")]`;
const cursor = () => ev<number>(`${cardsJs}.findIndex(e => e.classList.contains("cursor"))`);
const focusedIs = (sel: string) => ev<boolean>(`document.activeElement === document.querySelector(${JSON.stringify(sel)})`);
const FREE = "#decision .opt.free .free-text";
const INSTRUCT = '#decision [data-card="instruct"] .free-text';
const setValue = (sel: string, v: string) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event("input", { bubbles: true })); })(), "ok"`);

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
  test(`GUI focus: ${name}`, { skip: HAS_BROWSER ? false : "agent-browser is not installed" }, async (t) => {
    await cancelAll();
    try { await fn(t); } finally { await cancelAll(); }
  });
}

// ---- Focus ----

gui("↓ onto the free-text card focuses the box; Esc blurs and keeps the text; typing digits is text", async () => {
  const { id } = await seedQuestion();
  await reopen();
  assert.equal(focusedIs(FREE), false, "the first render does not steal the focus");
  press("ArrowDown", "ArrowDown"); // B -> C -> free text
  assert.equal(cursor(), 3);
  assert.equal(focusedIs(FREE), true);
  assert.match(ev<string>(`document.querySelector("#foot .hint-type").textContent`), /^Type your reply/);
  assert.equal(ev<boolean>(`getComputedStyle(document.querySelector("#foot .hint-type")).display !== "none"`), true);
  press("1", "j");
  assert.equal(ev<string>(`document.querySelector(${JSON.stringify(FREE)}).value`), "1j");
  assert.equal(await status(id), "pending", "a digit typed in the box is not a shortcut");
  assert.equal(cursor(), 3);
  press("Escape");
  assert.equal(focusedIs(FREE), false);
  assert.equal(ev<string>(`document.querySelector(${JSON.stringify(FREE)}).value`), "1j", "Esc keeps the text");
  assert.equal(cursor(), 3);
  assert.equal(ev<boolean>(`getComputedStyle(document.querySelector("#foot .hint-type")).display === "none"`), true);
});

gui("↑ in an empty box moves the cursor and blurs; with text it stays in the box", async () => {
  await seedQuestion();
  await reopen();
  press("End");
  assert.equal(focusedIs(FREE), true);
  press("ArrowUp");
  assert.equal(cursor(), 2);
  assert.equal(focusedIs(FREE), false);
  press("ArrowDown");
  assert.equal(focusedIs(FREE), true);
  press("x", "ArrowUp");
  assert.equal(cursor(), 3, "with text, ↑ is a text-field key");
  assert.equal(focusedIs(FREE), true);
});

gui("a click anywhere on the free-text card focuses the box; moving the cursor off blurs it", async () => {
  await seedQuestion();
  await reopen();
  ev(`document.querySelector("#decision .opt.free .lab").click(), "ok"`);
  assert.equal(cursor(), 3);
  assert.equal(focusedIs(FREE), true);
  press("Escape", "ArrowUp");
  assert.equal(focusedIs(FREE), false);
});

gui("Enter in the box sends the text; an empty box sends nothing", async () => {
  const { id } = await seedQuestion();
  await reopen();
  press("End", "Enter");
  assert.equal(await status(id), "pending");
  press("o", "k", "Enter");
  const end = Date.now() + 5000;
  while ((await status(id)) === "pending") { assert.ok(Date.now() < end, "never sent"); await sleep(100); }
  assert.equal(Object.values((await api(`/api/decisions/${id}`)).response.answers)[0], "ok");
});

gui("multi select: the box takes the focus too, and is ticked only once text is typed", async () => {
  await seedQuestion(ROOT, true);
  await reopen();
  press("End");
  assert.equal(focusedIs(FREE), true);
  assert.equal(ev<boolean>(`document.querySelector("#decision .opt.free input[type=checkbox]").checked`), false);
  press("a");
  assert.equal(ev<boolean>(`document.querySelector("#decision .opt.free input[type=checkbox]").checked`), true);
});

gui("checkpoint: ↓ onto the instruction card focuses it; Enter with text sends; off the card it blurs", async () => {
  const { id } = await seedCheckpoint();
  await reopen("document.querySelector('#decision [data-card=instruct]')");
  assert.equal(focusedIs(INSTRUCT), false);
  press("ArrowDown");
  assert.equal(focusedIs(INSTRUCT), true);
  press("ArrowDown"); // empty box: the cursor moves on to Stop
  assert.equal(focusedIs(INSTRUCT), false);
  press("ArrowUp");
  assert.equal(focusedIs(INSTRUCT), true);
  press("h", "i", "ArrowUp");
  assert.equal(focusedIs(INSTRUCT), true, "with text the arrows stay in the box");
  ab("screenshot", join(SHOTS, "G2-checkpoint-focus.png"));
  press("Enter");
  const end = Date.now() + 5000;
  while ((await status(id)) === "pending") { assert.ok(Date.now() < end, "never sent"); await sleep(100); }
  const r = (await api(`/api/decisions/${id}`)).response;
  assert.deepEqual([r.kind, r.text], ["instruct", "hi"]);
});

gui("checkpoint: the footer hint is visible below 900 px", async () => {
  await seedCheckpoint();
  try {
    ab("set", "viewport", "800", "700");
    await reopen("document.querySelector('#decision [data-card=instruct]')");
    const vis = ev<string>(`JSON.stringify([...document.querySelectorAll("#foot .hint > span")].filter(e => getComputedStyle(e).display !== "none").map(e => e.textContent).join(""))`);
    assert.match(vis, /Move/);
    assert.match(vis, /Esc/);
  } finally {
    ab("set", "viewport", "1280", "800");
  }
});

gui("a question with only the free card focuses the box on the first render; multi select unticks when the text is cleared", async () => {
  const n = ++seq;
  const d = await api("/api/decisions", {
    tool_use_id: `toolu_focus_${process.pid}_${n}`, kind: "answer_question",
    session: { session_id: `00000000-0000-0000-0005-${String(n).padStart(12, "0")}`, cwd: ROOT, transcript_path: transcript() },
    request: { questions: [{ question: `Free only ${n}?`, header: "Check", multiSelect: false, options: [] }] },
  });
  assert.ok(d.id);
  await reopen("document.querySelector('#decision .opt.free')");
  assert.equal(focusedIs(FREE), true);
  await cancelAll();
  await seedQuestion(ROOT, true);
  await reopen();
  press("End", "a");
  const tick = `document.querySelector("#decision .opt.free input[type=checkbox]").checked`;
  assert.equal(ev<boolean>(tick), true);
  press("Backspace");
  assert.equal(ev<boolean>(tick), false);
});

gui("checkpoint: a click on the card (not the box) focuses it; Esc blurs and keeps the text", async () => {
  await seedCheckpoint();
  await reopen("document.querySelector('#decision [data-card=instruct]')");
  ev(`document.querySelector('#decision [data-card="instruct"] .lab').click(), "ok"`);
  assert.equal(focusedIs(INSTRUCT), true);
  press("z", "Escape");
  assert.equal(focusedIs(INSTRUCT), false);
  assert.equal(ev<string>(`document.querySelector(${JSON.stringify(INSTRUCT)}).value`), "z");
});

// ---- Header colour ----

// The same algorithm as repoSlot in public/app.js
const slotOf = (name: string) => {
  let h = 0x811c9dc5;
  for (const ch of name) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 0x01000193) >>> 0; }
  return h % 12;
};
const hueOf = (name: string) => (238 + slotOf(name) * 27) % 360;
const cwdOf = (repo: string) => `/Users/test/.herdr/worktrees/${repo}/feat-x`;
const REPO_A = "ukagai";
const REPO_B = ["whoknows", "awm", "dotfiles", "blog", "infra"].find((n) => slotOf(n) !== slotOf(REPO_A))!;
const headColour = () => ev<{ hue: string; border: string; borderW: string; shadow: string; repo: string }>(
  `JSON.stringify((() => { const h = getComputedStyle(document.querySelector("#head")); return { hue: h.getPropertyValue("--repo-hue").trim(), border: h.borderLeftColor, borderW: h.borderLeftWidth, shadow: h.boxShadow, repo: getComputedStyle(document.querySelector("#head .origin-repo")).color }; })())`,
);

gui("the header colour follows the repository: different repos differ, the same repo is stable", async () => {
  await seedQuestion(cwdOf(REPO_A));
  await reopen();
  const a1 = headColour();
  assert.equal(a1.hue, String(hueOf(REPO_A)));
  assert.equal(a1.border, a1.repo, "the left border and the repo name share the colour");
  assert.equal(a1.borderW, "6px");
  assert.ok(a1.shadow.startsWith(a1.border) && /0px 3px 0px 0px/.test(a1.shadow) && a1.shadow.includes("inset"), `a 3 px top band in the repo colour: ${a1.shadow}`);
  ab("screenshot", join(SHOTS, "G2-header-repo-a.png"));
  await cancelAll();
  await seedQuestion(cwdOf(REPO_B));
  await reopen();
  const b = headColour();
  assert.notEqual(b.border, a1.border);
  assert.notEqual(b.hue, a1.hue);
  ab("screenshot", join(SHOTS, "G2-header-repo-b.png"));
  await cancelAll();
  await seedQuestion(cwdOf(REPO_A));
  await reopen();
  assert.deepEqual(headColour(), a1);
});

gui("a drawer row carries a dot in the repo colour; the blocker band keeps precedence and the repo colour stays as the left border", async () => {
  await seedQuestion(cwdOf(REPO_A));
  await seedQuestion(cwdOf(REPO_B));
  await reopen();
  press("b");
  await sleep(300);
  const dots = ev<string[]>(`JSON.stringify([...document.querySelectorAll("#drawer .row .repo-dot")].map(e => getComputedStyle(e).backgroundColor))`);
  assert.equal(dots.length, 2);
  assert.notEqual(dots[0], dots[1]);
  press("Escape");
  await cancelAll();
  await seedBlocker(cwdOf(REPO_B));
  await reopen();
  assert.equal(ev<boolean>(`document.querySelector("#head").classList.contains("blocker")`), true);
  assert.equal(ev<boolean>(`!!document.querySelector("#head .blocker-band")`), true);
  assert.equal(ev<string>(`getComputedStyle(document.querySelector("#head .hd-top")).backgroundColor`) !== "rgba(0, 0, 0, 0)", true, "the orange band");
  const bl = headColour();
  assert.equal(bl.borderW, "6px", "the repo colour stays as the left border");
  const accent = ev<string>(`(() => { const e = document.createElement("div"); e.style.color = "hsl(${hueOf(REPO_B)} 70% " + getComputedStyle(document.documentElement).getPropertyValue("--repo-l").trim() + ")"; document.body.append(e); const c = getComputedStyle(e).color; e.remove(); return c; })()`);
  assert.equal(bl.border, accent, "the left border is the repo accent");
  assert.notEqual(bl.border, "rgb(249, 115, 22)", "the border is not the blocker orange");
  assert.equal(bl.hue, String(hueOf(REPO_B)));
  assert.equal(headColour().hue, String(hueOf(REPO_B)));
});

gui("a checkpoint card gets its repo colour from the session folder", async () => {
  await seedCheckpoint(cwdOf(REPO_A));
  await reopen("document.querySelector('#decision [data-card=instruct]')");
  assert.equal(headColour().hue, String(hueOf(REPO_A)));
});
