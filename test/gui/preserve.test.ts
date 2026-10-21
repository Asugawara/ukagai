// Everything an explanation the hook accepts says must reach the GUI: every pass-* fixture is seeded through the API, opened in a real browser
// (agent-browser) and its atoms (test/support/explain-atoms.ts) are looked for on the page. Only ALLOWED_DROPS may be missing.
// Skipped when agent-browser is not on PATH, unless UKAGAI_REQUIRE_BROWSER=1 (CI): then its absence fails the run.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { passCases, type PassCase } from "../support/explain-atoms.js";
import { EXPLAINED_MD, FIELD_RULES, V, options as fieldOptions } from "../support/question-fields.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PIXEL = fileURLToPath(new URL("./fixtures/pixel.png", import.meta.url));
const HAS_BROWSER = spawnSync("agent-browser", ["--version"], { stdio: "ignore" }).status === 0;
const REQUIRE_BROWSER = process.env["UKAGAI_REQUIRE_BROWSER"] === "1";

let home = "";
let dataDir = "";
let port = 0;
let token = "";
let serve: ChildProcess | undefined;
let base = "";
let opened = false;
let seq = 0;
const session = `ukagai-gui-preserve-${process.pid}-${Date.now().toString(36)}`;

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
  return execFileSync("agent-browser", args, {
    env: { ...process.env, AGENT_BROWSER_SESSION: session },
    encoding: "utf8",
    timeout: 30000,
  }).trim();
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

async function api(path: string, body?: unknown) {
  const go = () => fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // A keep-alive socket the server closed while the browser was busy resets once; retry on a fresh connection
  const res = await go().catch(() => go());
  return res.json() as Promise<any>;
}

/** Seed the fixture as the hook would hand it over: a file under <data-dir>/explain, whose images are resolved next to it (every one is the same real PNG) */
async function seed(c: PassCase): Promise<string> {
  const n = ++seq;
  const markdown = c.markdown.replace(/\]\([^)\s]+\.png\)/g, "](pixel.png)");
  const options = c.labels.map((label, i) => ({ label: i === 0 && c.kind === "decision" ? `${label} (Recommended)` : label, description: `About ${label}`, preview: `KEEPPREVIEW${i}` }));
  const d = await api("/api/decisions", {
    tool_use_id: `toolu_gui_preserve_${process.pid}_${n}`,
    kind: "answer_question",
    session: { session_id: `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`, cwd: ROOT, transcript_path: join(home, ".claude", "projects", "p", "none.jsonl") },
    request: { questions: [{ question: c.question, header: "Check", options, multiSelect: false }] },
    explanation: {
      path: join(dataDir, "explain", c.file), ...(c.kind === "decision" ? {} : { type: c.kind }), title: c.title, question: c.question, reversibility: "reversible", scope: "file", markdown,
      has: { mermaid: c.atoms.mermaid.length > 0, table: c.kind !== "quiz", diff: false }, match: "question", attached_via: "first_call",
    },
  });
  assert.ok(d.id, `cannot create decision: ${JSON.stringify(d)}`);
  return d.id;
}

async function cancelAll() {
  const list = (await api("/api/decisions?status=pending")) as { id: string }[];
  for (const d of list) await api(`/api/decisions/${d.id}/cancel`, {});
}

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
  // Point HOME at a temp directory so ~/.ukagai and real sessions are untouched
  home = mkdtempSync(join(tmpdir(), "ukagai-gui-preserve-"));
  dataDir = join(home, "data");
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  await startServe();
  mkdirSync(join(dataDir, "explain"), { recursive: true });
  copyFileSync(PIXEL, join(dataDir, "explain", "pixel.png"));
  ab("open", base + "/", "--viewport", "1440x900");
  opened = true;
});

after(async () => {
  if (opened) { try { ab("close"); } catch {} }
  serve?.kill();
  if (home) rmSync(home, { recursive: true, force: true });
});

function gui(name: string, fn: () => Promise<void>) {
  test(`GUI: ${name}`, { skip: HAS_BROWSER ? false : "agent-browser is not installed" }, async () => {
    await cancelAll();
    try { await fn(); } finally { await cancelAll(); }
  });
}

