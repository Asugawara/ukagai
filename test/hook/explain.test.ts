import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BLOCKER_LABELS as BLOCKER_FIXED,
  denyReason,
  findSection,
  scanHeadings,
  toLines,
  MISSING_LABELS,
  multiDenyReason,
  findExplanation,
  markUsed,
  normalizeLabel,
  RECOMMEND_COND,
  SECTION,
  validateExplanation,
  validatePlan,
} from "../../src/hook/explain.js";
import { tmpDir, writeFile } from "./helpers.js";

const fixDir = fileURLToPath(new URL("../explain-fixtures/", import.meta.url));
const mdFiles = readdirSync(fixDir).filter((f) => f.endsWith(".md"));

test("there are 20 fixtures", () => {
  assert.equal(mdFiles.length, 20);
});

for (const f of mdFiles) {
  test(`fixture ${f} matches expected`, () => {
    const md = readFileSync(join(fixDir, f), "utf8");
    const expected = JSON.parse(readFileSync(join(fixDir, f.replace(/\.md$/, ".expected.json")), "utf8"));
    const actual = f.startsWith("plan-") ? validatePlan(md) : validateExplanation(md, "answer_question");
    assert.deepEqual(actual, expected);
  });
}

const GOOD = `---
ukagai: 1
question: "Q?"
title: Choose A or B
reversibility: reversible
scope: file
recommended: A
---
## Why this decision is needed now
Reason
## Options
| Option | What happens if chosen | Risks and how to undo |
|---|---|---|
| A | a | b |
| B | a | b |
## Recommendation
I recommend A. If C, choose B.
`;

/** The same explanation with Japanese headings and column names (aliases) */
const GOOD_JA = GOOD.replace("## Why this decision is needed now", "## なぜ今この判断が要るか")
  .replace("## Options", "## 選択肢")
  .replace("## Recommendation", "## 推奨")
  .replace("| Option | What happens if chosen | Risks and how to undo |", "| 選択肢 | 選ぶと起きること | リスクと戻し方 |")
  .replace("I recommend A. If C, choose B.", "A を推す。C なら B。");

test("a diagram is optional for reversible + file", () => {
  assert.equal(validateExplanation(GOOD).valid, true);
});

test("an explanation with Japanese headings, columns and condition passes", () => {
  assert.equal(validateExplanation(GOOD_JA).valid, true);
  assert.equal(validateExplanation(GOOD_JA.replace("## 推奨", "## Recommendation")).valid, true);
  // headings and table columns can be mixed freely
  assert.equal(validateExplanation(GOOD.replace("## Options", "## 選択肢")).valid, true);
  assert.equal(validateExplanation(GOOD.replace("What happens if chosen", "選ぶと起きること")).valid, true);
});

test("English headings are case-insensitive; table columns match by keyword", () => {
  assert.equal(validateExplanation(GOOD.replace("## Options", "## OPTIONS").replace("## Recommendation", "## recommendation")).valid, true);
  assert.equal(validateExplanation(GOOD.replace("What happens if chosen", "Outcome").replace("Risks and how to undo", "Risk")).valid, true);
});

test("a table with the wrong number of rows or labels is a table defect", () => {
  assert.deepEqual(validateExplanation(GOOD, "answer_question", ["A", "B", "C"]).missing, ["table"]);
  assert.deepEqual(validateExplanation(GOOD, "answer_question", ["A", "X"]).missing, ["table"]);
  assert.equal(validateExplanation(GOOD, "answer_question", ["A", "B"]).valid, true);
});

test("recommended missing from the options is a recommended defect; (Recommended) still matches", () => {
  assert.deepEqual(validateExplanation(GOOD.replace("recommended: A", "recommended: Z"), "answer_question", ["A", "B"]).missing, ["recommended"]);
  assert.deepEqual(validateExplanation(GOOD.replace("recommended: A\n", "")).missing, ["recommended"]);
  assert.equal(validateExplanation(GOOD, "answer_question", ["A (Recommended)", "B"]).valid, true);
  const md = GOOD.replace("recommended: A", "recommended: a（推奨）").replace("| A |", "| A (Recommended) |");
  assert.equal(validateExplanation(md, "answer_question", ["A", "B"]).valid, true);
  const ja = GOOD.replace("recommended: A", "recommended: A (推奨)").replace("| A |", "| A (推奨) |");
  assert.equal(validateExplanation(ja, "answer_question", ["A", "B"]).valid, true);
});

