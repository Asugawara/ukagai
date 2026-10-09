import { readdir, readFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { skillName } from "./skill-name.js";
import { RECENCY_WINDOW_MS, bodyHash, type PendingRewrite } from "../contract.js";
import type { DenyTemplate } from "./options.js";

// Implements the rules in docs/spec/explain.md.

/** Section headings: English first, Japanese alias second. */
export const SECTION = {
  why: ["Why this decision is needed now", "なぜ今この判断が要るか"],
  options: ["Options", "選択肢"],
  recommendation: ["Recommendation", "推奨"],
  diagram: ["Diagram", "図"],
  checked: ["What I checked", "確かめたこと"],
  diff: ["Related diff", "関係する差分"],
  blockerWhy: ["Why I stopped", "なぜ止まったか"],
  blockerTodo: ["What you need to do", "人にしてほしいこと"],
  impact: ["Scope and reversibility", "影響範囲と可逆性"],
  terms: ["Terms", "用語"],
  unknowns: ["What only you know", "あなたにしか分からないこと"],
  assumptions: ["Assumptions", "前提"],
  against: ["Counterargument", "反論"],
  affects: ["Affected", "影響を受けるもの"],
  quizWhy: ["Why this question now", "なぜ今この質問か"],
  quizPremise: ["Premise", "前提"],
  quizHow: ["How to answer", "答え方"],
} as const;

/** Fixed option labels for blockers (suffix "(Recommended)" allowed on the first). */
export const BLOCKER_LABELS = {
  done: ["Done. Continue", "対応した。続けて", "完了。続けて"],
  skip: ["Skip this step and continue", "この手順は飛ばして続けて", "この手順を飛ばして続けて"],
  stop: ["Stop here", "ここで中断", "ここで止める"],
} as const;

/** Table column detection (header cell text). The first column is always the option label. */
export const COLUMN_HAPPENS = /happens|outcome|起きること/i;
export const COLUMN_RISK = /risk|リスク/i;

/** Phrases that say the change cannot be undone. Checked before UNDO_WORDS. */
export const UNDO_BAD_WORDS =
  /\b(cannot|can't|can not|couldn't|won't) be (undone|restored|reverted|recovered|rolled back)\b|\bno way back\b|\birreversibl[ey]\b|\bunrecoverable\b|\bpermanent(ly)?\b|戻せない|戻せません|元に戻らない|元に戻せない|復元できない|取り消せない|二度と/i;
/** Phrases that say how to undo. */
export const UNDO_WORDS =
  /\b(undo|undone|revert|reverted|roll ?back|rolled back|restore|restored|reinstall|recreate|re-run|rerun|git (checkout|revert|reset|stash)|delete the|remove the)\b|戻せ|戻る|戻す|元に戻|消せ|やり直|再実行|再作成|復元/i;

export type MissingCode =
  | "file"
  | "front_matter"
  | "language"
  | "question"
  | "type"
  | "title"
  | "reversibility"
  | "scope"
  | "recommended"
  | "why"
  | "options"
  | "table"
  | "todo"
  | "recommend"
  | "recommend_long"
  | "recommend_cond"
  | "recommend_name"
  | "against_weak"
  | "assumptions_long"
  | "cell_long"
  | "coined_term"
  | "undo"
  | "why_long"
  | "diagram"
  | "diagram_trivial"
  | "checked"
  | "footnote"
  | "impact"
  | "multi"
  | "quiz_recommended"
  | "quiz_why"
  | "quiz_premise"
  | "quiz_leak";

export interface Has {
  mermaid: boolean;
  table: boolean;
  diff: boolean;
}

export interface Validation {
  valid: boolean;
  missing: MissingCode[];
  has: Has;
  question: string | null;
}

/** Names used in the deny reason (spec section 4) */
export const MISSING_LABELS: Record<MissingCode, string> = {
  file: "the explanation file itself",
  front_matter: "front matter (`ukagai: 1`)",
  language:
    "the configured language is Japanese: write the title, the explanation and the AskUserQuestion question / labels / descriptions in Japanese (code and proper nouns may stay)",
  question: "`question`",
  type: "`type` (decision / blocker / quiz)",
  title: "`title` (the decision for the human, in one sentence)",
  reversibility: "`reversibility`",
  scope: "`scope`",
  recommended: "`recommended` (label of the option you recommend)",
  why: 'the "Why this decision is needed now" section',
  options: 'the "Options" section',
  table: "the options table (first column is the label; columns for what happens if chosen and for risks and how to undo; one row per option)",
  todo: 'the "What you need to do" section (with a code block of commands)',
  recommend: 'the "Recommendation" section',
  recommend_long: 'the "Recommendation" section is too long (at most 5 sentences and 400 characters)',
  recommend_cond: 'a condition in "Recommendation" under which another option is right (write it as "if ... choose B", "when ...", "unless ...", etc.)',
  recommend_name:
    'the first sentence of "Recommendation" must name the recommended option by its label (quote its first words), not by position; do not refer to options by position ("the first one", "plan A")',
  against_weak: "the Counterargument repeats the Recommendation; make it attack the pick",
  assumptions_long: "at most 3 Assumptions: keep only premises you did not verify and that would change the pick",
  cell_long: "a cell in the options table is too long (at most 160 characters per cell)",
  coined_term:
    "internal identifiers the reader cannot know (plan codes, phase / gate / worker names). Say what each is in plain words, or define it under Terms",
  undo: "each risk cell must say how to undo (or that it cannot be undone)",
  why_long: 'the "Why this decision is needed now" section is too long (at most 600 characters; put details in "What I checked")',
  diagram:
    'a "Diagram" section with a Mermaid diagram that shows a sequence of 3+ steps between 2+ actors, a state machine with 4+ states, or a data flow between 3+ components (if none does, write one line under Options: "No diagram: <why>")',
  diagram_trivial:
    "remove the diagram: it only branches into the options or has 4 or fewer nodes, and the Options table already says it (draw only what the table cannot: a sequence between actors, a state machine, a data flow)",
  checked: 'the "What I checked" section (required unless reversible + file; commands run, files read, evidence as footnotes)',
  footnote: 'a footnote definition for every `[^n]` in the body (write `[^n]: evidence` in "What I checked")',
  impact: 'the "Scope and reversibility" section',
  multi: "one question per call",
  quiz_recommended: "a quiz must not recommend an answer; remove `recommended`",
  quiz_why: 'the "Why this question now" section (1 to 600 characters)',
  quiz_premise: 'the "Premise" section (non-empty, at most 600 characters)',
  quiz_leak: "the explanation repeats an option; a quiz explanation must not point at an answer",
};

const REVERSIBILITY = ["reversible", "costly", "irreversible"];
const SCOPE = ["file", "repo", "machine", "external"];
const TYPES = ["decision", "blocker", "quiz"];

// ---- helpers ----

export function toLines(markdown: string): string[] {
  return markdown.replace(/\r\n?/g, "\n").split("\n");
}

/** NFKC → drop whitespace → drop 「と」「・」 (Japanese aliases) → lowercase */
export function normalizeHeading(s: string): string {
  return s.normalize("NFKC").replace(/\s/gu, "").replace(/[と・]/gu, "").toLowerCase();
}

/**
 * Normalize an option label for matching (same rule in hook and GUI).
 * NFKC → strip a trailing `(Recommended)` / `（Recommended）` / `(推奨)` / `（推奨）`
 * → remove all whitespace → lowercase. Matching is exact on the normalized form.
 * (NFKC turns full-width parentheses into half-width ones, so only half-width needs checking afterwards.)
 */
export function normalizeLabel(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/\s*\((?:recommended|推奨)\)\s*$/iu, "")
    .replace(/\s/gu, "")
    .toLowerCase();
}

export interface FrontMatter {
  present: boolean;
  fields: Record<string, string>;
  /** First line of the body (0 without front matter) */
  bodyStart: number;
}

/** The lines of a block scalar with exactly their common leading-whitespace prefix removed (trailing spaces are kept, as in YAML) */
function dedent(block: string[]): string {
  const lead = block.filter((l) => l.trim() !== "").map((l) => /^[ \t]*/.exec(l)![0]);
  let prefix = lead[0] ?? "";
  for (const l of lead) {
    let k = 0;
    while (k < prefix.length && k < l.length && prefix[k] === l[k]) k++;
    prefix = prefix.slice(0, k);
  }
  return block.map((l) => (l.startsWith(prefix) ? l.slice(prefix.length) : "")).join("\n");
}

export function parseFrontMatter(lines: string[]): FrontMatter {
  if (lines[0]?.trimEnd() !== "---") return { present: false, fields: {}, bodyStart: 0 };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trimEnd() === "---") {
      close = i;
      break;
    }
  }
  if (close < 0) return { present: false, fields: {}, bodyStart: 0 };
  const fields: Record<string, string> = {};
  for (let i = 1; i < close; i++) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    let v = m[2]!.trim();
    // `question: |` (a literal block scalar, `question` only): the indented lines that follow, one indent removed, trailing newlines stripped
    if (m[1] === "question" && /^\|[+-]?$/.test(v)) {
      const block: string[] = [];
      let j = i + 1;
      while (j < close && (lines[j]!.trim() === "" || /^[ \t]/.test(lines[j]!))) block.push(lines[j++]!);
      while (block.length > 0 && block[block.length - 1]!.trim() === "") block.pop();
      fields["question"] = dedent(block);
      i = j - 1;
      continue;
    }
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    fields[m[1]!] = v;
  }
  return { present: true, fields, bodyStart: close + 1 };
}

