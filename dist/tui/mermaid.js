import { renderMermaidASCII } from "beautiful-mermaid";
import { width } from "./width.js";
// ```mermaid block to terminal box-drawing text (beautiful-mermaid, synchronous, no DOM).
// A diagram looks the same regardless of width, so draw each definition once and remember it.
/** Rendering that takes longer than this counts as a failure (judged after the fact since it is synchronous) */
export const RENDER_BUDGET_MS = 2000;
const cache = new Map();
// beautiful-mermaid counts every character as width 1, so full-width characters would misalign the boxes.
// Replace each full-width character with two private-use characters, draw, then restore the full-width character.
const WIDE_BASE = 0xe000;
const WIDE_MARK = "";
function isWide(ch) {
    return width(ch) === 2;
}
function protectWide(src, table) {
    let out = "";
    for (const ch of src) {
        if (!isWide(ch)) {
            out += ch;
            continue;
        }
        let k = table.indexOf(ch);
        if (k < 0)
            k = table.push(ch) - 1;
        if (k >= 0x1000)
            throw new Error("too many wide chars");
        out += String.fromCharCode(WIDE_BASE + k) + WIDE_MARK;
    }
    return out;
}
function restoreWide(line, table) {
    return line.replace(/([-])/g, (_, c) => table[c.charCodeAt(0) - WIDE_BASE] ?? "?");
}
// beautiful-mermaid reads `A-->B` (no spaces) as a single node name `A--` including the arrow (the GUI mermaid.js reads it fine).
// Before drawing, add spaces around arrows. Leave the inside of labels ([] () {} "" ||) alone.
// `--x` / `--o` are not read even with spaces and the edge disappears, so replace them with `-->` (only the end marker is lost).
const ARROW_RE = /<-->|<?-{2,}>|-{3,}|-\.+->|={2,}>|--[xo]/g;
const FLOW_RE = /^\s*(?:flowchart|graph|stateDiagram(?:-v2)?)\b/m;
function padLine(line) {
    let out = "";
    let code = "";
    let depth = 0;
    let quote = false;
    let pipe = false;
    const flush = (next) => {
        code = code.replace(ARROW_RE, (m, i, all) => {
            const before = i > 0 ? all[i - 1] !== " " : out !== "" && !out.endsWith(" ");
            const after = i + m.length < all.length ? all[i + m.length] !== " " : next !== undefined && next !== "|" && !/\s/.test(next);
            return `${before ? " " : ""}${/^--[xo]$/.test(m) ? "-->" : m}${after ? " " : ""}`;
        });
        out += code;
        code = "";
    };
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
            out += c;
            if (c === '"')
                quote = false;
        }
        else if (pipe) {
            out += c;
            if (c === "|") {
                pipe = false;
                if (line[i + 1] !== undefined && !/\s/.test(line[i + 1]))
                    out += " ";
            }
        }
        else if (depth > 0) {
            out += c;
            if (c === '"')
                quote = true;
            else if ("[({".includes(c))
                depth++;
            else if ("])}".includes(c))
                depth--;
        }
        else if (c === '"') {
            flush(c);
            out += c;
            quote = true;
        }
        else if (c === "|") {
            flush(c);
            out += c;
            pipe = true;
        }
        else if ("[({".includes(c)) {
            flush(c);
            out += c;
            depth = 1;
        }
        else
            code += c;
    }
    flush(undefined);
    return out;
}
export function padArrows(source) {
    if (!FLOW_RE.test(source))
        return source;
    return source.split("\n").map(padLine).join("\n");
}
/** Diagram types beautiful-mermaid draws as ASCII */
const ASCII_TYPES = /^(flowchart|graph|stateDiagram(-v2)?|sequenceDiagram|classDiagram|erDiagram|xychart(-beta)?)$/;
/** Drop leading `---` front matter and `%%{init …}%%` directives (the latter may span lines) */
export function stripPreamble(source) {
    let s = source;
    for (;;) {
        const next = s.replace(/^\s*---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/, "").replace(/^\s*%%\{[\s\S]*?\}%%/, "");
        if (next === s)
            return s;
        s = next;
    }
}
/** The diagram type: the first word of the first non-empty line that is not a `%%` comment (after the preamble) */
export function diagramType(source) {
    for (const raw of stripPreamble(source).split("\n")) {
        const l = raw.trim();
        if (l === "" || l.startsWith("%%"))
            continue;
        return /^[^\s:;{]+/.exec(l)?.[0] ?? "";
    }
    return "";
}
/** True when beautiful-mermaid can draw this type (any other type shows `diagram: <type>` plus the source) */
export function isAsciiType(type) {
    return ASCII_TYPES.test(type);
}
export function renderMermaid(raw) {
    const source = stripPreamble(raw);
    const hit = cache.get(source);
    if (hit)
        return hit;
    let res;
    try {
        const table = [];
        const t0 = Date.now();
        const text = renderMermaidASCII(protectWide(padArrows(source), table), { colorMode: "none" });
        if (Date.now() - t0 > RENDER_BUDGET_MS)
            throw new Error("timeout");
        const lines = text.split("\n").map((l) => restoreWide(l, table).replace(/\s+$/, ""));
        while (lines.at(-1) === "")
            lines.pop();
        while (lines[0] === "")
            lines.shift();
        res = lines.length ? { ok: true, lines, width: Math.max(...lines.map(width)) } : { ok: false };
    }
    catch {
        res = { ok: false };
    }
    cache.set(source, res);
    return res;
}
//# sourceMappingURL=mermaid.js.map