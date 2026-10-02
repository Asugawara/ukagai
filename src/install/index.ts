import { copyFile, mkdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { buildHookEntries, HOOK_EVENTS } from "../settings/hooks-spec.js";
import { unifiedDiff } from "../settings/diff.js";
import { LANGS, configPath, isLang, readConfig, writeConfig, type Lang } from "../settings/config.js";
import { mergeHooks, readSettings, serialize, writeSettings } from "../settings/merge.js";
import { CLI_PATH, SKILL_SOURCE, parseTarget } from "../settings/target.js";

const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

async function askLang(): Promise<Lang> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (await rl.question(`Language for the GUI / TUI [${LANGS.join("/")}] (en): `)).trim().toLowerCase();
      if (answer === "") return "en";
      if (isLang(answer)) return answer;
    }
  } finally {
    rl.close();
  }
}

/** Decide the display language and write config.json. `--lang` wins; otherwise an existing config is kept; otherwise ask on a TTY, else en. */
async function resolveLang(dataDir: string, flag: Lang | undefined): Promise<Lang> {
  if (flag !== undefined) {
    await writeConfig(dataDir, { lang: flag });
    return flag;
  }
  if (await exists(configPath(dataDir))) return (await readConfig(dataDir)).lang;
  const lang = process.stdin.isTTY && process.stdout.isTTY ? await askLang() : "en";
  await writeConfig(dataDir, { lang });
  return lang;
}

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
    const entries = buildHookEntries({ node: process.execPath, cli: CLI_PATH, timeout: t.timeout, observe: t.observe, hookArgs: t.hookArgs, autostart: !t.noAutostart });
    const after = mergeHooks(before, entries);
    const skillDest = join(t.skillDir, "SKILL.md");

    if (t.dryRun) {
      const diff = unifiedDiff(serialize(before), serialize(after), t.settingsFile, `${t.settingsFile} (after)`);
      process.stdout.write(diff === "" ? "settings: no changes\n" : diff);
      if (t.handleSkill) process.stdout.write(`skill: ${SKILL_SOURCE} -> ${skillDest}\n`);
      process.stdout.write("(--dry-run: nothing was written)\n");
      return 0;
    }

    const lang = await resolveLang(t.dataDir, t.lang);
    const bak = await writeSettings(t.settingsFile, after);
    if (t.handleSkill) {
      await mkdir(t.skillDir, { recursive: true });
      await copyFile(SKILL_SOURCE, skillDest);
    }
    const out = [`settings: ${t.settingsFile}`];
    if (bak) out.push(`backup:   ${bak}`);
    out.push(`node:     ${process.execPath}`, `cli:      ${CLI_PATH}`);
    out.push(`timeout:  ${t.timeout}s (PreToolUse --budget ${t.timeout - 10})${t.observe ? " [observe]" : ""}`);
    out.push(`events:   ${HOOK_EVENTS.join(", ")}`);
    out.push(`lang:     ${lang} (${configPath(t.dataDir)})`);
    out.push(t.noAutostart ? "autostart: off (--no-autostart)" : "autostart: on");
    out.push(t.handleSkill ? `skill:    ${skillDest}` : t.noSkill ? "skill:    (--no-skill)" : "skill:    (not handled because --settings was given; use --skill to place it)");
    process.stdout.write(out.join("\n") + "\n");
    return 0;
  } catch (err) {
    process.stderr.write(`ukagai install: ${(err as Error).message}\n`);
    return 1;
  }
}
