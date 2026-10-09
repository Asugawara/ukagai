import { cleanEnv } from "./clean-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { symlink, chmod } from "node:fs/promises";
import { createServer, type Server } from "node:http";

const CLI = resolve("src/cli.ts");
const TSX = import.meta.resolve("tsx");

interface Env { home: string; dir: string; settings: string }
async function setup(): Promise<Env> {
  const dir = await mkdtemp(join(tmpdir(), "ukagai-w6-"));
  const home = join(dir, "home");
  await mkdir(home);
  return { home, dir, settings: join(dir, "settings.json") };
}
function ukagai(env: Env, args: string[], cwd = env.dir, extra: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((res) => {
    execFile(process.execPath, ["--import", TSX, CLI, ...args], { cwd, env: cleanEnv({ HOME: env.home, ...extra }) }, (e, out, err) => {
      res({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out, err });
    });
  });
}
const readJson = async (f: string): Promise<any> => JSON.parse(await readFile(f, "utf8"));
const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);
const count = (s: any): number => Object.values<any[]>(s.hooks).reduce((n, g) => n + g.reduce((m, x) => m + x.hooks.length, 0), 0);
const EVENTS = ["PreToolUse", "PermissionRequest", "SessionStart", "SubagentStart", "UserPromptSubmit", "Stop", "SubagentStop", "PostToolUse", "SessionEnd", "Notification"];
const SKILL = (e: Env): string => join(e.home, ".claude", "skills", "ukagai-explain", "SKILL.md");
const OTHER = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "/usr/bin/other", args: ["x"] }] }] }, model: "opus" };

test("install into empty settings: all events, exec form, statusMessage, --budget 3590, skill", async () => {
  const e = await setup();
  const r = await ukagai(e, ["install", "--settings", e.settings]);
  assert.equal(r.code, 0, r.err);
  const s = await readJson(e.settings);
  assert.deepEqual(Object.keys(s.hooks).sort(), [...EVENTS].sort());
  const pre = s.hooks.PreToolUse[0];
  assert.equal(pre.matcher, "AskUserQuestion|ExitPlanMode");
  const h = pre.hooks[0];
  assert.equal(h.type, "command");
  assert.equal(h.command, process.execPath);
  assert.match(h.args[0], /dist[\\/]cli\.js$/);
  assert.equal(h.args[1], "hook");
  assert.equal(h.args[h.args.indexOf("--budget") + 1], "3590");
  assert.equal(h.statusMessage, "ukagai: waiting for an answer in the GUI");
  assert.equal(h.timeout, 3600);
  assert.equal(s.hooks.PermissionRequest.length, 1);
  assert.equal(s.hooks.PermissionRequest[0].matcher, undefined, "PermissionRequest matches every tool");
  assert.equal(s.hooks.PermissionRequest[0].hooks[0].timeout, 5);
  assert.equal(s.hooks.PermissionRequest[0].hooks[0].async, undefined);
  assert.equal(s.hooks.SessionEnd[0].hooks[0].timeout, 2);
  assert.equal(s.hooks.Stop[0].hooks[0].async, true);
  assert.equal(s.hooks.Stop[0].hooks[0].timeout, 5);
  assert.equal(s.hooks.SubagentStop[0].hooks[0].async, true);
  assert.equal(s.hooks.SessionStart[0].hooks[0].async, undefined);
  assert.ok(!(await exists(join(e.home, ".claude"))), "--settings does not touch the skill");
});

test("skill is placed only with --settings + --skill, and uninstall removes it only with --skill", async () => {
  const e = await setup();
  await ukagai(e, ["install", "--settings", e.settings, "--skill"]);
  assert.ok(await exists(SKILL(e)));
  const r1 = await ukagai(e, ["uninstall", "--settings", e.settings]);
  assert.doesNotMatch(r1.out, /skill:/);
  assert.ok(await exists(SKILL(e)), "uninstall with --settings only does not remove the skill");
  const r2 = await ukagai(e, ["uninstall", "--settings", e.settings, "--skill"]);
  assert.match(r2.out, /skill:/);
  assert.ok(!(await exists(SKILL(e))));
});

