// An HTML page in a document (![alt](x.html), docs/spec/markdown.md 2.13) in the GUI: a sandboxed iframe, relative images inside it, full screen, a plan card.
// A real server (temp HOME) and a real browser (agent-browser). Skipped when agent-browser is not on PATH. Keys are sent as KeyboardEvents (eval).
import { after, before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttp } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { FRAME_POLICY } from "../../src/serve/files.js";
import { FRAME_HELPER } from "../../src/serve/frame-helper.js";
import { optInPlanAutoShow } from "../support/plans-auto.js";

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

let current = session; // the browser session the helpers drive (the no-csp test runs its own)
function ab(...args: string[]): string {
  return execFileSync("agent-browser", args, { env: { ...process.env, AGENT_BROWSER_SESSION: current }, encoding: "utf8", timeout: 30000 }).trim();
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
// if they ran: the frame is sandboxed with allow-scripts, but its CSP lets only ukagai's helper (by hash) run
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
  optInPlanAutoShow(dataDir);
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
  lastId = d.id;
  return { id: d.id };
}

const BG = "#background";
const EXPL = `---\nukagai: 1\n---\n## Why this decision is needed now\n\nCompare the variants:\n\n![比較](compare.html)\n\nAfter.\n`;

/** The frame's document fetched as the browser did; its image is then fetched with no cookie (a sandboxed frame sends none): the tag must authorise it */
const frameImageStatus = () => ev<number | string>(`(async () => { const f = document.querySelector("${BG} iframe.doc-frame-view"); const r = await fetch(f.getAttribute("src")); const html = await r.text(); const m = /<img id="shot" src="([^"]+)"/.exec(html); return m ? (await fetch(m[1].replace(/&amp;/g, "&"), { credentials: "omit" })).status : "no img"; })().then((v) => JSON.stringify(v))`);

/** The id of the decision on screen (the one the test seeded; every test cancels the others first) */
let lastId = "";
const shownDecisionId = () => lastId;
const click = (label: string) => ev(`[...document.querySelectorAll(".overlay.frame .frame-btn")].find((b) => b.textContent === ${JSON.stringify(label)}).click(), "ok"`);
const zoomShown = () => text(".overlay.frame .frame-zoom");
/** Chromium's iframe `csp` attribute (CSP Embedded Enforcement); without it the frames have no scripts at all (sandbox="") */
const supportsCsp = () => ev<boolean>(`"csp" in HTMLIFrameElement.prototype`);
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
  if (!supportsCsp()) { // no CSP Embedded Enforcement: the frame has no scripts at all, no zoom controls, a fixed inline height; full screen and a new tab still work
    assert.equal(ev<string>(`document.querySelector("${BG} iframe.doc-frame-view").getAttribute("sandbox")`), "");
    assert.equal(ev<boolean>(`document.querySelector("${BG} iframe.doc-frame-view").hasAttribute("csp")`), false);
    assert.equal(Math.round(inlineHeight()), 480);
    ev(`document.querySelector("${BG} .doc-frame-full").click(), "ok"`);
    await waitFor("overlay", `document.querySelector(".overlay.frame iframe.frame-full")`);
    assert.equal(ev<string>(`document.querySelector(".overlay.frame iframe").getAttribute("sandbox")`), "");
    assert.equal(count(".overlay.frame .frame-zoom"), 0);
    assert.equal(count(".overlay.frame .frame-bar button"), 2, "only Comment on this page and Close are left");
    key("Escape");
    return;
  }
  const frameAttrs = (sel: string) => ev<string>(`(() => { const f = document.querySelector(${JSON.stringify(sel)}); return f.getAttribute("sandbox") + "|" + f.getAttribute("csp"); })()`);
  // never allow-same-origin; the csp attribute is the server's policy verbatim (data-frame-csp on <html>)
  assert.equal(frameAttrs(`${BG} iframe.doc-frame-view`), `allow-scripts|${FRAME_POLICY}`);
  assert.equal(ev<string>(`document.documentElement.getAttribute("data-frame-csp")`), FRAME_POLICY);
  assert.equal(text(`${BG} .doc-frame-alt`), "比較");
  assert.equal(text(`${BG} .doc-frame-bar .chip`), "compare.html");
  assert.equal(text(`${BG} .doc-frame-full`), "Full screen");
  assert.equal(text(`${BG} .doc-frame-open`), "Open in new tab");
  assert.equal(ev<string>(`document.querySelector("${BG} .doc-frame-open").getAttribute("href")`), `${src}&view=tab`); // the script-free view
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
  assert.equal(frameAttrs(".overlay.frame iframe"), `allow-scripts|${FRAME_POLICY}`);
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