export interface FenceBlock {
  lang: string;
  start: number;
  end: number;
}

export function scanFences(lines: string[]): { inFence: boolean[]; blocks: FenceBlock[] } {
  const inFence = new Array<boolean>(lines.length).fill(false);
  const blocks: FenceBlock[] = [];
  let open: { ch: string; len: number; lang: string; start: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!open) {
      const m = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/.exec(line);
      if (m) {
        open = { ch: m[1]![0]!, len: m[1]!.length, lang: m[2]!.toLowerCase(), start: i };
        inFence[i] = true;
      }
    } else {
      inFence[i] = true;
      const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (m && m[1]![0] === open.ch && m[1]!.length >= open.len) {
        blocks.push({ lang: open.lang, start: open.start, end: i });
        open = null;
      }
    }
  }
  if (open) blocks.push({ lang: open.lang, start: open.start, end: lines.length - 1 });
  return { inFence, blocks };
}

export interface Section {
  title: string;
  start: number;
  end: number;
}

export function scanHeadings(lines: string[], inFence: boolean[]): { level: number; title: string; line: number }[] {
  const out: { level: number; title: string; line: number }[] = [];
  lines.forEach((line, i) => {
    if (inFence[i]) return;
    const m = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) out.push({ level: m[1]!.length, title: m[2]!, line: i });
  });
  return out;
}

/**
 * Find a section by any of its names (English first, Japanese alias second).
 * Exact match on any name wins; otherwise the first partial match. English is case-insensitive.
 */
export function findSection(
  headings: { level: number; title: string; line: number }[],
  total: number,
  names: readonly string[],
): Section | null {
  const wants = names.map(normalizeHeading);
  const norm = headings.map((h) => normalizeHeading(h.title));
  // Prefer an exact match so that "Options" does not hit "Recommended options"
  let idx = norm.findIndex((t) => wants.includes(t));
  if (idx < 0) idx = norm.findIndex((t) => wants.some((w) => t.includes(w)));
  if (idx < 0) return null;
  const h = headings[idx]!;
  const next = headings.slice(idx + 1).find((x) => x.level <= h.level);
  return { title: h.title, start: h.line, end: next ? next.line : total };
}

export interface Table {
  header: string[];
  rows: string[][];
  /** Indexes of the columns other than the label (0), "what happens" and "risk" (empty for a 3-column table) */
  extraColumns: number[];
}

/** Columns after the label that are neither "what happens" nor "risk" */
function extraColumnsOf(header: string[]): number[] {
  const cells = header.map((h) => h.normalize("NFKC"));
  const happens = cells.findIndex((h) => COLUMN_HAPPENS.test(h));
  const risk = cells.findIndex((h) => COLUMN_RISK.test(h));
  return cells.map((_, i) => i).filter((i) => i > 0 && i !== happens && i !== risk);
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim());
}

const SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

export function findTables(lines: string[], inFence: boolean[], from: number, to: number): Table[] {
  const tables: Table[] = [];
  for (let i = from; i < to - 1; i++) {
    if (inFence[i] || inFence[i + 1]) continue;
    const head = lines[i]!;
    const sep = lines[i + 1]!;
    if (!head.includes("|") || !sep.includes("|") || !SEPARATOR.test(sep)) continue;
    const rows: string[][] = [];
    let j = i + 2;
    while (j < to && !inFence[j] && lines[j]!.includes("|") && lines[j]!.trim() !== "") {
      rows.push(splitRow(lines[j]!));
      j++;
    }
    const header = splitRow(head);
    tables.push({ header, rows, extraColumns: extraColumnsOf(header) });
    i = j - 1;
  }
  return tables;
}

function isEmptyCell(c: string | undefined): boolean {
  return c === undefined || /^[-—ー]*$/u.test(c.trim());
}

/** Indexes of the "what happens" and "risk" columns (-1 when missing) */
function columnsOf(t: Table): [number, number] {
  const cells = t.header.map((h) => h.normalize("NFKC"));
  return [cells.findIndex((h) => COLUMN_HAPPENS.test(h)), cells.findIndex((h) => COLUMN_RISK.test(h))];
}

/** spec 3.3 */
function tableOk(t: Table, labels: string[] | undefined): boolean {
  const cols = columnsOf(t);
  if (cols.some((c) => c < 0)) return false;
  if (t.rows.length < Math.max(2, labels?.length ?? 0)) return false;
  if (!t.rows.every((r) => cols.every((c) => !isEmptyCell(r[c])))) return false;
  if (labels) {
    const first = new Set(t.rows.map((r) => normalizeLabel(r[0] ?? "")));
    if (!labels.every((l) => first.has(normalizeLabel(l)))) return false;
  }
  return true;
}

/** Every risk cell says how to undo. In a blocker table, the fixed 3 labels are exempt */
function tableUndoOk(t: Table, blocker: boolean): boolean {
  const risk = columnsOf(t)[1];
  const fixed = Object.values(BLOCKER_LABELS).flatMap((names) => names.map(normalizeLabel));
  return t.rows.every((r) => (blocker && fixed.includes(normalizeLabel(r[0] ?? ""))) || (UNDO_BAD_WORDS.test(r[risk] ?? "") || UNDO_WORDS.test(r[risk] ?? "")));
}

/** Length limits (spec 3.2). Characters are code points after NFKC */
export const LIMITS = { recommendChars: 400, recommendSentences: 5, cellChars: 160, whyChars: 600, assumptions: 3 };

function cpLength(s: string): number {
  return [...s.normalize("NFKC")].length;
}

/** Body text of a section (without the heading, code blocks and blank lines) */
function sectionText(lines: string[], inFence: boolean[], s: Section): string {
  return lines
    .slice(s.start + 1, s.end)
    .filter((l, i) => !inFence[s.start + 1 + i] && l.trim() !== "")
    .map((l) => l.trim())
    .join("\n");
}

/** Sentence count. Splits on `。` `!` `?` and on a `.` followed by whitespace or the end (not `file.ts` or `0.5`) */
function countSentences(text: string): number {
  return text
    .normalize("NFKC")
    .split(/[。!?]+|\.(?=\s|$)/u)
    .filter((x) => x.trim() !== "").length;
}

/** Any cell in the "what happens" or "risk" column exceeds the limit */
function tableCellsLong(t: Table): boolean {
  const cols = columnsOf(t);
  return t.rows.some((r) => cols.some((c) => cpLength(r[c] ?? "") > LIMITS.cellChars));
}

