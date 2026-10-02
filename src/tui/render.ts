import { BOLD, CYAN, DIM, GREEN, MAGENTA, RESET, STRONG_RISK, YELLOW, inline, renderMarkdown, renderMarkdownRich, type Rendered } from "./markdown.js";
import { elapsed, type Card, type Chip, type ScreenModel } from "./model.js";
import { padEnd, sliceCols, truncate, width, wrap } from "./width.js";

// ScreenModel + 操作状態 → 画面(文字列)。I/O なし。

export interface ListItem {
  title: string;
  /** 人の作業待ち */
  blocker: boolean;
  chips: Chip[];
  kindLabel: string;
  createdAt: string;
  noExplanation: boolean;
  current: boolean;
}

export interface View {
  model: ScreenModel | null;
  /** カード(+ 末尾の自由記述)の位置。計画ではボタンの位置 */
  cursor: number;
  selected: ReadonlySet<string>;
  free: { on: boolean; text: string };
  /** 入力中(自由記述 / 却下理由)の文字列。null なら入力していない */
  input: { kind: "free" | "reason"; text: string } | null;
  reason: string;
  pending: number;
  toast: string | null;
  /** クリップボードに送れるか */
  copy: boolean;
  /** 長い推奨ボックスを全文で表示(`.`) */
  recFull: boolean;
  /** 一覧を開いているとき */
  list: { items: ListItem[]; index: number } | null;
  /** 背景(上下配置では画面全体)の先頭行 */
  scroll: number;
  /** 判断列の先頭行。null ならカーソルに追従 */
  rscroll: number | null;
  /** 反転表示する列(左右配置のとき) */
  focus: "background" | "decision";
  /** 幅超過の図の横位置(桁) */
  hscroll: number;
  /** 背景を全幅で表示(判断の列を隠す) */
  full: boolean;
  /** 「図が列幅を超えています」の案内を出す */
  fullHint: boolean;
  now: number;
}

export interface Size {
  cols: number;
  rows: number;
}

export interface Frame {
  text: string;
  lines: string[];
  /** 背景(上下配置では画面全体)を下に送れる最大量。画面外に続きが無ければ 0 */
  scrollMax: number;
  /** 左右配置か */
  wide: boolean;
  /** 左右配置で、右の列が始まる桁(0 始まり) */
  split: number;
  /** 判断列を下に送れる最大量と、いま見えている先頭行 */
  rightMax: number;
  rightOff: number;
  /** 上下配置でいま見えている先頭行 */
  off: number;
  /** 本文の窓の行数(半画面スクロールの目安) */
  bodyRows: number;
  /** 図の横スクロールの最大量(0 ならずらせる図が無い) */
  hMax: number;
  /** 背景を全幅表示中 */
  full: boolean;
  /** 列幅を超える図があり、端末の全幅なら収まる */
  figOver: boolean;
}

export const WIDE_COLS = 120;

/** 左右配置の判断列の幅。残りを背景に充てる */
export const decisionWidth = (cols: number): number => Math.max(44, Math.min(58, Math.round(cols * 0.34)));

const CHIP_COLOR: Record<Chip["kind"], string> = { repo: MAGENTA, branch: GREEN, worktree: YELLOW };
const BADGE_IRREVERSIBLE = "\x1b[41;97m";
const BADGE_COSTLY = "\x1b[43;30m";
const BADGE_REC = "\x1b[42;30m";
const BADGE_BLOCKER = "\x1b[43;30m";

const chip = (c: Chip): string => `${CHIP_COLOR[c.kind]}${c.text}${RESET}`;
export const chipsText = (chips: Chip[]): string => chips.map(chip).join(" ");

function metaLine(m: ScreenModel, now: number, cols: number): string {
  const parts = [chipsText(m.chips), `${DIM}${m.cwd}${RESET}`];
  if (m.reversibility === "irreversible") parts.push(`${BADGE_IRREVERSIBLE} 元に戻せない ${RESET}`);
  else if (m.reversibility === "costly") parts.push(`${BADGE_COSTLY} 戻すのにコストがかかる ${RESET}`);
  if (m.scope) parts.push(`${DIM}${m.scope}${RESET}`);
  parts.push(`${DIM}${elapsed(m.createdAt, now)}${RESET}`);
  const line = parts.join("  ");
  // 収まらないときは cwd を落とす(chips と可逆性は残す)
  return width(line) <= cols ? line : parts.filter((_, i) => i !== 1).join("  ");
}

