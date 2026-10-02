import { test } from "node:test";
import assert from "node:assert/strict";
import { buildModel, elapsed } from "../../src/tui/model.js";
import { BLOCKER_MD_JA, Q, V2_MD, V2_MD_JA, blockerDecision, decision, withExplanation } from "./helpers.js";

test("v2: title / chips / recommendation / cards / background sections", () => {
  const m = buildModel(decision(withExplanation(V2_MD)));
  assert.equal(m.kind, "question");
  assert.equal(m.title, "Whether the GUI update channel uses SSE or WebSocket");
  assert.deepEqual(m.chips.map((c) => `${c.kind}:${c.text}`), ["repo:◈ ukagai", "branch:⎇ feat/tui", "worktree:⧉ feat-tui"]);
  assert.equal(m.reversibility, "costly");
  assert.equal(m.scope, "repo");
  assert.match(m.recommendation ?? "", /I recommend SSE/);
  const q = m.question!;
  assert.ok(q.v2);
  assert.deepEqual(q.cards.map((c) => [c.value, c.label, c.recommended]), [
    ["SSE (Recommended)", "SSE", true],
    ["WebSocket", "WebSocket", false],
  ]);
  assert.equal(q.initialCursor, 0);
  assert.equal(q.cards[0]!.lines[1]!.risk, true);
  // The background has neither the options nor the recommendation
  assert.match(m.background!, /Why this decision is needed now/);
  assert.match(m.background!, /Diagram/);
  assert.match(m.background!, /What I checked/);
  assert.doesNotMatch(m.background!, /What happens if chosen/);
  assert.doesNotMatch(m.background!, /I recommend SSE/);
});

test("v2: Japanese heading aliases build the same model as English headings", () => {
  const en = buildModel(decision(withExplanation(V2_MD)));
  const ja = buildModel(decision(withExplanation(V2_MD_JA)));
  assert.deepEqual(ja.question, en.question);
  assert.equal(ja.recommendation, en.recommendation);
  assert.match(ja.background!, /なぜ今この判断が要るか/);
  assert.doesNotMatch(ja.background!, /選択肢|選ぶと起きること/);
});

test("v2: an option missing from the table falls back to its raw description; the (Recommended) suffix gets the initial cursor", () => {
  const md = V2_MD.replace("| SSE | One-way delivery from the server to the GUI. | If you later need **two-way**, rewrite it (about 1 day). |\n", "").replace("recommended: SSE", "recommended: nonexistent");
  const q = buildModel(decision(withExplanation(md))).question!;
  assert.deepEqual(q.cards.map((c) => c.value), ["WebSocket", "SSE (Recommended)"]);
  assert.deepEqual(q.cards[1]!.lines, [{ text: "One-way", md: false }]);
  assert.equal(q.initialCursor, 1);
});

test("old format (no table): the whole body is the background, options are raw labels", () => {
  const md = "---\nukagai: 1\nquestion: q\ntitle: Old format title\n---\n\n## Why now\n\nThe reason.\n";
  const m = buildModel(decision(withExplanation(md)));
  assert.equal(m.title, "Old format title");
  assert.ok(!m.question!.v2);
  assert.match(m.background!, /The reason/);
  assert.deepEqual(m.question!.cards.map((c) => c.label), ["SSE", "WebSocket"]);
  assert.equal(m.recommendation, null);
});

test("without an explanation: raw question and options, one sentence for the reason (per display language)", () => {
  const d = decision({ explanation: { path: "", markdown: "", has: { mermaid: false, table: false, diff: false }, match: "recency", attached_via: "none", none_reason: "plan_mode" } } as never);
  const m = buildModel(d);
  assert.equal(m.hasExplanation, false);
  assert.equal(m.title, Q);
  assert.equal(m.backgroundNote, "The agent did not write an explanation (reason: plan mode)");
  assert.equal(m.question!.cards[0]!.lines[0]!.text, "One-way");
  assert.equal(buildModel(d, "ja").backgroundNote, "エージェントは説明を書きませんでした(理由: plan mode のため)");
});

test("plan: the body is the background, the title is the first heading", () => {
  const d = decision({
    kind: "approve_plan",
    request: { plan: "# Plan title\n\n## Scope and reversibility\n\nSmall.", planFilePath: "/p.md" },
  } as never);
  const m = buildModel(d);
  assert.equal(m.kind, "plan");
  assert.equal(m.title, "Plan title");
  assert.match(m.background!, /Scope and reversibility/);
  assert.equal(m.question, undefined);
});

test("a cwd outside a worktree uses only its last segment as the repo", () => {
  const m = buildModel(decision({ session: { session_id: "s", cwd: "/Users/a/dev/ukagai", transcript_path: "/x" }, context: {} } as never));
  assert.deepEqual(m.chips.map((c) => c.text), ["◈ ukagai"]);
  assert.equal(m.cwd, "~/dev/ukagai");
});

test("blocker: todo leaves the background and its code blocks are extracted; the initial cursor is 'Done. Continue'", () => {
  const m = buildModel(blockerDecision());
  assert.equal(m.blocker, true);
  assert.match(m.todo ?? "", /Run the following in a terminal/);
  assert.deepEqual(m.todoCode, ["gcloud auth login\ngcloud auth application-default login"]);
  assert.match(m.background ?? "", /Why I stopped/);
  assert.doesNotMatch(m.background ?? "", /What you need to do/);
  assert.equal(m.recommendation, null);
  const q = m.question!;
  assert.deepEqual(q.cards.map((c) => c.label), ["Done. Continue", "Skip this step and continue", "Stop here"]);
  assert.equal(q.initialCursor, 0);
});

test("blocker: Japanese aliases for the sections are recognized", () => {
  const m = buildModel(blockerDecision({}, BLOCKER_MD_JA, [
    { label: "対応した。続けて (Recommended)" }, { label: "この手順は飛ばして続けて" }, { label: "ここで中断" },
  ]));
  assert.equal(m.blocker, true);
  assert.match(m.todo ?? "", /Run the following in a terminal/);
  assert.deepEqual(m.todoCode, ["gcloud auth login"]);
  assert.doesNotMatch(m.background ?? "", /人にしてほしいこと/);
  assert.deepEqual(m.question!.cards.map((c) => c.label), ["対応した。続けて", "この手順は飛ばして続けて", "ここで中断"]);
});

test("blocker: the front matter type alone makes a blocker (when explanation.type is missing)", () => {
  const base = blockerDecision();
  const m = buildModel({ ...base, explanation: { ...base.explanation!, type: undefined } });
  assert.equal(m.blocker, true);
});

test("a decision is not a blocker", () => {
  const m = buildModel(decision(withExplanation(V2_MD)));
  assert.equal(m.blocker, false);
  assert.equal(m.todo, null);
  assert.deepEqual(m.todoCode, []);
});

test("elapsed time and default titles follow the display language", () => {
  const at = "2026-10-02T00:00:00.000Z";
  const t = (s: number) => Date.parse(at) + s * 1000;
  assert.deepEqual([elapsed(at, t(5)), elapsed(at, t(120)), elapsed(at, t(7200))], ["5s", "2m", "2h"]);
  assert.deepEqual([elapsed(at, t(5), "ja"), elapsed(at, t(120), "ja"), elapsed(at, t(7200), "ja")], ["5秒", "2分", "2時間"]);
  const plan = decision({ kind: "approve_plan", request: { plan: "no heading", planFilePath: "/p" } } as never);
  assert.equal(buildModel(plan).title, "Approve plan");
  assert.equal(buildModel(plan, "ja").title, "計画の承認");
});
