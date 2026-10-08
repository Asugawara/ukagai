import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pluginFiles } from "../../src/plugin/build.js";
import { buildHookEntries } from "../../src/settings/hooks-spec.js";
import { CODEX_SPECS } from "../../src/install/codex.js";

const files = pluginFiles("1.2.3");
const parse = (p: string): any => JSON.parse(files[p]!);

test("both manifests parse and carry the version", () => {
  assert.equal(parse(".claude-plugin/plugin.json").version, "1.2.3");
  assert.equal(parse("plugin.json").version, "1.2.3");
  assert.equal(parse(".claude-plugin/plugin.json").name, "ukagai");
  assert.equal(parse("plugin.json").name, "ukagai");
  assert.equal(parse(".claude-plugin/plugin.json").hooks, "./hooks/claude.json");
  assert.equal(parse("plugin.json").extensions["com.openai"].hooks, "./hooks/codex.json");
});

test(".codex-plugin/plugin.json declares the Codex hooks; the Claude manifest does not mention codex.json", () => {
  const c = parse(".codex-plugin/plugin.json");
  assert.equal(c.version, "1.2.3");
  assert.equal(c.name, "ukagai");
  assert.equal(c.hooks, "./hooks/codex.json");
  assert.ok(!files[".claude-plugin/plugin.json"]!.includes("codex.json"));
  assert.ok(!files["plugin.json"]!.includes("claude.json"));
});

test("hooks/claude.json equals buildHookEntries for the launcher invocation", () => {
  const want = buildHookEntries({ invocation: { command: "/bin/sh", prefix: ["${CLAUDE_PLUGIN_ROOT}/bin/ukagai"] }, timeout: 3600, observe: false });
  assert.deepEqual(parse("hooks/claude.json"), { hooks: JSON.parse(JSON.stringify(want)) });
  const pre = parse("hooks/claude.json").hooks.PreToolUse[0].hooks[0];
  assert.equal(pre.command, "/bin/sh");
  assert.deepEqual(pre.args.slice(0, 2), ["${CLAUDE_PLUGIN_ROOT}/bin/ukagai", "hook"]);
  assert.deepEqual(pre.args.slice(-2), ["--managed-by", "ukagai"]);
  assert.ok(!pre.args.includes("--data-dir") && !pre.args.includes("--server"));
});

test("hooks/codex.json has the Codex events, matchers and timeouts", () => {
  const h = parse("hooks/codex.json").hooks;
  assert.deepEqual(Object.keys(h).sort(), [...new Set(CODEX_SPECS.map((s) => s.event))].sort());
  assert.equal(h.PreToolUse[0].matcher, "request_user_input");
  assert.equal(h.SessionStart[0].hooks[0].timeout, 30);
  assert.equal(h.SessionEnd[0].hooks[0].timeout, 3);
  const cmd: string = h.Stop[0].hooks[0].command;
  assert.equal(cmd, '"${PLUGIN_ROOT}/bin/ukagai" hook --agent codex --budget 3590 --managed-by ukagai');
});

test("every command path starts with the plugin root variable", () => {
  for (const g of Object.values<any[]>(parse("hooks/claude.json").hooks).flat())
    for (const h of g.hooks) assert.ok(h.args[0].startsWith("${CLAUDE_PLUGIN_ROOT}/"), h.args[0]);
  for (const g of Object.values<any[]>(parse("hooks/codex.json").hooks).flat())
    for (const h of g.hooks) assert.match(h.command, /^"\$\{PLUGIN_ROOT\}\/bin\/ukagai" /);
});

test("there is no hooks/hooks.json (Codex must never pick up the Claude file)", () => {
  assert.ok(!("hooks/hooks.json" in files));
  assert.deepEqual(Object.keys(files).filter((f) => f.startsWith("hooks/")).sort(), ["hooks/claude.json", "hooks/codex.json"]);
});

test("write-plugin-files.mjs writes the files into a stage (needs dist/)", async (t) => {
  const built = await stat(resolve("dist/plugin/build.js")).then(() => true, () => false);
  if (!built) return t.skip("dist/ is not built");
  const stage = await mkdtemp(join(tmpdir(), "ukagai-plugin-"));
  await new Promise<void>((res, rej) => execFile(process.execPath, [resolve("scripts/write-plugin-files.mjs"), stage, "9.9.9"], (e) => (e ? rej(e) : res())));
  assert.equal(JSON.parse(await readFile(join(stage, "plugin.json"), "utf8")).version, "9.9.9");
  assert.equal(JSON.parse(await readFile(join(stage, ".claude-plugin/plugin.json"), "utf8")).version, "9.9.9");
  assert.equal(JSON.parse(await readFile(join(stage, ".codex-plugin/plugin.json"), "utf8")).hooks, "./hooks/codex.json");
  assert.ok((await stat(join(stage, "hooks/claude.json"))).isFile());
  assert.ok(!(await stat(join(stage, "hooks/hooks.json")).then(() => true, () => false)));
});
