import { COLUMN_RISK, findTables, normalizeHeading, scanFences, toLines } from "../hook/explain.js";
import type { Lang } from "../settings/config.js";
import { t, type MessageKey } from "./i18n.js";
import { renderMermaid } from "./mermaid.js";
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
export const STRONG = "\x1b[1;36m";
export const STRONG_RISK = "\x1b[1;31m";

/** A highlight applied to plain text (not inside code spans): every match of `re` is wrapped in open / close */
export interface Mark {
  re: RegExp;
  open: string;
  close: string;
}

/** Marks for literal strings (longest first; whole-word for words, plain for CJK). Empty strings are skipped */
export function literalMarks(words: string[], open: string, close: string): Mark[] {
  const list = [...new Set(words.map((w) => w.trim()).filter((w) => w.length >= 2))].sort((a, b) => b.length - a.length);
  return list.map((w) => {
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const wordy = /^[\w]/.test(w) && /[\w]$/.test(w);
    return { re: new RegExp(wordy ? `(?<![\\w])${esc}(?![\\w])` : esc, "giu"), open, close };
  });
}

/** Apply marks to a plain text segment. Overlaps resolve to the earliest, then the longest match */
function applyMarks(text: string, marks: Mark[]): string {
  if (!marks.length || !text) return text;
  const hits: { s: number; e: number; m: Mark }[] = [];
  for (const m of marks) {
    for (const x of text.matchAll(new RegExp(m.re.source, m.re.flags.includes("g") ? m.re.flags : m.re.flags + "g"))) {
      if (x[0] === "") continue;
      hits.push({ s: x.index!, e: x.index! + x[0].length, m });
    }
  }
  hits.sort((a, b) => a.s - b.s || b.e - b.s - (a.e - a.s));
  let out = "";
  let at = 0;
  for (let k = 0; k < hits.length; k++) {
    const h = hits[k]!;
    if (h.s < at) continue;
    // Marks on exactly the same span nest (e.g. an option label that is also a term: colored and underlined)
    const same = hits.slice(k).filter((x) => x.s === h.s && x.e === h.e);
    out += text.slice(at, h.s) + same.map((x) => x.m.open).join("") + text.slice(h.s, h.e) + [...same].reverse().map((x) => x.m.close).join("");
    at = h.e;
  }
  return out + text.slice(at);
}

export interface InlineOpts {
  /** Highlights for terms, option labels and risk words */
  marks?: Mark[];
  /** Color of `**strong**` (default: bold cyan; red in the risk column) */
  strong?: string;
  /** Decoration outside the span, re-applied after the span closes */
  base?: string;
}