/**
 * Whether "Recommendation" contains a condition under which another option is right (checks for words only).
 * Excludes `ならない` / `ならず` (as in なければならない) and `ときどき`; `なければ` counts unless followed by `なら…`.
 * `if` / `when` / `unless` / `otherwise` / `in case` are matched as whole words.
 */
export const RECOMMEND_COND =
  /なら(?!ない|ず)|なければ(?!なら)|場合|とき(?!どき)|であれば|際[はに]|\bif\b|\bwhen\b|\bunless\b|\botherwise\b|\bin case\b/i;

/** Text used for the condition check: without code blocks and callouts (lines starting with `>`) */
function condText(text: string): string {
  return text
    .split("\n")
    .filter((l) => !l.startsWith(">"))
    .join("\n");
}

/** Ways of calling an option by position, which the reader cannot map to a card */
export const POSITIONAL_REF =
  /1つ目|2つ目|3つ目|一つ目|二つ目|三つ目|最初の案|案 ?[A-D]\b|選択肢 ?[0-9]|\bthe (first|second|third) (one|option)\b|\boption [0-9A-D]\b|\bplan [A-D]\b/i;

const LABEL_MARK = "\uE000";

/** NFKC, no whitespace / backticks / asterisks, lowercase (for finding a label in a sentence) */
function nameForm(s: string): string {
  return s.normalize("NFKC").replace(/[\s`*]/gu, "").toLowerCase();
}

/** Replace every occurrence of `needle` (whitespace-insensitive, case-insensitive) in `text` with the placeholder; null when absent */
function maskLabel(text: string, needle: string): string | null {
  const chars = [...nameForm(needle)];
  if (chars.length === 0) return null;
  const esc = chars.map((c) => c.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("\\s*");
  // Short labels (`Go`) must not match inside another word (`Google`)
  const bound = chars.length <= 3;
  const re = new RegExp((bound ? "(?<![A-Za-z0-9])" : "") + esc + (bound ? "(?![A-Za-z0-9])" : ""), "giu");
  return re.test(text) ? text.replace(re, LABEL_MARK) : null;
}

/**
 * The first sentence of the Recommendation names the recommended option: it contains the whole label
 * (without `(Recommended)` / `(推奨)`) or its opening (first 3 words for a spaced English label, else first 12 characters).
 * The label is masked out before splitting into sentences, so a `.` / `。` or a positional word inside the label does not matter.
 * Calling the option by position ("the first one", "案 A") outside the label fails even when the label is there.
 */
function namesRecommended(recommendation: string, label: string): boolean {
  const bare = label.normalize("NFKC").replace(/\s*\((?:recommended|推奨)\)\s*$/iu, "").trim();
  const full = nameForm(bare);
  if (full === "") return true;
  const text = condText(recommendation).normalize("NFKC").replace(/[`*]/gu, "").trim();
  const words = bare.replace(/[`*]/gu, "").split(/\s+/u).filter((w) => w !== "");
  const opening = words.length > 3 && /^[\x00-\x7f]+$/u.test(bare) ? words.slice(0, 3).join(" ") : [...full].slice(0, 12).join("");
  const masked = maskLabel(text, bare) ?? maskLabel(text, opening);
  if (masked === null) return false;
  const m = /[。!?]|\.(?=\s|$)/u.exec(masked);
  const sentence = m ? masked.slice(0, m.index) : masked;
  return sentence.includes(LABEL_MARK) && !POSITIONAL_REF.test(sentence);
}

/** Number of top-level bullets in the Assumptions section (bullets indented deeper than the least-indented one, and fenced lines, excluded) */
function countBullets(lines: string[], inFence: boolean[], s: Section): number {
  const indents: number[] = [];
  for (let i = s.start + 1; i < s.end; i++) {
    const m = !inFence[i] ? /^(\s*)(?:[-*+]|\d+[.)])\s+\S/u.exec(lines[i]!) : null;
    if (m) indents.push(m[1]!.length);
  }
  const top = Math.min(...indents);
  return indents.filter((n) => n === top).length;
}

/** Lowercase NFKC text without whitespace, punctuation and symbols (for comparing two passages) */
function squash(s: string): string {
  return s.normalize("NFKC").replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
}

/** The Counterargument body is a substring of the Recommendation body (it restates the pick instead of attacking it) */
function againstRepeats(against: string, recommendation: string): boolean {
  const a = squash(against);
  return a !== "" && squash(recommendation).includes(a);
}

function hasContent(lines: string[], s: Section): boolean {
  return lines.slice(s.start + 1, s.end).some((l) => l.trim() !== "");
}

function sectionHasMermaid(blocks: FenceBlock[], s: Section): boolean {
  return blocks.some((b) => b.lang === "mermaid" && b.start > s.start && b.start < s.end);
}

/** A line under Options that says why no diagram is drawn ("No diagram: <reason>", "図なし: <理由>") */
const NO_DIAGRAM_NOTE = /^\s*(?:>\s*)?(?:[-*]\s+)?(?:\*\*|_)?(?:no diagram|diagram:\s*none|図(?:は)?(?:なし|不要|省略))(?:\*\*|_)?\s*[:：—–,-]?\s*(\S.{7,})$/iu;

function hasNoDiagramNote(lines: string[], inFence: boolean[], s: Section): boolean {
  for (let i = s.start + 1; i < s.end; i++) {
    if (!inFence[i] && NO_DIAGRAM_NOTE.test(lines[i]!)) return true;
  }
  return false;
}

/** Node labels of a flowchart / graph block (null for any other diagram type) */
export function flowchartNodes(source: string): string[] | null {
  const raw = source.split(/\r?\n/);
  let i = 0;
  if (raw[0]?.trim() === "---") {
    i = raw.findIndex((l, n) => n > 0 && l.trim() === "---") + 1;
    if (i === 0) return null;
  }
  while (i < raw.length && (raw[i]!.trim() === "" || /^\s*%%/.test(raw[i]!))) i++;
  const head = /^\s*(?:flowchart|graph)\b(.*)$/i.exec(raw[i] ?? "");
  if (!head) return null;
  const nodes = new Map<string, string>();
  const NODE = /([A-Za-z0-9_]+)(?:\s*(\[\[[^\]]*\]\]|\[[^\]]*\]|\(\([^)]*\)\)|\([^)]*\)|\{[^}]*\}))?/y;
  const ARROW = /(?:<|[ox])?(?:-{2,}|={2,}|-\.+-)[>ox-]?/y;
  const statements = raw
    .slice(i + 1)
    .filter((l) => !/^\s*(?:%%|subgraph\b|end\b|classDef\b|class\b|style\b|linkStyle\b|click\b|direction\b)/.test(l))
    .join("\n")
    .replace(/(--|==)\s+[^\n|\[\](){}]+?\s+(-->|==>)/g, "$2")
    .replace(/\|[^|\n]*\|/g, " ");
  for (const stmt of statements.split(/[;\n]/)) {
    let pos = 0;
    while (pos < stmt.length) {
      ARROW.lastIndex = pos;
      if (ARROW.test(stmt)) {
        pos = ARROW.lastIndex;
        continue;
      }
      NODE.lastIndex = pos;
      const m = NODE.exec(stmt);
      if (m) {
        const width = m[2] && (m[2].startsWith("[[") || m[2].startsWith("((")) ? 2 : 1;
        const shape = m[2]?.slice(width, -width).replace(/^"|"$/g, "").trim();
        if (shape || !nodes.has(m[1]!)) nodes.set(m[1]!, shape || m[1]!);
        pos = NODE.lastIndex;
      } else pos++;
    }
  }
  return [...nodes.values()];
}

function labelKey(s: string): string {
  return normalizeLabel(s.replace(/<br\s*\/?>/gi, " "));
}

/** Node count of the first trivial flowchart: 4 or fewer nodes, or at least half the labels equal an option label (null when none is trivial) */
function trivialDiagram(blocks: FenceBlock[], lines: string[], optionLabels: string[]): number | null {
  const options = new Set(optionLabels.map(labelKey).filter((l) => l !== ""));
  for (const b of blocks) {
    if (b.lang !== "mermaid") continue;
    const nodes = flowchartNodes(lines.slice(b.start + 1, b.end).join("\n"));
    if (!nodes) continue;
    const same = nodes.filter((n) => options.has(labelKey(n))).length;
    if (nodes.length <= 4 || same * 2 >= nodes.length) return nodes.length;
  }
  return null;
}

function hasOf(lines: string[], inFence: boolean[], blocks: FenceBlock[]): Has {
  return {
    mermaid: blocks.some((b) => b.lang === "mermaid"),
    diff: blocks.some((b) => b.lang === "diff"),
    table: findTables(lines, inFence, 0, lines.length).length > 0,
  };
}

// ---- parsers for the optional sections (shared with the TUI) ----

/** Inside the body, outside code fences, with the front matter dropped */
function bodyOf(markdown: string): { lines: string[]; inFence: boolean[]; headings: ReturnType<typeof scanHeadings> } {
  const all = toLines(markdown);
  const lines = all.slice(parseFrontMatter(all).bodyStart);
  const { inFence } = scanFences(lines);
  return { lines, inFence, headings: scanHeadings(lines, inFence) };
}

/**
 * Bullet items (`-` / `*` / `+` / `1.`) of the section named by `names` (e.g. `SECTION.unknowns`), marker removed.
 * Indented continuation lines are joined with a space. Empty when the section is missing.
 */
export function parseBullets(markdown: string, names: readonly string[]): string[] {
  const { lines, inFence, headings } = bodyOf(markdown);
  const sec = findSection(headings, lines.length, names);
  if (!sec) return [];
  const out: string[] = [];
  for (let i = sec.start + 1; i < sec.end; i++) {
    if (inFence[i]) continue;
    const m = /^ {0,3}(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/.exec(lines[i]!);
    if (m) out.push(m[1]!);
    else if (out.length > 0 && /^\s{2,}\S/.test(lines[i]!)) out[out.length - 1] += " " + lines[i]!.trim();
  }
  return out;
}

export interface TermDef {
  term: string;
  definition: string;
}

/**
 * Items of the Terms section. Accepted shapes:
 * `- **term** — definition`, `- **term**: definition`, `- term — definition` (a `:` also works for the plain form).
 * Items without a separator or with an empty side are skipped.
 */
export function parseTerms(markdown: string): TermDef[] {
  const out: TermDef[] = [];
  for (const item of parseBullets(markdown, SECTION.terms)) {
    const bold = /^\*\*(.+?)\*\*\s*(?:[:：]|[—–―-]+)?\s*(.*)$/.exec(item);
    let term: string;
    let definition: string;
    if (bold) {
      term = bold[1]!;
      definition = bold[2]!;
    } else {
      const m = /^(.+?)\s*(?:\s[—–―-]+\s|[:：]\s*|[—―]\s*)(.+)$/.exec(item);
      if (!m) continue;
      term = m[1]!;
      definition = m[2]!;
    }
    term = term.replace(/[:：]$/, "").trim();
    definition = definition.trim();
    if (term && definition) out.push({ term, definition });
  }
  return out;
}

export interface Footnotes {
  /** `[^id]: text` definitions, anywhere in the body (first one wins for a repeated id) */
  defs: { id: string; text: string }[];
  /** Distinct `[^id]` references in the order they appear (definitions and code are not references) */
  refs: string[];
}

export function parseFootnotes(markdown: string): Footnotes {
  const { lines, inFence } = bodyOf(markdown);
  const defs: { id: string; text: string }[] = [];
  const refs: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (inFence[i]) continue;
    const d = /^ {0,3}\[\^([^\]\s]+)\]:\s*(.*)$/.exec(lines[i]!);
    if (d) {
      let text = d[2]!.trim();
      while (i + 1 < lines.length && !inFence[i + 1] && /^(?: {2,}|\t)\S/.test(lines[i + 1]!)) text += " " + lines[++i]!.trim();
      if (!defs.some((x) => x.id === d[1])) defs.push({ id: d[1]!, text });
      continue;
    }
    for (const m of lines[i]!.replace(/`[^`]*`/g, "").matchAll(/\[\^([^\]\s]+)\](?!:)/g)) {
      if (!refs.includes(m[1]!)) refs.push(m[1]!);
    }
  }
  return { defs, refs };
}

