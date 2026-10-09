import { cleanEnv } from "./clean-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { shellSplit } from "../../src/settings/agents.js";

const CLI = resolve("src/cli.ts");
const TSX = import.meta.resolve("tsx");
const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

interface Env { dir: string; home: string; codex: string; data: string; bin: string; flags: string[] }

/** A temp HOME with nothing in it: no agent is found until a test adds a marker */
async function setup(): Promise<Env> {
  const dir = await mkdtemp(join(tmpdir(), "ukagai-agents-"));
  const [home, codex, data, bin] = ["home", "codex", "data", "bin"].map((n) => join(dir, n)) as [string, string, string, string];
  // The Codex home exists (empty) like a real one: Codex spells hooks.json with symlinks resolved, and that spelling only
  // differs from the one install writes when the directory does not exist yet (/var vs /private/var on macOS)
  await mkdir(home);
  await mkdir(bin);
  await mkdir(codex);
  return { dir, home, codex, data, bin, flags: ["--codex-home", codex, "--data-dir", data, "--server", "http://127.0.0.1:9"] };
}
const markClaude = (e: Env): Promise<void> => writeFile(join(e.home, ".claude.json"), "{}");
const markCodex = (e: Env): Promise<unknown> => mkdir(join(e.codex, "sessions"), { recursive: true });
const stub = async (e: Env, name: string): Promise<void> => {
  await writeFile(join(e.bin, name), "#!/bin/sh\n");
  await chmod(join(e.bin, name), 0o755);
};

function ukagai(e: Env, args: string[], extra: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((res) => {
    execFile(process.execPath, ["--import", TSX, CLI, ...args], { cwd: e.dir, env: cleanEnv({ HOME: e.home, ...extra }) }, (er, out, err) => {
      res({ code: er ? ((er as { code?: number }).code ?? 1) : 0, out, err });
    });
  });
}
/** PATH with the stubs dir in front (the stubs are `claude` / `codex` that do nothing) */
const withBin = (e: Env): Record<string, string> => ({ PATH: `${e.bin}:/usr/bin:/bin` });

const claudeSettings = (e: Env): string => join(e.home, ".claude", "settings.json");
const hooksJson = (e: Env): string => join(e.codex, "hooks.json");
const read = (f: string): Promise<string> => readFile(f, "utf8");
const baks = async (dir: string): Promise<string[]> => (await readdir(dir).catch(() => [] as string[])).filter((f) => f.includes(".bak-"));
const agentsLine = (out: string): string => out.split("\n").find((l) => l.startsWith("agents:")) ?? "";

// ---- detection ----

test("install with nothing found: one line, exit 0, nothing written", async () => {
  const e = await setup();
  const r = await ukagai(e, ["install", ...e.flags]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^no agent found \(looked for claude on PATH, ~\/\.claude\.json, ~\/\.claude\/projects, codex on PATH, .*\/codex\/sessions\): install Claude Code or Codex CLI, then run: ukagai install\n$/);
  assert.deepEqual(await readdir(e.home), []);
  assert.deepEqual(await readdir(e.dir), ["bin", "codex", "home"], "no data dir");
  assert.deepEqual(await readdir(e.codex), []);
});

test("install registers Claude Code only when only Claude Code is found", async () => {
  const e = await setup();
  await markClaude(e);
  const r = await ukagai(e, ["install", ...e.flags]);
  assert.equal(r.code, 0, r.err);
  assert.match(agentsLine(r.out), /^agents: +Claude Code \(~\/\.claude\.json\)$/);
  assert.ok(await exists(claudeSettings(e)));
  assert.ok(!(await exists(hooksJson(e))));
  assert.match(r.out, /next: +start claude or codex/);
});

test("install registers Codex CLI only when only Codex CLI is found", async () => {
  const e = await setup();
  await markCodex(e);
  const r = await ukagai(e, ["install", ...e.flags]);
  assert.equal(r.code, 0, r.err);
  assert.match(agentsLine(r.out), /^agents: +Codex CLI \(.*\/codex\/sessions\)$/);
  assert.match(await read(hooksJson(e)), /managed-by/);
  assert.ok(!(await exists(join(e.home, ".claude"))), "Claude Code is left alone");
});

