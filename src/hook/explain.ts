import { readdir, readFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { RECENCY_WINDOW_MS } from "../contract.js";
import type { DenyTemplate } from "./options.js";

// docs/spec/explain.md の規則の実装。

export type MissingCode =
  | "file"
  | "front_matter"
  | "question"
  | "reversibility"
  | "scope"
  | "why"
  | "compare"
  | "table"
  | "diagram"
  | "impact";

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

/** deny 理由文での呼び名(spec 4 節) */
export const MISSING_LABELS: Record<MissingCode, string> = {
  file: "説明ファイル本体",
  front_matter: "front matter(`ukagai: 1`)",
  question: "`question`",
  reversibility: "`reversibility`",
  scope: "`scope`",
  why: "「なぜ今この判断が要るか」の節",
  compare: "「選択肢の比較」の節",
  table: "選択肢の比較の表(選択肢ごとに 1 行、利点・欠点・コストの列)",
  diagram: "「図」の節と Mermaid の図",
  impact: "「影響範囲と可逆性」の節",
};

const REVERSIBILITY = ["reversible", "costly", "irreversible"];
const SCOPE = ["file", "repo", "machine", "external"];

// ---- 小道具 ----

function toLines(markdown: string): string[] {
  return markdown.replace(/\r\n?/g, "\n").split("\n");
}

/** NFKC → 空白削除 → 「と」「・」削除 → 小文字化 */
export function normalizeHeading(s: string): string {
  return s.normalize("NFKC").replace(/\s/gu, "").replace(/[と・]/gu, "").toLowerCase();
}

export interface FrontMatter {
  present: boolean;
  fields: Record<string, string>;
  /** 本文の先頭行(front matter が無ければ 0) */
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

interface FenceBlock {
  lang: string;
  start: number;
  end: number;
}

function scanFences(lines: string[]): { inFence: boolean[]; blocks: FenceBlock[] } {
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

interface Section {
  title: string;
  start: number;
  end: number;
}

function scanHeadings(lines: string[], inFence: boolean[]): { level: number; title: string; line: number }[] {
  const out: { level: number; title: string; line: number }[] = [];
  lines.forEach((line, i) => {
    if (inFence[i]) return;
    const m = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) out.push({ level: m[1]!.length, title: m[2]!, line: i });
  });
  return out;
}

function findSection(
  headings: { level: number; title: string; line: number }[],
  total: number,
  name: string,
): Section | null {
  const want = normalizeHeading(name);
  const idx = headings.findIndex((h) => normalizeHeading(h.title).includes(want));
  if (idx < 0) return null;
  const h = headings[idx]!;
  const next = headings.slice(idx + 1).find((x) => x.level <= h.level);
  return { title: h.title, start: h.line, end: next ? next.line : total };
}

interface Table {
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

function findTables(lines: string[], inFence: boolean[], from: number, to: number): Table[] {
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

/** spec 3.3 */
function tableOk(t: Table, optionsCount: number | undefined): boolean {
  const norm = t.header.map(normalizeHeading);
  const cols = ["利点", "欠点", "コスト"].map((k) => norm.findIndex((h) => h.includes(k)));
  if (cols.some((c) => c < 0)) return false;
  if (t.rows.length < Math.max(2, optionsCount ?? 0)) return false;
  return t.rows.every((r) => cols.every((c) => !isEmptyCell(r[c])));
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

// ---- 検査 ----

/** spec 4 節。plan(ExitPlanMode)は validatePlan に委ねる */
export function validateExplanation(
  markdown: string,
  kind: "answer_question" | "approve_plan" = "answer_question",
  optionsCount?: number,
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
    if (!f["reversibility"] || !REVERSIBILITY.includes(f["reversibility"])) missing.push("reversibility");
    if (!f["scope"] || !SCOPE.includes(f["scope"])) missing.push("scope");
  }

  const why = findSection(headings, lines.length, "なぜ今この判断が要るか");
  if (!why || !hasContent(lines, why)) missing.push("why");

  const compare = findSection(headings, lines.length, "選択肢の比較");
  if (!compare) missing.push("compare");
  else {
    const tables = findTables(lines, inFence, compare.start + 1, compare.end);
    if (!tables.some((t) => tableOk(t, optionsCount))) missing.push("table");
  }

  const scope = f["scope"] ?? "";
  const rev = f["reversibility"] ?? "";
  const scopeKnown = SCOPE.includes(scope);
  const revKnown = REVERSIBILITY.includes(rev);
  const diagramRequired =
    !scopeKnown || !revKnown || scope !== "file" || rev !== "reversible";
  if (diagramRequired) {
    const diagram = findSection(headings, lines.length, "図");
    if (!diagram || !sectionHasMermaid(blocks, diagram)) missing.push("diagram");
  }

  return {
    valid: missing.length === 0,
    missing,
    has: hasOf(lines, inFence, blocks),
    question: f["question"] ? f["question"] : null,
  };
}

/** spec 9 節: 「影響範囲と可逆性」の節が空でなく存在する */
export function validatePlan(plan: string): Validation {
  const lines = toLines(plan);
  const { inFence, blocks } = scanFences(lines);
  const headings = scanHeadings(lines, inFence);
  const sec = findSection(headings, lines.length, "影響範囲と可逆性");
  const missing: MissingCode[] = !sec || !hasContent(lines, sec) ? ["impact"] : [];
  return { valid: missing.length === 0, missing, has: hasOf(lines, inFence, blocks), question: null };
}

// ---- 探索 ----

export interface FoundExplanation {
  path: string;
  markdown: string;
  match: "question" | "recency";
}

/** spec 5 節の手順 1。`question:` 完全一致(最新の更新時刻)→ 10 分以内の未使用 1 件 → null */
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
      // 読めないものは無視
    }
  }
  const exact = files.filter((f) => f.question === question).sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  if (exact) return { path: exact.path, markdown: exact.markdown, match: "question" };
  const recent = files.filter((f) => now - f.mtimeMs <= RECENCY_WINDOW_MS);
  if (recent.length === 1) return { path: recent[0]!.path, markdown: recent[0]!.markdown, match: "recency" };
  return null;
}

/** `<名前>.md` を `<名前>.used.md` に rename。新しいパスを返す */
export async function markUsed(path: string): Promise<string> {
  const used = path.replace(/\.md$/, "") + ".used.md";
  await rename(path, used);
  return used;
}

// ---- deny 理由文(spec 7 節 / 9 節) ----

const MAX_REASON = 600;

export interface DenyParams {
  /** AskUserQuestion のときだけ。plan では省く */
  path?: string;
  question?: string;
  missing: string[];
}

function composeReason(template: DenyTemplate, p: DenyParams, missingText: string, withTail: boolean): string {
  const isPlan = p.path === undefined || p.question === undefined;
  if (isPlan) {
    return template === "A"
      ? `計画(ExitPlanMode)に不備があります。足りない項目: ${missingText}。` +
          (withTail ? "\n書式は skill ukagai-explain に従って計画本文を直し、同じ計画をもう一度 ExitPlanMode で出してください。" : "")
      : `この計画には、まだ条件を満たしていない点があります。足りない項目: ${missingText}。` +
          (withTail ? "\n書き方は skill ukagai-explain にあります。直したうえで、もう一度 ExitPlanMode で出していただけますか。" : "");
  }
  if (template === "A") {
    return (
      `AskUserQuestion の前に、人が判断するための説明ファイルを書いてください。足りない項目: ${missingText}。\n` +
      `保存先: ${p.path}(同じディレクトリなら名前は自由)。front matter の question: には次の文字列を一字一句そのまま入れること: ${p.question}` +
      (withTail ? "\n書式は skill ukagai-explain に従い、書き終えたら同じ質問をもう一度 AskUserQuestion で出してください。文章で聞き直してはいけません。" : "")
    );
  }
  return (
    `この判断に付ける説明ファイル(ukagai 形式)が、まだ条件を満たしていません。足りない項目: ${missingText}。\n` +
    `${p.path} に書いていただけますか(同じディレクトリなら名前は自由です)。front matter の question: は「${p.question}」と完全に同じにしてください。` +
    (withTail ? "\n書き方は skill ukagai-explain にあります。書けたら、同じ質問をもう一度 AskUserQuestion で出してください。" : "")
  );
}

/** 600 文字以内。超えるときは missing を「…ほか N 件」に切り詰め、なお超えるときは最終文を削る。question は切らない */
export function denyReason(template: DenyTemplate, p: DenyParams): string {
  for (let keep = p.missing.length; keep >= 0; keep--) {
    const rest = p.missing.length - keep;
    const text = p.missing.slice(0, keep).join("、") + (rest > 0 ? `${keep > 0 ? "、" : ""}…ほか ${rest} 件` : "");
    const full = composeReason(template, p, text, true);
    if (full.length <= MAX_REASON) return full;
  }
  return composeReason(template, p, `…ほか ${p.missing.length} 件`, false);
}

// ---- 置き場 ----

/** `<scratchpad_dir>/ukagai/`、無ければ `<dataDir>/explain/<session_id>/` */
export function explainDir(scratchpadDir: string | undefined, dataDir: string, sessionId: string): string {
  return scratchpadDir ? join(scratchpadDir, "ukagai") : join(dataDir, "explain", sessionId);
}