// ---- coined terms (spec section 3.8) ----

/** Common abbreviations, units and product-ish codes that are not plan identifiers (uppercase, compared whole) */
export const COINED_ALLOW = new Set(
  (
    "CI CD CLI API GUI TUI SSE URL URI HTTP HTTPS JSON YAML TOML HTML CSS JS TS PR OSS DB UI UX OK NG ID CPU GPU RAM GB MB KB TB MS TTY ANSI SQL SSH TLS SSL DNS IP TCP UDP GCP AWS GCS S3 IAM VM OS PID ENV NPM PNPM CDN SVG PNG JPG PDF CSV UTF IDE LSP MCP LLM AI QA ADR README TODO FAQ EOF CRUD REST RPC GRPC JWT SDK ETA TBD WIP NFKC SGR ESC CJK IME UTC ISO RFC HEAD " +
    "SHA RSA AES HMAC GPT IPV MD5 MP3 MP4 EC2 K8S P50 P90 P95 P99 " +
    "ARM64 ARM32 X86 X64 ES5 ES6 ES7 E2E W3C X11 CO2 H2O V8 R2 U2 Z3 A100 H100 H264 H265 AV1 VP9 DB2 IE11 PS5 PS4 SOC2 SAML2 PCI MPEG D3 BM25 B2B B2C C2C P2P I18N L10N A11Y OIDC " +
    "M1 M2 M3 M4 L1 L2 L3 L4 Q1 Q2 Q3 Q4 H1 H2 T1 T2 T3 " +
    "C4 TS5 PG16 S3A F-16 B-52"
  ).split(" "),
);

/** A short code: 1-4 letters, optional `-`, 1-4 letters / digits, with a digit or `-` in it (`W-T2`, `FT4`, `P-GH`, `TM28`) */
export const COINED_TOKEN = /\b[A-Z]{1,4}\d{0,3}-[A-Z0-9]{1,4}\b|\b[A-Z]{1,4}\d{1,3}[A-Z]?\b/g;

/** Well-known code shapes blanked out before scanning: fiscal years, CVE ids, cloud regions, PCI-DSS, elliptic curves (`P-256`), MPEG-4, PM2.5 */
export const COINED_SKIP =
  /\bFY\d{2,4}\b|\bCVE-\d{4}-\d+\b|\b(?:US|EU|AP|SA|CA|ME|AF|ASIA|EUROPE|NORTHAMERICA)-[A-Z]+-?\d\b|\bPCI-DSS\b|\bP-?\d{3}\b|\bMPEG-\d\b|\bPM2\.5\b/g;

const PHASE_WORDS = ["Phase", "Step", "Stage", "Sprint", "Milestone", "Gate", "Track", "Wave", "Round", "Batch", "Lane"];
const anyCase = (w: string): string => [...w].map((c) => `[${c.toUpperCase()}${c.toLowerCase()}]`).join("");
/** A process word plus a number / letter: `Phase 2`, `Gate B`, `Step 3a` (the keyword in any case; the id is digits or capitals so that "step by step" is not hit) */
export const COINED_PHASE_EN = new RegExp(
  `\\b(?:${PHASE_WORDS.map(anyCase).join("|")})\\s?(\\d{1,3}[A-Za-z]?|[A-Z][A-Z0-9]{0,2})(?![A-Za-z0-9]|-[A-Z0-9])`,
  "g",
);
/** Japanese: `フェーズ 2`, `第 3 段階` (matched on `第 3`) */
export const COINED_PHASE_JA = /(?:フェーズ|ステップ|段階|工程|ゲート|トラック|ラウンド|第)\s?([0-9A-Z]{1,3})(?![A-Za-z0-9]|-[A-Z0-9])/g;

