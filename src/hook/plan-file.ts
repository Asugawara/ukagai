import { createReadStream } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { createInterface } from "node:readline";
import { extractExplainBlocks } from "../contract.js";

/** Same bound as the server's history reader */
const TRANSCRIPT_MAX_BYTES = 64 * 1024 * 1024;
/** Fallback scan: only plan files touched this recently */
const FALLBACK_WINDOW_MS = 30 * 60 * 1000;

/** Both wordings appear in Claude Code's plan-mode reminders. The plans directory is configurable, so any absolute *.md path is accepted here */
const PATH = String.raw`(\/[^\s"'` + "`" + String.raw`\\]+\.md)`;
const PLAN_PATH_RES = [new RegExp(String.raw`create your plan at ` + PATH, "g"), new RegExp(String.raw`plan file[^\n]{0,80}?` + PATH, "g")];

/** The last plan-file path the transcript names, or undefined */
async function lastPlanPathIn(transcriptPath: string): Promise<string | undefined> {
  let size: number;
  try {
    size = (await stat(transcriptPath)).size;
  } catch {
    return undefined;
  }
  const start = Math.max(0, size - TRANSCRIPT_MAX_BYTES);
  const stream = createReadStream(transcriptPath, { encoding: "utf8", start });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let last: string | undefined;
  let first = true;
  try {
    for await (const raw of rl) {
      // A read that starts mid-file begins inside a line
      if (first && start > 0) {
        first = false;
        continue;
      }
      first = false;
      if (!raw.includes("plan")) continue;
      const line = raw.replace(/\\\//g, "/");
      for (const re of PLAN_PATH_RES) {
        re.lastIndex = 0;
        for (const m of line.matchAll(re)) last = m[1];
      }
    }
  } catch {
    // an unreadable transcript is "no plan file"
  } finally {
    rl.close();
    stream.destroy();
  }
  return last;
}

/** realpath of `p` if it is an existing regular file inside `home` (realpath), else null */
async function insideHome(p: string, home: string): Promise<string | null> {
  try {
    const root = await realpath(home);
    const real = await realpath(p);
    if (!real.startsWith(root + sep)) return null;
    return (await stat(real)).isFile() ? real : null;
  } catch {
    return null;
  }
}

/**
 * The plan file of a plan-mode session. The transcript names it in the plan-mode reminder (the last mention wins); it must exist and
 * live under `home`. Without a usable mention, the newest `<home>/.claude/plans/*.md` modified within 30 minutes that holds an
 * explanation block for `question`. Null when neither exists (the caller then behaves as before: no explanation in plan mode)
 */
export async function findPlanFile(transcriptPath: string | undefined, home: string, question?: string, now: number = Date.now()): Promise<string | null> {
  if (transcriptPath) {
    const named = await lastPlanPathIn(transcriptPath);
    if (named) {
      const ok = await insideHome(named, home);
      if (ok) return ok;
    }
  }
  if (question === undefined) return null;
  const dir = join(home, ".claude", "plans");
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".md") && !n.startsWith("."));
  } catch {
    return null;
  }
  const files: { path: string; mtimeMs: number }[] = [];
  for (const n of names) {
    const real = await insideHome(join(dir, n), home);
    if (!real) continue;
    try {
      const st = await stat(real);
      if (now - st.mtimeMs <= FALLBACK_WINDOW_MS) files.push({ path: real, mtimeMs: st.mtimeMs });
    } catch {
      // ignore
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const f of files) {
    try {
      if (blockFor(extractExplainBlocks(await readFile(f.path, "utf8")), question)) return f.path;
    } catch {
      // ignore
    }
  }
  return null;
}

/** The last block whose front matter question matches verbatim (the file lookup's rule) */
export function blockFor(blocks: { question: string | undefined; body: string }[], question: string): { question: string | undefined; body: string } | undefined {
  return blocks.filter((b) => b.question === question).pop();
}
