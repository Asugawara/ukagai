// The ukagai Markdown dialect (docs/spec/markdown.md) in the GUI: one rich explanation that uses every construct, and a plan file with an image.
// A real server (temp HOME) and a real browser (agent-browser). Skipped when agent-browser is not on PATH. Keys are sent as KeyboardEvents (eval).
import { after, before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HAS_BROWSER = spawnSync("agent-browser", ["--version"], { stdio: "ignore" }).status === 0;
const SHOTS = process.env.UKAGAI_SHOTS_DIR ?? join(tmpdir(), "ukagai-shots");
mkdirSync(SHOTS, { recursive: true });

let home = "";
let top = "";
let scratch = "";
let port = 0;
let token = "";
let serve: ChildProcess | undefined;
let base = "";
let opened = false;
const session = `ukagai-md-${process.pid}-${Date.now().toString(36)}`;

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

const key = (k: string) => ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true })), "ok"`);
const count = (sel: string) => ev<number>(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const text = (sel: string) => ev<string>(`"t:" + ((document.querySelector(${JSON.stringify(sel)}) ?? {}).textContent ?? "")`).slice(2);
const texts = (sel: string) => ev<string[]>(`JSON.stringify([...document.querySelectorAll(${JSON.stringify(sel)})].map((e) => e.textContent.trim()))`);

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

/** A solid-colour PNG (no dependency): signature, IHDR, one IDAT, IEND */
function png(w: number, h: number, [r, g, b]: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf: Buffer) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const QUESTION = "Which store should hold the cache, A or B?";

/** A live session whose transcript carries `slug`: a plan file `<slug>.md` pops up only when its session is known */
async function planSession(slug: string): Promise<void> {
  const tpath = join(home, ".claude", "projects", "p", `${slug}.jsonl`);
  mkdirSync(join(home, ".claude", "projects", "p"), { recursive: true });
  writeFileSync(tpath, `{"type":"user","slug":"${slug}"}\n`);
  await fetch(base + "/api/events", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ session_id: `s-${slug}`, transcript_path: tpath, cwd: ROOT, hook_event_name: "UserPromptSubmit", received_at: new Date().toISOString() }),
  });
}

const EX_MD = readFileSync(new URL("./fixtures/dialect.md", import.meta.url), "utf8");
const PLAN_MD = "# Image plan\n\n## One\n\nBefore the change:\n\n![Plan screenshot](img/plan-shot.png)\n\nAfter.\n";

before(async () => {
  if (!HAS_BROWSER) return;
  home = mkdtempSync(join(tmpdir(), "ukagai-md-"));
  top = mkdtempSync(join(tmpdir(), "claude-ukagai-md-")); // <tmp>/claude-*/<project>/<session>/scratchpad, like Claude Code
  scratch = join(top, "-proj", "sess-md", "scratchpad");
  mkdirSync(join(scratch, "ukagai", "shots"), { recursive: true });
  writeFileSync(join(scratch, "ukagai", "shots", "ok.png"), png(640, 360, [37, 99, 235]));
  mkdirSync(join(home, ".claude", "plans", "img"), { recursive: true });
  writeFileSync(join(home, ".claude", "plans", "img", "plan-shot.png"), png(320, 200, [22, 163, 74]));
  const dataDir = join(home, "data");
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
  for (const d of [home, top]) if (d) rmSync(d, { recursive: true, force: true });
});

function gui(name: string, fn: (t: TestContext) => Promise<void>) {
  test(`GUI markdown: ${name}`, { skip: HAS_BROWSER ? false : "agent-browser is not installed" }, async (t) => {
    await cancelAll();
    ab("set", "viewport", "1440", "900");
    try { await fn(t); } finally { await cancelAll(); }
  });
}

async function seedDoc(markdown: string, question: string, file = "ex.md"): Promise<{ id: string }> {
  const docPath = join(scratch, "ukagai", file);
  writeFileSync(docPath, markdown);
  const d = await api("/api/decisions", {
    tool_use_id: `toolu_md_${process.pid}_${Date.now()}`,
    kind: "answer_question",
    session: { session_id: "00000000-0000-0000-0009-000000000001", cwd: ROOT, transcript_path: join(home, ".claude", "projects", "p", "none.jsonl"), scratchpad_dir: scratch },
    request: { questions: [{ question, header: "Store", multiSelect: false, options: [{ label: "A (Recommended)", description: "A" }, { label: "B", description: "B" }] }] },
    explanation: { path: docPath, markdown, has: { mermaid: true, table: true, diff: true }, match: "question", attached_via: "first_call" },
  });
  assert.ok(d.id, `cannot create decision: ${JSON.stringify(d)}`);
  void api(`/api/decisions/${d.id}/wait?timeout_ms=60000`).catch(() => {}); // a hook waiting keeps the lease (10 s) alive; cancelAll ends it
  return { id: d.id };
}

const seedRich = () => seedDoc(EX_MD.replace("__QUESTION__", QUESTION), QUESTION);

const BG = "#background";
const AUTHOR = `${BG} details:not(.fold):not(.affects):not(.plan-sec):not(.plan-sub)`; // the details the author wrote
const READY = `document.querySelector("${BG} .callout") && document.querySelectorAll("${BG} .mermaid-ok svg").length >= 3`;

async function openRich() {
  const { id } = await seedRich();
  ab("open", base + "/");
  await waitFor("rich explanation rendered", READY, 15000);
  return id;
}

gui("every construct renders (callouts, tasks, details, code, badges, mark, columns, steps, file refs)", async () => {
  await openRich();

  // Callouts: five kinds, the title replaces the kind word, the kind word is the label without one
  assert.deepEqual(ev<string[]>(`JSON.stringify([...document.querySelectorAll("${BG} blockquote.callout")].map((b) => [b.className.replace("callout ", ""), b.querySelector(".callout-label").textContent]))`), [
    ["note", "Context for the reader"],
    ["tip", "Tip"],
    ["important", "Important"],
    ["warning", "Warning"],
    ["caution", "Caution"],
  ]);
  assert.equal(ev<boolean>(`getComputedStyle(document.querySelector("${BG} blockquote.callout.important")).borderLeftColor !== getComputedStyle(document.querySelector("${BG} blockquote.callout.note")).borderLeftColor`), true);
  assert.equal(text(`${BG} blockquote.callout.note p`), "Body of the note.");
  assert.equal(ev<string>(`getComputedStyle(document.querySelector("${BG} blockquote.callout.tip")).position`), "static"); // not the fixed-position tooltip rule
  assert.equal(ev<boolean>(`document.querySelector("${BG} blockquote.callout.tip").getBoundingClientRect().height > 20`), true);

  // Task list: glyphs, done items dimmed, no real checkbox left
  assert.deepEqual(texts(`${BG} li.task .task-box`).sort(), ["☐", "☐", "☑", "☑", "☑"]);
  assert.equal(count(`${BG} li.task.done`), 3);
  assert.equal(count(`${BG} input`), 0);
  assert.equal(ev<boolean>(`getComputedStyle(document.querySelector("${BG} li.task.done")).textDecorationLine === "line-through"`), true);

  // Details: closed unless `open`; the Markdown inside renders; <br> / <sub> / <sup> survive, <kbd> does not
  assert.deepEqual(ev<boolean[]>(`JSON.stringify([...document.querySelectorAll("${AUTHOR}")].map((d) => d.open))`), [false, true, true]);
  assert.equal(text(`${AUTHOR} > summary`), "Full log (3 lines)");
  assert.equal(count(`${BG} sub`), 1);
  assert.equal(count(`${BG} sup:not(.fn):not(.fn-n)`), 1);
  assert.equal(count(`${BG} kbd`), 0);

  // The old regex stage ate `on*=` pairs: code and prose keep them
  assert.equal(ev<boolean>(`document.querySelector("${BG} code.language-tsx").textContent.includes("<button onClick={go} disabled>")`), true);
  assert.equal(ev<boolean>(`document.querySelector("${BG}").textContent.includes("once=5 and only=true")`), true);

  // Code: title tab above the block (text only), diff lines coloured
  assert.deepEqual(texts(`${BG} .codefile-tab`), ["src/serve/store.ts"]);
  assert.equal(count(`${BG} .codefile-tab a`), 0);
  assert.equal(count(`${BG} .codefile > pre code.language-ts`), 1);
  assert.equal(count(`${BG} pre.diff .add`) >= 1 && count(`${BG} pre.diff .del`) >= 1, true);
  assert.equal(ev<boolean>(`getComputedStyle(document.querySelector("${BG} pre.diff .add")).backgroundColor !== getComputedStyle(document.querySelector("${BG} pre.diff .del")).backgroundColor`), true);

  // Badges: the six tokens at the start of a list item or table cell; the word stays, brackets go; a token inside a sentence is untouched
  assert.deepEqual(texts(`${BG} .badge.done, ${BG} .badge.todo, ${BG} .badge.doing, ${BG} .badge.blocked, ${BG} .badge.risk, ${BG} .badge.skip`).sort(), ["blocked", "doing", "done", "done", "done", "risk", "risk", "skip", "todo", "todo"]);
  for (const k of ["done", "todo", "doing", "blocked", "risk", "skip"]) assert.ok(count(`${BG} .badge.${k}`) >= 1, k);
  assert.equal(ev<boolean>(`document.querySelector("${BG}").textContent.includes("a [done] token in a sentence stays")`), true);
  assert.equal(ev<boolean>(`!!document.querySelector("${BG} td .badge.risk")`), true);
  assert.equal(ev<string>(`getComputedStyle(document.querySelector("${BG} .badge.todo")).borderTopWidth`), "1px"); // not the blocker box (.todo)

  // ==mark==: text only, never inside code
  assert.deepEqual(texts(`${BG} mark`), ["must not miss"]); // `=====` and `a===b===c` are not highlights
  assert.equal(ev<boolean>(`document.querySelector("${BG}").textContent.includes("===== and a===b===c stay as written")`), true);
  assert.equal(ev<boolean>(`document.querySelector("${BG}").textContent.includes("==kept as written==")`), true);

  // Columns: side by side at 1440 px, stacked at 800 px
  assert.equal(count(`${BG} .cols .col`), 4); // Compare, and the pair inside a <details>
  assert.equal(ev<boolean>(`!document.querySelector("${BG}").textContent.includes("UKAGAICOLUMNS")`), true);
  assert.equal(text(`${AUTHOR} .cols .col:last-child`).includes("Right in details"), true);
  const side = ev<number[]>(`JSON.stringify([...document.querySelectorAll("${BG} .cols .col")].map((c) => Math.round(c.getBoundingClientRect().top)))`);
  assert.equal(side[0], side[1]);
  assert.equal(ev<boolean>(`getComputedStyle(document.querySelector("${BG} .cols")).display === "grid"`), true);
  assert.equal(text(`${BG} .cols .col:first-child`).includes("Before"), true);
  assert.equal(text(`${BG} .cols .col:last-child`).includes("After"), true);
  ab("set", "viewport", "800", "900");
  await waitFor("columns stacked", `(() => { const c = [...document.querySelectorAll("${BG} .cols .col")].map((x) => Math.round(x.getBoundingClientRect().top)); return c.length === 4 && c[0] < c[1]; })()`);
  ab("set", "viewport", "1440", "900");

  // Steps: a timeline for the ordered list under ## Steps; other ordered lists unchanged
  assert.equal(count(`${BG} ol.steps`), 1);
  assert.equal(count(`${BG} ol.steps > li`), 2);
  assert.equal(count(`${BG} ol:not(.steps)`), 1);
  assert.equal(ev<string>(`getComputedStyle(document.querySelector("${BG} ol.steps > li"), "::before").content`), "counter(step)"); // the numbered dot
  assert.equal(ev<string>(`getComputedStyle(document.querySelector("${BG} ol.steps > li"), "::before").borderRadius`), "50%");
  assert.equal(ev<boolean>(`document.querySelector("${BG} ol.steps > li").querySelector("strong + .badge")?.textContent === "done"`), true);
  assert.equal(count(`${BG} ol.steps > li ul li.task`), 2);
  assert.equal(ev<string>(`getComputedStyle(document.querySelector("${BG} ol:not(.steps)")).listStyleType`), "decimal");

  // File references: a chip for repository paths (with a line suffix), not for other code; a click copies it
  assert.deepEqual(texts(`${BG} .fileref`), ["src/contract.ts:12", "public/app.js#L40-L60"]);
  assert.equal(ev<boolean>(`[...document.querySelectorAll("${BG} code")].filter((c) => c.textContent === "not a path" || c.textContent === "npm test").every((c) => !c.classList.contains("fileref"))`), true);
  ev(`(() => { window.__clip = []; navigator.clipboard.writeText = async (s) => { window.__clip.push(s); }; return "ok"; })()`);
  ev(`document.querySelector("${BG} .fileref").click(), "ok"`);
  await waitFor("copied", `window.__clip.length === 1 && window.__clip[0] === "src/contract.ts:12"`);
  await waitFor("toast", `[...document.querySelectorAll(".toast")].some((t) => t.textContent.includes("Copied"))`);
});

gui("Mermaid renders any type: flowchart, sequenceDiagram, pie, and the other listed types do not throw", async () => {
  await openRich();
  assert.equal(count(`${BG} .mermaid-ok svg`) >= 3, true);
  assert.equal(count(`${BG} .mermaid-err`), 0);
  // Every type of the spec, rendered through the page's own Mermaid
  const types: Record<string, string> = {
    mindmap: "mindmap\n  root((Plan))\n    Option A\n    Option B",
    timeline: "timeline\n  title Rollout\n  2026 : Design\n  2027 : Ship",
    gitGraph: "gitGraph\n  commit\n  branch dev\n  commit\n  checkout main\n  merge dev",
    quadrantChart: "quadrantChart\n  title Risk and effort\n  x-axis Low effort --> High effort\n  y-axis Low risk --> High risk\n  A: [0.3, 0.6]",
    "xychart-beta": 'xychart-beta\n  title "Latency"\n  x-axis [a, b, c]\n  bar [5, 3, 4]',
    "block-beta": "block-beta\n  columns 2\n  a b",
    journey: "journey\n  title Day\n  section Work\n    Code: 5: Me",
    gantt: "gantt\n  title Rollout\n  dateFormat YYYY-MM-DD\n  section S\n  Task :a1, 2026-01-01, 3d",
    erDiagram: "erDiagram\n  A ||--o{ B : has",
    classDiagram: "classDiagram\n  class A",
    "stateDiagram-v2": "stateDiagram-v2\n  [*] --> A",
  };
  const results = ev<Record<string, string>>(`(async () => {
    const m = window.mermaid.default ?? window.mermaid;
    const out = {};
    for (const [k, src] of Object.entries(${JSON.stringify(types)})) {
      try { const { svg } = await m.render("probe-" + k.replace(/\\W/g, ""), src); out[k] = svg.includes("<svg") ? "ok" : "empty"; } catch (e) { out[k] = String(e.message ?? e).split("\\n")[0]; }
    }
    window.__mm = JSON.stringify(out);
    return "done";
  })()`);
  void results;
  await waitFor("mermaid probe", `window.__mm !== undefined`, 20000);
  const raw = ev<string | Record<string, string>>(`window.__mm`);
  const probe = typeof raw === "string" ? (JSON.parse(raw) as Record<string, string>) : raw;
  for (const k of Object.keys(types)) assert.equal(probe[k], "ok", `${k}: ${probe[k]}`);
});

gui("a Mermaid error keeps the source visible", async () => {
  const question = "Broken diagram, A or B?";
  const docPath = join(scratch, "ukagai", "bad.md");
  const markdown = `---\nukagai: 1\nquestion: ${question}\n---\n\n## Why this decision is needed now\n\nBody.\n\n\`\`\`mermaid\nnot a diagram at all\n\`\`\`\n`;
  writeFileSync(docPath, markdown);
  const d = await api("/api/decisions", {
    tool_use_id: `toolu_md_bad_${process.pid}`,
    kind: "answer_question",
    session: { session_id: "00000000-0000-0000-0009-000000000002", cwd: ROOT, transcript_path: join(home, ".claude", "projects", "p", "none.jsonl"), scratchpad_dir: scratch },
    request: { questions: [{ question, header: "Bad", multiSelect: false, options: [{ label: "A" }, { label: "B" }] }] },
    explanation: { path: docPath, markdown, has: { mermaid: true, table: false, diff: false }, match: "question", attached_via: "first_call" },
  });
  assert.ok(d.id);
  ab("open", base + "/");
  await waitFor("error placeholder", `document.querySelector("${BG} .mermaid-err")`, 10000);
  assert.equal(text(`${BG} .mermaid-err`).startsWith("Failed to render Mermaid"), true);
  assert.equal(text(`${BG} pre`).includes("not a diagram at all"), true);
});