/** A pointer that defines nothing */
const TERM_POINTER = /plan\s*の行|the plan item|see plan|計画の項目/gi;
const TERM_MIN_CHARS = 12;

function coinedAllowed(token: string): boolean {
  if (COINED_ALLOW.has(token)) return true;
  const prefix = /^[A-Z]+/.exec(token)?.[0] ?? "";
  return prefix.length >= 3 && COINED_ALLOW.has(prefix);
}

/** Identifier-like tokens in a piece of text, in order of appearance (NFKC; URLs ignored) */
export function extractCoined(text: string): string[] {
  const s = text
    .normalize("NFKC")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(COINED_SKIP, (m) => " ".repeat(m.length));
  const found: { at: number; token: string }[] = [];
  for (const m of s.matchAll(COINED_TOKEN)) {
    const t = m[0];
    if (coinedAllowed(t)) continue;
    if (/v\d[\w.]*-$/i.test(s.slice(Math.max(0, m.index - 24), m.index))) continue; // part of a version such as v0.2.0-DT1
    found.push({ at: m.index, token: t });
  }
  for (const re of [COINED_PHASE_EN, COINED_PHASE_JA]) {
    for (const m of s.matchAll(re)) {
      if (COINED_ALLOW.has(m[1]!.toUpperCase())) continue;
      found.push({ at: m.index, token: m[0] });
    }
  }
  const out: string[] = [];
  for (const f of found.sort((a, b) => a.at - b.at)) if (!out.includes(f.token)) out.push(f.token);
  return out;
}

/** A Terms definition that says something: at least 12 characters once pointers such as "plan の行" are removed */
function termDefines(definition: string): boolean {
  const rest = definition.normalize("NFKC").replace(TERM_POINTER, "").replace(/^[\s\p{P}\p{S}]+/u, "").trim();
  return cpLength(rest) >= TERM_MIN_CHARS;
}

/**
 * Internal identifiers in the explanation (title + body outside code fences; inline code counts) that Terms does not define.
 * Tokens in `question`, in option labels (`labels` and the first column of the Options tables) and in `recommended` are exempt.
 */
export function findCoinedTerms(markdown: string, labels: string[] = []): string[] {
  const all = toLines(markdown);
  const fm = parseFrontMatter(all);
  const lines = all.slice(fm.bodyStart);
  const { inFence } = scanFences(lines);
  const exempt = new Set<string>();
  const exemptText = [fm.fields["question"] ?? "", fm.fields["recommended"] ?? "", ...labels];
  const options = findSection(scanHeadings(lines, inFence), lines.length, SECTION.options);
  if (options) for (const t of findTables(lines, inFence, options.start + 1, options.end)) for (const r of t.rows) exemptText.push(r[0] ?? "");
  for (const x of exemptText) for (const t of extractCoined(x)) exempt.add(t);
  for (const d of parseTerms(markdown)) if (termDefines(d.definition)) for (const t of extractCoined(d.term)) exempt.add(t);
  const text = [fm.fields["title"] ?? "", ...lines.filter((_, i) => !inFence[i])].join("\n");
  return extractCoined(text).filter((t) => !exempt.has(t));
}

/** `MISSING_LABELS.coined_term` with the tokens listed (at most 8) */
export function coinedTermLabel(tokens: string[], withRemedy = true): string {
  const shown = tokens.slice(0, 8).join(", ");
  const more = tokens.length > 8 ? ` and ${tokens.length - 8} more` : "";
  const label = MISSING_LABELS.coined_term.replace("(plan codes", `(${shown}${more}; plan codes`);
  // another sentence of the deny reason already says "Replace each with plain words or define it under Terms"
  return withRemedy ? label : label.replace(/\. Say what each is.*$/, "");
}

// ---- "Cannot answer" enforcement (spec section 15) ----

/** Recommendation limits after an "Unclear" answer: half of the usual ones */
export const UNCLEAR_LIMITS = { chars: 200, sentences: 3 };

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `term` as a whole word (ASCII edges must not touch a letter / digit), case-insensitive, NFKC */
function termRegex(term: string): RegExp {
  const t = term.normalize("NFKC").trim();
  const left = /^[A-Za-z0-9]/.test(t) ? "(?<![A-Za-z0-9])" : "";
  const right = /[A-Za-z0-9]$/.test(t) ? "(?![A-Za-z0-9])" : "";
  return new RegExp(left + escapeRe(t) + right, "i");
}

/**
 * Which of `terms` (words the human said they could not understand) the explanation still uses without defining them:
 * they appear in the title or the body outside code fences, and Terms has no definition (see termDefines) naming them.
 * Option labels, the first column of the Options tables, `question` and `recommended` are exempt, as for coined terms.
 */
export function findUndefinedTerms(markdown: string, terms: string[], labels: string[] = []): string[] {
  const all = toLines(markdown);
  const fm = parseFrontMatter(all);
  const lines = all.slice(fm.bodyStart);
  const { inFence } = scanFences(lines);
  const exemptText = [fm.fields["question"] ?? "", fm.fields["recommended"] ?? "", ...labels];
  const options = findSection(scanHeadings(lines, inFence), lines.length, SECTION.options);
  if (options) for (const t of findTables(lines, inFence, options.start + 1, options.end)) for (const r of t.rows) exemptText.push(r[0] ?? "");
  const exempt = exemptText.join("\n").normalize("NFKC");
  const defined = parseTerms(markdown).filter((d) => termDefines(d.definition));
  const text = [fm.fields["title"] ?? "", ...lines.filter((_, i) => !inFence[i])].join("\n").normalize("NFKC");
  const out: string[] = [];
  for (const term of terms) {
    const re = termRegex(term);
    if (!re.test(text) || re.test(exempt) || defined.some((d) => re.test(d.term.normalize("NFKC")))) continue;
    if (!out.includes(term)) out.push(term);
  }
  return out;
}

export interface RewriteIssue {
  code: MissingCode;
  /** The sentence for the deny reason, in the same register as MISSING_LABELS */
  text: string;
}

/** Sentence equal to the question once whitespace, punctuation and case are squashed */
function sameQuestion(a: string, b: string): boolean {
  const x = squash(a);
  return x !== "" && x === squash(b);
}

/**
 * What the human's last "Cannot answer" still demands of this explanation (spec section 15). Empty when nothing is violated.
 * 1. identical body (hash) -> coined_term; 2. Undefined terms still used undefined -> coined_term;
 * 3. Unclear and the Recommendation over 200 characters / 3 sentences -> recommend_long;
 * 4. Too much at once and the same question -> multi.
 */
export function checkRewrite(memo: PendingRewrite, markdown: string, question: string, labels: string[] = []): RewriteIssue[] {
  if (!memo) return [];
  const issues: RewriteIssue[] = [];
  if (bodyHash(markdown) === memo.body_hash) {
    issues.push({
      code: "coined_term",
      text: "the human could not answer the previous explanation; this one is identical. Rewrite it",
    });
  }
  if (memo.reason === "Undefined terms") {
    const left = findUndefinedTerms(markdown, memo.terms, labels);
    if (left.length > 0) {
      issues.push({
        code: "coined_term",
        text: `the human said they could not understand: ${left.join(", ")}. Replace each with plain words or define it under Terms`,
      });
    }
  } else if (memo.reason === "Unclear") {
    const all = toLines(markdown);
    const lines = all.slice(parseFrontMatter(all).bodyStart);
    const { inFence } = scanFences(lines);
    const rec = findSection(scanHeadings(lines, inFence), lines.length, SECTION.recommendation);
    if (rec) {
      const text = sectionText(lines, inFence, rec);
      if (cpLength(text) > UNCLEAR_LIMITS.chars || countSentences(text) > UNCLEAR_LIMITS.sentences) {
        issues.push({
          code: "recommend_long",
          text: "the human said the explanation was unclear; keep the Recommendation to 3 sentences",
        });
      }
    }
  } else if (sameQuestion(question, memo.question)) {
    issues.push({ code: "multi", text: "the human said it was too much at once; split it: ask the first decision only" });
  }
  return issues;
}

