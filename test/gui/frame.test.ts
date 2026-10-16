// An HTML page in a document (![alt](x.html), docs/spec/markdown.md 2.13) in the GUI: a sandboxed iframe, relative images inside it, full screen, a plan card.
// A real server (temp HOME) and a real browser (agent-browser). Skipped when agent-browser is not on PATH. Keys are sent as KeyboardEvents (eval).
import { after, before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttp } from "node:http";
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
// Three stacked 1180 x 700 blocks inside overflow-x:auto wrappers, like a comparison mock-up. The page's own script and onerror= would shrink the inline frame (they tell the parent h=5)
// if they ran: the frame is sandboxed with allow-scripts, but its CSP lets only ukagai's helper (by nonce) run
const HOSTILE = `parent.postMessage({ ukagai: "frame", w: 1, h: 5, zoom: 1, marker: "pwned" }, "*")`;
const BLOCK = '<div class="scroll" style="overflow-x:auto"><div style="min-width:1180px;height:700px;background:#dbeafe;border-bottom:2px solid #333">block</div></div>';
const PAGE = `<!doctype html><html><body style="margin:0"><h1>Variants</h1><img id="shot" src="a.png"><p style="background:url(a.png)">x</p>${BLOCK}${BLOCK}${BLOCK}<script>${HOSTILE}</script><img src="missing.png" onerror='${HOSTILE}'></body></html>`;
const ABSOLUTE = '<!doctype html><html><body style="margin:0"><div style="position:absolute;top:0;height:300px;width:100px;background:#fde68a">abs</div></body></html>';
const FLOAT = '<!doctype html><html><body style="margin:0"><div style="float:left;height:300px;width:100px;background:#fbcfe8">float</div></body></html>';
const SHORT = '<!doctype html><html><body style="margin:0"><div style="height:200px;background:#dcfce7">short</div></body></html>';

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
  writeFileSync(join(scratch, "ukagai", "short.html"), SHORT);
  writeFileSync(join(scratch, "ukagai", "absolute.html"), ABSOLUTE);
  writeFileSync(join(scratch, "ukagai", "float.html"), FLOAT);
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

const click = (label: string) => ev(`[...document.querySelectorAll(".overlay.frame .frame-btn")].find((b) => b.textContent === ${JSON.stringify(label)}).click(), "ok"`);
const zoomShown = () => text(".overlay.frame .frame-zoom");
const inlineHeight = () => ev<number>(`document.querySelector("${BG} iframe.doc-frame-view").getBoundingClientRect().height`);

