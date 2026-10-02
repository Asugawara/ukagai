import { AskUserQuestionInput, ExitPlanModeInput, type Decision } from "../contract.js";
import {
  COLUMN_HAPPENS,
  COLUMN_RISK,
  SECTION,
  findSection,
  findTables,
  normalizeLabel,
  parseFrontMatter,
  scanFences,
  scanHeadings,
  toLines,
  type Table,
} from "../hook/explain.js";
import type { Lang } from "../settings/config.js";
import { t, type MessageKey } from "./i18n.js";

// Decision to screen model. Uses the same matching rules as the GUI (buildModel / parseOptionsTable in public/app.js).

export interface Chip {
  kind: "repo" | "branch" | "worktree";
  text: string;
}

export interface CardLine {
  /** A Markdown fragment (table cell); a raw string when md is false */
  text: string;
  md: boolean;
  /** The "Risks and how to undo" row (dim, strong text in red) */
  risk?: boolean;
}

export interface Card {
  /** The value placed in the answer: the original option.label */
  value: string;
  label: string;
  lines: CardLine[];
  /** Show the "Recommended" badge */
  recommended: boolean;
}

export type Reversibility = "reversible" | "costly" | "irreversible";

export interface ScreenModel {
  id: string;
  kind: "question" | "plan";
  title: string;
  chips: Chip[];
  /** Path with ~ for the home directory */
  cwd: string;
  reversibility?: Reversibility;
  scope?: string;
  createdAt: string;
  /** Markdown for the left (background) column; null if none */
  background: string | null;
  /** A sentence shown instead of the background (no explanation) */
  backgroundNote?: string;
  /** Body of the recommendation section (Markdown) */
  recommendation: string | null;
  /** Body of the "Scope and reversibility" section of the plan (Markdown), shown in the right column of the plan card */
  impact?: string | null;
  /** Waiting for the human (explanation.type === "blocker") */
  blocker: boolean;
  /** Body of the blocker "What you need to do" section (Markdown), shown at the top of the right column */
  todo: string | null;
  /** Contents of the code blocks in the todo (`c` copies the first) */
  todoCode: string[];
  /** For a single question */
  question?: {
    text: string;
    header: string;
    multi: boolean;
    cards: Card[];
    /** Initial cursor (the recommended option, else 0) */
    initialCursor: number;
    /** Whether the options were read from a table (v2) */
    v2: boolean;
  };
  /** Two or more questions (the TUI cannot answer them) */
  unsupported?: string;
  hasExplanation: boolean;
}

// Accepts both the English and the Japanese suffix
const SUFFIX_RE = /\s*[(（]\s*(recommended|推奨)\s*[)）]\s*$/i;
const stripSuffix = (s: string): string => s.replace(SUFFIX_RE, "");

const NONE_REASON: Record<string, MessageKey> = {
  loop_guard: "reason_loop_guard",
  plan_mode: "reason_plan_mode",
  not_required: "reason_not_required",
};

const WT_RE = /\/\.herdr\/worktrees\/([^/]+)\/([^/]+)/;

const tail = (cwd: string): string => cwd.split("/").filter(Boolean).pop() || cwd;

export const tildePath = (p: string): string => p.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");

const planOf = (d: Decision): string => {
  const r = ExitPlanModeInput.safeParse(d.request);
  return r.success ? r.data.plan : "";
};
const questionsOf = (d: Decision) => {
  const r = AskUserQuestionInput.safeParse(d.request);
  return r.success ? r.data.questions : [];
};

export function isBlocker(d: Decision, fm: Record<string, string> = {}): boolean {
  const ex = d.explanation;
  if (!ex) return false;
  if (ex.type) return ex.type === "blocker";
  return d.kind === "answer_question" && hasExplanation(d) && fm["type"] === "blocker";
}

