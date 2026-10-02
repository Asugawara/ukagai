import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { denyReason, findExplanation, markUsed, validateExplanation, validatePlan } from "../../src/hook/explain.js";
import { tmpDir, writeFile } from "./helpers.js";

const fixDir = fileURLToPath(new URL("../explain-fixtures/", import.meta.url));
const mdFiles = readdirSync(fixDir).filter((f) => f.endsWith(".md"));

test("fixture が 7 つある", () => {
  assert.equal(mdFiles.length, 7);
});

for (const f of mdFiles) {
  test(`fixture ${f} が expected と一致`, () => {
    const md = readFileSync(join(fixDir, f), "utf8");
    const expected = JSON.parse(readFileSync(join(fixDir, f.replace(/\.md$/, ".expected.json")), "utf8"));
    const actual = f.startsWith("plan-") ? validatePlan(md) : validateExplanation(md, "answer_question");
    assert.deepEqual(actual, expected);
  });
}

const GOOD = `---
ukagai: 1
question: "Q?"
reversibility: reversible
scope: file
---
## なぜ今この判断が要るか
理由
## 選択肢の比較
| 案 | 利点 | 欠点 | コスト |
|---|---|---|---|
| A | a | b | c |
| B | a | b | c |
`;

test("reversible + file は図が任意", () => {
  assert.equal(validateExplanation(GOOD).valid, true);
});

test("optionsCount より表の行が少ないと table 不備", () => {
  assert.deepEqual(validateExplanation(GOOD, "answer_question", 3).missing, ["table"]);
});

test("表のセルが - だけだと table 不備", () => {
  const md = GOOD.replace("| B | a | b | c |", "| B | a | - | c |");
  assert.deepEqual(validateExplanation(md).missing, ["table"]);
});

test("front matter が無いと front_matter のみ(question 等は評価しない)+ 図は必須扱い", () => {
  const md = GOOD.replace(/^---[\s\S]*?---\n/, "");
  assert.deepEqual(validateExplanation(md).missing, ["front_matter", "diagram"]);
});

test("コードフェンス内の見出しは節にならない", () => {
  const md = GOOD.replace("理由\n", "```\n## 選択肢の比較\n```\n");
  assert.equal(validateExplanation(md).valid, true);
});

test("validateExplanation(approve_plan) は validatePlan と同じ", () => {
  assert.deepEqual(validateExplanation("# x", "approve_plan").missing, ["impact"]);
});

test("findExplanation: question 完全一致 → recency → null、used は無視", async () => {
  const dir = tmpDir();
  writeFile(join(dir, "a.md"), GOOD);
  writeFile(join(dir, "b.used.md"), GOOD);
  const hit = await findExplanation(dir, "Q?");
  assert.equal(hit?.match, "question");
  assert.equal(hit?.path, join(dir, "a.md"));
  const rec = await findExplanation(dir, "別の質問");
  assert.equal(rec?.match, "recency");
  writeFile(join(dir, "c.md"), GOOD.replace("Q?", "R?"));
  assert.equal(await findExplanation(dir, "別の質問"), null);
  const old = new Date(Date.now() - 11 * 60 * 1000);
  utimesSync(join(dir, "a.md"), old, old);
  utimesSync(join(dir, "c.md"), old, old);
  assert.equal(await findExplanation(dir, "別の質問"), null);
  assert.equal(await findExplanation(join(dir, "none"), "Q?"), null);
});

test("markUsed は .used.md に rename する", async () => {
  const dir = tmpDir();
  writeFile(join(dir, "a.md"), GOOD);
  const used = await markUsed(join(dir, "a.md"));
  assert.equal(used, join(dir, "a.used.md"));
  assert.deepEqual(readdirSync(dir), ["a.used.md"]);
});

test("denyReason: 保存先・question 原文・足りない項目を含み 600 文字以内、URL なし", () => {
  for (const t of ["A", "B"] as const) {
    const r = denyReason(t, { path: "/tmp/x/ukagai/explain.md", question: "どちらにしますか？", missing: ["a", "b"] });
    assert.match(r, /\/tmp\/x\/ukagai\/explain\.md/);
    assert.match(r, /どちらにしますか？/);
    assert.match(r, /a、b/);
    assert.ok(r.length <= 600);
    assert.doesNotMatch(r, /https?:|localhost|127\.0\.0\.1|\/api\//);
  }
  const many = Array.from({ length: 80 }, (_, i) => `項目${i}`);
  const long = denyReason("A", { path: "/p/ukagai/explain.md", question: "Q", missing: many });
  assert.ok(long.length <= 600);
  assert.match(long, /…ほか \d+ 件/);
});
