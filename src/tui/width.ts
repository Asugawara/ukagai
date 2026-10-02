// 端末の表示幅(全角 2 桁)と、それに基づく折り返し。ANSI を含む文字列も扱う。

const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

export const stripAnsi = (s: string): string => s.replace(ANSI, "");

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

function graphemeWidth(g: string): number {
  const cp = g.codePointAt(0) ?? 0;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  // 結合文字だけの塊
  if (/^\p{M}+$/u.test(g)) return 0;
  return isWide(cp) ? 2 : 1;
}

/** 表示幅。ANSI は数えない */
export function width(s: string): number {
  let w = 0;
  for (const { segment } of segmenter.segment(stripAnsi(s))) w += graphemeWidth(segment);
  return w;
}

type Token = { kind: "ansi" | "char"; text: string; w: number };

function tokens(s: string): Token[] {
  const out: Token[] = [];
  let last = 0;
  const push = (plain: string) => {
    for (const { segment } of segmenter.segment(plain)) out.push({ kind: "char", text: segment, w: graphemeWidth(segment) });
  };
  for (const m of s.matchAll(ANSI)) {
    push(s.slice(last, m.index));
    out.push({ kind: "ansi", text: m[0], w: 0 });
    last = m.index + m[0].length;
  }
  push(s.slice(last));
  return out;
}

/** 表示幅 max に収まるよう切る(ANSI は保つ)。切ったら末尾に reset を付ける */
export function truncate(s: string, max: number): string {
  if (width(s) <= max) return s;
  let w = 0;
  let out = "";
  for (const t of tokens(s)) {
    if (t.kind === "char") {
      if (w + t.w > max) break;
      w += t.w;
    }
    out += t.text;
  }
  return out + "\x1b[0m";
}

export function padEnd(s: string, w: number): string {
  const gap = w - width(s);
  return gap > 0 ? s + " ".repeat(gap) : s;
}

/**
 * 表示幅 max で折り返す。空白で切れる所は空白で、無ければ(日本語など)文字単位で切る。
 * ANSI の装飾は行をまたいで引き継ぐ(行末で reset、次行頭で再掲)。
 */
export function wrap(s: string, max: number): string[] {
  if (max < 1) return [s];
  const lines: string[] = [];
  let cur = "";
  let curW = 0;
  let active = ""; // 現在有効な SGR
  let lastBreak = -1; // cur 内で空白の直後の位置(文字列 index)
  let widthAtBreak = 0;
  const flush = (text: string) => lines.push(active && !text.endsWith("\x1b[0m") ? text + "\x1b[0m" : text);

  for (const t of tokens(s)) {
    if (t.kind === "ansi") {
      cur += t.text;
      active = t.text === "\x1b[0m" ? "" : active + t.text;
      continue;
    }
    if (t.text === "\n") {
      flush(cur);
      cur = active;
      curW = 0;
      lastBreak = -1;
      continue;
    }
    if (curW + t.w > max) {
      if (t.text === " ") {
        // 行末の空白は捨てる
        flush(cur.replace(/ +$/, ""));
        cur = active;
        curW = 0;
        lastBreak = -1;
        continue;
      }
      if (lastBreak > 0 && t.w === 1) {
        const head = cur.slice(0, lastBreak).replace(/ +$/, "");
        const tail = cur.slice(lastBreak);
        flush(head);
        cur = active + tail;
        curW = curW - widthAtBreak;
      } else {
        flush(cur);
        cur = active;
        curW = 0;
      }
      lastBreak = -1;
    }
    cur += t.text;
    curW += t.w;
    if (t.text === " ") {
      lastBreak = cur.length;
      widthAtBreak = curW;
    }
  }
  flush(cur);
  return lines;
}
