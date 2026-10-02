import { rm, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { unifiedDiff } from "../settings/diff.js";
import { readSettings, removeHooks, serialize, writeSettings } from "../settings/merge.js";
import { parseTarget } from "../settings/target.js";

async function exists(p: string): Promise<boolean> {
  return stat(p).then(() => true, () => false);
}

export async function run(argv: string[]): Promise<number> {
  let t;
  try {
    t = parseTarget(argv);
  } catch (err) {
    process.stderr.write(`ukagai uninstall: ${(err as Error).message}\n`);
    return 2;
  }
  try {
    const fileExists = await exists(t.settingsFile);
    const before = await readSettings(t.settingsFile);
    const after = removeHooks(before);
    const changed = serialize(before) !== serialize(after);
    const skillFile = join(t.skillDir, "SKILL.md");
    const skillExists = t.handleSkill && (await exists(skillFile));

    if (t.dryRun) {
      const diff = unifiedDiff(serialize(before), serialize(after), t.settingsFile, `${t.settingsFile} (after)`);
      process.stdout.write(diff === "" ? "settings: no changes\n" : diff);
      if (skillExists) process.stdout.write(`skill: remove ${skillFile}\n`);
      process.stdout.write("(--dry-run: nothing was written)\n");
      return 0;
    }

    const out: string[] = [];
    if (fileExists && changed) {
      const bak = await writeSettings(t.settingsFile, after);
      out.push(`settings: removed the ukagai hooks from ${t.settingsFile}`);
      if (bak) out.push(`backup:   ${bak}`);
    } else out.push("settings: no ukagai hooks are registered");
    if (skillExists) {
      await rm(skillFile);
      await rmdir(t.skillDir).catch(() => undefined);
      out.push(`skill:    removed ${skillFile}`);
    }
    process.stdout.write(out.join("\n") + "\n");
    return 0;
  } catch (err) {
    process.stderr.write(`ukagai uninstall: ${(err as Error).message}\n`);
    return 1;
  }
}
