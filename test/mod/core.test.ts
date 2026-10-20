import { test } from "node:test";
import assert from "node:assert/strict";
import { MOD_BACKOFF_MAX_MS, MOD_POLL_MS, createSession, enabled, parseConfig, type Config, type Host } from "../../hooks/mod/core.js";

const CONFIG: Config = { server: "http://127.0.0.1:4818", dataDir: "/data" };

interface Call { url: string; method: string; headers: Record<string, string>; body: any }
interface Fake {
  host: Host;
  calls: Call[];
  env: Record<string, string>;
  clock: { now: number };
  /** queue of replies per action (poll|ack|release); an empty queue answers 204 / 200 */
  replies: Record<string, ({ status: number; text?: string } | "throw")[]>;
  submits: string[];
  submit: { result: () => Promise<{ ok: true } | { drop: string }> };
  files: Record<string, string>;
  sid: { id: string };
}
function fake(): Fake {
  const f = {
    calls: [] as Call[],
    env: {} as Record<string, string>,
    clock: { now: 1000 },
    replies: { poll: [], ack: [], release: [] } as Fake["replies"],
    submits: [] as string[],
    submit: { result: async () => ({ ok: true as const }) },
    files: { "/data/token": "tok-1\n" } as Record<string, string>,
    sid: { id: "sess-1" },
  };
  const host: Host = {
    async fetch(url, init) {
      const call = { url, method: init.method, headers: init.headers, body: JSON.parse(init.body) };
      f.calls.push(call);
      const action = url.split("/").pop()!;
      const r = f.replies[action]!.shift();
      if (r === "throw") throw new Error("down");
      if (r) return { status: r.status, text: r.text ?? "" };
      return action === "poll" ? { status: 204, text: "" } : { status: 200, text: '{"status":"answered"}' };
    },
    submit: (text) => {
      f.submits.push(text);
      return f.submit.result();
    },
    sessionId: () => f.sid.id,
    now: () => f.clock.now,
    readFile: (p) => f.files[p],
    getEnv: () => undefined,
    setEnv: (name, value) => void (f.env[name] = value),
  };
  return Object.assign(f, { host });
}
const item = (id: string, text = "[ukagai] (ref aaaaaaaa) hi") => ({ status: 200, text: JSON.stringify({ item: { item_id: id, text } }) });
const held = (id: string) => ({ status: 200, text: JSON.stringify({ held: { item_id: id } }) });
const actions = (f: Fake): string[] => f.calls.map((c) => c.url.split("/").slice(-1)[0]!);
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));
/** one tick, then let the fire-and-forget delivery settle */
async function tick(f: Fake, s: { tick(): Promise<void> }): Promise<void> {
  f.clock.now += 10_000; // past any backoff
  await s.tick();
  await flush();
}

test("enabled: UKAGAI_DISABLE, UKAGAI_MOD, isInteractive and surface", () => {
  const ok = { env: {}, isInteractive: true, surface: "terminal" };
  assert.equal(enabled(ok), true);
  assert.equal(enabled({ ...ok, env: { UKAGAI_DISABLE: "1" } }), false);
  assert.equal(enabled({ ...ok, env: { UKAGAI_DISABLE: "0" } }), true);
  for (const v of ["0", "false", "off", "OFF"]) assert.equal(enabled({ ...ok, env: { UKAGAI_MOD: v } }), false, v);
  assert.equal(enabled({ ...ok, env: { UKAGAI_MOD: "1" } }), true);
  assert.equal(enabled({ ...ok, isInteractive: false }), false);
  assert.equal(enabled({ ...ok, surface: null }), false);
  for (const s of ["desktop", "vscode", "mobile"]) assert.equal(enabled({ ...ok, surface: s }), false, s);
});

