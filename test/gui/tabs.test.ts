// Tabs: an auto-opened tab (/?autostart=1) closes itself when another ukagai tab is open; a normal tab never does.
// A real server (temp HOME) and a real browser (agent-browser, several tabs). Skipped when agent-browser is not on PATH.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HAS_BROWSER = spawnSync("agent-browser", ["--version"], { stdio: "ignore" }).status === 0;

let home = "";
let port = 0;
let serve: ChildProcess | undefined;
let base = "";
let opened = false;
const session = `ukagai-tabs-${process.pid}-${Date.now().toString(36)}`;
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
/** Open tabs as { id, url } */
function tabs(): { id: string; url: string }[] {
  const j = JSON.parse(ab("tab", "list", "--json")) as any;
  const list = j.data?.tabs ?? j.tabs ?? [];
  return list.map((t: any) => ({ id: String(t.tabId ?? t.id ?? t.label), url: String(t.url) }));
}
const pageUrls = () => tabs().map((t) => t.url);
async function waitFor(what: string, cond: () => boolean, ms = 10000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    let ok = false;
    try { ok = cond(); } catch {}
    if (ok) return;
    assert.ok(Date.now() < end, `condition not met in time: ${what}; tabs: ${JSON.stringify(pageUrls())}`);
    await sleep(150);
  }
}
/** Close every tab but one, and send that one to the app root */
function reset() {
  const all = tabs();
  for (const t of all.slice(1)) { try { ab("tab", "close", t.id); } catch {} }
  ab("open", base + "/");
}

before(async () => {
  if (!HAS_BROWSER) return;
  home = mkdtempSync(join(tmpdir(), "ukagai-tabs-"));
  const dataDir = join(home, "data");
  mkdirSync(join(home, ".claude", "plans"), { recursive: true });
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  serve = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "serve", "--port", String(port), "--data-dir", dataDir], { cwd: ROOT, stdio: "ignore", env: { ...process.env, HOME: home, UKAGAI_TERMINAL: "none" } });
  const end = Date.now() + 20000;
  for (;;) {
    try { if ((await fetch(base + "/healthz")).ok) break; } catch {}
    assert.ok(Date.now() < end, "serve did not start");
    await sleep(100);
  }
  ab("open", base + "/", "--viewport", "1280x800");
  opened = true;
});
after(async () => {
  if (opened) { try { ab("close"); } catch {} }
  serve?.kill();
  if (home) rmSync(home, { recursive: true, force: true });
});

function gui(name: string, fn: () => Promise<void>) {
  test(`GUI tabs: ${name}`, { skip: HAS_BROWSER ? false : "agent-browser is not installed" }, async () => {
    reset();
    await sleep(500);
    await fn();
  });
}

gui("an auto-opened tab closes itself when another ukagai tab is open; the first stays", async () => {
  assert.equal(tabs().length, 1);
  ab("tab", "new", base + "/?autostart=1");
  await waitFor("auto tab closed", () => tabs().length === 1, 8000);
  assert.equal(pageUrls()[0], base + "/");
});

gui("a second normal tab stays open", async () => {
  ab("tab", "new", base + "/");
  await sleep(6500);
  assert.equal(tabs().length, 2);
});

gui("an auto-opened tab alone stays open and loses the query", async () => {
  // Park a blank tab, drop the app tab, then load the auto URL there so no other ukagai tab exists
  const first = tabs()[0]!;
  ab("tab", "new", "about:blank");
  ab("tab", "close", first.id);
  ab("open", base + "/?autostart=1");
  await sleep(6500);
  const left = tabs();
  assert.equal(left.length, 1);
  assert.equal(left[0]!.url, base + "/");
});
