import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AutostartDeps } from "../../src/hook/autostart.js";
import { sessionContext } from "../../src/hook/context-hooks.js";
import { parseArgs } from "../../src/hook/options.js";
import { tmpDir } from "./helpers.js";

const RAW = { session_id: "s", transcript_path: "/t", cwd: "/c", hook_event_name: "SessionStart" };

function setup(opts: { up: boolean | "after-spawn"; extra?: string[]; server?: string; hang?: boolean }) {
  const dd = tmpDir();
  writeFileSync(join(dd, "token"), "tok\n");
  const spawns: { cmd: string; args: string[]; o: any }[] = [];
  const posts: { url: string; method: string; body: unknown; auth: string }[] = [];
  let fetches = 0;
  let started = false;
  const realFetch = globalThis.fetch;
  // Client uses the global fetch: stub it for the POST, restore in restore()
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    posts.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: String((init?.headers as any)?.Authorization) });
    if (opts.hang) return new Promise((_, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
    return new Response(JSON.stringify({ result: "connected" }), { status: 200 });
  }) as typeof fetch;
  const deps: AutostartDeps = {
    fetch: (async () => {
      fetches++;
      const ok = opts.up === true || (opts.up === "after-spawn" && started);
      if (!ok) throw new Error("ECONNREFUSED");
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
    spawn: (cmd, args, o) => {
      spawns.push({ cmd, args, o });
      if (args.includes("serve")) started = true;
      return { unref() {} };
    },
    cliPath: "/x/dist/cli.js",
    sleep: async () => {},
  };
  const hookOpts = parseArgs(["--data-dir", dd, "--server", opts.server ?? "http://127.0.0.1:4831", ...(opts.extra ?? [])]);
  return { dd, spawns, posts, deps, hookOpts, fetches: () => fetches, restore: () => { globalThis.fetch = realFetch; } };
}

const guiPosts = (s: ReturnType<typeof setup>) => s.posts.filter((p) => p.url.endsWith("/api/gui/open"));

test("reachable: exactly one POST /api/gui/open, no marker, no opener spawn", async () => {
  const s = setup({ up: true });
  try {
    const out = await sessionContext(RAW, s.hookOpts, s.deps);
    assert.ok(out);
    assert.equal(guiPosts(s).length, 1);
    assert.equal(guiPosts(s)[0]!.method, "POST");
    assert.deepEqual(guiPosts(s)[0]!.body, {});
    assert.equal(guiPosts(s)[0]!.auth, "Bearer tok");
    assert.equal(s.spawns.length, 0);
    assert.ok(!existsSync(join(s.dd, "gui-opened")));
  } finally {
    s.restore();
  }
});

test("unreachable: starts serve with the expected arguments, then asks once healthz passes", async () => {
  const s = setup({ up: "after-spawn" });
  try {
    const out = await sessionContext(RAW, s.hookOpts, s.deps);
    assert.ok(out);
    assert.equal(s.spawns.length, 1);
    assert.equal(s.spawns[0]!.cmd, process.execPath);
    assert.deepEqual(s.spawns[0]!.args, ["/x/dist/cli.js", "serve", "--port", "4831", "--data-dir", s.dd]);
    assert.equal(s.spawns[0]!.o.detached, true);
    assert.equal(guiPosts(s).length, 1);
    assert.ok(existsSync(join(s.dd, "serve.log")));
  } finally {
    s.restore();
  }
});

test("healthz never passes after start: no POST, additionalContext is still returned", async () => {
  const s = setup({ up: false });
  try {
    const out = await sessionContext(RAW, s.hookOpts, s.deps);
    assert.ok((out as any).hookSpecificOutput.additionalContext);
    assert.equal(s.spawns.length, 1);
    assert.equal(guiPosts(s).length, 0);
  } finally {
    s.restore();
  }
});

test("a POST that hangs is cut at the timeout and does not throw", async () => {
  const s = setup({ up: true, hang: true });
  try {
    const t0 = Date.now();
    const out = await sessionContext(RAW, s.hookOpts, s.deps);
    assert.ok(out);
    assert.ok(Date.now() - t0 < 2000);
    assert.equal(guiPosts(s).length, 1);
  } finally {
    s.restore();
  }
});

test("does not auto-start when the server is on another host", async () => {
  const s = setup({ up: false, server: "http://example.com:4818" });
  try {
    const out = await sessionContext(RAW, s.hookOpts, s.deps);
    assert.ok(out);
    assert.equal(s.spawns.length, 0);
  } finally {
    s.restore();
  }
});

test("--no-autostart: nothing at all", async () => {
  const s = setup({ up: false, extra: ["--no-autostart"] });
  try {
    const out = await sessionContext(RAW, s.hookOpts, s.deps);
    assert.ok(out);
    assert.equal(s.fetches(), 0);
    assert.equal(s.spawns.length, 0);
    assert.equal(s.posts.length, 0);
  } finally {
    s.restore();
  }
});

test("SubagentStart: does nothing", async () => {
  const s = setup({ up: false });
  try {
    const out = await sessionContext({ ...RAW, hook_event_name: "SubagentStart" }, s.hookOpts, s.deps);
    assert.ok(out);
    assert.equal(s.fetches(), 0);
    assert.equal(s.spawns.length, 0);
    assert.equal(s.posts.length, 0);
  } finally {
    s.restore();
  }
});

// ---- a running server of another version / with a replaced dist is restarted ----

/** A server whose healthz body is `health` until POST /api/shutdown (answered `shutdownStatus`), then (optionally) it is down until a spawn */
function stale(health: Record<string, unknown>, o: { shutdownStatus?: number; stopsOnShutdown?: boolean; version?: string; exists?: (p: string) => boolean } = {}) {
  const s = setup({ up: true });
  const calls: string[] = [];
  let down = false;
  let started = false;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push(`${init?.method ?? "GET"} ${path}`);
    s.posts.push({ url, method: init?.method ?? "GET", body: undefined, auth: String((init?.headers as any)?.Authorization) });
    if (path === "/api/shutdown") {
      if ((o.shutdownStatus ?? 200) === 200 && (o.stopsOnShutdown ?? true)) down = true;
      return new Response("{}", { status: o.shutdownStatus ?? 200 });
    }
    return new Response(JSON.stringify({ result: "connected" }), { status: 200 });
  }) as typeof fetch;
  s.deps.fetch = (async () => {
    calls.push("GET /healthz");
    if (down && !started) throw new Error("ECONNREFUSED");
    return new Response(JSON.stringify({ ok: true, ...health }), { status: 200 });
  }) as typeof fetch;
  const spawn = s.deps.spawn;
  s.deps.spawn = (cmd, args, opts) => {
    started = true;
    return spawn(cmd, args, opts);
  };
  s.deps.version = o.version ?? "1.2.0";
  if (o.exists) s.deps.exists = o.exists;
  return { ...s, calls, shutdowns: () => calls.filter((c) => c === "POST /api/shutdown").length };
}

