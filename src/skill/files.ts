import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, rmdirSync } from "node:fs";
import { basename, join } from "node:path";
import { SKILL_DIR } from "../settings/target.js";

/** Synchronous because the hook calls copyReference too; every function catches its own errors */

const visible = (name: string): boolean => !name.startsWith(".");

/** Top-level entries of the skill directory (SKILL.md and reference/ today); dotfiles are not shipped */
export function shipped(): string[] {
  try {
    return readdirSync(SKILL_DIR).filter(visible);
  } catch {
    return [];
  }
}

/** Both paths resolve to the same directory; false when either does not exist */
export function sameDir(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * Copy the skill directory to dest. A dest that is (a symlink to) the checkout itself is left alone, so the repo's files are never
 * deleted. Shipped entries are removed first so reference files of an older version go away; other files the human put there stay.
 */
export function placeSkill(dest: string): void {
  if (sameDir(dest, SKILL_DIR)) return;
  for (const e of shipped()) rmSync(join(dest, e), { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(SKILL_DIR, dest, { recursive: true, filter: (s) => !basename(s).startsWith(".") });
}

/**
 * Remove the shipped entries from dest, then the directory itself. A directory that is not empty stays: the human's own files, or
 * the extra reference/ of a newer version after a downgrade. Returns the names of the entries that were removed.
 */
export function removeSkill(dest: string): string[] {
  if (sameDir(dest, SKILL_DIR)) return [];
  const removed: string[] = [];
  for (const e of shipped()) {
    const p = join(dest, e);
    if (existsSync(p)) removed.push(e);
    rmSync(p, { recursive: true, force: true });
  }
  try {
    rmdirSync(dest);
  } catch {
    // not empty or already gone
  }
  return removed;
}

/** SKILL.md is the marker, so an old SKILL.md-only copy is still found */
export function hasSkill(dest: string): boolean {
  return existsSync(join(dest, "SKILL.md"));
}

function filesUnder(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const d of readdirSync(join(dir, rel), { withFileTypes: true })) {
    if (!visible(d.name)) continue;
    const r = rel === "" ? d.name : `${rel}/${d.name}`;
    if (d.isDirectory()) out.push(...filesUnder(dir, r));
    else out.push(r);
  }
  return out;
}

/** Relative paths of the shipped files that are missing under dest */
export function missingSkillFiles(dest: string): string[] {
  try {
    return filesUnder(SKILL_DIR).filter((f) => !existsSync(join(dest, f)));
  } catch {
    return [];
  }
}

/**
 * Copy reference/ to dir/reference: the skill's own directory is outside the project and Claude Code asks for a Read permission,
 * the scratchpad does not. Fail open: undefined when there is no reference/ or anything fails.
 */
export function copyReference(dir: string, src: string = join(SKILL_DIR, "reference")): string | undefined {
  try {
    if (!existsSync(src)) return undefined;
    const to = join(dir, "reference");
    mkdirSync(dir, { recursive: true });
    cpSync(src, to, { recursive: true, force: true, filter: (s) => !basename(s).startsWith(".") });
    return to;
  } catch {
    return undefined;
  }
}
