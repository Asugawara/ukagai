import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync, type Stats } from "node:fs";
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

/** Folders of the home directory that are never read, whatever the project root (`Library` only where the system keeps secrets: iCloud Drive and CloudStorage hold projects) */
const HOME_REFUSED = [".ssh", ".aws", ".gnupg", ".kube", ".docker", ".config", ".claude", ".codex", ".ukagai", "Library/Keychains", "Library/Cookies", "Library/Application Support", "Library/Containers", "Library/Group Containers", "Library/Mail", "Library/Messages", "Library/Safari"];

/** Directory names refused anywhere in a path (`.git` also as the last segment: a worktree's `.git` is a file) */
const REFUSED_DIRS = new Set([".git", ".ssh", ".aws", ".gnupg"]);

/** Dot-segments a repository commonly references; every other segment that starts with `.` is refused */
const DOT_DIRS = new Set([".github", ".gitlab", ".circleci", ".vscode", ".devcontainer", ".husky", ".changeset", ".storybook", ".claude", ".agents", ".claude-plugin", ".cursor"]);
const ENV_EXAMPLE = [/^\.env\.(?:example|sample)$/, /^\.env\..+\.(?:example|sample)$/];
const DOT_FILES = [
  /^\.(?:gitattributes|editorconfig|nvmrc|tool-versions|gitmodules|gitlab-ci\.yml|pre-commit-config\.yaml|release-please-manifest\.json|gitleaks\.toml|rubocop\.yml)$/,
  /^\.[\w-]+ignore$/,
  /^\.[a-z0-9_]+-version$/,
  /^\.(?:eslintrc|prettierrc|babelrc|stylelintrc|markdownlint)/,
  /^\.golangci\.ya?ml$/,
  ...ENV_EXAMPLE,
];

/** Extensions of files that name a secret in their name (`secrets.py`) or sit in a folder of that name, but are source code or documents */
const SOURCE_EXT = new Set("ts tsx js jsx mjs cjs mts cts py rb go rs java kt swift php c h cpp cs scala vue svelte md mdx rst adoc txt sh".split(" "));
const extOf = (name: string): string => (name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "");
const SECRET_WORD = /credential|secret/;

/** File names (NFKC, lower case) that hold secrets. `dirs` are the folders above the name; `rel` says they are relative to the project root */
export const NAME_RULES: Array<{ why: string; test: (name: string, dirs: string[], rel: boolean) => boolean }> = [
  { why: "env file", test: (n) => (n.startsWith(".env") || n.split(".").includes("env")) && !ENV_EXAMPLE.some((re) => re.test(n)) && !/\.(?:example|sample|template)$/.test(n) && !SOURCE_EXT.has(extOf(n)) },
  { why: "dev vars", test: (n) => n === ".dev.vars" },
  { why: "ssh key", test: (n) => /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/.test(n) || (n.startsWith("id_") && (extOf(n) === "" || extOf(n) === "pub")) },
  { why: "key store", test: (n) => /\.(?:pem|key|p12|pfx|keystore|jks|kdbx)$/.test(n) },
  { why: "terraform", test: (n) => n.includes(".tfstate") || n.endsWith(".tfvars") },
  { why: "credential file", test: (n) => /^\.(?:npmrc|netrc|pypirc|pgpass|git-credentials|htpasswd|vault-token)$/.test(n) },
  { why: "kubeconfig", test: (n) => n === "kubeconfig" },
  { why: "local properties", test: (n) => n === "local.properties" },
  { why: "service account", test: (n) => /^service-account.*\.json$/.test(n) },
  { why: "named credential / secret", test: (n, dirs, rel) => (SECRET_WORD.test(n) || (rel && dirs.some((d) => SECRET_WORD.test(d)))) && !SOURCE_EXT.has(extOf(n)) && !inWorkflows(dirs) },
  { why: "local settings of the agent", test: (n, dirs) => dirs.includes(".claude") && /\.local\./.test(n) },
];

const inWorkflows = (dirs: string[]): boolean => dirs.some((d, i) => d === ".github" && dirs[i + 1] === "workflows");

const fold = (s: string): string => s.normalize("NFKC").toLowerCase();

/**
 * A path that names a secret or repository internals. `rel` says the path is relative to the project root: then every dot-segment outside the allowlist is
 * refused and the folders count for the name rules; an absolute path's upper part (`~/.herdr/worktrees/...`, `~/secrets/proj`) is none of the document's business
 */
export function isDenied(path: string, rel = true): boolean {
  const parts = fold(path).split(/[\\/]+/).filter((p) => p !== "" && p !== "." && p !== "..");
  const name = parts.pop() ?? "";
  if (parts.some((p) => REFUSED_DIRS.has(p)) || REFUSED_DIRS.has(name)) return true;
  if (rel) {
    if (parts.some((p) => p.startsWith(".") && !DOT_DIRS.has(p))) return true;
    if (name.startsWith(".") && !DOT_FILES.some((re) => re.test(name))) return true;
  }
  return NAME_RULES.some((r) => r.test(name, parts, rel));
}

// ---- Resolution ----

const realOf = (p: string): string | null => {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
};

const statOf = (p: string): Stats | null => {
  try {
    return statSync(p);
  } catch {
    return null;
  }
};

