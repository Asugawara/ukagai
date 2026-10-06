// The tab icon in the real GUI: the static icon at 0 pending, a canvas-drawn 64x64 PNG data URL with the count (cap "5+") otherwise,
// a different one when a blocker waits. A real server (temp HOME) and a real browser (agent-browser). Skipped when agent-browser is not on PATH.
// The decoded icons are saved to UKAGAI_SHOTS_DIR (default: <tmp>/ukagai-shots) as FV1-favicon-{0,3,5plus,blocker}.png.
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

let home = "";
let dataDir = "";
let port = 0;
let token = "";
let serve: ChildProcess | undefined;
let base = "";
let opened = false;
let seq = 0;
const session = `ukagai-fav-${process.pid}-${Date.now().toString(36)}`;
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
async function api(path: string, body?: unknown) {
  const go = () => fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await go().catch(() => go());
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as any;
}
const transcript = () => join(home, ".claude", "projects", "p", "none.jsonl");

async function seedQuestion(): Promise<void> {
  const n = ++seq;
  const d = await api("/api/decisions", {
    tool_use_id: `toolu_fav_${process.pid}_${n}`,
    kind: "answer_question",
    session: { session_id: `00000000-0000-0000-0006-${String(n).padStart(12, "0")}`, cwd: ROOT, transcript_path: transcript() },
    request: { questions: [{ question: `Favicon question ${n}: A or B?`, header: "Check", multiSelect: false, options: [{ label: "A", description: "About A" }, { label: "B", description: "About B" }] }] },
  });
  assert.ok(d.id, JSON.stringify(d));
}
async function seedBlocker(): Promise<void> {
  const n = ++seq;
  const markdown = readFileSync(new URL("../explain-fixtures/pass-blocker.md", import.meta.url), "utf8");
  const fm = (k: string) => new RegExp(`^${k}: (.+)$`, "m").exec(markdown)![1]!;
  const labels = [...markdown.matchAll(/^\| ([^|]+?) \|/gm)].map((m) => m[1]!).filter((l) => !/^-+$/.test(l)).slice(1);
  const d = await api("/api/decisions", {
    tool_use_id: `toolu_fav_${process.pid}_${n}`,
    kind: "answer_question",
    session: { session_id: `00000000-0000-0000-0006-${String(n).padStart(12, "0")}`, cwd: ROOT, transcript_path: transcript() },
    request: { questions: [{ question: fm("question"), header: "Blocked", multiSelect: false, options: [
      { label: `${labels[0]} (Recommended)`, description: "Retry" }, { label: labels[1]!, description: "Skip" }, { label: labels[2]!, description: "Stop" },
    ] }] },
    explanation: { path: "", type: "blocker", title: fm("title"), question: fm("question"), reversibility: "reversible", scope: "machine", markdown, has: { mermaid: false, table: true, diff: false }, match: "question", attached_via: "first_call" },
  });
  assert.ok(d.id, JSON.stringify(d));
}
async function cancelAll() {
  for (const d of (await api("/api/decisions?status=pending")) as { id: string }[]) await api(`/api/decisions/${d.id}/cancel`, {});
}
const href = () => ev<string>(`document.querySelector("link[rel=icon]").href`);
/** Wait until the pending count in the title reads `n` and the icon has settled, then return the icon href */
async function iconAt(n: number): Promise<string> {
  await waitFor(`pending ${n}`, `document.querySelector("#pending-count")?.textContent === "${n}"`);
  await sleep(150);
  return href();
}
function png(dataUrl: string): Buffer {
  assert.match(dataUrl, /^data:image\/png;base64,/);
  return Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64");
}
function size(b: Buffer): [number, number] {
  assert.equal(b.subarray(1, 4).toString(), "PNG");
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

before(async () => {
  if (!HAS_BROWSER) return;
  home = mkdtempSync(join(tmpdir(), "ukagai-fav-"));
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
  test(`GUI favicon: ${name}`, { skip: HAS_BROWSER ? false : "agent-browser is not installed" }, async (t) => {
    await cancelAll();
    try { await fn(t); } finally { await cancelAll(); }
  });
}

gui("0 pending shows the static icon; 1 and 3 pending draw different 64x64 PNGs", async () => {
  ab("open", base + "/");
  await waitFor("page", `document.querySelector("#pending-count")`);
  await sleep(300);
  assert.match(href(), /\/favicon\.svg$/);
  const zero = href();
  await seedQuestion();
  const one = await iconAt(1);
  await seedQuestion();
  await seedQuestion();
  const three = await iconAt(3);
  assert.deepEqual(size(png(one)), [64, 64]);
  assert.deepEqual(size(png(three)), [64, 64]);
  assert.notEqual(one, three);
  assert.notEqual(one, zero);
  assert.notEqual(three, zero);
  writeFileSync(join(SHOTS, "FV1-favicon-3.png"), png(three));
  const svgBefore = ev<number>(`document.querySelectorAll("link[rel=icon]").length`);
  assert.equal(svgBefore, 1, "the static PNG fallback link is out of the way while a count shows");
  await cancelAll();
  await waitFor("back to 0", `/\\/favicon\\.svg$/.test(document.querySelector("link[rel=icon]").href)`);
  writeFileSync(join(SHOTS, "FV1-favicon-0.png"), readFileSync(new URL("../../public/favicon.png", import.meta.url)));
});

gui("6 pending shows the same capped icon as 7, which differs from 5", async () => {
  ab("open", base + "/");
  await waitFor("page", `document.querySelector("#pending-count")`);
  for (let i = 0; i < 5; i++) await seedQuestion();
  const five = await iconAt(5);
  await seedQuestion();
  const six = await iconAt(6);
  await seedQuestion();
  const seven = await iconAt(7);
  assert.notEqual(five, six);
  assert.equal(six, seven);
  assert.deepEqual(size(png(six)), [64, 64]);
  writeFileSync(join(SHOTS, "FV1-favicon-5plus.png"), png(six));
});

gui("a blocker pending gives a different icon than a plain question", async () => {
  ab("open", base + "/");
  await waitFor("page", `document.querySelector("#pending-count")`);
  await seedQuestion();
  const plain = await iconAt(1);
  await cancelAll();
  await waitFor("back to 0", `/\\/favicon\\.svg$/.test(document.querySelector("link[rel=icon]").href)`);
  await seedBlocker();
  const blocker = await iconAt(1);
  assert.deepEqual(size(png(blocker)), [64, 64]);
  assert.notEqual(blocker, plain);
  writeFileSync(join(SHOTS, "FV1-favicon-blocker.png"), png(blocker));
});

gui("the drawn icon is a PNG link found by id (type image/png); back at 0 it is the SVG link again, and the fallback PNG link is never taken for it", async () => {
  ab("open", base + "/");
  await waitFor("page", `document.querySelector("#pending-count")`);
  await sleep(300);
  assert.equal(ev(`document.getElementById("favicon").type`), "image/svg+xml");
  await seedQuestion();
  await iconAt(1);
  assert.equal(ev(`document.getElementById("favicon").type`), "image/png", "a PNG data URL must not carry the SVG type hint");
  assert.match(ev<string>(`document.getElementById("favicon").href`), /^data:image\/png;base64,/);
  await seedQuestion();
  const two = await iconAt(2); // drawn again: the id is kept on the replaced link and the redraw still finds it
  assert.equal(ev(`document.querySelectorAll("link[rel=icon]").length`), 1);
  assert.equal(ev(`document.getElementById("favicon").href`), two);
  await cancelAll();
  await waitFor("back to 0", `/\\/favicon\\.svg$/.test(document.getElementById("favicon").href)`);
  assert.equal(ev(`document.getElementById("favicon").type`), "image/svg+xml");
  assert.equal(ev(`document.querySelectorAll("link[rel=icon]").length`), 2, "the PNG fallback is back");
});