// The frame is sandboxed with allow-scripts, which applies to every document it navigates to. What keeps another site's script out is the iframe's `csp` attribute (CSP Embedded Enforcement):
// a document that does not carry the policy is refused, one that opts in can run only the helper. The server also neutralises the usual ways to navigate (http-equiv, declarative shadow roots) and the helper stops plain links,
// but those are extras: the parent navigates the frame itself below, which only the `csp` attribute can stop
gui("another site never runs a script in the frame, however the frame got there", async () => {
  const hits: string[] = [];
  const LANDED = '<script>parent.postMessage({ ukagai: "frame", w: 1, h: 7, zoom: 1, marker: "landed" }, "*"); fetch("/beacon", { mode: "no-cors" })</script>landed';
  const land = createHttp((req, res) => {
    hits.push(req.url ?? "");
    res.setHeader("content-type", "text/html");
    if (req.url?.startsWith("/optin")) res.setHeader("Allow-CSP-From", "*");
    res.end(req.url === "/beacon" ? "ok" : LANDED);
  });
  await new Promise<void>((r) => land.listen(0, "127.0.0.1", r));
  const LAND = `http://127.0.0.1:${(land.address() as { port: number }).port}`;
  try {
    // a meta refresh, a closed declarative shadow DOM link (both inert after the rewrite) and a plain link without target (stopped by the helper)
    writeFileSync(join(scratch, "ukagai", "nav.html"), `<!doctype html><html><head><meta http-equiv="refresh" content="0;url=${LAND}/landed?refresh"><META HTTP-EQUIV="Refresh" content="1;url=${LAND}/landed?refresh2"></head><body style="margin:0"><a id="ext" href="${LAND}/landed?link" style="display:block;height:100px;background:#e0e7ff">external</a><div><template shadowrootmode="closed"><a href="${LAND}/landed?dsd" style="display:block;height:50px">shadow</a></template></div><div style="height:250px">x</div></body></html>`);
    ab("open", base + "/");
    await waitFor("idle", `document.getElementById("empty") && !document.getElementById("empty").hidden`);
    ev(`window.__msgs = [], window.addEventListener("message", (e) => window.__msgs.push(e.data)), "ok"`);
    await seedDoc(EXPL.replace("compare.html", "nav.html"));
    await waitFor("frame", `document.querySelector("${BG} figure.doc-frame iframe")`, 15000);
    if (supportsCsp()) await waitFor("height", `Math.round(document.querySelector("${BG} iframe.doc-frame-view").getBoundingClientRect().height) === 350`);
    await sleep(2500); // past the second refresh
    const click = ev<{ x: number; y: number }>(`JSON.stringify((() => { const b = document.querySelector("${BG} iframe.doc-frame-view").getBoundingClientRect(); return { x: b.x + 30, y: b.y + 30 }; })())`);
    ab("mouse", "move", String(Math.round(click.x)), String(Math.round(click.y)));
    ab("mouse", "down");
    ab("mouse", "up");
    await sleep(1500);
    // navigations that no in-page defence can stop: the frame is sent to a page with no policy, and to one that opts in with Allow-CSP-From: *
    for (const url of [`${LAND}/landed?parent`, `${LAND}/optin?parent`]) {
      ev(`document.querySelector("${BG} iframe.doc-frame-view").src = ${JSON.stringify(url)}, "ok"`);
      await sleep(1500);
    }
    const msgs = ev<any[]>(`JSON.stringify(window.__msgs)`);
    assert.equal(msgs.filter((m) => m?.marker === "landed").length, 0, "the other site's script never ran");
    assert.deepEqual(hits.filter((u) => u.startsWith("/beacon")), [], "and its fetch never left");
    assert.ok(!hits.some((u) => u.startsWith("/landed?refresh") || u.startsWith("/landed?dsd")), `meta refresh and the shadow link were never followed: ${hits.join(" ")}`);
  } finally {
    land.close();
  }
});

