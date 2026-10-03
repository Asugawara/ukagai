import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rm } from "node:fs/promises";
import { editState, hookHash, readState } from "../../src/install/codex-trust.js";

const CLI = resolve("src/cli.ts");
const TSX = import.meta.resolve("tsx");
const fx = (n: string): string => readFileSync(fileURLToPath(new URL(`../fixtures/codex/trust/${n}`, import.meta.url)), "utf8");

// ---- the hashes Codex 0.159.3 wrote itself (C1) ----

test("hookHash reproduces the 7 hashes Codex wrote for hooks.json / proj hooks.json", () => {
  const state = readState(fx("config.toml"));
  const label: Record<string, string> = { session_start: "SessionStart", user_prompt_submit: "UserPromptSubmit", pre_tool_use: "PreToolUse", post_tool_use: "PostToolUse", stop: "Stop", permission_request: "PermissionRequest" };
  let n = 0;
  for (const [file, name] of [["hooks.json", "/home/hooks.json"], ["proj-hooks.json", "/proj/.codex/hooks.json"]] as const) {
    const doc = JSON.parse(fx(file)).hooks as Record<string, any[]>;
    for (const [event, groups] of Object.entries(doc)) {
      groups.forEach((g, gi) =>
        g.hooks.forEach((h: any, hi: number) => {
          const key = [...state.keys()].find((k) => k.endsWith(`${name}:${Object.keys(label).find((l) => label[l] === event)}:${gi}:${hi}`));
          assert.ok(key, `${event} ${gi}:${hi}`);
          assert.equal(hookHash(event, g.matcher, h), state.get(key!), key);
          n++;
        }),
      );
    }
  }
  assert.equal(n, 7);
});

test("hookHash: timeout defaults to 600, matcher is omitted from the hash when absent", () => {
  assert.equal(hookHash("Stop", undefined, { command: "x" }), hookHash("Stop", undefined, { command: "x", timeout: 600 }));
  assert.notEqual(hookHash("Stop", undefined, { command: "x" }), hookHash("Stop", "", { command: "x" }));
});

// ---- config.toml edits ----

const K1 = "/h/hooks.json:stop:0:0";
const K2 = "/h/hooks.json:stop:1:0";

test("editState: appends / replaces / drops / renames only [hooks.state] tables", () => {
  const base = 'model = "x"\n\n[tui]\na = 1\n';
  const a = editState(base, { set: new Map([[K1, "sha256:aa"]]) });
  assert.equal(a, `${base}\n[hooks.state."${K1}"]\ntrusted_hash = "sha256:aa"\n`);
  const b = editState(a, { set: new Map([[K1, "sha256:bb"]]) });
  assert.equal(b, `${base}\n[hooks.state."${K1}"]\ntrusted_hash = "sha256:bb"\n`);
  const c = editState(b, { rename: new Map([[K1, K2]]) });
  assert.equal(c, `${base}\n[hooks.state."${K2}"]\ntrusted_hash = "sha256:bb"\n`);
  assert.equal(editState(c, { drop: [K2] }), base);
  assert.equal(editState(base, {}), base);
  assert.equal(editState("", { set: new Map([[K1, "sha256:aa"]]) }), `[hooks.state."${K1}"]\ntrusted_hash = "sha256:aa"\n`);
});

test("editState: other tables after a dropped one and a missing trailing newline survive", () => {
  const src = `[hooks.state."${K1}"]\ntrusted_hash = "sha256:aa"\n\n[tui]\na = 1`;
  assert.equal(editState(src, { drop: [K1] }), "\n[tui]\na = 1");
  assert.equal(editState(src, {}), src);
});

// ---- the CLI against a temporary CODEX_HOME ----

