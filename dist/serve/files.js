import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, resolve, sep } from "node:path";
import { PLAN_BLOCK_SUFFIX, plansDir, realFileUnder } from "../contract.js";
import { FRAME_HELPER } from "./frame-helper.js";
/** Largest document image that is served */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Largest HTML page that is served (it is read into memory to rewrite its relative URLs) */
export const MAX_HTML_BYTES = 2 * 1024 * 1024;
export const FILE_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
};
export const isHtmlFile = (f) => FILE_TYPES[extname(f).toLowerCase()]?.startsWith("text/html") ?? false;
/**
 * The policy of the embedded view. The GUI puts exactly this string in the iframe's `csp` attribute (CSP Embedded Enforcement, Chromium): every document the frame loads,
 * also after the page navigated it, must opt in to a policy at least this strict or is refused, so nothing but ukagai's own frame helper (by hash: the page's <script>,
 * on*= attributes and javascript: URLs stay blocked) can run in it. No network (only same-origin / data: images and fonts, inline styles).
 */
export const FRAME_POLICY = `default-src 'none'; script-src 'sha256-${createHash("sha256").update(FRAME_HELPER).digest("base64")}'; img-src 'self' data:; style-src 'unsafe-inline'; font-src 'self' data:; base-uri 'none'`;
/** Sent with the page in the embedded view: a sandbox with allow-scripts (opaque origin, no popups, no forms, no top navigation) plus FRAME_POLICY (which also opts in to the frame's required CSP) */
export const FRAME_CSP = `sandbox allow-scripts; ${FRAME_POLICY}`;
/** Sent with the page opened on its own ("Open in new tab"): a top-level tab has no embedder to enforce anything, so it never runs a script */
export const TAB_CSP = "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src 'self' data:; base-uri 'none'";
// A Claude Code scratchpad below an OS temp dir: <tmp>/claude-<uid>/<project>/<session>/scratchpad/
const SCRATCHPAD = /^claude-[^/]+\/(?:[^/]+\/)*scratchpad\//;
const usable = (f) => {
    try {
        const st = statSync(f);
        return st.isFile() && st.size <= (isHtmlFile(f) ? MAX_HTML_BYTES : MAX_FILE_BYTES);
    }
    catch {
        return false;
    }
};
const real = (p) => {
    try {
        return realpathSync(p);
    }
    catch {
        return null;
    }
};
/** The directory a document's relative image paths resolve against: an explanation file (without the plan block suffix) or a plan file */
export function documentDir(docPath) {
    return dirname(docPath.endsWith(PLAN_BLOCK_SUFFIX) ? docPath.slice(0, -PLAN_BLOCK_SUFFIX.length) : docPath);
}
function inScratchpad(file) {
    for (const t of new Set(["/private/tmp", "/tmp", tmpdir()])) {
        const root = real(t);
        if (root && file.startsWith(root + sep) && SCRATCHPAD.test(file.slice(root.length + 1)))
            return true;
    }
    return false;
}
/**
 * The real path of the image `written` (as in the Markdown) for a document, or null when it must not be served:
 * not a regular file, wrong extension, too big, or outside the document's own root / plans dir / a Claude Code scratchpad / the data dir.
 * Missing and forbidden are not told apart.
 */
export function resolveDocumentFile(written, scope, home, dataDir) {
    if (!written || written.includes("\0") || !FILE_TYPES[extname(written).toLowerCase()])
        return null;
    const candidates = isAbsolute(written) ? [written] : [resolve(scope.baseDir, written), ...(scope.fallbackDirs ?? []).map((d) => resolve(d, written))];
    const roots = [...(scope.root ? [scope.root] : []), plansDir(home), ...(dataDir ? [dataDir] : [])];
    for (const candidate of candidates) {
        for (const r of roots) {
            const root = real(r);
            const file = root && realFileUnder(root, candidate);
            if (file && FILE_TYPES[extname(file).toLowerCase()] && usable(file))
                return file;
        }
        const file = real(candidate);
        if (file && inScratchpad(file) && FILE_TYPES[extname(file).toLowerCase()] && usable(file))
            return file;
    }
    return null;
}
// A sandboxed frame has an opaque origin, so the SameSite=Strict session cookie is not sent for the page's own images. Each rewritten URL therefore carries
// a tag (HMAC of "<who>|<path>" with a per-process secret) that authorises exactly that one file of that one document, in place of the cookie
const TAG_SECRET = randomBytes(32);
export const fileTag = (who, path) => createHmac("sha256", TAG_SECRET).update(`${who}|${path}`).digest("base64url").slice(0, 32);
export function validFileTag(who, path, tag) {
    if (!tag)
        return false;
    const a = Buffer.from(fileTag(who, path));
    const b = Buffer.from(tag);
    return a.length === b.length && timingSafeEqual(a, b);
}
// A relative reference is neither absolute (/x, //x), a fragment (#x), nor has a scheme (data:, http:, mailto:, ...)
const isRelative = (u) => u !== "" && !/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(u);
/**
 * The page's relative local references (`src=`, `href=`, `url(...)`) pointed at /api/files, so they keep working although the page itself is served from there.
 * `who` is the `decision=<id>` / `plan=<name>` query part (already encoded); `dir` the real directory of the page; `tab` the new-tab view (its links stay in that view). Scripts are left alone: the CSP stops them (only the injected frame helper runs).
 * Defence in depth, as the CSP and the frame's `csp` attribute are the real boundary: `http-equiv` (meta refresh / meta CSP), declarative shadow roots (the frame helper cannot see into a closed one)
 * and every `<link>` (`rel=prerender` / `preconnect` reach the network although `default-src 'none'`) are renamed to something inert. Following a link still sends that one request, as without ukagai.
 */
export function rewriteHtml(html, dir, who, tab = false) {
    const target = (rel, amp) => {
        let written = rel.replace(/&amp;/g, "&");
        const cut = written.search(/[?#]/);
        if (cut >= 0)
            written = written.slice(0, cut);
        try {
            written = decodeURIComponent(written);
        }
        catch { /* keep as written */ }
        const abs = resolve(dir, written);
        return `/api/files?${who}${amp}path=${encodeURIComponent(abs)}${amp}tag=${fileTag(who, abs)}${tab ? `${amp}view=tab` : ""}`; // view=tab keeps a followed link in the script-free new-tab view; it is not part of the tag
    };
    return html
        .replace(/http-equiv/gi, "data-ukagai-http-equiv") // no meta refresh (it would navigate the frame away), no meta CSP games
        .replace(/shadowroot/gi, "data-ukagai-shadowroot") // no declarative shadow DOM (shadowrootmode, shadowrootdelegatesfocus, ...)
        .replace(/<link\b/gi, "<ukagai-link") // no <link rel=prerender|preconnect|...: they ignore the CSP
        .replace(/(\s(?:src|href))=("([^"]*)"|'([^']*)')/gi, (m, name, q, d, sg) => {
        const u = (d ?? sg ?? "").trim();
        return isRelative(u) ? `${name}="${target(u, "&amp;")}"` : m;
    })
        .replace(/url\(\s*(["']?)([^"')]*)\1\s*\)/gi, (m, _q, u) => (isRelative(u.trim()) ? `url("${target(u.trim(), "&")}")` : m));
}
//# sourceMappingURL=files.js.map