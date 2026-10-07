import { BOLD, CYAN, DIM, GREEN, MAGENTA, RED, RESET, STRONG_RISK, YELLOW, inline, literalMarks, renderMarkdown, renderMarkdownRich, type Mark, type Rendered } from "./markdown.js";
import { IRREVERSIBLE_RE, UNDO_RE, elapsed, repoAnsi, PLANS_ANSI, type Card, type Chip, type ScreenModel } from "./model.js";
import { SECTION, normalizeHeading } from "../hook/explain.js";
import { NONE_TYPES } from "./none.js";
import { CANNOT_REASONS, CANNOT_TERMS, cannotRows } from "./cannot.js";
import type { Lang } from "../settings/config.js";
import { t } from "./i18n.js";
import { oneLine, type HistoryItem } from "./history.js";
import { planOutline, unreadNames, unreadSections, type PlanState } from "./plan.js";
import type { DiffLine, PlanDiff, SectionDiff } from "../contract.js";
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
  /** A plan file (its row says `plan`, `N sections · M lines`; new ones carry the dot, the others are plain) */
  plan?: { sections: number; lines: number; isNew: boolean; writing: boolean };
}

/** The versions of the shown plan (2 or more): the version line, the summary line, the note while an earlier one is shown, and the diff that marks the body */
export interface VersionView {
  tabs: string[];
  idx: number;
  /** `v1 → v2:` and what follows it (counts, or "first version") */
  head: string;
  body: string;
  /** What the human sent after the version before this one */
  ins: { label: string; text: string } | null;
  note: string | null;
  /** The diff to mark the body with; null when there is nothing to mark (first version, or the text on screen is not that version) */
  diff: PlanDiff | null;
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
  input: { kind: "free" | "reason" | "note" | "instruct"; text: string } | null;
  /** The instruction typed and left with Esc (shown plain); the presets; whether the plan file has a session to instruct */
  instruct: string;
  presets: readonly string[];
  canInstruct: boolean;
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
  /** The versions of the plan on screen; null with fewer than 2 */
  ver: VersionView | null;
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

/** The instruction card of a plan, always shown: its label, the numbered presets (pick one with its digit while the box is empty), then the box (typing, kept with Esc, or the placeholder) */
function instructCard(v: View, w: number, lang: Lang, on: boolean, key = "i"): { lines: string[]; start: number } {
  const typing = v.input?.kind === "instruct";
  const label = `${on ? `${BOLD}▸${RESET}` : " "} ${CYAN}[${key}]${RESET} ${on ? BOLD : ""}${t(lang, "instruct")}${RESET}`;
  // Nothing typed, no presets: one row, the placeholder beside the label
  if (!typing && !v.instruct && !v.presets.length) return { lines: [`${label}  ${t(lang, "instruct_placeholder")}`], start: 0 };
  const out: string[] = [label];
  v.presets.slice(0, 9).forEach((p, i) => out.push(...wrap(`  ${i + 1} ${p}`, w)));
  if (typing) out.push(...wrap(`  ${t(lang, "instruct_label")}: ${v.input!.text}▏`, w));
  else if (v.instruct) out.push(...wrap(`  ${t(lang, "instruct_label")}: ${v.instruct}`, w));
  else out.push(`  ${t(lang, "instruct_placeholder")}`);
  return { lines: out, start: 0 };
}

function instructHint(v: View, lang: Lang): string {
  return t(lang, v.presets.length && v.input?.text === "" ? "hint_plan_instruct" : "hint_plan_instruct_typed");
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
const BADGE_QUIZ = "\x1b[46;30m";

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

const repoName = (c: Chip): string => c.text.replace(/^◈ /, "");
const chip = (c: Chip): string => `${c.kind === "repo" ? repoAnsi(repoName(c)) : CHIP_COLOR[c.kind]}${c.text}${RESET}`;
export const chipsText = (chips: Chip[]): string => chips.map(chip).join(" ");

/** Affected names on one line: at most 6, the rest as +N */
function affectsText(m: ScreenModel): string {
  const shown = m.affects.slice(0, 6).map((x) => x.replace(/`/g, ""));
  const rest = m.affects.length - shown.length;
  return `⌁ ${shown.join(" · ")}${rest > 0 ? ` +${rest}` : ""}`;
}

/** Row 2 of the header: bracket chips `[● repo] [⎇ branch] [⧉ worktree] [scope] [age]`, the repo in bold and its own colour (the same repo always the same one: repoAnsi).
 *  The blocker / quiz band opens the line; the cwd is not shown (the origin is enough) */
function ctxLine(m: ScreenModel, now: number, cols: number, lang: Lang): string {
  const [repo, ...rest] = m.chips;
  const chip = (text: string) => `[${text}]`;
  const where = [repo ? chip(`${repoAnsi(repoName(repo))}●${RESET} ${repoAnsi(repoName(repo))}${BOLD}${repoName(repo)}${RESET}`) : "", ...rest.map((c) => chip(c.text))].filter(Boolean);
  const tail = [m.scope, elapsed(m.createdAt, now, lang)].filter((x): x is string => !!x).map(chip);
  const band = m.blocker ? `${BADGE_BLOCKER} ${t(lang, "waiting_for_you")} ${RESET} ` : m.quiz ? `${BADGE_QUIZ} ${t(lang, "quiz_band")} ${RESET} ` : "";
  return truncate(`${band}${[...where, ...tail].join(" ")}`, cols);
}

/** Row 1 of the header: the title in bold (2 rows at most), then the reversibility mark when it is costly / irreversible */
function titleLines(m: ScreenModel, cols: number, lang: Lang): string[] {
  const badge = m.reversibility === "irreversible" ? ` ${BADGE_IRREVERSIBLE} ${t(lang, "irreversible")} ${RESET}` : m.reversibility === "costly" ? ` ${BADGE_COSTLY} ${t(lang, "costly")} ${RESET}` : "";
  return wrap(`${BOLD}${m.question?.approval ? codeSpans(m.title, BOLD) : m.title}${RESET}${badge}`, cols).slice(0, 2);
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
  const num = !o.multi && o.index < 9 ? `${o.index + 1} ` : "";
  const lead = `${num}${o.cursor ? `${BOLD}▸${RESET}` : " "} ${o.selected ? CYAN : ""}${mark}${RESET} `;
  const label = `${o.cursor ? BOLD : ""}${OPT_COLORS[o.index % 4]}${card.fixed ? t(lang, `fixed_${card.fixed}`) : card.label}${RESET}`;
  const head = `${label}${card.recommended ? `  ${BADGE_REC} ${t(lang, "recommended_badge")} ${RESET}` : ""}`;
  const pad = " ".repeat(width(lead));
  const out = wrap(head, Math.max(8, w - width(lead))).map((l, k) => (k === 0 ? lead : pad) + l);
  for (const l of card.lines) {
    const body = l.risk
      ? `${inline(l.text, { strong: STRONG_RISK, marks: [...riskMarks(), ...o.marks] })}`
      : l.name
        ? `${BOLD}${l.name}:${RESET} ${inline(l.text, { marks: o.marks })}`
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
      ? [...body, `${t(o.lang, "rec_collapse")}`]
      : [...body.slice(0, REC_CUT_ROWS), `${t(o.lang, "rec_expand")}`];
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
    const long = m.plan && v.plan ? { p: m.plan, st: v.plan } : null;
    // A long plan has two zones; the options take the arrows only in the options zone (a short plan is always there)
    const optsOn = !long || long.st.zone === "opts";
    const unread = !ro && long ? unreadSections(long.p.outline, long.st) : [];
    // A plan file on its own: the one action Done reading, and the Instruct card when the session is known
    if (ro) {
      lines.push(`${CYAN}${t(lang, "plan_done_reading")}${RESET} (Esc)`);
      if (v.canInstruct) {
        const start = lines.length;
        lines.push("", ...instructCard(v, w, lang, optsOn).lines);
        if (optsOn) focus = [start + 1, lines.length];
      } else {
        lines.push(`${t(lang, "plan_no_session")}`);
      }
      const zoneHint = !long ? "" : !v.canInstruct ? t(lang, "hint_planview_zone_only") : t(lang, optsOn ? "hint_planview_zone_opts" : "hint_planview_zone_plan");
      const hint = [zoneHint, !long && v.canInstruct && !v.input ? t(lang, "hint_planview_instruct") : ""].filter(Boolean).join(" · ");
      return { lines, focus, hint: v.input?.kind === "instruct" ? instructHint(v, lang) : hint };
    }
    // Information, never a gate: the sections not yet opened, one plain line above the options
    lines.push(`${BOLD}${t(lang, "approve_question")}${RESET}`, "");
    if (unread.length) lines.push(...wrap(`${t(lang, "plan_unread", { n: unread.length, names: unreadNames(unread) })}`, w));
    // One option list like a question: 1 Approve (auto), 2 Instruct (its box opens when the cursor lands on it), 3 Reject (so does its reason box)
    const typingInstruct = v.input?.kind === "instruct";
    const typingReason = v.input?.kind === "reason";
    const at = (i: number) => optsOn && (v.cursor === i || (i === 1 && typingInstruct) || (i === 2 && typingReason));
    const mark = (on: boolean) => (on ? `${BOLD}▸${RESET}` : " ");
    const approveStart = lines.length;
    lines.push(`${mark(at(0))} ${CYAN}[1]${RESET} ${at(0) ? BOLD : ""}${GREEN}${t(lang, "approve_auto")}${RESET} ★ ${t(lang, "recommended_badge")}`);
    if (at(0)) focus = [approveStart, lines.length];
    const cardStart = lines.length;
    const card = instructCard(v, w, lang, at(1), "2").lines;
    lines.push(...card);
    if (at(1)) focus = [cardStart, cardStart + card.length];
    const rejectStart = lines.length;
    lines.push(`${mark(at(2))} ${CYAN}[3]${RESET} ${at(2) ? BOLD : ""}${t(lang, "reject")}${RESET}`);
    if (typingReason) lines.push(...wrap(`  ${t(lang, "reason")}: ${v.input!.text}▏${v.input!.text ? "" : ` ${DIM}${t(lang, "reason_placeholder")}${RESET}`}`, w));
    else if (v.reason) lines.push(...wrap(`  ${t(lang, "reason")}: ${v.reason}`, w));
    if (at(2)) focus = [rejectStart, lines.length];
    return {
      lines,
      focus,
      hint: v.input?.kind === "instruct" ? instructHint(v, lang) : v.input ? t(lang, "hint_plan_input") : t(lang, long ? (optsOn ? "hint_plan_zone_opts" : "hint_plan_zone_plan") : "hint_plan"),
    };
  }

  if (m.checkpoint) {
    if (v.idle) lines.push(...wrap(`${t(lang, v.terminal ? "checkpoint_idle_terminal" : "checkpoint_idle")}`, w), "");
    (["continue", "instruct", "stop"] as const).forEach((k, i) => {
      const start = lines.length;
      const on = v.cursor === i;
      const lead = `${i + 1} ${on ? `${BOLD}▸${RESET}` : " "} `;
      lines.push(`${lead}${on ? BOLD : ""}${OPT_COLORS[i]}${t(lang, `checkpoint_${k}`)}${RESET}${i === 0 ? `  ${BADGE_REC} ${t(lang, "recommended_badge")} ${RESET}` : ""}`);
      if (i === 1) {
        const typing = v.input?.kind === "free";
        const typed = typing ? `${v.input!.text}▏` : v.free.text;
        const pad = " ".repeat(width(lead));
        if (typed) for (const x of wrap(typed, Math.max(8, w - width(lead)))) lines.push(pad + x);
        else if (on) lines.push(`${pad}${t(lang, "checkpoint_placeholder")}`);
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
      lines.push(...wrap(`${q.header}`, w));
      if (m.title !== q.text) lines.push(...wrap(`${BOLD}${q.text}${RESET}`, w));
      lines.push("");
    }
  }
  const tm = termMarks(m);
  const textMarks = [...labelMarks(m), ...tm];
  if (m.todo) lines.push(`${BOLD}${YELLOW}${t(lang, "todo_title")}${RESET}`, ...renderMarkdown(m.todo, w, { lang, marks: tm }), "");
  // The decision column: the conclusion, its condition, the cards, free text and the hint (the reading material is in the background column)
  if (m.headline) lines.push(...wrap(`${BOLD}${inline(m.headline, { base: BOLD, marks: textMarks })}${RESET}`, w));
  // The condition under which another option is right: one plain line right under the headline
  if (m.cond) lines.push(...wrap(`${BOLD}${t(lang, "cond_label")}${RESET} ${inline(m.cond, { marks: textMarks })}`, w));
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
      if (note) lines.push(...wrap(`    ${t(lang, "note")}: ${note}`, w));
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
        lines.push(`    ${cur}${here ? BOLD : ""}${t(lang, CANNOT_REASONS[row.index]!.label)}${RESET}`);
        if (here) for (const x of wrap(`${t(lang, row.index === CANNOT_TERMS ? "cannot_terms_hint" : "cannot_detail_hint")}`, Math.max(8, w - 8))) lines.push(`        ${x}`);
      });
      const note = v.input?.kind === "note" ? `${v.input.text}▏` : c.text;
      if (note) lines.push(...wrap(`    ${t(lang, "note")}: ${note}`, w));
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
    ? t(lang, v.input?.kind === "free" ? (q.multi ? "hint_input_confirm" : "hint_input_send") : "hint_input")
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

/** `Goal` (bold) + the session's first instruction, cut at two rows with … */
function goalLines(m: ScreenModel, w: number, lang: Lang): string[] {
  const first = m.history?.first;
  if (!first) return [];
  const rows = wrap(`${BOLD}${t(lang, "goal_label").replace(/[:：]$/, "")}${RESET} ${oneLine(first.text)}`, w);
  const rule = `${DIM}${"─".repeat(w)}${RESET}`;
  if (rows.length <= 2) return [...rows, rule, ""];
  return [rows[0]!, `${truncate(rows.slice(1).map(stripAnsi).join(" "), Math.max(1, w - 1))}…`, rule, ""];
}

function leftColumn(v: View, m: ScreenModel, w: number, fullHint = true, rows = 24): Left {
  const lang = v.lang;
  if (v.histDetail) {
    const e = v.histDetail;
    const head = `${BOLD}${t(lang, "history_detail_title")}${RESET} ${e.at ? elapsed(e.at, v.now, lang) : ""}${e.first ? ` · ${t(lang, "history_first")}` : ""}`;
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


const verTag = (sec: SectionDiff | undefined, lang: Lang): string =>
  sec?.status === "added" ? ` ${GREEN}[${t(lang, "ver_new")}]${RESET}` : sec?.status === "changed" ? ` ${YELLOW}[${t(lang, "ver_chg")}]${RESET}` : "";

/** The added / changed sections of the diff, matched to the H2 headings of the text on screen (same rule as the server: by trimmed heading, duplicates in order) */
function verSections(diff: PlanDiff, headings: { key: number; title: string }[]): Map<number, SectionDiff> {
  const used = new Set<number>();
  const out = new Map<number, SectionDiff>();
  for (const h of headings) {
    const k = diff.sections.findIndex((s, j) => !used.has(j) && s.status !== "removed" && s.heading !== "" && s.heading === h.title.trim());
    if (k < 0) continue;
    used.add(k);
    const s = diff.sections[k]!;
    if (s.status === "added" || s.status === "changed") out.set(h.key, s);
  }
  return out;
}

/** The first `newCount` lines (new side) of a changed section's body, after the heading line: what a section shows when it has subsections of its own */
function ownDiff(lines: DiffLine[], newCount: number): DiffLine[] {
  const out: DiffLine[] = [];
  let n = 0;
  for (let i = lines[0]?.kind === "same" ? 1 : 0; i < lines.length && n < newCount; i++) {
    out.push(lines[i]!);
    if (lines[i]!.kind !== "del") n++;
  }
  return out;
}

/** A changed section's body: the unchanged lines as Markdown, the old line as `- text` in red, the new line as `+ text` in green */
function renderDiff(lines: DiffLine[], width: number, opts: { fullHint: boolean; lang: Lang; marks: Mark[] }): Rendered {
  const out: Rendered = { lines: [], footnotes: [], wide: [] };
  let buf: string[] = [];
  const flush = () => {
    if (buf.join("").trim()) {
      const r = renderMarkdownRich(buf.join("\n"), width, { ...opts, termsHeadings: TERMS_HEADINGS });
      out.footnotes.push(...r.footnotes.map((x) => ({ ...x, row: x.row + out.lines.length })));
      out.lines.push(...r.lines);
      out.wide.push(...r.wide);
    }
    buf = [];
  };
  for (const l of lines) {
    if (l.kind === "same") {
      buf.push(l.text);
      continue;
    }
    if (!l.text.trim()) continue;
    flush();
    for (const x of wrap(l.kind === "del" ? `${RED}- ${l.text}${RESET}` : `${GREEN}+ ${l.text}${RESET}`, width)) {
      out.lines.push(x);
      out.wide.push(null);
    }
  }
  flush();
  return out;
}

/** The version line (the shown one in reverse video), the summary line and the note, under the context line of a plan */
function verHeader(ver: VersionView, cols: number): string[] {
  const tabs = ver.tabs.map((x, i) => (i === ver.idx ? `${BOLD}\x1b[7m ${x} ${RESET}` : ` ${x} `)).join(" ");
  const sum = `${BOLD}${ver.head}${RESET} ${ver.body}${ver.ins ? ` · ${BOLD}${ver.ins.label}${RESET}${ver.ins.text.trim() ? ` ${ver.ins.text.replace(/\s+/g, " ")}` : ""}` : ""}`;
  return [truncate(tabs, cols), truncate(sum, cols), ...(ver.note ? [truncate(`${BOLD}${ver.note}${RESET}`, cols)] : [])];
}

/** A long plan: the text before the first section, then one `▸ ☐ Heading (n lines)` row per H2 / H3 with its body under it while open */
function planLeft(v: View, m: ScreenModel, w: number, lang: Lang, fullHint: boolean): Left {
  const { outline: o, text, extra } = m.plan!;
  const st = v.plan!;
  const src = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  const tm = termMarks(m);
  const out: Left = { lines: [], wide: [], footnotes: [], secRows: [] };
  // The sections that are new / changed since the version before: a tag on the heading
  const ver = v.ver?.diff ?? null;
  const secs = ver ? verSections(ver, o.entries.filter((e) => e.level === 2).map((e) => ({ key: e.i, title: e.title }))) : new Map<number, SectionDiff>();
  let cache = richCache.get(m);
  if (!cache) richCache.set(m, (cache = new Map()));
  const popBlank = () => {
    while (out.lines.length && out.lines.at(-1) === "") {
      out.lines.pop();
      out.wide.pop();
    }
  };
  const add = (sec: number, md: string, width: number, indent: string, diff?: DiffLine[]) => {
    if (!md.trim()) return;
    const key = `${diff ? "d" : ""}${sec}:${width}:${fullHint}:${lang}`;
    let r = cache.get(key);
    if (!r) {
      richStats.renders++;
      cache.set(key, (r = diff ? renderDiff(diff, width, { fullHint, lang, marks: tm }) : renderMarkdownRich(md, width, { fullHint, lang, marks: tm, termsHeadings: TERMS_HEADINGS })));
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
    if (e.level === 2) {
      parentOpen = st.open.has(e.i);
    }
    else if (!parentOpen) {
      out.secRows[e.i] = parentRow;
      return;
    }
    const row = out.lines.length;
    out.secRows[e.i] = row;
    if (e.level === 2) parentRow = row;
    const open = st.open.has(e.i);
    const ind = e.level === 3 ? "  " : "";
    // The selected section: inverted while the plan zone has the arrows, bold cyan otherwise
    const title = st.cur === e.i ? (st.zone === "plan" ? `\x1b[7m${e.plain}${RESET}` : `${BOLD}${CYAN}${e.plain}${RESET}`) : `${BOLD}${e.plain}${RESET}`;
    const head = `${ind}${open ? "▾" : "▸"} ${st.read.has(e.i) ? `${GREEN}☑${RESET}` : "☐"} ${title} (${planCount(lang, "plan_lines", e.lines)})${st.updated.has(e.i) ? ` ${t(lang, "plan_section_updated")}` : ""}${e.level === 2 ? verTag(secs.get(e.i), lang) : ""}`;
    for (const l of wrap(head, w)) {
      out.lines.push(l);
      out.wide.push(null);
    }
    if (!open) return;
    const next = o.entries[k + 1]?.at ?? src.length;
    const sec = e.level === 2 ? secs.get(e.i) : undefined;
    const diff = sec?.status === "changed" && sec.lines ? ownDiff(sec.lines, next - (e.at + 1)) : undefined;
    add(e.i, src.slice(e.at + 1, next).join("\n"), Math.max(8, w - ind.length - 2), `${ind}  `, diff);
  });
  add(-2, extra, w, "");
  popBlank();
  return out;
}

/** A plan that is not folded (short, or an earlier version) with the sections that changed since the version before marked the same way as a long one */
function planFlatMarked(v: View, m: ScreenModel, w: number, lang: Lang, fullHint: boolean): Left {
  const diff = v.ver!.diff!;
  const text = m.background!;
  const src = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  const h2 = planOutline(text).entries.filter((e) => e.level === 2);
  const secs = verSections(diff, h2.map((e) => ({ key: e.i, title: e.title })));
  const tm = termMarks(m);
  const out: Left = { lines: [], wide: [], footnotes: [], secRows: [] };
  const push = (r: Rendered, indent: string) => {
    out.footnotes.push(...r.footnotes.map((x) => ({ ...x, row: x.row + out.lines.length })));
    out.lines.push(...r.lines.map((l, i) => (r.wide[i] ? l : indent + l)));
    out.wide.push(...r.wide);
    while (out.lines.length && out.lines.at(-1) === "") {
      out.lines.pop();
      out.wide.pop();
    }
    out.lines.push("");
    out.wide.push(null);
  };
  const md = (s: string, width: number) => renderMarkdownRich(s, width, { fullHint, lang, marks: tm, termsHeadings: TERMS_HEADINGS });
  const pre = src.slice(0, h2[0]?.at ?? src.length).join("\n");
  if (pre.trim()) push(md(pre, w), "  ");
  h2.forEach((e, k) => {
    const sec = secs.get(e.i);
    const end = h2[k + 1]?.at ?? src.length;
    for (const l of wrap(`${BOLD}${e.plain}${RESET}${verTag(sec, lang)}`, w)) {
      out.lines.push(l);
      out.wide.push(null);
    }
    const body = src.slice(e.at + 1, end);
    if (sec?.status === "changed" && sec.lines) push(renderDiff(sec.lines.slice(sec.lines[0]?.kind === "same" ? 1 : 0), w, { fullHint, lang, marks: tm }), "");
    else if (body.join("").trim()) push(md(body.join("\n"), w), "");
  });
  while (out.lines.length && out.lines.at(-1) === "") {
    out.lines.pop();
    out.wide.pop();
  }
  return out;
}

function leftBody(v: View, m: ScreenModel, w: number, lang: Lang, fullHint: boolean, rows: number): Left {
  if (m.checkpoint) {
    const lines = [...wrap(`${t(lang, "checkpoint_optional")}`, w), "",`${t(lang, "checkpoint_kind")}`, ...wrap(m.checkpoint.recap, w)];
    return { lines, wide: lines.map(() => null), footnotes: [], secRows: [] };
  }
  if (m.backgroundNote) {
    const lines = wrap(`${m.backgroundNote}`, w);
    return { lines, wide: lines.map(() => null), footnotes: [], secRows: [] };
  }
  if (m.plan && v.plan) return planLeft(v, m, w, lang, fullHint);
  if (m.kind === "plan" && v.ver?.diff && m.background) return planFlatMarked(v, m, w, lang, fullHint);
  // Order (the same as the GUI): Why, the recommendation (what follows its headline), You decide, Against, Assumptions, then the rest of the background, then Affected
  const tm = termMarks(m);
  const textMarks = [...labelMarks(m), ...tm];
  const front: string[] = [];
  if (m.why) front.push(`${BOLD}${m.why.heading}${RESET}`, ...renderMarkdown(m.why.text, w, { lang, marks: tm }), "");
  const recText = m.recRest ?? (m.recommendation && !m.headline ? m.recommendation : null);
  if (recText) front.push(...recBox(recText, w, { rows, full: v.recFull, lang, marks: textMarks }), "");
  if (m.unknowns.length) front.push(...wrap(`${BOLD}${YELLOW}${t(lang, "you_decide")}${RESET} ${inline(m.unknowns.join(" · "), { marks: tm })}`, w), "");
  if (m.against) {
    front.push(`${BOLD}${t(lang, "against_title")}${RESET}`);
    for (const l of wrap(inline(m.against, { marks: textMarks }), Math.max(8, w - 2))) front.push(`${DIM}▏${RESET} ${l}`);
    front.push("");
  }
  if (m.assumptions.length) {
    front.push(`${BOLD}${t(lang, "assumptions_title")}${RESET}`);
    for (const a of m.assumptions) wrap(inline(a, { marks: textMarks }), Math.max(8, w - 2)).forEach((l, k) => front.push((k === 0 ? `${GREEN}☐${RESET} ` : "  ") + l));
    front.push(`${t(lang, "assumptions_note")}`, "");
  }
  const rest: Left = { secRows: [], ...(m.background ? renderMarkdownRich(m.background, w, { fullHint, lang, marks: tm, termsHeadings: TERMS_HEADINGS }) : { lines: [], wide: [], footnotes: [] }) };
  const back = m.affects.length ? wrap(`${t(lang, "affects_title")} ${affectsText(m).slice(2)}`, w) : [];
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
  if (v.list) left = `${t(lang, "footer_list")}`;
  else if (v.history) left = `${t(lang, "footer_history_list")}`;
  else if (v.histDetail) left = `${t(lang, "footer_history_detail")}`;
  else if (o.full) left = `${t(lang, "pending_n", { n: v.pending })}  ${t(lang, "footer_full")}`;
  else {
    left = `${t(lang, "pending_n", { n: v.pending })}  ${t(lang, v.model?.plan ? "footer_switch_plan" : "footer_switch")}${v.ver ? `  ${t(lang, "footer_versions")}` : ""}${hscrollable ? `  ${t(lang, "footer_hscroll_fig")}` : ""}  ${t(lang, "footer_list_quit")}${(v.model?.history?.total ?? 0) > 1 ? `  ${t(lang, "footer_history")}` : ""}${overflow ? `  ${t(lang, "footer_overflow")}` : ""}`;
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
      out.push(truncate(`${on ? `${BOLD}▸${RESET}` : " "} ${it.plan.isNew && !it.plan.writing ? `${CYAN}●${RESET}` : " "} ${it.plan.isNew ? (on ? BOLD : "") : ""}${it.title}${RESET}${it.plan.writing ? ` ${BOLD}${t(v.lang, "plan_writing")}${RESET}` : ""}`, cols));
      out.push(truncate(`      ${meta}`, cols));
      return;
    }
    const meta = [it.kindLabel, elapsed(it.createdAt, v.now, v.lang), it.noExplanation ? t(v.lang, "no_explanation") : "", it.current ? t(v.lang, "current") : ""]
      .filter(Boolean)
      .join(" · ");
    const mark = it.blocker ? `${BADGE_BLOCKER} ${t(v.lang, "task_badge")} ${RESET} ` : "";
    out.push(truncate(`${on ? `${BOLD}▸${RESET}` : " "} ${mark}${on ? BOLD : ""}${it.title}${RESET}`, cols));
    out.push(truncate(`    ${chipsText(it.chips)}  ${meta}`, cols));
  });
  return window(out, rows, 0);
}

const planCount = (lang: Lang, key: "plan_sections" | "plan_lines" | "plan_files", n: number): string => t(lang, n === 1 ? `${key}_one` : key, { n });

/** Row 2 of a plan file's header: `plans/ · Plan · updated 5m · 9 sections · 200 lines · 12 files · file.md` (the stats for a long plan only) */
function planFileMeta(m: ScreenModel, now: number, lang: Lang): string {
  const o = m.plan?.outline;
  const parts = [`[${t(lang, "kind_plan")}]`, `[${t(lang, "plan_updated_ago", { age: elapsed(m.createdAt, now, lang) })}]`];
  if (o) parts.push(`[${planCount(lang, "plan_sections", o.h2)} · ${planCount(lang, "plan_lines", o.lines)} · ${planCount(lang, "plan_files", o.files)}]`);
  parts.push(m.readonly!.name);
  return parts.join(" ");
}

/** The `s` overlay: when · first line of each instruction, the cursor kept in view */
function historyBody(v: View, cols: number, rows: number): string[] {
  const h = v.history!;
  const head = [`${BOLD}${t(v.lang, "history_title")}${RESET}`, ""];
  const size = Math.max(1, rows - head.length);
  const off = Math.max(0, Math.min(h.index - Math.floor(size / 2), h.items.length - size));
  const body = h.items.slice(off, off + size).map((it, k) => {
    const on = off + k === h.index;
    const when = padEnd(`${it.at ? elapsed(it.at, v.now, v.lang) : ""}`, 6);
    const mark = it.first ? `${YELLOW}${t(v.lang, "history_first")}${RESET} ` : "";
    const delivery = it.delivered === undefined ? "" : ` ${t(v.lang, it.delivered ? "history_delivered" : "history_undelivered")}`;
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
  return `${off > 0 ? "▲" : " "}${off < max ? "▼" : " "} ${off + 1}-${Math.min(total, off + size)}/${total}${hs}`;
}

/** Overlay a window, scrollbar and position indicator on an overflowing column. w is the column width including the bar */
function scrolled(all: string[], size: number, off: number, w: number, tail: string[], h?: { off: number; figW: number }): string[] {
  const max = all.length - size;
  // When it fits vertically, show neither the bar nor the ▲▼ position (keep only ◀▶ when shifted sideways)
  const bar = max > 0 ? scrollbar(size, all.length, off, max) : new Array<string>(size).fill(" ");
  const body = window(all, size, off).map((l, i) => `${padEnd(truncate(l, w - 1), w - 1)}${bar[i]}`);
  const pos = max > 0 ? position(off, max, size, all.length, h) : h && h.off > 0 ? `◀▶ ${h.off}/${h.figW}` : "";
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
    body[row] = " ".repeat(Math.max(0, Math.floor((cols - width(msg)) / 2))) + `${msg}`;
    return fin(body, []);
  }

  // Two rows for every kind: the title, then the context line (the checkpoint's note is the top of the left column, its headline is the recap's first sentence there)
  const rule = `${DIM}${"─".repeat(cols)}${RESET}`;
  const head = m.readonly
    ? [truncate(`${BOLD}${m.title}${RESET}`, cols), truncate(`[${PLANS_ANSI}●${RESET} ${PLANS_ANSI}${BOLD}plans/${RESET}] ${planFileMeta(m, v.now, v.lang)}`, cols), rule]
    : [...titleLines(m, cols, v.lang), ctxLine(m, v.now, cols, v.lang), rule];
  if (m.kind === "plan" && v.ver) head.splice(head.length - 1, 0, ...verHeader(v.ver, cols)); // under the context line, above the rule
  const bodyRows = Math.max(1, rows - head.length - 1);

  if (cols >= WIDE_COLS) {
    const SEP = " │ ";
    const full = v.full;
    const rightW = decisionWidth(cols);
    const leftW = full ? cols : cols - SEP.length - rightW;
    // Take one row for the heading (the focused column inverted); the rest is the column window
    const winRows = Math.max(1, bodyRows - 1);
    // The focused heading is inverted with a ▶ on the left (visible even in monochrome); the other is plain
    const heading = (label: string, w: number, on: boolean) => padEnd(on ? `\x1b[7m ▶ ${label} ${RESET}` : `   ${label}`, w);

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
    const hintRows = (r: Column, w: number): string[] => [truncate(`${r.hint}`, w)];
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
  const all = [...right.lines, "", right.hint, ...(leftAll.length ? ["", `${DIM}${"─".repeat(cols - 1)}${RESET}`, ...leftAll] : [])];
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