test("parseConfig: server must be loopback http with a port; dataDir must be absolute; the default is $HOME/.ukagai", () => {
  assert.deepEqual(parseConfig(undefined, "/home/u"), { server: "http://127.0.0.1:4818", dataDir: "/home/u/.ukagai" });
  assert.deepEqual(parseConfig("{", "/home/u/"), { server: "http://127.0.0.1:4818", dataDir: "/home/u/.ukagai" });
  assert.deepEqual(parseConfig('{"server":"http://localhost:4919","dataDir":"/x/d"}', "/h"), { server: "http://localhost:4919", dataDir: "/x/d" });
  for (const bad of ["https://127.0.0.1:4818", "http://example.com:4818", "http://127.0.0.1", "http://127.0.0.1:4818/x", "http://127.0.0.1:123456"]) {
    assert.equal(parseConfig(JSON.stringify({ server: bad }), "/h").server, "http://127.0.0.1:4818", bad);
  }
  assert.equal(parseConfig('{"dataDir":"relative/d"}', "/h").dataDir, "/h/.ukagai");
  assert.equal(parseConfig("{}", undefined).dataDir, undefined);
});

test("start sets UKAGAI_MOD_OWNER to 16 lowercase hex digits, a new one each time", async () => {
  const f = fake();
  const a = createSession(f.host, CONFIG);
  await a.start();
  assert.match(f.env["UKAGAI_MOD_OWNER"]!, /^[0-9a-f]{16}$/);
  const first = f.env["UKAGAI_MOD_OWNER"];
  await createSession(f.host, CONFIG).start();
  assert.notEqual(f.env["UKAGAI_MOD_OWNER"], first);
});

test("poll goes to /api/sessions/<id>/inbox/poll with the Bearer token and {owner, idle}", async () => {
  const f = fake();
  const s = createSession(f.host, CONFIG, () => "0123456789abcdef");
  await s.start();
  await s.tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.url, "http://127.0.0.1:4818/api/sessions/sess-1/inbox/poll");
  assert.equal(f.calls[0]!.method, "POST");
  assert.equal(f.calls[0]!.headers["Authorization"], "Bearer tok-1");
  assert.equal(f.calls[0]!.headers["Content-Type"], "application/json");
  assert.deepEqual(f.calls[0]!.body, { owner: "0123456789abcdef", idle: true });
});

test("idle is false while a main turn runs; subagent turns do not count", async () => {
  const f = fake();
  const s = createSession(f.host, CONFIG);
  await s.start();
  s.turnStart(undefined);
  await tick(f, s);
  s.turnComplete("sub-1");
  await tick(f, s);
  s.turnComplete(undefined);
  s.turnStart("sub-2");
  await tick(f, s);
  assert.deepEqual(f.calls.map((c) => c.body.idle), [false, false, true]);
});

test("an item is submitted as is (no asUser), then acked on the session it was claimed in", async () => {
  const f = fake();
  const s = createSession(f.host, CONFIG, () => "0123456789abcdef");
  await s.start();
  f.replies["poll"]!.push(item("d1", "[ukagai] (ref d1d1d1d1) answer"));
  await tick(f, s);
  assert.deepEqual(f.submits, ["[ukagai] (ref d1d1d1d1) answer"]);
  f.sid.id = "sess-2"; // /clear
  await tick(f, s);
  assert.deepEqual(actions(f), ["poll", "ack", "poll"]);
  assert.equal(f.calls[1]!.url, "http://127.0.0.1:4818/api/sessions/sess-1/inbox/ack");
  assert.deepEqual(f.calls[1]!.body, { owner: "0123456789abcdef", item_id: "d1" });
  assert.equal(f.calls[2]!.url, "http://127.0.0.1:4818/api/sessions/sess-2/inbox/poll");
  assert.equal(f.calls[2]!.body.idle, true);
});

test("a failing ack is sent again, and no new item is accepted meanwhile (idle:false)", async () => {
  const f = fake();
  const s = createSession(f.host, CONFIG);
  await s.start();
  f.replies["poll"]!.push(item("d1"));
  await tick(f, s);
  f.replies["ack"]!.push("throw", { status: 500 });
  await tick(f, s);
  await tick(f, s);
  await tick(f, s);
  assert.deepEqual(actions(f), ["poll", "ack", "poll", "ack", "poll", "ack", "poll"]);
  assert.deepEqual(f.calls.filter((c) => c.url.endsWith("/poll")).map((c) => c.body.idle), [true, false, false, true]);
});