// Browsers without the iframe `csp` attribute (Firefox, Safari): CI's Chromium has it, so a second browser session deletes it before the GUI loads (an init script)
gui("without iframe csp support the frames are sandbox=\"\": no script, no zoom controls, a fixed height, and another site's script still never runs", async () => {
  const hits: string[] = [];
  const land = createHttp((req, res) => {
    hits.push(req.url ?? "");
    res.setHeader("content-type", "text/html");
    res.end(req.url === "/beacon" ? "ok" : '<script>parent.postMessage({ ukagai: "frame", w: 1, h: 7, zoom: 1, marker: "landed" }, "*"); fetch("/beacon", { mode: "no-cors" })</script>landed');
  });
  await new Promise<void>((r) => land.listen(0, "127.0.0.1", r));
  const LAND = `http://127.0.0.1:${(land.address() as { port: number }).port}`;
  const initScript = join(top, "no-csp-attribute.js");
  writeFileSync(initScript, "delete HTMLIFrameElement.prototype.csp;\n");
  const outer = current;
  current = `${session}-nocsp`;
  try {
    ab("open", base + "/", "--init-script", initScript, "--viewport", "1440x900");
    await waitFor("idle", `document.getElementById("empty") && !document.getElementById("empty").hidden`);
    assert.equal(supportsCsp(), false, "the init script removed the attribute");
    ev(`window.__msgs = [], window.addEventListener("message", (e) => window.__msgs.push(e.data)), "ok"`);
    await seedDoc(EXPL);
    await waitFor("frame", `document.querySelector("${BG} figure.doc-frame iframe")`, 15000);
    const attrs = (sel: string) => ev<string>(`(() => { const f = document.querySelector(${JSON.stringify(sel)}); return f.getAttribute("sandbox") + "|" + f.hasAttribute("csp"); })()`);
    assert.equal(attrs(`${BG} iframe.doc-frame-view`), "|false");
    await sleep(1500); // a helper would have resized it by now
    assert.equal(Math.round(inlineHeight()), 480);
    ev(`document.querySelector("${BG} .doc-frame-full").click(), "ok"`);
    await waitFor("overlay", `document.querySelector(".overlay.frame iframe.frame-full")`);
    assert.equal(attrs(".overlay.frame iframe"), "|false");
    assert.equal(count(".overlay.frame .frame-zoom"), 0);
    assert.deepEqual(texts(".overlay.frame .frame-bar button, .overlay.frame .frame-bar a"), ["Comment on this page", "Open in new tab", "Close"], "no zoom / Fit controls");
    key("Escape");
    await waitFor("overlay closed", `!document.querySelector(".overlay.frame")`);
    // no helper to pick an element with: the button comments on the whole page (an element comment without a selector)
    assert.equal(text(`${BG} .doc-frame-pick .btn-text`), "Comment on this page");
    ev(`document.querySelector("${BG} .doc-frame-pick").click(), "ok"`);
    await waitFor("popover", `document.querySelector(".cmt-pop .cmt-pop-ta")`);
    assert.match(text(".cmt-pop .cmt-pop-q"), /^Whole page/);
    ev(`(() => { const t = document.querySelector(".cmt-pop-ta"); t.value = "tighten the header"; t.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
    ev(`document.querySelector(".cmt-pop-ta").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true })), "ok"`);
    await waitFor("comment stored", `localStorage.getItem("ukagai.comments.${shownDecisionId()}")`);
    const whole = ev<any>(`JSON.stringify(JSON.parse(localStorage.getItem("ukagai.comments.${shownDecisionId()}")).comments[0])`);
    assert.equal(whole.kind, "element");
    assert.equal(whole.selector, undefined, "whole page: no selector");
    assert.equal(whole.source.kind, "page");
    assert.equal(whole.source.file, join(scratch, "ukagai", "compare.html"));
    assert.equal(whole.note, "tighten the header");
    // the parent sends the frame to a page with no policy: a sandbox="" frame runs no script of it
    ev(`document.querySelector("${BG} iframe.doc-frame-view").src = ${JSON.stringify(`${LAND}/landed?parent`)}, "ok"`);
    await sleep(1500);
    assert.ok(hits.some((u) => u.startsWith("/landed?parent")), "the frame did load the page");
    assert.equal(ev<any[]>(`JSON.stringify(window.__msgs)`).filter((m) => m?.marker === "landed").length, 0, "its script never ran");
    assert.deepEqual(hits.filter((u) => u.startsWith("/beacon")), []);
  } finally {
    try { ab("close"); } catch {}
    current = outer;
    land.close();
  }
});

gui("a page that toggles its own content grows and shrinks back, however often", async () => {
  writeFileSync(join(scratch, "ukagai", "toggle.html"), '<!doctype html><html><head><style>#t{display:none}.box{display:none;height:400px;background:#fecaca}#t:checked~.box{display:block}label{display:block;height:150px;background:#e0e7ff}</style></head><body style="margin:0"><input type="checkbox" id="t"><label for="t">toggle</label><div class="box">box</div></body></html>');
  ab("open", base + "/");
  await waitFor("idle", `document.getElementById("empty") && !document.getElementById("empty").hidden`);
  await seedDoc(EXPL.replace("compare.html", "toggle.html"));
  await waitFor("frame", `document.querySelector("${BG} figure.doc-frame iframe")`, 15000);
  if (!supportsCsp()) return; // no helper: nothing measures the page
  const at = (h: number) => waitFor(`height ${h}`, `Math.round(document.querySelector("${BG} iframe.doc-frame-view").getBoundingClientRect().height) === ${h}`);
  await at(150);
  const r = ev<{ x: number; y: number }>(`JSON.stringify((() => { const b = document.querySelector("${BG} iframe.doc-frame-view").getBoundingClientRect(); return { x: b.x + 30, y: b.y + 30 }; })())`);
  const tap = async () => { ab("mouse", "move", String(Math.round(r.x)), String(Math.round(r.y))); ab("mouse", "down"); ab("mouse", "up"); await sleep(400); };
  for (let i = 0; i < 3; i++) {
    await tap();
    await at(550);
    await tap();
    await at(150);
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
  assert.equal(ev<string>(`document.querySelector("${BG} iframe.doc-frame-view").getAttribute("sandbox")`), supportsCsp() ? "allow-scripts" : "");
  assert.equal(Number(frameImageStatus()), 200);
  ev(`document.querySelector("${BG} .doc-frame-full").click(), "ok"`);
  await waitFor("overlay", `document.querySelector(".overlay.frame iframe.frame-full")`);
  key("Escape");
  await waitFor("overlay closed", `!document.querySelector(".overlay.frame")`);
  rmSync(join(home, ".claude", "plans", name), { force: true });
});

gui("the frame bar never breaks inside a word: two frames side by side in columns at 1280x800 (en and ja), narrower still", async () => {
  writeFileSync(join(scratch, "ukagai", "variant-a.html"), SHORT);
  writeFileSync(join(scratch, "ukagai", "variant-b.html"), SHORT);
  const md = `---\nukagai: 1\n---\n## Why this decision is needed now\n\n::: columns\n![Variant A](variant-a.html)\n\n---\n\n![Variant B](variant-b.html)\n:::\n`;
  ab("set", "viewport", "1280", "800");
  ab("open", base + "/");
  await waitFor("idle", `document.getElementById("empty") && !document.getElementById("empty").hidden`);
  await seedDoc(md);
  await waitFor("two frames", `document.querySelectorAll("${BG} figure.doc-frame").length === 2`, 15000);
  // every bar item keeps its text on one line (a line box as tall as one line of text), whatever the width
  const bar = () => ev<{ h: number[]; broken: string[]; rows: number[] }>(`JSON.stringify((() => {
    const bars = [...document.querySelectorAll("${BG} .doc-frame-bar")], broken = [];
    for (const b of bars) for (const e of b.querySelectorAll(".doc-frame-alt, .chip, .doc-frame-open, .doc-frame-full")) {
      const lh = parseFloat(getComputedStyle(e).lineHeight) || parseFloat(getComputedStyle(e).fontSize) * 1.5;
      if (e.getBoundingClientRect().height > lh + 12) broken.push(e.className + ":" + e.textContent);
      if (e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).textOverflow !== "ellipsis") broken.push("clipped " + e.className);
    }
    return { h: bars.map((b) => Math.round(b.getBoundingClientRect().height)), broken, rows: bars.map((b) => new Set([...b.children].map((e) => { const r = e.getBoundingClientRect(); return Math.round((r.top + r.bottom) / 2 / 4); })).size) };
  })())`);
  for (const lang of ["en", "ja"]) {
    ev(`document.documentElement.dataset.lang = ${JSON.stringify(lang)}, "ok"`);
    await sleep(300);
    const r = bar();
    assert.deepEqual(r.broken, [], `${lang}: ${JSON.stringify(r)}`);
    assert.equal(r.h[0], r.h[1], `${lang}: bars of equal height ${r.h}`);
    assert.deepEqual(r.rows, [1, 1], `${lang}: one row each`);
    // the buttons are icon-only here (the text stays as title / aria-label) and the names are whole
    const v = ev<{ icons: boolean[]; texts: boolean[]; cut: number; labels: string[] }>(`JSON.stringify((() => {
      const btns = [...document.querySelectorAll("${BG} .doc-frame-open, ${BG} .doc-frame-full")], names = [...document.querySelectorAll("${BG} .doc-frame-alt, ${BG} .doc-frame-bar .chip")];
      return { icons: btns.map((b) => getComputedStyle(b.querySelector("svg")).display !== "none"), texts: btns.map((b) => getComputedStyle(b.querySelector(".btn-text")).display !== "none"),
        cut: names.filter((e) => e.scrollWidth > e.clientWidth).length, labels: btns.map((b) => b.title === b.getAttribute("aria-label") && b.title.length > 0 ? b.title : "") };
    })())`);
    assert.deepEqual(v.icons, [true, true, true, true], `${lang}: icons`);
    assert.deepEqual(v.texts, [false, false, false, false], `${lang}: no button text`);
    assert.equal(v.cut, 0, `${lang}: alt and chip not truncated`);
    assert.ok(v.labels.every(Boolean), `${lang}: title and aria-label`);
  }
  ev(`document.documentElement.dataset.lang = "en", "ok"`);
  for (const w of [1000, 820, 640]) {
    ab("set", "viewport", String(w), "800");
    await sleep(300);
    const r = bar();
    assert.deepEqual(r.broken, [], `${w}px: ${JSON.stringify(r)}`);
  }
  // one column: the frame is wide, so the buttons keep their text
  await cancelAll();
  await seedDoc(`---\nukagai: 1\n---\n## Why this decision is needed now\n\n![Variant A](variant-a.html)\n`);
  await waitFor("wide frame", `document.querySelectorAll("${BG} figure.doc-frame").length === 1`, 15000);
  ab("set", "viewport", "1440", "900");
  await sleep(300);
  assert.equal(text(`${BG} .doc-frame-open`), "Open in new tab");
  assert.equal(ev<boolean>(`getComputedStyle(document.querySelector("${BG} .doc-frame-open .btn-text")).display !== "none" && getComputedStyle(document.querySelector("${BG} .doc-frame-open svg")).display === "none"`), true);
  assert.deepEqual(bar().broken, []);
  ab("set", "viewport", "1440", "900");
});