test("a missing title is a title defect, old columns a table defect, a missing Recommendation section a recommend defect", () => {
  assert.deepEqual(validateExplanation(GOOD.replace(/title: .*\n/, "")).missing, ["title"]);
  assert.deepEqual(validateExplanation(GOOD.replace("What happens if chosen", "Pros").replace("Risks and how to undo", "Cons")).missing, ["table"]);
  assert.deepEqual(validateExplanation(GOOD.replace("## Recommendation\nI recommend A. If C, choose B.\n", "")).missing, ["recommend"]);
});

test("a heading such as \"Options compared\" matches partially", () => {
  assert.equal(validateExplanation(GOOD.replace("## Options", "## Options compared")).valid, true);
  assert.equal(validateExplanation(GOOD_JA.replace("## 選択肢", "## 選択肢の比較")).valid, true);
});

test("findSection prefers an exact match (takes \"Options\" after \"Recommended options\")", () => {
  const md = GOOD.replace("## Options\n", "## Recommended options\nThis section has no table\n## Options\n");
  assert.equal(validateExplanation(md).valid, true);
  const bad = GOOD.replace("## Recommendation\n", "## Recommended options\n").replace("| B | a | b |", "| B | a | - |");
  assert.ok(validateExplanation(bad).missing.includes("table"));
});

test("findSection takes an array of names: exact match on any name first, then partial", () => {
  const lines = toLines("## Alpha\ntext\n## 選択肢の比較\ntext\n## Options\ntext\n");
  const headings = scanHeadings(lines, lines.map(() => false));
  assert.equal(findSection(headings, lines.length, SECTION.options)?.title, "Options");
  assert.equal(findSection(headings, lines.length, ["選択肢"])?.title, "選択肢の比較");
  assert.equal(findSection(headings, lines.length, ["OPTIONS"])?.title, "Options");
  assert.equal(findSection(headings, lines.length, SECTION.diagram), null);
});

test("normalizeLabel: NFKC, suffix removal, whitespace removal, lowercase", () => {
  assert.equal(normalizeLabel("SSE (Recommended)"), "sse");
  assert.equal(normalizeLabel("ＳＳＥ（Recommended）"), "sse");
  assert.equal(normalizeLabel("退避して 削除　(推奨)"), "退避して削除".replace(/\s/g, ""));
  assert.equal(normalizeLabel("退避して削除（推奨）"), "退避して削除");
  assert.equal(normalizeLabel("Node Test"), "nodetest");
  assert.equal(normalizeLabel("A (Recommended) B"), "a(recommended)b");
});

test("a cell with only - is a table defect", () => {
  const md = GOOD.replace("| B | a | b |", "| B | a | - |");
  assert.deepEqual(validateExplanation(md).missing, ["table"]);
});

test("without front matter only front_matter is reported (question etc. are not evaluated), and a diagram is required", () => {
  const md = GOOD.replace(/^---[\s\S]*?---\n/, "");
  assert.deepEqual(validateExplanation(md).missing, ["front_matter", "diagram"]);
});

test("headings inside code fences are not sections", () => {
  const md = GOOD.replace("Reason\n", "```\n## Options\n```\n");
  assert.equal(validateExplanation(md).valid, true);
});

test("validateExplanation(approve_plan) is the same as validatePlan", () => {
  assert.deepEqual(validateExplanation("# x", "approve_plan").missing, ["impact"]);
  assert.equal(validatePlan("# x\n## Scope and reversibility\nOne file.").valid, true);
  assert.equal(validatePlan("# x\n## 影響範囲と可逆性\n1 ファイル。").valid, true);
  assert.deepEqual(validatePlan("# x\n## Scope and reversibility\n").missing, ["impact"]);
});

test("findExplanation: exact question match → recency → null; used files are ignored", async () => {
  const dir = tmpDir();
  writeFile(join(dir, "a.md"), GOOD);
  writeFile(join(dir, "b.used.md"), GOOD);
  const hit = await findExplanation(dir, "Q?");
  assert.equal(hit?.match, "question");
  assert.equal(hit?.path, join(dir, "a.md"));
  const rec = await findExplanation(dir, "another question");
  assert.equal(rec?.match, "recency");
  writeFile(join(dir, "c.md"), GOOD.replace("Q?", "R?"));
  assert.equal(await findExplanation(dir, "another question"), null);
  const old = new Date(Date.now() - 11 * 60 * 1000);
  utimesSync(join(dir, "a.md"), old, old);
  utimesSync(join(dir, "c.md"), old, old);
  assert.equal(await findExplanation(dir, "another question"), null);
  assert.equal(await findExplanation(join(dir, "none"), "Q?"), null);
});

