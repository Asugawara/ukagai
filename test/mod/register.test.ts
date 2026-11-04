import { test } from "node:test";
import assert from "node:assert/strict";
import { MOD_POLL_MS } from "../../hooks/mod/core.js";
import { register } from "../../hooks/mod/register.js";

type Hook = (...a: any[]) => Promise<unknown>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A fake `$` and the hooks `register` hands to `on`. `clear()` is what Claude Code does on /clear: session.end with reason "clear", no session.start */
function setup(env: Record<string, string> = {}, opts: { noUi?: boolean; lang?: string } = {}) {
  const hooks: Record<string, Hook> = {};
  register(((event: string, ...rest: unknown[]) => void (hooks[event] = rest.at(-1) as Hook)) as never);
  const polls: Array<{ session: string; owner: string }> = [];
  const owners: Array<string | undefined> = [];
  const timers: Array<{ fn: () => void; cancelled: boolean }> = [];
  let sessionId = "sess-1";
  const withdraws: string[] = [];
  const state = { poll: { status: 204, text: "" } as { status: number; text: string }, withdrawStatus: 200 };
  const opened: Array<Record<string, unknown>> = [];
  const closed: string[] = [];
  const toasts: string[] = [];
  const open = new Map<string, { id: string; isPlaced: boolean }>();
  const ui = {
    open: async (a: { id: string }) => {
      opened.push(a);
      open.set(a.id, { id: a.id, isPlaced: true });
      return { isPlaced: true };
    },
    close: async (a: { id: string }) => void (open.delete(a.id), closed.push(a.id)),
    panes: async () => [...open.values()],
    resolve: () => ({ Box: "Box", Text: "Text" }),
    toast: (t: string) => void toasts.push(t),
  };
  const $ = {
    ...(opts.noUi ? {} : { ui }),
    http: {
      fetch: async (url: string, init?: { body?: string }) => {
        const m = /\/api\/sessions\/([^/]+)\/inbox\/poll$/.exec(url);
        if (m) polls.push({ session: decodeURIComponent(m[1]!), owner: JSON.parse(init?.body ?? "{}").owner });
        const w = /\/api\/decisions\/([^/]+)\/withdraw$/.exec(url);
        if (w) {
          withdraws.push(decodeURIComponent(w[1]!));
          return { status: state.withdrawStatus, text: "{}" };
        }
        return m ? state.poll : { status: 204, text: "" };
      },
    },
    prompt: { submit: async () => ({}) },
    session: { id: async () => sessionId },
    fs: { read: async (p: string) => (p.endsWith("/token") ? "tok\n" : p.endsWith("config.json") ? JSON.stringify({ dataDir: "/d", ...(opts.lang ? { lang: opts.lang } : {}) }) : Promise.reject(new Error("no"))) },
    env: {
      get: async (n: string) => (n === "HOME" ? "/home" : env[n]),
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
    setEnv: (k: string, v: string) => void (env[k] = v),
    setSession: (id: string) => void (sessionId = id),
    polls,
    owners,
    $,
    hooks,
    withdraws,
    state,
    opened,
    closed,
    toasts,
    open,
    next,
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

test("a session.start that runs again disabled leaves nothing for a later /clear to rebuild", async () => {
  const m = setup();
  await m.start();
  m.setEnv("UKAGAI_MOD", "off");
  await m.start();
  assert.equal(m.live().length, 0);
  await m.end("clear");
  assert.equal(m.live().length, 0);
  await m.tick();
  assert.deepEqual(m.polls, []);
});

const WAIT = { status: 200, text: JSON.stringify({ waiting: { decision_id: "dec-1", question: "Which one?" } }) };
const flat = (n: any): string => (typeof n === "string" ? n : Array.isArray(n) ? n.map(flat).join("|") : n && typeof n === "object" ? flat(n.children) : ""); // eslint-disable-line @typescript-eslint/no-explicit-any

function withH<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as unknown as { h?: unknown };
  g.h = (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children });
  return fn().finally(() => void delete g.h);
}

test("a waiting question opens the pane with closeOnEscape and 2 rows", async () => {
  const m = setup();
  await m.start();
  m.state.poll = WAIT;
  await m.tick();
  assert.deepEqual(m.opened, [{ id: "ukagai-waiting", title: "ukagai", closeOnEscape: true, rows: 2 }]);
  m.state.poll = { status: 204, text: "" };
  await m.tick();
  assert.deepEqual(m.closed, ["ukagai-waiting"], "the mod closes it when the question stops waiting");
});

test("the person's close withdraws; a plugin or unload close sends nothing; the pane is never kept open", async () => {
  const m = setup();
  await m.start();
  m.state.poll = WAIT;
  await m.tick();
  const closeHook = m.hooks["ui.close"]!;
  const seen: unknown[] = [];
  const next = async (e: unknown) => void seen.push(e);
  await closeHook(m.$, { id: "ukagai-waiting", origin: { kind: "plugin" } }, next);
  await closeHook(m.$, { id: "ukagai-waiting", origin: { kind: "unload" } }, next);
  assert.deepEqual(m.withdraws, []);
  await closeHook(m.$, { id: "ukagai-waiting", origin: { kind: "person" } }, next);
  assert.deepEqual(m.withdraws, ["dec-1"]);
  assert.equal(seen.length, 3, "next(e) every time");
  assert.deepEqual(m.toasts, []);
});

test("a failed withdraw toasts", async () => {
  const m = setup();
  await m.start();
  m.state.poll = WAIT;
  await m.tick();
  m.state.withdrawStatus = 500;
  await m.hooks["ui.close"]!(m.$, { id: "ukagai-waiting", origin: { kind: "person" } }, m.next);
  assert.equal(m.toasts.length, 1);
  assert.match(m.toasts[0]!, /could not withdraw/);
});

test("ui.render: two lines, en by default and ja with lang in config.json", async () => {
  for (const [lang, line, hint] of [
    [undefined, "ukagai: waiting for your answer: Which one?", "Esc at an empty prompt withdraws"],
    ["ja", "ukagai: 回答待ち: Which one?", "空のプロンプトで Esc"],
  ] as const) {
    const m = setup({}, { lang });
    await m.start();
    m.state.poll = WAIT;
    await m.tick();
    const out = await withH(() => m.hooks["ui.render"]!(m.$, { component: "Pane", requestId: "ukagai-waiting" }, m.next));
    const text = flat(out);
    assert.ok(text.includes(line), text);
    assert.ok(text.includes(hint), text);
  }
});

test("tool.call AskUserQuestion: returns what next returned, refreshes, and opens a pane that is not placed", async () => {
  const m = setup();
  await m.start();
  m.state.poll = WAIT;
  const r = await m.hooks["tool.call"]!(m.$, { tool: "AskUserQuestion" }, async () => "result");
  assert.equal(r, "result");
  assert.ok(m.opened.length >= 1);
  m.open.get("ukagai-waiting")!.isPlaced = false;
  const before = m.opened.length;
  await m.hooks["tool.call"]!(m.$, { tool: "AskUserQuestion" }, async () => "result");
  assert.equal(m.opened.length, before + 1, "opened again with this hook's $");
});

test("a reload that finds the pane open with nothing waiting closes it", async () => {
  const m = setup();
  m.open.set("ukagai-waiting", { id: "ukagai-waiting", isPlaced: true });
  await m.start();
  assert.deepEqual(m.closed, ["ukagai-waiting"]);
});

test("without $.ui: no error and no pane", async () => {
  const m = setup({}, { noUi: true });
  await m.start();
  m.state.poll = WAIT;
  await m.tick();
  await m.hooks["ui.close"]!(m.$, { id: "ukagai-waiting", origin: { kind: "person" } }, m.next);
  assert.equal((await m.hooks["tool.call"]!(m.$, { tool: "AskUserQuestion" }, async () => 1)), 1);
  assert.equal(m.opened.length, 0);
});