// ---- 右: 判断 ----

interface Column {
  lines: string[];
  /** カーソル位置のカードが占める行 [start, end) */
  focus: [number, number];
  hint: string;
}

function cardLines(card: Card, w: number, o: { cursor: boolean; selected: boolean; multi: boolean }): string[] {
  const mark = o.multi ? (o.selected ? "[x]" : "[ ]") : o.selected ? "●" : "○";
  const lead = `${o.cursor ? `${BOLD}▸${RESET}` : " "} ${o.selected ? CYAN : ""}${mark}${RESET} `;
  const label = o.cursor ? `${BOLD}${card.label}${RESET}` : card.label;
  const head = `${label}${card.recommended ? `  ${BADGE_REC} 推奨 ${RESET}` : ""}`;
  const pad = " ".repeat(width(lead));
  const out = wrap(head, Math.max(8, w - width(lead))).map((l, k) => (k === 0 ? lead : pad) + l);
  for (const l of card.lines) {
    const body = l.risk ? `${DIM}${inline(l.text, { strong: STRONG_RISK, base: DIM })}${RESET}` : l.md ? inline(l.text) : l.text;
    for (const x of wrap(body, Math.max(8, w - width(lead)))) out.push(pad + x);
  }
  return out;
}

/** 推奨ボックスが列の高さの半分を超えるとき、本文を何行で切るか */
const REC_CUT_ROWS = 8;

function recBox(text: string, w: number, o: { rows: number; full: boolean }): string[] {
  const inner = Math.max(10, w - 4);
  let body = renderMarkdown(text, inner);
  if (body.length + 2 > o.rows / 2) {
    body = o.full
      ? [...body, `${DIM}… (. で折りたたむ)${RESET}`]
      : [...body.slice(0, REC_CUT_ROWS), `${DIM}… (. で全文)${RESET}`];
  }
  const top = `${DIM}┌─${RESET} ${BOLD}推奨${RESET} ${DIM}${"─".repeat(Math.max(0, w - 9))}┐${RESET}`;
  const bottom = `${DIM}└${"─".repeat(Math.max(0, w - 2))}┘${RESET}`;
  return [top, ...body.map((l) => `${DIM}│${RESET} ${padEnd(l, inner)} ${DIM}│${RESET}`), bottom];
}