test("ack and release: 200, 404 and 409 all drop the record", async () => {
  for (const status of [200, 404, 409]) {
    const f = fake();
    const s = createSession(f.host, CONFIG);
    await s.start();
    f.replies["poll"]!.push(item("d1"));
    f.replies["ack"]!.push({ status });
    await tick(f, s);
    await tick(f, s);
    await tick(f, s);
    assert.deepEqual(actions(f), ["poll", "ack", "poll", "poll"], String(status));
  }
});

test("a drop is released with the reason (cut to 500 characters) and the machine stays not idle until the next turn.complete", async () => {
  const f = fake();
  const s = createSession(f.host, CONFIG, () => "0123456789abcdef");
  await s.start();
  f.submit.result = async () => ({ drop: "x".repeat(600) });
  f.replies["poll"]!.push(item("d1"));
  await tick(f, s);
  await tick(f, s);
  await tick(f, s);
  assert.deepEqual(actions(f), ["poll", "release", "poll", "poll"]);
  assert.deepEqual(f.calls[1]!.body, { owner: "0123456789abcdef", item_id: "d1", drop: "x".repeat(500) });
  assert.deepEqual(f.calls.filter((c) => c.url.endsWith("/poll")).map((c) => c.body.idle), [true, false, false]);
  s.turnStart(undefined);
  s.turnComplete(undefined);
  await tick(f, s);
  assert.equal(f.calls.at(-1)!.body.idle, true);
});

test("a submit that throws is released without a drop", async () => {
  const f = fake();
  const s = createSession(f.host, CONFIG);
  await s.start();
  f.submit.result = async () => {
    throw new Error("boom");
  };
  f.replies["poll"]!.push(item("d1"));
  await tick(f, s);
  await tick(f, s);
  assert.equal(f.calls[1]!.url.split("/").pop(), "release");
  assert.ok(!("drop" in f.calls[1]!.body));
});

test("held for an item with no record: release without a drop; with a record: nothing", async () => {
  const f = fake();
  const s = createSession(f.host, CONFIG);
  await s.start();
  f.replies["poll"]!.push(held("lost"));
  await tick(f, s);
  await tick(f, s);
  assert.deepEqual(actions(f), ["poll", "release", "poll"]);
  assert.deepEqual(Object.keys(f.calls[1]!.body).sort(), ["item_id", "owner"]);

  // while submit has not settled the record exists: held changes nothing
  const g = fake();
  const t = createSession(g.host, CONFIG);
  await t.start();
  g.submit.result = () => new Promise(() => undefined);
  g.replies["poll"]!.push(item("d2"), held("d2"));
  await tick(g, t);
  await tick(g, t);
  await tick(g, t);
  assert.deepEqual(actions(g), ["poll", "poll", "poll"]);
});

test("a submit that never settles does not stop the heartbeat", async () => {
  const f = fake();
  const s = createSession(f.host, CONFIG);
  await s.start();
  f.submit.result = () => new Promise(() => undefined);
  f.replies["poll"]!.push(item("d1"));
  for (let i = 0; i < 4; i++) await tick(f, s);
  assert.deepEqual(actions(f), ["poll", "poll", "poll", "poll"]);
  assert.deepEqual(f.calls.map((c) => c.body.idle), [true, false, false, false]);
});

test("401 reads the token again before the next request", async () => {
  const f = fake();
  const s = createSession(f.host, CONFIG);
  await s.start();
  f.replies["poll"]!.push({ status: 401 });
  await s.tick();
  assert.equal(f.calls[0]!.headers["Authorization"], "Bearer tok-1");
  f.files["/data/token"] = "tok-2\n";
  await tick(f, s);
  assert.equal(f.calls[1]!.headers["Authorization"], "Bearer tok-2");
});

