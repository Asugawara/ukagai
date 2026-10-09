import { copyFile, mkdir, rm, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { buildHookEntries, HOOK_EVENTS } from "../settings/hooks-spec.js";
import { unifiedDiff } from "../settings/diff.js";
import { configPath, localeLang, readConfig, writeConfig, type Lang } from "../settings/config.js";
import { mergeHooks, readSettings, removeHooks, serialize, writeSettings } from "../settings/merge.js";
import { enabledClaudePlugin, enabledCodexPlugin } from "../settings/plugins.js";
import { CODEX_SPECS, apply as applyCodex, plan, type CodexInstallOptions } from "./codex.js";
import { SKILL_SOURCE, hookInvocation, parseTarget, type Invocation, type Target } from "../settings/target.js";
import { claudeOptions, codexOptions, detectClaude, detectCodex, registeredClaude, registeredCodex, resolveOptions, tilde } from "../settings/agents.js";

const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

const pluginLine = (key: string): string => `plugin ${key} is enabled: hooks and skill come from the plugin (use --force to register them in settings.json as well)`;

type Agent = "claude" | "codex";
const LABEL: Record<Agent, string> = { claude: "Claude Code", codex: "Codex CLI" };

/** The language of the first install: config.json is created from the locale only when it is missing, and never touched otherwise */
async function ensureConfig(dataDir: string): Promise<Lang> {
  if (await exists(configPath(dataDir))) return (await readConfig(dataDir)).lang;
  const lang = localeLang();
  await writeConfig(dataDir, { ...(await readConfig(dataDir)), lang });
  return lang;
}

/** Whether the agent already has ukagai hooks. A registration that cannot be read counts as registered: the run reports the error */
async function isRegistered(t: Target, agent: Agent): Promise<boolean> {
  try {
    return agent === "claude" ? registeredClaude(await readSettings(t.settingsFile)) : await registeredCodex(t.codexHome);
  } catch {
    return true;
  }
}

/** Register (or, with the plugin enabled, unregister) the hooks and the skill in Claude Code's settings */
async function installClaude(t: Target, inv: Invocation, emit: (s: string) => void): Promise<void> {
  // An enabled plugin brings the hooks and the skill: installing them here too would run every hook twice
  const plugin = !t.force && !t.settingsGiven ? await enabledClaudePlugin(t.pluginSettingsFiles) : undefined;
  const before = await readSettings(t.settingsFile);
  const o = resolveOptions(t, registeredClaude(before) ? claudeOptions(before) : undefined);
  const entries = buildHookEntries({ invocation: inv, timeout: o.timeout, observe: o.observe, hookArgs: o.hookArgs, autostart: !o.noAutostart });
  const after = plugin !== undefined ? removeHooks(before) : mergeHooks(before, entries);
  const skillDest = join(t.skillDir, "SKILL.md");
  const changed = serialize(before) !== serialize(after);

  if (t.dryRun) {
    if (plugin !== undefined) emit(pluginLine(plugin) + "\n");
    const diff = unifiedDiff(serialize(before), serialize(after), t.settingsFile, `${t.settingsFile} (after)`);
    emit(diff === "" ? "settings: no changes\n" : diff);
    if (plugin !== undefined) {
      if (t.handleSkill && (await exists(skillDest))) emit(`skill: remove ${skillDest}\n`);
    } else if (t.handleSkill) emit(`skill: ${SKILL_SOURCE} -> ${skillDest}\n`);
    return;
  }
  if (plugin !== undefined) {
    if ((await exists(t.settingsFile)) && changed) {
      const bak = await writeSettings(t.settingsFile, after);
      emit(`settings: removed the ukagai hooks from ${t.settingsFile}\n`);
      if (bak) emit(`backup:   ${bak}\n`);
    }
    if (t.handleSkill && (await exists(skillDest))) {
      await rm(skillDest);
      await rmdir(t.skillDir).catch(() => undefined);
      emit(`skill:    removed ${skillDest}\n`);
    }
    emit(pluginLine(plugin) + "\n");
    return;
  }
  // The same content is not written again: every write leaves a .bak-* next to the file
  const bak = changed ? await writeSettings(t.settingsFile, after) : null;
  if (t.handleSkill) {
    await mkdir(t.skillDir, { recursive: true });
    await copyFile(SKILL_SOURCE, skillDest);
  }
  emit(`settings: ${t.settingsFile}${changed ? "" : " (unchanged)"}\n`);
  if (bak) emit(`backup:   ${bak}\n`);
  emit(`hook:     ${[inv.command, ...inv.prefix, "hook"].join(" ")}${inv.launcher ? "" : " (dev checkout: hooks run node + dist/cli.js)"}\n`);
  if (inv.launcher && inv.command.includes("/versions/")) emit("note:     hooks point at a versioned path; run the ukagai on PATH instead\n");
  emit(`timeout:  ${o.timeout}s (PreToolUse --budget ${o.timeout - 10})${o.observe ? " [observe]" : ""}\n`);
  emit(`events:   ${HOOK_EVENTS.join(", ")}\n`);
  emit(o.noAutostart ? "autostart: off (--no-autostart)\n" : "autostart: on\n");
  emit((t.handleSkill ? `skill:    ${skillDest}` : t.noSkill ? "skill:    (--no-skill)" : "skill:    (not handled because --settings was given; use --skill to place it)") + "\n");
}

/** Register (or, with the plugin enabled, unregister) the hooks in Codex CLI's hooks.json and trust them in config.toml */
async function installCodex(t: Target, inv: Invocation, emit: (s: string) => void): Promise<void> {
  const pluginKey = t.force ? undefined : await enabledCodexPlugin(t.codexHome);
  const o = resolveOptions(t, pluginKey === undefined && (await registeredCodex(t.codexHome)) ? await codexOptions(t.codexHome) : undefined);
  const cx: CodexInstallOptions = { home: t.codexHome, invocation: inv, timeout: o.timeout, hookArgs: o.hookArgs, noAutostart: o.noAutostart };
  const p = await plan(cx, pluginKey !== undefined ? "uninstall" : "install");
  if (t.dryRun) {
    if (pluginKey !== undefined) emit(pluginLine(pluginKey) + "\n");
    for (const [file, a, b] of [
      [p.hooksFile, p.hooksBefore, p.hooksAfter],
      [p.configFile, p.configBefore, p.configAfter],
    ] as const) {
      const diff = unifiedDiff(a, b, file, `${file} (after)`);
      emit(diff === "" ? `codex: ${file}: no changes\n` : diff);
    }
    return;
  }
  const baks = await applyCodex(t.codexHome, p);
  if (pluginKey !== undefined) emit(pluginLine(pluginKey) + "\n");
  else {
    emit(`codex:    ${p.hooksFile} (${CODEX_SPECS.map((c) => c.event).join(", ")})\n`);
    emit(`trust:    ${p.managed.size} hook(s) trusted in ${p.configFile}\n`);
  }
  for (const b of baks) emit(`backup:   ${b}\n`);
}

export async function run(argv: string[]): Promise<number> {
  let t;
  try {
    t = parseTarget(argv, "install");
  } catch (err) {
    process.stderr.write(`ukagai install: ${(err as Error).message}\n`);
    return 2;
  }
  for (const w of t.warnings) process.stderr.write(`ukagai install: warning: ${w}\n`);
  try {
    const candidates: Agent[] = [...(t.claude ? (["claude"] as const) : []), ...(t.codex ? (["codex"] as const) : [])];
    const picked: [Agent, string][] = [];
    for (const agent of candidates) {
      if (t.refresh) {
        if (await isRegistered(t, agent)) picked.push([agent, "registered"]);
      } else if (t.agentsExplicit) picked.push([agent, "requested"]);
      else {
        const why = agent === "claude" ? await detectClaude() : await detectCodex(t.codexHome);
        if (why !== undefined) picked.push([agent, why]);
      }
    }
    if (picked.length === 0) {
      process.stdout.write(
        (t.refresh
          ? "no ukagai hooks are registered; nothing to refresh (run: ukagai install)"
          : `no agent found (looked for claude on PATH, ~/.claude.json, ~/.claude/projects, codex on PATH, ${tilde(t.codexHome)}/sessions): install Claude Code or Codex CLI, then run: ukagai install`) + "\n",
      );
      return 0;
    }

    const inv = hookInvocation();
    const out: string[] = [`agents:   ${picked.map(([a, why]) => `${LABEL[a]} (${why})`).join(", ")}\n`];
    // Detection and --refresh keep one agent's failure from stopping the others
    const isolate = t.refresh || !t.agentsExplicit;
    let failed = false;
    let done = 0;
    for (const [agent] of picked) {
      try {
        await (agent === "claude" ? installClaude : installCodex)(t, inv, (s) => void out.push(s));
        done++;
      } catch (err) {
        if (!isolate) throw err;
        failed = true;
        process.stderr.write(`${agent}: error: ${(err as Error).message}\n`);
      }
    }
    if (t.dryRun) out.push("(--dry-run: nothing was written)\n");
    else {
      const lang = await ensureConfig(t.dataDir);
      out.push(`lang:     ${lang} (${configPath(t.dataDir)}); change it on the Settings page: ${t.server}/settings\n`);
      if (done > 0) out.push("next:     start claude or codex; the GUI opens on your first session\n");
    }
    process.stdout.write(out.join(""));
    return failed ? 1 : 0;
  } catch (err) {
    process.stderr.write(`ukagai install: ${(err as Error).message}\n`);
    return 1;
  }
}
