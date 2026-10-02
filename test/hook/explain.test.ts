import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  denyReason,
  multiDenyReason,
  findExplanation,
  markUsed,
  normalizeLabel,
  validateExplanation,
  validatePlan,
} from "../../src/hook/explain.js";
import { tmpDir, writeFile } from "./helpers.js";

const fixDir = fileURLToPath(new URL("../explain-fixtures/", import.meta.url));
const mdFiles = readdirSync(fixDir).filter((f) => f.endsWith(".md"));

test("fixture が 10 ある", () => {
  assert.equal(mdFiles.length, 10);
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
title: A と B のどちらにするか
reversibility: reversible
scope: file
recommended: A
---
## なぜ今この判断が要るか
理由
## 選択肢
| 案 | 選ぶと起きること | リスクと戻し方 |
|---|---|---|
| A | a | b |
| B | a | b |
## 推奨
A を推す。C なら B。
`;

test("reversible + file は図が任意", () => {
  assert.equal(validateExplanation(GOOD).valid, true);
});

test("labels が揃わない(行が足りない / 先頭セルが合わない)と table 不備", () => {
  assert.deepEqual(validateExplanation(GOOD, "answer_question", ["A", "B", "C"]).missing, ["table"]);
  assert.deepEqual(validateExplanation(GOOD, "answer_question", ["A", "X"]).missing, ["table"]);
  assert.equal(validateExplanation(GOOD, "answer_question", ["A", "B"]).valid, true);
});

test("recommended が options に無いと recommended 不備、(Recommended) 付きは照合が通る", () => {
  assert.deepEqual(validateExplanation(GOOD.replace("recommended: A", "recommended: Z"), "answer_question", ["A", "B"]).missing, ["recommended"]);
  assert.deepEqual(validateExplanation(GOOD.replace("recommended: A\n", "")).missing, ["recommended"]);
  assert.equal(validateExplanation(GOOD.replace("recommended: A", "recommended: A"), "answer_question", ["A (Recommended)", "B"]).valid, true);
  const md = GOOD.replace("recommended: A", "recommended: a（推奨）").replace("| A |", "| A (Recommended) |");
  assert.equal(validateExplanation(md, "answer_question", ["A", "B"]).valid, true);
});

test("title が無いと title 不備、旧列の表は table 不備、推奨の節が無いと recommend 不備", () => {
  assert.deepEqual(validateExplanation(GOOD.replace(/title: .*\n/, "")).missing, ["title"]);
  assert.deepEqual(validateExplanation(GOOD.replace("選ぶと起きること", "利点").replace("リスクと戻し方", "欠点")).missing, ["table"]);
  assert.deepEqual(validateExplanation(GOOD.replace("## 推奨\nA を推す。C なら B。\n", "")).missing, ["recommend"]);
});

test("旧見出し「選択肢の比較」も部分一致で通る", () => {
  assert.equal(validateExplanation(GOOD.replace("## 選択肢", "## 選択肢の比較")).valid, true);
});

test("findSection は完全一致を優先する(「推奨する選択肢」の後の「選択肢」を取る)", () => {
  const md = GOOD.replace("## 選択肢\n", "## 推奨する選択肢\nこの節に表は無い\n## 選択肢\n");
  assert.equal(validateExplanation(md).valid, true);
  const bad = GOOD.replace("## 推奨\n", "## 推奨する選択肢\n").replace("## 選択肢\n", "## 選択肢\n").replace("| B | a | b |", "| B | a | - |");
  assert.ok(validateExplanation(bad).missing.includes("table"));
});

test("normalizeLabel: NFKC・接尾辞除去・空白削除・小文字化", () => {
  assert.equal(normalizeLabel("SSE (Recommended)"), "sse");
  assert.equal(normalizeLabel("ＳＳＥ（Recommended）"), "sse");
  assert.equal(normalizeLabel("退避して 削除　(推奨)"), "退避して削除".replace(/\s/g, ""));
  assert.equal(normalizeLabel("退避して削除（推奨）"), "退避して削除");
  assert.equal(normalizeLabel("Node Test"), "nodetest");
  assert.equal(normalizeLabel("A (Recommended) B"), "a(recommended)b");
});

test("表のセルが - だけだと table 不備", () => {
  const md = GOOD.replace("| B | a | b |", "| B | a | - |");
  assert.deepEqual(validateExplanation(md).missing, ["table"]);
});

test("front matter が無いと front_matter のみ(question 等は評価しない)+ 図は必須扱い", () => {
  const md = GOOD.replace(/^---[\s\S]*?---\n/, "");
  assert.deepEqual(validateExplanation(md).missing, ["front_matter", "diagram"]);
});

test("コードフェンス内の見出しは節にならない", () => {
  const md = GOOD.replace("理由\n", "```\n## 選択肢\n```\n");
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

test("multiDenyReason: 問数を含み 600 文字以内、URL なし", () => {
  const r = multiDenyReason(3);
  assert.match(r, /今回は 3 問/);
  assert.ok(r.length <= 600);
  assert.doesNotMatch(r, /https?:|localhost|127\.0\.0\.1|\/api\//);
});