test("without a token nothing is sent; once it appears the polling starts", async () => {
  const f = fake();
  delete f.files["/data/token"];
  const s = createSession(f.host, CONFIG);
  await s.start();
  await s.tick();
  assert.equal(f.calls.length, 0);
  f.files["/data/token"] = "late";
  await tick(f, s);
  assert.equal(f.calls.length, 1);
});

test("4xx, 5xx and connection failures back off 1 -> 2 -> 4 -> 5 seconds; a 2xx resets to 1", async () => {
  assert.equal(MOD_POLL_MS, 1000);
  assert.equal(MOD_BACKOFF_MAX_MS, 5000);
  for (const bad of [{ status: 404 }, { status: 400 }, { status: 415 }, { status: 500 }, "throw" as const]) {
    const f = fake();
    const s = createSession(f.host, CONFIG);
    await s.start();
    f.replies["poll"]!.push(bad, bad, bad, bad);
    await s.tick();
    for (const gap of [2000, 4000, 5000, 5000]) {
      const n = f.calls.length;
      f.clock.now += gap - 1;
      await s.tick();
      assert.equal(f.calls.length, n, `${JSON.stringify(bad)}: nothing before ${gap} ms`);
      f.clock.now += 1;
      await s.tick();
      assert.equal(f.calls.length, n + 1, `${JSON.stringify(bad)}: a poll at ${gap} ms`);
    }
    // the fifth poll succeeds (204): back to 1 s
    f.clock.now += 5000;
    await s.tick();
    const n = f.calls.length;
    f.clock.now += 1000;
    await s.tick();
    assert.equal(f.calls.length, n + 1);
  }
});

test("end() stops the ticks and sends one last ack without waiting; it never releases", async () => {
  const f = fake();
  const s = createSession(f.host, CONFIG);
  await s.start();
  f.replies["poll"]!.push(item("d1"));
  f.replies["ack"]!.push("throw");
  await tick(f, s);
  await tick(f, s); // ack d1 fails: the record stays
  const before = f.calls.length;
  s.end();
  await flush();
  assert.deepEqual(actions(f).slice(before), ["ack"]);
  await tick(f, s);
  assert.equal(f.calls.length, before + 1, "no tick after end()");
  assert.ok(!actions(f).includes("release"));
});

test("two instances (reload, two processes) have different owners and each acks only its own item", async () => {
  const f = fake();
  const a = createSession(f.host, CONFIG, () => "aaaaaaaaaaaaaaaa");
  const b = createSession(f.host, CONFIG, () => "bbbbbbbbbbbbbbbb");
  await a.start();
  await b.start();
  f.replies["poll"]!.push(item("d1"), { status: 204 });
  await tick(f, a);
  await tick(f, b);
  await tick(f, a);
  const acks = f.calls.filter((c) => c.url.endsWith("/ack"));
  assert.equal(acks.length, 1);
  assert.equal(acks[0]!.body.owner, "aaaaaaaaaaaaaaaa");
  assert.deepEqual(f.submits.length, 1);
});

test("a garbled 200 body is a failure, not an exception", async () => {
  const f = fake();
  const s = createSession(f.host, CONFIG);
  await s.start();
  f.replies["poll"]!.push({ status: 200, text: "not json" });
  await s.tick();
  await s.tick();
  assert.equal(f.calls.length, 1, "backing off");
});

test("end() while a poll is in flight: the item it returns is not submitted and its claim is released once, without a drop", async () => {
  const f = fake();
  const s = createSession(f.host, CONFIG, () => "o".repeat(16));
  await s.start();
  f.replies.poll.push(item("it-1"));
  const real = f.host.fetch;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  f.host.fetch = async (url, init) => {
    if (url.endsWith("/poll")) await gate;
    return real(url, init);
  };
  const ticking = s.tick();
  await flush();
  s.end();
  release();
  await ticking;
  await flush();
  assert.deepEqual(f.submits, []);
  const releases = f.calls.filter((c) => c.url.endsWith("/release"));
  assert.equal(releases.length, 1);
  assert.deepEqual(releases[0]!.body, { owner: "o".repeat(16), item_id: "it-1" });
});
