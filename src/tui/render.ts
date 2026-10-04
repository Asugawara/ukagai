import { BOLD, CYAN, DIM, GREEN, MAGENTA, RED, RESET, STRONG_RISK, YELLOW, inline, literalMarks, renderMarkdown, renderMarkdownRich, type Mark, type Rendered } from "./markdown.js";
import { IRREVERSIBLE_RE, UNDO_RE, elapsed, type Card, type Chip, type ScreenModel } from "./model.js";
import { SECTION, normalizeHeading } from "../hook/explain.js";
import { NONE_TYPES } from "./none.js";
import { CANNOT_REASONS, CANNOT_TERMS, cannotRows } from "./cannot.js";
import type { Lang } from "../settings/config.js";
import { t } from "./i18n.js";
import { oneLine, type HistoryItem } from "./history.js";
import { unreadNames, unreadSections, type PlanState } from "./plan.js";
import { padEnd, sliceCols, stripAnsi, truncate, width, wrap } from "./width.js";

// ScreenModel + interaction state to screen (strings). No I/O.

export interface ListItem {
  title: string;
  /** Waiting for the human */
  blocker: boolean;
  chips: Chip[];
  kindLabel: string;
  createdAt: string;
  noExplanation: boolean;
  current: boolean;
  /** A plan file (its row says `plan`, `N sections · M lines`; new ones carry the dot, the others are dim) */
  plan?: { sections: number; lines: number; isNew: boolean };
}

export interface View {
  model: ScreenModel | null;
  /** Display language */
  lang: Lang;
  /** The shown checkpoint's session is idle (its note says the reply arrives at the next tool call) */
  idle: boolean;
  /** ...and the reply will be typed into its terminal */
  terminal?: boolean;
  /** The `s` overlay (the session's instructions, chronological; cursor); null when closed */
  history: { index: number; items: HistoryItem[] } | null;
  /** One instruction shown in full in place of the background column */
  histDetail: HistoryItem | null;
  /** Position of the card (plus the trailing free text); the button position for a plan */
  cursor: number;
  selected: ReadonlySet<string>;
  free: { on: boolean; text: string };
  /** Text being typed (free text / rejection reason); null when not typing */
  input: { kind: "free" | "reason" | "note"; text: string } | null;
  /** The "None of these" reason picker (index into NONE_TYPES, optional note); null when closed */
  none: { index: number; text: string } | null;
  /** The "Can't answer this" picker (reason in force, row, terms with their ticks, note); null when closed */
  cannot: { index: number; pos: number; terms: readonly string[]; checked: ReadonlySet<string>; text: string } | null;
  /** A prompt that needs attention in the footer ("Press Enter again…", "Sent in 3… Undo (u)") */
  notice: string | null;
  reason: string;
  pending: number;
  toast: string | null;
  /** Connection to the server: shown in red at the left while down, and briefly announced when restored */
  conn: { state: "down"; server: string } | { state: "restored" } | null;
  /** Whether copying to the clipboard is possible */
  copy: boolean;
  /** Show a long recommendation box in full (`.`) */
  recFull: boolean;
  /** A long plan's open / read sections and contents cursor; null for any other decision */
  plan: PlanState | null;
  /** When the list is open */
  list: { items: ListItem[]; index: number } | null;
  /** First row of the background (the whole screen in the stacked layout) */
  scroll: number;
  /** First row of the decision column; null follows the cursor */
  rscroll: number | null;
  /** Column shown inverted (side-by-side layout) */
  focus: "background" | "decision";
  /** Horizontal position of a too-wide diagram (columns) */
  hscroll: number;
  /** Show the background at full width (hides the decision column) */
  full: boolean;
  /** Show the "diagram too wide" hint */
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
  /** Maximum amount the background (whole screen in the stacked layout) can scroll down; 0 if nothing continues off screen */
  scrollMax: number;
  /** Whether the layout is side by side */
  wide: boolean;
  /** In the side-by-side layout, the column where the right column starts (0-based) */
  split: number;
  /** Maximum amount the decision column can scroll down, and the first row currently visible */
  rightMax: number;
  rightOff: number;
  /** First row currently visible in the stacked layout */
  off: number;
  /** Rows in the body window (basis for half-screen scrolling) */
  bodyRows: number;
  /** Maximum horizontal scroll of diagrams (0 if no diagram can be shifted) */
  hMax: number;
  /** Whether the background is shown at full width */
  full: boolean;
  /** A diagram exceeds the column width but fits the full terminal width */
  figOver: boolean;
  /** Scroll positions (in the background scroll coordinates) of the footnote definitions */
  footRows: number[];
  /** Scroll positions of each contents row's heading in a long plan (a hidden H3 points at its H2) */
  secRows: number[];
}

/** The background column's lines, plus where each section of a long plan starts */
type Left = Rendered & { secRows: number[] };

export const WIDE_COLS = 120;

/** Width of the decision column in the side-by-side layout; the rest goes to the background */
export const decisionWidth = (cols: number): number => Math.max(44, Math.min(60, Math.round(cols * 0.4)));

const CHIP_COLOR: Record<Chip["kind"], string> = { repo: MAGENTA, branch: GREEN, worktree: YELLOW };
const BADGE_IRREVERSIBLE = "\x1b[41;97m";
const BADGE_COSTLY = "\x1b[43;30m";
const BADGE_REC = "\x1b[42;30m";
const BADGE_BLOCKER = "\x1b[43;30m";

/** Option colors (index 0..3); the same order everywhere on the screen */
export const OPT_COLORS = [CYAN, MAGENTA, YELLOW, "\x1b[94m"];
const FG_OFF = "\x1b[39m";