gui("images: src rewritten to /api/files, caption, lightbox with focus restore, missing file text, external image dropped", async () => {
  const id = await openRich();
  assert.equal(count(`${BG} figure.doc-img`) >= 3, true); // ok, gone, the <img src="x"> (a failed image becomes text, so count figures)
  const okSrc = ev<string>(`document.querySelector("${BG} figure.doc-img img").getAttribute("src")`);
  assert.equal(okSrc, `/api/files?decision=${id}&path=${encodeURIComponent("shots/ok.png")}`);
  assert.equal(ev<string>(`document.querySelector("${BG} figure.doc-img img").getAttribute("loading")`), "lazy");
  assert.equal(text(`${BG} figure.doc-img figcaption`), "Settings page, dark theme");
  assert.equal(ev<boolean>(`document.querySelector("${BG} figure.doc-img img").getBoundingClientRect().height <= 480`), true);
  ev(`document.querySelector("${BG} figure.doc-img").scrollIntoView(), "ok"`);
  await waitFor("image loaded", `document.querySelector("${BG} figure.doc-img img").complete && document.querySelector("${BG} figure.doc-img img").naturalWidth === 640`);

  // lightbox: opens at full size, the background is inert, Esc closes and focus returns to the image button
  ev(`document.querySelector("${BG} figure.doc-img .doc-img-open").click(), "ok"`);
  await waitFor("lightbox", `document.querySelector(".overlay.lightbox img.lightbox-img")`);
  assert.equal(ev<boolean>(`document.getElementById("main").inert`), true);
  assert.equal(ev<boolean>(`document.querySelector(".overlay.lightbox").getAttribute("aria-modal") === "true"`), true);
  key("Escape");
  await waitFor("lightbox closed", `!document.querySelector(".overlay.lightbox")`);
  assert.equal(ev<boolean>(`document.getElementById("main").inert`), false);
  assert.equal(ev<boolean>(`document.activeElement.classList.contains("doc-img-open")`), true);
  // a click on the overlay closes it too
  ev(`document.querySelector("${BG} figure.doc-img .doc-img-open").click(), "ok"`);
  await waitFor("lightbox again", `document.querySelector(".overlay.lightbox")`);
  ev(`document.querySelector(".overlay.lightbox").click(), "ok"`);
  await waitFor("lightbox closed by click", `!document.querySelector(".overlay.lightbox")`);

  // a missing file shows the alt text and the note
  // lazy images load near the viewport: scroll to it on every poll
  await waitFor("missing image text", `(document.querySelector('${BG} img[src*="gone.png"], ${BG} .img-alt')?.scrollIntoView(), true) && [...document.querySelectorAll("${BG} figure.doc-img")].some((f) => f.querySelector(".img-missing") && f.textContent.includes("Gone screenshot"))`, 10000);
  assert.equal(text(`${BG} .img-missing`), "image not found");

  // external images are dropped, other schemes too
  assert.equal(count(`${BG} img[src^="http"], ${BG} img[src^="//"], ${BG} img[src*="example.com"]`), 0);
  assert.equal(count(`${BG} img[src^="file:"]`), 0);
});

