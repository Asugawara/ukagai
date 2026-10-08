import { scanFences, scanHeadings, toLines } from "../hook/explain.js";
/** H2 sections (fences respected). The text before the first H2 is a section with heading "" (dropped when blank) */
export function splitSections(markdown) {
    const lines = markdown === "" ? [] : toLines(markdown.replace(/\r?\n$/, ""));
    const h2 = scanHeadings(lines, scanFences(lines).inFence).filter((h) => h.level === 2);
    const out = [];
    const first = h2[0]?.line ?? lines.length;
    const pre = lines.slice(0, first);
    if (pre.some((l) => l.trim() !== ""))
        out.push({ heading: "", lines: pre });
    h2.forEach((h, i) => out.push({ heading: h.title.trim(), lines: lines.slice(h.line, h2[i + 1]?.line ?? lines.length) }));
    return out;
}
const norm = (l) => l.replace(/\s+$/, "");
const body = (lines) => lines.map(norm).join("\n").replace(/\n+$/, "");
/** The largest LCS table (cells) a section pair may need; a bigger pair is reported as changed without line marks */
export const MAX_DIFF_CELLS = 4_000_000;
/** Line diff by LCS; lines are compared without trailing whitespace, the new text is kept for `same` / `add` */
export function diffLines(prev, next) {
    const a = prev.map(norm);
    const b = next.map(norm);
    const n = a.length;
    const m = b.length;
    const w = m + 1;
    const t = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--)
        for (let j = m - 1; j >= 0; j--)
            t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    const out = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j])
            out.push({ kind: "same", text: next[j] }), i++, j++;
        else if (t[(i + 1) * w + j] >= t[i * w + j + 1])
            out.push({ kind: "del", text: prev[i++] });
        else
            out.push({ kind: "add", text: next[j++] });
    }
    while (i < n)
        out.push({ kind: "del", text: prev[i++] });
    while (j < m)
        out.push({ kind: "add", text: next[j++] });
    return out;
}
/** Section-level diff of two plans, in the order of `next` (removed sections last) */
export function diffPlans(prev, next) {
    const old = splitSections(prev);
    const taken = new Set();
    const sections = [];
    for (const s of splitSections(next)) {
        const at = old.findIndex((o, i) => !taken.has(i) && o.heading === s.heading);
        if (at < 0) {
            sections.push({ heading: s.heading, status: "added", new_lines: s.lines });
            continue;
        }
        taken.add(at);
        const o = old[at];
        if (body(o.lines) === body(s.lines))
            sections.push({ heading: s.heading, status: "same" });
        else if ((o.lines.length + 1) * (s.lines.length + 1) > MAX_DIFF_CELLS)
            sections.push({ heading: s.heading, status: "changed" });
        else
            sections.push({ heading: s.heading, status: "changed", lines: diffLines(o.lines, s.lines) });
    }
    old.forEach((o, i) => {
        if (!taken.has(i))
            sections.push({ heading: o.heading, status: "removed", old_lines: o.lines });
    });
    const count = (st) => sections.filter((s) => s.status === st).length;
    return { sections, summary: { added: count("added"), changed: count("changed"), removed: count("removed"), same: count("same") } };
}
//# sourceMappingURL=plan-diff.js.map