import { BOLD, CYAN, DIM, GREEN, MAGENTA, RESET, STRONG_RISK, YELLOW, inline, renderMarkdown } from "./markdown.js";
import { elapsed, type Card, type Chip, type ScreenModel } from "./model.js";
import { padEnd, truncate, width, wrap } from "./width.js";

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
  /** 一覧を開いているとき */
  list: { items: ListItem[]; index: number } | null;
  /** 背景の先頭行 */
  scroll: number;
  now: number;
}

export interface Size {
  cols: number;
  rows: number;
}

export interface Frame {
  text: string;
  lines: string[];
  /** 背景を下に送れる最大量(画面外に続きが無ければ 0) */
  scrollMax: number;
}

export const WIDE_COLS = 120;

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

function recBox(text: string, w: number): string[] {
  const inner = Math.max(10, w - 4);
  const body = renderMarkdown(text, inner);
  const top = `${DIM}┌─${RESET} ${BOLD}推奨${RESET} ${DIM}${"─".repeat(Math.max(0, w - 9))}┐${RESET}`;
  const bottom = `${DIM}└${"─".repeat(Math.max(0, w - 2))}┘${RESET}`;
  return [top, ...body.map((l) => `${DIM}│${RESET} ${padEnd(l, inner)} ${DIM}│${RESET}`), bottom];
}

function rightColumn(v: View, m: ScreenModel, w: number): Column {
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
  if (m.recommendation) lines.push(...recBox(m.recommendation, w), "");

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

function leftColumn(m: ScreenModel, w: number): string[] {
  if (m.backgroundNote) return wrap(`${DIM}${m.backgroundNote}${RESET}`, w);
  if (m.background) return renderMarkdown(m.background, w);
  return [];
}

// ---- 画面 ----

function window(lines: string[], rows: number, offset: number): string[] {
  const out = lines.slice(offset, offset + rows);
  while (out.length < rows) out.push("");
  return out;
}

function footer(v: View, cols: number): string {
  let left: string;
  if (v.list) left = `${DIM}j/k 移動  Enter 表示  Esc 戻る${RESET}`;
  else left = `保留 ${v.pending}  ${DIM}h/l 切替  b 一覧  q 終了${RESET}`;
  if (v.toast) left += `  ${BOLD}${GREEN}${v.toast}${RESET}`;
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

export function renderFrame(v: View, size: Size): Frame {
  const { cols, rows } = size;
  const m = v.model;
  const fin = (body: string[], head: string[], scrollMax = 0): Frame => {
    const lines = [...head, ...body, footer(v, cols)].map((l) => truncate(l, cols));
    return { text: lines.join("\n"), lines, scrollMax };
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
    const leftW = Math.floor((cols - SEP.length) / 2);
    const rightW = cols - SEP.length - leftW;
    const leftAll = leftColumn(m, leftW);
    const right = rightColumn(v, m, rightW);

    // 左: 収まらないときだけ、最終行に「続き」の印を出してスクロールできるようにする
    let left: string[];
    let scrollMax = 0;
    if (leftAll.length <= bodyRows) left = window(leftAll, bodyRows, 0);
    else {
      const size = bodyRows - 1;
      scrollMax = leftAll.length - size;
      const off = Math.min(v.scroll, scrollMax);
      left = window(leftAll, size, off);
      left.push(`${DIM}${off > 0 ? "▲" : " "}${off < scrollMax ? "▼" : " "} Ctrl-U/D でスクロール (${off + 1}-${Math.min(leftAll.length, off + size)}/${leftAll.length})${RESET}`);
    }

    // 右: 収まらないときはカーソルのカードが見える位置まで送り、ヒントは最下段に固定
    let rcol: string[];
    const all = [...right.lines, "", `${DIM}${right.hint}${RESET}`];
    if (all.length <= bodyRows) rcol = window(all, bodyRows, 0);
    else {
      const size = bodyRows - 1;
      const [fs, fe] = right.focus;
      const off = Math.max(0, Math.min(fs, fe - size));
      rcol = window(right.lines, size, off);
      rcol.push(`${DIM}${right.hint}${RESET}`);
    }

    const body = left.map((l, i) => `${padEnd(truncate(l, leftW), leftW)}${DIM}${SEP}${RESET}${truncate(rcol[i] ?? "", rightW)}`);
    return fin(body, head, scrollMax);
  }

  // 狭い: 上下。判断を先に置き(いつも届くように)、背景を下に続ける
  const right = rightColumn(v, m, cols);
  const leftAll = leftColumn(m, cols);
  const all = [...right.lines, "", `${DIM}${right.hint}${RESET}`, ...(leftAll.length ? ["", `${DIM}${"─".repeat(cols)}${RESET}`, ...leftAll] : [])];
  const scrollMax = Math.max(0, all.length - bodyRows);
  let off = Math.min(v.scroll, scrollMax);
  if (off === 0) off = Math.max(0, Math.min(right.focus[0], right.focus[1] - bodyRows));
  return fin(window(all, bodyRows, off), head, scrollMax);
}

export function render(v: View, size: Size): string {
  return renderFrame(v, size).text;
}
