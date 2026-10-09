import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { customSkillPath } from "../settings/skill.js";

/**
 * Where the agent reads the human's edited version of the skill, or undefined (today's texts) when there is none or anything fails (fail open).
 * Claude Code (`scratchpadDir` given): the file is copied to `<scratchpad>/ukagai/skill/SKILL.md`, which it reads without an approval prompt
 * (a file under ~/.ukagai is outside the project and asks every session). The copy sits in `skill/`, not in `ukagai/`: `findExplanation`
 * takes every `*.md` directly under `ukagai/` for an explanation. Codex has no scratchpad: the data directory's own file is used.
 * The copy is refreshed on every call, so a version saved mid-session reaches the next hook run.
 */
export function resolveSkillRef(dataDir: string, scratchpadDir?: string): string | undefined {
  try {
    const src = customSkillPath(dataDir);
    if (!statSync(src).isFile()) return undefined;
    if (!scratchpadDir) return src;
    const dir = join(scratchpadDir, "ukagai", "skill");
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, "SKILL.md");
    copyFileSync(src, dest);
    return dest;
  } catch {
    return undefined;
  }
}
