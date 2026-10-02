import { findTables, scanFences, toLines } from "../hook/explain.js";
import { renderMermaid } from "./mermaid.js";
import { padEnd, sliceCols, wrap, width } from "./width.js";

// Markdown の端末描画。行は表示幅 w 以内に折り返し済みで返す。

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

export interface InlineOpts {
  /** `**強調**` の色(既定: cyan 太字。リスク列は赤) */
  strong?: string;
  /** 範囲の外側の装飾。span を閉じたあとに再掲する */
  base?: string;
}

/** `**強調**` / `` `code` `` / `*em*` / リンクを ANSI に。前後の装飾は base に戻す */
export function inline(text: string, opts: InlineOpts = {}): string {
  const strong = opts.strong ?? STRONG;
  const base = opts.base ?? "";
  const close = RESET + base;
  return text
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/\\([|*`_])/g, "$1")
    .replace(/`([^`]+)`/g, (_, c: string) => `${DIM}${c}${close}`)
    .replace(/\*\*([^*]+)\*\*/g, (_, c: string) => `${strong}${c}${close}`)
    .replace(/(?<![*\w])\*([^*\s][^*]*)\*(?![*\w])/g, (_, c: string) => `\x1b[3m${c}${close}`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t: string, u: string) => `${t} ${DIM}(${u})${close}`);
}

const CALLOUTS: Record<string, { label: string; color: string }> = {
  NOTE: { label: "補足", color: BLUE },
  TIP: { label: "ヒント", color: GREEN },
  WARNING: { label: "注意", color: YELLOW },
  CAUTION: { label: "警告", color: RED },
};

function isCjk(ch: string | undefined): boolean {
  return ch !== undefined && width(ch) === 2;
}

/** 段落の行を 1 本に。日本語どうしの改行には空白を入れない */
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
  if (l.startsWith("@@")) return `${BLUE}${l}${RESET}`;
  if (l.startsWith("+")) return `${GREEN}${l}${RESET}`;
  if (l.startsWith("-")) return `${RED}${l}${RESET}`;
  return l;
}

/** 表を、列幅をそろえた罫線なしのテキストにする。収まらないときは広い列から縮めてセルを折り返す */
function renderTable(header: string[], rows: string[][], w: number): string[] {
  const cols = header.length;
  const GAP = 2;
  const isRisk = header.map((h) => h.normalize("NFKC").includes("リスク"));
  const cell = (r: string[], c: number, strong?: string) => inline(r[c] ?? "", strong ? { strong } : {});
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
  /** 幅超過の図の行は、切り詰める前の全体(行ごと。それ以外は null)。横スクロールの対象 */
  wide: (string | null)[];
}

export interface MarkdownOpts {
  /** 図の注記に「f で全幅」を添える(全幅表示に切り替えられるとき) */
  fullHint?: boolean;
}

/** Markdown → 端末の行(表示幅 w 以内に折り返し済み) */
export function renderMarkdown(markdown: string, w: number, opts: MarkdownOpts = {}): string[] {
  return renderMarkdownRich(markdown, w, opts).lines;
}

export function renderMarkdownRich(markdown: string, w: number, opts: MarkdownOpts = {}): Rendered {
  const lines = toLines(markdown);
  const { inFence, blocks } = scanFences(lines);
  const out: string[] = [];
  const wideRows = new Map<number, string>();
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
            out.push(...wrap(`${DIM}(図: 幅 ${fig.width} 桁。←→ / 横ホイールでスクロール${opts.fullHint === false ? "" : " · f で全幅"})${RESET}`, w));
            for (const l of fig.lines) {
              if (width(l) > w) wideRows.set(out.length, l);
              out.push(sliceCols(l, 0, w));
            }
          } else out.push(...fig.lines);
        } else {
          out.push(`${DIM}(図: 描画に失敗。以下は定義)${RESET}`);
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
      out.push(...wrap(`${BOLD}${inline(h[2]!, { base: BOLD })}${RESET}`, w));
      i++;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && findTables(lines, inFence, i, i + 2).length) {
      let end = i + 2;
      while (end < lines.length && !inFence[end] && lines[end]!.includes("|") && lines[end]!.trim() !== "") end++;
      const t = findTables(lines, inFence, i, end)[0]!;
      gap();
      out.push(...renderTable(t.header, t.rows, w));
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
      if (spec) out.push(`${color}▌ ${BOLD}${spec.label}${RESET}`);
      const paras: string[][] = [[]];
      for (const l of bodyLines) {
        if (l.trim() === "") paras.push([]);
        else paras.at(-1)!.push(l);
      }
      paras.forEach((p, k) => {
        if (!p.length) return;
        if (k > 0) out.push(bar.trimEnd());
        for (const l of wrap(inline(joinSoft(p)), w - 2)) out.push(bar + l);
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
      while (i < lines.length && lines[i]!.trim() !== "" && !/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i]!) && !inFence[i] && !/^ {0,3}(#{1,6}\s|>)/.test(lines[i]!)) {
        item.push(lines[i]!);
        i++;
      }
      const lead = " ".repeat(indent) + mark + " ";
      const pad = " ".repeat(width(lead));
      wrap(inline(joinSoft(item)), Math.max(8, w - width(lead))).forEach((l, k) => out.push((k === 0 ? lead : pad) + l));
      continue;
    }
    // 段落
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !blocks.some((b) => b.start === i) &&
      !/^ {0,3}(#{1,6}\s|>)/.test(lines[i]!) &&
      !(para.length && /^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i]!))
    ) {
      para.push(lines[i]!);
      i++;
    }
    out.push(...wrap(inline(joinSoft(para)), w));
  }
  while (out.at(-1) === "") out.pop();
  return { lines: out, wide: out.map((_, k) => wideRows.get(k) ?? null) };
}
