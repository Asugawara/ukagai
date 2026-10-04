import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../../src/tui/app.js";
import { buildModel, fixedLabel, repoAnsi } from "../../src/tui/model.js";
import { parseSse } from "../../src/tui/api.js";
import { DEFAULT_SETTINGS } from "../../src/contract.js";
import { render, renderFrame, type View } from "../../src/tui/render.js";
import { stripAnsi, width } from "../../src/tui/width.js";
import { BLOCKER_MD_JA, V2_MD, V2_MD_JA, blockerDecision, decision, withExplanation } from "./helpers.js";

const NOW = Date.parse("2026-10-02T00:00:30.000Z");
function viewOf(d = decision(withExplanation(V2_MD)), lang: "en" | "ja" = "en"): View {
  const app = new App();
  app.lang = lang;
  app.upsert(d, NOW);
  return app.view(NOW);
}

test("140x40: heading, chips, recommendation, cards, background, hints, status line", () => {
  const out = stripAnsi(render(viewOf(), { cols: 140, rows: 40 }));
  const lines = out.split("\n");
  assert.equal(lines.length, 40);
  for (const s of [
    "ukagai ⎇ feat/tui ⧉ feat-tui", "Costly to undo", "repo",
    "Whether the GUI update channel uses SSE or WebSocket",
    "Why this decision is needed now", "What I checked", "hook", "serve",
    "Recommendation", "I recommend SSE", "▸ ● SSE", "○ WebSocket", "One-way delivery from the", "Free text",
    "j/k Enter send", "i text", "Pending 1", "h/l switch  b list  q quit",
  ]) assert.ok(out.includes(s), `missing: ${s}`);
  assert.ok(lines.some((l) => l.includes(" │ ") && l.includes("◄") === false && l.includes("SSE")), "two columns");
  assert.ok(lines.some((l) => l.includes("Background") && l.includes("Decision")), "column headings");
  for (const l of lines) assert.ok(width(l) <= 140);
});

test("colors: the repo in the origin has its own bold colour, reversibility is a background color, recommended badge", () => {
  const raw = render(viewOf(), { cols: 140, rows: 40 });
  assert.ok(raw.includes(`\x1b[1m${repoAnsi("ukagai")}ukagai\x1b[0m \x1b[1m⎇ feat/tui\x1b[0m \x1b[1m⧉ feat-tui`));
  assert.ok(raw.includes("\x1b[43;30m ◐ Costly to undo"));
  assert.ok(raw.includes("\x1b[42;30m Recommended "));
  const irr = viewOf(decision(withExplanation(V2_MD.replace("costly", "irreversible"))));
  assert.ok(render(irr, { cols: 140, rows: 40 }).includes("\x1b[41;97m ■ Irreversible"));
});

test("narrow (80 columns): stacked layout, the decision comes first", () => {
  const lines = stripAnsi(render(viewOf(), { cols: 80, rows: 60 })).split("\n");
  const rec = lines.findIndex((l) => l.includes("▸ ● SSE"));
  const bg = lines.findIndex((l) => l.includes("Why this decision is needed now"));
  assert.ok(rec > 0 && bg > rec);
  assert.ok(!lines.some((l) => l.includes("Background") && l.includes("Decision")));
});

test("scroll marks and scrollMax appear only when the background does not fit", () => {
  const long = V2_MD + "\n" + Array.from({ length: 80 }, (_, i) => `- row ${i}`).join("\n") + "\n";
  const v = viewOf(decision(withExplanation(long)));
  const f = renderFrame(v, { cols: 140, rows: 24 });
  assert.ok(f.scrollMax > 0);
  const txt = stripAnsi(f.text);
  assert.ok(/▼ 1-\d+\/\d+/.test(txt), "position indicator");
  assert.ok(txt.includes("PgUp/PgDn scroll · Tab column"));
  assert.ok(txt.includes("█"), "scrollbar");
  const short = renderFrame(viewOf(), { cols: 140, rows: 60 });
  assert.equal(short.scrollMax, 0);
  assert.ok(!stripAnsi(short.text).includes("PgUp/PgDn"));
  const scrolled = renderFrame({ ...v, scroll: f.scrollMax }, { cols: 140, rows: 24 });
  assert.ok(stripAnsi(scrolled.text).includes("row 79"));
});

