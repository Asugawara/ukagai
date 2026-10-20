import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { MOD_DIR } from "../settings/target.js";

/**
 * The ukagai mod as a plugin of its own, placed at ~/.claude/skills/ukagai-mod/ (a skills-dir plugin Claude Code loads without
 * flags or installation). It carries only the module: the command hooks come from settings.json, a second copy would run them twice.
 * Synchronous like src/skill/files.ts.
 */

const NAME = "ukagai-mod";
const DESCRIPTION = "Delivers ukagai answers to Claude Code as messages once the agent is idle (needs the ukagai hooks).";
const json = (v: unknown): string => JSON.stringify(v, null, 2) + "\n";

/** The module sources: *.ts without the tests */
function sources(): string[] {
  try {
    return readdirSync(MOD_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  } catch {
    return [];
  }
}

export interface ModOptions {
  version: string;
  /** Written to hooks/mod/config.json only when given */
  server?: string | undefined;
  dataDir?: string | undefined;
}

export function placeMod(dest: string, o: ModOptions): void {
  removeMod(dest);
  mkdirSync(join(dest, ".claude-plugin"), { recursive: true });
  mkdirSync(join(dest, "hooks", "mod"), { recursive: true });
  writeFileSync(join(dest, ".claude-plugin", "plugin.json"), json({ name: NAME, version: o.version, description: DESCRIPTION, author: { name: "Asugawara" }, hooks: "./hooks/claude.json" }));
  writeFileSync(join(dest, "hooks", "claude.json"), json({ modules: ["./mod/register.ts"] }));
  for (const f of sources()) copyFileSync(join(MOD_DIR, f), join(dest, "hooks", "mod", f));
  const config = { ...(o.server !== undefined ? { server: o.server } : {}), ...(o.dataDir !== undefined ? { dataDir: o.dataDir } : {}) };
  if (Object.keys(config).length > 0) writeFileSync(join(dest, "hooks", "mod", "config.json"), json(config));
}

/** Remove what placeMod wrote, then the empty directories; files the human added stay. Returns whether anything was removed */
export function removeMod(dest: string): boolean {
  if (!hasMod(dest)) return false;
  rmSync(join(dest, ".claude-plugin", "plugin.json"), { force: true });
  rmSync(join(dest, "hooks", "claude.json"), { force: true });
  for (const f of [...sources(), "config.json"]) rmSync(join(dest, "hooks", "mod", f), { force: true });
  for (const d of [join(dest, ".claude-plugin"), join(dest, "hooks", "mod"), join(dest, "hooks"), dest]) {
    try {
      rmdirSync(d);
    } catch {
      // not empty or already gone
    }
  }
  return true;
}

/** plugin.json with this name is the marker: a directory of the human's own is not touched */
export function hasMod(dest: string): boolean {
  try {
    const p = JSON.parse(readFileSync(join(dest, ".claude-plugin", "plugin.json"), "utf8")) as { name?: unknown };
    return p.name === NAME;
  } catch {
    return false;
  }
}

/** Source files missing under dest (for doctor) */
export function missingModFiles(dest: string): string[] {
  const want = [".claude-plugin/plugin.json", "hooks/claude.json", ...sources().map((f) => `hooks/mod/${f}`)];
  return want.filter((f) => !existsSync(join(dest, f)));
}
