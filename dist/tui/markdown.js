import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { COLUMN_RISK, findTables, normalizeHeading, scanFences, toLines } from "../hook/explain.js";
import { t } from "./i18n.js";
import { diagramType, isAsciiType, renderMermaid } from "./mermaid.js";
import { padEnd, sliceCols, wrap, width } from "./width.js";
// Terminal rendering of Markdown. Lines are returned already wrapped to display width w.
export const RESET = "\x1b[0m";
export const BOLD = "\x1b[1m";
export const DIM = "\x1b[2m";
export const RED = "\x1b[31m";
export const GREEN = "\x1b[32m";
export const YELLOW = "\x1b[33m";
export const BLUE = "\x1b[34m";
export const MAGENTA = "\x1b[35m";
export const CYAN = "\x1b[36m";
export const INVERSE = "\x1b[7m";
export const INVERSE_OFF = "\x1b[27m";
export const STRONG = "\x1b[1;36m";
export const STRONG_RISK = "\x1b[1;31m";
/** Marks for literal strings (longest first; whole-word for words, plain for CJK). Empty strings are skipped */
export function literalMarks(words, open, close) {
    const list = [...new Set(words.map((w) => w.trim()).filter((w) => w.length >= 2))].sort((a, b) => b.length - a.length);
    return list.map((w) => {
        const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const wordy = /^[\w]/.test(w) && /[\w]$/.test(w);
        return { re: new RegExp(wordy ? `(?<![\\w])${esc}(?![\\w])` : esc, "giu"), open, close };
    });
}
/** Apply marks to a plain text segment. Overlaps resolve to the earliest, then the longest match */
function applyMarks(text, marks) {
    if (!marks.length || !text)
        return text;
    const hits = [];
    for (const m of marks) {
        for (const x of text.matchAll(new RegExp(m.re.source, m.re.flags.includes("g") ? m.re.flags : m.re.flags + "g"))) {
            if (x[0] === "")
                continue;
            hits.push({ s: x.index, e: x.index + x[0].length, m });
        }
    }
    hits.sort((a, b) => a.s - b.s || b.e - b.s - (a.e - a.s));
    let out = "";
    let at = 0;
    for (let k = 0; k < hits.length; k++) {
        const h = hits[k];
        if (h.s < at)
            continue;
        // Marks on exactly the same span nest (e.g. an option label that is also a term: colored and underlined)
        const same = hits.slice(k).filter((x) => x.s === h.s && x.e === h.e);
        out += text.slice(at, h.s) + same.map((x) => x.m.open).join("") + text.slice(h.s, h.e) + [...same].reverse().map((x) => x.m.close).join("");
        at = h.e;
    }
    return out + text.slice(at);
}
const BADGES = { done: GREEN, todo: "", doing: CYAN, blocked: RED, risk: RED, skip: "" };
const BADGE_RE = /^((?:\*\*[^*]+\*\*\s*)?)\[(done|todo|doing|blocked|risk|skip)\]/;
const IMAGE_DEST = String.raw `((?:[^()\s]|\([^()\s]*\))+)`;
const IMAGE_RE = new RegExp(String.raw `!\[([^\]]*)\]\(${IMAGE_DEST}(?:\s+"[^"]*")?\)`, "g");
// `==text==` but not runs of `=` (setext underlines, `a===b`); public/app.js inlineMarks must use the same pattern
const MARK_RE = /(?<!=)==(?=[^\s=])([^=\n]*?[^\s=])==(?!=)/g;
/** Turn `**strong**` / `` `code` `` / `*em*` / links into ANSI, returning to base decoration afterwards */
export function inline(text, opts = {}) {
    const strong = opts.strong ?? STRONG;
    const base = opts.base ?? "";
    const close = RESET + base;
    const plain = text
        .replace(/<br\s*\/?>/gi, opts.br ? "\n" : " ")
        .replace(/<\/?(?:sub|sup)>/gi, "")
        .replace(/\\([|*`_])/g, "$1");
    const badged = opts.badge
        ? plain.replace(BADGE_RE, (_, lead, word) => `${lead}[${BADGES[word] ? BADGES[word] + word + RESET + base : word}]`)
        : plain;
    // Marks go only on text outside code spans (and are applied before `**` so they do not split the markers)
    const marked = badged
        .split(/(`[^`]+`)/)
        .map((seg, i) => {
        if (i % 2)
            return seg;
        const hl = seg
            .replace(IMAGE_RE, (_, alt, src) => `\x00${alt ? `${alt} — ` : ""}${src}\x01`)
            .replace(MARK_RE, (_, c) => `\x02${c}\x03`);
        return opts.marks?.length ? applyMarks(hl, opts.marks) : hl;
    })
        .join("");
    return marked
        .replace(/\x00([^\x01]*)\x01/g, (_, c) => `${opts.imageLabel ?? "[image]"} ${c}`)
        .replace(/\[\^([^\]\s]+)\](?!:)/g, (_, id) => `${CYAN}[${id}]${close}`)
        .replace(/`([^`]+)`/g, (_, c) => `${CYAN}${c}${close}`)
        .replace(/\*\*([^*]+)\*\*/g, (_, c) => `${strong}${c}${close}`)
        .replace(/(?<![*\w])\*([^*\s][^*]*)\*(?![*\w])/g, (_, c) => `\x1b[3m${c}${close}`)
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => `${t} (${u})`)
        // Last, so a reset inside the mark (nested bold, code) re-opens the inverse
        .replace(/\x02([^\x03]*)\x03/g, (_, c) => INVERSE + c.replaceAll(close, close + INVERSE) + INVERSE_OFF);
}
const CALLOUTS = {
    NOTE: { label: "callout_note", color: BLUE },
    TIP: { label: "callout_tip", color: GREEN },
    WARNING: { label: "callout_warning", color: YELLOW },
    IMPORTANT: { label: "callout_important", color: MAGENTA },
    CAUTION: { label: "callout_caution", color: RED },
};
// `<details>` and `::: columns` are expanded into plain lines plus two sentinel lines before rendering:
// SENT + "H" + <body line count> + SENT + <summary> (a dim fold header) and SENT + "R" (a dim rule).
const SENT = "\x01";
const DETAILS_OPEN = /^\s*<details(?:\s[^>]*)?>\s*$/i;
const DETAILS_CLOSE = /^\s*<\/details>\s*$/i;
const IMAGE_LINE = new RegExp(String.raw `^\s*!\[([^\]]*)\]\(${IMAGE_DEST}(?:\s+"[^"]*")?\)\s*$`);
function expandBlocks(lines, fallback) {
    const { inFence } = scanFences(lines);
    const out = [];
    let i = 0;
    while (i < lines.length) {
        const l = lines[i];
        if (inFence[i]) {
            out.push(l);
            i++;
        }
        else if (DETAILS_OPEN.test(l)) {
            let depth = 1;
            let j = i + 1;
            let closed = false;
            for (; j < lines.length; j++) {
                if (inFence[j])
                    continue;
                // An unclosed <details> ends at the next `## ` heading (markdown.md §2.3), so a section is never swallowed
                if (/^## /.test(lines[j]))
                    break;
                if (DETAILS_OPEN.test(lines[j]))
                    depth++;
                else if (DETAILS_CLOSE.test(lines[j]) && --depth === 0) {
                    closed = true;
                    break;
                }
            }
            let inner = lines.slice(i + 1, j);
            const bodyOnly = inner;
            let summary = fallback;
            const first = inner.findIndex((x) => x.trim() !== "");
            if (first >= 0 && /^\s*<summary[\s>]/i.test(inner[first])) {
                let k = first;
                let text = "";
                while (k < inner.length) {
                    const m = /<\/summary>/i.exec(inner[k]);
                    if (m) {
                        text += " " + inner[k].slice(0, m.index);
                        inner = [inner[k].slice(m.index + m[0].length), ...inner.slice(k + 1)];
                        k = -1;
                        break;
                    }
                    text += " " + inner[k];
                    k++;
                }
                if (k !== -1) {
                    // No </summary>: the first line is the summary, the rest stays body
                    text = bodyOnly[first];
                    inner = bodyOnly.slice(first + 1);
                }
                summary = text.replace(/<\/?(?:summary|b|i|em|strong|code|kbd|span|a)(?:\s[^>]*)?>/gi, " ").replace(/\s+/g, " ").trim() || fallback;
            }
            while (inner.length && inner[0].trim() === "")
                inner.shift();
            while (inner.length && inner.at(-1).trim() === "")
                inner.pop();
            out.push("", `${SENT}H${inner.length}${SENT}${summary}`, ...expandBlocks(inner, fallback), "");
            i = closed ? j + 1 : j;
        }
        else if (/^\s*:::\s*columns\s*$/i.test(l)) {
            let j = i + 1;
            while (j < lines.length && !(!inFence[j] && /^\s*:::\s*$/.test(lines[j])))
                j++;
            const inner = lines.slice(i + 1, j);
            const innerFence = scanFences(inner).inFence;
            const cols = [[]];
            inner.forEach((x, k) => {
                if (!innerFence[k] && /^\s*-{3,}\s*$/.test(x))
                    cols.push([]);
                else
                    cols.at(-1).push(x);
            });
            for (const col of cols) {
                while (col.length && col[0].trim() === "")
                    col.shift();
                while (col.length && col.at(-1).trim() === "")
                    col.pop();
                out.push("", `${SENT}R`, ...expandBlocks(col, fallback), "");
            }
            i = j + 1;
        }
        else if (/^\s*:::/.test(l))
            i++;
        else {
            out.push(l);
            i++;
        }
    }
    return out;
}
/** `W×H` from the header of a PNG / GIF / JPEG / WebP (read from the first 64 KB, no dependency) */
function imageSize(src, baseDir) {
    const file = isAbsolute(src) ? src : baseDir ? join(baseDir, src) : "";
    if (!/\.(png|jpe?g|gif|webp)$/i.test(file))
        return "";
    let fd;
    try {
        fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
        if (!fstatSync(fd).isFile())
            return "";
        const buf = Buffer.alloc(65536);
        const b = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0));
        let dim = null;
        if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47)
            dim = [b.readUInt32BE(16), b.readUInt32BE(20)];
        else if (b.length >= 10 && b.toString("latin1", 0, 3) === "GIF")
            dim = [b.readUInt16LE(6), b.readUInt16LE(8)];
        else if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
            for (let p = 2; p + 9 < b.length;) {
                const m = b[p + 1];
                if (b[p] !== 0xff || m === 0xff)
                    p++;
                else if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
                    dim = [b.readUInt16BE(p + 7), b.readUInt16BE(p + 5)];
                    break;
                }
                else
                    p += m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) ? 2 : 2 + b.readUInt16BE(p + 2);
            }
        }
        else if (b.length >= 30 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
            const kind = b.toString("latin1", 12, 16);
            if (kind === "VP8X")
                dim = [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
            else if (kind === "VP8L") {
                const bits = b.readUInt32LE(21);
                dim = [1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff)];
            }
            else if (kind === "VP8 ")
                dim = [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
        }
        return dim && dim[0] > 0 && dim[1] > 0 ? ` (${dim[0]}×${dim[1]})` : "";
    }
    catch {
        return "";
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
    }
}
function isCjk(ch) {
    return ch !== undefined && width(ch) === 2;
}
/** Join paragraph lines into one. No space is inserted at a line break between two CJK characters */
function joinSoft(lines) {
    let out = "";
    for (const raw of lines) {
        const l = raw.trim();
        if (out === "")
            out = l;
        else
            out += (isCjk(out.at(-1)) && isCjk(l[0]) ? "" : " ") + l;
    }
    return out;
}
function diffLine(l) {
    if (/^(diff |index |\+\+\+ |--- )/.test(l))
        return `${BOLD}${l}${RESET}`;
    if (l.startsWith("@@"))
        return `${CYAN}${l}${RESET}`;
    if (l.startsWith("+"))
        return `${GREEN}${l}${RESET}`;
    if (l.startsWith("-"))
        return `${RED}${l}${RESET}`;
    return l;
}
/** Render a table as aligned text without borders. When it does not fit, shrink the widest columns first and wrap cells */
function renderTable(header, rows, w, marks, imageLabel) {
    const cols = header.length;
    const GAP = 2;
    const isRisk = header.map((h) => COLUMN_RISK.test(h.normalize("NFKC")));
    const cell = (r, c, strong) => inline(r[c] ?? "", { marks, badge: true, imageLabel, ...(strong ? { strong } : {}) });
    const natural = Array.from({ length: cols }, (_, c) => Math.max(width(header[c] ?? ""), ...rows.map((r) => width(cell(r, c)))));
    const avail = Math.max(cols * 4, w - GAP * (cols - 1));
    const widths = [...natural];
    while (widths.reduce((a, b) => a + b, 0) > avail) {
        const max = Math.max(...widths);
        const i = widths.indexOf(max);
        if (max <= 4)
            break;
        widths[i] = max - 1;
    }
    const out = [];
    const emit = (cells, pre) => {
        const wrapped = cells.map((t, c) => wrap(t, widths[c]));
        const h = Math.max(...wrapped.map((x) => x.length));
        for (let k = 0; k < h; k++) {
            const parts = wrapped.map((x, c) => {
                const s = x[k] ?? "";
                return padEnd(pre ? `${pre}${s}${RESET}` : s, widths[c]);
            });
            out.push(parts.join(" ".repeat(GAP)).replace(/\s+$/, ""));
        }
    };
    emit(header, BOLD);
    for (const r of rows) {
        emit(Array.from({ length: cols }, (_, c) => cell(r, c, isRisk[c] ? STRONG_RISK : undefined)), "");
    }
    return out;
}
/** Markdown to terminal lines (already wrapped to display width w) */
export function renderMarkdown(markdown, w, opts = {}) {
    return renderMarkdownRich(markdown, w, opts).lines;
}
export function renderMarkdownRich(markdown, w, opts = {}) {
    const lang = opts.lang ?? "en";
    const lines = expandBlocks(toLines(markdown), t(lang, "details_summary"));
    const { inFence, blocks } = scanFences(lines);
    const out = [];
    const wideRows = new Map();
    const footnotes = [];
    let marks = opts.marks ?? [];
    const imageLabel = t(lang, "image_label");
    const inl = (x, o = {}) => inline(x, { marks, imageLabel, br: true, ...o });
    const gap = () => {
        if (out.length && out.at(-1) !== "")
            out.push("");
    };
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        const block = blocks.find((b) => b.start === i);
        if (block) {
            const closed = block.end > block.start && /^ {0,3}(`{3,}|~{3,})\s*$/.test(lines[block.end]);
            const body = lines.slice(block.start + 1, closed ? block.end : block.end + 1);
            gap();
            const title = /\btitle=(?:"([^"]*)"|'([^']*)')/.exec(lines[block.start]);
            const kind = block.lang === "mermaid" ? diagramType(body.join("\n")) : "";
            if (block.lang === "mermaid" && !isAsciiType(kind)) {
                const label = ` ${t(lang, "diagram_type", { type: kind || "?" })} `;
                out.push(...wrap(`${DIM}┌${"─".repeat(width(label))}┐${RESET}`, w), ...wrap(`${DIM}│${RESET}${label}${DIM}│${RESET}`, w), ...wrap(`${DIM}└${"─".repeat(width(label))}┘${RESET}`, w));
                for (const l of body)
                    out.push(...wrap(`  ${l}`, w));
            }
            else if (block.lang === "mermaid") {
                const fig = renderMermaid(body.join("\n"));
                if (fig.ok) {
                    if (fig.width > w) {
                        out.push(...wrap(t(lang, opts.fullHint === false ? "figure_note" : "figure_note_full", { width: fig.width }), w));
                        for (const l of fig.lines) {
                            if (width(l) > w)
                                wideRows.set(out.length, l);
                            out.push(sliceCols(l, 0, w));
                        }
                    }
                    else
                        out.push(...fig.lines);
                }
                else {
                    out.push(t(lang, "figure_failed"));
                    for (const l of body)
                        out.push(...wrap(`  ${l}`, w));
                }
            }
            else if (block.lang === "diff") {
                if (title && (title[1] ?? title[2]))
                    out.push(...wrap(`${title[1] ?? title[2]}`, w));
                for (const l of body)
                    out.push(...wrap(`  ${diffLine(l)}`, w));
            }
            else {
                if (title && (title[1] ?? title[2]))
                    out.push(...wrap(`${title[1] ?? title[2]}`, w));
                for (const l of body)
                    out.push(...wrap(`  ${l}`, w));
            }
            out.push("");
            i = block.end + 1;
            continue;
        }
        if (line.trim() === "") {
            gap();
            i++;
            continue;
        }
        if (line.startsWith(SENT)) {
            gap();
            const head = /^\x01H(\d+)\x01(.*)$/.exec(line);
            if (head) {
                const n = Number(head[1]);
                out.push(...wrap(`▸ ${inline(head[2])} (${t(lang, n === 1 ? "plan_lines_one" : "plan_lines", { n })})`, w));
            }
            else
                out.push(`${DIM}${"─".repeat(w)}${RESET}`);
            i++;
            continue;
        }
        const h = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
        if (h) {
            gap();
            marks = opts.termsHeadings?.includes(normalizeHeading(h[2])) ? [] : (opts.marks ?? []);
            out.push(...wrap(`${BOLD}${inline(h[2], { base: BOLD })}${RESET}`, w));
            i++;
            continue;
        }
        if (line.includes("|") && i + 1 < lines.length && findTables(lines, inFence, i, i + 2).length) {
            let end = i + 2;
            while (end < lines.length && !inFence[end] && lines[end].includes("|") && lines[end].trim() !== "")
                end++;
            const t = findTables(lines, inFence, i, end)[0];
            gap();
            out.push(...renderTable(t.header, t.rows, w, marks, imageLabel));
            out.push("");
            i = end;
            continue;
        }
        if (/^ {0,3}>/.test(line)) {
            const quote = [];
            while (i < lines.length && /^ {0,3}>/.test(lines[i])) {
                quote.push(lines[i].replace(/^ {0,3}>\s?/, ""));
                i++;
            }
            gap();
            const m = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i.exec(quote[0].trim());
            const spec = m ? CALLOUTS[m[1].toUpperCase()] : null;
            const bodyLines = spec ? quote.slice(1) : quote;
            const color = spec?.color ?? DIM;
            const bar = `${color}▌${RESET} `;
            if (spec) {
                const title = m[2].trim();
                const head = title ? inl(title, { base: color + BOLD }) : t(lang, spec.label);
                wrap(`${color}${BOLD}${title ? `[!${m[1].toUpperCase()}] ` : ""}${head}${RESET}`, w - 2).forEach((l, k) => out.push(k === 0 ? `${color}▌${RESET} ${l}` : bar + l));
            }
            const paras = [[]];
            for (const l of bodyLines) {
                if (l.trim() === "")
                    paras.push([]);
                else
                    paras.at(-1).push(l);
            }
            paras.forEach((p, k) => {
                if (!p.length)
                    return;
                if (k > 0)
                    out.push(bar.trimEnd());
                for (const l of wrap(inl(joinSoft(p)), w - 2))
                    out.push(bar + l);
            });
            out.push("");
            continue;
        }
        const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
        if (li) {
            const indent = Math.min(6, li[1].length);
            let mark = /^\d/.test(li[2]) ? li[2] : "•";
            const item = [li[3]];
            i++;
            while (i < lines.length && lines[i].trim() !== "" && !/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i]) && !inFence[i] && !lines[i].startsWith(SENT) && !/^ {0,3}(#{1,6}\s|>)/.test(lines[i]) && !/^ {0,3}\[\^[^\]\s]+\]:/.test(lines[i])) {
                item.push(lines[i]);
                i++;
            }
            let text = joinSoft(item);
            const task = /^\[([ xX])\](?:\s+|$)/.exec(text);
            let done = false;
            if (task) {
                done = task[1] !== " ";
                mark = (/^\d/.test(mark) ? mark + " " : "") + (done ? "☑" : "☐");
                text = text.slice(task[0].length);
            }
            const lead = " ".repeat(indent) + mark + " ";
            const pad = " ".repeat(width(lead));
            const body = !text ? "" : done ? inl(text, { badge: true }) : inl(text, { badge: true });
            wrap(body, Math.max(8, w - width(lead))).forEach((l, k) => out.push(((k === 0 ? lead : pad) + l).trimEnd()));
            continue;
        }
        const fn = /^ {0,3}\[\^([^\]\s]+)\]:\s*(.*)$/.exec(line);
        if (fn) {
            const item = [fn[2]];
            i++;
            while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !inFence[i])
                item.push(lines[i++]);
            const lead = `${CYAN}[${fn[1]}]${RESET} `;
            const pad = " ".repeat(width(lead));
            footnotes.push({ id: fn[1], row: out.length });
            wrap(inl(joinSoft(item)), Math.max(8, w - width(lead))).forEach((l, k) => out.push((k === 0 ? lead : pad) + l));
            continue;
        }
        const img = IMAGE_LINE.exec(line);
        if (img) {
            const [, alt, src] = img;
            if (/\.html?$/i.test(src.split(/[?#]/)[0])) {
                out.push(...wrap(`[HTML] ${alt ? `${alt} — ` : ""}${src.split(/[?#]/)[0].split("/").pop()} ${t(lang, "html_embed")}`, w));
                i++;
                continue;
            }
            out.push(...wrap(`${imageLabel} ${alt ? `${alt} — ` : ""}${src}${imageSize(src, opts.baseDir)}`, w));
            i++;
            continue;
        }
        // Paragraph
        const para = [];
        while (i < lines.length &&
            lines[i].trim() !== "" &&
            !blocks.some((b) => b.start === i) &&
            !lines[i].startsWith(SENT) &&
            !(para.length && IMAGE_LINE.test(lines[i])) &&
            !/^ {0,3}(#{1,6}\s|>)/.test(lines[i]) &&
            !/^ {0,3}\[\^[^\]\s]+\]:/.test(lines[i]) &&
            !(para.length && /^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i]))) {
            para.push(lines[i]);
            i++;
        }
        out.push(...wrap(inl(joinSoft(para)), w));
    }
    while (out.at(-1) === "")
        out.pop();
    return { lines: out, footnotes, wide: out.map((_, k) => wideRows.get(k) ?? null) };
}
//# sourceMappingURL=markdown.js.map