test("--data-dir / --server go into every hook's args when given, and not when omitted", async () => {
  const e = await setup();
  const dd = join(e.dir, "data");
  await ukagai(e, ["install", "--settings", e.settings, "--data-dir", dd, "--server", "http://127.0.0.1:9999/"]);
  const s = await readJson(e.settings);
  const hooks = Object.values<any[]>(s.hooks).flatMap((g) => g.flatMap((x) => x.hooks));
  assert.equal(hooks.length, EVENTS.length + 3); // + the checkpoint and the two plan-context groups
  for (const h of hooks) {
    assert.equal(h.args[h.args.indexOf("--data-dir") + 1], dd);
    assert.equal(h.args[h.args.indexOf("--server") + 1], "http://127.0.0.1:9999");
  }
  const e2 = await setup();
  await ukagai(e2, ["install", "--settings", e2.settings]);
  const s2 = await readJson(e2.settings);
  for (const g of Object.values<any[]>(s2.hooks)) {
    for (const h of g.flatMap((x) => x.hooks)) {
      assert.ok(!h.args.includes("--data-dir") && !h.args.includes("--server"));
    }
  }
});

test("--help of the 5 subcommands exits 0 and prints usage", async () => {
  const e = await setup();
  for (const c of ["serve", "hook", "install", "uninstall", "doctor"]) {
    for (const f of ["--help", "-h"]) {
      const r = await ukagai(e, [c, f]);
      assert.equal(r.code, 0, `${c} ${f}: ${r.err}`);
      assert.match(r.out, new RegExp(`Usage: ukagai ${c}`));
    }
  }
});

test("a second install leaves a .bak", async () => {
  const e = await setup();
  await writeFile(e.settings, JSON.stringify(OTHER));
  await ukagai(e, ["install", "--settings", e.settings]);
  const baks = (await readdir(e.dir)).filter((f) => f.startsWith("settings.json.bak-"));
  assert.equal(baks.length, 1);
  assert.deepEqual(await readJson(join(e.dir, baks[0]!)), OTHER);
});

test("keeps existing hooks and does not duplicate on a second install", async () => {
  const e = await setup();
  await writeFile(e.settings, JSON.stringify(OTHER));
  await ukagai(e, ["install", "--settings", e.settings]);
  const s1 = await readJson(e.settings);
  assert.equal(s1.model, "opus");
  assert.deepEqual(s1.hooks.SessionStart[0], OTHER.hooks.SessionStart[0]);
  assert.equal(s1.hooks.SessionStart.length, 2);
  const n = count(s1);
  await ukagai(e, ["install", "--settings", e.settings]);
  const s2 = await readJson(e.settings);
  assert.equal(count(s2), n);
  assert.deepEqual(s2, s1);
});