test("without an explanation (multi-select): raw options and checkboxes", () => {
  const d = decision({
    explanation: { path: "", markdown: "", has: { mermaid: false, table: false, diff: false }, match: "recency", attached_via: "none" },
    request: { questions: [{ question: "Which ones to include?", header: "Target", multiSelect: true, options: [{ label: "A", description: "a is first" }, { label: "B", description: "b is second" }] }] },
  } as never);
  const out = stripAnsi(render(viewOf(d), { cols: 140, rows: 30 }));
  for (const s of ["Which ones to include?", "[ ] A", "a is first", "Space Enter send", "The agent did not write an explanation"]) assert.ok(out.includes(s), s);
});

test("a plan shows approve / reject buttons", () => {
  const d = decision({ kind: "approve_plan", request: { plan: "# Plan title\n\n## Scope and reversibility\n\nSmall.", planFilePath: "/p" } } as never);
  const out = stripAnsi(render(viewOf(d), { cols: 140, rows: 30 }));
  for (const s of ["Approve this plan?", "[y] Approve", "[n] Reject", "Scope and reversibility"]) assert.ok(out.includes(s), s);
  assert.ok(!out.includes("auto") && !out.includes("[a]"));
});

test("with no pending decisions, the empty message is centered", () => {
  const out = stripAnsi(render(new App().view(NOW), { cols: 100, rows: 20 }));
  assert.ok(out.includes("No pending decisions"));
  assert.ok(out.includes("Pending 0"));
});

test("a view can be rendered from a model alone (buildModel result placed on the view)", () => {
  const m = buildModel(decision(withExplanation(V2_MD)));
  const v: View = { ...viewOf(), model: m };
  assert.ok(stripAnsi(render(v, { cols: 140, rows: 40 })).includes(m.title));
});

test("blocker: band on top, 'What you need to do' with code right under the heading, then the 3 options, copy hint", () => {
  const out = stripAnsi(render(viewOf(blockerDecision()), { cols: 140, rows: 40 }));
  const lines = out.split("\n");
  assert.ok(lines[0]!.startsWith("ukagai ⎇ feat/tui") && lines[0]!.includes("Waiting for you"));
  for (const s of ["What you need to do", "gcloud auth login", "▸ ● Done. Continue", "○ Skip this step and continue", "○ Stop here", "c copy", "Why I stopped"]) {
    assert.ok(out.includes(s), `missing: ${s}`);
  }
  // In the right column, "What you need to do" sits above the 3 options
  const right = (s: string) => lines.findIndex((l) => l.split(" │ ").slice(1).join(" │ ").includes(s));
  assert.ok(right("What you need to do") >= 0 && right("What you need to do") < right("Done. Continue"));
  // and not in the left column
  assert.ok(!lines.some((l) => l.split(" │ ")[0]!.includes("What you need to do")));
  assert.ok(!out.includes("┌─ Recommendation"), "no recommendation box without a recommendation section");
  assert.ok(render(viewOf(blockerDecision()), { cols: 140, rows: 40 }).includes("\x1b[43;30m Waiting for you"));
});

test("blocker: without pbcopy the hint says copy is unsupported", () => {
  const app = new App();
  app.copySupported = false;
  app.upsert(blockerDecision(), NOW);
  const out = stripAnsi(render(app.view(NOW), { cols: 140, rows: 40 }));
  assert.ok(out.includes("no copy"));
  assert.ok(!out.includes("c copy"));
});

test("blocker: the list row carries a 'Task' mark", () => {
  const app = new App();
  app.upsert(blockerDecision(), NOW);
  app.upsert(decision({ id: "d2", created_at: "2026-10-02T00:00:10.000Z", ...withExplanation(V2_MD) }), NOW);
  app.handle({ name: "char", ch: "b" }, 1);
  const lines = stripAnsi(render(app.view(NOW), { cols: 100, rows: 20 })).split("\n");
  assert.ok(lines.some((l) => l.includes("Task") && l.includes("gcloud")), lines.join("\n"));
  assert.equal(lines.filter((l) => l.includes(" Task ")).length, 1);
});

test("a non-blocker decision shows neither the band nor 'c copy'", () => {
  const out = stripAnsi(render(viewOf(), { cols: 140, rows: 40 }));
  assert.ok(!out.includes("Waiting for you") && !out.includes("c copy"));
});

// ---- display language ----

