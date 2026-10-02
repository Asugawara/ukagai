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
  parseBullets,
  parseFootnotes,
  parseTerms,
  findTables,
  scanFences,
  UNDO_BAD_WORDS,
  UNDO_WORDS,
  parsePlanImpact,
} from "../../src/hook/explain.js";
import { tmpDir, writeFile } from "./helpers.js";

const fixDir = fileURLToPath(new URL("../explain-fixtures/", import.meta.url));
const mdFiles = readdirSync(fixDir).filter((f) => f.endsWith(".md"));

test("there are 25 fixtures", () => {
  assert.equal(mdFiles.length, 25);
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
| A | a | Revert it |
| B | a | Revert it |
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
  const bad = GOOD.replace("## Recommendation\n", "## Recommended options\n").replace("| B | a | Revert it |", "| B | a | - |");
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
  const md = GOOD.replace("| B | a | Revert it |", "| B | a | - |");
  assert.deepEqual(validateExplanation(md).missing, ["table"]);
});

test("without front matter only front_matter is reported (question etc. are not evaluated), and a diagram is required", () => {
  const md = GOOD.replace(/^---[\s\S]*?---\n/, "");
  assert.deepEqual(validateExplanation(md).missing, ["front_matter", "diagram", "checked"]);
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

test("denyReason: has the save path, the verbatim question and the missing items; at most 1000 characters; no URL", () => {
  for (const t of ["A", "B"] as const) {
    const r = denyReason(t, { path: "/tmp/x/ukagai/explain.md", question: "Which one?", missing: ["a", "b"] });
    assert.match(r, /\/tmp\/x\/ukagai\/explain\.md/);
    assert.match(r, /Which one\?/);
    assert.match(r, /a; b/);
    assert.ok(r.length <= 1000);
    assert.doesNotMatch(r, /https?:|localhost|127\.0\.0\.1|\/api\//);
  }
  const many = Array.from({ length: 80 }, (_, i) => `item${i}`);
  const long = denyReason("A", { path: "/p/ukagai/explain.md", question: "Q", missing: many });
  assert.ok(long.length <= 1000);
  assert.match(long, /\.\.\. and \d+ more/);
});

test("denyReason: no file / missing front matter gives the minimal template (ukagai: 1, the real question, English headings, save path) within 1600 characters", () => {
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
      assert.ok(r.length <= 1600);
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

test("denyReason: a table-only defect has no template and stays within 1000 characters", () => {
  const r = denyReason("A", {
    path: "/tmp/x/ukagai/explain.md",
    question: "Q",
    missing: [MISSING_LABELS.table],
    codes: ["table"],
  });
  assert.doesNotMatch(r, /ukagai: 1\n/);
  assert.doesNotMatch(r, /```/);
  assert.match(r, /The full format is in skill ukagai-explain/);
  assert.ok(r.length <= 1000);
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
  assert.ok(r.length <= 1600);
});

test("denyReason for a plan: English, no template, mentions ExitPlanMode", () => {
  for (const t of ["A", "B"] as const) {
    const r = denyReason(t, { missing: [MISSING_LABELS.impact] });
    assert.match(r, /ExitPlanMode/);
    assert.match(r, /Scope and reversibility/);
    assert.doesNotMatch(r, /[ぁ-んァ-ン一-龥]/);
  }
});

test("multiDenyReason: has the question count; at most 1000 characters; no URL", () => {
  const r = multiDenyReason(3);
  assert.match(r, /this call had 3/);
  assert.ok(r.length <= 1000);
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
| Done. Continue (Recommended) | a | Revert it |
| Skip this step and continue | a | Revert it |
| Stop here | a | Revert it |
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
  assert.deepEqual(validateExplanation(BLOCKER.replace("type: blocker", "type: decision")).missing, ["why", "recommend", "diagram", "checked"]);
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
  const noDiagram = GOOD.replace(/## Diagram[\s\S]*?(?=\n## |$)/, "") + "## What I checked\n- read the code\n";
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
  assert.deepEqual(validateExplanation(GOOD.replace("| A | a | Revert it |", `| A | ${"a".repeat(161)} | Revert it |`)).missing, ["cell_long"]);
  assert.deepEqual(validateExplanation(GOOD.replace("| A | a | Revert it |", `| A | a | Revert ${"a".repeat(154)} |`)).missing, ["cell_long"]);
  assert.equal(validateExplanation(GOOD.replace("| A | a | Revert it |", `| A | ${"a".repeat(160)} | Revert it |`)).valid, true);
  assert.deepEqual(validateExplanation(GOOD.replace("Reason\n", "a".repeat(601) + "\n")).missing, ["why_long"]);
  assert.equal(validateExplanation(GOOD.replace("Reason\n", "a".repeat(600) + "\n")).valid, true);
});

// ---- rich sections (M1) ----

test("parseTerms: bold + dash, bold + colon, plain + dash, plain + colon; items without a separator are skipped", () => {
  const md = `## Terms

- **SSE** — one-way streaming over HTTP.
- **long-poll**: a request held open.
- **ping:** keeps a connection alive.
- plain term — plain definition
- other: other definition
- no separator here
- **only term**
\`\`\`
- **in fence** — ignored
\`\`\`
## Next
- **after** — ignored
`;
  assert.deepEqual(parseTerms(md), [
    { term: "SSE", definition: "one-way streaming over HTTP." },
    { term: "long-poll", definition: "a request held open." },
    { term: "ping", definition: "keeps a connection alive." },
    { term: "plain term", definition: "plain definition" },
    { term: "other", definition: "other definition" },
  ]);
  assert.deepEqual(parseTerms("## 用語\n- **用語A** — 説明。\n"), [{ term: "用語A", definition: "説明。" }]);
  assert.deepEqual(parseTerms("no section"), []);
});

test("parseBullets: marker removed, continuation joined, other sections and fences ignored, Japanese alias", () => {
  const md = `---
ukagai: 1
---
## What only you know
- First
  continued
* Second
1. Third
Plain line
## Assumptions
- Other
`;
  assert.deepEqual(parseBullets(md, SECTION.unknowns), ["First continued", "Second", "Third"]);
  assert.deepEqual(parseBullets(md, SECTION.assumptions), ["Other"]);
  assert.deepEqual(parseBullets(md, SECTION.against), []);
  assert.deepEqual(parseBullets("## あなたにしか分からないこと\n- 好み\n", SECTION.unknowns), ["好み"]);
});

test("parseFootnotes: refs and defs; a ref without a def is detected; defs only is fine; code and fences are ignored", () => {
  const md = `Body[^1] and again[^1] with [^b]. \`[^code]\`
| cell[^t] |
## What I checked
[^1]: evidence one
  continued
[^b]: evidence b
\`\`\`
[^fence]
\`\`\`
`;
  const n = parseFootnotes(md);
  assert.deepEqual(n.refs, ["1", "b", "t"]);
  assert.deepEqual(n.defs, [
    { id: "1", text: "evidence one continued" },
    { id: "b", text: "evidence b" },
  ]);
  assert.deepEqual(parseFootnotes("text\n[^x]: only a def\n"), { defs: [{ id: "x", text: "only a def" }], refs: [] });
});

test("footnote: a ref without a definition is a footnote defect; a definition without a ref passes", () => {
  const base = GOOD.replace("Reason", "Reason[^1]");
  assert.deepEqual(validateExplanation(base).missing, ["footnote"]);
  assert.equal(validateExplanation(base + "## What I checked\n[^1]: grep output\n").valid, true);
  assert.equal(validateExplanation(GOOD + "## What I checked\n[^9]: unused\n").valid, true);
  // blockers are not evaluated
  assert.ok(!validateExplanation(BLOCKER.replace("Authentication error.", "Authentication error.[^1]"), "answer_question", BLOCKER_OPTION_LABELS).missing.includes("footnote"));
});

test("undo: every risk cell needs an undo word (or says it cannot be undone); English and Japanese", () => {
  const risk = (cell: string) => GOOD.replace("| B | a | Revert it |", `| B | a | ${cell} |`);
  assert.deepEqual(validateExplanation(risk("Slow.")).missing, ["undo"]);
  for (const ok of ["Undo with git", "revert the commit", "Roll back", "rollback", "restore from .bak", "reinstall it", "delete the file", "remove the entry", "It cannot be undone", "Irreversible", "戻すには git revert", "消せる", "やり直せる", "再実行する", "元に戻らない", "戻せない"]) {
    assert.equal(validateExplanation(risk(ok)).valid, true, ok);
  }
  assert.ok(UNDO_WORDS.test("UNDO"));
  // Japanese columns work too
  assert.equal(validateExplanation(GOOD_JA).valid, true);
  assert.deepEqual(validateExplanation(GOOD_JA.replace("| B | a | Revert it |", "| B | a | 遅い |")).missing, ["undo"]);
  // a table defect is reported alone, without undo
  assert.deepEqual(validateExplanation(GOOD.replace("| B | a | Revert it |", "| B | a | - |")).missing, ["table"]);
});

test("undo in a blocker: the fixed 3 labels are exempt, other rows are checked", () => {
  assert.equal(validateExplanation(BLOCKER, "answer_question", BLOCKER_OPTION_LABELS).valid, true);
  assert.equal(validateExplanation(BLOCKER_JA, "answer_question", ["対応した。続けて (Recommended)", "この手順は飛ばして続けて", "ここで中断"]).valid, true);
  const extra = BLOCKER + "| Retry later | a | slow |\n";
  assert.deepEqual(validateExplanation(extra).missing, ["undo"]);
});

test("checked: required unless reversible + file; blockers are exempt; order of the codes", () => {
  const withMeta = (rev: string, scope: string) => GOOD.replace(/reversibility: .*/, `reversibility: ${rev}`).replace(/scope: .*/, `scope: ${scope}`);
  assert.equal(validateExplanation(GOOD).valid, true);
  assert.deepEqual(validateExplanation(withMeta("reversible", "repo")).missing, ["checked"]);
  assert.deepEqual(validateExplanation(withMeta("costly", "file")).missing, ["diagram", "checked"]);
  assert.equal(validateExplanation(withMeta("reversible", "repo") + "## 確かめたこと\n- 読んだ\n").valid, true);
  assert.deepEqual(validateExplanation(withMeta("reversible", "repo") + "## What I checked\n\n").missing, ["checked"]);
  assert.ok(!validateExplanation(BLOCKER, "answer_question", BLOCKER_OPTION_LABELS).missing.includes("checked"));
  // order: cell_long, undo, ..., diagram, checked, footnote
  const all = withMeta("costly", "machine")
    .replace("| A | a | Revert it |", `| A | ${"a".repeat(161)} | slow |`)
    .replace("Reason", "Reason[^1]");
  assert.deepEqual(validateExplanation(all).missing, ["cell_long", "undo", "diagram", "checked", "footnote"]);
});

test("findTables: extraColumns lists the columns besides the label, happens and risk", () => {
  const lines = toLines(`| Option | What happens if chosen | Risks and how to undo | Cost | Effort |
|---|---|---|---|---|
| A | a | b | c | d |
`);
  const t = findTables(lines, scanFences(lines).inFence, 0, lines.length)[0]!;
  assert.deepEqual(t.extraColumns, [3, 4]);
  const lines3 = toLines("| 選択肢 | 選ぶと起きること | リスクと戻し方 |\n|---|---|---|\n| A | a | b |\n");
  assert.deepEqual(findTables(lines3, scanFences(lines3).inFence, 0, lines3.length)[0]!.extraColumns, []);
  // columns in any order
  const lines4 = toLines("| Option | Cost | Risk | Outcome |\n|---|---|---|---|\n| A | a | b | c |\n");
  assert.deepEqual(findTables(lines4, scanFences(lines4).inFence, 0, lines4.length)[0]!.extraColumns, [1]);
});

test("a 4-column table passes validation", () => {
  const md = GOOD.replace("| Option | What happens if chosen | Risks and how to undo |\n|---|---|---|", "| Option | What happens if chosen | Risks and how to undo | Cost |\n|---|---|---|---|")
    .replace("| A | a | Revert it |", "| A | a | Revert it | 1d |")
    .replace("| B | a | Revert it |", "| B | a | Revert it | 2d |");
  assert.equal(validateExplanation(md).valid, true);
});

test("the new section names are in SECTION with an English name first and a Japanese alias", () => {
  for (const k of ["terms", "unknowns", "assumptions", "against", "affects"] as const) {
    assert.equal(SECTION[k].length, 2);
    assert.doesNotMatch(SECTION[k][0], /[ぁ-んァ-ン一-龥]/);
    assert.match(SECTION[k][1], /[ぁ-んァ-ン一-龥]/);
  }
});

test("denyReason template: has What only you know, Assumptions and What I checked; optional sections are not in it", () => {
  const r = denyReason("A", { path: "/p/ukagai/explain.md", question: "Q", missing: ["x"], codes: ["file"] });
  assert.match(r, /## What only you know/);
  assert.match(r, /## Assumptions/);
  assert.match(r, /## What I checked/);
  assert.doesNotMatch(r, /## (Terms|Counterargument|Affected)/);
  assert.ok(r.length <= 1600);
  const rec = r.split("## Assumptions")[1]!.split("\n")[0]!;
  assert.doesNotMatch(rec, RECOMMEND_COND);
});

test("undo vocabulary: bad words pass, undo words pass, 'gone' fails", () => {
  const risk = (cell: string) => GOOD.replace("| B | a | Revert it |", `| B | a | ${cell} |`);
  assert.equal(validateExplanation(risk("The history cannot be restored.")).valid, true);
  assert.equal(validateExplanation(risk("To undo, restore from git.")).valid, true);
  assert.deepEqual(validateExplanation(risk("The data is gone.")).missing, ["undo"]);
  assert.ok(UNDO_BAD_WORDS.test("it cannot be restored"));
  assert.ok(!UNDO_BAD_WORDS.test("restore from git"));
});

test("against_weak: a Counterargument inside the Recommendation is flagged; a real one is not", () => {
  const withAgainst = (t: string) => GOOD + `## Counterargument\n${t}\n`;
  assert.deepEqual(validateExplanation(withAgainst("If C, choose B!")).missing, ["against_weak"]);
  assert.equal(validateExplanation(withAgainst("B avoids the lock-in that A creates.")).valid, true);
  assert.equal(validateExplanation(GOOD).valid, true);
});

test("parsePlanImpact: reads Reversibility / Scope in several shapes, ignores unknown values", () => {
  const plan = (body: string) => `# Plan\n\n## Scope and reversibility\n${body}\n`;
  assert.deepEqual(parsePlanImpact(plan("- Reversibility: costly\n- Scope: repo")), { reversibility: "costly", scope: "repo" });
  assert.deepEqual(parsePlanImpact(plan("reversibility: irreversible\nscope: external")), { reversibility: "irreversible", scope: "external" });
  assert.deepEqual(parsePlanImpact(plan("可逆性: reversible\n影響範囲: file")), { reversibility: "reversible", scope: "file" });
  assert.deepEqual(parsePlanImpact(plan("Reversibility: maybe\nOne file.")), {});
  assert.deepEqual(parsePlanImpact("# Plan\nReversibility: costly\n"), {});
});
