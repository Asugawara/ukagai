// Terminal display width (full-width characters take 2 columns) and wrapping based on it. Handles strings containing ANSI.

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
  // A run of combining characters only
  if (/^\p{M}+$/u.test(g)) return 0;
  return isWide(cp) ? 2 : 1;
}

/** Display width; ANSI sequences are not counted */
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

/** Cut to fit display width max (ANSI is preserved). Appends a reset when cut */
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

// Characters that must not start a line (punctuation, closing brackets). If wrapping would put one there, move the previous character to the next line with it
const NO_LINE_START = new Set(Array.from("。、，．）」』】〕〉》！？：；,.!?)]}"));

/**
 * Wrap at display width max. Break at spaces where possible, otherwise per character (Japanese etc.).
 * ANSI decoration carries across lines (reset at the end of a line, re-applied at the start of the next).
 */
export function wrap(s: string, max: number): string[] {
  if (max < 1) return [s];
  const lines: string[] = [];
  let cur = "";
  let curW = 0;
  let active = ""; // Currently active SGR
  let lastBreak = -1; // Position in cur right after a space (string index)
  let widthAtBreak = 0;
  let lastCharAt = -1; // Position in cur where the previous character starts (string index)
  let lastCharW = 0;
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
      lastCharAt = -1;
      continue;
    }
    if (curW + t.w > max) {
      if (t.text === " ") {
        // Drop trailing spaces at the end of a line
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
      } else if (NO_LINE_START.has(t.text) && lastCharAt > 0 && lastCharW > 0 && cur[lastCharAt] !== " ") {
        // Kinsoku: do not start a line with punctuation; move the previous character to the next line with it
        const head = cur.slice(0, lastCharAt);
        flush(/\x1b\[/.test(head) && !head.endsWith("\x1b[0m") ? head + "\x1b[0m" : head);
        cur = active + cur.slice(lastCharAt);
        curW = lastCharW;
      } else {
        flush(cur);
        cur = active;
        curW = 0;
      }
      lastBreak = -1;
    }
    lastCharAt = cur.length;
    lastCharW = t.w;
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

/** Slice display columns [from, from+max) (ANSI is preserved). A column that splits a full-width character becomes a space */
export function sliceCols(s: string, from: number, max: number): string {
  let w = 0;
  let out = "";
  let started = false;
  let active = false;
  for (const t of tokens(s)) {
    if (t.kind === "ansi") {
      out += t.text;
      active = t.text !== "\x1b[0m";
      continue;
    }
    const end = w + t.w;
    w = end;
    if (end <= from) continue;
    if (!started && w - t.w < from) {
      // A full-width character was split at the left edge
      out += " ".repeat(end - from);
      started = true;
      continue;
    }
    started = true;
    if (end - from > max) {
      if (end - t.w - from < max) out += " ".repeat(max - (end - t.w - from));
      break;
    }
    out += t.text;
  }
  return active ? out + "\x1b[0m" : out;
}