test("uninstall restores the equivalent original and removes the skill", async () => {
  const e = await setup();
  await writeFile(e.settings, JSON.stringify(OTHER));
  await ukagai(e, ["install", "--settings", e.settings, "--skill"]);
  const r = await ukagai(e, ["uninstall", "--settings", e.settings, "--skill"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(await readJson(e.settings), OTHER);
  assert.ok(!(await exists(SKILL(e))));
  assert.ok(!(await exists(join(e.home, ".claude", "skills", "ukagai-explain"))));
});

test("uninstall: no empty event keys or hooks remain", async () => {
  const e = await setup();
  await ukagai(e, ["install", "--settings", e.settings]);
  await ukagai(e, ["uninstall", "--settings", e.settings]);
  assert.deepEqual(await readJson(e.settings), {});
});

test("--dry-run does not write", async () => {
  const e = await setup();
  await writeFile(e.settings, JSON.stringify(OTHER));
  const before = await stat(e.settings);
  const r = await ukagai(e, ["install", "--settings", e.settings, "--dry-run"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^\+.*PreToolUse/m);
  const after = await stat(e.settings);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.deepEqual((await readdir(e.dir)).sort(), ["home", "settings.json"]);
  assert.ok(!(await exists(SKILL(e))));
});

test("--observe: --observe on PreToolUse, AskUserQuestion in the PostToolUse matcher", async () => {
  const e = await setup();
  await ukagai(e, ["install", "--settings", e.settings, "--observe"]);
  const s = await readJson(e.settings);
  assert.ok(s.hooks.PreToolUse[0].hooks[0].args.includes("--observe"));
  assert.match(s.hooks.PostToolUse[0].matcher, /AskUserQuestion/);
});

test("--no-autostart: only on the SessionStart hook, not by default", async () => {
  const e = await setup();
  await ukagai(e, ["install", "--settings", e.settings]);
  assert.ok(!(await readJson(e.settings)).hooks.SessionStart[0].hooks[0].args.includes("--no-autostart"));
  await ukagai(e, ["install", "--settings", e.settings, "--no-autostart"]);
  const s = await readJson(e.settings);
  assert.ok(s.hooks.SessionStart[0].hooks[0].args.includes("--no-autostart"));
  assert.ok(!s.hooks.Stop[0].hooks[0].args.includes("--no-autostart"));
});

test("--project writes to .claude/settings.json and .claude/skills", async () => {
  const e = await setup();
  const proj = join(e.dir, "proj");
  await mkdir(proj);
  const r = await ukagai(e, ["install", "--project", "--no-skill"], proj);
  assert.equal(r.code, 0, r.err);
  assert.ok(await exists(join(proj, ".claude", "settings.json")));
  assert.ok(!(await exists(join(proj, ".claude", "skills"))));
  await ukagai(e, ["install", "--project"], proj);
  assert.ok(await exists(join(proj, ".claude", "skills", "ukagai-explain", "SKILL.md")));
  assert.ok(!(await exists(SKILL(e))));
});

test("broken JSON is not rewritten and exits 1", async () => {
  const e = await setup();
  await writeFile(e.settings, "{ not json");
  const r = await ukagai(e, ["install", "--settings", e.settings]);
  assert.equal(r.code, 1);
  assert.equal(await readFile(e.settings, "utf8"), "{ not json");
});

test("doctor: installed, server never started -> ○ \"not started yet\", no problems, exit 0", async () => {
  const e = await setup();
  await ukagai(e, ["install", "--settings", e.settings]);
  const r = await ukagai(e, ["doctor", "--settings", e.settings, "--server", "http://127.0.0.1:1", "--data-dir", join(e.dir, "data")]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /○ +hook PreToolUse/);
  assert.match(r.out, /○ +hook PreToolUse \(plan context\)/);
  assert.match(r.out, /○ +hook UserPromptSubmit \(plan context\)/);
  assert.match(r.out, /○ +server .*not started yet/);
  assert.match(r.out, /○ +token .*not created yet/);
  assert.match(r.out, /no problems/);
  assert.match(r.out, /○ +skill ukagai-explain +not handled/);
});

test("doctor: the token exists but no server answers -> server × with the start hint, exit 1", async () => {
  const e = await setup();
  await ukagai(e, ["install", "--settings", e.settings]);
  const data = join(e.dir, "data");
  await mkdir(data);
  await writeFile(join(data, "token"), "t");
  const r = await ukagai(e, ["doctor", "--settings", e.settings, "--server", "http://127.0.0.1:1", "--data-dir", data]);
  assert.equal(r.code, 1);
  assert.match(r.out, /× +server .*cannot connect \(.*\); start a claude session or run: ukagai serve/);
  assert.match(r.out, /○ +token/);
  assert.match(r.out, /1 problem\(s\) found/);
});

interface Stub { server: Server; url: string; shutdowns: number; up: () => boolean }
/** A server that answers /healthz and stops on POST /api/shutdown with the right bearer */
async function stubServer(token: string): Promise<Stub> {
  const stub = { shutdowns: 0 } as Stub;
  let up = true;
  stub.server = createServer((req, res) => {
    if (req.url === "/healthz") return void res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    if (req.method === "POST" && req.url === "/api/shutdown" && req.headers.authorization === `Bearer ${token}`) {
      stub.shutdowns++;
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      up = false;
      stub.server.close();
      stub.server.closeAllConnections();
      return;
    }
    res.writeHead(401).end();
  });
  await new Promise<void>((r) => stub.server.listen(0, "127.0.0.1", r));
  stub.url = `http://127.0.0.1:${(stub.server.address() as { port: number }).port}`;
  stub.up = () => up;
  return stub;
}

async function serverSetup(args: string[] = ["--claude"]): Promise<{ e: Env; stub: Stub; flags: string[]; codex: string }> {
  const e = await setup();
  const data = join(e.dir, "data");
  await mkdir(data);
  await writeFile(join(data, "token"), "secret\n");
  const stub = await stubServer("secret");
  const codex = join(e.dir, "codex");
  await mkdir(codex);
  const flags = ["--server", stub.url, "--data-dir", data, "--codex-home", codex];
  const r = await ukagai(e, ["install", ...flags, ...args]);
  assert.equal(r.code, 0, r.err);
  return { e, stub, flags, codex };
}

test("uninstall stops the server when no ukagai hook remains", async () => {
  const { e, stub, flags } = await serverSetup();
  try {
    const r = await ukagai(e, ["uninstall", ...flags]);
    assert.equal(r.code, 0, r.err);
    assert.equal(stub.shutdowns, 1);
    assert.ok(!stub.up());
    assert.match(r.out, new RegExp(`server: +stopped ${stub.url}`));
  } finally {
    stub.server.close();
  }
});

test("uninstall of Claude only while Codex hooks exist leaves the server running", async () => {
  const { e, stub, flags } = await serverSetup(["--codex", "--claude"]);
  try {
    const r = await ukagai(e, ["uninstall", "--claude", ...flags]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /server: +left running \(ukagai hooks are still registered for Codex CLI\)/);
    assert.equal(stub.shutdowns, 0);
    assert.ok(stub.up());
    const r2 = await ukagai(e, ["uninstall", "--codex", ...flags]);
    assert.match(r2.out, /server: +stopped/);
    assert.equal(stub.shutdowns, 1);
  } finally {
    stub.server.close();
  }
});

test("uninstall --dry-run says it would stop the server and stops nothing", async () => {
  const { e, stub, flags } = await serverSetup();
  try {
    const r = await ukagai(e, ["uninstall", "--dry-run", ...flags]);
    assert.match(r.out, new RegExp(`server: +would stop ${stub.url}`));
    assert.equal(stub.shutdowns, 0);
    assert.ok(stub.up());
  } finally {
    stub.server.close();
  }
});

test("uninstall --settings <file> (a development target) does not touch the server", async () => {
  const { e, stub, flags } = await serverSetup();
  try {
    await ukagai(e, ["install", "--settings", e.settings, ...flags]);
    const r = await ukagai(e, ["uninstall", "--settings", e.settings, ...flags]);
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(r.out, /server:/);
    assert.equal(stub.shutdowns, 0);
    assert.ok(stub.up());
  } finally {
    stub.server.close();
  }
});

test("uninstall --project (a development target) does not touch the server", async () => {
  const { e, stub, flags } = await serverSetup();
  try {
    const cwd = join(e.dir, "proj");
    await mkdir(cwd);
    await ukagai(e, ["install", "--project", ...flags], cwd);
    const r = await ukagai(e, ["uninstall", "--project", ...flags], cwd);
    assert.equal(r.code, 0, r.err);
    assert.doesNotMatch(r.out, /server:/);
    assert.equal(stub.shutdowns, 0);
    assert.ok(stub.up());
  } finally {
    stub.server.close();
  }
});

test("uninstall: when the hook check itself fails and no server answers, it says not running", async () => {
  const e = await setup();
  const data = join(e.dir, "data");
  await mkdir(data);
  const notADir = join(e.dir, "codex-file");
  await writeFile(notADir, "");
  await ukagai(e, ["install", "--claude", "--server", "http://127.0.0.1:1", "--data-dir", data]);
  // --codex-home pointing at a file makes the Codex hook check throw (ENOTDIR), the catch path; --claude keeps Codex out of the run itself
  const r = await ukagai(e, ["uninstall", "--claude", "--server", "http://127.0.0.1:1", "--data-dir", data, "--codex-home", notADir]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /server: +not running/);
  assert.doesNotMatch(r.out, /still running/);
});

test("uninstall reports a server that refuses to stop (wrong token) and still exits 0", async () => {
  const { e, stub, flags } = await serverSetup();
  try {
    await writeFile(join(e.dir, "data", "token"), "wrong");
    const r = await ukagai(e, ["uninstall", ...flags]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /server: +still running at .*stop it yourself/);
  } finally {
    stub.server.close();
  }
});

test("doctor --skill: detects whether the skill exists", async () => {
  const e = await setup();
  await ukagai(e, ["install", "--settings", e.settings, "--skill"]);
  const args = ["doctor", "--settings", e.settings, "--skill", "--server", "http://127.0.0.1:1", "--data-dir", join(e.dir, "data")];
  assert.match((await ukagai(e, args)).out, /○ +skill ukagai-explain +\S*SKILL\.md/);
  await ukagai(e, ["uninstall", "--settings", e.settings, "--skill"]);
  assert.match((await ukagai(e, args)).out, /× +skill ukagai-explain/);
});

test("upgrade in place: a settings file from before the plan-context group gains it, user hooks stay, no duplicates", async () => {
  const e = await setup();
  await writeFile(e.settings, JSON.stringify(OTHER));
  await ukagai(e, ["install", "--settings", e.settings]);
  const full = await readJson(e.settings);
  const old = JSON.parse(JSON.stringify(full));
  old.hooks.PreToolUse = old.hooks.PreToolUse.filter((g: any) => g.matcher !== "EnterPlanMode");
  old.hooks.UserPromptSubmit = old.hooks.UserPromptSubmit.filter((g: any) => !g.hooks.some((h: any) => h.args.includes("--plan-context")));
  assert.equal(old.hooks.PreToolUse.length, full.hooks.PreToolUse.length - 1);
  assert.equal(old.hooks.UserPromptSubmit.length, full.hooks.UserPromptSubmit.length - 1);
  await writeFile(e.settings, JSON.stringify(old));
  const args = ["doctor", "--settings", e.settings, "--server", "http://127.0.0.1:1", "--data-dir", join(e.dir, "data")];
  const before = (await ukagai(e, args)).out;
  assert.match(before, /× +hook PreToolUse \(plan context\) +not registered/);
  assert.match(before, /× +hook UserPromptSubmit \(plan context\) +not registered/);
  await ukagai(e, ["install", "--settings", e.settings]);
  const s = await readJson(e.settings);
  assert.deepEqual(s, full);
  assert.equal(s.hooks.PreToolUse.filter((g: any) => g.matcher === "EnterPlanMode").length, 1);
  assert.deepEqual(s.hooks.SessionStart[0], OTHER.hooks.SessionStart[0]);
  assert.equal(s.hooks.UserPromptSubmit.filter((g: any) => g.hooks.some((h: any) => h.args.includes("--plan-context"))).length, 1);
  const after = (await ukagai(e, args)).out;
  assert.match(after, /○ +hook PreToolUse \(plan context\)/);
  assert.match(after, /○ +hook UserPromptSubmit \(plan context\)/);
});

test("install --observe registers no plan-context group and doctor says off", async () => {
  const e = await setup();
  await ukagai(e, ["install", "--settings", e.settings, "--observe"]);
  const s = await readJson(e.settings);
  assert.ok(!s.hooks.PreToolUse.some((g: any) => g.matcher === "EnterPlanMode"));
  const r = await ukagai(e, ["doctor", "--settings", e.settings, "--server", "http://127.0.0.1:1", "--data-dir", join(e.dir, "data")]);
  assert.match(r.out, /○ +hook PreToolUse \(plan context\) +off \(--observe\)/);
  assert.match(r.out, /○ +hook UserPromptSubmit \(plan context\) +off \(--observe\)/);
  assert.equal(s.hooks.UserPromptSubmit.length, 1);
});

test("upgrade in place: an installed Write|Edit PermissionRequest group is replaced by the matcher-less one", async () => {
  const e = await setup();
  await writeFile(e.settings, JSON.stringify(OTHER));
  await ukagai(e, ["install", "--settings", e.settings]);
  const full = await readJson(e.settings);
  const old = JSON.parse(JSON.stringify(full));
  old.hooks.PermissionRequest = [{ matcher: "Write|Edit", hooks: old.hooks.PermissionRequest[0].hooks }];
  await writeFile(e.settings, JSON.stringify(old));
  await ukagai(e, ["install", "--settings", e.settings]);
  const s = await readJson(e.settings);
  assert.equal(s.hooks.PermissionRequest.length, 1);
  assert.equal(s.hooks.PermissionRequest[0].matcher, undefined);
  assert.deepEqual(s, full);
});

// ---- the launcher form (UKAGAI_LAUNCHER) ----

const LAUNCHER = resolve("bin/ukagai");
const launcherEnv = (p: string): Record<string, string> => ({ UKAGAI_LAUNCHER: p });
const allHooks = (s: any): any[] => Object.values<any[]>(s.hooks).flatMap((g) => g.flatMap((x: any) => x.hooks));

test("launcher form: command is the launcher path and args start with hook", async () => {
  const e = await setup();
  const r = await ukagai(e, ["install", "--settings", e.settings], e.dir, launcherEnv(LAUNCHER));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /hook: +\S+bin\/ukagai hook\n/);
  assert.doesNotMatch(r.out, /dev checkout/);
  const hooks = allHooks(await readJson(e.settings));
  assert.ok(hooks.length > 0);
  for (const h of hooks) {
    assert.equal(h.command, LAUNCHER);
    assert.equal(h.args[0], "hook");
    assert.deepEqual(h.args.slice(-2), ["--managed-by", "ukagai"]);
  }
});

test("node form: the install summary says it is a dev checkout", async () => {
  const e = await setup();
  const r = await ukagai(e, ["install", "--settings", e.settings]);
  assert.match(r.out, /dev checkout: hooks run node \+ dist\/cli\.js/);
});

test("launcher form: a symlink to the launcher is registered as the unresolved link path", async () => {
  const e = await setup();
  const link = join(e.dir, "bin-link");
  await symlink(LAUNCHER, link);
  const r = await ukagai(e, ["install", "--settings", e.settings], e.dir, launcherEnv(link));
  assert.equal(r.code, 0, r.err);
  assert.equal(allHooks(await readJson(e.settings))[0].command, link);
});

test("launcher form: a path under /versions/ gets a note", async () => {
  const e = await setup();
  await mkdir(join(e.dir, "versions", "1.0.0"), { recursive: true });
  const link = join(e.dir, "versions", "1.0.0", "ukagai");
  await symlink(LAUNCHER, link);
  const r = await ukagai(e, ["install", "--settings", e.settings], e.dir, launcherEnv(link));
  assert.match(r.out, /hooks point at a versioned path; run the ukagai on PATH instead/);
});

test("a launcher that is another tree's (or missing / relative) falls back to the node form", async () => {
  const e = await setup();
  const other = join(e.dir, "other-ukagai");
  await writeFile(other, "#!/bin/sh\n");
  await chmod(other, 0o755);
  for (const l of [other, join(e.dir, "missing"), "bin/ukagai"]) {
    await ukagai(e, ["install", "--settings", e.settings], e.dir, launcherEnv(l));
    const h = allHooks(await readJson(e.settings))[0];
    assert.equal(h.command, process.execPath, l);
    assert.equal(h.args[1], "hook");
  }
});

test("old node-form entries are replaced by launcher-form ones: same count, foreign hooks kept", async () => {
  const e = await setup();
  await writeFile(e.settings, JSON.stringify(OTHER));
  await ukagai(e, ["install", "--settings", e.settings]);
  const old = await readJson(e.settings);
  const n = count(old);
  await ukagai(e, ["install", "--settings", e.settings], e.dir, launcherEnv(LAUNCHER));
  const s = await readJson(e.settings);
  assert.equal(count(s), n);
  const managed = allHooks(s).filter((h) => h.args?.includes("--managed-by"));
  assert.ok(managed.length > 0);
  for (const h of managed) assert.equal(h.command, LAUNCHER);
  assert.equal(s.model, "opus");
  assert.ok(allHooks(s).some((h) => h.command === "/usr/bin/other"));
  assert.equal(allHooks(s).length, allHooks(old).length);
});

test("uninstall removes both the node form and the launcher form", async () => {
  const e = await setup();
  await writeFile(e.settings, JSON.stringify(OTHER));
  await ukagai(e, ["install", "--settings", e.settings]);
  await ukagai(e, ["uninstall", "--settings", e.settings]);
  assert.equal(count(await readJson(e.settings)), 1);
  await ukagai(e, ["install", "--settings", e.settings], e.dir, launcherEnv(LAUNCHER));
  await ukagai(e, ["uninstall", "--settings", e.settings], e.dir, launcherEnv(LAUNCHER));
  const s = await readJson(e.settings);
  assert.equal(count(s), 1);
  assert.equal(allHooks(s)[0].command, "/usr/bin/other");
});

test("doctor: version row; launcher form shows launcher + node-path rows, node form shows node / cli rows", async () => {
  const e = await setup();
  const data = join(e.dir, "data");
  const doctor = (extra: Record<string, string> = {}) =>
    ukagai(e, ["doctor", "--settings", e.settings, "--server", "http://127.0.0.1:1", "--data-dir", data], e.dir, extra);
  await ukagai(e, ["install", "--settings", e.settings]);
  const node = await doctor();
  assert.match(node.out, /○ +version +\S+ \(/);
  assert.match(node.out, /○ +node exists/);
  assert.match(node.out, /[○×] +cli exists/);
  assert.doesNotMatch(node.out, /[○×] +(launcher|node-path) /);

  await ukagai(e, ["install", "--settings", e.settings], e.dir, launcherEnv(LAUNCHER));
  const noNodePath = await doctor();
  assert.match(noNodePath.out, /○ +launcher +\S+/);
  assert.match(noNodePath.out, /× +node-path .*re-run install\.sh/);
  await mkdir(data, { recursive: true });
  await writeFile(join(data, "node-path"), process.execPath + "\n");
  const ok = await doctor();
  assert.match(ok.out, /○ +node-path/);
  assert.doesNotMatch(ok.out, /node exists|cli exists/);
});

test("doctor: a missing launcher is ×", async () => {
  const e = await setup();
  await writeFile(e.settings, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: join(e.dir, "gone"), args: ["hook", "--managed-by", "ukagai"] }] }] } }));
  const r = await ukagai(e, ["doctor", "--settings", e.settings, "--server", "http://127.0.0.1:1", "--data-dir", join(e.dir, "data")]);
  assert.match(r.out, /× +launcher .*missing or not executable/);
});