test("install registers both when both are found", async () => {
  const e = await setup();
  await markClaude(e);
  await markCodex(e);
  const r = await ukagai(e, ["install", ...e.flags]);
  assert.equal(r.code, 0, r.err);
  assert.match(agentsLine(r.out), /Claude Code .*, Codex CLI /);
  assert.ok(await exists(claudeSettings(e)));
  assert.match(await read(hooksJson(e)), /managed-by/);
});

test("a claude / codex executable on PATH counts as found; ~/.claude/projects too; ~/.claude/settings.json alone does not", async () => {
  const e = await setup();
  await mkdir(join(e.home, ".claude"));
  await writeFile(join(e.home, ".claude", "settings.json"), "{}");
  await mkdir(join(e.home, ".claude", "skills"));
  const none = await ukagai(e, ["install", "--dry-run", ...e.flags], withBin(e));
  assert.match(none.out, /^no agent found/, "what an old install / uninstall leaves behind is not a Claude Code user");

  await stub(e, "claude");
  assert.match(agentsLine((await ukagai(e, ["install", "--dry-run", ...e.flags], withBin(e))).out), /^agents: +Claude Code \(claude on PATH\)$/);
  await stub(e, "codex");
  assert.match(agentsLine((await ukagai(e, ["install", "--dry-run", ...e.flags], withBin(e))).out), /^agents: +Claude Code \(claude on PATH\), Codex CLI \(codex on PATH\)$/);
  assert.match((await ukagai(e, ["install", "--dry-run", ...e.flags])).out, /^no agent found/, "the stubs are only found through PATH");

  await mkdir(join(e.home, ".claude", "projects"));
  assert.match(agentsLine((await ukagai(e, ["install", "--dry-run", ...e.flags])).out), /^agents: +Claude Code \(~\/\.claude\/projects\)$/);
});

test("a non-executable file named claude on PATH is not found", async () => {
  const e = await setup();
  await writeFile(join(e.bin, "claude"), "#!/bin/sh\n");
  const r = await ukagai(e, ["install", "--dry-run", ...e.flags], withBin(e));
  assert.match(r.out, /^no agent found/);
});

test("the Codex home comes from --codex-home, then $CODEX_HOME, then ~/.codex", async () => {
  const e = await setup();
  const viaEnv = join(e.dir, "env-codex");
  await mkdir(join(viaEnv, "sessions"), { recursive: true });
  const noFlag = ["--data-dir", e.data, "--server", "http://127.0.0.1:9"];
  assert.match(agentsLine((await ukagai(e, ["install", "--dry-run", ...noFlag], { CODEX_HOME: viaEnv })).out), /Codex CLI \(.*env-codex\/sessions\)/);
  assert.match((await ukagai(e, ["install", "--dry-run", ...e.flags], { CODEX_HOME: viaEnv })).out, /^no agent found/, "--codex-home wins over $CODEX_HOME");
  await mkdir(join(e.home, ".codex", "sessions"), { recursive: true });
  assert.match(agentsLine((await ukagai(e, ["install", "--dry-run", ...noFlag])).out), /Codex CLI \(~\/\.codex\/sessions\)/);
});

// ---- options survive a re-registration ----

const OPTS = ["--timeout", "600", "--observe", "--no-autostart"];
const hookArgs = async (e: Env): Promise<string[][]> =>
  Object.values<any[]>(JSON.parse(await read(claudeSettings(e))).hooks).flatMap((g) => g.flatMap((x: any) => x.hooks.map((h: any) => h.args as string[])));

async function registerBoth(e: Env, extra: string[] = OPTS): Promise<void> {
  const r = await ukagai(e, ["install", "--claude", "--codex", ...extra, ...e.flags]);
  assert.equal(r.code, 0, r.err);
}

