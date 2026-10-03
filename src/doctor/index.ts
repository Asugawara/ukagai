import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { configPath, readConfig } from "../settings/config.js";
import { HOOK_EVENTS } from "../settings/hooks-spec.js";
import { findManaged, readSettings } from "../settings/merge.js";
import { status as codexStatus } from "../install/codex.js";
import { parseTarget } from "../settings/target.js";

const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

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

  let settings: Record<string, unknown> = {};
  if (t.claude) {
    try {
      settings = await readSettings(t.settingsFile);
    } catch (err) {
      add(false, `settings ${t.settingsFile}`, (err as Error).message);
    }
  }
  if (t.codex) {
    try {
      const cs = await codexStatus(t.codexHome);
      for (const r of cs.rows) {
        add(r.installed && r.trusted === "trusted", `codex hook ${r.event}`, !r.installed ? "not registered" : r.trusted === "trusted" ? "trusted" : `${r.trusted} (run: ukagai install --codex)`);
      }
      const cmd = cs.rows.find((r) => r.command !== undefined)?.command;
      if (cmd !== undefined) add(true, "codex hooks.json", cs.hooksFile);
    } catch (err) {
      add(false, `codex ${t.codexHome}`, (err as Error).message);
    }
  }
  let node: string | undefined;
  let cli: string | undefined;
  for (const ev of t.claude ? HOOK_EVENTS : []) {
    const h = findManaged(settings, ev);
    add(h !== undefined, `hook ${ev}`, h ? "" : "not registered");
    if (h && node === undefined) {
      node = typeof h["command"] === "string" ? h["command"] : undefined;
      const args = h["args"];
      cli = Array.isArray(args) && typeof args[0] === "string" ? args[0] : undefined;
    }
  }
  if (node !== undefined) add(await exists(node), "node exists", node);
  if (cli !== undefined) add(await exists(cli), "cli exists", cli);

  try {
    const res = await fetch(`${t.server}/healthz`, { signal: AbortSignal.timeout(2000) });
    add(res.status === 200, `server ${t.server}/healthz`, `HTTP ${res.status}`);
  } catch (err) {
    add(false, `server ${t.server}/healthz`, `cannot connect (${(err as Error).cause instanceof Error ? ((err as Error).cause as Error).message : (err as Error).message})`);
  }
  add(await exists(join(t.dataDir, "token")), "token", join(t.dataDir, "token"));
  if (t.claude) {
    if (t.handleSkill) add(await exists(join(t.skillDir, "SKILL.md")), "skill ukagai-explain", join(t.skillDir, "SKILL.md"));
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