gui("raw HTML: scripts, iframes, forms, event attributes and unknown tags are dropped", async () => {
  await openRich();
  assert.equal(ev<boolean>(`window.__pwn === undefined`), true);
  assert.equal(count(`${BG} script, ${BG} iframe, ${BG} form, ${BG} object, ${BG} embed, ${BG} kbd, ${BG} button.evil`), 0);
  // .optref carries the app's own --oc style (the headline, now in this column, holds such marks)
  assert.equal(ev<boolean>(`[...document.querySelectorAll("${BG} *")].filter((e) => !e.closest("svg") && !e.classList.contains("optref")).every((e) => ![...e.attributes].some((a) => a.name.startsWith("on") || a.name === "style" || a.name === "srcdoc"))`), true);
  assert.equal(ev<boolean>(`document.querySelector("${BG}").textContent.includes("visible text of an unknown tag")`), true);
  assert.equal(count(`${BG} a[href^="javascript:"]`), 0);
  // The review payloads: entity / whitespace tricks all lose their href; a click runs nothing
  for (const label of ["js link", "x1", "x2", "x3", "x4"]) {
    assert.equal(ev<boolean>(`(() => { const a = [...document.querySelectorAll("${BG} a")].find((x) => x.textContent === ${JSON.stringify(label)}); return !!a && !a.hasAttribute("href"); })()`), true, label);
  }
  ev(`[...document.querySelectorAll("${BG} a")].filter((a) => /^(js link|x\\d)$/.test(a.textContent)).forEach((a) => a.click()), "ok"`);
  assert.equal(ev<boolean>(`window.__x === undefined`), true);
  // ordinary links keep their href
  assert.equal(ev<string>(`[...document.querySelectorAll("${BG} a")].find((x) => x.textContent === "fine").getAttribute("href")`), "https://example.com/page");
  assert.equal(ev<string>(`[...document.querySelectorAll("${BG} a")].find((x) => x.textContent === "rel").getAttribute("href")`), "docs/spec.md");
});