const termMarks = (m: ScreenModel): Mark[] => [
  ...literalMarks(m.terms.map((x) => x.term), "\x1b[4m", "\x1b[24m"),
  // Tokens Terms does not define: red + underline (not every terminal has a dotted underline)
  ...literalMarks(m.coinedTerms, "\x1b[31;4m", "\x1b[39;24m"),
];
/** Option labels colored in running text (labels shorter than 3 characters would match too much) */
const labelMarks = (m: ScreenModel): Mark[] =>
  (m.question?.cards ?? []).flatMap((c, i) => literalMarks(c.label.length >= 3 ? [c.label] : [], OPT_COLORS[i % 4]!, FG_OFF));
const riskMarks = (): Mark[] => [
  { re: IRREVERSIBLE_RE, open: "\x1b[4;31m", close: "\x1b[24;39m" },
  { re: UNDO_RE, open: "\x1b[4;32m", close: "\x1b[24;39m" },
];
const TERMS_HEADINGS = SECTION.terms.map(normalizeHeading);

const chip = (c: Chip): string => `${CHIP_COLOR[c.kind]}${c.text}${RESET}`;
export const chipsText = (chips: Chip[]): string => chips.map(chip).join(" ");

/** Affected names on one line: at most 6, the rest as +N */
function affectsText(m: ScreenModel): string {
  const shown = m.affects.slice(0, 6).map((x) => x.replace(/`/g, ""));
  const rest = m.affects.length - shown.length;
  return `⌁ ${shown.join(" · ")}${rest > 0 ? ` +${rest}` : ""}`;
}

function metaLine(m: ScreenModel, now: number, cols: number, lang: Lang): string {
  // The origin comes first: `repo ⎇ branch ⧉ worktree` in bold accent colour, whatever else is dropped
  const origin = `${BOLD}${CYAN}${m.chips.map((c) => c.text.replace(/^◈ /, "")).join(" ")}${RESET}`;
  const parts = [origin, `${DIM}${m.cwd}${RESET}`];
  if (m.blocker) parts.splice(1, 0, `${BADGE_BLOCKER} ${t(lang, "waiting_for_you")} ${RESET}`);
  if (m.reversibility === "irreversible") parts.push(`${BADGE_IRREVERSIBLE} ${t(lang, "irreversible")} ${RESET}`);
  else if (m.reversibility === "costly") parts.push(`${BADGE_COSTLY} ${t(lang, "costly")} ${RESET}`);
  else if (m.reversibility === "reversible") parts.push(`${GREEN}${t(lang, "reversible")}${RESET}`);
  if (m.scope) parts.push(`${DIM}${m.scope}${RESET}`);
  parts.push(`${DIM}${elapsed(m.createdAt, now, lang)}${RESET}`);
  const line = parts.join("  ");
  // When it does not fit, drop the cwd (keep the origin and reversibility)
  return width(line) <= cols ? line : truncate(parts.filter((_, i) => i !== (m.blocker ? 2 : 1)).join("  "), cols);
}

/** Backticked spans in bold cyan (the command of an approval) */
const codeSpans = (text: string, base = ""): string =>
  text.split(/(`[^`]+`)/).filter(Boolean).map((p) => (/^`[^`]+`$/.test(p) ? `${BOLD}${CYAN}${p.slice(1, -1)}${RESET}${base}` : p)).join("");

// ---- Right: decision ----

interface Column {
  lines: string[];
  /** Rows [start, end) occupied by the card under the cursor */
  focus: [number, number];
  hint: string;
}

function cardLines(card: Card, w: number, lang: Lang, o: { cursor: boolean; selected: boolean; multi: boolean; index: number; marks: Mark[] }): string[] {
  const mark = o.multi ? (o.selected ? "[x]" : "[ ]") : o.selected ? "●" : "○";
  const num = !o.multi && o.index < 9 ? `${DIM}${o.index + 1}${RESET} ` : "";
  const lead = `${num}${o.cursor ? `${BOLD}▸${RESET}` : " "} ${o.selected ? CYAN : ""}${mark}${RESET} `;
  const label = `${o.cursor ? BOLD : ""}${OPT_COLORS[o.index % 4]}${card.fixed ? t(lang, `fixed_${card.fixed}`) : card.label}${RESET}`;
  const head = `${label}${card.recommended ? `  ${BADGE_REC} ${t(lang, "recommended_badge")} ${RESET}` : ""}`;
  const pad = " ".repeat(width(lead));
  const out = wrap(head, Math.max(8, w - width(lead))).map((l, k) => (k === 0 ? lead : pad) + l);
  for (const l of card.lines) {
    const body = l.risk
      ? `${DIM}${inline(l.text, { strong: STRONG_RISK, base: DIM, marks: [...riskMarks(), ...o.marks] })}${RESET}`
      : l.name
        ? `${DIM}${l.name}:${RESET} ${inline(l.text, { marks: o.marks })}`
        : l.md
          ? inline(l.text, { marks: o.marks })
          : l.text;
    for (const x of wrap(body, Math.max(8, w - width(lead)))) out.push(pad + x);
  }
  return out;
}

/** How many body rows to keep when the recommendation box exceeds half the column height */
const REC_CUT_ROWS = 8;

function recBox(text: string, w: number, o: { rows: number; full: boolean; lang: Lang; title?: string; always?: boolean; marks?: Mark[] }): string[] {
  const inner = Math.max(10, w - 4);
  const title = o.title ?? t(o.lang, "recommendation");
  let body = renderMarkdown(text, inner, { lang: o.lang, ...(o.marks ? { marks: o.marks } : {}) });
  if (body.length > REC_CUT_ROWS && (o.always || body.length + 2 > o.rows / 2)) {
    body = o.full
      ? [...body, `${DIM}${t(o.lang, "rec_collapse")}${RESET}`]
      : [...body.slice(0, REC_CUT_ROWS), `${DIM}${t(o.lang, "rec_expand")}${RESET}`];
  }
  const top = `${DIM}┌─${RESET} ${BOLD}${title}${RESET} ${DIM}${"─".repeat(Math.max(0, w - 5 - width(title)))}┐${RESET}`;
  const bottom = `${DIM}└${"─".repeat(Math.max(0, w - 2))}┘${RESET}`;
  return [top, ...body.map((l) => `${DIM}│${RESET} ${padEnd(l, inner)} ${DIM}│${RESET}`), bottom];
}

/** Join hint parts by importance; when too wide for w, cut with … (the leading parts stay visible) */
function fitHint(parts: string[], w: number): string {
  const s = parts.join(" · ");
  return width(s) <= w ? s : `${truncate(s, Math.max(1, w - 1))}…`;
}

function rightColumn(v: View, m: ScreenModel, w: number, rows: number): Column {
  const lang = v.lang;
  const lines: string[] = [];
  let focus: [number, number] = [0, 0];

  if (m.unsupported) {
    lines.push(...wrap(`${YELLOW}${m.unsupported}${RESET}`, w));
    return { lines, focus, hint: t(lang, "hint_unsupported") };
  }

  if (m.kind === "plan") {
    if (m.impact) lines.push(...recBox(m.impact, w, { rows, full: v.recFull, lang, title: t(lang, "impact_title"), always: true }), "");
    const ro = !!m.readonly;
    const toc = m.plan && v.plan ? { p: m.plan, st: v.plan } : null;
    const unread = !ro && toc ? unreadSections(toc.p.outline, toc.st) : [];
    if (toc) {
      // The contents: a window of rows around the cursor so the buttons stay on screen (the rest is "▲ n" / "▼ n")
      const es = toc.p.outline.entries;
      const budget = Math.max(4, ro ? rows - lines.length - 4 : rows - lines.length - 1 - 2 - 4 - 2 - (unread.length ? 1 : 0) - (v.input?.kind === "reason" || v.reason ? 2 : 0));
      const size = Math.min(es.length, budget);
      const start = Math.max(0, Math.min(toc.st.cur - Math.floor(size / 2), es.length - size));
      lines.push(`${BOLD}${t(lang, "toc_title")}${RESET}`);
      if (start > 0) lines.push(`${DIM}  ▲ ${start}${RESET}`);
      for (const e of es.slice(start, start + size)) {
        const on = toc.st.cur === e.i;
        if (on) focus = [lines.length, lines.length + 1];
        // A long title is cut with … so the line count at its end always shows
        const lead = `${on ? `${BOLD}▸${RESET}` : " "} ${e.level === 3 ? "  " : ""}${toc.st.read.has(e.i) ? `${GREEN}☑${RESET}` : "☐"} `;
        const count = planCount(lang, "plan_lines", e.lines);
        const room = Math.max(4, w - width(lead) - width(count) - 2);
        const title = width(e.plain) > room ? `${truncate(e.plain, room - 1)}…` : e.plain;
        lines.push(`${lead}${on ? BOLD : ""}${title}${RESET}  ${DIM}${count}${RESET}`);
      }
      if (start + size < es.length) lines.push(`${DIM}  ▼ ${es.length - start - size}${RESET}`);
      lines.push("");
    }
    // A plan file on its own: the contents and the one action, Done reading
    if (ro) {
      lines.push(`${CYAN}${t(lang, "plan_done_reading")}${RESET} ${DIM}(Esc)${RESET}`);
      return { lines, focus, hint: toc ? t(lang, "hint_planview_toc") : "" };
    }
    // Information, never a gate: the sections not yet opened, one dim line above the buttons
    lines.push(`${BOLD}${t(lang, "approve_question")}${RESET}`, "");
    if (unread.length) lines.push(...wrap(`${DIM}${t(lang, "plan_unread", { n: unread.length, names: unreadNames(unread) })}${RESET}`, w));
    const buttons: [string, string][] = [["y", t(lang, "approve")], ["n", t(lang, "reject")]];
    buttons.forEach(([k, label], i) => {
      const start = lines.length;
      // With a contents the arrows and Enter act on it, not on the buttons: no cursor mark on them
      const on = !toc && v.cursor === i;
      lines.push(`${on ? `${BOLD}▸${RESET}` : " "} ${CYAN}[${k}]${RESET} ${on ? BOLD : ""}${label}${RESET}`);
      if (on) focus = [start, lines.length];
    });
    if (v.input?.kind === "reason") {
      lines.push("", ...wrap(`  ${t(lang, "reason")}: ${v.input.text}▏`, w));
    } else if (v.reason) {
      lines.push("", ...wrap(`${DIM}  ${t(lang, "reason")}: ${v.reason}${RESET}`, w));
    }
    return {
      lines,
      focus,
      hint: v.input ? t(lang, "hint_plan_input") : t(lang, m.plan ? "hint_plan_toc" : "hint_plan"),
    };
  }

  if (m.checkpoint) {
    if (v.idle) lines.push(...wrap(`${DIM}${t(lang, v.terminal ? "checkpoint_idle_terminal" : "checkpoint_idle")}${RESET}`, w), "");
    (["continue", "instruct", "stop"] as const).forEach((k, i) => {
      const start = lines.length;
      const on = v.cursor === i;
      const lead = `${DIM}${i + 1}${RESET} ${on ? `${BOLD}▸${RESET}` : " "} `;
      lines.push(`${lead}${on ? BOLD : ""}${OPT_COLORS[i]}${t(lang, `checkpoint_${k}`)}${RESET}${i === 0 ? `  ${BADGE_REC} ${t(lang, "recommended_badge")} ${RESET}` : ""}`);
      if (i === 1) {
        const typing = v.input?.kind === "free";
        const typed = typing ? `${v.input!.text}▏` : v.free.text;
        const pad = " ".repeat(width(lead));
        if (typed) for (const x of wrap(typed, Math.max(8, w - width(lead)))) lines.push(pad + x);
        else if (on) lines.push(`${pad}${DIM}${t(lang, "checkpoint_placeholder")}${RESET}`);
      }
      if (on) focus = [start, lines.length];
      lines.push("");
    });
    return { lines, focus, hint: v.input ? t(lang, "hint_input_send") : t(lang, "hint_checkpoint") };
  }

  const q = m.question!;
  if (q.approval) {
    // A Codex approval: the question with its backticked command in bold cyan, so the command stands out
    lines.push(...wrap(codeSpans(q.text), w), "");
  } else if (!q.v2) {
    if (m.title !== q.text || !m.hasExplanation) {
      lines.push(...wrap(`${DIM}${q.header}${RESET}`, w));
      if (m.title !== q.text) lines.push(...wrap(`${BOLD}${q.text}${RESET}`, w));
      lines.push("");
    }
  }
  const tm = termMarks(m);
  const textMarks = [...labelMarks(m), ...tm];
  if (m.todo) lines.push(`${BOLD}${YELLOW}${t(lang, "todo_title")}${RESET}`, ...renderMarkdown(m.todo, w, { lang, marks: tm }), "");
  // The decision column: the conclusion, its condition, the cards, free text and the hint (the reading material is in the background column)
  if (m.headline) lines.push(...wrap(`${BOLD}${inline(m.headline, { base: BOLD, marks: textMarks })}${RESET}`, w));
  // The condition under which another option is right: one dim line right under the headline
  if (m.cond) lines.push(...wrap(`${DIM}${t(lang, "cond_prefix")} ${inline(m.cond, { base: DIM, marks: textMarks })}${RESET}`, w));
  if (m.headline) lines.push("");
  const cardMarks = tm;
  q.cards.forEach((c, i) => {
    const start = lines.length;
    const on = v.cursor === i;
    lines.push(...cardLines(c, w, lang, { cursor: on, selected: v.selected.has(c.value), multi: q.multi, index: i, marks: cardMarks }));
    if (on) focus = [start, lines.length];
    lines.push("");
  });
  // With no options (a prose question) only free text is left: no None of these / Can't answer rows
  if (q.cards.length && !q.approval) {
    const ni = q.cards.length;
    const nstart = lines.length;
    const non = v.cursor === ni;
    lines.push(`${non ? `${BOLD}▸${RESET}` : " "} ${v.none ? CYAN : ""}${q.multi ? "[ ]" : "○"}${RESET} ${non ? BOLD : ""}${t(lang, "none_of_these")}${RESET}  ${CYAN}n${RESET}`);
    if (v.none) {
      NONE_TYPES.forEach((nt, k) => lines.push(`    ${k === v.none!.index ? `${BOLD}▸${RESET} ${BOLD}` : "  "}${t(lang, nt.label)}${RESET}`));
      const note = v.input?.kind === "note" ? `${v.input.text}▏` : v.none.text;
      if (note) lines.push(...wrap(`    ${DIM}${t(lang, "note")}:${RESET} ${note}`, w));
    }
    if (non || v.none) focus = [nstart, lines.length];
    if (v.none) lines.push("");
    const ci = q.cards.length + 1;
    const cstart = lines.length;
    const con = v.cursor === ci;
    lines.push(`${con ? `${BOLD}▸${RESET}` : " "} ${v.cannot ? CYAN : ""}${q.multi ? "[ ]" : "○"}${RESET} ${con ? BOLD : ""}${t(lang, "cannot_answer")}${RESET}  ${CYAN}x${RESET}`);
    if (v.cannot) {
      const c = v.cannot;
      cannotRows(c.index, c.terms.length).forEach((row, k) => {
        const cur = c.pos === k ? `${BOLD}▸${RESET} ` : "  ";
        if (row.kind === "term") {
          const term = c.terms[row.index]!;
          lines.push(`        ${cur}${c.checked.has(term) ? `${CYAN}[x]${RESET}` : "[ ]"} \x1b[31;4m${term}${RESET}`);
          return;
        }
        const here = row.index === c.index;
        lines.push(`    ${cur}${here ? BOLD : DIM}${t(lang, CANNOT_REASONS[row.index]!.label)}${RESET}`);
        if (here) for (const x of wrap(`${DIM}${t(lang, row.index === CANNOT_TERMS ? "cannot_terms_hint" : "cannot_detail_hint")}${RESET}`, Math.max(8, w - 8))) lines.push(`        ${x}`);
      });
      const note = v.input?.kind === "note" ? `${v.input.text}▏` : c.text;
      if (note) lines.push(...wrap(`    ${DIM}${t(lang, "note")}:${RESET} ${note}`, w));
    }
    if (con || v.cannot) focus = [cstart, lines.length];
    lines.push("");
  }
  const fi = q.cards.length + 2;
  const fstart = lines.length;
  const fon = v.cursor === fi;
  const typing = v.input?.kind === "free";
  const ftext = typing ? `${v.input!.text}▏` : v.free.text;
  const lead = `${fon ? `${BOLD}▸${RESET}` : " "} ${v.free.on ? CYAN : ""}${q.multi ? (v.free.on ? "[x]" : "[ ]") : v.free.on ? "●" : "○"}${RESET} `;
  lines.push(`${lead}${fon ? BOLD : ""}${t(lang, "free_text")}${RESET}  ${CYAN}i${RESET}`);
  if (ftext) for (const x of wrap(ftext, Math.max(8, w - width(lead)))) lines.push(" ".repeat(width(lead)) + x);
  if (fon) focus = [fstart, lines.length];

  const hint = v.cannot
    ? fitHint([t(lang, v.input?.kind === "note" ? "hint_input" : "hint_cannot_pick")], w)
    : v.none
    ? fitHint([t(lang, v.input?.kind === "note" ? "hint_input" : "hint_none_pick")], w)
    : typing
    ? t(lang, v.input?.kind === "free" && !q.multi ? "hint_input_send" : "hint_input")
    : fitHint(
        [
          t(lang, q.multi ? "hint_main_multi" : "hint_main") + (m.todoCode.length ? ` ${t(lang, v.copy ? "hint_copy" : "hint_copy_unsupported")}` : ""),
          ...(q.cards.length && !q.approval ? [t(lang, "hint_cannot"), t(lang, "hint_none")] : []),
          ...(q.multi ? [] : [t(lang, "hint_numbers")]),
          t(lang, "hint_free"),
          ...(m.footnotes.length ? [t(lang, "hint_evidence")] : []),
        ],
        w,
      );
  return { lines, focus, hint };
}

// ---- Left: background ----

/** `Goal:` + the session's first instruction, cut at two rows with … */
function goalLines(m: ScreenModel, w: number, lang: Lang): string[] {
  const first = m.history?.first;
  if (!first) return [];
  const rows = wrap(`${BOLD}${CYAN}${t(lang, "goal_label")}${RESET} ${oneLine(first.text)}`, w);
  if (rows.length <= 2) return [...rows, ""];
  return [rows[0]!, `${truncate(rows.slice(1).map(stripAnsi).join(" "), Math.max(1, w - 1))}…`, ""];
}

function leftColumn(v: View, m: ScreenModel, w: number, fullHint = true, rows = 24): Left {
  const lang = v.lang;
  if (v.histDetail) {
    const e = v.histDetail;
    const head = `${BOLD}${t(lang, "history_detail_title")}${RESET} ${DIM}${e.at ? elapsed(e.at, v.now, lang) : ""}${e.first ? ` · ${t(lang, "history_first")}` : ""}${RESET}`;
    // Shown as typed: line breaks and spacing kept
    const lines = [head, "", ...e.text.split("\n").flatMap((l) => (l === "" ? [""] : wrap(l, w)))];
    return { lines, wide: lines.map(() => null), footnotes: [], secRows: [] };
  }
  const goal = goalLines(m, w, lang);
  const r = leftBody(v, m, w, lang, fullHint, rows);
  if (!goal.length) return r;
  return {
    lines: [...goal, ...r.lines],
    wide: [...goal.map(() => null), ...r.wide],
    footnotes: r.footnotes.map((x) => ({ ...x, row: x.row + goal.length })),
    secRows: r.secRows.map((x) => x + goal.length),
  };
}

/** Counts of the memoized section renders (tests check that a repaint does not render again) */
export const richStats = { renders: 0 };
/** Rendered sections of a plan: per screen model, by section (-1 the text before the first, -2 the extra), width, hint and language. A repaint without changes renders nothing */
const richCache = new WeakMap<ScreenModel, Map<string, Rendered>>();

/** A long plan: the text before the first section, then one `▸ ☐ Heading (n lines)` row per H2 / H3 with its body under it while open */
function planLeft(v: View, m: ScreenModel, w: number, lang: Lang, fullHint: boolean): Left {
  const { outline: o, text, extra } = m.plan!;
  const st = v.plan!;
  const src = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  const tm = termMarks(m);
  const out: Left = { lines: [], wide: [], footnotes: [], secRows: [] };
  let cache = richCache.get(m);
  if (!cache) richCache.set(m, (cache = new Map()));
  const popBlank = () => {
    while (out.lines.length && out.lines.at(-1) === "") {
      out.lines.pop();
      out.wide.pop();
    }
  };
  const add = (sec: number, md: string, width: number, indent: string) => {
    if (!md.trim()) return;
    const key = `${sec}:${width}:${fullHint}:${lang}`;
    let r = cache.get(key);
    if (!r) {
      richStats.renders++;
      cache.set(key, (r = renderMarkdownRich(md, width, { fullHint, lang, marks: tm, termsHeadings: TERMS_HEADINGS })));
    }
    out.footnotes.push(...r.footnotes.map((x) => ({ ...x, row: x.row + out.lines.length })));
    out.lines.push(...r.lines.map((l, i) => (r.wide[i] ? l : indent + l)));
    out.wide.push(...r.wide);
    popBlank();
    out.lines.push("");
    out.wide.push(null);
  };
  add(-1, src.slice(0, o.entries[0]?.at ?? src.length).join("\n"), w, "");
  let parentRow = 0;
  let parentOpen = true;
  o.entries.forEach((e, k) => {
    if (e.level === 2) parentOpen = st.open.has(e.i);
    else if (!parentOpen) {
      out.secRows[e.i] = parentRow;
      return;
    }
    const row = out.lines.length;
    out.secRows[e.i] = row;
    if (e.level === 2) parentRow = row;
    const open = st.open.has(e.i);
    const ind = e.level === 3 ? "  " : "";
    const head = `${ind}${open ? "▾" : "▸"} ${st.read.has(e.i) ? `${GREEN}☑${RESET}` : "☐"} ${st.cur === e.i ? `${BOLD}${CYAN}` : BOLD}${e.plain}${RESET} ${DIM}(${planCount(lang, "plan_lines", e.lines)})${RESET}${st.updated.has(e.i) ? ` ${DIM}${t(lang, "plan_section_updated")}${RESET}` : ""}`;
    for (const l of wrap(head, w)) {
      out.lines.push(l);
      out.wide.push(null);
    }
    if (!open) return;
    const next = o.entries[k + 1]?.at ?? src.length;
    add(e.i, src.slice(e.at + 1, next).join("\n"), Math.max(8, w - ind.length - 2), `${ind}  `);
  });
  add(-2, extra, w, "");
  popBlank();
  return out;
}

function leftBody(v: View, m: ScreenModel, w: number, lang: Lang, fullHint: boolean, rows: number): Left {
  if (m.checkpoint) {
    const lines = [`${DIM}${t(lang, "checkpoint_kind")}${RESET}`, ...wrap(m.checkpoint.recap, w)];
    return { lines, wide: lines.map(() => null), footnotes: [], secRows: [] };
  }
  if (m.backgroundNote) {
    const lines = wrap(`${DIM}${m.backgroundNote}${RESET}`, w);
    return { lines, wide: lines.map(() => null), footnotes: [], secRows: [] };
  }
  if (m.plan && v.plan) return planLeft(v, m, w, lang, fullHint);
  // Order (the same as the GUI): Why, the recommendation (what follows its headline), You decide, Against, Assumptions, then the rest of the background, then Affected
  const tm = termMarks(m);
  const textMarks = [...labelMarks(m), ...tm];
  const front: string[] = [];
  if (m.why) front.push(`${BOLD}${m.why.heading}${RESET}`, ...renderMarkdown(m.why.text, w, { lang, marks: tm }), "");
  const recText = m.recRest ?? (m.recommendation && !m.headline ? m.recommendation : null);
  if (recText) front.push(...recBox(recText, w, { rows, full: v.recFull, lang, marks: textMarks }), "");
  if (m.unknowns.length) front.push(...wrap(`${BOLD}${YELLOW}${t(lang, "you_decide")}${RESET} ${inline(m.unknowns.join(" · "), { marks: tm })}`, w), "");
  if (m.against) {
    front.push(`${BOLD}${DIM}${t(lang, "against_title")}${RESET}`);
    for (const l of wrap(inline(m.against, { marks: textMarks }), Math.max(8, w - 2))) front.push(`${DIM}▏${RESET} ${l}`);
    front.push("");
  }
  if (m.assumptions.length) {
    front.push(`${BOLD}${t(lang, "assumptions_title")}${RESET}`);
    for (const a of m.assumptions) wrap(inline(a, { marks: textMarks }), Math.max(8, w - 2)).forEach((l, k) => front.push((k === 0 ? `${GREEN}☐${RESET} ` : "  ") + l));
    front.push(`${DIM}${t(lang, "assumptions_note")}${RESET}`, "");
  }
  const rest: Left = { secRows: [], ...(m.background ? renderMarkdownRich(m.background, w, { fullHint, lang, marks: tm, termsHeadings: TERMS_HEADINGS }) : { lines: [], wide: [], footnotes: [] }) };
  const back = m.affects.length ? wrap(`${DIM}${t(lang, "affects_title")}${RESET} ${affectsText(m).slice(2)}`, w) : [];
  const tailLines = back.length ? ["", ...back] : [];
  if (!front.length && !tailLines.length) return rest;
  return {
    lines: [...front, ...rest.lines, ...tailLines],
    wide: [...front.map(() => null), ...rest.wide, ...tailLines.map(() => null)],
    footnotes: rest.footnotes.map((x) => ({ ...x, row: x.row + front.length })),
    secRows: [],
  };
}

/** Shift only the rows of too-wide diagrams by hoff columns. Also returns the maximum shift and the widest diagram */
function shifted(r: Rendered, w: number, hoff: number): { lines: string[]; hMax: number; figW: number } {
  const figW = Math.max(0, ...r.wide.map((l) => (l ? width(l) : 0)));
  const hMax = Math.max(0, figW - w);
  const off = Math.min(hoff, hMax);
  return { lines: r.lines.map((l, i) => (r.wide[i] ? sliceCols(r.wide[i]!, off, w) : l)), hMax, figW };
}

// ---- Screen ----

function window(lines: string[], rows: number, offset: number): string[] {
  const out = lines.slice(offset, offset + rows);
  while (out.length < rows) out.push("");
  return out;
}

function footer(v: View, cols: number, overflow: boolean, o: { full?: boolean; hint?: boolean; hscrollable?: boolean } = {}): string {
  const hscrollable = o.hscrollable ?? false;
  const lang = v.lang;
  let left: string;
  if (v.notice) return truncate(`${BOLD}${YELLOW}${v.notice}${RESET}`, cols);
  if (v.list) left = `${DIM}${t(lang, "footer_list")}${RESET}`;
  else if (v.history) left = `${DIM}${t(lang, "footer_history_list")}${RESET}`;
  else if (v.histDetail) left = `${DIM}${t(lang, "footer_history_detail")}${RESET}`;
  else if (o.full) left = `${t(lang, "pending_n", { n: v.pending })}  ${DIM}${t(lang, "footer_full")}${RESET}`;
  else {
    left = `${t(lang, "pending_n", { n: v.pending })}  ${DIM}${t(lang, "footer_switch")}${hscrollable ? `  ${t(lang, "footer_hscroll_fig")}` : ""}  ${t(lang, "footer_list_quit")}${(v.model?.history?.total ?? 0) > 1 ? `  ${t(lang, "footer_history")}` : ""}${overflow ? `  ${t(lang, "footer_overflow")}` : ""}${RESET}`;
  }
  if (v.conn?.state === "down") left = `${BOLD}${RED}${t(lang, "cannot_connect", { server: v.conn.server })}${RESET}  ${left}`;
  else if (v.conn?.state === "restored") left = `${BOLD}${GREEN}${t(lang, "reconnected")}${RESET}  ${left}`;
  if (v.toast) left += `  ${BOLD}${GREEN}${v.toast}${RESET}`;
  if (o.hint) left += `  ${BOLD}${YELLOW}${t(lang, "fig_over_hint")}${RESET}`;
  return truncate(left, cols);
}

function listBody(v: View, cols: number, rows: number): string[] {
  const out: string[] = [`${BOLD}${t(v.lang, "list_title")}${RESET}`, ""];
  const l = v.list!;
  l.items.forEach((it, i) => {
    const on = i === l.index;
    if (it.plan) {
      // A plan file: title, then `plan · age · N sections · M lines`; new ones carry the dot, the others are dim
      const meta = [it.kindLabel, elapsed(it.createdAt, v.now, v.lang), `${planCount(v.lang, "plan_sections", it.plan.sections)} · ${planCount(v.lang, "plan_lines", it.plan.lines)}`, it.current ? t(v.lang, "current") : ""].filter(Boolean).join(" · ");
      out.push(truncate(`${on ? `${BOLD}▸${RESET}` : " "} ${it.plan.isNew ? `${CYAN}●${RESET}` : " "} ${it.plan.isNew ? (on ? BOLD : "") : DIM}${it.title}${RESET}`, cols));
      out.push(truncate(`      ${DIM}${meta}${RESET}`, cols));
      return;
    }
    const meta = [it.kindLabel, elapsed(it.createdAt, v.now, v.lang), it.noExplanation ? t(v.lang, "no_explanation") : "", it.current ? t(v.lang, "current") : ""]
      .filter(Boolean)
      .join(" · ");
    const mark = it.blocker ? `${BADGE_BLOCKER} ${t(v.lang, "task_badge")} ${RESET} ` : "";
    out.push(truncate(`${on ? `${BOLD}▸${RESET}` : " "} ${mark}${on ? BOLD : ""}${it.title}${RESET}`, cols));
    out.push(truncate(`    ${chipsText(it.chips)}  ${DIM}${meta}${RESET}`, cols));
  });
  return window(out, rows, 0);
}

const planCount = (lang: Lang, key: "plan_sections" | "plan_lines" | "plan_files", n: number): string => t(lang, n === 1 ? `${key}_one` : key, { n });

/** Row 2 of a plan file's header: `Plan  updated 5m  9 sections · 200 lines · 12 files  file.md` (the stats for a long plan only) */
function planFileMeta(m: ScreenModel, now: number, lang: Lang): string {
  const o = m.plan?.outline;
  const parts = [t(lang, "kind_plan"), t(lang, "plan_updated_ago", { age: elapsed(m.createdAt, now, lang) })];
  if (o) parts.push(`${planCount(lang, "plan_sections", o.h2)} · ${planCount(lang, "plan_lines", o.lines)} · ${planCount(lang, "plan_files", o.files)}`);
  parts.push(m.readonly!.name);
  return `${DIM}${parts.join("  ")}${RESET}`;
}

/** The `s` overlay: when · first line of each instruction, the cursor kept in view */
function historyBody(v: View, cols: number, rows: number): string[] {
  const h = v.history!;
  const head = [`${BOLD}${t(v.lang, "history_title")}${RESET}`, ""];
  const size = Math.max(1, rows - head.length);
  const off = Math.max(0, Math.min(h.index - Math.floor(size / 2), h.items.length - size));
  const body = h.items.slice(off, off + size).map((it, k) => {
    const on = off + k === h.index;
    const when = padEnd(`${DIM}${it.at ? elapsed(it.at, v.now, v.lang) : ""}${RESET}`, 6);
    const mark = it.first ? `${YELLOW}${t(v.lang, "history_first")}${RESET} ` : "";
    const delivery = it.delivered === undefined ? "" : ` ${DIM}${t(v.lang, it.delivered ? "history_delivered" : "history_undelivered")}${RESET}`;
    return truncate(`${on ? `${BOLD}▸${RESET}` : " "} ${when} ${mark}${on ? BOLD : ""}${oneLine(it.text)}${RESET}${delivery}`, cols);
  });
  return window([...head, ...body], rows, 0);
}

/** A simple scrollbar for the right edge (`█` marks the position in a `░` track, so it never reads as a box edge `│`), size rows tall */
function scrollbar(size: number, total: number, off: number, max: number): string[] {
  const len = Math.max(1, Math.min(size, Math.round((size * size) / total)));
  const start = max > 0 ? Math.round((off / max) * (size - len)) : 0;
  return Array.from({ length: size }, (_, i) => (i >= start && i < start + len ? "█" : `${DIM}░${RESET}`));
}

/** The `▲▼ 1-20/58` indicator on the last row */
function position(off: number, max: number, size: number, total: number, h?: { off: number; figW: number }): string {
  const hs = h && h.off > 0 ? ` ◀▶ ${h.off}/${h.figW}` : "";
  return `${DIM}${off > 0 ? "▲" : " "}${off < max ? "▼" : " "} ${off + 1}-${Math.min(total, off + size)}/${total}${hs}${RESET}`;
}

/** Overlay a window, scrollbar and position indicator on an overflowing column. w is the column width including the bar */
function scrolled(all: string[], size: number, off: number, w: number, tail: string[], h?: { off: number; figW: number }): string[] {
  const max = all.length - size;
  // When it fits vertically, show neither the bar nor the ▲▼ position (keep only ◀▶ when shifted sideways)
  const bar = max > 0 ? scrollbar(size, all.length, off, max) : new Array<string>(size).fill(" ");
  const body = window(all, size, off).map((l, i) => `${padEnd(truncate(l, w - 1), w - 1)}${bar[i]}`);
  const pos = max > 0 ? position(off, max, size, all.length, h) : h && h.off > 0 ? `${DIM}◀▶ ${h.off}/${h.figW}${RESET}` : "";
  return [...body, truncate(pos, w), ...tail];
}

export function renderFrame(v: View, size: Size): Frame {
  const { cols, rows } = size;
  const m = v.model;
  const fin = (body: string[], head: string[], meta: Partial<Frame> = {}, overflow = false): Frame => {
    const base = { scrollMax: 0, wide: false, split: 0, rightMax: 0, rightOff: 0, off: 0, bodyRows: Math.max(1, rows - 1), hMax: 0, full: false, figOver: false, footRows: [] as number[], secRows: [] as number[] };
    const f = { ...base, ...meta };
    const lines = [...head, ...body, footer(v, cols, overflow, { full: f.full, hint: v.fullHint && f.figOver && !f.full, hscrollable: f.hMax > 0 })].map((l) => truncate(l, cols));
    return { text: lines.join("\n"), lines, ...f };
  };

  if (v.list) return fin(listBody(v, cols, rows - 1), []);
  if (v.history) return fin(historyBody(v, cols, rows - 1), []);

  if (!m) {
    const body = new Array<string>(Math.max(0, rows - 1)).fill("");
    const msg = t(v.lang, "empty");
    const row = Math.floor((rows - 1) / 2);
    body[row] = " ".repeat(Math.max(0, Math.floor((cols - width(msg)) / 2))) + `${DIM}${msg}${RESET}`;
    return fin(body, []);
  }

  const head = m.checkpoint
    ? [metaLine(m, v.now, cols, v.lang), truncate(`${BOLD}${m.title}${RESET}`, cols), ...wrap(m.checkpoint.headline, cols).slice(0, 1), truncate(`${DIM}${t(v.lang, "checkpoint_optional")}${RESET}`, cols), `${DIM}${"─".repeat(cols)}${RESET}`]
    : m.readonly
    ? [truncate(`${BOLD}${CYAN}plans/${RESET}  ${planFileMeta(m, v.now, v.lang)}`, cols), truncate(`${BOLD}${m.title}${RESET}`, cols), `${DIM}${"─".repeat(cols)}${RESET}`]
    : [metaLine(m, v.now, cols, v.lang), ...wrap(`${BOLD}${m.question?.approval ? codeSpans(m.title, BOLD) : m.title}${RESET}`, cols).slice(0, 2), `${DIM}${"─".repeat(cols)}${RESET}`];
  const bodyRows = Math.max(1, rows - head.length - 1);

  if (cols >= WIDE_COLS) {
    const SEP = " │ ";
    const full = v.full;
    const rightW = decisionWidth(cols);
    const leftW = full ? cols : cols - SEP.length - rightW;
    // Take one row for the heading (the focused column inverted); the rest is the column window
    const winRows = Math.max(1, bodyRows - 1);
    // The focused heading is inverted with a ▶ on the left (visible even in monochrome); the other is dim
    const heading = (label: string, w: number, on: boolean) => padEnd(on ? `\x1b[7m ▶ ${label} ${RESET}` : `${DIM}   ${label}${RESET}`, w);

    // Left: when it overflows (tall, or has a diagram that can shift sideways) put a bar on the right edge and the position on the last row; otherwise leave it as is
    let leftR = leftColumn(v, m, leftW, true, winRows);
    const hasWide = leftR.wide.some(Boolean);
    const leftOver = leftR.lines.length > winRows || hasWide;
    let scrollMax = 0;
    let left: string[];
    let hMax = 0;
    let figW = 0;
    let textW = leftW;
    if (leftOver) {
      textW = leftW - 1;
      leftR = leftColumn(v, m, textW, true, winRows);
      const sh = shifted(leftR, textW, v.hscroll);
      hMax = sh.hMax;
      figW = sh.figW;
      const size = winRows - 1;
      scrollMax = Math.max(0, sh.lines.length - size);
      const off = Math.min(v.scroll, scrollMax);
      left = scrolled(sh.lines, size, off, leftW, [], { off: Math.min(v.hscroll, hMax), figW });
    } else left = window(leftR.lines, winRows, 0);
    const figOver = !full && hMax > 0 && figW <= cols - 1;
    const meta = { scrollMax, wide: true, bodyRows: winRows, hMax, full, figOver, footRows: leftR.footnotes.map((x) => x.row), secRows: leftR.secRows };

    if (full) {
      const body = [heading(t(v.lang, "bg_full_title"), cols, true), ...left.map((l) => truncate(l, cols))];
      return fin(body, head, { ...meta, split: cols }, leftOver);
    }

    // Right: when it overflows, scroll so the card under the cursor is visible (or to the manually scrolled position). The hint stays on the bottom row
    let right = rightColumn(v, m, rightW, winRows);
    // The hint is one row (cut at the column width)
    const hintRows = (r: Column, w: number): string[] => [truncate(`${DIM}${r.hint}${RESET}`, w)];
    const rightOver = right.lines.length + 1 + hintRows(right, rightW).length > winRows;
    let rcol: string[];
    let rightMax = 0;
    let rightOff = 0;
    if (rightOver) {
      right = rightColumn(v, m, rightW - 1, winRows);
      const hr = hintRows(right, rightW - 1);
      const size = Math.max(1, winRows - 1 - hr.length);
      rightMax = Math.max(0, right.lines.length - size);
      const [fs, fe] = right.focus;
      const follow = Math.max(0, Math.min(fs, fe - size));
      rightOff = Math.min(rightMax, v.rscroll ?? follow);
      rcol = scrolled(right.lines, size, rightOff, rightW, hr);
    } else rcol = window([...right.lines, "", ...hintRows(right, rightW)], winRows, 0);

    const body = [
      `${heading(t(v.lang, "bg_title"), leftW, v.focus === "background")}${DIM}${SEP}${RESET}${heading(t(v.lang, "decision_title"), rightW, v.focus === "decision")}`,
      ...left.map((l, i) => `${padEnd(truncate(l, leftW), leftW)}${DIM}${SEP}${RESET}${truncate(rcol[i] ?? "", rightW)}`),
    ];
    return fin(body, head, { ...meta, split: leftW + SEP.length, rightMax, rightOff }, leftOver || rightOver);
  }

  // Narrow: stacked. Put the decision first (so it is always reachable) and continue with the background below
  const right = rightColumn(v, m, cols - 1, bodyRows);
  const leftR = leftColumn(v, m, cols - 1, false, bodyRows);
  const sh = shifted(leftR, cols - 1, v.hscroll);
  const leftAll = sh.lines;
  const all = [...right.lines, "", `${DIM}${right.hint}${RESET}`, ...(leftAll.length ? ["", `${DIM}${"─".repeat(cols - 1)}${RESET}`, ...leftAll] : [])];
  const hOff = Math.min(v.hscroll, sh.hMax);
  const footRows = leftR.footnotes.map((x) => x.row + right.lines.length + 4);
  const secRows = leftR.secRows.map((x) => x + right.lines.length + 4);
  if (all.length <= bodyRows && sh.hMax === 0) return fin(window(all, bodyRows, 0), head, { bodyRows, footRows, secRows });
  const win = bodyRows - 1;
  const scrollMax = Math.max(0, all.length - win);
  let off = Math.min(v.scroll, scrollMax);
  if (off === 0) off = Math.max(0, Math.min(right.focus[0], right.focus[1] - win));
  off = Math.min(off, scrollMax);
  return fin(scrolled(all, win, off, cols, [], { off: hOff, figW: sh.figW }), head, { scrollMax, off, bodyRows: win, hMax: sh.hMax, footRows, secRows }, true);
}

export function render(v: View, size: Size): string {
  return renderFrame(v, size).text;
}
