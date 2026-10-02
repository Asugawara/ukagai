import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { buildHookEntries, HOOK_EVENTS } from "../settings/hooks-spec.js";
import { unifiedDiff } from "../settings/diff.js";
import { mergeHooks, readSettings, serialize, writeSettings } from "../settings/merge.js";
import { CLI_PATH, SKILL_SOURCE, parseTarget } from "../settings/target.js";

export async function run(argv: string[]): Promise<number> {
  let t;
  try {
    t = parseTarget(argv);
  } catch (err) {
    process.stderr.write(`ukagai install: ${(err as Error).message}\n`);
    return 2;
  }
  try {
    const before = await readSettings(t.settingsFile);
    const entries = buildHookEntries({ node: process.execPath, cli: CLI_PATH, timeout: t.timeout, observe: t.observe });
    const after = mergeHooks(before, entries);
    const skillDest = join(t.skillDir, "SKILL.md");

    if (t.dryRun) {
      const diff = unifiedDiff(serialize(before), serialize(after), t.settingsFile, `${t.settingsFile} (after)`);
      process.stdout.write(diff === "" ? "settings: 変更なし\n" : diff);
      if (!t.noSkill) process.stdout.write(`skill: ${SKILL_SOURCE} -> ${skillDest}\n`);
      process.stdout.write("(--dry-run: 何も書いていません)\n");
      return 0;
    }

    const bak = await writeSettings(t.settingsFile, after);
    if (!t.noSkill) {
      await mkdir(t.skillDir, { recursive: true });
      await copyFile(SKILL_SOURCE, skillDest);
    }
    const out = [`settings: ${t.settingsFile}`];
    if (bak) out.push(`backup:   ${bak}`);
    out.push(`node:     ${process.execPath}`, `cli:      ${CLI_PATH}`);
    out.push(`timeout:  ${t.timeout}s(PreToolUse の --budget ${t.timeout - 10})${t.observe ? " [observe]" : ""}`);
    out.push(`events:   ${HOOK_EVENTS.join(", ")}`);
    out.push(t.noSkill ? "skill:    (--no-skill)" : `skill:    ${skillDest}`);
    process.stdout.write(out.join("\n") + "\n");
    return 0;
  } catch (err) {
    process.stderr.write(`ukagai install: ${(err as Error).message}\n`);
    return 1;
  }
}
