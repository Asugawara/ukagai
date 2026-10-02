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
    const skillExists = !t.noSkill && (await exists(skillFile));

    if (t.dryRun) {
      const diff = unifiedDiff(serialize(before), serialize(after), t.settingsFile, `${t.settingsFile} (after)`);
      process.stdout.write(diff === "" ? "settings: 変更なし\n" : diff);
      if (skillExists) process.stdout.write(`skill: ${skillFile} を削除\n`);
      process.stdout.write("(--dry-run: 何も書いていません)\n");
      return 0;
    }

    const out: string[] = [];
    if (fileExists && changed) {
      const bak = await writeSettings(t.settingsFile, after);
      out.push(`settings: ${t.settingsFile} から ukagai の hook を除去`);
      if (bak) out.push(`backup:   ${bak}`);
    } else out.push("settings: ukagai の hook は登録されていません");
    if (skillExists) {
      await rm(skillFile);
      await rmdir(t.skillDir).catch(() => undefined);
      out.push(`skill:    ${skillFile} を削除`);
    }
    process.stdout.write(out.join("\n") + "\n");
    return 0;
  } catch (err) {
    process.stderr.write(`ukagai uninstall: ${(err as Error).message}\n`);
    return 1;
  }
}