gui("an explanation shows the page in a sandboxed iframe; the image inside loads; full screen opens the overlay and Esc closes it", async () => {
  // a recorder in the parent before the page exists: the explanation arrives live, so the recorder survives to see every message of the frame
  ab("open", base + "/");
  await waitFor("idle", `document.getElementById("empty") && !document.getElementById("empty").hidden`);
  ev(`window.__msgs = [], window.addEventListener("message", (e) => window.__msgs.push(e.data)), "ok"`);
  const { id } = await seedDoc(EXPL);
  await waitFor("frame", `document.querySelector("${BG} figure.doc-frame iframe")`, 15000);
  const src = `/api/files?decision=${id}&path=${encodeURIComponent("compare.html")}`;
  assert.equal(ev<string>(`document.querySelector("${BG} iframe.doc-frame-view").getAttribute("src")`), src);
  assert.equal(ev<string>(`document.querySelector("${BG} iframe.doc-frame-view").getAttribute("sandbox")`), "allow-scripts"); // never allow-same-origin
  assert.equal(text(`${BG} .doc-frame-alt`), "比較");
  assert.equal(text(`${BG} .doc-frame-bar .chip`), "compare.html");
  assert.equal(text(`${BG} .doc-frame-full`), "Full screen");
  assert.equal(text(`${BG} .doc-frame-open`), "Open in new tab");
  assert.equal(ev<string>(`document.querySelector("${BG} .doc-frame-open").getAttribute("href")`), src);
  assert.equal(ev<string>(`document.querySelector("${BG} .doc-frame-open").getAttribute("target") + "|" + document.querySelector("${BG} .doc-frame-open").getAttribute("rel")`), "_blank|noopener");
  assert.equal(count(`${BG} .doc-img`), 0);
  // the page's own <img src="a.png"> is rewritten and served (a 200), and in the real frame it has loaded
  assert.equal(Number(frameImageStatus()), 200);
  // the frame's height follows its content (the page is tall: up to 70% of the window), not a fixed 480px. The page's own script / onerror= told the parent h=5: they did not run
  await waitFor("inline height follows the content", `Math.round(document.querySelector("${BG} iframe.doc-frame-view").getBoundingClientRect().height) === 630`);
  // the page's <script> and onerror= posted a message with a marker: neither ran (the helper's own reports carry none)
  const msgs = ev<any[]>(`JSON.stringify(window.__msgs)`);
  assert.ok(msgs.some((m) => m?.ukagai === "frame"), "the helper reported");
  assert.equal(msgs.filter((m) => m?.marker === "pwned").length, 0);
  ab("screenshot", join(SHOTS, "doc-frame-inline.png"));
  // a message that does not come from a frame in the document is ignored
  ev(`window.postMessage({ ukagai: "frame", w: 1, h: 5, zoom: 1 }, "*"), "ok"`);
  await sleep(300);
  assert.equal(inlineHeight(), 630);
  // full screen
  ev(`document.querySelector("${BG} .doc-frame-full").click(), "ok"`);
  await waitFor("overlay", `document.querySelector(".overlay.frame iframe.frame-full")`);
  assert.equal(ev<string>(`document.querySelector(".overlay.frame iframe").getAttribute("sandbox")`), "allow-scripts");
  assert.equal(ev<boolean>(`document.getElementById("main").inert`), true);
  assert.equal(ev<string>(`document.querySelector(".overlay.frame iframe").getAttribute("src")`), src);
  // the overlay fills the window (real full screen, or the fallback), the bar is on top, and the iframe takes the rest at full width: no scroll outside the iframe
  const geo = ev<{ w: number; h: number; cw: number; ch: number; fx: number; fw: number; fb: number; scroll: boolean }>(`JSON.stringify((() => {
    const r = document.querySelector(".overlay.frame .overlay-card").getBoundingClientRect(), f = document.querySelector(".overlay.frame iframe").getBoundingClientRect(), c = document.querySelector(".overlay.frame .overlay-card");
    return { w: innerWidth, h: innerHeight, cw: r.width, ch: r.height, fx: f.x, fw: f.width, fb: f.bottom, scroll: c.scrollHeight > c.clientHeight || c.scrollWidth > c.clientWidth };
  })())`);
  assert.deepEqual([geo.cw, geo.ch, geo.fx, geo.fw, geo.fb, geo.scroll], [geo.w, geo.h, 0, geo.w, geo.h, false]);
  assert.equal(text(".overlay.frame .frame-title"), "比較");
  for (const l of ["Fit", "100%", "−", "+", "Open in new tab", "Close"]) assert.equal(ev<boolean>(`[...document.querySelectorAll(".overlay.frame .frame-bar button, .overlay.frame .frame-bar a")].some((b) => b.textContent === ${JSON.stringify(l)})`), true, l);
  await waitFor("zoom shown", `document.querySelector(".overlay.frame .frame-zoom").textContent === "100%"`);
  ab("screenshot", join(SHOTS, "doc-frame-full-100.png"));
  // Fit shows the whole page (the page is 2100+ px tall, the window 900), + / − / 100% change the zoom
  click("Fit");
  await waitFor("fit", `parseInt(document.querySelector(".overlay.frame .frame-zoom").textContent) < 60`);
  const fit = parseInt(zoomShown());
  assert.ok(fit > 20 && fit < 60, zoomShown());
  ab("screenshot", join(SHOTS, "doc-frame-full-fit.png"));
  click("100%");
  await waitFor("100%", `document.querySelector(".overlay.frame .frame-zoom").textContent === "100%"`);
  click("+");
  await waitFor("125%", `document.querySelector(".overlay.frame .frame-zoom").textContent === "125%"`);
  click("−");
  click("−");
  await waitFor("80%", `document.querySelector(".overlay.frame .frame-zoom").textContent === "80%"`);
  key("+");
  await waitFor("100% again by a key", `document.querySelector(".overlay.frame .frame-zoom").textContent === "100%"`);
  key("f");
  await waitFor("fit by a key", `parseInt(document.querySelector(".overlay.frame .frame-zoom").textContent) < 60`);
  key("0");
  await waitFor("100% by a key", `document.querySelector(".overlay.frame .frame-zoom").textContent === "100%"`);
  key("Escape");
  await waitFor("overlay closed", `!document.querySelector(".overlay.frame")`);
  assert.equal(ev<boolean>(`document.getElementById("main").inert`), false);
  ab("screenshot", join(SHOTS, "doc-frame.png"));
});