/** Open the page on the decision that is already seeded and wait for the screen */
async function reopen() {
  ab("open", base + "/");
  const end = Date.now() + 5000;
  while (!ev<boolean>(`!!document.querySelector("#decision .opt, #decision .btn")`)) {
    assert.ok(Date.now() < end, "screen did not render");
    await sleep(100);
  }
}

/** The atoms the page lacks, computed inside the page (the text stays there: only a short list comes back) */
function missingOnPage(c: PassCase): string[] {
  const a = c.atoms;
  return ev<string[]>(`JSON.stringify((() => {
    const A = ${JSON.stringify({ sentinels: a.sentinels, images: a.images, codeKeys: a.codeKeys, mermaid: a.mermaid.length })};
    // textContent, not what is painted: code folded behind "Show code" and a closed <details> are still on the page, one click from the human
    const flat = (s) => s.replace(/\\s/g, "");
    const roots = ["#head", "#background", "#decision"].map((s) => document.querySelector(s)).filter(Boolean);
    const text = flat(roots.map((e) => e.textContent ?? "").join("\\n") + [...document.querySelectorAll("[data-def]")].map((e) => e.dataset.def).join("\\n"));
    const out = [];
    for (const w of A.sentinels) if (!text.includes(w)) out.push("sentinel " + w);
    // Images count only inside the three screen regions (not anywhere in the document)
    const shownImages = roots.flatMap((e) => [...e.querySelectorAll("img")]);
    for (const alt of A.images) if (!shownImages.some((i) => i.alt === alt) && !text.includes(flat(alt))) out.push("image " + alt);
    for (const k of A.codeKeys) if (!text.includes(flat(k))) out.push("code " + k);
    const drawn = roots.reduce((n, e) => n + e.querySelectorAll(".mermaid-ok").length, 0);
    if (drawn < A.mermaid) out.push("diagrams " + drawn + "/" + A.mermaid);
    return out;
  })())`);
}

/** The text of every preview that is on screen (display is not none) */
const visiblePreviews = () => ev<string[]>(`JSON.stringify([...document.querySelectorAll("#decision .opt .opt-preview")].filter((p) => getComputedStyle(p).display !== "none").map((p) => p.textContent))`);

if (REQUIRE_BROWSER) {
  test("UKAGAI_REQUIRE_BROWSER=1: agent-browser is on PATH", () => {
    assert.ok(HAS_BROWSER, "agent-browser is not on PATH; the GUI preserve test would be skipped and guard nothing");
  });
}

test("the fixture list is not empty and holds the fixtures that matter", () => {
  const files = passCases().map((c) => c.file);
  assert.ok(files.length > 0);
  for (const f of ["pass-media-in-sections.md", "pass-diagram-under-options.md"]) assert.ok(files.includes(f), `${f} is missing`);
});

for (const c of passCases()) {
  gui(`keeps every atom of ${c.file}`, async () => {
    await seed(c);
    await reopen();
    // Mermaid is drawn after the page is built: poll until nothing is missing, then report what is
    let missing = missingOnPage(c);
    for (const end = Date.now() + 5000; missing.length && Date.now() < end; ) {
      await sleep(200);
      missing = missingOnPage(c);
    }
    assert.deepEqual(missing, [], `${c.file}: not on the page`);
    // The option's preview shows under the cursor card only (the first card of every fixture)
    assert.deepEqual(visiblePreviews(), ["KEEPPREVIEW0"], "previews on screen");
    // Terms leave the left column for the list behind `?`: every term is there
    const terms = c.kind === "decision" && /^## (?:Terms|用語)\s*$/m.test(c.markdown) ? (/^## (?:Terms|用語)\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(c.markdown)?.[1]?.match(/^[-*] /gm)?.length ?? 0) : 0;
    if (terms) {
      ab("press", "?");
      assert.equal(ev<number>(`document.querySelectorAll(".overlay.terms dt").length`), terms, "the Terms list");
      ab("press", "Escape");
    }
  });
}

gui("an image placed above the Options table loads", async () => {
  const c = passCases().find((x) => x.file === "pass-media-in-sections.md")!;
  await seed(c);
  await reopen();
  const img = `[...document.images].find((i) => i.alt === "KEEPALTOPTBEFORE")`;
  const end = Date.now() + 5000;
  for (;;) {
    // loading="lazy": bring the image into the viewport before waiting for it
    if (ev<boolean>(`(() => { const i = ${img}; if (!i) return false; i.scrollIntoView(); return i.complete && i.naturalWidth > 0; })()`)) break;
    assert.ok(Date.now() < end, "the image above the Options table did not load");
    await sleep(200);
  }
});

