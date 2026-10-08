import { cleanEnv } from "./clean-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { enabledClaudePlugin, enabledCodexPlugin } from "../../src/settings/plugins.js";

const CLI = resolve("src/cli.ts");
const TSX = import.meta.resolve("tsx");
const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "ukagai-plug-"));
  const home = join(dir, "home");
  const codex = join(dir, "codex");
  await mkdir(join(home, ".claude"), { recursive: true });
  await mkdir(codex);
  return { dir, home, codex, settings: join(home, ".claude", "settings.json"), skill: join(home, ".claude", "skills", "ukagai-explain", "SKILL.md") };
}
type E = Awaited<ReturnType<typeof setup>>;
const run = (e: E, args: string[]): Promise<{ code: number; out: string; err: string }> =>
  new Promise((res) =>
    execFile(process.execPath, ["--import", TSX, CLI, ...args, "--data-dir", join(e.dir, "data"), "--server", "http://127.0.0.1:9"], { cwd: e.dir, env: cleanEnv({ HOME: e.home }) }, (er, out, err) =>
      res({ code: er ? ((er as { code?: number }).code ?? 1) : 0, out, err }),
    ),
  );
const PLUGIN = { enabledPlugins: { "ukagai@ukagai": true } };

test("enabledClaudePlugin: only true values of ukagai@ keys", async () => {
  const e = await setup();
  const f = join(e.dir, "s.json");
  assert.equal(await enabledClaudePlugin([f]), undefined, "missing file");
  await writeFile(f, JSON.stringify({ enabledPlugins: { "ukagai@x": false, "other@x": true } }));
  assert.equal(await enabledClaudePlugin([f]), undefined);
  await writeFile(f, JSON.stringify({ enabledPlugins: { "ukagai@x": true } }));
  assert.equal(await enabledClaudePlugin([join(e.dir, "none.json"), f]), "ukagai@x");
});

test("enabledCodexPlugin: [plugins.\"ukagai@…\"] with enabled = true", async () => {
  const e = await setup();
  assert.equal(await enabledCodexPlugin(e.codex), undefined);
  await writeFile(join(e.codex, "config.toml"), '[plugins."ukagai@m"]\nenabled = false\n');
  assert.equal(await enabledCodexPlugin(e.codex), undefined);
  await writeFile(join(e.codex, "config.toml"), '[plugins."other@m"]\nenabled = true\n\n[plugins."ukagai@m"]\nenabled = true # on\n');
  assert.equal(await enabledCodexPlugin(e.codex), "ukagai@m");
});

