import { readdir, readFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { RECENCY_WINDOW_MS } from "../contract.js";
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
} as const;

/** Fixed option labels for blockers (suffix "(Recommended)" allowed on the first). */
export const BLOCKER_LABELS = {
  done: ["Done. Continue", "対応した。続けて"],
  skip: ["Skip this step and continue", "この手順は飛ばして続けて"],
  stop: ["Stop here", "ここで中断"],
} as const;

/** Table column detection (header cell text). The first column is always the option label. */
export const COLUMN_HAPPENS = /happens|outcome|起きること/i;
export const COLUMN_RISK = /risk|リスク/i;

export type MissingCode =
  | "file"
  | "front_matter"
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
  | "cell_long"
  | "why_long"
  | "diagram"
  | "impact"
  | "multi";

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
  question: "`question`",
  type: "`type` (decision / blocker)",
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
  cell_long: "a cell in the options table is too long (at most 160 characters per cell)",
  why_long: 'the "Why this decision is needed now" section is too long (at most 600 characters; put details in "What I checked")',
  diagram: 'a "Diagram" section with a Mermaid diagram',
  impact: 'the "Scope and reversibility" section',
  multi: "one question per call",
};

const REVERSIBILITY = ["reversible", "costly", "irreversible"];
const SCOPE = ["file", "repo", "machine", "external"];
const TYPES = ["decision", "blocker"];

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
  for (const line of lines.slice(1, close)) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!.trim();
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
    tables.push({ header: splitRow(head), rows });
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

/** Length limits (spec 3.2). Characters are code points after NFKC */
export const LIMITS = { recommendChars: 400, recommendSentences: 5, cellChars: 160, whyChars: 600 };

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

function hasContent(lines: string[], s: Section): boolean {
  return lines.slice(s.start + 1, s.end).some((l) => l.trim() !== "");
}

function sectionHasMermaid(blocks: FenceBlock[], s: Section): boolean {
  return blocks.some((b) => b.lang === "mermaid" && b.start > s.start && b.start < s.end);
}

function hasOf(lines: string[], inFence: boolean[], blocks: FenceBlock[]): Has {
  return {
    mermaid: blocks.some((b) => b.lang === "mermaid"),
    diff: blocks.some((b) => b.lang === "diff"),
    table: findTables(lines, inFence, 0, lines.length).length > 0,
  };
}

// ---- validation ----

/** spec section 4. Plans (ExitPlanMode) are delegated to validatePlan */
export function validateExplanation(
  markdown: string,
  kind: "answer_question" | "approve_plan" = "answer_question",
  labels?: string[],
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
  if (fm.present) {
    if (!f["question"]) missing.push("question");
    if (f["type"] !== undefined && !TYPES.includes(f["type"])) missing.push("type");
    if (!f["title"]) missing.push("title");
    if (!f["reversibility"] || !REVERSIBILITY.includes(f["reversibility"])) missing.push("reversibility");
    if (!f["scope"] || !SCOPE.includes(f["scope"])) missing.push("scope");
    const rec = f["recommended"];
    if (!rec || (labels && !labels.some((l) => normalizeLabel(l) === normalizeLabel(rec)))) missing.push("recommended");
  }

  const blocker = f["type"] === "blocker";
  const why = findSection(headings, lines.length, blocker ? SECTION.blockerWhy : SECTION.why);
  if (!why || !hasContent(lines, why)) missing.push("why");
  else if (cpLength(sectionText(lines, inFence, why)) > LIMITS.whyChars) missing.push("why_long");

  const options = findSection(headings, lines.length, SECTION.options);
  if (!options) missing.push("options");
  else {
    const tables = findTables(lines, inFence, options.start + 1, options.end);
    const okTables = tables.filter((t) => tableOk(t, labels));
    if (okTables.length === 0) missing.push("table");
    else if (okTables.some((t) => tableCellsLong(t))) missing.push("cell_long");
  }

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
    }
  }

  const scope = f["scope"] ?? "";
  const rev = f["reversibility"] ?? "";
  const scopeKnown = SCOPE.includes(scope);
  const revKnown = REVERSIBILITY.includes(rev);
  // Required unless reversible with a scope of file / repo (repo + reversible is optional)
  const diagramRequired =
    !blocker &&
    (!scopeKnown || !revKnown || rev !== "reversible" || scope === "machine" || scope === "external");
  if (diagramRequired) {
    const diagram = findSection(headings, lines.length, SECTION.diagram);
    if (!diagram || !sectionHasMermaid(blocks, diagram)) missing.push("diagram");
  }

  return {
    valid: missing.length === 0,
    missing,
    has: hasOf(lines, inFence, blocks),
    question: f["question"] ? f["question"] : null,
  };
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