// ---- quiz (type: quiz) ----

/** Codes for the quiz sections, in evaluation order: quiz_why, quiz_premise, quiz_leak */
function quizMissing(lines: string[], inFence: boolean[], headings: ReturnType<typeof scanHeadings>, labels?: string[]): MissingCode[] {
  const out: MissingCode[] = [];
  const why = findSection(headings, lines.length, SECTION.quizWhy);
  if (!why || !hasContent(lines, why) || cpLength(sectionText(lines, inFence, why)) > LIMITS.whyChars) out.push("quiz_why");
  const premise = findSection(headings, lines.length, SECTION.quizPremise);
  if (!premise || !hasContent(lines, premise) || cpLength(sectionText(lines, inFence, premise)) > LIMITS.whyChars) out.push("quiz_premise");
  const how = findSection(headings, lines.length, SECTION.quizHow);
  const body = nameForm(
    [why, premise, how]
      .filter((x): x is Section => x !== null)
      .map((x) => sectionText(lines, inFence, x))
      .join("\n"),
  );
  const leaked = (labels ?? []).some((l) => {
    const bare = nameForm(l.replace(/\s*[(（](?:recommended|推奨)[)）]\s*$/iu, ""));
    return [...bare].length >= QUIZ_LEAK_MIN && body.includes(bare);
  });
  if (leaked) out.push("quiz_leak");
  return out;
}

/** Option labels shorter than this are not looked for in a quiz explanation */
const QUIZ_LEAK_MIN = 6;

// ---- validation ----

/** A Japanese character (hiragana, katakana or han) */
const HAS_JAPANESE = /[\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Han}]/u;

/** spec section 4. Plans (ExitPlanMode) are delegated to validatePlan */
export function validateExplanation(
  markdown: string,
  kind: "answer_question" | "approve_plan" = "answer_question",
  labels?: string[],
  lang: "en" | "ja" = "en",
  ask?: { question?: string; descriptions?: string[] },
): Validation {
  if (kind === "approve_plan") return validatePlan(markdown);
  const all = toLines(markdown);
  const fm = parseFrontMatter(all);
  const lines = all.slice(fm.bodyStart);
  const { inFence, blocks } = scanFences(lines);
  const headings = scanHeadings(lines, inFence);
  const missing: MissingCode[] = [];
  const f = fm.fields;

  if (!fm.present || f["ukagai"] !== "1") missing.push("front_matter");
  if (lang === "ja") {
    const quiz = f["type"] === "quiz";
    const whySec = findSection(headings, lines.length, quiz ? SECTION.quizWhy : f["type"] === "blocker" ? SECTION.blockerWhy : SECTION.why);
    const premiseSec = quiz ? findSection(headings, lines.length, SECTION.quizPremise) : null;
    const prose = [f["title"] ?? "", whySec ? sectionText(lines, inFence, whySec) : "", premiseSec ? sectionText(lines, inFence, premiseSec) : ""].join("\n");
    const descs = (ask?.descriptions ?? []).filter((d) => d.trim() !== "");
    if (
      !HAS_JAPANESE.test(prose) ||
      (ask?.question !== undefined && !HAS_JAPANESE.test(ask.question)) ||
      (descs.length > 0 && !descs.some((d) => HAS_JAPANESE.test(d)))
    ) {
      missing.push("language");
    }
  }
  if (fm.present) {
    if (!f["question"]) missing.push("question");
    if (f["type"] !== undefined && !TYPES.includes(f["type"])) missing.push("type");
    if (!f["title"]) missing.push("title");
    if (!f["reversibility"] || !REVERSIBILITY.includes(f["reversibility"])) missing.push("reversibility");
    if (!f["scope"] || !SCOPE.includes(f["scope"])) missing.push("scope");
    const rec = f["recommended"];
    if (f["type"] === "quiz") {
      if (rec !== undefined) missing.push("quiz_recommended");
    } else if (!rec || (labels && !labels.some((l) => normalizeLabel(l) === normalizeLabel(rec)))) missing.push("recommended");
  }

  if (f["type"] === "quiz") {
    missing.push(...quizMissing(lines, inFence, headings, labels));
    return {
      valid: missing.length === 0,
      missing,
      has: hasOf(lines, inFence, blocks),
      question: f["question"] ? f["question"] : null,
    };
  }

  const blocker = f["type"] === "blocker";
  const why = findSection(headings, lines.length, blocker ? SECTION.blockerWhy : SECTION.why);
  if (!why || !hasContent(lines, why)) missing.push("why");
  else if (cpLength(sectionText(lines, inFence, why)) > LIMITS.whyChars) missing.push("why_long");

  const options = findSection(headings, lines.length, SECTION.options);
  let okTables: Table[] = [];
  if (!options) missing.push("options");
  else {
    const tables = findTables(lines, inFence, options.start + 1, options.end);
    okTables = tables.filter((t) => tableOk(t, labels));
    if (okTables.length === 0) missing.push("table");
    else if (okTables.some((t) => tableCellsLong(t))) missing.push("cell_long");
  }
  if (findCoinedTerms(markdown, labels).length > 0) missing.push("coined_term");
  if (okTables.length > 0 && okTables.some((t) => !tableUndoOk(t, blocker))) missing.push("undo");

  if (blocker) {
    const todo = findSection(headings, lines.length, SECTION.blockerTodo);
    if (!todo || !hasContent(lines, todo) || !blocks.some((b) => b.start > todo.start && b.start < todo.end)) {
      missing.push("todo");
    }
  } else {
    const recommend = findSection(headings, lines.length, SECTION.recommendation);
    if (!recommend || !hasContent(lines, recommend)) missing.push("recommend");
    else {
      const text = sectionText(lines, inFence, recommend);
      if (cpLength(text) > LIMITS.recommendChars || countSentences(text) > LIMITS.recommendSentences) {
        missing.push("recommend_long");
      }
      if (!RECOMMEND_COND.test(condText(text))) missing.push("recommend_cond");
      if (f["recommended"] && !namesRecommended(text, f["recommended"])) missing.push("recommend_name");
      const against = findSection(headings, lines.length, SECTION.against);
      if (against && againstRepeats(sectionText(lines, inFence, against), text)) missing.push("against_weak");
    }
    const assumptions = findSection(headings, lines.length, SECTION.assumptions);
    if (assumptions && countBullets(lines, inFence, assumptions) > LIMITS.assumptions) missing.push("assumptions_long");
  }

  const scope = f["scope"] ?? "";
  const rev = f["reversibility"] ?? "";
  const scopeKnown = SCOPE.includes(scope);
  const revKnown = REVERSIBILITY.includes(rev);
  // Required unless reversible with a scope of file / repo (repo + reversible is optional)
  const diagramRequired =
    !blocker &&
    (!scopeKnown || !revKnown || rev !== "reversible" || scope === "machine" || scope === "external");
  const trivial = blocker ? null : trivialDiagram(blocks, lines, okTables.flatMap((t) => t.rows.map((r) => r[0] ?? "")));
  if (diagramRequired && trivial === null) {
    const diagram = findSection(headings, lines.length, SECTION.diagram);
    const noted = options !== null && hasNoDiagramNote(lines, inFence, options);
    if ((!diagram || !sectionHasMermaid(blocks, diagram)) && !noted) missing.push("diagram");
  }
  if (trivial !== null) missing.push("diagram_trivial");

  if (!blocker) {
    // Required unless reversible + file
    if (!(rev === "reversible" && scope === "file")) {
      const checked = findSection(headings, lines.length, SECTION.checked);
      if (!checked || !hasContent(lines, checked)) missing.push("checked");
    }
    const notes = parseFootnotes(markdown);
    const defined = new Set(notes.defs.map((d) => d.id));
    if (notes.refs.some((id) => !defined.has(id))) missing.push("footnote");
  }

  return {
    valid: missing.length === 0,
    missing,
    has: hasOf(lines, inFence, blocks),
    question: f["question"] ? f["question"] : null,
  };
}

