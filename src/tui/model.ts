import { AskUserQuestionInput, ExitPlanModeInput, type Decision, type SessionHistory } from "../contract.js";
import {
  COLUMN_HAPPENS,
  COLUMN_RISK,
  RECOMMEND_COND,
  SECTION,
  UNDO_BAD_WORDS,
  UNDO_WORDS,
  findCoinedTerms,
  findSection,
  findTables,
  normalizeLabel,
  parseBullets,
  parseFootnotes,
  parseFrontMatter,
  parseTerms,
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
  /** Heading of an extra table column (shown dim before the text) */
  name?: string;
}

/** Words saying it cannot be undone (red), then words saying how to undo (green): the hook's shared vocabulary, with the g flag for matchAll */
export const IRREVERSIBLE_RE = new RegExp(UNDO_BAD_WORDS.source, "giu");
export const UNDO_RE = new RegExp(UNDO_WORDS.source, "giu");

export interface Card {
  /** The value placed in the answer: the original option.label */
  value: string;
  label: string;
  lines: CardLine[];
  /** Show the "Recommended" badge */
  recommended: boolean;
  /** The risk cell says it cannot be undone (choosing it needs Enter twice) */
  heavy?: boolean;
  /** One of the blocker's three fixed options: shown in the display language, the value stays as received */
  fixed?: FixedLabel;
}

export type FixedLabel = "done" | "skip" | "stop";

const FIXED_ALIASES: Record<FixedLabel, string[]> = {
  done: ["Done. Continue", "対応した。続けて", "完了。続けて"],
  skip: ["Skip this step and continue", "この手順は飛ばして続けて", "この手順を飛ばして続けて"],
  stop: ["Stop here", "ここで中断", "ここで止める"],
};
const squash = (s: string): string => s.normalize("NFKC").replace(/\s/gu, "").toLowerCase();

/** Which blocker fixed label this option is (any language alias, with or without the (Recommended) suffix), if any */
export function fixedLabel(label: string): FixedLabel | undefined {
  const key = squash(label.replace(SUFFIX_RE, ""));
  return (Object.keys(FIXED_ALIASES) as FixedLabel[]).find((k) => FIXED_ALIASES[k].some((a) => squash(a) === key));
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
  /** First sentence of the recommendation (the one-line conclusion); null when there is none */
  headline: string | null;
  /** The recommendation without its first sentence (what the box shows) */
  recRest: string | null;
  /** "Why this decision is needed now" (heading text and body); first in the background column. null when absent (or it has footnotes: it stays in the background) */
  why: { heading: string; text: string } | null;
  /** The sentence of the recommendation (its last one) that says when another option is right; shown under the headline. null when absent */
  cond: string | null;
  /** "What only you know" bullets */
  unknowns: string[];
  assumptions: string[];
  against: string | null;
  affects: string[];
  terms: { term: string; definition: string }[];
  /** Identifier-like tokens that Terms does not define (the hook's coined_term rule); the default checklist of "Can't answer this…" */
  coinedTerms: string[];
  /** Ids of the footnotes referenced from the text and defined in the file */
  footnotes: string[];
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
    /** A Codex approval (header "Approval", Allow / Deny): the question is shown with its backticked command, and Deny is not heavy */
    approval: boolean;
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
  /** The session's human instructions (lazily fetched); null until they arrive or when the fetch failed */
  history: SessionHistory | null;
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

const hasMatch = (re: RegExp, s: string): boolean => new RegExp(re.source, re.flags.replace("g", "")).test(s);

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
        ...t.extraColumns.map((c) => ({ text: row[c] ?? "", md: true, name: t.header[c] ?? "" })),
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
      heavy: ri >= 0 && hasMatch(IRREVERSIBLE_RE, row[ri] ?? ""),
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
  return { cards: cards.map(({ suffix: _s, key: _k, ...c }) => withFixed(c)), extras };
}

const withFixed = (c: Card): Card => {
  const f = fixedLabel(c.value);
  return f ? { ...c, fixed: f } : c;
};

function rawCard(o: { label: string; description?: string | undefined }, recommended: boolean): Card {
  return withFixed({
    value: o.label,
    label: stripSuffix(o.label),
    lines: o.description ? [{ text: o.description, md: false }] : [],
    recommended,
  });
}

/** Extract the body of the "Scope and reversibility" section from a plan (exact match first, then partial); null if absent */
export function impactOf(plan: string): string | null {
  const body = toLines(plan);
  const { inFence } = scanFences(body);
  const sec = findSection(scanHeadings(body, inFence), body.length, SECTION.impact);
  if (!sec) return null;
  return body.slice(sec.start + 1, sec.end).join("\n").trim() || null;
}

/** Split off the first sentence (`。` `!` `?`, or a `.` followed by whitespace / the end) */
/** The last sentence of the recommendation's prose (callouts and code excluded) when it holds a condition word and is not the headline itself */
export function condOf(recommendation: string): string | null {
  let fence = false;
  const prose: string[] = [];
  for (const line of recommendation.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    else if (!fence && !line.startsWith(">")) prose.push(line);
  }
  const sentences = prose.join(" ").split(/(?<=[。！？])|(?<=[.!?])\s+/u).map((x) => x.trim()).filter(Boolean);
  const last = sentences.length > 1 ? sentences.at(-1)! : "";
  return last && RECOMMEND_COND.test(last) ? last : null;
}

