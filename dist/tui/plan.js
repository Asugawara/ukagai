import { createHash } from "node:crypto";
import { SECTION, normalizeHeading, scanFences, scanHeadings, toLines } from "../hook/explain.js";
// The outline of a long plan: its ## / ### sections, with line and file counts. No I/O.
// The same rules as planOutlineOf in public/app.js (test/gui/plan.test.ts and test/tui/plan.test.ts pin the same numbers on one fixture).
export const PLAN_SHORT_H2 = 2;
export const PLAN_SHORT_LINES = 40;
const PATH_LINE_SUFFIX = /:\d+(?:[-:]\d+)?$/;
const PATH_SHAPE = /^(?:~\/|\.{1,2}\/|\/)?(?:[\w@.+-]+\/)*[\w@.+-]+$/;
/** A backticked token that names a file: it has a `/`, or ends in a short extension; `:12` line suffixes are ignored. null otherwise */
export function pathOf(code) {
    const s = code.trim().replace(PATH_LINE_SUFFIX, "");
    if (!PATH_SHAPE.test(s))
        return null;
    return s.includes("/") || /\.[a-z][a-z0-9]{0,5}$/i.test(s) ? s : null;
}
const plainMd = (s) => s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/^[ \t]*#+[ \t]*/, "").replace(/[`*]/g, "").replace(/\s+/g, " ").trim();
const IMPACT = SECTION.impact.map(normalizeHeading);
const isImpactTitle = (title) => IMPACT.some((n) => normalizeHeading(plainMd(title)).includes(n));
export function planOutline(md) {
    const lines = toLines(md);
    while (lines.length > 1 && lines[lines.length - 1] === "")
        lines.pop();
    const { inFence } = scanFences(lines);
    const marks = scanHeadings(lines, inFence).filter((h) => h.level <= 3);
    const filesIn = (from, to) => {
        const out = new Set();
        for (let i = from; i < to; i++) {
            if (inFence[i])
                continue;
            for (const c of lines[i].matchAll(/`([^`\n]+)`/g)) {
                const p = pathOf(c[1]);
                if (p)
                    out.add(p);
            }
        }
        return out;
    };
    const entries = [];
    marks.forEach((m, k) => {
        if (m.level === 1)
            return;
        const end = marks.slice(k + 1).find((n) => n.level <= m.level)?.line ?? lines.length;
        const hash = createHash("sha256").update(lines.slice(m.line, end).join("\n")).digest("hex").slice(0, 12);
        entries.push({ i: entries.length, level: m.level, title: m.title, plain: plainMd(m.title), at: m.line, lines: end - m.line, files: filesIn(m.line, end), hash, scope: isImpactTitle(m.title) });
    });
    const h2 = entries.filter((e) => e.level === 2).length;
    return { lines: lines.length, entries, h2, files: filesIn(0, lines.length).size, long: h2 > PLAN_SHORT_H2 && lines.length > PLAN_SHORT_LINES };
}
/** The first H2 is open and counts as read; the scope section is on screen in the decision column, so it counts as read too */
export function initialPlanState(o) {
    const first = o.entries.find((e) => e.level === 2);
    return { open: new Set(first ? [first.i] : []), read: new Set([...(first ? [first.i] : []), ...o.entries.filter((e) => e.scope).map((e) => e.i)]), updated: new Set(), cur: first?.i ?? 0, zone: "plan" };
}
/** `level:title` per outline entry: how a changed section is matched with its earlier self */
export const headings = (o) => o.entries.map((e) => `${e.level}:${e.title}`);
/**
 * The state of a plan whose text changed (a live update, or a plan file turning into its approval screen): a section whose hash is unchanged keeps
 * its open / read state; a changed one keeps its open state but turns unread and `updated`, a new one is folded, unread and `updated`; removed ones are gone. The contents cursor follows its section.
 */
export function remapState(o, prev) {
    const used = new Set();
    const heads = headings(o);
    const prevHeads = headings(prev.outline);
    const prevHashes = prev.outline.entries.map((e) => e.hash);
    const hashes = o.entries.map((e) => e.hash);
    const st = { open: new Set(), read: new Set(), updated: new Set(), cur: 0, zone: prev.st.zone };
    let cur = null;
    o.entries.forEach((e, j) => {
        const i = prevHashes.findIndex((h, k) => h === hashes[j] && !used.has(k));
        if (i < 0) {
            // A changed section keeps its open / folded state (matched by level and heading); a new one arrives folded
            const m = prevHeads.findIndex((h, k) => h === heads[j] && !used.has(k) && !hashes.includes(prevHashes[k]));
            if (m >= 0) {
                used.add(m);
                if (prev.st.open.has(m))
                    st.open.add(j);
                if (prev.st.cur === m)
                    cur = j;
            }
            if (e.scope)
                st.read.add(j);
            else
                st.updated.add(j);
            return;
        }
        used.add(i);
        if (prev.st.open.has(i))
            st.open.add(j);
        if (prev.st.read.has(i) || e.scope)
            st.read.add(j);
        if (prev.st.updated.has(i))
            st.updated.add(j);
        if (prev.st.cur === i)
            cur = j;
    });
    st.cur = cur ?? Math.max(0, Math.min(prev.st.cur, o.entries.length - 1));
    return st;
}
/** The H2 sections never opened (the scope section excluded), in order */
export const unreadSections = (o, st) => o.entries.filter((e) => e.level === 2 && !st.read.has(e.i));
export const parentOf = (o, e) => (e.level === 3 ? [...o.entries].reverse().find((x) => x.level === 2 && x.at < e.at) : undefined);
/** Open a section (and its H2), marking both read; or close it */
export function setOpen(o, st, i, open) {
    const e = o.entries[i];
    if (!e)
        return;
    if (open) {
        st.open.add(i);
        st.read.add(i);
        st.updated.delete(i);
        const p = parentOf(o, e);
        if (p) {
            st.open.add(p.i);
            st.read.add(p.i);
            st.updated.delete(p.i);
        }
    }
    else
        st.open.delete(i);
}
/** `o`: open everything, or close everything when everything is already open */
export function toggleAll(o, st) {
    if (o.entries.every((e) => st.open.has(e.i)))
        st.open.clear();
    else
        for (const e of o.entries)
            setOpen(o, st, e.i, true);
}
/** `Unread sections (3): a, b, c` text for the confirmation (at most 5 names) */
export function unreadNames(un) {
    return un.slice(0, 5).map((e) => e.plain).join(", ") + (un.length > 5 ? ` +${un.length - 5}` : "");
}
//# sourceMappingURL=plan.js.map