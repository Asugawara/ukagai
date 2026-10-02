import { renderMermaidASCII } from "beautiful-mermaid";
import { width } from "./width.js";

// ```mermaid ブロック → 端末の罫線テキスト(beautiful-mermaid、同期・DOM 無し)。
// 図は幅に依らず同じ絵なので、定義ごとに 1 度だけ描いて覚えておく。

/** これを超えて描画にかかったら失敗扱いにする(同期処理なので事後の判定) */
export const RENDER_BUDGET_MS = 2000;

export type MermaidResult = { ok: true; lines: string[]; width: number } | { ok: false };

const cache = new Map<string, MermaidResult>();

// beautiful-mermaid は文字幅を 1 と数えるので、全角文字のままだと箱がずれる。
// 全角 1 文字を「私用領域 2 文字」に置き換えて描き、描いたあとで全角に戻す。
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

export function renderMermaid(source: string): MermaidResult {
  const hit = cache.get(source);
  if (hit) return hit;
  let res: MermaidResult;
  try {
    const table: string[] = [];
    const t0 = Date.now();
    const text = renderMermaidASCII(protectWide(source, table), { colorMode: "none" });
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