test("install --refresh keeps every registered option: settings.json, hooks.json and config.toml come out byte for byte, with no backups", async () => {
  const e = await setup();
  await registerBoth(e);
  const files = [claudeSettings(e), hooksJson(e), join(e.codex, "config.toml")];
  const before = await Promise.all(files.map(read));
  const r = await ukagai(e, ["install", "--refresh", "--codex-home", e.codex]);
  assert.equal(r.code, 0, r.err);
  assert.match(agentsLine(r.out), /^agents: +Claude Code \(registered\), Codex CLI \(registered\)$/);
  assert.deepEqual(await Promise.all(files.map(read)), before);
  assert.deepEqual(await baks(join(e.home, ".claude")), []);
  assert.deepEqual(await baks(e.codex), []);
  // the options really were in there, so equality means they were read back
  const args = await hookArgs(e);
  assert.ok(args.some((a) => a.includes("--observe")) && args.some((a) => a.includes("--no-autostart")));
  assert.ok(args.some((a) => a[a.indexOf("--budget") + 1] === "590"));
  assert.ok(args.every((a) => a[a.indexOf("--data-dir") + 1] === e.data && a[a.indexOf("--server") + 1] === "http://127.0.0.1:9"));
});

test("install without arguments also keeps the options of the agents that are registered", async () => {
  const e = await setup();
  await registerBoth(e);
  await markClaude(e);
  await markCodex(e);
  const files = [claudeSettings(e), hooksJson(e), join(e.codex, "config.toml")];
  const before = await Promise.all(files.map(read));
  const r = await ukagai(e, ["install", "--codex-home", e.codex]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(await Promise.all(files.map(read)), before);
});

test("an explicit option overrides the registered one and the others stay", async () => {
  const e = await setup();
  await registerBoth(e);
  const r = await ukagai(e, ["install", "--refresh", "--timeout", "900", "--codex-home", e.codex]);
  assert.equal(r.code, 0, r.err);
  const args = await hookArgs(e);
  assert.ok(args.some((a) => a[a.indexOf("--budget") + 1] === "890"));
  assert.ok(args.some((a) => a.includes("--observe")) && args.some((a) => a.includes("--no-autostart")));
  assert.match(await read(hooksJson(e)), /--budget 890/);
  assert.match(await read(hooksJson(e)), /--no-autostart/);
});

test("--refresh touches only the agents that are registered", async () => {
  const e = await setup();
  await markCodex(e);
  const r0 = await ukagai(e, ["install", "--claude", ...OPTS, ...e.flags]);
  assert.equal(r0.code, 0, r0.err);
  const before = await read(claudeSettings(e));
  const r = await ukagai(e, ["install", "--refresh", "--codex-home", e.codex]);
  assert.equal(r.code, 0, r.err);
  assert.match(agentsLine(r.out), /^agents: +Claude Code \(registered\)$/);
  assert.equal(await read(claudeSettings(e)), before);
  assert.ok(!(await exists(hooksJson(e))), "Codex CLI was found but never registered: --refresh does not add it");
});

test("--refresh with nothing registered: one line, exit 0, nothing written", async () => {
  const e = await setup();
  await markClaude(e);
  await markCodex(e);
  const r = await ukagai(e, ["install", "--refresh", ...e.flags]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "no ukagai hooks are registered; nothing to refresh (run: ukagai install)\n");
  assert.ok(!(await exists(join(e.home, ".claude", "settings.json"))));
  assert.ok(!(await exists(hooksJson(e))));
  assert.ok(!(await exists(e.data)));
});

test("--refresh together with --codex narrows to that agent, and only when it is registered", async () => {
  const e = await setup();
  await registerBoth(e);
  const before = await read(claudeSettings(e));
  const r = await ukagai(e, ["install", "--refresh", "--codex", "--timeout", "900", "--codex-home", e.codex]);
  assert.equal(r.code, 0, r.err);
  assert.match(agentsLine(r.out), /^agents: +Codex CLI \(registered\)$/);
  assert.equal(await read(claudeSettings(e)), before);
  assert.match(await read(hooksJson(e)), /--budget 890/);
});

test("--refresh is an unknown argument of uninstall and doctor (exit 2) and is listed by install --help", async () => {
  const e = await setup();
  for (const c of ["uninstall", "doctor"]) {
    const r = await ukagai(e, [c, "--refresh", ...e.flags]);
    assert.equal(r.code, 2, c);
    assert.match(r.err, /unknown argument: --refresh/);
  }
  assert.match((await ukagai(e, ["install", "--help"])).out, /--refresh/);
});

// ---- one agent's failure stays with it ----

test("a broken hooks.json does not stop Claude Code's registration, and the exit code is 1", async () => {
  const e = await setup();
  await markClaude(e);
  await markCodex(e);
  await writeFile(hooksJson(e), "{ not json");
  const r = await ukagai(e, ["install", ...e.flags]);
  assert.equal(r.code, 1);
  assert.match(r.err, /codex: error: .*hooks\.json is not valid JSON/);
  assert.match(await read(claudeSettings(e)), /managed-by/);
  assert.equal(await read(hooksJson(e)), "{ not json", "the broken file is not rewritten");
  assert.match(r.out, /next:/, "Claude Code was registered");
});

test("--refresh isolates failures the same way", async () => {
  const e = await setup();
  await registerBoth(e);
  await writeFile(hooksJson(e), "{ not json");
  const r = await ukagai(e, ["install", "--refresh", "--timeout", "900", "--codex-home", e.codex]);
  assert.equal(r.code, 1);
  assert.match(r.err, /codex: error:/);
  assert.ok((await hookArgs(e)).some((a) => a[a.indexOf("--budget") + 1] === "890"), "Claude Code was still refreshed");
});

test("with an explicit agent flag an error is not isolated: exit 1 with the plain message", async () => {
  const e = await setup();
  await writeFile(hooksJson(e), "{ not json");
  const r = await ukagai(e, ["install", "--codex", ...e.flags]);
  assert.equal(r.code, 1);
  assert.match(r.err, /^ukagai install: .*not valid JSON/);
});

// ---- backups ----

test("a second install with the same content makes no backup and says unchanged", async () => {
  const e = await setup();
  await markClaude(e);
  await markCodex(e);
  await mkdir(join(e.home, ".claude"));
  await writeFile(claudeSettings(e), JSON.stringify({ model: "opus" }));
  const first = await ukagai(e, ["install", ...e.flags]);
  assert.equal(first.code, 0, first.err);
  assert.equal((await baks(join(e.home, ".claude"))).length, 1, "the first install changes the file");
  const claudeBefore = await read(claudeSettings(e));
  const second = await ukagai(e, ["install", ...e.flags]);
  assert.equal(second.code, 0, second.err);
  assert.equal((await baks(join(e.home, ".claude"))).length, 1);
  assert.equal(await read(claudeSettings(e)), claudeBefore);
  assert.match(second.out, /settings: .*settings\.json \(unchanged\)/);
  assert.deepEqual(await baks(e.codex), []);
});

// ---- uninstall ----

interface Stub { server: Server; url: string; shutdowns: number }
async function stubServer(token: string): Promise<Stub> {
  const s = { shutdowns: 0 } as Stub;
  s.server = createServer((req, res) => {
    if (req.url === "/healthz") return void res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    if (req.method === "POST" && req.url === "/api/shutdown" && req.headers.authorization === `Bearer ${token}`) {
      s.shutdowns++;
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      s.server.close();
      s.server.closeAllConnections();
      return;
    }
    res.writeHead(401).end();
  });
  await new Promise<void>((r) => s.server.listen(0, "127.0.0.1", r));
  s.url = `http://127.0.0.1:${(s.server.address() as { port: number }).port}`;
  return s;
}

test("uninstall without arguments removes both agents' hooks and stops the server", async () => {
  const e = await setup();
  await mkdir(e.data);
  await writeFile(join(e.data, "token"), "secret\n");
  const srv = await stubServer("secret");
  try {
    const flags = ["--codex-home", e.codex, "--data-dir", e.data, "--server", srv.url];
    assert.equal((await ukagai(e, ["install", "--claude", "--codex", ...flags])).code, 0);
    const r = await ukagai(e, ["uninstall", ...flags]);
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(await read(claudeSettings(e)), /managed-by/);
    assert.ok(!(await exists(hooksJson(e))) || !/managed-by/.test(await read(hooksJson(e))));
    assert.match(r.out, new RegExp(`server: +stopped ${srv.url}`));
    assert.equal(srv.shutdowns, 1);
  } finally {
    srv.server.close();
  }
});

test("uninstall without arguments does not create ~/.codex for someone who never used Codex", async () => {
  const e = await setup();
  await markClaude(e);
  const noCodexFlag = ["--data-dir", e.data, "--server", "http://127.0.0.1:9"];
  assert.equal((await ukagai(e, ["install", "--claude", ...noCodexFlag])).code, 0);
  const r = await ukagai(e, ["uninstall", ...noCodexFlag]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /codex: +no ukagai hooks are registered/);
  assert.ok(!(await exists(join(e.home, ".codex"))), "~/.codex was not created");
});

test("uninstall without arguments with a broken Codex home: codex: error, exit 1, Claude Code is still removed, the server is left", async () => {
  const e = await setup();
  await mkdir(e.data);
  await writeFile(join(e.data, "token"), "secret\n");
  const srv = await stubServer("secret");
  try {
    const flags = ["--codex-home", e.codex, "--data-dir", e.data, "--server", srv.url];
    assert.equal((await ukagai(e, ["install", "--claude", "--codex", ...flags])).code, 0);
    await writeFile(hooksJson(e), "{ not json");
    const r = await ukagai(e, ["uninstall", ...flags]);
    assert.equal(r.code, 1);
    assert.match(r.err, /codex: error:/);
    assert.doesNotMatch(await read(claudeSettings(e)), /managed-by/);
    assert.match(r.out, /server: +left running/);
    assert.equal(srv.shutdowns, 0);
  } finally {
    srv.server.close();
  }
});

// ---- doctor ----

test("doctor without arguments: Claude Code registered, codex on PATH: no Codex rows, no problems", async () => {
  const e = await setup();
  await markClaude(e);
  await stub(e, "codex");
  assert.equal((await ukagai(e, ["install", "--claude", ...e.flags])).code, 0);
  const r = await ukagai(e, ["doctor", ...e.flags], withBin(e));
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /codex/i);
  assert.match(r.out, /hook PreToolUse/);
  assert.match(r.out, /no problems/);
});

