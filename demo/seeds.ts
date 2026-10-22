// Seed data for the demo GUI: fixed ids, the story text (en / ja), and the files the seeds read.
// Imports nothing that starts work; the render and the shots call into it.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Lang = "en" | "ja";
export const LANGS: readonly Lang[] = ["en", "ja"];

export const OWNER = "0123456789abcdef";

export type SessionKey = "cc" | "cc2" | "codex";
export const SESSION_IDS: Record<SessionKey, string> = {
  cc: "5e7c9a10-0000-4000-8000-000000000001",
  cc2: "5e7c9a10-0000-4000-8000-000000000002",
  codex: "5e7c9a10-0000-4000-8000-000000000003",
};

export const PROJECTS: Record<SessionKey, string> = {
  cc: "export-service",
  cc2: "orders-api",
  codex: "web-app",
};

export const TOOL_USE_IDS = {
  hero: "toolu_demo_hero",
  compare: "toolu_demo_compare",
  planV1: "toolu_demo_plan_v1",
  planV2: "toolu_demo_plan_v2",
} as const;

// Stored in the demo's own story; timeline.js does not exist yet (Step 9).
export const STORY: Record<Lang, Record<SessionKey, { prompt: string; question?: string; instruction?: string }>> = {
  en: {
    cc: { prompt: "Failed exports should retry with backoff. Plan it first.", question: "Where should the retry for failed exports live?" },
    codex: { prompt: "Make the onboarding page convert better. Show me options.", question: "Which onboarding page variant should we ship?" },
    cc2: { prompt: "Add a currency column to the orders table.", instruction: "Backfill in batches: one UPDATE would lock orders for minutes." },
  },
  ja: {
    cc: { prompt: "失敗したエクスポートをバックオフ付きでリトライさせたい。まずプランを立てて", question: "失敗したエクスポートのリトライはどこに置くべきですか？" },
    codex: { prompt: "オンボーディングページの登録率を上げたい。案を見せて", question: "公開するオンボーディングページはどの案にしますか？" },
    cc2: { prompt: "orders テーブルに currency 列を追加して", instruction: "バッチで埋め戻して。1 回の UPDATE だと orders が数分ロックされる" },
  },
};

export interface Option {
  label: string;
  description: string;
}

export const HERO_HEADER: Record<Lang, string> = { en: "Retry", ja: "リトライ" };
export const COMPARE_HEADER: Record<Lang, string> = { en: "Variant", ja: "案" };

export const HERO_OPTIONS: Record<Lang, Option[]> = {
  en: [
    { label: "In the queue worker (Recommended)", description: "The worker nacks on timeout and the queue redelivers with backoff." },
    { label: "In the API", description: "The API re-enqueues failed jobs after a status poll." },
    { label: "In the client", description: "The client resubmits when the request errors." },
  ],
  ja: [
    { label: "キューのワーカー (推奨)", description: "ワーカーがタイムアウトで nack し、キューがバックオフ付きで再配信する。" },
    { label: "API サーバー", description: "API が状態をポーリングし、失敗したジョブを再投入する。" },
    { label: "クライアント", description: "リクエストがエラーになったらクライアントが再送する。" },
  ],
};

export const COMPARE_OPTIONS: Record<Lang, Option[]> = {
  en: [
    { label: "Variant A, centered (Recommended)", description: "Ship the single-column page with the blue button." },
    { label: "Variant B, split", description: "Ship the two-column page with the testimonial." },
    { label: "Keep the current page", description: "Change nothing." },
  ],
  ja: [
    { label: "案 A（中央寄せ） (推奨)", description: "青いボタンの 1 カラムのページを公開する。" },
    { label: "案 B（2 分割）", description: "お客様の声つきの 2 カラムのページを公開する。" },
    { label: "現状のまま", description: "何も変えない。" },
  ],
};

export const BACKFILL: Record<Lang, { v1: string; v2: string }> = {
  en: { v1: "one UPDATE over all 40M rows", v2: "in batches of 10k rows, resumable by order id" },
  ja: { v1: "4,000 万行を 1 回の UPDATE で書き換える", v2: "1 万行ずつのバッチで、注文 id から再開できるようにする" },
};

export const SEEDS_DIR = join(dirname(fileURLToPath(import.meta.url)), "seeds");

export function seedText(name: string): string {
  return readFileSync(join(SEEDS_DIR, name), "utf8");
}

export interface FrontMatter {
  title: string;
  question: string;
  reversibility: string;
  scope: string;
}

export function frontMatter(md: string): FrontMatter {
  const field = (k: string) => {
    const m = new RegExp(`\\n${k}: (.*)`).exec(md);
    if (!m) throw new Error(`explanation has no ${k}: front matter`);
    return m[1]!;
  };
  return { title: field("title"), question: field("question"), reversibility: field("reversibility"), scope: field("scope") };
}

export const heroExplanation = (lang: Lang) => seedText(`hero.${lang}.md`);
export const compareExplanation = (lang: Lang) => seedText(`compare.${lang}.md`);
export const compareHtml = (lang: Lang, which: "a" | "b") => seedText(`compare-${which}.${lang}.html`);

export function planTemplate(lang: Lang, version: 1 | 2): string {
  const backfill = version === 1 ? BACKFILL[lang].v1 : BACKFILL[lang].v2;
  return seedText(`plan.${lang}.md`).replace("{{backfill}}", backfill);
}

export const checkoutSource = () => seedText("orders-api/checkout.ts.txt");