test("ja: the main UI strings are Japanese", () => {
  const out = stripAnsi(render(viewOf(decision(withExplanation(V2_MD)), "ja"), { cols: 140, rows: 40 }));
  for (const s of [
    "戻すのにコストがかかる", "推奨", "自由記述", "背景", "判断",
    "j/k Enter 送信", "x 返答不可", "保留 1", "h/l 切替  b 一覧  q 終了",
  ]) assert.ok(out.includes(s), `missing: ${s}`);
  // headings written in the file are shown as written (not translated)
  assert.ok(out.includes("Why this decision is needed now"));
});

test("ja: plan buttons, empty state, blocker band", () => {
  const plan = decision({ kind: "approve_plan", request: { plan: "# P\n\n## Scope and reversibility\n\nSmall.", planFilePath: "/p" } } as never);
  const out = stripAnsi(render(viewOf(plan, "ja"), { cols: 140, rows: 30 }));
  for (const s of ["この計画を承認しますか", "[y] 承認", "[n] 却下"]) assert.ok(out.includes(s), s);
  const app = new App();
  app.lang = "ja";
  assert.ok(stripAnsi(render(app.view(NOW), { cols: 100, rows: 20 })).includes("判断待ちはありません"));
  const blocker = stripAnsi(render(viewOf(blockerDecision(), "ja"), { cols: 140, rows: 40 }));
  assert.ok(blocker.split("\n")[0]!.startsWith("ukagai ⎇ feat/tui") && blocker.split("\n")[0]!.includes("人の作業待ち"));
  assert.ok(blocker.includes("c コピー"));
});

test("Japanese heading aliases in the file give the same screen as the English headings", () => {
  const strip = (md: string) => stripAnsi(render(viewOf(decision(withExplanation(md))), { cols: 140, rows: 40 }));
  const en = strip(V2_MD);
  const ja = strip(V2_MD_JA);
  // The option table and recommendation are recognized in both: same cards, same recommendation box
  for (const s of ["▸ ● SSE", "○ WebSocket", "One-way delivery from the", "┌─ Recommendation", "I recommend SSE"]) {
    assert.ok(ja.includes(s), `ja alias: missing ${s}`);
    assert.ok(en.includes(s), `en: missing ${s}`);
  }
  // The headings shown in the background are the ones written in the file
  assert.ok(ja.includes("なぜ今この判断が要るか") && !ja.includes("Why this decision is needed now"));
  const blocker = stripAnsi(render(viewOf(blockerDecision({}, BLOCKER_MD_JA, [
    { label: "対応した。続けて (Recommended)" }, { label: "この手順は飛ばして続けて" }, { label: "ここで中断" },
  ])), { cols: 140, rows: 40 }));
  for (const s of ["▸ ● Done. Continue", "gcloud auth login", "Waiting for you"]) assert.ok(blocker.includes(s), s);
  // The todo section moves to the right column (it is not left in the background)
  const rows = blocker.split("\n");
  assert.ok(rows.some((l) => l.split(" │ ").slice(1).join(" │ ").includes("What you need to do")), "todo heading is in the right column");
  assert.ok(!rows.some((l) => l.split(" │ ")[0]!.includes("人にしてほしいこと")), "todo section is not in the background");
});

test("W1: a trailing (Recommended) / (推奨) is stripped from the card label; the value sent stays as received", () => {
  for (const [lbl, other] of [["A (Recommended)", "B"], ["A (推奨)", "B"], ["A（推奨）", "B"]] as const) {
    const d = decision({ request: { questions: [{ question: "Q?", header: "H", multiSelect: false, options: [{ label: lbl, description: "x" }, { label: other, description: "y" }] }] } });
    const m = buildModel(d);
    assert.equal(m.question!.cards[0]!.label, "A");
    assert.equal(m.question!.cards[0]!.value, lbl);
  }
});

test("W1: blocker fixed labels are shown in the display language (value unchanged); either-language input", () => {
  for (const lang of ["en", "ja"] as const) {
    for (const d of [blockerDecision(), blockerDecision({}, BLOCKER_MD_JA)]) {
      const out = stripAnsi(render(viewOf(d, lang), { cols: 140, rows: 40 }));
      const want = lang === "en" ? ["Done. Continue", "Skip this step and continue", "Stop here"] : ["完了。続けて", "この手順を飛ばして続けて", "ここで止める"];
      for (const s of want) assert.ok(out.includes(s), `${lang}: ${s}`);
    }
  }
  assert.equal(fixedLabel("対応した。続けて (推奨)"), "done");
  assert.equal(fixedLabel("Stop here"), "stop");
  assert.equal(fixedLabel("Sqlite"), undefined);
});

