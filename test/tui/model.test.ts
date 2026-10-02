import { test } from "node:test";
import assert from "node:assert/strict";
import { buildModel } from "../../src/tui/model.js";
import { V2_MD, blockerDecision, decision, withExplanation } from "./helpers.js";

test("v2: title / chips / 推奨 / カード / 背景節", () => {
  const m = buildModel(decision(withExplanation(V2_MD)));
  assert.equal(m.kind, "question");
  assert.equal(m.title, "GUI の更新通知を SSE と WebSocket のどちらにするか");
  assert.deepEqual(m.chips.map((c) => `${c.kind}:${c.text}`), ["repo:◈ ukagai", "branch:⎇ feat/tui", "worktree:⧉ feat-tui"]);
  assert.equal(m.reversibility, "costly");
  assert.equal(m.scope, "repo");
  assert.match(m.recommendation ?? "", /SSE を推します/);
  const q = m.question!;
  assert.ok(q.v2);
  assert.deepEqual(q.cards.map((c) => [c.value, c.label, c.recommended]), [
    ["SSE (Recommended)", "SSE", true],
    ["WebSocket", "WebSocket", false],
  ]);
  assert.equal(q.initialCursor, 0);
  assert.equal(q.cards[0]!.lines[1]!.risk, true);
  // 背景には選択肢・推奨が入らない
  assert.match(m.background!, /なぜ今この判断が要るか/);
  assert.match(m.background!, /図/);
  assert.match(m.background!, /確かめたこと/);
  assert.doesNotMatch(m.background!, /選ぶと起きること/);
  assert.doesNotMatch(m.background!, /SSE を推します/);
});

test("v2: 表に無い選択肢は生の description で補い、(Recommended) 接尾辞の選択肢に初期カーソル", () => {
  const md = V2_MD.replace("| SSE | server から GUI への一方向配信になる。 | **双方向**にしたくなったら書き直す(約 1 日)。 |\n", "").replace("recommended: SSE", "recommended: 存在しない");
  const q = buildModel(decision(withExplanation(md))).question!;
  assert.deepEqual(q.cards.map((c) => c.value), ["WebSocket", "SSE (Recommended)"]);
  assert.deepEqual(q.cards[1]!.lines, [{ text: "一方向", md: false }]);
  assert.equal(q.initialCursor, 1);
});

test("旧形式(表が無い説明)は背景に本文全体、選択肢は生のラベル", () => {
  const md = "---\nukagai: 1\nquestion: q\ntitle: 旧形式の題\n---\n\n## なぜ今\n\n理由です。\n";
  const m = buildModel(decision(withExplanation(md)));
  assert.equal(m.title, "旧形式の題");
  assert.ok(!m.question!.v2);
  assert.match(m.background!, /理由です/);
  assert.deepEqual(m.question!.cards.map((c) => c.label), ["SSE", "WebSocket"]);
  assert.equal(m.recommendation, null);
});

test("説明なし: 生の質問と選択肢、理由の一文", () => {
  const m = buildModel(
    decision({ explanation: { path: "", markdown: "", has: { mermaid: false, table: false, diff: false }, match: "recency", attached_via: "none", none_reason: "plan_mode" } } as never),
  );
  assert.equal(m.hasExplanation, false);
  assert.equal(m.title, "通知は SSE と WebSocket のどちらにしますか？");
  assert.match(m.backgroundNote ?? "", /説明を書きませんでした\(理由: plan_mode\)/);
  assert.equal(m.question!.cards[0]!.lines[0]!.text, "一方向");
});

test("計画: 本文が背景、題は先頭の見出し", () => {
  const d = decision({
    kind: "approve_plan",
    request: { plan: "# 計画の題\n\n## 影響範囲と可逆性\n\n小さい。", planFilePath: "/p.md" },
  } as never);
  const m = buildModel(d);
  assert.equal(m.kind, "plan");
  assert.equal(m.title, "計画の題");
  assert.match(m.background!, /影響範囲と可逆性/);
  assert.equal(m.question, undefined);
});

test("worktree 以外の cwd は末尾だけを repo に", () => {
  const m = buildModel(decision({ session: { session_id: "s", cwd: "/Users/a/dev/ukagai", transcript_path: "/x" }, context: {} } as never));
  assert.deepEqual(m.chips.map((c) => c.text), ["◈ ukagai"]);
  assert.equal(m.cwd, "~/dev/ukagai");
});

test("blocker: todo は背景から外れ、コードブロックを取り出す。初期カーソルは「対応した。続けて」", () => {
  const m = buildModel(blockerDecision());
  assert.equal(m.blocker, true);
  assert.match(m.todo ?? "", /ターミナルで次を実行/);
  assert.deepEqual(m.todoCode, ["gcloud auth login\ngcloud auth application-default login"]);
  assert.match(m.background ?? "", /なぜ止まったか/);
  assert.doesNotMatch(m.background ?? "", /人にしてほしいこと/);
  assert.equal(m.recommendation, null);
  const q = m.question!;
  assert.deepEqual(q.cards.map((c) => c.label), ["対応した。続けて", "この手順は飛ばして続けて", "ここで中断"]);
  assert.equal(q.initialCursor, 0);
});

test("blocker: front matter の type だけでも blocker(explanation.type が無いとき)", () => {
  const base = blockerDecision();
  const m = buildModel({ ...base, explanation: { ...base.explanation!, type: undefined } });
  assert.equal(m.blocker, true);
});

test("decision は blocker ではない", () => {
  const m = buildModel(decision(withExplanation(V2_MD)));
  assert.equal(m.blocker, false);
  assert.equal(m.todo, null);
  assert.deepEqual(m.todoCode, []);
});
