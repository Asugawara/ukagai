// An HTML page in a document (![alt](x.html), docs/spec/markdown.md 2.13) in the GUI: a sandboxed iframe, relative images inside it, full screen, a plan card.
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
const session = `ukagai-frame-${process.pid}-${Date.now().toString(36)}`;

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

const QUESTION = "Which header variant, A or B?";
const PAGE = '<!doctype html><html><body style="margin:0"><h1>Variants</h1><img id="shot" src="a.png"><p style="background:url(a.png)">x</p><script>document.body.dataset.ran = "1"</script></body></html>';

async function planSession(slug: string): Promise<void> {
  const tpath = join(home, ".claude", "projects", "p", `${slug}.jsonl`);
  mkdirSync(join(home, ".claude", "projects", "p"), { recursive: true });
  writeFileSync(tpath, `{"type":"user","slug":"${slug}"}\n`);
  await fetch(base + "/api/events", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ session_id: `s-${slug}`, transcript_path: tpath, cwd: ROOT, hook_event_name: "Stop", received_at: new Date().toISOString() }), // Stop: the session is idle, so the plan is ready (PlanReady)
  });
}

before(async () => {
  if (!HAS_BROWSER) return;
  home = mkdtempSync(join(tmpdir(), "ukagai-frame-"));
  top = mkdtempSync(join(tmpdir(), "claude-ukagai-frame-"));
  scratch = join(top, "-proj", "sess-frame", "scratchpad");
  mkdirSync(join(scratch, "ukagai"), { recursive: true });
  writeFileSync(join(scratch, "ukagai", "a.png"), png(120, 80, [37, 99, 235]));
  writeFileSync(join(scratch, "ukagai", "compare.html"), PAGE);
  mkdirSync(join(home, ".claude", "plans"), { recursive: true });
  writeFileSync(join(home, ".claude", "plans", "a.png"), png(120, 80, [22, 163, 74]));
  writeFileSync(join(home, ".claude", "plans", "plan-compare.html"), PAGE);
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
  test(`GUI html frame: ${name}`, { skip: HAS_BROWSER ? false : "agent-browser is not installed" }, async (t) => {
    await cancelAll();
    ab("set", "viewport", "1440", "900");
    try { await fn(t); } finally { await cancelAll(); }
  });
}

async function seedDoc(markdown: string): Promise<{ id: string }> {
  const docPath = join(scratch, "ukagai", "ex.md");
  writeFileSync(docPath, markdown);
  const d = await api("/api/decisions", {
    tool_use_id: `toolu_fr_${process.pid}_${Date.now()}`,
    kind: "answer_question",
    session: { session_id: "00000000-0000-0000-0009-000000000002", cwd: ROOT, transcript_path: join(home, ".claude", "projects", "p", "none.jsonl"), scratchpad_dir: scratch },
    request: { questions: [{ question: QUESTION, header: "Header", multiSelect: false, options: [{ label: "A (Recommended)", description: "A" }, { label: "B", description: "B" }] }] },
    explanation: { path: docPath, markdown, has: { mermaid: false, table: false, diff: false }, match: "question", attached_via: "first_call" },
  });
  assert.ok(d.id, JSON.stringify(d));
  void api(`/api/decisions/${d.id}/wait?timeout_ms=60000`).catch(() => {});
  return { id: d.id };
}

const BG = "#background";
const EXPL = `---\nukagai: 1\n---\n## Why this decision is needed now\n\nCompare the variants:\n\n![比較](compare.html)\n\nAfter.\n`;

/** The frame's document fetched as the browser did; its image is then fetched with no cookie (a sandboxed frame sends none): the tag must authorise it */
const frameImageStatus = () => ev<number | string>(`(async () => { const f = document.querySelector("${BG} iframe.doc-frame-view"); const r = await fetch(f.getAttribute("src")); const html = await r.text(); const m = /<img id="shot" src="([^"]+)"/.exec(html); return m ? (await fetch(m[1].replace(/&amp;/g, "&"), { credentials: "omit" })).status : "no img"; })().then((v) => JSON.stringify(v))`);

gui("an explanation shows the page in a sandboxed iframe; the image inside loads; full screen opens the overlay and Esc closes it", async () => {
  const { id } = await seedDoc(EXPL);
  ab("open", base + "/");
  await waitFor("frame", `document.querySelector("${BG} figure.doc-frame iframe")`, 15000);
  assert.equal(ev<string>(`document.querySelector("${BG} iframe.doc-frame-view").getAttribute("src")`), `/api/files?decision=${id}&path=${encodeURIComponent("compare.html")}`);
  assert.equal(ev<boolean>(`document.querySelector("${BG} iframe.doc-frame-view").getAttribute("sandbox") === ""`), true);
  assert.equal(ev<number>(`document.querySelector("${BG} iframe.doc-frame-view").getBoundingClientRect().height`), 480);
  assert.equal(text(`${BG} .doc-frame-alt`), "比較");
  assert.equal(text(`${BG} .doc-frame-bar .chip`), "compare.html");
  assert.equal(text(`${BG} .doc-frame-full`), "Full screen");
  assert.equal(count(`${BG} .doc-img`), 0);
  // the page's own <img src="a.png"> is rewritten and served (a 200), and in the real frame it has loaded
  assert.equal(Number(frameImageStatus()), 200);
  await waitFor("page loaded in the frame", `(() => { const f = document.querySelector("${BG} iframe.doc-frame-view"); f.scrollIntoView(); return f.contentWindow === null ? false : true; })()`);
  // full screen
  ev(`document.querySelector("${BG} .doc-frame-full").click(), "ok"`);
  await waitFor("overlay", `document.querySelector(".overlay.frame iframe.frame-full")`);
  assert.equal(ev<boolean>(`document.querySelector(".overlay.frame iframe").getAttribute("sandbox") === ""`), true);
  assert.equal(ev<boolean>(`document.getElementById("main").inert`), true);
  assert.equal(ev<string>(`document.querySelector(".overlay.frame iframe").getAttribute("src")`), `/api/files?decision=${id}&path=${encodeURIComponent("compare.html")}`);
  key("Escape");
  await waitFor("overlay closed", `!document.querySelector(".overlay.frame")`);
  assert.equal(ev<boolean>(`document.getElementById("main").inert`), false);
  ab("screenshot", join(SHOTS, "doc-frame.png"));
});

gui("an external .html URL is still dropped", async () => {
  await seedDoc(EXPL.replace("After.", "![ext](https://example.com/x.html)\n"));
  ab("open", base + "/");
  await waitFor("frame", `document.querySelector("${BG} figure.doc-frame iframe")`, 15000);
  assert.equal(count(`${BG} iframe`), 1);
  assert.equal(count(`${BG} iframe[src*="example.com"]`), 0);
});

gui("a plan card shows the page through plan=<name>", async () => {
  const name = "frame-plan.md";
  ab("open", base + "/");
  await waitFor("idle", `document.getElementById("empty") && !document.getElementById("empty").hidden`);
  await planSession("frame-plan");
  writeFileSync(join(home, ".claude", "plans", name), "# Frame plan\n\n## One\n\n![Plan page](plan-compare.html)\n\n## Two\n\nx\n");
  await waitFor("plan frame", `document.querySelector("${BG} figure.doc-frame iframe")`, 10000);
  assert.equal(ev<string>(`document.querySelector("${BG} iframe.doc-frame-view").getAttribute("src")`), `/api/files?plan=${encodeURIComponent(name)}&path=${encodeURIComponent("plan-compare.html")}`);
  assert.equal(ev<boolean>(`document.querySelector("${BG} iframe.doc-frame-view").getAttribute("sandbox") === ""`), true);
  assert.equal(Number(frameImageStatus()), 200);
  ev(`document.querySelector("${BG} .doc-frame-full").click(), "ok"`);
  await waitFor("overlay", `document.querySelector(".overlay.frame iframe.frame-full")`);
  key("Escape");
  await waitFor("overlay closed", `!document.querySelector(".overlay.frame")`);
  rmSync(join(home, ".claude", "plans", name), { force: true });
});