const MAX_REASON = 600;
/** Upper bound for a deny reason that embeds the minimal template (the template itself is about 400 characters) */
const MAX_REASON_TEMPLATE = 1200;

export interface DenyParams {
  /** AskUserQuestion only; omitted for plans */
  path?: string;
  question?: string;
  missing: string[];
  /** Codes behind `missing`; decides whether to show the template (omitted: no template) */
  codes?: MissingCode[];
  /** True when the file found has `type: blocker` */
  blocker?: boolean;
}

/** The template is shown only when a front matter key (the core of the format) is missing. For blockers, whenever anything is missing */
const TEMPLATE_CODES: MissingCode[] = ["file", "front_matter", "question", "title", "recommended"];

function needsTemplate(p: DenyParams): boolean {
  if (p.path === undefined || p.question === undefined || !p.codes) return false;
  return p.blocker === true ? p.codes.length > 0 : p.codes.some((c) => TEMPLATE_CODES.includes(c));
}

const OPTIONS_HEADER = "| Option | What happens if chosen | Risks and how to undo |";

function templateBlock(p: DenyParams): string {
  const body = p.blocker
    ? [
        "---",
        "ukagai: 1",
        `question: ${p.question}`,
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
        `question: ${p.question}`,
        "title: <the decision for the human, in one sentence>",
        "recommended: <label of the option you recommend>",
        "reversibility: reversible | costly | irreversible",
        "scope: file | repo | machine | external",
        "---",
        `## ${SECTION.why[0]}`,
        `## ${SECTION.options[0]}`,
        OPTIONS_HEADER,
        `## ${SECTION.recommendation[0]}`,
        "(the option you recommend and why; the last sentence names the condition that makes another option right)",
        `## ${SECTION.diagram[0]}  (Mermaid; for anything not reversible, or scope machine / external)`,
      ];
  return "```\n" + body.join("\n") + "\n```";
}

function composeReason(template: DenyTemplate, p: DenyParams, missingText: string, withTail: boolean): string {
  const isPlan = p.path === undefined || p.question === undefined;
  if (isPlan) {
    return template === "A"
      ? `The plan (ExitPlanMode) is incomplete. Missing: ${missingText}.` +
          (withTail ? "\nFix the plan text following skill ukagai-explain, then call ExitPlanMode again with the same plan." : "")
      : `This plan does not meet the requirements yet. Missing: ${missingText}.` +
          (withTail ? "\nThe format is described in skill ukagai-explain. Could you fix it and call ExitPlanMode again?" : "");
  }
  const tpl = needsTemplate(p) ? "\n" + templateBlock(p) : "";
  if (template === "A") {
    return (
      `First read skill ukagai-explain (if you have not). Before AskUserQuestion, write an explanation file the human can decide from. Missing: ${missingText}.\n` +
      (tpl
        ? `Save to: ${p.path} (any name in the same directory). Write it in this shape; question: already holds the question text verbatim.${tpl}`
        : `Save to: ${p.path} (any name in the same directory). Put exactly this string in the front matter question: ${p.question}`) +
      (withTail ? "\nThe full format is in skill ukagai-explain. When done, call AskUserQuestion again with the same question. Do not ask in prose." : "")
    );
  }
  return (
    `Could you first read skill ukagai-explain (if you have not)? The explanation file (ukagai format) for this decision does not meet the requirements yet. Missing: ${missingText}.\n` +
    (tpl
      ? `Could you write ${p.path} in this shape (any name in the same directory is fine)? question: is identical to the question text.${tpl}`
      : `Could you write ${p.path} (any name in the same directory is fine)? The front matter question: must be identical to "${p.question}".`) +
    (withTail ? "\nThe full format is in skill ukagai-explain. When done, please call AskUserQuestion again with the same question." : "")
  );
}

/** At most 600 characters (1200 with the template). Beyond that, missing is cut to "... and N more", then the last sentence is dropped. question is never cut */
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

/** Deny reason for two or more questions (spec section 5, step 0). No URL, at most 600 characters */
export function multiDenyReason(count: number): string {
  return (
    `Ask one question per AskUserQuestion call (this call had ${count}). The GUI shows one question at a time, with its explanation file. ` +
    "Starting from the first question, write an explanation file for each and call AskUserQuestion again with that single question. Do not ask in prose."
  );
}

// ---- location ----

/** `<scratchpad_dir>/ukagai/`, otherwise `<dataDir>/explain/<session_id>/` */
export function explainDir(scratchpadDir: string | undefined, dataDir: string, sessionId: string): string {
  return scratchpadDir ? join(scratchpadDir, "ukagai") : join(dataDir, "explain", sessionId);
}
