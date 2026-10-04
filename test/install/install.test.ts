import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve("src/cli.ts");
const TSX = import.meta.resolve("tsx");

interface Env { home: string; dir: string; settings: string }
async function setup(): Promise<Env> {
  const dir = await mkdtemp(join(tmpdir(), "ukagai-w6-"));
  const home = join(dir, "home");
  await mkdir(home);
  return { home, dir, settings: join(dir, "settings.json") };
}
function ukagai(env: Env, args: string[], cwd = env.dir): Promise<{ code: number; out: string; err: string }> {
  return new Promise((res) => {
    execFile(process.execPath, ["--import", TSX, CLI, ...args], { cwd, env: { ...process.env, HOME: env.home } }, (e, out, err) => {
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

test("doctor: installed + no server -> hook ○, server ×, exit 1", async () => {
  const e = await setup();
  await ukagai(e, ["install", "--settings", e.settings]);
  const r = await ukagai(e, ["doctor", "--settings", e.settings, "--server", "http://127.0.0.1:1", "--data-dir", join(e.dir, "data")]);
  assert.equal(r.code, 1);
  assert.match(r.out, /○ +hook PreToolUse/);
  assert.match(r.out, /○ +hook PreToolUse \(plan context\)/);
  assert.match(r.out, /○ +hook UserPromptSubmit \(plan context\)/);
  assert.match(r.out, /× +server/);
  assert.match(r.out, /× +token/);
  assert.match(r.out, /○ +skill ukagai-explain +not handled/);
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