// ---- Comments on an element of a page ----
// agent-browser's mouse and frame commands do not reach a frame with an opaque origin (sandbox="allow-scripts" without allow-same-origin: no events arrive, `frame` cannot switch into it).
// So the helper is tested in an ordinary same-origin frame served by a small HTTP server (real mouse events, the real helper text, no CSP), and the parent's handling of its messages is tested
// in the real GUI by delivering the messages as the frame would (a MessageEvent whose source is the frame's window, which is the only thing the parent checks)
const PICK_PAGE = '<!doctype html><html><body style="margin:0"><button id="save" class="primary save" style="position:absolute;left:40px;top:60px;width:120px;height:40px;outline:1px dotted red">Save</button><ul style="position:absolute;top:120px;left:300px;margin:0;padding:0;list-style:none"><li class="item" style="height:20px">one</li><li class="item" style="height:20px">two</li></ul><p id="t" style="position:absolute;left:20px;top:200px;margin:0;font:20px sans-serif">Hello inline world</p></body></html>';

test("frame helper: pick, selection, marks and the rects it reports (same-origin frame, real mouse)", { skip: HAS_BROWSER ? false : "agent-browser is not installed" }, async () => {
  const srv = createHttp((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url === "/page") res.end(PICK_PAGE.replace("<body", `<body`).replace("</body>", `<script>${FRAME_HELPER}</script></body>`));
    else res.end('<!doctype html><html><body style="margin:0"><iframe id="f" src="/page" style="width:600px;height:400px;border:0"></iframe><script>window.__m=[];addEventListener("message",function(e){__m.push(e.data)});</script></body></html>');
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/`;
  const frame = (js: string) => `document.getElementById("f").contentWindow.${js}`;
  const post = (msg: object) => ev(`${frame("postMessage")}(${JSON.stringify(msg)}, "*"), "ok"`);
  const last = (kind: string) => ev<any>(`JSON.stringify(window.__m.filter((m) => m.ukagai === ${JSON.stringify(kind)}).at(-1) ?? null)`);
  const outline = (sel: string) => ev<string>(`(() => { const e = document.getElementById("f").contentDocument.querySelector(${JSON.stringify(sel)}); const c = getComputedStyle(e); return c.outlineStyle + " " + c.outlineColor + " " + c.outlineWidth; })()`);
  try {
    ab("set", "viewport", "800", "600");
    // the page is served by this process, so the open must not block it (ab is synchronous)
    await new Promise<void>((res, rej) => execFile("agent-browser", ["open", url], { env: { ...process.env, AGENT_BROWSER_SESSION: current }, timeout: 30000 }, (e) => (e ? rej(e) : res())));
    await waitFor("helper ready", `window.__m.some((m) => m.ukagai === "frame")`);
    // outlines while picking; the page's own inline outline comes back when the pointer leaves
    assert.equal(outline("#save"), "dotted rgb(255, 0, 0) 1px");
    post({ ukagai: "pick", on: true });
    ab("mouse", "move", "80", "80");
    await waitFor("outlined", `getComputedStyle(${frame("document.getElementById")}("save")).outlineStyle === "solid"`);
    assert.equal(outline("#save"), "solid rgb(219, 39, 119) 2px");
    ab("mouse", "move", "500", "350");
    await waitFor("restored", `getComputedStyle(${frame("document.getElementById")}("save")).outlineStyle === "dotted"`);
    assert.equal(outline("#save"), "dotted rgb(255, 0, 0) 1px", "the previous inline outline is back");
    // a click picks (and the click does not reach the page); picking is then off
    ab("mouse", "move", "80", "80");
    ab("mouse", "down");
    ab("mouse", "up");
    await waitFor("picked", `window.__m.some((m) => m.ukagai === "picked")`);
    assert.deepEqual(last("picked"), { ukagai: "picked", sel: "#save", tag: "button", text: "Save", rect: { x: 40, y: 60, w: 120, h: 40 } });
    ab("mouse", "move", "81", "81");
    await sleep(200);
    assert.equal(outline("#save"), "dotted rgb(255, 0, 0) 1px", "picking turned itself off");
    // zoom: getBoundingClientRect already includes the helper's zoom on <html>, so the rect is in the frame's viewport pixels as it is
    post({ ukagai: "zoom", value: 2 });
    await waitFor("zoomed", `window.__m.some((m) => m.ukagai === "frame" && m.zoom === 2)`);
    post({ ukagai: "pick", on: true });
    ab("mouse", "move", "200", "150");
    ab("mouse", "down");
    ab("mouse", "up");
    await waitFor("picked again", `window.__m.filter((m) => m.ukagai === "picked").length === 2`);
    assert.deepEqual(last("picked").rect, { x: 80, y: 120, w: 240, h: 80 });
    post({ ukagai: "zoom", value: 1 });
    await waitFor("zoom back", `window.__m.filter((m) => m.ukagai === "frame").at(-1).zoom === 1`);
    // the second list item: no id, a class shared with its sibling: tag.class:nth-of-type, and the selector finds exactly that element
    post({ ukagai: "pick", on: true });
    ab("mouse", "move", "310", "150");
    ab("mouse", "down");
    ab("mouse", "up");
    await waitFor("picked li", `window.__m.filter((m) => m.ukagai === "picked").length === 3`);
    const li = last("picked");
    assert.equal(li.tag, "li");
    assert.equal(li.text, "two");
    assert.equal(li.sel, "li.item:nth-of-type(2)");
    assert.equal(ev(`${frame("document.querySelectorAll")}(${JSON.stringify(li.sel)}).length`), 1);
    // Esc while picking: pick-cancel, no pick
    post({ ukagai: "pick", on: true });
    ev(`${frame("dispatchEvent")}(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })), "ok"`);
    await waitFor("cancelled", `window.__m.some((m) => m.ukagai === "pick-cancel")`);
    assert.equal(ev<number>(`window.__m.filter((m) => m.ukagai === "picked").length`), 3);
    // text selected in the page (picking is off): the quote, its surroundings, the element it sits in
    ab("mouse", "move", "22", "212");
    ab("mouse", "down");
    ab("mouse", "move", "150", "212");
    ab("mouse", "up");
    await waitFor("selected", `window.__m.some((m) => m.ukagai === "selected")`);
    const sel = last("selected");
    assert.match(sel.quote, /^Hello/);
    assert.equal(sel.sel, "#t");
    assert.equal(typeof sel.prefix, "string");
    assert.ok(sel.prefix.length <= 64 && sel.suffix.length <= 64 && sel.quote.length <= 500);
    assert.deepEqual(Object.keys(sel.rect).sort(), ["h", "w", "x", "y"]);
    // marks: outlined dashed, replaced by the next message, the page's own outline restored when cleared
    post({ ukagai: "marks", items: [{ n: 1, sel: "#save" }, { n: 2, sel: "li.item:nth-of-type(2)" }, { n: 3, sel: "no such (" }] });
    await waitFor("marked", `getComputedStyle(${frame("document.getElementById")}("save")).outlineStyle === "dashed"`);
    assert.equal(outline("li.item:nth-of-type(2)"), "dashed rgb(219, 39, 119) 2px");
    post({ ukagai: "marks", items: [{ n: 1, sel: "#t" }] });
    await waitFor("replaced", `getComputedStyle(${frame("document.getElementById")}("save")).outlineStyle === "dotted"`);
    assert.equal(outline("li.item:nth-of-type(2)").startsWith("none"), true);
    assert.equal(outline("#t").startsWith("dashed"), true);
    post({ ukagai: "marks", items: [] });
    await waitFor("cleared", `getComputedStyle(${frame("document.getElementById")}("t")).outlineStyle === "none"`);
  } finally {
    srv.close();
    ab("open", base + "/");
    ab("set", "viewport", "1440", "900");
  }
});

const writeNote = (note: string) => {
  ev(`(() => { const t = document.querySelector(".cmt-pop-ta"); t.value = ${JSON.stringify(note)}; t.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
  ev(`document.querySelector(".cmt-pop-ta").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true })), "ok"`);
};
const stored = (id: string) => ev<any[]>(`JSON.stringify(JSON.parse(localStorage.getItem("ukagai.comments.${id}") ?? '{"comments":[]}').comments)`);
/** Deliver `msg` to the GUI as if the (inline) frame had posted it: the parent only checks that event.source is the frame's window */
const fromFrame = (msg: object, sel = `${BG} iframe.doc-frame-view`) => ev(`window.dispatchEvent(new MessageEvent("message", { data: ${JSON.stringify(msg)}, source: document.querySelector(${JSON.stringify(sel)}).contentWindow })), "ok"`);

gui("the toggle in the frame bar picks an element: the helper's report opens the popover, the comment keeps selector, tag, text and the page's file; Esc cancels; a selection of the page is a text comment of the page", async () => {
  writeFileSync(join(scratch, "ukagai", "pick.html"), PICK_PAGE);
  ab("open", base + "/");
  await waitFor("idle", `document.getElementById("empty") && !document.getElementById("empty").hidden`);
  const { id } = await seedDoc(EXPL.replace("compare.html", "pick.html"));
  await waitFor("frame", `document.querySelector("${BG} figure.doc-frame iframe")`, 15000);
  if (!supportsCsp()) return; // no helper: the whole-page button is covered by the no-csp test
  await waitFor("frame loaded", `document.querySelector("${BG} iframe.doc-frame-view")._marks !== undefined`);
  const file = join(scratch, "ukagai", "pick.html");
  const pressed = () => ev<boolean>(`document.querySelector("${BG} .doc-frame-pick").getAttribute("aria-pressed") === "true"`);
  // a report nobody asked for is ignored
  fromFrame({ ukagai: "picked", sel: "#save", tag: "button", text: "Save", rect: { x: 1, y: 1, w: 5, h: 5 } });
  await sleep(200);
  assert.equal(count(".cmt-pop"), 0, "not picking: a picked message does nothing");
  // Esc ends picking and does nothing else
  ev(`document.querySelector("${BG} .doc-frame-pick").click(), "ok"`);
  assert.equal(pressed(), true);
  key("Escape");
  assert.equal(pressed(), false, "Esc ends picking");
  assert.equal(count(".cmt-pop") + count(".overlay"), 0);
  // the helper says the user cancelled
  ev(`document.querySelector("${BG} .doc-frame-pick").click(), "ok"`);
  fromFrame({ ukagai: "pick-cancel" });
  assert.equal(pressed(), false);
  // a pick: malformed fields are dropped, strings clipped, the popover opens at the element
  ev(`document.querySelector("${BG} .doc-frame-pick").click(), "ok"`);
  fromFrame({ ukagai: "picked", sel: "#save", tag: "BUTTON<x>", text: "Save", rect: { x: 40, y: 60, w: 120, h: 40 } });
  await waitFor("popover", `document.querySelector(".cmt-pop .cmt-pop-ta")`);
  assert.equal(pressed(), false, "picking is off after one pick");
  assert.match(text(".cmt-pop .cmt-pop-q"), /^Element “Save”/, "a bad tag is dropped, the label falls back");
  const box = ev<{ l: number; t: number }>(`JSON.stringify((() => { const r = document.querySelector("${BG} iframe.doc-frame-view").getBoundingClientRect(), p = document.querySelector(".cmt-pop").getBoundingClientRect(); return { l: Math.round(p.left - r.left), t: Math.round(p.top - r.top) }; })())`);
  assert.ok(box.t >= 100 - 2 && box.l >= 8 - 1, `the popover sits below the element: ${JSON.stringify(box)}`); // below the 60 + 40 px element
  ev(`document.querySelector(".cmt-pop .btn:not(.primary)").click(), "ok"`);
  ev(`document.querySelector("${BG} .doc-frame-pick").click(), "ok"`);
  fromFrame({ ukagai: "picked", sel: "#save", tag: "button", text: "Save", rect: { x: 40, y: 60, w: 120, h: 40 } });
  await waitFor("popover", `document.querySelector(".cmt-pop .cmt-pop-ta")`);
  assert.match(text(".cmt-pop .cmt-pop-q"), /^button “Save”/);
  writeNote("make this primary");
  await waitFor("stored", `localStorage.getItem("ukagai.comments.${id}")`);
  const [c] = stored(id);
  assert.equal(c.kind, "element");
  assert.equal(c.selector, "#save");
  assert.equal(c.tag, "button");
  assert.equal(c.text, "Save");
  assert.deepEqual(c.source, { kind: "page", file });
  assert.equal(c.note, "make this primary");
  await waitFor("badge and list row", `document.querySelectorAll("${BG} .cmt-badge").length === 1 && document.querySelectorAll("#decision .cmt-row").length === 1`);
  assert.match(text("#decision .cmt-row .cmt-where"), /button “Save”/);
  // a selection: a text comment of the page; the left column is never searched for its quote, so it is not an orphan
  fromFrame({ ukagai: "selected", quote: "Hello inline", prefix: "x".repeat(200), suffix: " world", sel: "#t", rect: { x: 20, y: 200, w: 100, h: 24 } });
  await waitFor("selection popover", `document.querySelector(".cmt-pop .cmt-pop-ta")`);
  assert.match(text(".cmt-pop .cmt-pop-q"), /Hello inline/);
  writeNote("reword this");
  await waitFor("two stored", `JSON.parse(localStorage.getItem("ukagai.comments.${id}")).comments.length === 2`);
  const t2 = stored(id)[1];
  assert.equal(t2.kind, "text");
  assert.deepEqual(t2.source, { kind: "page", file });
  assert.equal(t2.quote, "Hello inline");
  assert.equal(t2.prefix.length, 64, "clipped to the contract's 64");
  assert.equal(t2.selector, "#t");
  await waitFor("settled", `document.querySelectorAll("${BG} .cmt-badge").length === 2`);
  assert.equal(count("#decision .cmt-row.orphan"), 0, "a page comment is anchored to its frame");
  // a report with a bad rect is dropped
  fromFrame({ ukagai: "selected", quote: "x", rect: { x: "1", y: 1, w: 1, h: 1 } });
  await sleep(200);
  assert.equal(count(".cmt-pop"), 0);
  // the frame leaves the page (another explanation): its comments are orphans, not lost
  ab("screenshot", join(SHOTS, "FRAME-comments.png"));
});

gui("full screen: picking an element opens the popover and the comment gets its badge and list row; a pick survives the frame loading again", async () => {
  writeFileSync(join(scratch, "ukagai", "pick.html"), PICK_PAGE);
  ab("open", base + "/");
  await waitFor("idle", `document.getElementById("empty") && !document.getElementById("empty").hidden`);
  const { id } = await seedDoc(EXPL.replace("compare.html", "pick.html"));
  await waitFor("frame", `document.querySelector("${BG} figure.doc-frame iframe")`, 15000);
  if (!supportsCsp()) return;
  await waitFor("frame loaded", `document.querySelector("${BG} iframe.doc-frame-view")._marks !== undefined`);
  ev(`document.querySelector("${BG} .doc-frame-full").click(), "ok"`);
  await waitFor("overlay", `document.querySelector(".overlay.frame iframe.frame-full")`);
  const full = ".overlay.frame iframe.frame-full";
  const pressed = () => ev<boolean>(`document.querySelector(".overlay.frame .frame-pick").getAttribute("aria-pressed") === "true"`);
  // the toggle of the full-screen bar picks in the full-screen frame; the report of that frame opens the popover inside the overlay
  ev(`document.querySelector(".overlay.frame .frame-pick").click(), "ok"`);
  assert.equal(pressed(), true);
  fromFrame({ ukagai: "picked", sel: "#save", tag: "button", text: "Save", rect: { x: 40, y: 60, w: 120, h: 40 } }, full);
  await waitFor("popover", `document.querySelector(".cmt-pop .cmt-pop-ta")`);
  assert.equal(pressed(), false, "picking is off after one pick");
  const box = ev<{ l: number; t: number; inside: boolean }>(`JSON.stringify((() => { const r = document.querySelector("${full}").getBoundingClientRect(), p = document.querySelector(".cmt-pop").getBoundingClientRect(); return { l: Math.round(p.left - r.left), t: Math.round(p.top - r.top), inside: p.right <= innerWidth && p.bottom <= innerHeight && p.top >= 0 }; })())`);
  assert.ok(box.inside && box.t >= 100 - 2, `the popover is on screen below the element: ${JSON.stringify(box)}`);
  writeNote("full screen note");
  await waitFor("stored", `localStorage.getItem("ukagai.comments.${id}")`);
  assert.equal(stored(id)[0].selector, "#save");
  key("Escape"); // closes the overlay: the badge and the list row are of the left column
  await waitFor("overlay closed", `!document.querySelector(".overlay.frame")`);
  await waitFor("badge and list row", `document.querySelectorAll("${BG} .cmt-badge").length === 1 && document.querySelectorAll("#decision .cmt-row").length === 1`);
  // the frame loads again while the button shows picking: the helper is told again (its pick state starts empty)
  ev(`document.querySelector("${BG} .doc-frame-full").click(), "ok"`);
  await waitFor("overlay again", `document.querySelector(".overlay.frame iframe.frame-full")`);
  ev(`window.__loads = 0, document.querySelector("${full}").addEventListener("load", () => window.__loads++), "ok"`);
  ev(`document.querySelector(".overlay.frame .frame-pick").click(), "ok"`);
  ev(`(() => { const f = document.querySelector("${full}"); f.src = f.src; return "ok"; })()`);
  await waitFor("reloaded", `window.__loads === 1`);
  assert.equal(pressed(), true);
  await sleep(500);
  ab("mouse", "move", "600", "500");
  ab("mouse", "move", "100", String(40 + 80));
  ab("mouse", "down");
  ab("mouse", "up");
  await waitFor("popover after reload", `document.querySelector(".cmt-pop .cmt-pop-ta")`);
  assert.equal(pressed(), false);
  key("Escape");
});