function rightColumn(v: View, m: ScreenModel, w: number, rows: number): Column {
  const lines: string[] = [];
  let focus: [number, number] = [0, 0];

  if (m.unsupported) {
    lines.push(...wrap(`${YELLOW}${m.unsupported}${RESET}`, w));
    return { lines, focus, hint: "h/l 保留の切替" };
  }

  if (m.kind === "plan") {
    lines.push(`${BOLD}この計画を承認しますか${RESET}`, "");
    const buttons: [string, string][] = [["y", "承認"], ["a", "承認して auto"], ["n", "却下"]];
    buttons.forEach(([k, label], i) => {
      const start = lines.length;
      const on = v.cursor === i;
      lines.push(`${on ? `${BOLD}▸${RESET}` : " "} ${CYAN}[${k}]${RESET} ${on ? BOLD : ""}${label}${RESET}`);
      if (on) focus = [start, lines.length];
    });
    if (v.input?.kind === "reason") {
      lines.push("", ...wrap(`  理由: ${v.input.text}▏`, w));
    } else if (v.reason) {
      lines.push("", ...wrap(`${DIM}  理由: ${v.reason}${RESET}`, w));
    }
    return {
      lines,
      focus,
      hint: v.input ? "Enter 却下を送る · Esc 取りやめ" : "j/k 移動 · Enter 決定 · y 承認 · a auto · n 却下",
    };
  }

  const q = m.question!;
  if (!q.v2) {
    if (m.title !== q.text || !m.hasExplanation) {
      lines.push(...wrap(`${DIM}${q.header}${RESET}`, w));
      if (m.title !== q.text) lines.push(...wrap(`${BOLD}${q.text}${RESET}`, w));
      lines.push("");
    }
  }
  if (m.todo) lines.push(`${BOLD}${YELLOW}人にしてほしいこと${RESET}`, ...renderMarkdown(m.todo, w), "");
  if (m.recommendation) lines.push(...recBox(m.recommendation, w, { rows, full: v.recFull }), "");

  q.cards.forEach((c, i) => {
    const start = lines.length;
    const on = v.cursor === i;
    lines.push(...cardLines(c, w, { cursor: on, selected: v.selected.has(c.value), multi: q.multi }));
    if (on) focus = [start, lines.length];
    lines.push("");
  });
  const fi = q.cards.length;
  const fstart = lines.length;
  const fon = v.cursor === fi;
  const typing = v.input?.kind === "free";
  const ftext = typing ? `${v.input!.text}▏` : v.free.text;
  const lead = `${fon ? `${BOLD}▸${RESET}` : " "} ${v.free.on ? CYAN : ""}${q.multi ? (v.free.on ? "[x]" : "[ ]") : v.free.on ? "●" : "○"}${RESET} `;
  lines.push(`${lead}${fon ? BOLD : ""}自由記述${RESET}  ${CYAN}i${RESET}`);
  if (ftext) for (const x of wrap(ftext, Math.max(8, w - width(lead)))) lines.push(" ".repeat(width(lead)) + x);
  if (fon) focus = [fstart, lines.length];

  const hint = typing
    ? "Enter 確定 · Esc 取りやめ"
    : `j/k 移動 · ${q.multi ? "Space 切替 · " : ""}Enter 回答${m.todoCode.length ? ` · ${v.copy ? "c コピー" : "コピー非対応"}` : ""} · i 自由記述`;
  return { lines, focus, hint };
}

// ---- 左: 背景 ----

function leftColumn(m: ScreenModel, w: number, fullHint = true): Rendered {
  if (m.backgroundNote) {
    const lines = wrap(`${DIM}${m.backgroundNote}${RESET}`, w);
    return { lines, wide: lines.map(() => null) };
  }
  if (m.background) return renderMarkdownRich(m.background, w, { fullHint });
  return { lines: [], wide: [] };
}

/** 幅超過の図の行だけ hoff 桁ずらす。ずらせる最大量と、図の最大幅も返す */
function shifted(r: Rendered, w: number, hoff: number): { lines: string[]; hMax: number; figW: number } {
  const figW = Math.max(0, ...r.wide.map((l) => (l ? width(l) : 0)));
  const hMax = Math.max(0, figW - w);
  const off = Math.min(hoff, hMax);
  return { lines: r.lines.map((l, i) => (r.wide[i] ? sliceCols(r.wide[i]!, off, w) : l)), hMax, figW };
}

// ---- 画面 ----

function window(lines: string[], rows: number, offset: number): string[] {
  const out = lines.slice(offset, offset + rows);
  while (out.length < rows) out.push("");
  return out;
}

function footer(v: View, cols: number, overflow: boolean, o: { full?: boolean; hint?: boolean; hscrollable?: boolean } = {}): string {
  const hscrollable = o.hscrollable ?? false;
  let left: string;
  if (v.list) left = `${DIM}j/k 移動  Enter 表示  Esc 戻る${RESET}`;
  else if (o.full) left = `保留 ${v.pending}  ${DIM}f / Esc で戻る  ←→ 横スクロール  j/k PgUp/PgDn 縦  q 終了${RESET}`;
  else {
    left = `保留 ${v.pending}  ${DIM}h/l 切替${hscrollable ? "  ←→ 図を横スクロール" : ""}  b 一覧  q 終了${overflow ? "  PgUp/PgDn 背景をスクロール · Tab 列の切替" : ""}${RESET}`;
  }
  if (v.toast) left += `  ${BOLD}${GREEN}${v.toast}${RESET}`;
  if (o.hint) left += `  ${BOLD}${YELLOW}図が列幅を超えています: f で全幅表示${RESET}`;
  return truncate(left, cols);
}

