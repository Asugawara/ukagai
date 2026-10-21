import { closeSync, constants, existsSync, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { realFileUnder } from "../contract.js";

// The source snippet behind a `path:line` reference in a document (GET /api/source, docs/spec/api.md). Every doubt is a null (the route answers 404).

/** Largest file that is read */
export const SOURCE_MAX_BYTES = 2 * 1024 * 1024;
/** A longer line is cut here */
export const SOURCE_LINE_MAX = 400;
/** Lines around a single `line`, and the most lines of a `line`-`end` range */
const CONTEXT = 5;
const RANGE_MAX = 40;
const BINARY_PROBE = 8192;

const DENY_DIRS = new Set([".git", ".ssh", ".aws", ".gnupg"]);
const DENY_FILES = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|\.pgpass|\.git-credentials|id_rsa.*|id_ed25519.*|.*\.(?:pem|key|p12|pfx))$/;
const DENY_EXAMPLE = /^\.env\..*\.(?:example|sample)$|^\.env\.(?:example|sample)$/;

/** A path that names a secret or repository internals: any directory in the list, or a credential file name (case-insensitive: macOS volumes are) */
export function isDenied(path: string): boolean {
  const parts = path.split(/[\\/]+/).filter(Boolean).map((p) => p.toLowerCase());
  const name = parts.pop() ?? "";
  if (parts.some((p) => DENY_DIRS.has(p)) || DENY_DIRS.has(name)) return true;
  return DENY_FILES.test(name) && !DENY_EXAMPLE.test(name);
}

export interface SourceSnippet {
  /** Relative to the root the file was found under, `/`-separated */
  path: string;
  /** First and last line shown (1-based) */
  start: number;
  end: number;
  /** The referenced lines (inside start..end) */
  hit: [number, number];
  /** Lines in the file */
  total: number;
  lines: string[];
}

/** The nearest directory at or above `dir` that holds a `.git` (a directory, or the file of a worktree). Null when there is none; git is not run */
function repoRoot(dir: string): string | null {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return d;
    if (dirname(d) === d) return null;
  }
}

/** The lines of a regular text file of at most SOURCE_MAX_BYTES, or null (binary, too big, unreadable) */
function readLines(file: string): string[] | null {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > SOURCE_MAX_BYTES) return null;
    const buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < st.size) {
      const n = readSync(fd, buf, got, st.size - got, got);
      if (n === 0) break;
      got += n;
    }
    const body = buf.subarray(0, got);
    if (body.subarray(0, BINARY_PROBE).includes(0)) return null;
    const lines = body.toString("utf8").split(/\r\n|\r|\n/);
    if (lines.at(-1) === "") lines.pop();
    return lines;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Read `line` (or `line`-`end`) of `written` as a document of a session in `cwd` names it.
 * A relative path is tried against `cwd`, then against the repository root above it; the real file (symlinks resolved) must be a regular file under that root.
 */
export function readSource(cwd: string, written: string, line: number, end?: number): SourceSnippet | null {
  if (!cwd || !isAbsolute(cwd) || !written || written.length > 1024 || written.includes("\0") || isDenied(written)) return null;
  let realCwd: string;
  try {
    realCwd = realpathSync(cwd);
    if (!statSync(realCwd).isDirectory()) return null;
  } catch {
    return null;
  }
  const root = repoRoot(realCwd) ?? realCwd;
  const candidates = isAbsolute(written) ? [written] : [join(realCwd, written), join(root, written)];
  for (const candidate of candidates) {
    const real = realFileUnder(root, candidate);
    if (!real) continue;
    const rel = relative(root, real);
    if (isDenied(rel)) return null;
    const lines = readLines(real);
    if (!lines || line < 1 || line > lines.length) return null;
    const last = end === undefined ? line : Math.min(end, line + RANGE_MAX - 1, lines.length);
    const hit: [number, number] = [line, last];
    const start = end === undefined ? Math.max(1, line - CONTEXT) : line;
    const stop = end === undefined ? Math.min(lines.length, line + CONTEXT) : last;
    return {
      path: rel.split(sep).join("/"),
      start,
      end: stop,
      hit,
      total: lines.length,
      lines: lines.slice(start - 1, stop).map((l) => (l.length > SOURCE_LINE_MAX ? l.slice(0, SOURCE_LINE_MAX) + "…" : l)),
    };
  }
  return null;
}