/** Extract the contents of fenced code blocks in order */
export function codeBlocks(md: string): string[] {
  const out: string[] = [];
  const re = /^(```|~~~)[^\n]*\n([\s\S]*?)^\1[ \t]*$/gm;
  for (let m = re.exec(md); m; m = re.exec(md)) out.push((m[2] ?? "").replace(/\n$/, ""));
  return out;
}

export function hasExplanation(d: Decision): boolean {
  return !!d.explanation && d.explanation.attached_via !== "none";
}

export function chipsOf(d: Decision): Chip[] {
  const m = WT_RE.exec(d.session.cwd);
  const out: Chip[] = [{ kind: "repo", text: `◈ ${m?.[1] ?? tail(d.session.cwd)}` }];
  if (d.context?.branch) out.push({ kind: "branch", text: `⎇ ${d.context.branch}` });
  if (m?.[2]) out.push({ kind: "worktree", text: `⧉ ${m[2]}` });
  return out;
}

export function titleOf(d: Decision, fm: Record<string, string>, lang: Lang = "en"): string {
  const explicit = d.explanation?.title || (hasExplanation(d) && d.kind === "answer_question" ? fm["title"] : undefined);
  if (explicit) return explicit;
  if (d.kind === "approve_plan") {
    return /^#[ \t]+(.+?)[ \t]*$/m.exec(planOf(d))?.[1] ?? t(lang, "default_plan_title");
  }
  const q = questionsOf(d)[0]?.question;
  return stripSuffix(d.session.title || q || t(lang, "default_question_title"));
}

function metaOf(d: Decision, fm: Record<string, string>, key: "reversibility" | "scope"): string | undefined {
  const ex = d.explanation;
  if (!ex) return undefined;
  if (ex[key]) return ex[key];
  if (d.kind === "answer_question" && hasExplanation(d)) return fm[key];
  return undefined;
}

export function elapsed(iso: string, now: number = Date.now(), lang: Lang = "en"): string {
  const sec = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (sec < 60) return t(lang, "elapsed_s", { n: sec });
  if (sec < 3600) return t(lang, "elapsed_m", { n: Math.floor(sec / 60) });
  return t(lang, "elapsed_h", { n: Math.floor(sec / 3600) });
}

const isDash = (s: string): boolean => /^[-—ー]*$/u.test(s.trim());

/** Match a table (first column = label) to the options. Null if no row matches */
function cardsFromTable(
  t: Table,
  options: { label: string; description?: string | undefined }[],
  recommended: string | undefined,
): { cards: Card[]; extras: Card[] } | null {
  const hi = t.header.findIndex((h) => COLUMN_HAPPENS.test(h.normalize("NFKC")));
  const ri = t.header.findIndex((h) => COLUMN_RISK.test(h.normalize("NFKC")));
  const cards: (Card & { suffix: boolean; key: string })[] = [];
  const used = new Set<string>();
  for (const row of t.rows) {
    const key = normalizeLabel(row[0] ?? "");
    const o = options.find((x) => normalizeLabel(x.label) === key);
    if (!o || used.has(o.label)) continue;
    used.add(o.label);
    let lines: CardLine[];
    if (hi >= 0 && ri >= 0) {
      lines = [
        { text: row[hi] ?? "", md: true },
        { text: row[ri] ?? "", md: true, risk: true },
      ];
    } else {
      lines = row.slice(1).map((c, j) => ({ text: c ? `${t.header[j + 1] ?? ""}: ${c}` : "", md: true }));
    }
    lines = lines.filter((l) => l.text && !isDash(l.text));
    cards.push({
      value: o.label,
      label: stripSuffix(row[0] ?? ""),
      lines,
      recommended: false,
      suffix: SUFFIX_RE.test(row[0] ?? ""),
      key,
    });
  }
  if (!cards.length) return null;
  const want = recommended ? normalizeLabel(recommended) : null;
  const byFm = want ? cards.filter((c) => normalizeLabel(c.value) === want) : [];
  for (const c of byFm.length ? byFm : cards.filter((c) => c.suffix)) c.recommended = true;
  const extras = options
    .filter((o) => !used.has(o.label))
    .map((o) => rawCard(o, false));
  return { cards: cards.map(({ suffix: _s, key: _k, ...c }) => c), extras };
}

function rawCard(o: { label: string; description?: string | undefined }, recommended: boolean): Card {
  return {
    value: o.label,
    label: stripSuffix(o.label),
    lines: o.description ? [{ text: o.description, md: false }] : [],
    recommended,
  };
}

/** Extract the body of the "Scope and reversibility" section from a plan (exact match first, then partial); null if absent */
export function impactOf(plan: string): string | null {
  const body = toLines(plan);
  const { inFence } = scanFences(body);
  const sec = findSection(scanHeadings(body, inFence), body.length, SECTION.impact);
  if (!sec) return null;
  return body.slice(sec.start + 1, sec.end).join("\n").trim() || null;
}

export function buildModel(d: Decision, lang: Lang = "en"): ScreenModel {
  const explained = hasExplanation(d);
  const md = explained ? (d.explanation?.markdown ?? "") : "";
  const all = toLines(md);
  const fmParsed = d.kind === "answer_question" && explained ? parseFrontMatter(all) : null;
  const fm = fmParsed?.fields ?? {};
  const rev = metaOf(d, fm, "reversibility") as Reversibility | undefined;
  const base = {
    id: d.id,
    title: titleOf(d, fm, lang),
    chips: chipsOf(d),
    cwd: tildePath(d.session.cwd),
    ...(rev ? { reversibility: rev } : {}),
    ...(metaOf(d, fm, "scope") ? { scope: metaOf(d, fm, "scope") as string } : {}),
    createdAt: d.created_at,
    hasExplanation: explained,
    blocker: isBlocker(d, fm),
    todo: null as string | null,
    todoCode: [] as string[],
  };

  if (d.kind === "approve_plan") {
    const plan = planOf(d);
    let background = plan;
    // The hook puts the plan body in explanation.markdown, so only append it when it differs from the plan
    if (explained && md.trim() !== plan.trim()) {
      const lines = toLines(md);
      background += "\n\n---\n\n" + lines.slice(parseFrontMatter(lines).bodyStart).join("\n");
    }
    return { ...base, kind: "plan", background, recommendation: null, impact: impactOf(plan) };
  }

  const qs = questionsOf(d);
  const q = qs[0];
  if (!q || qs.length > 1) {
    return {
      ...base,
      kind: "question",
      background: null,
      recommendation: null,
      unsupported: t(lang, "unsupported_multi"),
    };
  }
  const rawCards = q.options.map((o) => rawCard(o, SUFFIX_RE.test(o.label)));
  const pref = (cards: Card[]) => Math.max(0, cards.findIndex((c) => c.recommended));
  const plainQuestion = {
    text: q.question,
    header: q.header,
    multi: !!q.multiSelect,
  };

  if (!explained) {
    const code = d.explanation?.none_reason ?? "";
    const reason = NONE_REASON[code] ? t(lang, NONE_REASON[code]) : code;
    return {
      ...base,
      kind: "question",
      background: null,
      backgroundNote: reason ? t(lang, "no_explanation_note_reason", { reason }) : t(lang, "no_explanation_note"),
      recommendation: null,
      question: { ...plainQuestion, cards: rawCards, initialCursor: pref(rawCards), v2: false },
    };
  }

  const body = all.slice(fmParsed!.bodyStart);
  const { inFence } = scanFences(body);
  const headings = scanHeadings(body, inFence);
  const optSec = findSection(headings, body.length, SECTION.options);
  let recSec = findSection(headings, body.length, SECTION.recommendation);
  if (recSec && optSec && recSec.start === optSec.start) recSec = null;
  const table = optSec ? findTables(body, inFence, optSec.start + 1, optSec.end)[0] : undefined;
  const parsed = table ? cardsFromTable(table, q.options, fm["recommended"]) : null;

  if (!parsed) {
    const cards = rawCards;
    return {
      ...base,
      kind: "question",
      background: body.join("\n"),
      recommendation: null,
      question: { ...plainQuestion, cards, initialCursor: pref(cards), v2: false },
    };
  }

  const drop: [number, number][] = [[optSec!.start, optSec!.end]];
  let todo: string | null = null;
  if (base.blocker) {
    const todoSec = findSection(headings, body.length, SECTION.blockerTodo);
    if (todoSec && todoSec.start !== optSec!.start) {
      const text = body.slice(todoSec.start + 1, todoSec.end).join("\n").trim();
      if (text) {
        todo = text;
        drop.push([todoSec.start, todoSec.end]);
      }
    }
  }
  let recommendation: string | null = null;
  if (recSec) {
    const text = body.slice(recSec.start + 1, recSec.end).join("\n").trim();
    if (text) {
      recommendation = text;
      drop.push([recSec.start, recSec.end]);
    }
  }
  const kept = body.filter((_, i) => !drop.some(([s, e]) => i >= s && i < e));
  const cards = [...parsed.cards, ...parsed.extras];
  return {
    ...base,
    kind: "question",
    background: kept.join("\n").trim(),
    recommendation,
    todo,
    todoCode: todo ? codeBlocks(todo) : [],
    question: {
      ...plainQuestion,
      cards,
      initialCursor: Math.max(0, cards.findIndex((c, i) => c.recommended || (i >= parsed.cards.length && SUFFIX_RE.test(c.value)))),
      v2: true,
    },
  };
}