function listBody(v: View, cols: number, rows: number): string[] {
  const out: string[] = [`${BOLD}保留の一覧${RESET}`, ""];
  const l = v.list!;
  l.items.forEach((it, i) => {
    const on = i === l.index;
    const meta = [it.kindLabel, elapsed(it.createdAt, v.now), it.noExplanation ? "説明なし" : "", it.current ? "表示中" : ""]
      .filter(Boolean)
      .join(" · ");
    const mark = it.blocker ? `${BADGE_BLOCKER} 作業 ${RESET} ` : "";
    out.push(truncate(`${on ? `${BOLD}▸${RESET}` : " "} ${mark}${on ? BOLD : ""}${it.title}${RESET}`, cols));
    out.push(truncate(`    ${chipsText(it.chips)}  ${DIM}${meta}${RESET}`, cols));
  });
  return window(out, rows, 0);
}

/** 右端に置く簡易スクロールバー(`│` の列に `█` で位置)。size 行ぶん */
function scrollbar(size: number, total: number, off: number, max: number): string[] {
  const len = Math.max(1, Math.min(size, Math.round((size * size) / total)));
  const start = max > 0 ? Math.round((off / max) * (size - len)) : 0;
  return Array.from({ length: size }, (_, i) => (i >= start && i < start + len ? "█" : `${DIM}│${RESET}`));
}

/** 最下行の `▲▼ 1-20/58` */
function position(off: number, max: number, size: number, total: number, h?: { off: number; figW: number }): string {
  const hs = h && h.off > 0 ? ` ◀▶ ${h.off}/${h.figW}` : "";
  return `${DIM}${off > 0 ? "▲" : " "}${off < max ? "▼" : " "} ${off + 1}-${Math.min(total, off + size)}/${total}${hs}${RESET}`;
}

/** 溢れる列に、窓・スクロールバー・位置表示をかぶせる。w は列の幅(バー込み) */
function scrolled(all: string[], size: number, off: number, w: number, tail: string[], h?: { off: number; figW: number }): string[] {
  const max = all.length - size;
  const bar = scrollbar(size, all.length, off, max);
  const body = window(all, size, off).map((l, i) => `${padEnd(truncate(l, w - 1), w - 1)}${bar[i]}`);
  return [...body, truncate(position(off, max, size, all.length, h), w), ...tail];
}