interface Env { dir: string; home: string; codex: string; fakeHome: string }
async function setup(): Promise<Env> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ukagai-c3-")));
  const codex = join(dir, "codex");
  const fakeHome = join(dir, "home");
  await mkdir(codex);
  await mkdir(fakeHome);
  return { dir, home: dir, codex, fakeHome };
}
function ukagai(e: Env, args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((res) => {
    execFile(process.execPath, ["--import", TSX, CLI, ...args], { cwd: e.dir, env: { ...process.env, HOME: e.fakeHome, CODEX_HOME: "" } }, (er, out, err) => {
      res({ code: er ? ((er as { code?: number }).code ?? 1) : 0, out, err });
    });
  });
}
const AWM = { type: "command", command: "/usr/bin/awm-hook", timeout: 10 };
const EXISTING = {
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [AWM] }],
    Stop: [{ hooks: [AWM] }],
  },
};
const CONFIG = `model = "gpt"\n\n[projects."/x"]\ntrust_level = "trusted"\n\n[hooks.state]\n\n[hooks.state."OLD:stop:0:0"]\ntrusted_hash = "sha256:00"\n`;

test("install --codex: merges into hooks.json, appends the managed groups, writes matching trust, touches nothing else", async () => {
  const e = await setup();
  await writeFile(join(e.codex, "hooks.json"), JSON.stringify(EXISTING, null, 2));
  await writeFile(join(e.codex, "config.toml"), CONFIG);
  const r = await ukagai(e, ["install", "--codex", "--codex-home", e.codex, "--data-dir", join(e.dir, "data"), "--lang", "en"]);
  assert.equal(r.code, 0, r.err);
  const hooks = JSON.parse(await readFile(join(e.codex, "hooks.json"), "utf8")).hooks;
  assert.deepEqual(hooks.PreToolUse[0], EXISTING.hooks.PreToolUse[0]);
  assert.equal(hooks.PreToolUse.length, 2);
  const pre = hooks.PreToolUse[1];
  assert.equal(pre.matcher, "request_user_input");
  assert.equal(pre.hooks[0].timeout, 3600);
  assert.match(pre.hooks[0].command, /hook --agent codex --budget 3590 .*--managed-by ukagai$/);
  assert.equal(hooks.PermissionRequest[0].matcher, undefined);
  assert.equal(hooks.Stop.length, 2);
  assert.equal(hooks.SessionStart[0].hooks[0].timeout, 30);
  assert.ok(!hooks.SessionStart[0].hooks[0].command.includes("--budget"));

  const cfg = await readFile(join(e.codex, "config.toml"), "utf8");
  assert.ok(cfg.startsWith(CONFIG), "existing bytes untouched");
  const st = readState(cfg);
  const hf = join(e.codex, "hooks.json");
  assert.equal(st.get(`${hf}:pre_tool_use:1:0`), hookHash("PreToolUse", "request_user_input", pre.hooks[0]));
  assert.equal(st.get(`${hf}:permission_request:0:0`), hookHash("PermissionRequest", undefined, hooks.PermissionRequest[0].hooks[0]));
  assert.equal(st.get(`${hf}:stop:1:0`), hookHash("Stop", undefined, hooks.Stop[1].hooks[0]));
  assert.equal(st.get(`${hf}:session_start:0:0`), hookHash("SessionStart", undefined, hooks.SessionStart[0].hooks[0]));
  assert.equal(st.get("OLD:stop:0:0"), "sha256:00");
  assert.equal(st.size, 5);
  assert.ok(!(await readdir(e.fakeHome)).length, "nothing written to HOME");
  assert.ok(!(await readdir(e.fakeHome).then((l) => l.includes(".claude"))), "Claude settings untouched");
});

test("install --codex twice changes nothing; the second run makes no backups", async () => {
  const e = await setup();
  const args = ["install", "--codex", "--codex-home", e.codex, "--data-dir", join(e.dir, "data"), "--lang", "en"];
  await ukagai(e, args);
  const h1 = await readFile(join(e.codex, "hooks.json"), "utf8");
  const c1 = await readFile(join(e.codex, "config.toml"), "utf8");
  await ukagai(e, args);
  assert.equal(await readFile(join(e.codex, "hooks.json"), "utf8"), h1);
  assert.equal(await readFile(join(e.codex, "config.toml"), "utf8"), c1);
  assert.ok((await readdir(e.codex)).every((f) => !f.includes(".bak-")));
});