test("same version and cli present: no shutdown, no spawn", async () => {
  const s = stale({ version: "1.2.0", cli: "/x/dist/cli.js" }, { exists: () => true });
  try {
    await sessionContext(RAW, s.hookOpts, s.deps);
    assert.equal(s.shutdowns(), 0);
    assert.equal(s.spawns.length, 0);
    assert.equal(guiPosts(s).length, 1);
  } finally {
    s.restore();
  }
});

test("a healthz without version / cli (an older server): left alone", async () => {
  const s = stale({}, { exists: () => false });
  try {
    await sessionContext(RAW, s.hookOpts, s.deps);
    assert.equal(s.shutdowns(), 0);
    assert.equal(s.spawns.length, 0);
  } finally {
    s.restore();
  }
});

test("another version: shutdown with the bearer token, then a new server is spawned once", async () => {
  const s = stale({ version: "1.1.0", cli: "/x/dist/cli.js" }, { exists: () => true });
  try {
    await sessionContext(RAW, s.hookOpts, s.deps);
    assert.equal(s.shutdowns(), 1);
    assert.equal(s.posts.find((p) => p.url.endsWith("/api/shutdown"))!.auth, "Bearer tok");
    assert.equal(s.spawns.length, 1);
    assert.ok(s.spawns[0]!.args.includes("serve"));
    assert.ok(s.calls.indexOf("POST /api/shutdown") < s.calls.length - 1);
    assert.equal(guiPosts(s).length, 1);
  } finally {
    s.restore();
  }
});

test("cli file gone: same restart", async () => {
  const s = stale({ version: "1.2.0", cli: "/old/versions/1.2.0/dist/cli.js" }, { exists: () => false });
  try {
    await sessionContext(RAW, s.hookOpts, s.deps);
    assert.equal(s.shutdowns(), 1);
    assert.equal(s.spawns.length, 1);
  } finally {
    s.restore();
  }
});

test("shutdown refused: fail open, nothing is spawned, the GUI request still goes to the running server", async () => {
  const s = stale({ version: "1.1.0" }, { shutdownStatus: 500 });
  try {
    const out = await sessionContext(RAW, s.hookOpts, s.deps);
    assert.ok(out);
    assert.equal(s.shutdowns(), 1);
    assert.equal(s.spawns.length, 0);
    assert.equal(guiPosts(s).length, 1);
  } finally {
    s.restore();
  }
});

test("shutdown accepted but the server never goes down: waits at most 3 s, spawns nothing", async () => {
  const s = stale({ version: "1.1.0" }, { stopsOnShutdown: false });
  // a fake clock: every sleep advances it, nothing waits in wall time
  let clock = 0;
  s.deps.sleep = async (ms) => {
    clock += ms;
  };
  try {
    await sessionContext(RAW, s.hookOpts, s.deps);
    assert.equal(s.shutdowns(), 1, "the shutdown was asked");
    assert.equal(s.spawns.length, 0);
    const probes = s.calls.filter((c) => c === "GET /healthz").length;
    // the wait loop polls every 100 ms for 3 s: 1 first probe + 30 polls; both bounds fail if the loop is removed or unbounded
    assert.ok(probes >= 1 + 30, `expected at least 31 healthz probes, got ${probes}`);
    assert.ok(probes <= 1 + 30 + 1, `expected at most 32 healthz probes, got ${probes}`);
    assert.ok(clock >= 3000 && clock <= 3100, `waited ${clock} ms on the fake clock`);
  } finally {
    s.restore();
  }
});