gui("a short page makes a short inline frame", async () => {
  await seedDoc(EXPL.replace("compare.html", "short.html"));
  ab("open", base + "/");
  await waitFor("frame", `document.querySelector("${BG} figure.doc-frame iframe")`, 15000);
  await waitFor("height follows the content", `Math.round(document.querySelector("${BG} iframe.doc-frame-view").getBoundingClientRect().height) === 200`);
});

const heights = async (n: number) => { const out: number[] = []; for (let i = 0; i < n; i++) { out.push(Math.round(inlineHeight())); await sleep(200); } return out; };

gui("a page of only absolutely positioned (or floated) content settles on one height", async () => {
  for (const name of ["absolute.html", "float.html"]) {
    await seedDoc(EXPL.replace("compare.html", name));
    ab("open", base + "/");
    await waitFor("frame", `document.querySelector("${BG} figure.doc-frame iframe")`, 15000);
    await waitFor(`${name} height`, `Math.round(document.querySelector("${BG} iframe.doc-frame-view").getBoundingClientRect().height) === 300`);
    assert.deepEqual([...new Set(await heights(10))], [300], name);
    await cancelAll();
  }
});

gui("a page cannot navigate the frame: meta refresh and a link to another site go nowhere", async () => {
  const hits: string[] = [];
  const land = createHttp((req, res) => {
    hits.push(req.url ?? "");
    res.setHeader("content-type", "text/html");
    res.end('<script>parent.postMessage({ ukagai: "frame", w: 1, h: 7, zoom: 1, marker: "landed" }, "*")</script>landed');
  });
  await new Promise<void>((r) => land.listen(0, "127.0.0.1", r));
  const LAND = `http://127.0.0.1:${(land.address() as { port: number }).port}/landed`;
  try {
    writeFileSync(join(scratch, "ukagai", "nav.html"), `<!doctype html><html><head><meta http-equiv="refresh" content="0;url=${LAND}"><META HTTP-EQUIV="Refresh" content="1;url=${LAND}"></head><body style="margin:0"><a id="ext" href="${LAND}" target="_top" style="display:block;height:100px;background:#e0e7ff">external</a><div style="height:300px">x</div></body></html>`);
    ab("open", base + "/");
    await waitFor("idle", `document.getElementById("empty") && !document.getElementById("empty").hidden`);
    ev(`window.__msgs = [], window.addEventListener("message", (e) => window.__msgs.push(e.data)), "ok"`);
    await seedDoc(EXPL.replace("compare.html", "nav.html"));
    await waitFor("frame", `document.querySelector("${BG} figure.doc-frame iframe")`, 15000);
    await waitFor("height", `Math.round(document.querySelector("${BG} iframe.doc-frame-view").getBoundingClientRect().height) === 400`);
    await sleep(2500); // past the second refresh
    // a real click on the link
    const r = ev<{ x: number; y: number }>(`JSON.stringify((() => { const b = document.querySelector("${BG} iframe.doc-frame-view").getBoundingClientRect(); return { x: b.x + 30, y: b.y + 30 }; })())`);
    ab("mouse", "move", String(Math.round(r.x)), String(Math.round(r.y)));
    ab("mouse", "down");
    ab("mouse", "up");
    await sleep(1500);
    const msgs = ev<any[]>(`JSON.stringify(window.__msgs)`);
    assert.equal(msgs.filter((m) => m?.marker === "landed").length, 0);
    assert.ok(msgs.filter((m) => m?.ukagai === "frame").length > 0, "the helper is still the frame's script");
    assert.deepEqual(hits, [], "the other site was never requested");
    assert.equal(Math.round(inlineHeight()), 400);
  } finally {
    land.close();
  }
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
  assert.equal(ev<string>(`document.querySelector("${BG} iframe.doc-frame-view").getAttribute("sandbox")`), "allow-scripts");
  assert.equal(Number(frameImageStatus()), 200);
  ev(`document.querySelector("${BG} .doc-frame-full").click(), "ok"`);
  await waitFor("overlay", `document.querySelector(".overlay.frame iframe.frame-full")`);
  key("Escape");
  await waitFor("overlay closed", `!document.querySelector(".overlay.frame")`);
  rmSync(join(home, ".claude", "plans", name), { force: true });
});