test("uninstall renames the trust of hooks that sat behind a removed ukagai group (their keys shift down)", async () => {
  const e = await setup();
  const args = ["--codex", "--codex-home", e.codex, "--data-dir", join(e.dir, "data")];
  await ukagai(e, ["install", ...args, "--lang", "en"]);
  const hf = join(e.codex, "hooks.json");
  const doc = JSON.parse(await readFile(hf, "utf8"));
  doc.hooks.Stop.push({ hooks: [AWM] }); // added later by another tool: stop:1:0, trusted by Codex
  await writeFile(hf, JSON.stringify(doc));
  const cfg = await readFile(join(e.codex, "config.toml"), "utf8");
  await writeFile(join(e.codex, "config.toml"), editState(cfg, { set: new Map([[`${hf}:stop:1:0`, "sha256:awm"]]) }));
  const r = await ukagai(e, ["uninstall", ...args]);
  assert.equal(r.code, 0, r.err);
  const st = readState(await readFile(join(e.codex, "config.toml"), "utf8"));
  assert.deepEqual([...st.keys()], [`${hf}:stop:0:0`]);
  assert.equal(st.get(`${hf}:stop:0:0`), "sha256:awm");
});

test("install replaces a ukagai handler in place (its position and the others' keys stay)", async () => {
  const e = await setup();
  const args = ["--codex", "--codex-home", e.codex, "--data-dir", join(e.dir, "data"), "--lang", "en"];
  await ukagai(e, ["install", ...args]);
  const hf = join(e.codex, "hooks.json");
  const doc = JSON.parse(await readFile(hf, "utf8"));
  doc.hooks.Stop.push({ hooks: [AWM] });
  await writeFile(hf, JSON.stringify(doc));
  await ukagai(e, ["install", ...args, "--timeout", "100"]); // different timeout: new hash for the same slot
  const after = JSON.parse(await readFile(hf, "utf8")).hooks.Stop;
  assert.match(after[0].hooks[0].command, /--managed-by ukagai/);
  assert.equal(after[0].hooks[0].timeout, 100);
  assert.deepEqual(after[1].hooks, [AWM]);
  const st = readState(await readFile(join(e.codex, "config.toml"), "utf8"));
  assert.equal(st.get(`${hf}:stop:0:0`), hookHash("Stop", undefined, after[0].hooks[0]));
});

test("uninstall --codex removes only ukagai's handlers and trust; the original bytes come back", async () => {
  const e = await setup();
  await writeFile(join(e.codex, "hooks.json"), JSON.stringify(EXISTING, null, 2) + "\n");
  await writeFile(join(e.codex, "config.toml"), CONFIG);
  const args = ["--codex", "--codex-home", e.codex, "--data-dir", join(e.dir, "data")];
  await ukagai(e, ["install", ...args, "--lang", "en"]);
  const r = await ukagai(e, ["uninstall", ...args]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(await readFile(join(e.codex, "hooks.json"), "utf8")), EXISTING);
  assert.equal(await readFile(join(e.codex, "config.toml"), "utf8"), CONFIG);
});

test("--dry-run writes nothing; without --codex Codex is not touched; --codex alone leaves Claude alone", async () => {
  const e = await setup();
  const r = await ukagai(e, ["install", "--codex", "--codex-home", e.codex, "--dry-run", "--data-dir", join(e.dir, "data")]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /hooks\.json/);
  assert.deepEqual(await readdir(e.codex), []);
  const settings = join(e.dir, "settings.json");
  const r2 = await ukagai(e, ["install", "--settings", settings, "--codex-home", e.codex, "--data-dir", join(e.dir, "data"), "--lang", "en"]);
  assert.equal(r2.code, 0, r2.err);
  assert.deepEqual(await readdir(e.codex), [], "Codex untouched without --codex");
  const r3 = await ukagai(e, ["install", "--codex", "--codex-home", e.codex, "--data-dir", join(e.dir, "data"), "--lang", "en"]);
  assert.equal(r3.code, 0, r3.err);
  assert.deepEqual(await readdir(e.fakeHome), [], "no ~/.claude");
});