test("G1: frame line 1 starts with repo and branch in bold, at 120x40 and 100x24, and on a plan file", () => {
  for (const [cols, rows] of [[120, 40], [100, 24]] as const) {
    const raw = render(viewOf(), { cols, rows });
    assert.ok(stripAnsi(raw.split("\n")[0]!).startsWith("ukagai ⎇ feat/tui"), `${cols}x${rows}`);
    assert.ok(raw.split("\n")[0]!.startsWith("\x1b[1m"), "bold sequence first");
  }
  const blk = render(viewOf(blockerDecision()), { cols: 120, rows: 40 });
  assert.ok(stripAnsi(blk.split("\n")[0]!).startsWith("ukagai"), "blocker");
});

test("settings.updated: parsed from SSE; the app takes the language (unless --lang pinned it)", () => {
  const next = { ...DEFAULT_SETTINGS, lang: "ja" as const };
  const ev = parseSse(`event: settings.updated\ndata: ${JSON.stringify(next)}`);
  assert.deepEqual(ev, { event: "settings.updated", settings: next });
  assert.equal(parseSse(`event: settings.updated\ndata: ${JSON.stringify({ lang: "fr" })}`), null);
  const app = new App();
  app.settingsUpdated(next);
  assert.equal(app.lang, "ja");
  const pinned = new App();
  pinned.lang = "en";
  pinned.langLocked = true;
  pinned.settingsUpdated(next);
  assert.equal(pinned.lang, "en");
});

const QUIZ_Q = "Subject: parse_retry_after\n\nWhat does it return for \"120\"?";
const QUIZ_MD = (lang: "en" | "ja") => `---
ukagai: 1
type: quiz
question: |
  Subject: parse_retry_after

  What does it return for "120"?
title: Comprehension quiz on parse_retry_after
reversibility: reversible
scope: file
---

## ${lang === "en" ? "Why this question now" : "なぜ今この質問か"}

The agent edited this function 12 times.

## ${lang === "en" ? "Premise" : "前提"}

src/http/retry.rs reads the Retry-After header.

## ${lang === "en" ? "How to answer" : "答え方"}

Pick with the arrow keys and press Enter.
`;
const quizDecision = (lang: "en" | "ja" = "en") =>
  decision({
    request: { questions: [{ question: QUIZ_Q, header: "Quiz", multiSelect: false, options: [{ label: "Some(120s)", description: "Seconds" }, { label: "None (Recommended)", description: "No value" }] }] },
    ...withExplanation(QUIZ_MD(lang), { type: "quiz" }),
  });

test("quiz: band, the three sections, the options as given, no recommendation", () => {
  const raw = render(viewOf(quizDecision()), { cols: 140, rows: 40 });
  const out = stripAnsi(raw);
  for (const s of ["Quiz", "Why this question now", "The agent edited this function 12 times.", "Premise", "src/http/retry.rs reads", "How to answer", "▸ ● Some(120s)", "○ None (Recommended)", "Free text"]) assert.ok(out.includes(s), `missing: ${s}`);
  assert.ok(raw.includes("\x1b[46;30m Quiz "), "the Quiz band");
  for (const s of ["Recommendation", "Recommended ", "Waiting for you"]) assert.ok(!out.split("\n").some((l) => l.includes(s) && !l.includes("None (Recommended)")), `unexpected: ${s}`);
  assert.ok(!raw.includes("\x1b[42;30m Recommended "), "no recommended badge");
  const m = buildModel(quizDecision());
  assert.equal(m.quiz, true);
  assert.equal(m.recommendation, null);
  assert.equal(m.question!.cards.every((c) => !c.recommended), true);
  assert.equal(m.question!.initialCursor, 0);
});

test("quiz: ja headings and band; the Japanese Premise alias is not read as Assumptions", () => {
  const out = stripAnsi(render(viewOf(quizDecision("ja"), "ja"), { cols: 140, rows: 40 }));
  for (const s of ["理解度クイズ", "なぜ今この質問か", "前提", "答え方"]) assert.ok(out.includes(s), `missing: ${s}`);
  assert.equal(buildModel(quizDecision("ja"), "ja").assumptions.length, 0);
});
