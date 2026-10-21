import { closeSync, constants, existsSync, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

// The source snippet behind a `path:line` reference in a document (GET /api/source, docs/spec/api.md). Every doubt is a null (the route answers 404).

/** Largest file that is read */
export const SOURCE_MAX_BYTES = 2 * 1024 * 1024;
/** A longer line is cut here */
export const SOURCE_LINE_MAX = 400;
/** Lines around a single `line`, and the most lines of a `line`-`end` range */
const CONTEXT = 5;
const RANGE_MAX = 40;
const BINARY_PROBE = 8192;

/** What the server knows that a document must never reach: the user's home and the server's own data directory */
export interface SourceEnv {
  home: string;
  dataDir?: string;
}

// ---- Refusal rules ----

/** Directories of the home directory that are never read, whatever the project root */
const HOME_REFUSED = [".ssh", ".aws", ".gnupg", ".kube", ".docker", ".config", ".claude", ".codex", ".ukagai", "Library"];

/** Directory names refused anywhere in a path (`.git` also as the last segment: a worktree's `.git` is a file) */
const REFUSED_DIRS = new Set([".git", ".ssh", ".aws", ".gnupg"]);

/** Dot-segments a repository commonly references; every other segment that starts with `.` is refused */
const DOT_DIRS = new Set([".github", ".gitlab", ".circleci", ".vscode", ".devcontainer", ".husky", ".changeset", ".storybook", ".claude"]);
const DOT_FILES = [/^\.(?:gitignore|gitattributes|editorconfig|nvmrc|node-version|tool-versions)$/, /^\.(?:eslintrc|prettierrc)/, /^\.env\.(?:example|sample)$/, /^\.env\..+\.(?:example|sample)$/];

/** Extensions of files that name a secret in their name (`secrets.py`) but are source code or documents */
const SOURCE_EXT = new Set("ts tsx js jsx mjs cjs py rb go rs java kt swift php c h cpp cs scala vue svelte md".split(" "));
const extOf = (name: string): string => (name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "");

/** File names (NFKC, lower case) that hold secrets */
export const NAME_RULES: Array<{ why: string; test: (name: string) => boolean }> = [
  { why: "env file", test: (n) => (n.startsWith(".env") || n.endsWith(".env")) && !DOT_FILES.slice(2).some((re) => re.test(n)) },
  { why: "dev vars", test: (n) => n === ".dev.vars" },
  { why: "ssh key", test: (n) => n.startsWith("id_") },
  { why: "key store", test: (n) => /\.(?:pem|key|p12|pfx|keystore|jks|kdbx)$/.test(n) },
  { why: "terraform", test: (n) => n.includes(".tfstate") || n.endsWith(".tfvars") },
  { why: "credential file", test: (n) => /^\.(?:npmrc|netrc|pypirc|pgpass|git-credentials|htpasswd|vault-token)$/.test(n) },
  { why: "kubeconfig", test: (n) => n === "kubeconfig" },
  { why: "local properties", test: (n) => n === "local.properties" },
  { why: "service account", test: (n) => /^service-account.*\.json$/.test(n) },
  { why: "named credential / secret", test: (n) => /credential|secret/.test(n) && !SOURCE_EXT.has(extOf(n)) },
];

const fold = (s: string): string => s.normalize("NFKC").toLowerCase();

/**
 * A path that names a secret or repository internals. `dotRule` also refuses every dot-segment outside the allowlist: pass it for a path relative to the
 * project root, not for an absolute path whose upper part (`~/.herdr/worktrees/...`) is none of the document's business
 */
export function isDenied(path: string, dotRule = true): boolean {
  const parts = fold(path).split(/[\\/]+/).filter((p) => p !== "" && p !== "." && p !== "..");
  const name = parts.pop() ?? "";
  if (parts.some((p) => REFUSED_DIRS.has(p)) || REFUSED_DIRS.has(name)) return true;
  if (dotRule) {
    if (parts.some((p) => p.startsWith(".") && !DOT_DIRS.has(p))) return true;
    if (name.startsWith(".") && !DOT_FILES.some((re) => re.test(name))) return true;
  }
  return NAME_RULES.some((r) => r.test(name));
}

// ---- Resolution ----

const realOf = (p: string): string | null => {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
};

const under = (p: string, base: string): boolean => p.startsWith(base.endsWith(sep) ? base : base + sep);

/** `/`, the home directory, or a directory above it: a root there would hold everything the user has */
const isWide = (p: string, home: string): boolean => p === sep || p === home || under(home, p);

/** A place a document never reads from: the server's data directory and the home directory's own config / credential folders */
function refusedArea(real: string, env: { home: string; dataDir: string | null }): boolean {
  const low = fold(real);
  const inside = (base: string): boolean => low === fold(base) || under(low, fold(base));
  return (env.dataDir !== null && inside(env.dataDir)) || HOME_REFUSED.some((d) => inside(join(env.home, d)));
}

/** The nearest directory at or above `dir` that holds a `.git` (a directory, or the file of a worktree). Null when there is none; git is not run */
function repoRoot(dir: string): string | null {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return d;
    if (dirname(d) === d) return null;
  }
}