export interface PlanImpact {
  reversibility?: "reversible" | "costly" | "irreversible";
  scope?: "file" | "repo" | "machine" | "external";
}

/**
 * Reads `Reversibility:` / `Scope:` (also `reversibility:`, `可逆性:`, `影響範囲:`; bullets, bold and backticks allowed)
 * from the "Scope and reversibility" section of a plan. Values are the English words. Missing or unknown values are left out.
 */
export function parsePlanImpact(plan: string): PlanImpact {
  const lines = toLines(plan);
  const { inFence } = scanFences(lines);
  const sec = findSection(scanHeadings(lines, inFence), lines.length, SECTION.impact);
  const out: PlanImpact = {};
  if (!sec) return out;
  for (let i = sec.start + 1; i < sec.end; i++) {
    if (inFence[i]) continue;
    const m = /^\s*(?:[-*+]\s+)?\**(reversibility|可逆性|scope|影響範囲)\**\s*[:：]\s*\**`?([A-Za-z]+)`?\**/i.exec(lines[i]!);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const val = m[2]!.toLowerCase();
    if ((key === "reversibility" || key === "可逆性") && out.reversibility === undefined && REVERSIBILITY.includes(val)) {
      out.reversibility = val as PlanImpact["reversibility"];
    } else if ((key === "scope" || key === "影響範囲") && out.scope === undefined && SCOPE.includes(val)) {
      out.scope = val as PlanImpact["scope"];
    }
  }
  return out;
}

/** spec section 9: a non-empty "Scope and reversibility" section exists */
export function validatePlan(plan: string): Validation {
  const lines = toLines(plan);
  const { inFence, blocks } = scanFences(lines);
  const headings = scanHeadings(lines, inFence);
  const sec = findSection(headings, lines.length, SECTION.impact);
  const missing: MissingCode[] = !sec || !hasContent(lines, sec) ? ["impact"] : [];
  return { valid: missing.length === 0, missing, has: hasOf(lines, inFence, blocks), question: null };
}

// ---- lookup ----

export interface FoundExplanation {
  path: string;
  markdown: string;
  match: "question" | "recency";
}

/** spec section 5, step 1. Exact `question:` match (latest mtime) → the single unused file within 10 minutes → null */
export async function findExplanation(
  dir: string,
  question: string,
  now: number = Date.now(),
): Promise<FoundExplanation | null> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".md") && !n.endsWith(".used.md"));
  } catch {
    return null;
  }
  const files: { path: string; markdown: string; mtimeMs: number; question: string | undefined }[] = [];
  for (const n of names) {
    const path = join(dir, n);
    try {
      const [markdown, st] = await Promise.all([readFile(path, "utf8"), stat(path)]);
      files.push({
        path,
        markdown,
        mtimeMs: st.mtimeMs,
        question: parseFrontMatter(toLines(markdown)).fields["question"],
      });
    } catch {
      // ignore unreadable files
    }
  }
  const exact = files.filter((f) => f.question === question).sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  if (exact) return { path: exact.path, markdown: exact.markdown, match: "question" };
  const recent = files.filter((f) => now - f.mtimeMs <= RECENCY_WINDOW_MS);
  if (recent.length === 1) return { path: recent[0]!.path, markdown: recent[0]!.markdown, match: "recency" };
  return null;
}

/** Rename `<name>.md` to `<name>.used.md` and return the new path */
export async function markUsed(path: string): Promise<string> {
  const used = path.replace(/\.md$/, "") + ".used.md";
  await rename(path, used);
  return used;
}

// ---- deny reason (spec sections 7 and 9) ----

const MAX_REASON = 1000;
/** Upper bound for a deny reason that embeds the minimal template (the template itself is about 400 characters) */
const MAX_REASON_TEMPLATE = 1600;

export interface DenyParams {
  /** AskUserQuestion only; omitted for plans */
  path?: string;
  /** AskUserQuestion in plan mode: the plan file the explanation block goes into (instead of `path`) */
  planFile?: string;
  question?: string;
  missing: string[];
  /** Codes behind `missing`; decides whether to show the template (omitted: no template) */
  codes?: MissingCode[];
  /** True when the file found has `type: blocker` */
  blocker?: boolean;
  /** True when the file found has `type: quiz` */
  quiz?: boolean;
  /** The human's edited version of the skill (a file path): the texts name it instead of the skill; set by the hook, never looked up here */
  skillRef?: string;
  /** `codex` swaps the Claude Code tool / skill names in the text for Codex's (`request_user_input`, the SessionStart context) */
  agent?: string;
}

/** The template is shown only when a front matter key (the core of the format) is missing. For blockers, whenever anything is missing */
const TEMPLATE_CODES: MissingCode[] = ["file", "front_matter", "question", "title", "recommended"];

function needsTemplate(p: DenyParams): boolean {
  if ((p.path === undefined && p.planFile === undefined) || p.question === undefined || !p.codes) return false;
  return p.blocker === true ? p.codes.length > 0 : p.codes.some((c) => TEMPLATE_CODES.includes(c));
}

/** The `question:` line(s) of a template: a question with line breaks is written as a `|` block scalar */
function questionField(q: string): string {
  return q.includes("\n") ? "question: |\n" + q.split("\n").map((l) => (l === "" ? "" : "  " + l)).join("\n") : `question: ${q}`;
}

/** How to put the question into the front matter, for a sentence of the deny reason */
function questionRule(q: string): string {
  return q.includes("\n")
    ? `Write the front matter question as \`question: |\` followed by the lines of this text, each indented by two spaces (blank lines stay blank): ${JSON.stringify(q)}`
    : `Put exactly this string in the front matter question: ${q}`;
}

const OPTIONS_HEADER = "| Option | What happens if chosen | Risks and how to undo |";

/** Plan mode: the block shape in short (front matter and section headings; the details are in the skill / SessionStart context) */
function planTemplateBlock(p: DenyParams): string {
  const body = [
    "<!-- ukagai-explain -->",
    "---",
    "ukagai: 1",
    questionField(p.question ?? ""),
    "title: <the decision for the human, in one sentence>",
    "recommended: <label of the option you recommend>",
    "reversibility: reversible | costly | irreversible",
    "scope: file | repo | machine | external",
    "---",
    `## ${SECTION.why[0]}`,
    `## ${SECTION.unknowns[0]}`,
    `## ${SECTION.options[0]}`,
    OPTIONS_HEADER,
    `## ${SECTION.recommendation[0]}`,
    `## ${SECTION.assumptions[0]}`,
    `## ${SECTION.checked[0]}`,
    "<!-- /ukagai-explain -->",
  ];
  return "```\n" + body.join("\n") + "\n```";
}

function templateBlock(p: DenyParams): string {
  if (p.planFile !== undefined) return planTemplateBlock(p);
  const body = p.quiz
    ? [
        "---",
        "ukagai: 1",
        "type: quiz",
        questionField(p.question ?? ""),
        "title: <what the quiz is about, in one sentence>",
        "reversibility: reversible",
        "scope: file",
        "---",
        `## ${SECTION.quizWhy[0]}`,
        `## ${SECTION.quizPremise[0]}  (do not repeat an option; no recommendation)`,
        `## ${SECTION.quizHow[0]}  (optional)`,
      ]
    : p.blocker
    ? [
        "---",
        "ukagai: 1",
        questionField(p.question ?? ""),
        "type: blocker",
        "title: <what is needed, in one sentence>",
        `recommended: ${BLOCKER_LABELS.done[0]}`,
        "reversibility: reversible",
        "scope: machine",
        "---",
        `## ${SECTION.blockerWhy[0]}  (the failed command and an excerpt of the error)`,
        `## ${SECTION.blockerTodo[0]}  (numbered steps, and a code block with commands to run as they are)`,
        `## ${SECTION.options[0]}`,
        OPTIONS_HEADER,
        `| ${BLOCKER_LABELS.done[0]} | | |`,
        `| ${BLOCKER_LABELS.skip[0]} | | |`,
        `| ${BLOCKER_LABELS.stop[0]} | | |`,
      ]
    : [
        "---",
        "ukagai: 1",
        questionField(p.question ?? ""),
        "title: <the decision for the human, in one sentence>",
        "recommended: <label of the option you recommend>",
        "reversibility: reversible | costly | irreversible",
        "scope: file | repo | machine | external",
        "---",
        `## ${SECTION.why[0]}`,
        `## ${SECTION.unknowns[0]}  (1-3 bullets: what you could not settle by investigating)`,
        `## ${SECTION.options[0]}`,
        OPTIONS_HEADER,
        `## ${SECTION.recommendation[0]}`,
        "(the option you recommend and why; the last sentence names the condition that makes another option right)",
        `## ${SECTION.assumptions[0]}  (one premise per bullet)`,
        `## ${SECTION.diagram[0]}  (Mermaid; for anything not reversible, or scope machine / external)`,
        `## ${SECTION.checked[0]}  (commands run and files read; evidence as [^1]: ... cited from the body; not needed for reversible + file)`,
      ];
  return "```\n" + body.join("\n") + "\n```";
}