test("markUsed renames to .used.md", async () => {
  const dir = tmpDir();
  writeFile(join(dir, "a.md"), GOOD);
  const used = await markUsed(join(dir, "a.md"));
  assert.equal(used, join(dir, "a.used.md"));
  assert.deepEqual(readdirSync(dir), ["a.used.md"]);
});

test("denyReason: has the save path, the verbatim question and the missing items; at most 600 characters; no URL", () => {
  for (const t of ["A", "B"] as const) {
    const r = denyReason(t, { path: "/tmp/x/ukagai/explain.md", question: "Which one?", missing: ["a", "b"] });
    assert.match(r, /\/tmp\/x\/ukagai\/explain\.md/);
    assert.match(r, /Which one\?/);
    assert.match(r, /a; b/);
    assert.ok(r.length <= 600);
    assert.doesNotMatch(r, /https?:|localhost|127\.0\.0\.1|\/api\//);
  }
  const many = Array.from({ length: 80 }, (_, i) => `item${i}`);
  const long = denyReason("A", { path: "/p/ukagai/explain.md", question: "Q", missing: many });
  assert.ok(long.length <= 600);
  assert.match(long, /\.\.\. and \d+ more/);
});

test("denyReason: no file / missing front matter gives the minimal template (ukagai: 1, the real question, English headings, save path) within 1200 characters", () => {
  for (const t of ["A", "B"] as const) {
    for (const codes of [["file"], ["front_matter", "question"]] as const) {
      const r = denyReason(t, {
        path: "/tmp/x/ukagai/explain.md",
        question: "Which one?",
        missing: codes.map((c) => MISSING_LABELS[c]),
        codes: [...codes],
      });
      assert.match(r, /skill ukagai-explain/);
      assert.match(r, /ukagai: 1/);
      assert.match(r, /question: Which one\?/);
      assert.match(r, new RegExp(`## ${SECTION.why[0]}`));
      assert.match(r, new RegExp(`## ${SECTION.options[0]}`));
      assert.match(r, new RegExp(`## ${SECTION.recommendation[0]}`));
      assert.match(r, /\| Option \| What happens if chosen \| Risks and how to undo \|/);
      assert.match(r, /\/tmp\/x\/ukagai\/explain\.md/);
      assert.ok(r.length <= 1200);
      assert.doesNotMatch(r, /https?:|localhost|127\.0\.0\.1|\/api\//);
      assert.doesNotMatch(r, /[ぁ-んァ-ン一-龥]/);
    }
  }
});

test("denyReason: the template placeholder under Recommendation does not satisfy recommend_cond", () => {
  const r = denyReason("A", { path: "/p/ukagai/explain.md", question: "Q", missing: ["x"], codes: ["file"] });
  const rec = r.split("## Recommendation\n")[1]!.split("\n")[0]!;
  assert.doesNotMatch(rec, RECOMMEND_COND);
});

test("denyReason: a table-only defect has no template and stays within 600 characters", () => {
  const r = denyReason("A", {
    path: "/tmp/x/ukagai/explain.md",
    question: "Q",
    missing: [MISSING_LABELS.table],
    codes: ["table"],
  });
  assert.doesNotMatch(r, /ukagai: 1\n/);
  assert.doesNotMatch(r, /```/);
  assert.match(r, /The full format is in skill ukagai-explain/);
  assert.ok(r.length <= 600);
});

test("denyReason: a blocker defect gives a template with the fixed 3 labels and the table header", () => {
  const r = denyReason("A", {
    path: "/tmp/x/ukagai/explain.md",
    question: "Did you authenticate?",
    missing: [MISSING_LABELS.table],
    codes: ["table"],
    blocker: true,
  });
  assert.match(r, /type: blocker/);
  assert.match(r, /question: Did you authenticate\?/);
  assert.match(r, /\| Done\. Continue \|/);
  assert.match(r, /\| Skip this step and continue \|/);
  assert.match(r, /\| Stop here \|/);
  assert.match(r, /\| Option \| What happens if chosen \| Risks and how to undo \|/);
  assert.match(r, new RegExp(`## ${SECTION.blockerWhy[0]}`));
  assert.match(r, new RegExp(`## ${SECTION.blockerTodo[0]}`));
  assert.ok(r.length <= 1200);
});

test("denyReason for a plan: English, no template, mentions ExitPlanMode", () => {
  for (const t of ["A", "B"] as const) {
    const r = denyReason(t, { missing: [MISSING_LABELS.impact] });
    assert.match(r, /ExitPlanMode/);
    assert.match(r, /Scope and reversibility/);
    assert.doesNotMatch(r, /[ぁ-んァ-ン一-龥]/);
  }
});

test("multiDenyReason: has the question count; at most 600 characters; no URL", () => {
  const r = multiDenyReason(3);
  assert.match(r, /this call had 3/);
  assert.ok(r.length <= 600);
  assert.doesNotMatch(r, /https?:|localhost|127\.0\.0\.1|\/api\//);
  assert.doesNotMatch(r, /[ぁ-んァ-ン一-龥]/);
});

test("MISSING_LABELS are English", () => {
  for (const label of Object.values(MISSING_LABELS)) assert.doesNotMatch(label, /[ぁ-んァ-ン一-龥]/);
});

const BLOCKER = `---
ukagai: 1
question: "Q?"
type: blocker
title: Please authenticate
reversibility: reversible
scope: machine
recommended: Done. Continue
---
## Why I stopped
Authentication error.
## What you need to do
1. Run it

\`\`\`sh
gcloud auth login
\`\`\`
## Options
| Option | What happens if chosen | Risks and how to undo |
|---|---|---|
| Done. Continue (Recommended) | a | b |
| Skip this step and continue | a | b |
| Stop here | a | b |
`;

const BLOCKER_OPTION_LABELS = ["Done. Continue (Recommended)", "Skip this step and continue", "Stop here"];

/** The same blocker with the Japanese headings and fixed labels (aliases) */
const BLOCKER_JA = BLOCKER.replace("## Why I stopped", "## なぜ止まったか")
  .replace("## What you need to do", "## 人にしてほしいこと")
  .replace("## Options", "## 選択肢")
  .replace("Done. Continue (Recommended)", "対応した。続けて (Recommended)")
  .replace("Skip this step and continue", "この手順は飛ばして続けて")
  .replace("Stop here", "ここで中断")
  .replace("recommended: Done. Continue", "recommended: 対応した。続けて");

test("BLOCKER_LABELS lists the English label first and the Japanese alias second", () => {
  assert.deepEqual(BLOCKER_OPTION_LABELS.map((l) => l.replace(" (Recommended)", "")), [BLOCKER_FIXED.done[0], BLOCKER_FIXED.skip[0], BLOCKER_FIXED.stop[0]]);
  assert.equal(BLOCKER_FIXED.done[1], "対応した。続けて");
});

test("a blocker needs no recommend / diagram, and its 3 labels can be matched", () => {
  const v = validateExplanation(BLOCKER, "answer_question", BLOCKER_OPTION_LABELS);
  assert.deepEqual(v.missing, []);
  assert.equal(v.valid, true);
});

test("a blocker written with Japanese headings and labels passes", () => {
  const labels = ["対応した。続けて (Recommended)", "この手順は飛ばして続けて", "ここで中断"];
  const v = validateExplanation(BLOCKER_JA, "answer_question", labels);
  assert.deepEqual(v.missing, []);
  assert.equal(v.valid, true);
});

test("mismatched blocker labels are a table defect; a todo without a code block is a todo defect", () => {
  assert.deepEqual(validateExplanation(BLOCKER, "answer_question", [...BLOCKER_OPTION_LABELS, "other"]).missing, ["table"]);
  assert.deepEqual(validateExplanation(BLOCKER.replace(/```sh[\s\S]*?```/, "gcloud auth login")).missing, ["todo"]);
});

test("with type decision, todo is not needed and recommend is required as usual", () => {
  assert.equal(validateExplanation(GOOD.replace("ukagai: 1", "ukagai: 1\ntype: decision")).valid, true);
  assert.deepEqual(validateExplanation(BLOCKER.replace("type: blocker", "type: decision")).missing, ["why", "recommend", "diagram"]);
});

test("Recommendation without a condition (なら / 場合 / とき / if ...) is a recommend_cond defect; blockers are not evaluated", () => {
  const rec = (body: string) => GOOD.replace("I recommend A. If C, choose B.", body);
  assert.deepEqual(validateExplanation(rec("I recommend A.")).missing, ["recommend_cond"]);
  for (const ok of ["C の場合は B。", "速さが要るときは B。", "Use B if C.", "C なら B。", "When C, use B.", "Unless C, use A.", "Otherwise B is fine.", "Pick B in case C happens."]) {
    assert.equal(validateExplanation(rec(ok)).valid, true, ok);
  }
  // false passes fail, a range of phrasings passes
  for (const ng of ["命名規則に合わせなければならないためです。", "ときどき読み返すので。", "I read the diff.", "We shall see in a cased manner.", "守らなければならず、B は避ける。", "A でなければならない。"]) {
    assert.deepEqual(validateExplanation(rec(ng)).missing, ["recommend_cond"], ng);
  }
  for (const ok of ["短さを優先するのであれば log.jsonl が正しくなります。", "保存期間が長い場合は SQLite。", "Choose log.jsonl if brevity matters.", "移行する際は B。", "長さが問題でなければ log.jsonl でも構いません。"]) {
    assert.equal(validateExplanation(rec(ok)).valid, true, ok);
  }
  // words inside code blocks and callouts do not count
  assert.deepEqual(validateExplanation(rec("I recommend A.\n> [!NOTE]\n> If C, choose B.")).missing, ["recommend_cond"]);
  assert.deepEqual(validateExplanation(rec("I recommend A.\n```\nif x\n```")).missing, ["recommend_cond"]);
  // too long and no condition: both, with recommend_long first
  assert.deepEqual(validateExplanation(rec("a".repeat(401))).missing, ["recommend_long", "recommend_cond"]);
  assert.ok(!validateExplanation(BLOCKER, "answer_question", BLOCKER_OPTION_LABELS).missing.includes("recommend_cond"));
});

test("diagram requirement: repo + reversible is optional; costly / machine / external required", () => {
  const noDiagram = GOOD.replace(/## Diagram[\s\S]*?(?=\n## |$)/, "");
  const fm = (rev: string, scope: string) => noDiagram.replace(/reversibility: .*/, `reversibility: ${rev}`).replace(/scope: .*/, `scope: ${scope}`);
  assert.equal(validateExplanation(fm("reversible", "file")).valid, true);
  assert.equal(validateExplanation(fm("reversible", "repo")).valid, true);
  assert.deepEqual(validateExplanation(fm("reversible", "machine")).missing, ["diagram"]);
  assert.deepEqual(validateExplanation(fm("reversible", "external")).missing, ["diagram"]);
  assert.deepEqual(validateExplanation(fm("costly", "file")).missing, ["diagram"]);
  assert.deepEqual(validateExplanation(fm("irreversible", "repo")).missing, ["diagram"]);
  // a Japanese "図" section with Mermaid also satisfies it
  const ja = fm("costly", "file") + "\n## 図\n\n```mermaid\nflowchart LR\n  A --> B\n```\n";
  assert.equal(validateExplanation(ja).valid, true);
});

test("length limits: Recommendation 400 characters / 5 sentences, cells 160 characters, Why 600 characters; full-width and half-width count the same", () => {
  const rec = (body: string) => GOOD.replace("I recommend A. If C, choose B.", body);
  assert.equal(validateExplanation(rec("if " + "a".repeat(397))).valid, true);
  assert.deepEqual(validateExplanation(rec("if " + "a".repeat(398))).missing, ["recommend_long"]);
  assert.deepEqual(validateExplanation(rec("if " + "Ａ".repeat(398))).missing, ["recommend_long"]);
  assert.equal(validateExplanation(rec("If so. Two. Three. Four. Five.")).valid, true);
  assert.deepEqual(validateExplanation(rec("If so. Two. Three. Four. Five. Six.")).missing, ["recommend_long"]);
  assert.equal(validateExplanation(rec("Use file.ts and 0.5 if needed.")).valid, true);
  assert.equal(validateExplanation(rec("```\n" + "a".repeat(500) + "\n```\nI recommend A. If C, choose B.")).valid, true);
  assert.deepEqual(validateExplanation(GOOD.replace("| A | a | b |", `| A | ${"a".repeat(161)} | b |`)).missing, ["cell_long"]);
  assert.deepEqual(validateExplanation(GOOD.replace("| A | a | b |", `| A | a | ${"a".repeat(161)} |`)).missing, ["cell_long"]);
  assert.equal(validateExplanation(GOOD.replace("| A | a | b |", `| A | ${"a".repeat(160)} | b |`)).valid, true);
  assert.deepEqual(validateExplanation(GOOD.replace("Reason\n", "a".repeat(601) + "\n")).missing, ["why_long"]);
  assert.equal(validateExplanation(GOOD.replace("Reason\n", "a".repeat(600) + "\n")).valid, true);
});