/** The lines of a regular text file of at most SOURCE_MAX_BYTES that is still the file at `real`, or null (binary, too big, replaced, unreadable) */
function readLines(real: string): string[] | null {
  let fd: number | undefined;
  try {
    fd = openSync(real, constants.O_RDONLY);
    const st = fstatSync(fd);
    const now = statSync(real);
    if (!st.isFile() || st.size > SOURCE_MAX_BYTES || st.dev !== now.dev || st.ino !== now.ino) return null;
    const buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < st.size) {
      const n = readSync(fd, buf, got, st.size - got, got);
      if (n === 0) break;
      got += n;
    }
    const body = buf.subarray(0, got);
    if (body.subarray(0, BINARY_PROBE).includes(0)) return null;
    const lines = body.toString("utf8").split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
    if (lines.at(-1) === "") lines.pop();
    return lines;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
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

/**
 * Read `line` (or `line`-`end`) of `written` as a document of a session in `cwd` names it.
 * The root is the repository above `cwd` (the cwd itself when there is none, or when the repository would be `/` or the home directory or above it);
 * a relative path is tried against `cwd`, then against the root. The real file (symlinks resolved, on-disk spelling) must be a regular file under the root,
 * outside the refused areas, and pass the name rules. A `line` past the end of a candidate goes on to the next candidate.
 */
export function readSource(cwd: string, written: string, line: number, end: number | undefined, env: SourceEnv): SourceSnippet | null {
  if (!cwd || !isAbsolute(cwd) || !written || written.length > 1024 || written.includes("\0")) return null;
  const home = realOf(env.home);
  const realCwd = realOf(cwd);
  if (!home || !realCwd || !statSync(realCwd).isDirectory() || isWide(realCwd, home)) return null;
  const area = { home, dataDir: env.dataDir === undefined ? null : (realOf(env.dataDir) ?? env.dataDir) };
  if (refusedArea(realCwd, area) || isDenied(written, !isAbsolute(written))) return null;
  let root = repoRoot(realCwd) ?? realCwd;
  if (isWide(root, home)) root = realCwd;
  const candidates = isAbsolute(written) ? [written] : [join(realCwd, written), join(root, written)];
  for (const candidate of [...new Set(candidates)]) {
    const real = realOf(candidate);
    if (!real || !under(real, root)) continue;
    const rel = relative(root, real);
    if (refusedArea(real, area) || isDenied(rel)) return null;
    const lines = readLines(real);
    if (!lines) return null;
    if (line < 1 || line > lines.length) continue;
    const last = end === undefined ? line : Math.min(end, line + RANGE_MAX - 1, lines.length);
    const start = end === undefined ? Math.max(1, line - CONTEXT) : line;
    const stop = end === undefined ? Math.min(lines.length, line + CONTEXT) : last;
    return {
      path: rel.split(sep).join("/"),
      start,
      end: stop,
      hit: [line, last],
      total: lines.length,
      lines: lines.slice(start - 1, stop).map((l) => (l.length > SOURCE_LINE_MAX ? l.slice(0, SOURCE_LINE_MAX) + "…" : l)),
    };
  }
  return null;
}
