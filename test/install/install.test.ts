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

test("空の settings に install: 全 event、exec form、statusMessage、--budget 3590、skill", async () => {
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
  assert.equal(h.statusMessage, "ukagai: GUI で回答待ち");
  assert.equal(h.timeout, 3600);
  assert.equal(s.hooks.SessionEnd[0].hooks[0].timeout, 2);
  assert.equal(s.hooks.Stop[0].hooks[0].async, undefined);
  assert.equal(s.hooks.Stop[0].hooks[0].timeout, 5);
  assert.equal(s.hooks.SubagentStop[0].hooks[0].async, true);
  assert.equal(s.hooks.SessionStart[0].hooks[0].async, undefined);
  assert.ok(await exists(SKILL(e)));
});

test("--data-dir / --server 指定で全 hook の args に入り、未指定では入らない", async () => {
  const e = await setup();
  const dd = join(e.dir, "data");
  await ukagai(e, ["install", "--settings", e.settings, "--data-dir", dd, "--server", "http://127.0.0.1:9999/"]);
  const s = await readJson(e.settings);
  const hooks = Object.values<any[]>(s.hooks).flatMap((g) => g.flatMap((x) => x.hooks));
  assert.equal(hooks.length, EVENTS.length);
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

test("5 サブコマンドの --help は exit 0 で使い方を出す", async () => {
  const e = await setup();
  for (const c of ["serve", "hook", "install", "uninstall", "doctor"]) {
    for (const f of ["--help", "-h"]) {
      const r = await ukagai(e, [c, f]);
      assert.equal(r.code, 0, `${c} ${f}: ${r.err}`);
      assert.match(r.out, new RegExp(`使い方: ukagai ${c}`));
    }
  }
});

test("2 回目の install は .bak を残す", async () => {
  const e = await setup();
  await writeFile(e.settings, JSON.stringify(OTHER));
  await ukagai(e, ["install", "--settings", e.settings]);
  const baks = (await readdir(e.dir)).filter((f) => f.startsWith("settings.json.bak-"));
  assert.equal(baks.length, 1);
  assert.deepEqual(await readJson(join(e.dir, baks[0]!)), OTHER);
});

test("既存の hooks を保持し、2 回 install しても重複しない", async () => {
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

test("uninstall で元と等価に戻り、skill が消える", async () => {
  const e = await setup();
  await writeFile(e.settings, JSON.stringify(OTHER));
  await ukagai(e, ["install", "--settings", e.settings]);
  const r = await ukagai(e, ["uninstall", "--settings", e.settings]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(await readJson(e.settings), OTHER);
  assert.ok(!(await exists(SKILL(e))));
  assert.ok(!(await exists(join(e.home, ".claude", "skills", "ukagai-explain"))));
});

test("uninstall: 空になった event キーと hooks が残らない", async () => {
  const e = await setup();
  await ukagai(e, ["install", "--settings", e.settings]);
  await ukagai(e, ["uninstall", "--settings", e.settings]);
  assert.deepEqual(await readJson(e.settings), {});
});

test("--dry-run は書かない", async () => {
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

test("--observe: PreToolUse に --observe、PostToolUse の matcher に AskUserQuestion", async () => {
  const e = await setup();
  await ukagai(e, ["install", "--settings", e.settings, "--observe"]);
  const s = await readJson(e.settings);
  assert.ok(s.hooks.PreToolUse[0].hooks[0].args.includes("--observe"));
  assert.match(s.hooks.PostToolUse[0].matcher, /AskUserQuestion/);
});

test("--no-autostart: SessionStart の hook だけに --no-autostart、既定では付かない", async () => {
  const e = await setup();
  await ukagai(e, ["install", "--settings", e.settings]);
  assert.ok(!(await readJson(e.settings)).hooks.SessionStart[0].hooks[0].args.includes("--no-autostart"));
  await ukagai(e, ["install", "--settings", e.settings, "--no-autostart"]);
  const s = await readJson(e.settings);
  assert.ok(s.hooks.SessionStart[0].hooks[0].args.includes("--no-autostart"));
  assert.ok(!s.hooks.Stop[0].hooks[0].args.includes("--no-autostart"));
});

test("--project は .claude/settings.json と .claude/skills に書く", async () => {
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

test("壊れた JSON は書き換えず exit 1", async () => {
  const e = await setup();
  await writeFile(e.settings, "{ not json");
  const r = await ukagai(e, ["install", "--settings", e.settings]);
  assert.equal(r.code, 1);
  assert.equal(await readFile(e.settings, "utf8"), "{ not json");
});

test("doctor: install 済み + server 不在 → hook ○、server ×、exit 1", async () => {
  const e = await setup();
  await ukagai(e, ["install", "--settings", e.settings]);
  const r = await ukagai(e, ["doctor", "--settings", e.settings, "--server", "http://127.0.0.1:1", "--data-dir", join(e.dir, "data")]);
  assert.equal(r.code, 1);
  assert.match(r.out, /○ +hook PreToolUse/);
  assert.match(r.out, /× +server/);
  assert.match(r.out, /× +token/);
  assert.match(r.out, /○ +skill/);
});
