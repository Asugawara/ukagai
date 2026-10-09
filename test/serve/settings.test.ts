// Settings: GET / PUT /api/settings, <data-dir>/config.json, live application (recap watcher, Codex bridge, terminal delivery), GET /settings.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, Settings, type Decision } from "../../src/contract.js";
import { start, type ServeHandle } from "../../src/serve/index.js";
import { PlanBridge } from "../../src/serve/codex-bridge/plan.js";
import type { Terminal, TerminalFound, TerminalRef, TerminalStatus } from "../../src/serve/terminal.js";
import { configPath } from "../../src/settings/config.js";

const roots: string[] = [];
const handles: ServeHandle[] = [];
after(async () => {
  for (const h of handles) await h.close();
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "ukagai-set-"));
  roots.push(d);
  return d;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(20);
  assert.ok(cond(), "condition not met in time");
}

class FakeTerminal implements Terminal {
  finds: string[] = [];
  typed: string[] = [];
  async find(sessionId: string): Promise<TerminalFound | undefined> {
    this.finds.push(sessionId);
    return { ref: { kind: "herdr", pane_id: "w1:p1" }, status: "idle" };
  }
  async status(): Promise<TerminalStatus> {
    return "idle";
  }
  async type(_ref: TerminalRef, text: string): Promise<void> {
    this.typed.push(text);
  }
}

type Env = { h: ServeHandle; url: string; dir: string; home: string; transcript: string; term: FakeTerminal; sse: string[] };

async function boot(opts: { dir?: string; config?: string } = {}): Promise<Env> {
  const home = tmp();
  const dir = opts.dir ?? tmp();
  if (opts.config !== undefined) writeFileSync(configPath(dir), opts.config);
  const pdir = join(home, ".claude", "projects", "p");
  mkdirSync(pdir, { recursive: true });
  const transcript = join(pdir, "sess-1.jsonl");
  writeFileSync(transcript, '{"type":"user"}\n');
  const term = new FakeTerminal();
  const h = await start({ port: 0, dataDir: dir, home, terminal: term, terminalPollMs: 10, recapPollMs: 100 });
  handles.push(h);
  const sse: string[] = [];
  const res = await fetch(`http://127.0.0.1:${h.port}/api/stream`, { headers: { authorization: `Bearer ${h.token}` } });
  const reader = res.body!.getReader();
  void (async () => {
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) return;
      sse.push(dec.decode(value));
    }
  })();
  await sleep(50);
  return { h, url: `http://127.0.0.1:${h.port}`, dir, home, transcript, term, sse };
}