/** Turn `**strong**` / `` `code` `` / `*em*` / links into ANSI, returning to base decoration afterwards */
export function inline(text: string, opts: InlineOpts = {}): string {
  const strong = opts.strong ?? STRONG;
  const base = opts.base ?? "";
  const close = RESET + base;
  const plain = text.replace(/<br\s*\/?>/gi, " ").replace(/\\([|*`_])/g, "$1");
  // Marks go only on text outside code spans (and are applied before `**` so they do not split the markers)
  const marked = opts.marks?.length
    ? plain
        .split(/(`[^`]+`)/)
        .map((seg, i) => (i % 2 ? seg : applyMarks(seg, opts.marks!)))
        .join("")
    : plain;
  return marked
    .replace(/\[\^([^\]\s]+)\](?!:)/g, (_, id: string) => `${DIM}[${id}]${close}`)
    .replace(/`([^`]+)`/g, (_, c: string) => `${DIM}${c}${close}`)
    .replace(/\*\*([^*]+)\*\*/g, (_, c: string) => `${strong}${c}${close}`)
    .replace(/(?<![*\w])\*([^*\s][^*]*)\*(?![*\w])/g, (_, c: string) => `\x1b[3m${c}${close}`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t: string, u: string) => `${t} ${DIM}(${u})${close}`);
}

const CALLOUTS: Record<string, { label: MessageKey; color: string }> = {
  NOTE: { label: "callout_note", color: BLUE },
  TIP: { label: "callout_tip", color: GREEN },
  WARNING: { label: "callout_warning", color: YELLOW },
  CAUTION: { label: "callout_caution", color: RED },
};

function isCjk(ch: string | undefined): boolean {
  return ch !== undefined && width(ch) === 2;
}

/** Join paragraph lines into one. No space is inserted at a line break between two CJK characters */
function joinSoft(lines: string[]): string {
  let out = "";
  for (const raw of lines) {
    const l = raw.trim();
    if (out === "") out = l;
    else out += (isCjk(out.at(-1)) && isCjk(l[0]) ? "" : " ") + l;
  }
  return out;
}

function diffLine(l: string): string {
  if (/^(diff |index |\+\+\+ |--- )/.test(l)) return `${BOLD}${l}${RESET}`;
  if (l.startsWith("@@")) return `${BLUE}${l}${RESET}`;
  if (l.startsWith("+")) return `${GREEN}${l}${RESET}`;
  if (l.startsWith("-")) return `${RED}${l}${RESET}`;
  return l;
}

/** Render a table as aligned text without borders. When it does not fit, shrink the widest columns first and wrap cells */
function renderTable(header: string[], rows: string[][], w: number, marks: Mark[]): string[] {
  const cols = header.length;
  const GAP = 2;
  const isRisk = header.map((h) => COLUMN_RISK.test(h.normalize("NFKC")));
  const cell = (r: string[], c: number, strong?: string) => inline(r[c] ?? "", { marks, ...(strong ? { strong } : {}) });
  const natural = Array.from({ length: cols }, (_, c) =>
    Math.max(width(header[c] ?? ""), ...rows.map((r) => width(cell(r, c)))),
  );
  const avail = Math.max(cols * 4, w - GAP * (cols - 1));
  const widths = [...natural];
  while (widths.reduce((a, b) => a + b, 0) > avail) {
    const max = Math.max(...widths);
    const i = widths.indexOf(max);
    if (max <= 4) break;
    widths[i] = max - 1;
  }
  const out: string[] = [];
  const emit = (cells: string[], pre: string) => {
    const wrapped = cells.map((t, c) => wrap(t, widths[c]!));
    const h = Math.max(...wrapped.map((x) => x.length));
    for (let k = 0; k < h; k++) {
      const parts = wrapped.map((x, c) => {
        const s = x[k] ?? "";
        return padEnd(pre ? `${pre}${s}${RESET}` : s, widths[c]!);
      });
      out.push(parts.join(" ".repeat(GAP)).replace(/\s+$/, ""));
    }
  };
  emit(header, BOLD);
  for (const r of rows) {
    emit(
      Array.from({ length: cols }, (_, c) => cell(r, c, isRisk[c] ? STRONG_RISK : undefined)),
      "",
    );
  }
  return out;
}

export interface Rendered {
  lines: string[];
  /** Rows (in `lines`) of the footnote definitions, in order */
  footnotes: { id: string; row: number }[];
  /** For too-wide diagram rows, the full row before truncation (null for other rows); these are what scrolls sideways */
  wide: (string | null)[];
}

export interface MarkdownOpts {
  /** Add "f for full width" to the diagram note (when switching to full width is possible) */
  fullHint?: boolean;
  /** Display language for UI-owned strings (callout labels, diagram notes) */
  lang?: Lang;
  /** Highlights for terms (not applied under the Terms heading) */
  marks?: Mark[];
  /** Normalized Terms headings (marks are skipped inside that section) */
  termsHeadings?: string[];
}

/** Markdown to terminal lines (already wrapped to display width w) */
export function renderMarkdown(markdown: string, w: number, opts: MarkdownOpts = {}): string[] {
  return renderMarkdownRich(markdown, w, opts).lines;
}

export function renderMarkdownRich(markdown: string, w: number, opts: MarkdownOpts = {}): Rendered {
  const lang = opts.lang ?? "en";
  const lines = toLines(markdown);
  const { inFence, blocks } = scanFences(lines);
  const out: string[] = [];
  const wideRows = new Map<number, string>();
  const footnotes: { id: string; row: number }[] = [];
  let marks = opts.marks ?? [];
  const inl = (x: string, o: InlineOpts = {}) => inline(x, { marks, ...o });
  const gap = () => {
    if (out.length && out.at(-1) !== "") out.push("");
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const block = blocks.find((b) => b.start === i);
    if (block) {
      const closed = block.end > block.start && /^ {0,3}(`{3,}|~{3,})\s*$/.test(lines[block.end]!);
      const body = lines.slice(block.start + 1, closed ? block.end : block.end + 1);
      gap();
      if (block.lang === "mermaid") {
        const fig = renderMermaid(body.join("\n"));
        if (fig.ok) {
          if (fig.width > w) {
            out.push(...wrap(`${DIM}${t(lang, opts.fullHint === false ? "figure_note" : "figure_note_full", { width: fig.width })}${RESET}`, w));
            for (const l of fig.lines) {
              if (width(l) > w) wideRows.set(out.length, l);
              out.push(sliceCols(l, 0, w));
            }
          } else out.push(...fig.lines);
        } else {
          out.push(`${DIM}${t(lang, "figure_failed")}${RESET}`);
          for (const l of body) out.push(...wrap(`${DIM}  ${l}${RESET}`, w));
        }
      } else if (block.lang === "diff") {
        for (const l of body) out.push(...wrap(`  ${diffLine(l)}`, w));
      } else {
        for (const l of body) out.push(...wrap(`${DIM}  ${l}${RESET}`, w));
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
    const h = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      gap();
      marks = opts.termsHeadings?.includes(normalizeHeading(h[2]!)) ? [] : (opts.marks ?? []);
      out.push(...wrap(`${BOLD}${inline(h[2]!, { base: BOLD })}${RESET}`, w));
      i++;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && findTables(lines, inFence, i, i + 2).length) {
      let end = i + 2;
      while (end < lines.length && !inFence[end] && lines[end]!.includes("|") && lines[end]!.trim() !== "") end++;
      const t = findTables(lines, inFence, i, end)[0]!;
      gap();
      out.push(...renderTable(t.header, t.rows, w, marks));
      out.push("");
      i = end;
      continue;
    }
    if (/^ {0,3}>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i]!)) {
        quote.push(lines[i]!.replace(/^ {0,3}>\s?/, ""));
        i++;
      }
      gap();
      const m = /^\[!(NOTE|TIP|WARNING|CAUTION)\]\s*(.*)$/i.exec(quote[0]!.trim());
      const spec = m ? CALLOUTS[m[1]!.toUpperCase()]! : null;
      const bodyLines = spec ? [...(m![2]! ? [m![2]!] : []), ...quote.slice(1)] : quote;
      const color = spec?.color ?? DIM;
      const bar = `${color}▌${RESET} `;
      if (spec) out.push(`${color}▌ ${BOLD}${t(lang, spec.label)}${RESET}`);
      const paras: string[][] = [[]];
      for (const l of bodyLines) {
        if (l.trim() === "") paras.push([]);
        else paras.at(-1)!.push(l);
      }
      paras.forEach((p, k) => {
        if (!p.length) return;
        if (k > 0) out.push(bar.trimEnd());
        for (const l of wrap(inl(joinSoft(p)), w - 2)) out.push(bar + l);
      });
      out.push("");
      continue;
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      const indent = Math.min(6, li[1]!.length);
      const mark = /^\d/.test(li[2]!) ? li[2]! : "•";
      const item: string[] = [li[3]!];
      i++;
      while (i < lines.length && lines[i]!.trim() !== "" && !/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i]!) && !inFence[i] && !/^ {0,3}(#{1,6}\s|>)/.test(lines[i]!) && !/^ {0,3}\[\^[^\]\s]+\]:/.test(lines[i]!)) {
        item.push(lines[i]!);
        i++;
      }
      const lead = " ".repeat(indent) + mark + " ";
      const pad = " ".repeat(width(lead));
      wrap(inl(joinSoft(item)), Math.max(8, w - width(lead))).forEach((l, k) => out.push((k === 0 ? lead : pad) + l));
      continue;
    }
    const fn = /^ {0,3}\[\^([^\]\s]+)\]:\s*(.*)$/.exec(line);
    if (fn) {
      const item: string[] = [fn[2]!];
      i++;
      while (i < lines.length && /^\s{2,}\S/.test(lines[i]!) && !inFence[i]) item.push(lines[i++]!);
      const lead = `${DIM}[${fn[1]}]${RESET} `;
      const pad = " ".repeat(width(lead));
      footnotes.push({ id: fn[1]!, row: out.length });
      wrap(inl(joinSoft(item)), Math.max(8, w - width(lead))).forEach((l, k) => out.push((k === 0 ? lead : pad) + l));
      continue;
    }
    // Paragraph
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !blocks.some((b) => b.start === i) &&
      !/^ {0,3}(#{1,6}\s|>)/.test(lines[i]!) &&
      !/^ {0,3}\[\^[^\]\s]+\]:/.test(lines[i]!) &&
      !(para.length && /^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i]!))
    ) {
      para.push(lines[i]!);
      i++;
    }
    out.push(...wrap(inl(joinSoft(para)), w));
  }
  while (out.at(-1) === "") out.pop();
  return { lines: out, footnotes, wide: out.map((_, k) => wideRows.get(k) ?? null) };
}