test("install with the plugin enabled removes settings hooks and the skill copy, keeps --lang", async () => {
  const e = await setup();
  assert.equal((await run(e, ["install"])).code, 0);
  assert.ok(await exists(e.skill));
  const s = JSON.parse(await readFile(e.settings, "utf8"));
  assert.ok(s.hooks.PreToolUse);
  await writeFile(e.settings, JSON.stringify({ ...s, ...PLUGIN }));
  const r = await run(e, ["install", "--lang", "ja"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /plugin ukagai@ukagai is enabled: hooks and skill come from the plugin \(use --force to register them in settings\.json as well\)/);
  const after = JSON.parse(await readFile(e.settings, "utf8"));
  assert.equal(after.hooks, undefined);
  assert.deepEqual(after.enabledPlugins, PLUGIN.enabledPlugins);
  assert.ok(!(await exists(e.skill)));
  assert.match(await readFile(join(e.dir, "data", "config.json"), "utf8"), /"ja"/);
});

test("install --force registers even with the plugin enabled; --settings ignores the plugin", async () => {
  const e = await setup();
  await writeFile(e.settings, JSON.stringify(PLUGIN));
  assert.equal((await run(e, ["install", "--force"])).code, 0);
  assert.ok(JSON.parse(await readFile(e.settings, "utf8")).hooks.PreToolUse);
  assert.ok(await exists(e.skill));
  const other = join(e.dir, "other.json");
  assert.equal((await run(e, ["install", "--settings", other])).code, 0);
  assert.ok(JSON.parse(await readFile(other, "utf8")).hooks.PreToolUse);
});

test("install --codex with the Codex plugin enabled removes hooks.json handlers and says so", async () => {
  const e = await setup();
  assert.equal((await run(e, ["install", "--codex", "--codex-home", e.codex])).code, 0);
  assert.match(await readFile(join(e.codex, "hooks.json"), "utf8"), /managed-by/);
  await writeFile(join(e.codex, "config.toml"), (await readFile(join(e.codex, "config.toml"), "utf8")) + '\n[plugins."ukagai@m"]\nenabled = true\n');
  const r = await run(e, ["install", "--codex", "--codex-home", e.codex]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /plugin ukagai@m is enabled/);
  assert.ok(!(await exists(join(e.codex, "hooks.json"))) || !/managed-by/.test(await readFile(join(e.codex, "hooks.json"), "utf8")));
  assert.match(await readFile(join(e.codex, "config.toml"), "utf8"), /\[plugins\."ukagai@m"\]/);
});

test("doctor: plugin row, and the twice-registered error", async () => {
  const e = await setup();
  await writeFile(e.settings, JSON.stringify(PLUGIN));
  let r = await run(e, ["doctor"]);
  assert.match(r.out, /plugin\s+ukagai@ukagai enabled/);
  assert.match(r.out, /skill ukagai-explain\s+from the plugin/);
  assert.ok(!/hook SessionStart/.test(r.out), "hooks come from the plugin");
  assert.ok(!/registered twice/.test(r.out));
  await run(e, ["install", "--force"]);
  r = await run(e, ["doctor"]);
  assert.match(r.out, /×\s+hooks registered twice\s+plugin and settings\.json: run ukagai install/);
  await writeFile(e.settings, "{}");
  r = await run(e, ["doctor"]);
  assert.match(r.out, /plugin\s+no plugin/);
});

test("doctor --codex: plugin row and twice-registered error", async () => {
  const e = await setup();
  await writeFile(join(e.codex, "config.toml"), '[plugins."ukagai@m"]\nenabled = true\n');
  let r = await run(e, ["doctor", "--codex", "--codex-home", e.codex]);
  assert.match(r.out, /codex plugin\s+ukagai@m enabled/);
  assert.ok(!/codex hooks registered twice/.test(r.out));
  await run(e, ["install", "--codex", "--codex-home", e.codex, "--force"]);
  r = await run(e, ["doctor", "--codex", "--codex-home", e.codex]);
  assert.match(r.out, /×\s+codex hooks registered twice/);
});

test("enabledCodexPlugin: literal keys, [plugins] dotted / inline forms, false, and a later table", async () => {
  const e = await setup();
  const cases: Array<[string, string | undefined]> = [
    ["[plugins.'ukagai@m']\nenabled = true\n", "ukagai@m"],
    ['[plugins]\n"ukagai@m".enabled = true\n', "ukagai@m"],
    ["[plugins]\n'ukagai@m'.enabled = true\n", "ukagai@m"],
    ['[plugins]\n"ukagai@m" = { enabled = true }\n', "ukagai@m"],
    ['plugins."ukagai@m".enabled = true\n', "ukagai@m"],
    ['[plugins."ukagai@m"] # c\nenabled = true\n', "ukagai@m"],
    ['[plugins."ukagai@m"]\nenabled = false\n', undefined],
    ['[plugins]\n"ukagai@m".enabled = false\n"ukagai@n" = { enabled = false }\n', undefined],
    ['[plugins."other@m"]\nenabled = true\n', undefined],
    ['[plugins."ukagai@m"]\nenabled = false\n\n[other]\nenabled = true\n', undefined],
    ['[plugins."ukagai@m"]\nname = "x"\n[features]\nenabled = true\n', undefined],
  ];
  for (const [toml, want] of cases) {
    await writeFile(join(e.codex, "config.toml"), toml);
    assert.equal(await enabledCodexPlugin(e.codex), want, toml);
  }
});

test("enabledClaudePlugin: the first file that mentions a ukagai@ key decides (local > project > user)", async () => {
  const e = await setup();
  const [local, project, user] = ["l.json", "p.json", "u.json"].map((n) => join(e.dir, n)) as [string, string, string];
  const w = (f: string, v: unknown): Promise<void> => writeFile(f, JSON.stringify({ enabledPlugins: v }));
  await w(user, { "ukagai@m": true });
  await w(project, { "ukagai@m": false });
  assert.equal(await enabledClaudePlugin([local, project, user]), undefined, "project false beats user true");
  await w(user, { "ukagai@m": false });
  await w(project, { "ukagai@m": true });
  assert.equal(await enabledClaudePlugin([local, project, user]), "ukagai@m", "project true beats user false");
  await w(local, { "other@m": true });
  assert.equal(await enabledClaudePlugin([local, project, user]), "ukagai@m", "a file without a ukagai@ key does not decide");
  await w(local, { "ukagai@m": false });
  assert.equal(await enabledClaudePlugin([local, project, user]), undefined, "local false beats project true");
  assert.equal(await enabledClaudePlugin([join(e.dir, "none.json"), user]), undefined);
  await w(user, { "ukagai@m": true });
  assert.equal(await enabledClaudePlugin([join(e.dir, "none.json"), user]), "ukagai@m", "user only");
});

test("install --project: project settings false overrides user true (precedence through the CLI)", async () => {
  const e = await setup();
  await writeFile(e.settings, JSON.stringify(PLUGIN));
  await mkdir(join(e.dir, ".claude"), { recursive: true });
  await writeFile(join(e.dir, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "ukagai@ukagai": false } }));
  const r = await run(e, ["install", "--project", "--dry-run"]);
  assert.equal(r.code, 0, r.err);
  assert.ok(!/is enabled/.test(r.out), r.out);
});

test("install --dry-run with the plugin enabled prints the plugin line and writes nothing", async () => {
  const e = await setup();
  await writeFile(e.settings, JSON.stringify(PLUGIN));
  await writeFile(join(e.codex, "config.toml"), '[plugins."ukagai@m"]\nenabled = true\n');
  const before = await readFile(e.settings, "utf8");
  const r = await run(e, ["install", "--dry-run", "--codex", "--claude", "--codex-home", e.codex]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /plugin ukagai@ukagai is enabled/);
  assert.match(r.out, /plugin ukagai@m is enabled/);
  assert.match(r.out, /nothing was written/);
  assert.equal(await readFile(e.settings, "utf8"), before);
  assert.ok(!(await exists(join(e.dir, "data", "config.json"))));
});

test("doctor --settings <file> ignores the user-level plugin and reports that file's hooks", async () => {
  const e = await setup();
  await writeFile(e.settings, JSON.stringify(PLUGIN));
  const other = join(e.dir, "dev.json");
  const r = await run(e, ["doctor", "--settings", other]);
  assert.ok(!/plugin\s+ukagai@ukagai enabled/.test(r.out), r.out);
  assert.ok(!/from the plugin/.test(r.out), r.out);
  assert.match(r.out, /hook SessionStart/);
});
