import { access, constants, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { configPath, readConfig } from "../settings/config.js";
import { CHECKPOINT_FLAG, HOOK_EVENTS, PLAN_CONTEXT_FLAG } from "../settings/hooks-spec.js";
import { findManaged, readSettings } from "../settings/merge.js";
import { enabledClaudePlugin, enabledCodexPlugin } from "../settings/plugins.js";
import { status as codexStatus } from "../install/codex.js";
import { REPO_ROOT, parseTarget } from "../settings/target.js";
import { VERSION } from "../version.js";

const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);
const executable = (p: string): Promise<boolean> => access(p, constants.X_OK).then(() => true, () => false);

export async function run(argv: string[]): Promise<number> {
  let t;
  try {
    t = parseTarget(argv);
  } catch (err) {
    process.stderr.write(`ukagai doctor: ${(err as Error).message}\n`);
    return 2;
  }
  const rows: [boolean, string, string][] = [];
  const add = (ok: boolean, name: string, note = ""): void => void rows.push([ok, name, note]);

  add(true, "version", `${VERSION} (${REPO_ROOT})`);

  let settings: Record<string, unknown> = {};
  if (t.claude) {
    try {
      settings = await readSettings(t.settingsFile);
    } catch (err) {
      add(false, `settings ${t.settingsFile}`, (err as Error).message);
    }
  }
  const claudePlugin = t.claude ? await enabledClaudePlugin(t.pluginSettingsFiles) : undefined;
  const codexPlugin = t.codex ? await enabledCodexPlugin(t.codexHome) : undefined;
  const managedInSettings = HOOK_EVENTS.some((ev) => findManaged(settings, ev) !== undefined);
  // with the plugin enabled and nothing in settings.json, the hooks and the skill come from the plugin
  const viaPlugin = claudePlugin !== undefined && !managedInSettings;
  if (t.codex) {
    try {
      const cs = await codexStatus(t.codexHome);
      const codexViaPlugin = codexPlugin !== undefined && !cs.rows.some((r) => r.installed);
      for (const r of codexViaPlugin ? [] : cs.rows) {
        add(r.installed && r.trusted === "trusted", `codex hook ${r.event}`, !r.installed ? "not registered" : r.trusted === "trusted" ? "trusted" : `${r.trusted} (run: ukagai install --codex)`);
      }
      const cmd = cs.rows.find((r) => r.command !== undefined)?.command;
      if (cmd !== undefined) add(true, "codex hooks.json", cs.hooksFile);
    } catch (err) {
      add(false, `codex ${t.codexHome}`, (err as Error).message);
    }
  }
  if (t.claude) {
    add(true, "plugin", claudePlugin !== undefined ? `${claudePlugin} enabled` : "no plugin");
    if (claudePlugin !== undefined && managedInSettings) add(false, "hooks registered twice", "plugin and settings.json: run ukagai install");
  }
  if (t.codex) {
    add(true, "codex plugin", codexPlugin !== undefined ? `${codexPlugin} enabled` : "no plugin");
    if (codexPlugin !== undefined && (await codexStatus(t.codexHome).then((c) => c.rows.some((r) => r.installed), () => false))) add(false, "codex hooks registered twice", "plugin and hooks.json: run ukagai install --codex");
  }
  let node: string | undefined;
  let cli: string | undefined;
  let launcher = false;
  for (const ev of t.claude && !viaPlugin ? HOOK_EVENTS : []) {
    const h = findManaged(settings, ev);
    add(h !== undefined, `hook ${ev}`, h ? "" : "not registered");
    if (h && node === undefined) {
      node = typeof h["command"] === "string" ? h["command"] : undefined;
      const args = h["args"];
      // The launcher form is `<launcher> hook …`; the node form is `<node> <cli.js> hook …`
      launcher = Array.isArray(args) && args[0] === "hook";
      cli = Array.isArray(args) && typeof args[0] === "string" && !launcher ? args[0] : undefined;
    }
  }
  if (t.claude && !viaPlugin) {
    const c = findManaged(settings, "PreToolUse", (h) => Array.isArray(h["args"]) && h["args"].includes(CHECKPOINT_FLAG));
    const observing = Array.isArray(findManaged(settings, "PreToolUse")?.["args"]) && (findManaged(settings, "PreToolUse")!["args"] as unknown[]).includes("--observe");
    add(c !== undefined || observing, "hook PreToolUse (checkpoint)", c ? "" : observing ? "off (--observe)" : "not registered (run: ukagai install)");
    const p = findManaged(settings, "PreToolUse", (h) => Array.isArray(h["args"]) && h["args"].includes(PLAN_CONTEXT_FLAG));
    add(p !== undefined || observing, "hook PreToolUse (plan context)", p ? "" : observing ? "off (--observe)" : "not registered (run: ukagai install)");
    const u = findManaged(settings, "UserPromptSubmit", (h) => Array.isArray(h["args"]) && h["args"].includes(PLAN_CONTEXT_FLAG));
    add(u !== undefined || observing, "hook UserPromptSubmit (plan context)", u ? "" : observing ? "off (--observe)" : "not registered (run: ukagai install)");
  }
  if (node !== undefined && launcher) {
    const ok = await executable(node);
    const real = ok ? await realpath(node).catch(() => node!) : undefined;
    add(ok, "launcher", ok ? (real !== node ? `${node} -> ${real}` : node) : `${node} is missing or not executable (run: ukagai install)`);
    const np = join(t.dataDir, "node-path");
    let target: string | undefined;
    try {
      target = (await readFile(np, "utf8")).split("\n")[0]?.trim() || undefined;
    } catch {
      // missing
    }
    const good = target !== undefined && (await executable(target));
    add(good, "node-path", good ? `${np} -> ${target}` : `${np} is missing or points at no executable (re-run install.sh)`);
  } else {
    if (node !== undefined) add(await exists(node), "node exists", node);
    if (cli !== undefined) add(await exists(cli), "cli exists", cli);
  }

  try {
    const res = await fetch(`${t.server}/healthz`, { signal: AbortSignal.timeout(2000) });
    let note = `HTTP ${res.status}`;
    if (res.status === 200) {
      const sv = ((await res.json().catch(() => null)) as { version?: unknown } | null)?.version;
      if (typeof sv === "string" && sv !== VERSION) note += `; server runs ${sv}; it restarts at the next session start`;
    }
    add(res.status === 200, `server ${t.server}/healthz`, note);
  } catch (err) {
    add(false, `server ${t.server}/healthz`, `cannot connect (${(err as Error).cause instanceof Error ? ((err as Error).cause as Error).message : (err as Error).message})`);
  }
  add(await exists(join(t.dataDir, "token")), "token", join(t.dataDir, "token"));
  if (t.claude) {
    if (viaPlugin) add(true, "skill ukagai-explain", "from the plugin");
    else if (t.handleSkill) add(await exists(join(t.skillDir, "SKILL.md")), "skill ukagai-explain", join(t.skillDir, "SKILL.md"));
    else add(true, "skill ukagai-explain", "not handled");
  }

  const ss = findManaged(settings, "SessionStart");
  const off = Array.isArray(ss?.["args"]) && (ss["args"] as unknown[]).includes("--no-autostart");
  add(true, "autostart", off ? "off (--no-autostart)" : "on");
  add(true, "lang", `${(await readConfig(t.dataDir)).lang} (${configPath(t.dataDir)})`);
  add(true, "serve.log", join(t.dataDir, "serve.log"));
  let opened = "(none)";
  try {
    opened = (await readFile(join(t.dataDir, "gui-opened"), "utf8")).trim() || opened;
  } catch {
    // not recorded
  }
  add(true, "gui-opened", opened);

  try {
    const lines = (await readFile(join(t.dataDir, "hook.log"), "utf8")).trimEnd().split("\n").slice(-3);
    lines.forEach((l, i) => add(true, i === 0 ? "hook.log (last 3)" : "", l));
  } catch {
    // no log yet
  }

  const w = Math.max(...rows.map((r) => r[1].length));
  for (const [ok, name, note] of rows) {
    process.stdout.write(`${ok ? "○" : "×"}  ${name.padEnd(w)}  ${note}\n`.replace(/\s+\n$/, "\n"));
  }
  const bad = rows.filter((r) => !r[0]).length;
  process.stdout.write(bad === 0 ? "no problems\n" : `${bad} problem(s) found\n`);
  return bad === 0 ? 0 : 1;
}
