import { AskUserQuestionInput, ExitPlanModeInput, type Decision } from "../contract.js";
import {
  findSection,
  findTables,
  normalizeHeading,
  normalizeLabel,
  parseFrontMatter,
  scanFences,
  scanHeadings,
  toLines,
  type Table,
} from "../hook/explain.js";

// 判断(Decision)→ 画面モデル。GUI(public/app.js の buildModel / parseOptionsTable)と同じ照合規則。

export interface Chip {
  kind: "repo" | "branch" | "worktree";
  text: string;
}

export interface CardLine {
  /** Markdown の断片(表のセル)。md が false なら生の文字列 */
  text: string;
  md: boolean;
  /** 「リスクと戻し方」の行(dim、強調は赤) */
  risk?: boolean;
}

export interface Card {
  /** 回答に入れる値。元の option.label */
  value: string;
  label: string;
  lines: CardLine[];
  /** 「推奨」バッジ */
  recommended: boolean;
}

export type Reversibility = "reversible" | "costly" | "irreversible";

export interface ScreenModel {
  id: string;
  kind: "question" | "plan";
  title: string;
  chips: Chip[];
  /** ~ 付きのパス */
  cwd: string;
  reversibility?: Reversibility;
  scope?: string;
  createdAt: string;
  /** 左(背景)に出す Markdown。無ければ null */
  background: string | null;
  /** 背景の代わりに出す一文(説明なし) */
  backgroundNote?: string;
  /** 「推奨」節の本文(Markdown) */
  recommendation: string | null;
  /** 計画本文の「影響範囲と可逆性」節の本文(Markdown)。計画カードの右列に出す */
  impact?: string | null;
  /** 人の作業待ち(explanation.type === "blocker") */
  blocker: boolean;
  /** blocker の「人にしてほしいこと」節の本文(Markdown)。右列の最上部に出す */
  todo: string | null;
  /** todo の中のコードブロックの中身(`c` で先頭をコピー) */
  todoCode: string[];
  /** 単一の質問のとき */
  question?: {
    text: string;
    header: string;
    multi: boolean;
    cards: Card[];
    /** 初期カーソル(推奨、無ければ 0) */
    initialCursor: number;
    /** 表から読めた(v2)か */
    v2: boolean;
  };
  /** 質問が 2 つ以上(TUI では答えられない) */
  unsupported?: string;
  hasExplanation: boolean;
}

const SUFFIX_RE = /\s*[(（]\s*(recommended|推奨)\s*[)）]\s*$/i;
const stripSuffix = (s: string): string => s.replace(SUFFIX_RE, "");

const NONE_REASON: Record<string, string> = {
  loop_guard: "書き直しの指示に従わなかったため",
  plan_mode: "plan mode のため",
  not_required: "説明を要求していないため",
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

/** Markdown の fenced code block の中身を順に取り出す */
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

export function titleOf(d: Decision, fm: Record<string, string>): string {
  const t = d.explanation?.title || (hasExplanation(d) && d.kind === "answer_question" ? fm["title"] : undefined);
  if (t) return t;
  if (d.kind === "approve_plan") {
    return /^#[ \t]+(.+?)[ \t]*$/m.exec(planOf(d))?.[1] ?? "計画の承認";
  }
  const q = questionsOf(d)[0]?.question;
  return stripSuffix(d.session.title || q || "質問");
}

function metaOf(d: Decision, fm: Record<string, string>, key: "reversibility" | "scope"): string | undefined {
  const ex = d.explanation;
  if (!ex) return undefined;
  if (ex[key]) return ex[key];
  if (d.kind === "answer_question" && hasExplanation(d)) return fm[key];
  return undefined;
}

export function elapsed(iso: string, now: number = Date.now()): string {
  const sec = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (sec < 60) return `${sec}秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)}分`;
  return `${Math.floor(sec / 3600)}時間`;
}

const isDash = (s: string): boolean => /^[-—ー]*$/u.test(s.trim());

/** 表(先頭列 = ラベル)を options に対応付ける。対応が取れる行が無ければ null */
function cardsFromTable(
  t: Table,
  options: { label: string; description?: string | undefined }[],
  recommended: string | undefined,
): { cards: Card[]; extras: Card[] } | null {
  const hn = t.header.map(normalizeHeading);
  const hi = hn.findIndex((h) => h.includes(normalizeHeading("起きること")));
  const ri = hn.findIndex((h) => h.includes(normalizeHeading("リスク")));
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

/** 計画本文から「影響範囲と可逆性」節の本文を抜き出す(完全一致を先に、次に部分一致)。無ければ null */
export function impactOf(plan: string): string | null {
  const body = toLines(plan);
  const { inFence } = scanFences(body);
  const sec = findSection(scanHeadings(body, inFence), body.length, "影響範囲と可逆性");
  if (!sec) return null;
  return body.slice(sec.start + 1, sec.end).join("\n").trim() || null;
}

export function buildModel(d: Decision): ScreenModel {
  const explained = hasExplanation(d);
  const md = explained ? (d.explanation?.markdown ?? "") : "";
  const all = toLines(md);
  const fmParsed = d.kind === "answer_question" && explained ? parseFrontMatter(all) : null;
  const fm = fmParsed?.fields ?? {};
  const rev = metaOf(d, fm, "reversibility") as Reversibility | undefined;
  const base = {
    id: d.id,
    title: titleOf(d, fm),
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
    // hook は explanation.markdown に計画本文を入れるので、本文と違うときだけ続ける
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
      unsupported: "質問が複数あります。TUI では答えられないので GUI で答えてください",
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
    const reason = NONE_REASON[code] ?? code;
    return {
      ...base,
      kind: "question",
      background: null,
      backgroundNote: `エージェントは説明を書きませんでした${reason ? `(理由: ${reason})` : ""}`,
      recommendation: null,
      question: { ...plainQuestion, cards: rawCards, initialCursor: pref(rawCards), v2: false },
    };
  }

  const body = all.slice(fmParsed!.bodyStart);
  const { inFence } = scanFences(body);
  const headings = scanHeadings(body, inFence);
  const optSec = findSection(headings, body.length, "選択肢");
  let recSec = findSection(headings, body.length, "推奨");
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
    const todoSec = findSection(headings, body.length, "人にしてほしいこと");
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