test("doctor --codex: trusted after install, modified when the command is edited, not registered after uninstall", async () => {
  const e = await setup();
  const args = ["--codex", "--codex-home", e.codex, "--data-dir", join(e.dir, "data"), "--server", "http://127.0.0.1:9"];
  await ukagai(e, ["install", ...args, "--lang", "en"]);
  let r = await ukagai(e, ["doctor", ...args]);
  assert.match(r.out, /○ +codex hook PreToolUse +trusted/);
  assert.match(r.out, /○ +codex hook Stop +trusted/);
  const doc = JSON.parse(await readFile(join(e.codex, "hooks.json"), "utf8"));
  doc.hooks.Stop[0].hooks[0].command += " --extra";
  await writeFile(join(e.codex, "hooks.json"), JSON.stringify(doc));
  r = await ukagai(e, ["doctor", ...args]);
  assert.match(r.out, /× +codex hook Stop +modified/);
  await ukagai(e, ["uninstall", ...args]);
  r = await ukagai(e, ["doctor", ...args]);
  assert.match(r.out, /× +codex hook Stop +not registered/);
});

test("a path with spaces / quotes is shell-quoted in the command (the data dir here)", async () => {
  const e = await setup();
  const dd = join(e.dir, "it's a dir");
  await ukagai(e, ["install", "--codex", "--codex-home", e.codex, "--data-dir", dd, "--lang", "en"]);
  const cmd = JSON.parse(await readFile(join(e.codex, "hooks.json"), "utf8")).hooks.Stop[0].hooks[0].command as string;
  assert.ok(cmd.includes(`'${dd.replace(/'/g, `'\\''`)}'`), cmd);
});

// ---- round trip: existing formatting survives, created files go away ----

const lines = (t: string): string[] => t.replace(/\n$/, "").split("\n");

test("empty CODEX_HOME: install then uninstall leaves nothing (no files, no record)", async () => {
  const e = await setup();
  const args = ["--codex", "--codex-home", e.codex, "--data-dir", join(e.dir, "data")];
  await ukagai(e, ["install", ...args, "--lang", "en"]);
  assert.ok((await readdir(e.codex)).includes(".ukagai-codex.json"));
  const r = await ukagai(e, ["uninstall", ...args]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(await readdir(e.codex), []);
});

test("without a record uninstall does not delete a file that merely ends up empty", async () => {
  const e = await setup();
  const args = ["--codex", "--codex-home", e.codex, "--data-dir", join(e.dir, "data")];
  await ukagai(e, ["install", ...args, "--lang", "en"]);
  await rm(join(e.codex, ".ukagai-codex.json"));
  await ukagai(e, ["uninstall", ...args]);
  assert.deepEqual((await readdir(e.codex)).filter((f) => !f.includes(".bak-")).sort(), ["config.toml", "hooks.json"]);
});

function richConfig(): string {
  const parts = ['model = "gpt-5"', ""];
  for (let i = 0; i < 750; i++) parts.push(`[projects."/Users/x/dev/p${i}"]`, 'trust_level = "trusted"', "");
  for (let i = 0; i < 150; i++) parts.push(`[mcp_servers.s${i}]`, 'command = "npx"', `args = ["-y", "pkg-${i}"]`, "");
  parts.push('[hooks.state."/home/x/.codex/hooks.json:stop:0:0"]', 'trusted_hash = "sha256:abc"');
  return parts.join("\n"); // no trailing newline
}
const AWM_TAB = `{\n\t"hooks": {\n\t\t"PreToolUse": [\n\t\t\t{\n\t\t\t\t"matcher": "Bash",\n\t\t\t\t"hooks": [\n\t\t\t\t\t{\n\t\t\t\t\t\t"type": "command",\n\t\t\t\t\t\t"command": "/usr/bin/awm-hook"\n\t\t\t\t\t}\n\t\t\t\t]\n\t\t\t}\n\t\t],\n\t\t"Stop": [\n\t\t\t{\n\t\t\t\t"hooks": [\n\t\t\t\t\t{\n\t\t\t\t\t\t"type": "command",\n\t\t\t\t\t\t"command": "/usr/bin/awm-hook"\n\t\t\t\t\t}\n\t\t\t\t]\n\t\t\t}\n\t\t]\n\t}\n}`; // tab indent, no final newline

test("awm-style hooks.json (tabs, no final newline) + 58 KB config.toml: install only appends, uninstall restores the bytes, 2nd install is a no-op", async () => {
  const e = await setup();
  const hf = join(e.codex, "hooks.json");
  const cf = join(e.codex, "config.toml");
  const cfg = richConfig();
  assert.ok(cfg.length > 50_000);
  await writeFile(hf, AWM_TAB);
  await writeFile(cf, cfg);
  const args = ["--codex", "--codex-home", e.codex, "--data-dir", join(e.dir, "data")];
  assert.equal((await ukagai(e, ["install", ...args, "--lang", "en", "--dry-run"])).code, 0);
  assert.equal(await readFile(hf, "utf8"), AWM_TAB, "dry-run changes nothing");
  assert.equal(await readFile(cf, "utf8"), cfg);
  assert.deepEqual((await readdir(e.codex)).sort(), ["config.toml", "hooks.json"]);

  const r = await ukagai(e, ["install", ...args, "--lang", "en"]);
  assert.equal(r.code, 0, r.err);
  const h1 = await readFile(hf, "utf8");
  const c1 = await readFile(cf, "utf8");
  assert.ok(!h1.endsWith("\n"), "no final newline added");
  assert.ok(!/^ +"/m.test(h1), "no space indentation introduced");
  // every existing line is still there in order; the only edits are a comma on the line before an appended group
  const old = lines(AWM_TAB);
  const now = lines(h1);
  let j = 0;
  const changed: string[] = [];
  for (const l of old) {
    while (j < now.length && now[j] !== l && now[j] !== l + ",") j++;
    assert.ok(j < now.length, `line lost: ${l}`);
    if (now[j] !== l) changed.push(l);
    j++;
  }
  assert.ok(changed.every((l) => /^\t{2,3}[}\]]$/.test(l)), `only closing brackets gain a comma: ${changed.join("|")}`);
  assert.equal(JSON.parse(h1).hooks.Stop.length, 2);
  assert.ok(c1.startsWith(cfg + "\n"), "config: only a newline and the new tables are added");
  assert.equal(readState(c1).size, 5);

  const bakCount = (await readdir(e.codex)).filter((f) => f.includes(".bak-")).length;
  await ukagai(e, ["install", ...args, "--lang", "en"]);
  assert.equal(await readFile(hf, "utf8"), h1);
  assert.equal(await readFile(cf, "utf8"), c1);
  assert.equal((await readdir(e.codex)).filter((f) => f.includes(".bak-")).length, bakCount);

  const u = await ukagai(e, ["uninstall", ...args]);
  assert.equal(u.code, 0, u.err);
  assert.equal(await readFile(hf, "utf8"), AWM_TAB, "hooks.json back to the original bytes");
  assert.equal(await readFile(cf, "utf8"), cfg, "config.toml back to the original bytes");
  assert.ok(!(await readdir(e.codex)).includes(".ukagai-codex.json"));
});

test("uninstall without a usable backup still removes the added final newline (line-based)", async () => {
  const e = await setup();
  const cf = join(e.codex, "config.toml");
  const cfg = 'model = "x"\n\n[tui]\na = 1';
  await writeFile(cf, cfg);
  const args = ["--codex", "--codex-home", e.codex, "--data-dir", join(e.dir, "data")];
  await ukagai(e, ["install", ...args, "--lang", "en"]);
  for (const f of await readdir(e.codex)) if (f.startsWith("config.toml.bak-")) await rm(join(e.codex, f));
  await ukagai(e, ["uninstall", ...args]);
  assert.equal(await readFile(cf, "utf8"), cfg);
});
