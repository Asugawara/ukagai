import { realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, resolve, sep } from "node:path";
import { PLAN_BLOCK_SUFFIX, plansDir, realFileUnder } from "../contract.js";

/** Largest document image that is served */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export const FILE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

// A Claude Code scratchpad below an OS temp dir: <tmp>/claude-<uid>/<project>/<session>/scratchpad/
const SCRATCHPAD = /^claude-[^/]+\/(?:[^/]+\/)*scratchpad\//;

const usable = (f: string): boolean => {
  try {
    const st = statSync(f);
    return st.isFile() && st.size <= MAX_FILE_BYTES;
  } catch {
    return false;
  }
};

const real = (p: string): string | null => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};

/** The directory a document's relative image paths resolve against: an explanation file (without the plan block suffix) or a plan file */
export function documentDir(docPath: string): string {
  return dirname(docPath.endsWith(PLAN_BLOCK_SUFFIX) ? docPath.slice(0, -PLAN_BLOCK_SUFFIX.length) : docPath);
}

/**
 * Where a document's images may come from. `baseDir` only resolves relative paths. `root` is an extra allowed root and is set only when the document
 * is a validated standalone explanation file (its directory is under <data-dir>/explain, a scratchpad or ~/.ukagai/explain); a plan-block explanation
 * (anywhere under $HOME) or a plan file never makes its own directory a root, so the result must lie under a fixed root.
 */
export type DocumentScope = { baseDir: string; root?: string };

function inScratchpad(file: string): boolean {
  for (const t of new Set(["/private/tmp", "/tmp", tmpdir()])) {
    const root = real(t);
    if (root && file.startsWith(root + sep) && SCRATCHPAD.test(file.slice(root.length + 1))) return true;
  }
  return false;
}

/**
 * The real path of the image `written` (as in the Markdown) for a document, or null when it must not be served:
 * not a regular file, wrong extension, too big, or outside the document's own root / plans dir / a Claude Code scratchpad / the data dir.
 * Missing and forbidden are not told apart.
 */
export function resolveDocumentFile(written: string, scope: DocumentScope, home: string, dataDir: string | undefined): string | null {
  if (!written || written.includes("\0") || !FILE_TYPES[extname(written).toLowerCase()]) return null;
  const candidate = isAbsolute(written) ? written : resolve(scope.baseDir, written);
  const roots = [...(scope.root ? [scope.root] : []), plansDir(home), ...(dataDir ? [dataDir] : [])];
  for (const r of roots) {
    const root = real(r);
    const file = root && realFileUnder(root, candidate);
    if (file && FILE_TYPES[extname(file).toLowerCase()] && usable(file)) return file;
  }
  const file = real(candidate);
  if (file && inScratchpad(file) && FILE_TYPES[extname(file).toLowerCase()] && usable(file)) return file;
  return null;
}