/** Seed a decision with the field values of test/support/question-fields.ts */
async function seedFields(explained: boolean, multiSelect = false): Promise<string> {
  const n = ++seq;
  const d = await api("/api/decisions", {
    tool_use_id: `toolu_gui_fields_${process.pid}_${n}`,
    kind: "answer_question",
    session: { session_id: `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`, cwd: ROOT, transcript_path: join(home, ".claude", "projects", "p", "none.jsonl") },
    request: { questions: [{ question: V.question, header: V.header, options: fieldOptions(), multiSelect }] },
    ...(explained ? { explanation: { path: join(dataDir, "explain", "fields.md"), title: "Pick the cache layer", question: V.question, reversibility: "reversible", scope: "file", markdown: EXPLAINED_MD, has: { mermaid: false, table: true, diff: false }, match: "question", attached_via: "first_call" } } : {}),
  });
  assert.ok(d.id, `cannot create decision: ${JSON.stringify(d)}`);
  return d.id;
}

const pageHas = (word: string) => ev<boolean>(`(() => { const t = ["#head", "#background", "#decision"].map((s) => document.querySelector(s)?.textContent ?? "").join(" "); return t.includes(${JSON.stringify(word)}); })()`);

for (const mode of ["plain", "explained"] as const) {
  gui(`fields (${mode}): shown ones are on the page, hidden ones are not`, async () => {
    await seedFields(mode === "explained");
    await reopen();
    for (const r of FIELD_RULES) {
      const rule = r.gui?.[mode] ?? r[mode];
      if (rule === true) assert.ok(pageHas(r.word), `${r.field}: ${r.word} is not shown`);
      else assert.ok(!pageHas(r.word), `${r.field}: hidden (${rule}) but ${r.word} is on the page`);
    }
  });
}

gui("fields: multiSelect decides between radio buttons and checkboxes", async () => {
  await seedFields(false, true);
  await reopen();
  assert.equal(ev<number>(`document.querySelectorAll("#decision .opt input[type=checkbox]").length`), 4); // three options and the free text
  await cancelAll();
  await seedFields(false, false);
  await reopen();
  assert.equal(ev<number>(`document.querySelectorAll("#decision .opt input[type=checkbox]").length`), 0);
});

gui("preview: visible on the cursor card only, moves with the arrow key, and clicking it does not send the answer", async () => {
  const id = await seedFields(true);
  await reopen();
  assert.deepEqual(visiblePreviews(), [`${V.alpha.preview}`]);
  ab("press", "ArrowDown");
  assert.deepEqual(visiblePreviews(), [V.beta.preview]);
  // The preview is plain text: its tab and line break are kept, nothing in it is parsed
  ab("press", "ArrowUp");
  assert.equal(ev<string>(`getComputedStyle(document.querySelector("#decision .opt.cursor .opt-preview")).whiteSpace`), "pre");
  // A click on a one-click card sends it; a click on its preview must not. Poll for ~1.5 s: fail as soon as the decision leaves `pending`
  ab("click", "#decision .opt.cursor .opt-preview");
  for (const end = Date.now() + 1500; Date.now() < end; await sleep(100)) {
    const d = await api(`/api/decisions/${id}`);
    assert.equal(d.status, "pending", "a click on the preview closed the decision");
  }
  assert.equal((await api(`/api/decisions/${id}`)).response, undefined, "no answer was sent");
});

gui("preview: positive control: a click on the card itself (not on its preview) does send the answer", async () => {
  const id = await seedFields(true);
  await reopen();
  ab("click", "#decision .opt.cursor .lab");
  const end = Date.now() + 5000;
  for (;;) {
    const d = await api(`/api/decisions/${id}`);
    if (d.status === "answer_submitted") {
      assert.equal(Object.values(d.response.answers)[0], fieldOptions()[0]!.label, "the first card's label was sent");
      break;
    }
    assert.ok(Date.now() < end, `the click on the card never sent the answer (${d.status})`);
    await sleep(100);
  }
});
