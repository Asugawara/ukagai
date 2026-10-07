import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GRACE_MS, GuiOpener, localDate } from "../../src/serve/gui-open.js";
import { start, type ServeHandle } from "../../src/serve/index.js";
import { SseHub } from "../../src/serve/sse.js";

const NOW = new Date(2026, 9, 2, 12, 0, 0);
const TODAY = localDate(NOW);
const roots: string[] = [];
const handles: ServeHandle[] = [];
const aborts: AbortController[] = [];

after(async () => {
  for (const a of aborts) a.abort();
  for (const h of handles) await h.close();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "ukagai-guiopen-"));
  roots.push(d);
  return d;
}

function setup(platform: NodeJS.Platform = "darwin") {
  const dataDir = tmp();
  const hub = new SseHub();
  const spawns: { cmd: string; args: string[]; o: any }[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const logs: Record<string, string | number | undefined>[] = [];
  const opener = new GuiOpener({
    dataDir,
    port: () => 4999,
    hub,
    spawn: (cmd, args, o) => {
      spawns.push({ cmd, args, o });
      return { unref() {} };
    },
    platform,
    now: () => NOW,
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    log: (_e, f) => logs.push(f ?? {}),
  });
  const connect = (browser: boolean) => {
    const ac = new AbortController();
    aborts.push(ac);
    hub.connect(ac.signal, browser);
    return ac;
  };
  return { dataDir, hub, spawns, timers, logs, opener, connect, marker: join(dataDir, "gui-opened") };
}

test("marker is today: opened_today, nothing else", () => {
  const s = setup();
  writeFileSync(s.marker, TODAY + "\n");
  assert.equal(s.opener.request(), "opened_today");
  assert.equal(s.timers.length, 0);
  assert.equal(s.spawns.length, 0);
});

test("a connected browser tab: connected, marker written, no spawn", () => {
  const s = setup();
  s.connect(true);
  assert.equal(s.opener.request(), "connected");
  assert.equal(readFileSync(s.marker, "utf8").trim(), TODAY);
  assert.equal(s.spawns.length, 0);
  assert.equal(s.timers.length, 0);
  assert.equal(s.logs[0]?.["result"], "connected");
});

test("no client: pending, and after the grace the opener runs with ?autostart=1 and the marker is written", () => {
  const s = setup();
  assert.equal(s.opener.request(), "pending");
  assert.equal(s.timers.length, 1);
  assert.equal(s.timers[0]!.ms, GRACE_MS);
  assert.equal(existsSync(s.marker), false);
  s.timers[0]!.fn();
  assert.deepEqual(s.spawns.map((x) => [x.cmd, x.args]), [["open", ["http://127.0.0.1:4999/?autostart=1"]]]);
  assert.equal(s.spawns[0]!.o.detached, true);
  assert.equal(s.spawns[0]!.o.stdio, "ignore");
  assert.equal(readFileSync(s.marker, "utf8").trim(), TODAY);
  assert.deepEqual(s.logs.at(-1), { result: "pending", opened: "yes" });
});

test("a browser that connects within the grace: marker written, no spawn", () => {
  const s = setup();
  assert.equal(s.opener.request(), "pending");
  s.connect(true);
  s.timers[0]!.fn();
  assert.equal(s.spawns.length, 0);
  assert.equal(readFileSync(s.marker, "utf8").trim(), TODAY);
  assert.deepEqual(s.logs.at(-1), { result: "pending", opened: "no" });
});

test("a second request while pending: pending, still one timer", () => {
  const s = setup();
  assert.equal(s.opener.request(), "pending");
  assert.equal(s.opener.request(), "pending");
  assert.equal(s.timers.length, 1);
  s.timers[0]!.fn();
  assert.equal(s.opener.request(), "opened_today");
  assert.equal(s.spawns.length, 1);
});

test("linux uses xdg-open", () => {
  const s = setup("linux");
  s.opener.request();
  s.timers[0]!.fn();
  assert.equal(s.spawns[0]!.cmd, "xdg-open");
});

test("another platform: no spawn, marker written", () => {
  const s = setup("win32");
  s.opener.request();
  s.timers[0]!.fn();
  assert.equal(s.spawns.length, 0);
  assert.equal(readFileSync(s.marker, "utf8").trim(), TODAY);
});

test("a bearer stream client (the TUI) does not count as a browser", () => {
  const s = setup();
  s.connect(false);
  assert.equal(s.hub.size, 1);
  assert.equal(s.hub.browsers, 0);
  assert.equal(s.opener.request(), "pending");
  s.timers[0]!.fn();
  assert.equal(s.spawns.length, 1);
});

test("SseHub.browsers counts only flagged clients and drops them on abort", () => {
  const hub = new SseHub();
  const a = new AbortController();
  const b = new AbortController();
  hub.connect(a.signal, true);
  hub.connect(b.signal);
  hub.connect(undefined, true);
  assert.equal(hub.size, 3);
  assert.equal(hub.browsers, 2);
  a.abort();
  assert.equal(hub.browsers, 1);
  hub.closeAll();
});

test("never throws when the data dir is unusable", () => {
  const s = setup();
  const bad = new GuiOpener({ ...(s.opener as any).deps, dataDir: join(s.marker, "x") });
  assert.doesNotThrow(() => bad.request());
});

test("POST /api/gui/open: 401 without the bearer (a cookie is not enough); cookie stream makes it connected", async () => {
  const dataDir = tmp();
  const h = await start({ port: 0, dataDir, home: tmp() });
  handles.push(h);
  const url = `http://127.0.0.1:${h.port}`;
  const post = (headers: Record<string, string>) => fetch(url + "/api/gui/open", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
  assert.equal((await post({})).status, 401);
  const page = await fetch(url + "/");
  const cookie = (page.headers.get("set-cookie") ?? "").split(";")[0]!;
  assert.ok(cookie);
  assert.equal((await post({ cookie })).status, 401);
  const ac = new AbortController();
  aborts.push(ac);
  const stream = await fetch(url + "/api/stream", { headers: { cookie }, signal: ac.signal });
  assert.equal(stream.status, 200);
  const res = await post({ authorization: `Bearer ${h.token}` });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { result: "connected" });
  assert.equal(readFileSync(join(dataDir, "gui-opened"), "utf8").trim(), localDate(new Date()));
  assert.equal((await post({ authorization: `Bearer ${h.token}` }).then((r) => r.json())).result, "opened_today");
});