/** Codex has no skills and its question tool is `request_user_input`: the format is the one given in the SessionStart context */
function forAgent(text: string, agent: string | undefined): string {
  if (agent !== "codex") return text;
  return text
    .replace(/First read skill (?:ukagai:)?ukagai-explain \(if you have not\)\. /g, "")
    .replace(/Could you first read skill (?:ukagai:)?ukagai-explain \(if you have not\)\? /g, "")
    .replace(/The (?:full )?format is (?:in|described in) skill (?:ukagai:)?ukagai-explain\. /g, "The explanation file format is as given in the SessionStart context. ")
    .replace(/skill (?:ukagai:)?ukagai-explain/g, "the explanation file format in the SessionStart context")
    .replace(/AskUserQuestion/g, "request_user_input");
}

/** Every deny the hook sends starts with this, so the agent does not read a validation round as an error */
function tagged(text: string): string {
  return `[ukagai, not a failure] ${text}`;
}

/** The deny at the end of a hook leg: the question stays open in ukagai, the agent is asked to call the tool again */
export function handoffReason(kind: "answer_question" | "approve_plan", agent: string | undefined): string {
  const call =
    kind === "approve_plan"
      ? "Call ExitPlanMode again now with the same plan"
      : "Call AskUserQuestion again now with exactly the same question and options";
  return forAgent(
    tagged(`The human has not answered yet; the question stays open in ukagai. ${call} to keep waiting for the answer. Do not ask in prose and do not change the question.`),
    agent,
  );
}

function composeReason(template: DenyTemplate, p: DenyParams, missingText: string, withTail: boolean): string {
  // With the human's version composeRaw already words the skill for the agent: only the question tool's name is swapped for Codex
  if (p.skillRef !== undefined) {
    const text = tagged(composeRaw(template, p, missingText, withTail));
    return p.agent === "codex" ? text.replace(/AskUserQuestion/g, "request_user_input") : text;
  }
  return forAgent(tagged(composeRaw(template, p, missingText, withTail)), p.agent);
}

function composeRaw(template: DenyTemplate, p: DenyParams, missingText: string, withTail: boolean): string {
  const sk = skillName(process.env, p.agent);
  // The skill as the texts below name it: the plain skill, or (the human edited it) just the file, once, which replaces the skill. No explanatory
  // parenthesis here: a reason is capped at 1000 / 1600 characters and a real scratchpad path is ~150, so every extra word pushes "Missing" or the closing request out
  const ref = p.skillRef;
  const what = ref === undefined ? `skill ${sk}` : ref;
  const thatFile = ref === undefined ? `skill ${sk}` : "that file";
  if (p.planFile !== undefined) {
    const tpl = needsTemplate(p) ? "\n" + templateBlock(p) : "";
    return template === "A"
      ? `First read ${what} (if you have not). In plan mode the explanation goes into your plan file, not a separate file: append to ${p.planFile} a block between <!-- ukagai-explain --> and <!-- /ukagai-explain --> holding the explanation (front matter with question: verbatim, Why this decision is needed now, What only you know, Options table, Recommendation, Assumptions, What I checked), then call AskUserQuestion again with the same question. Missing: ${missingText}.` +
          tpl
      : `Could you first read ${what} (if you have not)? In plan mode the explanation goes into your plan file, not a separate file. Could you append to ${p.planFile} a block between <!-- ukagai-explain --> and <!-- /ukagai-explain --> holding the explanation (front matter with question: identical to the question text, Why this decision is needed now, What only you know, Options table, Recommendation, Assumptions, What I checked), then call AskUserQuestion again with the same question? Missing: ${missingText}.` +
          tpl;
  }
  const isPlan = p.path === undefined || p.question === undefined;
  if (isPlan) {
    return template === "A"
      ? `The plan (ExitPlanMode) is incomplete. Missing: ${missingText}.` +
          (withTail ? `\nFix the plan text following ${what}, then call ExitPlanMode again with the same plan.` : "")
      : `This plan does not meet the requirements yet. Missing: ${missingText}.` +
          (withTail ? `\nThe format is described in ${what}. Could you fix it and call ExitPlanMode again?` : "");
  }
  const tpl = needsTemplate(p) ? "\n" + templateBlock(p) : "";
  if (template === "A") {
    return (
      `First read ${what} (if you have not). Before AskUserQuestion, write an explanation file the human can decide from. Missing: ${missingText}.\n` +
      (tpl
        ? `Save to: ${p.path} (any name in the same directory). Write it in this shape; question: already holds the question text verbatim.${tpl}`
        : `Save to: ${p.path} (any name in the same directory). ${questionRule(p.question!)}`) +
      (withTail ? `\nThe full format is in ${thatFile}. When done, call AskUserQuestion again with the same question. Do not ask in prose.` : "")
    );
  }
  return (
    `Could you first read ${what} (if you have not)? The explanation file (ukagai format) for this decision does not meet the requirements yet. Missing: ${missingText}.\n` +
    (tpl
      ? `Could you write ${p.path} in this shape (any name in the same directory is fine)? question: is identical to the question text.${tpl}`
      : `Could you write ${p.path} (any name in the same directory is fine)? ${p.question!.includes("\n") ? questionRule(p.question!) : `The front matter question: must be identical to "${p.question}".`}`) +
    (withTail ? `\nThe full format is in ${thatFile}. When done, please call AskUserQuestion again with the same question.` : "")
  );
}

/** At most 1000 characters (1600 with the template). Beyond that, missing is cut to "... and N more", then the last sentence is dropped. question is never cut */
export function denyReason(template: DenyTemplate, p: DenyParams): string {
  const max = needsTemplate(p) ? MAX_REASON_TEMPLATE : MAX_REASON;
  for (let keep = p.missing.length; keep >= 0; keep--) {
    const rest = p.missing.length - keep;
    const text = p.missing.slice(0, keep).join("; ") + (rest > 0 ? `${keep > 0 ? "; " : ""}... and ${rest} more` : "");
    const full = composeReason(template, p, text, true);
    if (full.length <= max) return full;
  }
  return composeReason(template, p, `... and ${p.missing.length} more`, false);
}

/** Deny reason for two or more questions (spec section 5, step 0). No URL, at most 1000 characters */
export function multiDenyReason(count: number, agent?: string): string {
  return forAgent(
    tagged(`Ask one question per AskUserQuestion call (this call had ${count}). The GUI shows one question at a time, with its explanation file. ` +
    "Starting from the first question, write an explanation file for each and call AskUserQuestion again with that single question. Do not ask in prose."),
    agent,
  );
}

// ---- location ----

/** `<scratchpad_dir>/ukagai/`, otherwise `<dataDir>/explain/<session_id>/` */
export function explainDir(scratchpadDir: string | undefined, dataDir: string, sessionId: string): string {
  return scratchpadDir ? join(scratchpadDir, "ukagai") : join(dataDir, "explain", sessionId);
}