const under = (p: string, base: string): boolean => p.startsWith(base.endsWith(sep) ? base : base + sep);
const idOf = (st: Stats): string => `${st.dev}:${st.ino}`;

/** `p` and every directory above it */
function chain(p: string): string[] {
  const out = [p];
  for (let d = dirname(p); d !== out.at(-1); d = dirname(d)) out.push(d);
  return out;
}

/** What is refused or too wide, compared by identity (dev + inode) as well as by name: a path alias (macOS `/System/Volumes/Data/...`) has the same identity */
interface Area {
  home: string;
  dataDir: string | null;
  /** The home directory and every directory above it */
  wideIds: Set<string>;
  /** The data directory and the existing refused folders of the home directory */
  refusedIds: Set<string>;
}

function areaOf(env: SourceEnv): Area | null {
  const home = realOf(env.home);
  if (!home) return null;
  const dataDir = env.dataDir === undefined ? null : (realOf(env.dataDir) ?? env.dataDir);
  const ids = (paths: string[]): Set<string> => new Set(paths.map(statOf).filter((s): s is Stats => s !== null).map(idOf));
  return { home, dataDir, wideIds: ids(chain(home)), refusedIds: ids([...(dataDir === null ? [] : [dataDir]), ...HOME_REFUSED.map((d) => join(home, d))]) };
}

/** `/`, the home directory, or a directory above it: a root there would hold everything the user has */
const isWide = (p: string, area: Area): boolean => {
  const st = statOf(p);
  return p === sep || p === area.home || under(area.home, p) || (st !== null && area.wideIds.has(idOf(st)));
};

/** A place a document never reads from: the server's data directory and the home directory's own config / credential folders */
function refusedArea(real: string, area: Area): boolean {
  const low = fold(real);
  const inside = (base: string): boolean => low === fold(base) || under(low, fold(base));
  if ((area.dataDir !== null && inside(area.dataDir)) || HOME_REFUSED.some((d) => inside(join(area.home, d)))) return true;
  return chain(real).some((d) => {
    const st = statOf(d);
    return st !== null && area.refusedIds.has(idOf(st));
  });
}

/**
 * The nearest directory at or above `dir` that holds a `.git` (a directory, or the file of a worktree) owned by the server's user. Null when there is none; git is not run.
 * The walk stops at a directory that another user owns or that anyone can write to (`/tmp` is sticky: a `.git` planted there must not widen the root)
 */
function repoRoot(dir: string): string | null {
  const uid = process.getuid?.();
  for (let d = dir; ; d = dirname(d)) {
    const st = statOf(d);
    if (!st || (uid !== undefined && st.uid !== uid) || (st.mode & 0o1002) !== 0) return null;
    const git = existsSync(join(d, ".git")) ? lstatSync(join(d, ".git")) : null;
    if (git && (uid === undefined || git.uid === uid)) return d;
    if (dirname(d) === d) return null;
  }
}

/**
 * The lines of a regular text file of at most SOURCE_MAX_BYTES that is still the file `candidate` names (`real` is its real path), or null (not a regular file,
 * binary, too big, replaced, unreadable). Best effort against a swap: the file is opened without following links or waiting for a writer (a FIFO must not block
 * the server), then the path is resolved again and must give the same real path and the same device and inode as the open file. A hard link inside the root passes
 */
export function readLines(real: string, candidate: string = real, afterOpen?: () => void): string[] | null {
  const before = statOf(real);
  if (!before?.isFile()) return null;
  let fd: number | undefined;
  try {
    fd = openSync(real, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
    afterOpen?.(); // a test seam: the window in which a writer could swap the path
    const st = fstatSync(fd);
    const now = statOf(real);
    if (!st.isFile() || st.size > SOURCE_MAX_BYTES || realOf(candidate) !== real || !now || st.dev !== now.dev || st.ino !== now.ino) return null;
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
 * The root is the repository above `cwd` (the cwd itself when there is none, when the repository would be `/`, the home directory or above it, or when its
 * `.git` or a directory on the way is not the server user's own or is writable by anyone); a relative path is tried against `cwd`, then against the root.
 * The real file (symlinks resolved, on-disk spelling) must be a regular file under the root, outside the refused areas, and pass the name rules.
 * A `line` past the end of a candidate goes on to the next candidate.
 */
export function readSource(cwd: string, written: string, line: number, end: number | undefined, env: SourceEnv): SourceSnippet | null {
  if (!cwd || !isAbsolute(cwd) || !written || written.length > 1024 || written.includes("\0")) return null;
  const area = areaOf(env);
  const realCwd = realOf(cwd);
  if (!area || !realCwd || !statOf(realCwd)?.isDirectory() || isWide(realCwd, area)) return null;
  if (refusedArea(realCwd, area) || isDenied(written, !isAbsolute(written))) return null;
  let root = repoRoot(realCwd) ?? realCwd;
  if (isWide(root, area)) root = realCwd;
  const candidates = isAbsolute(written) ? [written] : [join(realCwd, written), join(root, written)];
  for (const candidate of [...new Set(candidates)]) {
    const real = realOf(candidate);
    if (!real || !under(real, root)) continue;
    const rel = relative(root, real);
    if (refusedArea(real, area) || isDenied(rel)) return null;
    const lines = readLines(real, candidate);
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
