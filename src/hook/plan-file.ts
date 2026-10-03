import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { TRANSCRIPT_MAX_BYTES, extractExplainBlocks, isPlanFile, plansDir, realFileUnder } from "../contract.js";

type ExplainBlock = { question: string | undefined; body: string };

/** Fallback scan: only plan files touched this recently */
const FALLBACK_WINDOW_MS = 30 * 60 * 1000;
/** The transcript is read backwards in chunks of this size, each overlapping the previous one so a path on a boundary is whole in one of them */
const CHUNK_BYTES = 512 * 1024;
const OVERLAP_BYTES = 2048;

/** Both wordings appear in Claude Code's plan-mode reminders. The plans directory is configurable, so any absolute *.md path is accepted here */
const PATH = String.raw`(\/[^\s"'` + "`" + String.raw`\\]+\.md)`;
const PLAN_PATH_RES = [new RegExp(String.raw`create your plan at ` + PATH, "g"), new RegExp(String.raw`plan file[^\n]{0,80}?` + PATH, "g")];

/** The last plan-file path in `text` (JSON-escaped slashes included), or undefined */
function lastPlanPath(text: string): string | undefined {
  if (!text.includes("create your plan at") && !text.includes("plan file")) return undefined;
  const plain = text.replace(/\\\//g, "/");
  let best: { index: number; path: string } | undefined;
  for (const re of PLAN_PATH_RES) {
    for (const m of plain.matchAll(re)) {
      if (!best || m.index! >= best.index) best = { index: m.index!, path: m[1]! };
    }
  }
  return best?.path;
}

/** The last plan-file path the transcript names, or undefined. Reads from the end and stops at the first chunk that names one */
async function lastPlanPathIn(transcriptPath: string): Promise<string | undefined> {
  let fh;
  try {
    fh = await open(transcriptPath, "r");
    const size = (await fh.stat()).size;
    const floor = Math.max(0, size - TRANSCRIPT_MAX_BYTES);
    let end = size;
    while (end > floor) {
      const start = Math.max(floor, end - CHUNK_BYTES);
      const buf = Buffer.alloc(end - start);
      const { bytesRead } = await fh.read(buf, 0, buf.length, start);
      const found = lastPlanPath(buf.toString("utf8", 0, bytesRead));
      if (found) return found;
      if (start === floor) break;
      end = start + OVERLAP_BYTES;
    }
  } catch {
    // an unreadable transcript is "no plan file"
  } finally {
    await fh?.close().catch(() => {});
  }
  return undefined;
}

/** The last block whose front matter question matches verbatim (the file lookup's rule) */
export function blockFor(blocks: ExplainBlock[], question: string): ExplainBlock | undefined {
  return blocks.filter((b) => b.question === question).pop();
}

/** blockFor over a plan file's blocks; undefined when there is none or the file cannot be read */
export async function readBlockFor(file: string, question: string): Promise<ExplainBlock | undefined> {
  try {
    return blockFor(extractExplainBlocks(await readFile(file, "utf8")), question);
  } catch {
    return undefined;
  }
}

/**
 * The plan file of a plan-mode session. The transcript names it in the plan-mode reminder (the last mention wins); it must be a plan
 * file (the server's file names) that exists and lives under `home`. Without a usable mention, the newest `<home>/.claude/plans/*.md`
 * modified within 30 minutes that holds an explanation block for `question`; that block comes back with it so the caller does not read
 * the file again. Null when neither exists (the caller then behaves as before: no explanation in plan mode)
 */
export async function findPlanFile(
  transcriptPath: string | undefined,
  home: string,
  question?: string,
  now: number = Date.now(),
): Promise<{ file: string; block?: ExplainBlock } | null> {
  let root: string;
  try {
    root = await realpath(home);
  } catch {
    return null;
  }
  if (transcriptPath) {
    const named = await lastPlanPathIn(transcriptPath);
    if (named && isPlanFile(named.slice(named.lastIndexOf("/") + 1))) {
      const file = realFileUnder(root, named);
      if (file) return { file };
    }
  }
  if (question === undefined) return null;
  const dir = plansDir(home);
  let names: string[];
  try {
    names = (await readdir(dir)).filter(isPlanFile);
  } catch {
    return null;
  }
  const hits = await Promise.all(
    names.map(async (n) => {
      try {
        const path = join(dir, n);
        const { mtimeMs } = await stat(path);
        if (now - mtimeMs > FALLBACK_WINDOW_MS) return null;
        const file = realFileUnder(root, path);
        const block = file ? await readBlockFor(file, question) : undefined;
        return file && block ? { file, block, mtimeMs } : null;
      } catch {
        return null;
      }
    }),
  );
  const newest = hits.filter((h) => h !== null).sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  return newest ? { file: newest.file, block: newest.block } : null;
}
