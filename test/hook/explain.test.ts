import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  denyReason,
  MISSING_LABELS,
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

test("fixture が 17 ある", () => {
  assert.equal(mdFiles.length, 17);
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

test("denyReason: ファイル無し / front_matter 欠けは最小テンプレート(ukagai: 1・実際の質問文・節見出し・保存先)を含み 1200 文字以内", () => {
  for (const t of ["A", "B"] as const) {
    for (const codes of [["file"], ["front_matter", "question"]] as const) {
      const r = denyReason(t, {
        path: "/tmp/x/ukagai/explain.md",
        question: "どちらにしますか？",
        missing: codes.map((c) => MISSING_LABELS[c]),
        codes: [...codes],
      });
      assert.match(r, /^まず skill ukagai-explain を読/);
      assert.match(r, /ukagai: 1/);
      assert.match(r, /question: どちらにしますか？/);
      assert.match(r, /## 選択肢/);
      assert.match(r, /\/tmp\/x\/ukagai\/explain\.md/);
      assert.match(r, /skill ukagai-explain/);
      assert.ok(r.length <= 1200);
      assert.doesNotMatch(r, /https?:|localhost|127\.0\.0\.1|\/api\//);
    }
  }
});

test("denyReason: table だけ欠けのときはテンプレートを含めず 600 文字以内", () => {
  const r = denyReason("A", {
    path: "/tmp/x/ukagai/explain.md",
    question: "Q",
    missing: [MISSING_LABELS.table],
    codes: ["table"],
  });
  assert.doesNotMatch(r, /ukagai: 1\n/);
  assert.doesNotMatch(r, /```/);
  assert.match(r, /書式の全体は skill ukagai-explain/);
  assert.ok(r.length <= 600);
});

test("denyReason: blocker の欠けは固定 3 ラベルの表の見出し付きテンプレートを出す", () => {
  const r = denyReason("A", {
    path: "/tmp/x/ukagai/explain.md",
    question: "認証できましたか？",
    missing: [MISSING_LABELS.table],
    codes: ["table"],
    blocker: true,
  });
  assert.match(r, /type: blocker/);
  assert.match(r, /question: 認証できましたか？/);
  assert.match(r, /\| 対応した。続けて \|/);
  assert.match(r, /\| この手順は飛ばして続けて \|/);
  assert.match(r, /\| ここで中断 \|/);
  assert.match(r, /\| 選択肢 \| 選ぶと起きること \| リスクと戻し方 \|/);
  assert.ok(r.length <= 1200);
});

test("multiDenyReason: 問数を含み 600 文字以内、URL なし", () => {
  const r = multiDenyReason(3);
  assert.match(r, /今回は 3 問/);
  assert.ok(r.length <= 600);
  assert.doesNotMatch(r, /https?:|localhost|127\.0\.0\.1|\/api\//);
});

const BLOCKER = `---
ukagai: 1
question: "Q?"
type: blocker
title: 認証してほしい
reversibility: reversible
scope: machine
recommended: 対応した。続けて
---
## なぜ止まったか
認証エラー。
## 人にしてほしいこと
1. 実行する

\`\`\`sh
gcloud auth login
\`\`\`
## 選択肢
| 案 | 選ぶと起きること | リスクと戻し方 |
|---|---|---|
| 対応した。続けて (Recommended) | a | b |
| この手順は飛ばして続けて | a | b |
| ここで中断 | a | b |
`;

const BLOCKER_LABELS = ["対応した。続けて (Recommended)", "この手順は飛ばして続けて", "ここで中断"];

test("blocker は recommend / diagram を要求せず、3 ラベルを照合できる", () => {
  const v = validateExplanation(BLOCKER, "answer_question", BLOCKER_LABELS);
  assert.deepEqual(v.missing, []);
  assert.equal(v.valid, true);
});

test("blocker のラベルが揃わないと table 不備、todo のコードブロックが無いと todo 不備", () => {
  assert.deepEqual(validateExplanation(BLOCKER, "answer_question", [...BLOCKER_LABELS, "別"]).missing, ["table"]);
  assert.deepEqual(validateExplanation(BLOCKER.replace(/```sh[\s\S]*?```/, "gcloud auth login")).missing, ["todo"]);
});

test("type が decision なら todo は要らず、従来どおり recommend が要る", () => {
  assert.equal(validateExplanation(GOOD.replace("ukagai: 1", "ukagai: 1\ntype: decision")).valid, true);
  assert.deepEqual(validateExplanation(BLOCKER.replace("type: blocker", "type: decision")).missing, ["why", "recommend", "diagram"]);
});

test("推奨に条件(なら / 場合 / とき / if )が無いと recommend_cond。blocker では評価しない", () => {
  const rec = (body: string) => GOOD.replace("A を推す。C なら B。", body);
  assert.deepEqual(validateExplanation(rec("A を推す。")).missing, ["recommend_cond"]);
  for (const ok of ["C の場合は B。", "速さが要るときは B。", "Use B if C.", "C なら B。"]) {
    assert.equal(validateExplanation(rec(ok)).valid, true, ok);
  }
  // Q2-03: 誤通過は落ち、言い回しの幅は通る
  for (const ng of ["命名規則に合わせなければならないためです。", "ときどき読み返すので。", "diff を見るので。", "守らなければならず、B は避ける。", "A でなければならない。"]) {
    assert.deepEqual(validateExplanation(rec(ng)).missing, ["recommend_cond"], ng);
  }
  for (const ok of ["短さを優先するのであれば log.jsonl が正しくなります。", "保存期間が長い場合は SQLite。", "Choose log.jsonl if brevity matters.", "移行する際は B。", "When C, use B.", "Unless C, use A.", "長さが問題でなければ log.jsonl でも構いません。"]) {
    assert.equal(validateExplanation(rec(ok)).valid, true, ok);
  }
  // コードブロックと callout の中の語は数えない
  assert.deepEqual(validateExplanation(rec("A を推す。\n> [!NOTE]\n> C なら B。")).missing, ["recommend_cond"]);
  assert.deepEqual(validateExplanation(rec("A を推す。\n```\nif x\n```")).missing, ["recommend_cond"]);
  // 長すぎて条件も無いときは両方、順序は recommend_long の直後
  assert.deepEqual(validateExplanation(rec("あ".repeat(401))).missing, ["recommend_long", "recommend_cond"]);
  assert.ok(!validateExplanation(BLOCKER, "answer_question", BLOCKER_LABELS).missing.includes("recommend_cond"));
});

test("図の必須条件: repo + reversible は任意、costly / machine / external は必須", () => {
  const noDiagram = GOOD.replace(/## 図[\s\S]*?(?=\n## |$)/, "");
  const fm = (rev: string, scope: string) => noDiagram.replace(/reversibility: .*/, `reversibility: ${rev}`).replace(/scope: .*/, `scope: ${scope}`);
  assert.equal(validateExplanation(fm("reversible", "file")).valid, true);
  assert.equal(validateExplanation(fm("reversible", "repo")).valid, true);
  assert.deepEqual(validateExplanation(fm("reversible", "machine")).missing, ["diagram"]);
  assert.deepEqual(validateExplanation(fm("reversible", "external")).missing, ["diagram"]);
  assert.deepEqual(validateExplanation(fm("costly", "file")).missing, ["diagram"]);
  assert.deepEqual(validateExplanation(fm("irreversible", "repo")).missing, ["diagram"]);
});

test("長さの上限: 推奨は 400 文字 / 5 文、セルは 160 文字、なぜは 600 文字。全角半角は同じ 1 文字", () => {
  const rec = (body: string) => GOOD.replace("A を推す。C なら B。", body);
  assert.equal(validateExplanation(rec("なら" + "あ".repeat(398))).valid, true);
  assert.deepEqual(validateExplanation(rec("なら" + "あ".repeat(399))).missing, ["recommend_long"]);
  assert.deepEqual(validateExplanation(rec("なら" + "Ａ".repeat(399))).missing, ["recommend_long"]);
  assert.equal(validateExplanation(rec("なら。二。三。四。五。")).valid, true);
  assert.deepEqual(validateExplanation(rec("なら。二。三。四。五。六。")).missing, ["recommend_long"]);
  assert.equal(validateExplanation(rec("file.ts と 0.5 を使う場合。")).valid, true);
  assert.equal(validateExplanation(rec("```\n" + "あ".repeat(500) + "\n```\nA を推す。C なら B。")).valid, true);
  assert.deepEqual(validateExplanation(GOOD.replace("| A | a | b |", `| A | ${"あ".repeat(161)} | b |`)).missing, ["cell_long"]);
  assert.deepEqual(validateExplanation(GOOD.replace("| A | a | b |", `| A | a | ${"あ".repeat(161)} |`)).missing, ["cell_long"]);
  assert.equal(validateExplanation(GOOD.replace("| A | a | b |", `| A | ${"あ".repeat(160)} | b |`)).valid, true);
  assert.deepEqual(validateExplanation(GOOD.replace("理由\n", "あ".repeat(601) + "\n")).missing, ["why_long"]);
  assert.equal(validateExplanation(GOOD.replace("理由\n", "あ".repeat(600) + "\n")).valid, true);
});
