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
  const options = c.labels.map((label, i) => ({ label: i === 0 && c.kind === "decision" ? `${label} (Recommended)` : label, description: `About ${label}` }));
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
    const flat = (s) => s.replace(/\\s/g, "");
    const roots = ["#head", "#background", "#decision"].map((s) => document.querySelector(s)).filter(Boolean);
    const text = flat(roots.map((e) => e.textContent ?? "").join("\\n") + [...document.querySelectorAll("[data-def]")].map((e) => e.dataset.def).join("\\n"));
    const out = [];
    for (const w of A.sentinels) if (!text.includes(w)) out.push("sentinel " + w);
    for (const alt of A.images) if (![...document.images].some((i) => i.alt === alt) && !text.includes(flat(alt))) out.push("image " + alt);
    for (const k of A.codeKeys) if (!text.includes(flat(k))) out.push("code " + k);
    const drawn = roots.reduce((n, e) => n + e.querySelectorAll(".mermaid-ok").length, 0);
    if (drawn < A.mermaid) out.push("diagrams " + drawn + "/" + A.mermaid);
    return out;
  })())`);
}

if (REQUIRE_BROWSER) {
  test("UKAGAI_REQUIRE_BROWSER=1: agent-browser is on PATH", () => {
    assert.ok(HAS_BROWSER, "agent-browser is not on PATH; the GUI preserve test would be skipped and guard nothing");
  });
}

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
