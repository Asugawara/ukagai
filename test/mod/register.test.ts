import { test } from "node:test";
import assert from "node:assert/strict";
import { MOD_POLL_MS } from "../../hooks/mod/core.js";
import { register } from "../../hooks/mod/register.js";

type Hook = (...a: any[]) => Promise<unknown>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A fake `$` and the hooks `register` hands to `on`. `clear()` is what Claude Code does on /clear: session.end with reason "clear", no session.start */
function setup() {
  const hooks: Record<string, Hook> = {};
  register(((event: string, hook: Hook) => void (hooks[event] = hook)) as never);
  const polls: Array<{ session: string; owner: string }> = [];
  const owners: Array<string | undefined> = [];
  const timers: Array<{ fn: () => void; cancelled: boolean }> = [];
  let sessionId = "sess-1";
  const $ = {
    http: {
      fetch: async (url: string, init?: { body?: string }) => {
        const m = /\/api\/sessions\/([^/]+)\/inbox\/poll$/.exec(url);
        if (m) polls.push({ session: decodeURIComponent(m[1]!), owner: JSON.parse(init?.body ?? "{}").owner });
        return { status: 204, text: "" };
      },
    },
    prompt: { submit: async () => ({}) },
    session: { id: async () => sessionId },
    fs: { read: async (p: string) => (p.endsWith("/token") ? "tok\n" : p.endsWith("config.json") ? JSON.stringify({ dataDir: "/d" }) : Promise.reject(new Error("no"))) },
    env: {
      get: async (n: string) => (n === "HOME" ? "/home" : undefined),
      set: (_n: string, v: string | undefined) => void owners.push(v),
    },
    plugin: { root: "/plugin" },
    clock: {
      every: (_ms: number, fn: () => void) => {
        const t = { fn, cancelled: false };
        timers.push(t);
        return { cancel: () => void (t.cancelled = true) };
      },
    },
  };
  const next = async (e: unknown) => e;
  const live = () => timers.filter((t) => !t.cancelled);
  /** Runs every live timer once and lets the poll finish */
  const tick = async () => {
    for (const t of live()) t.fn();
    await new Promise((r) => setTimeout(r, 20));
  };
  return {
    start: () => hooks["session.start"]!($, { isInteractive: true, surface: "terminal" }, next),
    end: (reason: string) => hooks["session.end"]!($, { reason, sessionId }, next),
    setSession: (id: string) => void (sessionId = id),
    polls,
    owners,
    live,
    tick,
  };
}

test("after /clear the mod keeps polling the new session with a new owner", async () => {
  const m = setup();
  await m.start();
  await m.tick();
  assert.deepEqual(m.polls.map((p) => p.session), ["sess-1"]);
  const first = m.polls[0]!.owner;

  m.setSession("sess-2");
  await m.end("clear");
  assert.equal(m.live().length, 1, "one timer goes on");
  assert.equal(m.owners.length, 2);
  assert.notEqual(m.owners[1], m.owners[0], "the env gets the new owner");

  await m.tick();
  assert.equal(m.polls.at(-1)!.session, "sess-2");
  assert.equal(m.polls.at(-1)!.owner, m.owners[1]);
  assert.notEqual(m.polls.at(-1)!.owner, first);
  assert.ok(MOD_POLL_MS > 0);
});

test("two /clear in a row still leave exactly one timer", async () => {
  const m = setup();
  await m.start();
  await m.end("clear");
  await m.end("clear");
  assert.equal(m.live().length, 1);
});

test("a real end (exit, resume, logout, other) stops the mod", async () => {
  for (const reason of ["prompt_input_exit", "resume", "logout", "other"]) {
    const m = setup();
    await m.start();
    await m.end(reason);
    assert.equal(m.live().length, 0, reason);
    const before = m.polls.length;
    await m.tick();
    assert.equal(m.polls.length, before, reason);
  }
});

test("session.end before any session.start does not throw", async () => {
  const m = setup();
  await m.end("clear");
  assert.equal(m.live().length, 0);
});
