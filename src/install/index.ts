import { copyFile, mkdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { buildHookEntries, HOOK_EVENTS } from "../settings/hooks-spec.js";
import { unifiedDiff } from "../settings/diff.js";
import { LANGS, configPath, isLang, readConfig, writeConfig, type Lang } from "../settings/config.js";
import { mergeHooks, readSettings, serialize, writeSettings } from "../settings/merge.js";
import { CODEX_SPECS, apply as applyCodex, plan, type CodexInstallOptions } from "./codex.js";
import { SKILL_SOURCE, hookInvocation, parseTarget } from "../settings/target.js";

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
    await writeConfig(dataDir, { ...(await readConfig(dataDir)), lang: flag });
    return flag;
  }
  if (await exists(configPath(dataDir))) return (await readConfig(dataDir)).lang;
  const lang = process.stdin.isTTY && process.stdout.isTTY ? await askLang() : "en";
  await writeConfig(dataDir, { ...(await readConfig(dataDir)), lang });
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
    const inv = hookInvocation();
    const cx: CodexInstallOptions = {
      home: t.codexHome,
      invocation: inv,
      timeout: t.timeout,
      hookArgs: t.hookArgs,
      noAutostart: t.noAutostart,
    };
    const codexPlan = t.codex ? await plan(cx, "install") : undefined;
    const before = await readSettings(t.settingsFile);
    const entries = buildHookEntries({ invocation: inv, timeout: t.timeout, observe: t.observe, hookArgs: t.hookArgs, autostart: !t.noAutostart });
    const after = mergeHooks(before, entries);
    const skillDest = join(t.skillDir, "SKILL.md");

    if (t.dryRun) {
      if (t.claude) {
        const diff = unifiedDiff(serialize(before), serialize(after), t.settingsFile, `${t.settingsFile} (after)`);
        process.stdout.write(diff === "" ? "settings: no changes\n" : diff);
        if (t.handleSkill) process.stdout.write(`skill: ${SKILL_SOURCE} -> ${skillDest}\n`);
      }
      if (codexPlan) {
        for (const [file, a, b] of [
          [codexPlan.hooksFile, codexPlan.hooksBefore, codexPlan.hooksAfter],
          [codexPlan.configFile, codexPlan.configBefore, codexPlan.configAfter],
        ] as const) {
          const diff = unifiedDiff(a, b, file, `${file} (after)`);
          process.stdout.write(diff === "" ? `codex: ${file}: no changes\n` : diff);
        }
      }
      process.stdout.write("(--dry-run: nothing was written)\n");
      return 0;
    }

    const lang = await resolveLang(t.dataDir, t.lang);
    const out: string[] = [];
    if (t.claude) {
      const bak = await writeSettings(t.settingsFile, after);
      if (t.handleSkill) {
        await mkdir(t.skillDir, { recursive: true });
        await copyFile(SKILL_SOURCE, skillDest);
      }
      out.push(`settings: ${t.settingsFile}`);
      if (bak) out.push(`backup:   ${bak}`);
      out.push(`hook:     ${[inv.command, ...inv.prefix, "hook"].join(" ")}${inv.launcher ? "" : " (dev checkout: hooks run node + dist/cli.js)"}`);
      if (inv.launcher && inv.command.includes("/versions/")) out.push("note:     hooks point at a versioned path; run the ukagai on PATH instead");
      out.push(`timeout:  ${t.timeout}s (PreToolUse --budget ${t.timeout - 10})${t.observe ? " [observe]" : ""}`);
      out.push(`events:   ${HOOK_EVENTS.join(", ")}`);
      out.push(t.noAutostart ? "autostart: off (--no-autostart)" : "autostart: on");
      out.push(t.handleSkill ? `skill:    ${skillDest}` : t.noSkill ? "skill:    (--no-skill)" : "skill:    (not handled because --settings was given; use --skill to place it)");
    }
    if (codexPlan) {
      const baks = await applyCodex(t.codexHome, codexPlan);
      out.push(`codex:    ${codexPlan.hooksFile} (${CODEX_SPECS.map((c) => c.event).join(", ")})`);
      out.push(`trust:    ${codexPlan.managed.size} hook(s) trusted in ${codexPlan.configFile}`);
      for (const b of baks) out.push(`backup:   ${b}`);
    }
    out.push(`lang:     ${lang} (${configPath(t.dataDir)})`);
    process.stdout.write(out.join("\n") + "\n");
    return 0;
  } catch (err) {
    process.stderr.write(`ukagai install: ${(err as Error).message}\n`);
    return 1;
  }
}