const EDGE_MD = `---
ukagai: 1
question: Edge cases, A or B?
---

## Why this decision is needed now

<details>
<summary>Never closed</summary>

An unclosed details must not swallow the options.

### Steps

1. not a timeline
2. h3 is not the Steps section

::: columns
one

---

two

---

three

---

four
:::

![inline](data:image/png;base64,iVBORw0KGgo=)

## Options

| Option | What happens if chosen | Risks and how to undo |
|---|---|---|
| A (Recommended) | Uses A for reads | Revert the file |
| B | Uses B for reads | Revert the file |

## Recommendation

I recommend **A** because it is simpler. Another option is right if B is already running.
`;

gui("edge cases: an unclosed <details> ends at the next ## heading, >3 columns stack, h3 Steps and data: images are not special", async () => {
  await seedDoc(EDGE_MD, "Edge cases, A or B?", "edge.md");
  ab("open", base + "/");
  await waitFor("edge rendered", `document.querySelector("${BG} .cols")`, 10000);
  // the option cards still have their columns (the Options table stayed a section)
  assert.equal(ev<boolean>(`[...document.querySelectorAll("#decision .opt .desc")].some((d) => d.textContent.includes("Uses A for reads"))`), true);
  assert.equal(count(`${BG} details > summary`) >= 1, true);
  assert.equal(count(`${BG} ol.steps`), 0);
  assert.equal(count(`${BG} .cols.n3 .col`), 4);
  const tops = ev<number[]>(`JSON.stringify([...document.querySelectorAll("${BG} .cols .col")].map((c) => Math.round(c.getBoundingClientRect().top)))`);
  assert.equal(tops[0], tops[1]);
  assert.equal(tops[1], tops[2]);
  assert.equal(tops[3] > tops[2], true); // the fourth stacks below, in order
  assert.equal(count(`${BG} img[src^="data:"]`), 0);
});