export function renderFrame(v: View, size: Size): Frame {
  const { cols, rows } = size;
  const m = v.model;
  const fin = (body: string[], head: string[], meta: Partial<Frame> = {}, overflow = false): Frame => {
    const base = { scrollMax: 0, wide: false, split: 0, rightMax: 0, rightOff: 0, off: 0, bodyRows: Math.max(1, rows - 1), hMax: 0, full: false, figOver: false };
    const f = { ...base, ...meta };
    const lines = [...head, ...body, footer(v, cols, overflow, { full: f.full, hint: v.fullHint && f.figOver && !f.full, hscrollable: f.hMax > 0 })].map((l) => truncate(l, cols));
    return { text: lines.join("\n"), lines, ...f };
  };

  if (v.list) return fin(listBody(v, cols, rows - 1), []);

  if (!m) {
    const body = new Array<string>(Math.max(0, rows - 1)).fill("");
    const msg = "判断待ちはありません";
    const row = Math.floor((rows - 1) / 2);
    body[row] = " ".repeat(Math.max(0, Math.floor((cols - width(msg)) / 2))) + `${DIM}${msg}${RESET}`;
    return fin(body, []);
  }

  const head = [...(m.blocker ? [`${BADGE_BLOCKER} 人の作業待ち ${RESET}`] : []), metaLine(m, v.now, cols), ...wrap(`${BOLD}${m.title}${RESET}`, cols).slice(0, 2), `${DIM}${"─".repeat(cols)}${RESET}`];
  const bodyRows = Math.max(1, rows - head.length - 1);

  if (cols >= WIDE_COLS) {
    const SEP = " │ ";
    const full = v.full;
    const rightW = decisionWidth(cols);
    const leftW = full ? cols : cols - SEP.length - rightW;
    // 見出し行(フォーカスのある列を反転)を 1 行取り、残りが列の窓
    const winRows = Math.max(1, bodyRows - 1);
    const heading = (label: string, w: number, on: boolean) => padEnd(on ? `\x1b[7m ${label} ${RESET}` : `${DIM} ${label}${RESET}`, w);

    // 左: 溢れる(縦に長い、または横にずらせる図がある)ときは右端にバー、最下行に位置。収まるときはそのまま
    let leftR = leftColumn(m, leftW);
    const hasWide = leftR.wide.some(Boolean);
    const leftOver = leftR.lines.length > winRows || hasWide;
    let scrollMax = 0;
    let left: string[];
    let hMax = 0;
    let figW = 0;
    let textW = leftW;
    if (leftOver) {
      textW = leftW - 1;
      leftR = leftColumn(m, textW);
      const sh = shifted(leftR, textW, v.hscroll);
      hMax = sh.hMax;
      figW = sh.figW;
      const size = winRows - 1;
      scrollMax = Math.max(0, sh.lines.length - size);
      const off = Math.min(v.scroll, scrollMax);
      left = scrolled(sh.lines, size, off, leftW, [], { off: Math.min(v.hscroll, hMax), figW });
    } else left = window(leftR.lines, winRows, 0);
    const figOver = !full && hMax > 0 && figW <= cols - 1;
    const meta = { scrollMax, wide: true, bodyRows: winRows, hMax, full, figOver };

    if (full) {
      const body = [heading("背景(全幅)", cols, true), ...left.map((l) => truncate(l, cols))];
      return fin(body, head, { ...meta, split: cols }, leftOver);
    }

    // 右: 溢れるときはカーソルのカードが見える位置まで送る(手でスクロールしたらその位置)。ヒントは最下段に固定
    let right = rightColumn(v, m, rightW, winRows);
    const rightOver = right.lines.length + 2 > winRows;
    let rcol: string[];
    let rightMax = 0;
    let rightOff = 0;
    if (rightOver) {
      right = rightColumn(v, m, rightW - 1, winRows);
      const size = Math.max(1, winRows - 2);
      rightMax = Math.max(0, right.lines.length - size);
      const [fs, fe] = right.focus;
      const follow = Math.max(0, Math.min(fs, fe - size));
      rightOff = Math.min(rightMax, v.rscroll ?? follow);
      rcol = scrolled(right.lines, size, rightOff, rightW, [`${DIM}${right.hint}${RESET}`]);
    } else rcol = window([...right.lines, "", `${DIM}${right.hint}${RESET}`], winRows, 0);

    const body = [
      `${heading("背景", leftW, v.focus === "background")}${DIM}${SEP}${RESET}${heading("判断", rightW, v.focus === "decision")}`,
      ...left.map((l, i) => `${padEnd(truncate(l, leftW), leftW)}${DIM}${SEP}${RESET}${truncate(rcol[i] ?? "", rightW)}`),
    ];
    return fin(body, head, { ...meta, split: leftW + SEP.length, rightMax, rightOff }, leftOver || rightOver);
  }

  // 狭い: 上下。判断を先に置き(いつも届くように)、背景を下に続ける
  const right = rightColumn(v, m, cols - 1, bodyRows);
  const leftR = leftColumn(m, cols - 1, false);
  const sh = shifted(leftR, cols - 1, v.hscroll);
  const leftAll = sh.lines;
  const all = [...right.lines, "", `${DIM}${right.hint}${RESET}`, ...(leftAll.length ? ["", `${DIM}${"─".repeat(cols - 1)}${RESET}`, ...leftAll] : [])];
  const hOff = Math.min(v.hscroll, sh.hMax);
  if (all.length <= bodyRows && sh.hMax === 0) return fin(window(all, bodyRows, 0), head, { bodyRows });
  const win = bodyRows - 1;
  const scrollMax = Math.max(0, all.length - win);
  let off = Math.min(v.scroll, scrollMax);
  if (off === 0) off = Math.max(0, Math.min(right.focus[0], right.focus[1] - win));
  off = Math.min(off, scrollMax);
  return fin(scrolled(all, win, off, cols, [], { off: hOff, figW: sh.figW }), head, { scrollMax, off, bodyRows: win, hMax: sh.hMax }, true);
}

export function render(v: View, size: Size): string {
  return renderFrame(v, size).text;
}
