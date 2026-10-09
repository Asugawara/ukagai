import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, resolve, sep } from "node:path";
import { PLAN_BLOCK_SUFFIX, plansDir, realFileUnder } from "../contract.js";

/** Largest document image that is served */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Largest HTML page that is served (it is read into memory to rewrite its relative URLs) */
export const MAX_HTML_BYTES = 2 * 1024 * 1024;

export const FILE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
};

export const isHtmlFile = (f: string): boolean => FILE_TYPES[extname(f).toLowerCase()]?.startsWith("text/html") ?? false;

/** Sent with every served HTML page: no script, no network, no navigation; only same-origin / data: images and fonts and inline styles */
export const HTML_CSP = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src 'self' data:";

// A Claude Code scratchpad below an OS temp dir: <tmp>/claude-<uid>/<project>/<session>/scratchpad/
const SCRATCHPAD = /^claude-[^/]+\/(?:[^/]+\/)*scratchpad\//;

const usable = (f: string): boolean => {
  try {
    const st = statSync(f);
    return st.isFile() && st.size <= (isHtmlFile(f) ? MAX_HTML_BYTES : MAX_FILE_BYTES);
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
export type DocumentScope = {
  baseDir: string;
  root?: string;
  /** Tried in order when a relative path is not found against `baseDir`: for a plan document, the decision session's `<scratchpad_dir>/ukagai`. No root or scratchpad check is relaxed */
  fallbackDirs?: string[];
};

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
  const candidates = isAbsolute(written) ? [written] : [resolve(scope.baseDir, written), ...(scope.fallbackDirs ?? []).map((d) => resolve(d, written))];
  const roots = [...(scope.root ? [scope.root] : []), plansDir(home), ...(dataDir ? [dataDir] : [])];
  for (const candidate of candidates) {
    for (const r of roots) {
      const root = real(r);
      const file = root && realFileUnder(root, candidate);
      if (file && FILE_TYPES[extname(file).toLowerCase()] && usable(file)) return file;
    }
    const file = real(candidate);
    if (file && inScratchpad(file) && FILE_TYPES[extname(file).toLowerCase()] && usable(file)) return file;
  }
  return null;
}

// A sandboxed frame has an opaque origin, so the SameSite=Strict session cookie is not sent for the page's own images. Each rewritten URL therefore carries
// a tag (HMAC of "<who>|<path>" with a per-process secret) that authorises exactly that one file of that one document, in place of the cookie
const TAG_SECRET = randomBytes(32);
export const fileTag = (who: string, path: string): string => createHmac("sha256", TAG_SECRET).update(`${who}|${path}`).digest("base64url").slice(0, 32);
export function validFileTag(who: string, path: string, tag: string | undefined): boolean {
  if (!tag) return false;
  const a = Buffer.from(fileTag(who, path));
  const b = Buffer.from(tag);
  return a.length === b.length && timingSafeEqual(a, b);
}

// A relative reference is neither absolute (/x, //x), a fragment (#x), nor has a scheme (data:, http:, mailto:, ...)
const isRelative = (u: string): boolean => u !== "" && !/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(u);

/**
 * The page's relative local references (`src=`, `href=`, `url(...)`) pointed at /api/files, so they keep working although the page itself is served from there.
 * `who` is the `decision=<id>` / `plan=<name>` query part (already encoded); `dir` the real directory of the page. Scripts are left alone: the CSP sandbox stops them.
 */
export function rewriteHtml(html: string, dir: string, who: string): string {
  const target = (rel: string, amp: string): string => {
    let written = rel.replace(/&amp;/g, "&");
    const cut = written.search(/[?#]/);
    if (cut >= 0) written = written.slice(0, cut);
    try { written = decodeURIComponent(written); } catch { /* keep as written */ }
    const abs = resolve(dir, written);
    return `/api/files?${who}${amp}path=${encodeURIComponent(abs)}${amp}tag=${fileTag(who, abs)}`;
  };
  return html
    .replace(/(\s(?:src|href))=("([^"]*)"|'([^']*)')/gi, (m, name: string, q: string, d?: string, sg?: string) => {
      const u = (d ?? sg ?? "").trim();
      return isRelative(u) ? `${name}="${target(u, "&amp;")}"` : m;
    })
    .replace(/url\(\s*(["']?)([^"')]*)\1\s*\)/gi, (m, _q: string, u: string) => (isRelative(u.trim()) ? `url("${target(u.trim(), "&")}")` : m));
}
