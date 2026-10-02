import { renderMermaidASCII } from "beautiful-mermaid";
import { width } from "./width.js";

// ```mermaid block to terminal box-drawing text (beautiful-mermaid, synchronous, no DOM).
// A diagram looks the same regardless of width, so draw each definition once and remember it.

/** Rendering that takes longer than this counts as a failure (judged after the fact since it is synchronous) */
export const RENDER_BUDGET_MS = 2000;

export type MermaidResult = { ok: true; lines: string[]; width: number } | { ok: false };

const cache = new Map<string, MermaidResult>();

// beautiful-mermaid counts every character as width 1, so full-width characters would misalign the boxes.
// Replace each full-width character with two private-use characters, draw, then restore the full-width character.
const WIDE_BASE = 0xe000;
const WIDE_MARK = "";

function isWide(ch: string): boolean {
  return width(ch) === 2;
}

function protectWide(src: string, table: string[]): string {
  let out = "";
  for (const ch of src) {
    if (!isWide(ch)) {
      out += ch;
      continue;
    }
    let k = table.indexOf(ch);
    if (k < 0) k = table.push(ch) - 1;
    if (k >= 0x1000) throw new Error("too many wide chars");
    out += String.fromCharCode(WIDE_BASE + k) + WIDE_MARK;
  }
  return out;
}

function restoreWide(line: string, table: string[]): string {
  return line.replace(/([-])/g, (_, c: string) => table[c.charCodeAt(0) - WIDE_BASE] ?? "?");
}

// beautiful-mermaid reads `A-->B` (no spaces) as a single node name `A--` including the arrow (the GUI mermaid.js reads it fine).
// Before drawing, add spaces around arrows. Leave the inside of labels ([] () {} "" ||) alone.
// `--x` / `--o` are not read even with spaces and the edge disappears, so replace them with `-->` (only the end marker is lost).
const ARROW_RE = /<-->|<?-{2,}>|-{3,}|-\.+->|={2,}>|--[xo]/g;
const FLOW_RE = /^\s*(?:flowchart|graph|stateDiagram(?:-v2)?)\b/m;

function padLine(line: string): string {
  let out = "";
  let code = "";
  let depth = 0;
  let quote = false;
  let pipe = false;
  const flush = (next: string | undefined) => {
    code = code.replace(ARROW_RE, (m, i: number, all: string) => {
      const before = i > 0 ? all[i - 1] !== " " : out !== "" && !out.endsWith(" ");
      const after = i + m.length < all.length ? all[i + m.length] !== " " : next !== undefined && next !== "|" && !/\s/.test(next);
      return `${before ? " " : ""}${/^--[xo]$/.test(m) ? "-->" : m}${after ? " " : ""}`;
    });
    out += code;
    code = "";
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      out += c;
      if (c === '"') quote = false;
    } else if (pipe) {
      out += c;
      if (c === "|") {
        pipe = false;
        if (line[i + 1] !== undefined && !/\s/.test(line[i + 1]!)) out += " ";
      }
    } else if (depth > 0) {
      out += c;
      if (c === '"') quote = true;
      else if ("[({".includes(c)) depth++;
      else if ("])}".includes(c)) depth--;
    } else if (c === '"') {
      flush(c);
      out += c;
      quote = true;
    } else if (c === "|") {
      flush(c);
      out += c;
      pipe = true;
    } else if ("[({".includes(c)) {
      flush(c);
      out += c;
      depth = 1;
    } else code += c;
  }
  flush(undefined);
  return out;
}

export function padArrows(source: string): string {
  if (!FLOW_RE.test(source)) return source;
  return source.split("\n").map(padLine).join("\n");
}

export function renderMermaid(source: string): MermaidResult {
  const hit = cache.get(source);
  if (hit) return hit;
  let res: MermaidResult;
  try {
    const table: string[] = [];
    const t0 = Date.now();
    const text = renderMermaidASCII(protectWide(padArrows(source), table), { colorMode: "none" });
    if (Date.now() - t0 > RENDER_BUDGET_MS) throw new Error("timeout");
    const lines = text.split("\n").map((l) => restoreWide(l, table).replace(/\s+$/, ""));
    while (lines.at(-1) === "") lines.pop();
    while (lines[0] === "") lines.shift();
    res = lines.length ? { ok: true, lines, width: Math.max(...lines.map(width)) } : { ok: false };
  } catch {
    res = { ok: false };
  }
  cache.set(source, res);
  return res;
}