function api(env: Env, path: string, init: { method?: string; body?: unknown; raw?: string; type?: string } = {}) {
  return fetch(env.url + path, {
    method: init.method ?? (init.body === undefined && init.raw === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${env.h.token}`, "content-type": init.type ?? "application/json" },
    body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
  });
}
const put = (env: Env, body: unknown) => api(env, "/api/settings", { method: "PUT", body });
const getSettings = async (env: Env): Promise<Settings> => (await api(env, "/api/settings")).json() as Promise<Settings>;
const change = (f: (s: Settings) => void): Settings => {
  const s = structuredClone(DEFAULT_SETTINGS);
  f(s);
  return s;
};

// ---- defaults / reading ----

test("GET /api/settings: defaults when config.json is missing", async () => {
  const env = await boot();
  const r = await api(env, "/api/settings");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), DEFAULT_SETTINGS);
});

test("GET /api/settings: defaults when config.json is malformed; bad fields fall back one by one", async () => {
  const bad = await boot({ config: "{ not json" });
  assert.deepEqual(await getSettings(bad), DEFAULT_SETTINGS);
  const arr = await boot({ config: "[1,2]" });
  assert.deepEqual(await getSettings(arr), DEFAULT_SETTINGS);
  const partial = await boot({
    config: JSON.stringify({
      lang: "ja",
      theme: "neon",
      hints: "yes",
      checkpoints: { enabled: false, codex_delay_s: 5, terminal_delivery: 1 },
      plans: null,
      notify: { sound: true, browser: "x" },
    }),
  });
  assert.deepEqual(await getSettings(partial), {
    ...DEFAULT_SETTINGS,
    lang: "ja",
    checkpoints: { enabled: false, codex_delay_s: 180, terminal_delivery: true },
    notify: { sound: true, browser: false, title_badge: true },
  });
});

test("GET / PUT /api/settings need auth (cookie or Bearer)", async () => {
  const env = await boot();
  assert.equal((await fetch(env.url + "/api/settings")).status, 401);
  assert.equal((await fetch(env.url + "/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(DEFAULT_SETTINGS) })).status, 401);
  const cookie = ((await fetch(env.url + "/")).headers.get("set-cookie") ?? "").split(";")[0]!;
  assert.equal((await fetch(env.url + "/api/settings", { headers: { cookie } })).status, 200);
  const r = await fetch(env.url + "/api/settings", { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(change((s) => (s.hints = false))) });
  assert.equal(r.status, 200);
});

// ---- PUT validation ----

test("PUT /api/settings: 400 with the issue list for a bad enum, a delay out of range, a non-object", async () => {
  const env = await boot();
  const cases: [string, unknown][] = [
    ["bad lang", change((s) => ((s as any).lang = "fr"))],
    ["bad theme", change((s) => ((s as any).theme = "neon"))],
    ["delay below the minimum", change((s) => (s.checkpoints.codex_delay_s = 29))],
    ["delay above the maximum", change((s) => (s.checkpoints.codex_delay_s = 3601))],
    ["delay not an integer", change((s) => (s.checkpoints.codex_delay_s = 60.5))],
    ["bool as string", change((s) => ((s as any).hints = "yes"))],
    ["missing group", { ...DEFAULT_SETTINGS, notify: undefined }],
    ["array", []],
    ["string", "settings"],
    ["null", null],
  ];
  for (const [name, body] of cases) {
    const r = await put(env, body);
    assert.equal(r.status, 400, name);
    const j = (await r.json()) as { error: string; issues: unknown[] };
    assert.equal(j.error, "invalid request", name);
    assert.ok(Array.isArray(j.issues) && j.issues.length > 0, name);
  }
  assert.equal((await put(env, undefined)).status, 400); // no body: invalid JSON
  assert.equal((await api(env, "/api/settings", { method: "PUT", raw: "{nope" })).status, 400);
  assert.equal((await api(env, "/api/settings", { method: "PUT", body: DEFAULT_SETTINGS, type: "text/plain" })).status, 415);
  assert.deepEqual(await getSettings(env), DEFAULT_SETTINGS, "nothing was saved");
  assert.equal(env.sse.join("").includes("settings.updated"), false);
});

test("PUT /api/settings: the limits themselves are accepted", async () => {
  const env = await boot();
  for (const delay of [30, 3600]) assert.equal((await put(env, change((s) => (s.checkpoints.codex_delay_s = delay)))).status, 200);
});

// ---- persistence / broadcast ----

test("PUT persists to config.json (reload the server: same values), returns the object and broadcasts settings.updated", async () => {
  const env = await boot();
  const next = change((s) => {
    s.lang = "ja";
    s.theme = "dark";
    s.hints = false;
    s.checkpoints = { enabled: false, codex_delay_s: 600, terminal_delivery: false };
    s.plans.auto_show = false;
    s.notify = { sound: true, browser: true, title_badge: false };
  });
  const r = await put(env, next);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), next);
  await until(() => env.sse.join("").includes("event: settings.updated"));
  const data = env.sse.join("").split("event: settings.updated\ndata: ")[1]!.split("\n")[0]!;
  assert.deepEqual(JSON.parse(data), next);
  await env.h.close();
  assert.deepEqual(JSON.parse(readFileSync(configPath(env.dir), "utf8")), next);
  const again = await boot({ dir: env.dir });
  assert.deepEqual(await getSettings(again), next);
});

test("PUT keeps the language in step: GET /api/config, the injected <html lang> and data-theme follow", async () => {
  const env = await boot();
  assert.match(await (await fetch(env.url + "/")).text(), /<html[^>]*\blang="en"/);
  await put(env, change((s) => ((s.lang = "ja"), (s.theme = "dark"))));
  assert.equal(((await (await api(env, "/api/config")).json()) as { lang: string }).lang, "ja");
  const html = await (await fetch(env.url + "/")).text();
  assert.match(html, /<html[^>]*\bdata-lang="ja"/);
  assert.match(html, /<html[^>]*\bdata-theme="dark"/);
  await put(env, change((s) => (s.theme = "system")));
  assert.doesNotMatch(await (await fetch(env.url + "/settings")).text(), /data-theme=/);
});

// ---- GET /settings ----

test("GET /settings and /settings/ serve the page and set the session cookie like /", async () => {
  const env = await boot();
  for (const path of ["/settings", "/settings/"]) {
    const r = await fetch(env.url + path);
    assert.equal(r.status, 200, path);
    assert.match(r.headers.get("content-type") ?? "", /text\/html/);
    const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0]!;
    assert.match(cookie, /^ukagai_session=[0-9a-f]{48}$/, path);
    assert.match(r.headers.get("set-cookie") ?? "", /HttpOnly/i);
    assert.equal(r.headers.get("cache-control"), "no-store");
    const html = await r.text();
    assert.match(html, /<html[^>]*\blang="en"[^>]*\bdata-lang="en"/);
    assert.match(html, /src="\/public\/settings\.js\?v=[0-9a-z]+"/);
    assert.match(html, /href="\/public\/app\.css\?v=[0-9a-z]+"/);
    // the cookie it set is accepted by the API, and a cookie already held is not replaced
    assert.equal((await fetch(env.url + "/api/settings", { headers: { cookie } })).status, 200);
    assert.equal((await fetch(env.url + path, { headers: { cookie } })).headers.get("set-cookie"), null);
  }
  assert.equal((await fetch(env.url + "/public/settings.js")).status, 200);
  assert.equal((await fetch(env.url + "/public/api.js")).status, 200);
});

// ---- checkpoints.enabled: the recap watcher ----

const recapLine = (content: string, ts: string) =>
  JSON.stringify({ type: "system", subtype: "away_summary", content, timestamp: ts, sessionId: "sess-1", cwd: "/w/proj" }) + "\n";
const checkpoints = (env: Env): Decision[] => env.h.store.list().filter((d) => d.kind === "checkpoint");
const event = (env: Env, name: string) =>
  api(env, "/api/events", { body: { session_id: "sess-1", transcript_path: env.transcript, cwd: "/w/proj", hook_event_name: name, received_at: new Date().toISOString() } });

test("checkpoints.enabled=false: the recap watcher creates nothing, and logs checkpoint_skipped disabled; turning it on again resumes", async () => {
  const env = await boot();
  await event(env, "SessionStart");
  await sleep(250);
  assert.equal((await put(env, change((s) => (s.checkpoints.enabled = false)))).status, 200);
  appendFileSync(env.transcript, recapLine("Fixed the parser.", "2026-10-04T01:00:00.000Z"));
  await sleep(500);
  assert.equal(checkpoints(env).length, 0);
  await until(() => {
    try {
      return readFileSync(join(env.dir, "serve.log"), "utf8").includes("checkpoint_skipped");
    } catch {
      return false;
    }
  });
  assert.match(readFileSync(join(env.dir, "serve.log"), "utf8"), /checkpoint_skipped[^\n]*"?reason"?[=:]"?disabled/);
  await put(env, DEFAULT_SETTINGS);
  appendFileSync(env.transcript, recapLine("Next recap.", "2026-10-04T01:05:00.000Z"));
  await until(() => checkpoints(env).length === 1, 1500);
});

test("checkpoints.enabled=false: a pending checkpoint card stays as it is", async () => {
  const env = await boot();
  const r = await api(env, "/api/decisions", {
    body: { tool_use_id: "checkpoint:sess-1:2026-10-04T01:00:00.000Z", kind: "checkpoint", session: { session_id: "sess-1", cwd: "/w/proj", transcript_path: env.transcript }, request: { recap: "r", recap_at: "2026-10-04T01:00:00.000Z" } },
  });
  const d = (await r.json()) as Decision;
  await put(env, change((s) => (s.checkpoints.enabled = false)));
  await sleep(150);
  assert.equal(env.h.store.get(d.id)!.status, "pending");
});

// ---- checkpoints.enabled / codex_delay_s: the Codex bridge ----

const THREAD = "00000000-0000-4000-8000-000000000026";
function bridgeOf(env: Env, extra: { checkpointDelayMs?: number } = {}) {
  const logs: { event: string; fields?: Record<string, unknown> }[] = [];
  const bridge = new PlanBridge({
    store: env.h.store,
    log: ((event: string, fields?: Record<string, unknown>) => void logs.push({ event, fields })) as any,
    lang: "en",
    settings: env.h.settings,
    tuiRunningIn: async () => true,
    ...extra,
  });
  const completeTurn = (turnId: string, text = "All done. Next: tests.") => {
    bridge.handle({ method: "thread/settings/updated", params: { threadId: THREAD, threadSettings: { cwd: "/work/proj", model: "m", effort: "low", collaborationMode: { mode: "default", settings: {} } } } } as any);
    bridge.handle({ method: "turn/started", params: { threadId: THREAD, turn: { id: turnId, items: [], status: "inProgress" } } } as any);
    bridge.handle({ method: "item/completed", params: { threadId: THREAD, turnId, item: { type: "agentMessage", id: `${turnId}-m`, text, phase: "final_answer" } } } as any);
    bridge.handle({ method: "turn/completed", params: { threadId: THREAD, turn: { id: turnId, items: [], status: "completed" } } } as any);
  };
  return { bridge, logs, completeTurn };
}

/** Record the delays of setTimeout calls made while `f` runs (the bridge arms its checkpoint timer with one) */
function armedDelays(f: () => void): number[] {
  const orig = globalThis.setTimeout;
  const delays: number[] = [];
  (globalThis as any).setTimeout = ((fn: any, ms?: number, ...rest: any[]) => {
    if (typeof ms === "number" && ms >= 1000) delays.push(ms);
    // Do not run the long timers: the test only needs to know when they would fire
    return orig(() => {}, 1, ...rest);
  }) as any;
  try {
    f();
  } finally {
    globalThis.setTimeout = orig;
  }
  return delays;
}

test("Codex bridge: checkpoints.enabled=false arms nothing and logs checkpoint_skipped disabled", async () => {
  const env = await boot();
  const { bridge, logs, completeTurn } = bridgeOf(env);
  await put(env, change((s) => (s.checkpoints.enabled = false)));
  const delays = armedDelays(() => completeTurn("turn-1"));
  bridge.stop();
  assert.deepEqual(delays, []);
  assert.deepEqual(logs.filter((l) => l.event === "checkpoint_skipped").map((l) => l.fields?.reason), ["disabled"]);
  assert.equal(checkpoints(env).length, 0);
});

test("Codex bridge: codex_delay_s is read live at arm time (30 s, then 90 s, without a restart)", async () => {
  const env = await boot();
  const { bridge, completeTurn } = bridgeOf(env);
  assert.deepEqual(armedDelays(() => completeTurn("turn-1")), [180_000]);
  await put(env, change((s) => (s.checkpoints.codex_delay_s = 30)));
  assert.deepEqual(armedDelays(() => completeTurn("turn-2")), [30_000]);
  await put(env, change((s) => (s.checkpoints.codex_delay_s = 90)));
  assert.deepEqual(armedDelays(() => completeTurn("turn-3")), [90_000]);
  bridge.stop();
});

test("Codex bridge: the injectable delay (tests) wins over codex_delay_s, and a checkpoint is created after it", async () => {
  const env = await boot();
  const { bridge, completeTurn } = bridgeOf(env, { checkpointDelayMs: 60 });
  // A connected daemon that has the thread loaded (the checkpoint is only asked for when it could be delivered)
  (bridge as any).rpc = { request: async (method: string) => (method === "thread/loaded/list" ? { data: [THREAD], nextCursor: null } : {}) };
  await put(env, change((s) => (s.checkpoints.codex_delay_s = 3600)));
  completeTurn("turn-1", "Recap text");
  await until(() => checkpoints(env).length === 1, 1500);
  bridge.stop();
});

// ---- checkpoints.terminal_delivery ----

async function checkpointFor(env: Env, recapAt: string): Promise<Decision> {
  const r = await api(env, "/api/decisions", {
    body: { tool_use_id: `checkpoint:sess-1:${recapAt}`, kind: "checkpoint", session: { session_id: "sess-1", cwd: "/w/proj", transcript_path: env.transcript }, request: { recap: "recap", recap_at: recapAt } },
  });
  return (await r.json()) as Decision;
}

test("checkpoints.terminal_delivery=false: nothing is typed, the reply waits for the hook; on again types it", async () => {
  const env = await boot();
  await event(env, "Stop");
  await put(env, change((s) => (s.checkpoints.terminal_delivery = false)));
  const d = await checkpointFor(env, "2026-10-04T01:00:00.000Z");
  await api(env, `/api/decisions/${d.id}/answer`, { body: { kind: "instruct", text: "go on" } });
  await sleep(250);
  assert.deepEqual(env.term.typed, []);
  assert.deepEqual(env.term.finds, [], "no terminal is even looked up");
  // the hook's next tool call takes it
  const r = await api(env, "/api/sessions/sess-1/instruction");
  assert.equal(r.status, 200);

  await put(env, DEFAULT_SETTINGS);
  const d2 = await checkpointFor(env, "2026-10-04T02:00:00.000Z");
  await api(env, `/api/decisions/${d2.id}/answer`, { body: { kind: "instruct", text: "again" } });
  await until(() => env.term.typed.length === 1);
  assert.match(env.term.typed[0]!, /again/);
});

// ---- failed write / concurrency / odd keys / the file's language ----

test("a failed write (read-only data dir): 500, nothing changes in memory, file or SSE; the next save works", { skip: process.getuid?.() === 0 ? "root ignores directory permissions" : false }, async () => {
  const env = await boot();
  assert.equal((await put(env, change((s) => (s.hints = false)))).status, 200); // creates config.json
  const saved = readFileSync(configPath(env.dir), "utf8");
  const count = () => env.sse.join("").split("event: settings.updated").length;
  await until(() => count() === 2); // the first PUT's broadcast has arrived
  const sseBefore = count();
  chmodSync(env.dir, 0o555);
  try {
    const r = await put(env, change((s) => ((s.hints = true), (s.theme = "dark"), (s.checkpoints.enabled = false))));
    assert.equal(r.status, 500);
    assert.deepEqual(await r.json(), { error: "internal error" });
    assert.equal((await getSettings(env)).theme, "system", "memory still has the saved values");
    assert.equal((await getSettings(env)).checkpoints.enabled, true, "and the live checkpoint setting did not flip");
    assert.equal(readFileSync(configPath(env.dir), "utf8"), saved);
    await sleep(100);
    assert.equal(count(), sseBefore, "no broadcast");
    assert.deepEqual(readdirSync(env.dir).filter((f) => f.endsWith(".tmp")), []);
  } finally {
    chmodSync(env.dir, 0o755);
  }
  const ok = await put(env, change((s) => (s.theme = "dark")));
  assert.equal(ok.status, 200);
  assert.equal((await getSettings(env)).theme, "dark");
});

test("concurrent PUTs: all answer, memory and file agree on the last one, no tmp file is left", async () => {
  const env = await boot();
  const delays = Array.from({ length: 30 }, (_, i) => 30 + i);
  const rs = await Promise.all(delays.map((d) => put(env, change((s) => (s.checkpoints.codex_delay_s = d)))));
  assert.deepEqual(rs.map((r) => r.status), delays.map(() => 200));
  const mem = await getSettings(env);
  assert.ok(delays.includes(mem.checkpoints.codex_delay_s));
  assert.deepEqual(JSON.parse(readFileSync(configPath(env.dir), "utf8")), mem);
  assert.deepEqual(readdirSync(env.dir).filter((f) => f.endsWith(".tmp")), []);
});

test("PUT: a __proto__ key is dropped, nothing is polluted, and the file holds only the schema's keys", async () => {
  const env = await boot();
  const r = await api(env, "/api/settings", {
    method: "PUT",
    raw: JSON.stringify(DEFAULT_SETTINGS).replace("{", '{"__proto__":{"polluted":1},"constructor":7,'),
  });
  assert.equal(r.status, 200);
  const got = (await r.json()) as Settings;
  assert.deepEqual(got, DEFAULT_SETTINGS);
  assert.equal(Object.hasOwn(got, "__proto__"), false);
  assert.equal(({} as any).polluted, undefined);
  await env.h.close();
  const file = JSON.parse(readFileSync(configPath(env.dir), "utf8"));
  assert.deepEqual(file, DEFAULT_SETTINGS);
  assert.equal(Object.hasOwn(file, "__proto__"), false);
});

test("PUT keeps the language config.json got meanwhile (unless the client changes it)", async () => {
  const env = await boot();
  writeFileSync(configPath(env.dir), JSON.stringify({ ...DEFAULT_SETTINGS, lang: "ja" })); // the file changed behind the server's back
  const r = await put(env, change((s) => (s.hints = false))); // the page still thinks "en" and does not change it
  assert.equal(((await r.json()) as Settings).lang, "ja");
  assert.equal(JSON.parse(readFileSync(configPath(env.dir), "utf8")).lang, "ja");
  assert.equal((await getSettings(env)).lang, "ja");
  // a client that does change the language wins
  const r2 = await put(env, change((s) => ((s.lang = "en"), (s.hints = false))));
  assert.equal(((await r2.json()) as Settings).lang, "en");
});

// ---- M3 / M4 ----

test("Codex bridge: a timer armed while enabled does not create a checkpoint once it was switched off", async () => {
  const env = await boot();
  const { bridge, logs, completeTurn } = bridgeOf(env, { checkpointDelayMs: 150 });
  (bridge as any).rpc = { request: async (method: string) => (method === "thread/loaded/list" ? { data: [THREAD], nextCursor: null } : {}) };
  completeTurn("turn-1");
  await put(env, change((s) => (s.checkpoints.enabled = false)));
  await sleep(450);
  bridge.stop();
  assert.equal(checkpoints(env).length, 0);
  assert.deepEqual(logs.filter((l) => l.event === "checkpoint_skipped").map((l) => l.fields?.reason), ["disabled"]);
});

test("terminal_delivery off clears the terminal label of sessions (at once and for a new checkpoint); on again finds it again", async () => {
  const env = await boot();
  await event(env, "Stop");
  const labelOf = async () => (((await (await api(env, "/api/sessions")).json()) as { session_id: string; terminal?: string }[]).find((x) => x.session_id === "sess-1") ?? {}).terminal;
  const d = await checkpointFor(env, "2026-10-04T01:00:00.000Z");
  await until(() => env.term.finds.length > 0);
  await until(() => env.h.store.listSessions().find((x) => x.session_id === "sess-1")?.terminal !== undefined);
  assert.match((await labelOf()) ?? "", /herdr/);
  await put(env, change((s) => (s.checkpoints.terminal_delivery = false)));
  assert.equal(await labelOf(), undefined, "cleared when the setting changes");
  // a label that comes back some other way is cleared by the next checkpoint too
  env.h.store.setTerminal("sess-1", "herdr:w1:p1");
  await checkpointFor(env, "2026-10-04T02:00:00.000Z");
  await sleep(100);
  assert.equal(await labelOf(), undefined);
  await put(env, DEFAULT_SETTINGS);
  await checkpointFor(env, "2026-10-04T03:00:00.000Z");
  await until(() => env.h.store.listSessions().find((x) => x.session_id === "sess-1")?.terminal !== undefined);
  void d;
});
