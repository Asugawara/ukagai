import { readFileSync, realpathSync, statSync } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { isPlanFile, plansDir, stripExplainBlocks } from "../contract.js";
import { scanFences, scanHeadings, toLines } from "../hook/explain.js";
export const MAX_PLANS = 50;
export const MAX_PLAN_BYTES = 1024 * 1024;
export class PlanError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}
/** Title (first H1 outside code fences), H2 count and line count of a plan (explain blocks already stripped) */
function scan(markdown) {
    const lines = markdown === "" ? [] : toLines(markdown.replace(/\r?\n$/, ""));
    const headings = scanHeadings(lines, scanFences(lines).inFence);
    return {
        title: headings.find((h) => h.level === 1)?.title.trim(),
        sections: headings.filter((h) => h.level === 2).length,
        lines: lines.length,
    };
}
async function realRoot(dir) {
    try {
        return await realpath(dir);
    }
    catch {
        return null;
    }
}
/** A plan file under the real plans directory `root`: a regular file whose realpath stays inside it. Null otherwise */
async function resolveIn(root, name, symlink) {
    try {
        // Only a symlink can leave the directory; a plain entry is already `root/name`
        const path = symlink ? await realpath(join(root, name)) : join(root, name);
        if (symlink && !path.startsWith(root + sep))
            return null;
        const st = await stat(path);
        return st.isFile() ? { path, size: st.size, mtimeMs: st.mtimeMs } : null;
    }
    catch {
        return null;
    }
}
/** Every listable plan file (same filters as the list, no cap) */
async function resolveAll(dir) {
    const root = await realRoot(dir);
    if (!root)
        return [];
    let entries;
    try {
        entries = await readdir(root, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const found = await Promise.all(entries
        .filter((e) => isPlanFile(e.name) && (e.isFile() || e.isSymbolicLink()))
        .map(async (e) => ({ name: e.name, r: await resolveIn(root, e.name, e.isSymbolicLink()) })));
    return found.filter((x) => x.r !== null);
}
async function resolvePlan(dir, name) {
    const root = await realRoot(dir);
    return root ? resolveIn(root, name, true) : null;
}
/** The body lines of the H2 section titled `name` (trimmed, case-insensitive), or null */
function h2Body(lines, headings, name) {
    const i = headings.findIndex((h) => h.level === 2 && h.title.trim().toLowerCase() === name);
    if (i < 0)
        return null;
    const next = headings.slice(i + 1).find((h) => h.level <= 2);
    return lines.slice(headings[i].line + 1, next ? next.line : lines.length);
}
/**
 * Whether a plan has the sections ukagai's plan-context text asks for: `Steps` with a list item and `Verification` with a task item
 * (headings trimmed, case-insensitive). Required of a session only when ukagai handed it that text (see PlanReady)
 */
export function hasFormat(md) {
    const lines = md === "" ? [] : toLines(md.replace(/\r?\n$/, ""));
    const headings = scanHeadings(lines, scanFences(lines).inFence);
    if (!h2Body(lines, headings, "steps")?.some((l) => /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(l)))
        return false;
    return h2Body(lines, headings, "verification")?.some((l) => /^\s*[-*+]\s+\[[ xX]\]\s*\S/.test(l)) ?? false;
}
function buildSummary(name, size, mtimeMs, md, isRead) {
    const s = scan(md);
    const mtime = new Date(mtimeMs).toISOString();
    return { name, title: s.title ?? name, mtime, bytes: size, sections: s.sections, lines: s.lines, read: isRead(name, mtime), format_ok: hasFormat(md), ready: false };
}
async function summarize(name, r, isRead) {
    let md = "";
    if (r.size <= MAX_PLAN_BYTES) {
        try {
            md = stripExplainBlocks(await readFile(r.path, "utf8"));
        }
        catch { }
    }
    return buildSummary(name, r.size, r.mtimeMs, md, isRead);
}
/** The summary of a plan file known to sit directly in the plans dir (a name from `planNameOfPath`), read synchronously. Null if it is gone */
export function planSummarySync(dir, name, isRead = () => false) {
    try {
        const path = join(dir, name);
        const st = statSync(path);
        if (!st.isFile())
            return null;
        const md = st.size <= MAX_PLAN_BYTES ? stripExplainBlocks(readFileSync(path, "utf8")) : "";
        return buildSummary(name, st.size, st.mtimeMs, md, isRead);
    }
    catch {
        return null;
    }
}
/** One plan's summary through the same filters as the list (`*.md`, no dotfile, realpath inside the dir). Null if it does not pass. Oversize files are summarized without reading, as in the list */
export async function planSummary(dir, name, isRead = () => false) {
    if (!isPlanFile(name))
        return null;
    const r = await resolvePlan(dir, name);
    return r ? summarize(name, r, isRead) : null;
}
export async function listPlans(home, isRead = () => false) {
    const found = (await resolveAll(plansDir(home)))
        .sort((a, b) => b.r.mtimeMs - a.r.mtimeMs || (a.name < b.name ? -1 : 1))
        .slice(0, MAX_PLANS);
    return Promise.all(found.map(({ name, r }) => summarize(name, r, isRead)));
}
/** Throws PlanError when the plan cannot be served */
export async function readPlan(home, name, isRead = () => false) {
    if (!isPlanFile(name))
        throw new PlanError(400, "invalid plan name");
    const r = await resolvePlan(plansDir(home), name);
    if (!r)
        throw new PlanError(404, "plan not found");
    if (r.size > MAX_PLAN_BYTES)
        throw new PlanError(413, "plan too large");
    // The explanation blocks written for AskUserQuestion are shown on the question screen, not in the plan
    const markdown = stripExplainBlocks(await readFile(r.path, "utf8"));
    const mtime = new Date(r.mtimeMs).toISOString();
    return { name, title: scan(markdown).title ?? name, mtime, markdown, read: isRead(name, mtime), format_ok: hasFormat(markdown), ready: false };
}
/** name -> "mtimeMs:size" of every listable plan file (same filters as the list, no cap), for change detection */
export async function plansFingerprint(dir) {
    return new Map((await resolveAll(dir)).map(({ name, r }) => [name, `${r.mtimeMs}:${r.size}`]));
}
/** The fingerprint of one file, or null if it is not a listable plan */
export async function planFingerprint(dir, name) {
    if (!isPlanFile(name))
        return null;
    const r = await resolvePlan(dir, name);
    return r ? `${r.mtimeMs}:${r.size}` : null;
}
/** The plan name a file path points at, if its realpath is a plan file directly inside the plans dir; null otherwise (missing, outside, subdirectory) */
export function planNameOfPath(dir, filePath) {
    try {
        const root = realpathSync(dir);
        const real = realpathSync(filePath);
        if (dirname(real) !== root)
            return null;
        const name = basename(real);
        return isPlanFile(name) ? name : null;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=plans.js.map