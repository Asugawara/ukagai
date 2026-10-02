import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../../src/tui/app.js";
import { buildModel } from "../../src/tui/model.js";
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
    "◈ ukagai", "⎇ feat/tui", "⧉ feat-tui", "Costly to undo", "repo",
    "Whether the GUI update channel uses SSE or WebSocket",
    "Why this decision is needed now", "What I checked", "hook", "serve",
    "Recommendation", "I recommend SSE", "▸ ● SSE", "○ WebSocket", "One-way delivery from the server to the GUI", "Free text",
    "j/k move Enter send i text", "Pending 1", "h/l switch  b list  q quit",
  ]) assert.ok(out.includes(s), `missing: ${s}`);
  assert.ok(lines.some((l) => l.includes(" │ ") && l.includes("◄") === false && l.includes("SSE")), "two columns");
  assert.ok(lines.some((l) => l.includes("Background") && l.includes("Decision")), "column headings");
  for (const l of lines) assert.ok(width(l) <= 140);
});

test("colors: chips are magenta/green/yellow, reversibility is a background color, recommended badge", () => {
  const raw = render(viewOf(), { cols: 140, rows: 40 });
  assert.ok(raw.includes("\x1b[35m◈ ukagai"));
  assert.ok(raw.includes("\x1b[32m⎇ feat/tui"));
  assert.ok(raw.includes("\x1b[33m⧉ feat-tui"));
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
  for (const s of ["Which ones to include?", "[ ] A", "a is first", "Space pick", "The agent did not write an explanation"]) assert.ok(out.includes(s), s);
});

test("a plan shows approve / auto / reject buttons", () => {
  const d = decision({ kind: "approve_plan", request: { plan: "# Plan title\n\n## Scope and reversibility\n\nSmall.", planFilePath: "/p" } } as never);
  const out = stripAnsi(render(viewOf(d), { cols: 140, rows: 30 }));
  for (const s of ["Approve this plan?", "[y] Approve", "[a] Approve and auto", "[n] Reject", "Scope and reversibility"]) assert.ok(out.includes(s), s);
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
  assert.equal(lines[0]!.trim(), "Waiting for you");
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
    "j/k 移動 Enter 送信 i 記述", "保留 1", "h/l 切替  b 一覧  q 終了",
  ]) assert.ok(out.includes(s), `missing: ${s}`);
  // headings written in the file are shown as written (not translated)
  assert.ok(out.includes("Why this decision is needed now"));
});

test("ja: plan buttons, empty state, blocker band", () => {
  const plan = decision({ kind: "approve_plan", request: { plan: "# P\n\n## Scope and reversibility\n\nSmall.", planFilePath: "/p" } } as never);
  const out = stripAnsi(render(viewOf(plan, "ja"), { cols: 140, rows: 30 }));
  for (const s of ["この計画を承認しますか", "[y] 承認", "[a] 承認して auto", "[n] 却下"]) assert.ok(out.includes(s), s);
  const app = new App();
  app.lang = "ja";
  assert.ok(stripAnsi(render(app.view(NOW), { cols: 100, rows: 20 })).includes("判断待ちはありません"));
  const blocker = stripAnsi(render(viewOf(blockerDecision(), "ja"), { cols: 140, rows: 40 }));
  assert.equal(blocker.split("\n")[0]!.trim(), "人の作業待ち");
  assert.ok(blocker.includes("c コピー"));
});

test("Japanese heading aliases in the file give the same screen as the English headings", () => {
  const strip = (md: string) => stripAnsi(render(viewOf(decision(withExplanation(md))), { cols: 140, rows: 40 }));
  const en = strip(V2_MD);
  const ja = strip(V2_MD_JA);
  // The option table and recommendation are recognized in both: same cards, same recommendation box
  for (const s of ["▸ ● SSE", "○ WebSocket", "One-way delivery from the server to the GUI", "┌─ Recommendation", "I recommend SSE"]) {
    assert.ok(ja.includes(s), `ja alias: missing ${s}`);
    assert.ok(en.includes(s), `en: missing ${s}`);
  }
  // The headings shown in the background are the ones written in the file
  assert.ok(ja.includes("なぜ今この判断が要るか") && !ja.includes("Why this decision is needed now"));
  const blocker = stripAnsi(render(viewOf(blockerDecision({}, BLOCKER_MD_JA, [
    { label: "対応した。続けて (Recommended)" }, { label: "この手順は飛ばして続けて" }, { label: "ここで中断" },
  ])), { cols: 140, rows: 40 }));
  for (const s of ["▸ ● 対応した。続けて", "gcloud auth login", "Waiting for you"]) assert.ok(blocker.includes(s), s);
  // The todo section moves to the right column (it is not left in the background)
  const rows = blocker.split("\n");
  assert.ok(rows.some((l) => l.split(" │ ").slice(1).join(" │ ").includes("What you need to do")), "todo heading is in the right column");
  assert.ok(!rows.some((l) => l.split(" │ ")[0]!.includes("人にしてほしいこと")), "todo section is not in the background");
});
