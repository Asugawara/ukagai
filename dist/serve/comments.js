import { INSTRUCTION_MAX_CHARS } from "../contract.js";
/** The composed text is over INSTRUCTION_MAX_CHARS; thrown before any state change */
export class TooLongError extends Error {
    length;
    max;
    constructor(length, max = INSTRUCTION_MAX_CHARS) {
        super("too_long");
        this.length = length;
        this.max = max;
    }
}
const QUOTE_MAX = 160;
function quoted(s) {
    const flat = s.length > QUOTE_MAX ? s.slice(0, QUOTE_MAX) + "…" : s;
    return JSON.stringify(flat);
}
function fileOf(c, ctx) {
    switch (c.source.kind) {
        case "plan":
            return ctx.planFile;
        case "explanation":
            return ctx.explanationFile;
        default:
            return c.source.file;
    }
}
function whereLine(c, ctx) {
    const file = fileOf(c, ctx);
    const head = file ? `${c.source.kind} ${file}` : c.source.kind;
    let line;
    if (c.kind === "region") {
        const r = c.rect;
        line = `${head}, region x=${r.x} y=${r.y} w=${r.w} h=${r.h}`;
        const mark = c.mark ? ctx.markPath?.(c.mark) : undefined;
        if (mark)
            line += ` (marked copy: ${mark})`;
    }
    else if (c.kind === "element") {
        if (c.selector)
            line = `${head}, element ${c.selector}${c.text ? ` ${quoted(c.text)}` : ""}`;
        else
            line = `${head} (whole page)`;
    }
    else if (c.source.kind === "page") {
        line = `${head}, element ${c.selector ?? "(unknown)"}: ${quoted(c.quote ?? "")}`;
    }
    else {
        const section = c.section && c.section.length > 0 ? `, ${JSON.stringify(c.section.join(" > "))}` : "";
        line = `${head}${section}: ${quoted(c.quote ?? "")}`;
    }
    // A text anchor in the plan or the explanation is searched in that text; a page or image comment is gone from the screen
    const inText = c.kind === "text" && (c.source.kind === "plan" || c.source.kind === "explanation");
    if (!c.orphan)
        return line;
    return inText ? `${line} (no longer in the current text)` : `${line} (no longer shown)`;
}
/** The text of the comments as the agent reads it (see the contract: "Text the agent sees") */
export function formatComments(comments, ctx = {}) {
    const lines = [`The human left ${comments.length} comment${comments.length === 1 ? "" : "s"}:`];
    comments.forEach((c, i) => {
        lines.push(`${i + 1}. ${whereLine(c, ctx)}`);
        const [first = "", ...rest] = c.note.split("\n");
        lines.push(`   → ${first}`);
        for (const l of rest)
            lines.push(`     ${l}`);
    });
    return lines.join("\n");
}
/** `base` followed by the block after a blank line; the block alone when there is no base */
export function appendBlock(base, block) {
    return base ? `${base}\n\n${block}` : block;
}
/** appendBlock that refuses a result over `max` characters */
export function composeWithComments(base, comments, ctx, max = INSTRUCTION_MAX_CHARS) {
    const text = appendBlock(base, formatComments(comments, ctx));
    if (text.length > max)
        throw new TooLongError(text.length, max);
    return text;
}
//# sourceMappingURL=comments.js.map