gui("Japanese display language: callout label, task labels and the missing-image note", async () => {
  await openRich();
  ev(`document.documentElement.dataset.lang = "ja", "ok"`);
  await waitFor("ja callout", `[...document.querySelectorAll("${BG} .callout.important .callout-label")].some((l) => l.textContent === "重要")`);
  assert.equal(ev<boolean>(`[...document.querySelectorAll("${BG} .task-box")].some((b) => b.getAttribute("aria-label") === "完了") && [...document.querySelectorAll("${BG} .task-box")].some((b) => b.getAttribute("aria-label") === "未完了")`), true);
  await waitFor("ja missing image", `(document.querySelector('${BG} img[src*="gone.png"], ${BG} .img-alt')?.scrollIntoView(), true) && [...document.querySelectorAll("${BG} .img-missing")].some((m) => m.textContent === "画像が見つかりません")`, 10000);
  ev(`document.documentElement.dataset.lang = "en", "ok"`);
});

gui("a plan file renders its image through plan=<name> and a <details> in a plan section does not break folding", async () => {
  const name = "image-plan.md";
  const planMd = `${PLAN_MD}\n## Two\n\n<details>\n<summary>Plan log</summary>\n\nlog body\n\n</details>\n\n## Three\n\n${"filler line\n\n".repeat(30)}`;
  ab("open", base + "/");
  await waitFor("idle", `document.getElementById("empty") && !document.getElementById("empty").hidden`);
  const dir = join(home, ".claude", "plans");
  await planSession("image-plan");
  writeFileSync(join(dir, name), planMd);
  await waitFor("plan screen", `document.querySelector("${BG} figure.doc-img img")`, 8000);
  assert.equal(ev<string>(`document.querySelector("${BG} figure.doc-img img").getAttribute("src")`), `/api/files?plan=${encodeURIComponent(name)}&path=${encodeURIComponent("img/plan-shot.png")}`);
  ev(`document.querySelector("${BG} figure.doc-img").scrollIntoView(), "ok"`);
  await waitFor("plan image loaded", `document.querySelector("${BG} figure.doc-img img").naturalWidth === 320`);
  // the author's <details> folds natively, the section keeps folding
  assert.equal(ev<boolean>(`!!document.querySelector("${BG} details.plan-sec")`), true);
  ev(`(() => { const s = document.querySelectorAll("${BG} details.plan-sec")[1]; s.open = true; return "ok"; })()`);
  const author = `${BG} details:not(.plan-sec):not(.plan-sub):not(.fold)`;
  assert.equal(ev<boolean>(`document.querySelector(${JSON.stringify(author)}).open`), false);
  ev(`document.querySelector(${JSON.stringify(author + " > summary")}).click(), "ok"`);
  await waitFor("author details opens", `document.querySelector(${JSON.stringify(author)}).open === true`);
  assert.equal(ev<boolean>(`document.querySelector(${JSON.stringify(author)}).closest("details.plan-sec").open`), true);
  rmSync(join(dir, name), { force: true });
});

gui("screenshots: the rich explanation in light and dark", async () => {
  ab("set", "viewport", "1280", "1500");
  for (const scheme of ["light", "dark"]) {
    ab("set", "media", scheme);
    await openRich(); // reloads, so Mermaid starts in the scheme under test
    ev(`(() => { const h = [...document.querySelectorAll("${BG} h2")].find((x) => x.textContent === "Callouts and lists"); document.querySelector("${BG}").scrollTop += h.getBoundingClientRect().top - 100; return "ok"; })()`);
    await sleep(500);
    const file = join(SHOTS, `RP2-${scheme}.png`);
    ab("screenshot", file);
    assert.ok(readFileSync(file).length > 1000);
    await cancelAll();
  }
  ab("set", "media", "light");
});
