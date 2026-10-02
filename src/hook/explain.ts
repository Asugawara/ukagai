import { readdir, readFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { RECENCY_WINDOW_MS } from "../contract.js";
import type { DenyTemplate } from "./options.js";

// docs/spec/explain.md の規則の実装。

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

/** deny 理由文での呼び名(spec 4 節) */
export const MISSING_LABELS: Record<MissingCode, string> = {
  file: "説明ファイル本体",
  front_matter: "front matter(`ukagai: 1`)",
  question: "`question`",
  type: "`type`(decision / blocker)",
  title: "`title`(決めてほしいこと 1 文)",
  reversibility: "`reversibility`",
  scope: "`scope`",
  recommended: "`recommended`(推す選択肢のラベル)",
  why: "「なぜ今この判断が要るか」の節",
  options: "「選択肢」の節",
  table: "選択肢の表(先頭列はラベル、選ぶと起きること・リスクと戻し方の列、選択肢ごとに 1 行)",
  todo: "「人にしてほしいこと」の節(コマンドのコードブロック付き)",
  recommend: "「推奨」の節",
  recommend_long: "「推奨」の節が長い(5 文・400 文字以内)",
  recommend_cond: "「推奨」に別の選択肢が正しくなる条件(「〜なら B」「〜の場合は B」「〜のときは B」「〜であれば B」のいずれかで書く)",
  cell_long: "選択肢の表のセルが長い(各セル 160 文字以内)",
  why_long: "「なぜ今この判断が要るか」の節が長い(600 文字以内。詳細は「確かめたこと」へ)",
  diagram: "「図」の節と Mermaid の図",
  impact: "「影響範囲と可逆性」の節",
  multi: "質問は 1 回に 1 問",
};

const REVERSIBILITY = ["reversible", "costly", "irreversible"];
const SCOPE = ["file", "repo", "machine", "external"];
const TYPES = ["decision", "blocker"];

// ---- 小道具 ----

export function toLines(markdown: string): string[] {
  return markdown.replace(/\r\n?/g, "\n").split("\n");
}

/** NFKC → 空白削除 → 「と」「・」削除 → 小文字化 */
export function normalizeHeading(s: string): string {
  return s.normalize("NFKC").replace(/\s/gu, "").replace(/[と・]/gu, "").toLowerCase();
}

/**
 * 選択肢ラベルの照合用正規化(hook と GUI で同じ規則)。
 * NFKC → 末尾の `(Recommended)` / `（Recommended）` / `(推奨)` / `（推奨）` を除去
 * → 空白(全種)を削除 → 小文字化。照合は正規化後の完全一致。
 * (NFKC で全角括弧は半角になるので、除去は NFKC の後に半角括弧だけ見ればよい)
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

export function findSection(
  headings: { level: number; title: string; line: number }[],
  total: number,
  name: string,
): Section | null {
  const want = normalizeHeading(name);
  // 完全一致を優先し、無ければ部分一致(「選択肢」が「推奨する選択肢」に当たらないように)
  let idx = headings.findIndex((h) => normalizeHeading(h.title) === want);
  if (idx < 0) idx = headings.findIndex((h) => normalizeHeading(h.title).includes(want));
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

/** spec 3.3 */
function tableOk(t: Table, labels: string[] | undefined): boolean {
  const norm = t.header.map(normalizeHeading);
  const cols = ["起きること", "リスク"].map((k) => norm.findIndex((h) => h.includes(normalizeHeading(k))));
  if (cols.some((c) => c < 0)) return false;
  if (t.rows.length < Math.max(2, labels?.length ?? 0)) return false;
  if (!t.rows.every((r) => cols.every((c) => !isEmptyCell(r[c])))) return false;
  if (labels) {
    const first = new Set(t.rows.map((r) => normalizeLabel(r[0] ?? "")));
    if (!labels.every((l) => first.has(normalizeLabel(l)))) return false;
  }
  return true;
}

/** 長さの上限(spec 3.2)。文字数は NFKC 後の code point 数 */
export const LIMITS = { recommendChars: 400, recommendSentences: 5, cellChars: 160, whyChars: 600 };

function cpLength(s: string): number {
  return [...s.normalize("NFKC")].length;
}

/** 節の本文(見出し・コードブロック・空行を除く) */
function sectionText(lines: string[], inFence: boolean[], s: Section): string {
  return lines
    .slice(s.start + 1, s.end)
    .filter((l, i) => !inFence[s.start + 1 + i] && l.trim() !== "")
    .map((l) => l.trim())
    .join("\n");
}

/** 文の数。`。` `!` `?` と、直後が空白か末尾の `.` で区切る(`file.ts` や `0.5` は区切らない) */
function countSentences(text: string): number {
  return text
    .normalize("NFKC")
    .split(/[。!?]+|\.(?=\s|$)/u)
    .filter((x) => x.trim() !== "").length;
}

/** 「起きること」「リスク」列のセルのいずれかが上限を超える */
function tableCellsLong(t: Table): boolean {
  const norm = t.header.map(normalizeHeading);
  const cols = ["起きること", "リスク"].map((k) => norm.findIndex((h) => h.includes(normalizeHeading(k))));
  return t.rows.some((r) => cols.some((c) => cpLength(r[c] ?? "") > LIMITS.cellChars));
}

/**
 * 「推奨」に別の選択肢が正しくなる条件があるか(語の有無だけ見る)。
 * `ならない` / `ならず`(なければならない 等)と `ときどき` は除く。`if` / `when` / `unless` は単語として
 */
export const RECOMMEND_COND = /なら(?!ない|ず)|場合|とき(?!どき)|であれば|際[はに]|\bif\b|\bwhen\b|\bunless\b/i;

/** 条件の判定に使う本文: コードブロック・callout(`>` 始まりの行)を除く */
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

// ---- 検査 ----

/** spec 4 節。plan(ExitPlanMode)は validatePlan に委ねる */
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
  const why = findSection(headings, lines.length, blocker ? "なぜ止まったか" : "なぜ今この判断が要るか");
  if (!why || !hasContent(lines, why)) missing.push("why");
  else if (cpLength(sectionText(lines, inFence, why)) > LIMITS.whyChars) missing.push("why_long");

  const options = findSection(headings, lines.length, "選択肢");
  if (!options) missing.push("options");
  else {
    const tables = findTables(lines, inFence, options.start + 1, options.end);
    const okTables = tables.filter((t) => tableOk(t, labels));
    if (okTables.length === 0) missing.push("table");
    else if (okTables.some((t) => tableCellsLong(t))) missing.push("cell_long");
  }

  if (blocker) {
    const todo = findSection(headings, lines.length, "人にしてほしいこと");
    if (!todo || !hasContent(lines, todo) || !blocks.some((b) => b.start > todo.start && b.start < todo.end)) {
      missing.push("todo");
    }
  } else {
    const recommend = findSection(headings, lines.length, "推奨");
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
  // 必須: reversible 以外、または scope が machine / external(repo + reversible は任意)
  const diagramRequired =
    !blocker &&
    (!scopeKnown || !revKnown || rev !== "reversible" || scope === "machine" || scope === "external");
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

/** questions が 2 つ以上のときの deny 理由文(spec 5 節の手順 0)。URL なし、600 文字以内 */
export function multiDenyReason(count: number): string {
  return (
    `AskUserQuestion は 1 回に 1 問にしてください(今回は ${count} 問)。GUI は 1 問ずつ、説明ファイルと一緒に表示します。` +
    "最初の質問から順に、1 問ごとに説明ファイルを書いて AskUserQuestion を 1 問だけで出し直してください。文章で聞き直してはいけません。"
  );
}

// ---- 置き場 ----

/** `<scratchpad_dir>/ukagai/`、無ければ `<dataDir>/explain/<session_id>/` */
export function explainDir(scratchpadDir: string | undefined, dataDir: string, sessionId: string): string {
  return scratchpadDir ? join(scratchpadDir, "ukagai") : join(dataDir, "explain", sessionId);
}