export function splitHeadline(text: string): { headline: string; rest: string } {
  const flat = text.replace(/\s*\n\s*/g, " ").trim();
  const m = /^(.+?(?:[。！？!?]+|\.(?=\s|$)))\s*(.*)$/su.exec(flat);
  return m ? { headline: m[1]!.trim(), rest: m[2]!.trim() } : { headline: flat, rest: "" };
}

/** The Deny option of a Codex approval */
const DENY_RE = /^\s*(deny|denied|reject|拒否|却下)/i;

const NO_RICH = { why: null, cond: null, headline: null, recRest: null, unknowns: [], assumptions: [], against: null, affects: [], terms: [], coinedTerms: [] as string[], footnotes: [] };

export function buildModel(d: Decision, lang: Lang = "en", history: SessionHistory | null = null): ScreenModel {
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
    history,
    blocker: isBlocker(d, fm),
    todo: null as string | null,
    todoCode: [] as string[],
  };
  const coinedTerms =
    d.kind === "answer_question" && explained && questionsOf(d).length === 1
      ? findCoinedTerms(md, questionsOf(d)[0]!.options.map((o) => stripSuffix(o.label)))
      : [];

  if (d.kind === "approve_plan") {
    const plan = planOf(d);
    let background = plan;
    // The hook puts the plan body in explanation.markdown, so only append it when it differs from the plan
    if (explained && md.trim() !== plan.trim()) {
      const lines = toLines(md);
      background += "\n\n---\n\n" + lines.slice(parseFrontMatter(lines).bodyStart).join("\n");
    }
    return { ...base, ...NO_RICH, kind: "plan", background, recommendation: null, impact: impactOf(plan) };
  }

  const qs = questionsOf(d);
  const q = qs[0];
  if (!q || qs.length > 1) {
    return {
      ...base,
      ...NO_RICH,
      kind: "question",
      background: null,
      recommendation: null,
      unsupported: t(lang, "unsupported_multi"),
    };
  }
  const rawCards = q.options.map((o) => rawCard(o, SUFFIX_RE.test(o.label)));
  // With no options (a prose question) only free text is left: the cursor starts on it (slot 2, after the hidden None of these / Can't answer)
  const pref = (cards: Card[]) => (cards.length ? Math.max(0, cards.findIndex((c) => c.recommended)) : 2);
  const plainQuestion = {
    text: q.question,
    header: q.header,
    approval: /^approval$/i.test(q.header.trim()),
    multi: !!q.multiSelect,
  };

  if (!explained) {
    const code = d.explanation?.none_reason ?? "";
    const reason = NONE_REASON[code] ? t(lang, NONE_REASON[code]) : code;
    return {
      ...base,
      ...NO_RICH,
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
      ...NO_RICH,
      kind: "question",
      background: body.join("\n"),
      recommendation: null,
      coinedTerms,
      question: { ...plainQuestion, cards, initialCursor: pref(cards), v2: false },
    };
  }

  const drop: [number, number][] = [[optSec!.start, optSec!.end]];
  const secBody = (names: readonly string[], dropIt: boolean): string => {
    const sec = findSection(headings, body.length, names);
    if (!sec || sec.start === optSec!.start || (recSec && sec.start === recSec.start)) return "";
    if (dropIt) drop.push([sec.start, sec.end]);
    return body.slice(sec.start + 1, sec.end).join("\n").trim();
  };
  // The hook parsers read the whole Markdown; secBody is still called so the sections are dropped from the background.
  const full = body.join("\n");
  // Why leads the background column; a Why with footnotes stays in the background (renderMarkdown has no footnote definitions)
  let why: ScreenModel["why"] = null;
  const whySec = findSection(headings, body.length, [...SECTION.why, ...SECTION.blockerWhy]);
  if (whySec && whySec.start !== optSec!.start && !(recSec && whySec.start === recSec.start)) {
    const text = body.slice(whySec.start + 1, whySec.end).join("\n").trim();
    if (text && !/\[\^/.test(text)) {
      why = { heading: body[whySec.start]!.replace(/^\s*#+\s*/, "").trim(), text };
      drop.push([whySec.start, whySec.end]);
    }
  }
  const unknowns = secBody(SECTION.unknowns, true) ? parseBullets(full, SECTION.unknowns) : [];
  const assumptions = secBody(SECTION.assumptions, true) ? parseBullets(full, SECTION.assumptions) : [];
  const against = secBody(SECTION.against, true).replace(/\s*\n\s*/g, " ") || null;
  const affects = secBody(SECTION.affects, true) ? parseBullets(full, SECTION.affects) : [];
  const terms = secBody(SECTION.terms, false) ? parseTerms(full) : [];
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
  const cards = [...parsed.cards, ...parsed.extras].map((c) => (plainQuestion.approval && DENY_RE.test(c.label) ? { ...c, heavy: false } : c));
  const split = recommendation ? splitHeadline(recommendation) : null;
  const fns = parseFootnotes(body.join("\n"));
  return {
    ...base,
    kind: "question",
    background: kept.join("\n").trim(),
    recommendation,
    why,
    cond: recommendation ? condOf(recommendation) : null,
    headline: split?.headline ?? null,
    recRest: split?.rest || null,
    unknowns,
    assumptions,
    against,
    affects,
    terms,
    coinedTerms,
    footnotes: fns.defs.map((x) => x.id),
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