test("doctor without arguments: Codex registered only: only Codex rows", async () => {
  const e = await setup();
  assert.equal((await ukagai(e, ["install", "--codex", ...e.flags])).code, 0);
  const r = await ukagai(e, ["doctor", ...e.flags]);
  assert.match(r.out, /○ +codex hook PreToolUse +trusted/);
  assert.doesNotMatch(r.out, /[○×] +hook /, "no Claude hook rows");
  assert.doesNotMatch(r.out, /skill ukagai-explain/);
});

test("doctor without arguments and nothing registered: the found agents; when none, Claude Code", async () => {
  const e = await setup();
  const none = await ukagai(e, ["doctor", ...e.flags]);
  assert.equal(none.code, 1);
  assert.match(none.out, /× +hook PreToolUse +not registered/);
  assert.doesNotMatch(none.out, /codex/i);
  await markCodex(e);
  const found = await ukagai(e, ["doctor", ...e.flags]);
  assert.match(found.out, /× +codex hook PreToolUse +not registered \(run: ukagai install --codex\)/);
  assert.doesNotMatch(found.out, /hook PreToolUse \(checkpoint\)/);
});

test("doctor says which install command repairs a Claude Code row", async () => {
  const e = await setup();
  const r = await ukagai(e, ["doctor", "--claude", ...e.flags]);
  assert.match(r.out, /hook PreToolUse \(checkpoint\) +not registered \(run: ukagai install --claude\)/);
});

// ---- shellSplit ----

test("shellSplit reads back what hookCommand writes: bare words, 'quoted', \"plugin\" paths and the '\\'' escape", () => {
  assert.deepEqual(shellSplit("/usr/bin/ukagai hook --agent codex --budget 590"), ["/usr/bin/ukagai", "hook", "--agent", "codex", "--budget", "590"]);
  assert.deepEqual(shellSplit("'/a b/ukagai' hook --data-dir 'it'\\''s here'"), ["/a b/ukagai", "hook", "--data-dir", "it's here"]);
  assert.deepEqual(shellSplit('"${PLUGIN_ROOT}/bin/ukagai" hook'), ["${PLUGIN_ROOT}/bin/ukagai", "hook"]);
  assert.deepEqual(shellSplit("a '' b"), ["a", "", "b"]);
});
