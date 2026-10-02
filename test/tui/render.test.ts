import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../../src/tui/app.js";
import { buildModel } from "../../src/tui/model.js";
import { render, renderFrame, type View } from "../../src/tui/render.js";
import { stripAnsi, width } from "../../src/tui/width.js";
import { V2_MD, blockerDecision, decision, withExplanation } from "./helpers.js";

const NOW = Date.parse("2026-10-02T00:00:30.000Z");
function viewOf(d = decision(withExplanation(V2_MD))): View {
  const app = new App();
  app.upsert(d, NOW);
  return app.view(NOW);
}

test("140x40: 見出し・chips・推奨・カード・背景・ヒント・状態行", () => {
  const out = stripAnsi(render(viewOf(), { cols: 140, rows: 40 }));
  const lines = out.split("\n");
  assert.equal(lines.length, 40);
  for (const s of [
    "◈ ukagai", "⎇ feat/tui", "⧉ feat-tui", "戻すのにコストがかかる", "repo",
    "GUI の更新通知を SSE と WebSocket のどちらにするか",
    "なぜ今この判断が要るか", "確かめたこと", "hook", "serve",
    "推奨", "SSE を推します", "▸ ● SSE", "○ WebSocket", "server から GUI への一方向配信", "自由記述",
    "j/k 移動 · Enter 回答 · i 自由記述", "保留 1", "h/l 切替  b 一覧  q 終了",
  ]) assert.ok(out.includes(s), `含まれない: ${s}`);
  assert.ok(lines.some((l) => l.includes(" │ ") && l.includes("◄") === false && l.includes("SSE")), "2 カラム");
  assert.ok(lines.some((l) => l.includes("背景") && l.includes("判断")), "見出し");
  for (const l of lines) assert.ok(width(l) <= 140);
});

test("色: chips は紫/緑/橙、可逆性は背景色、推奨バッジ", () => {
  const raw = render(viewOf(), { cols: 140, rows: 40 });
  assert.ok(raw.includes("\x1b[35m◈ ukagai"));
  assert.ok(raw.includes("\x1b[32m⎇ feat/tui"));
  assert.ok(raw.includes("\x1b[33m⧉ feat-tui"));
  assert.ok(raw.includes("\x1b[43;30m 戻すのにコストがかかる"));
  assert.ok(raw.includes("\x1b[42;30m 推奨 "));
  const irr = viewOf(decision(withExplanation(V2_MD.replace("costly", "irreversible"))));
  assert.ok(render(irr, { cols: 140, rows: 40 }).includes("\x1b[41;97m 元に戻せない"));
});

test("狭い(80 桁)と上下に並び、判断が先に来る", () => {
  const lines = stripAnsi(render(viewOf(), { cols: 80, rows: 60 })).split("\n");
  const rec = lines.findIndex((l) => l.includes("▸ ● SSE"));
  const bg = lines.findIndex((l) => l.includes("なぜ今この判断が要るか"));
  assert.ok(rec > 0 && bg > rec);
  assert.ok(!lines.some((l) => l.includes("背景") && l.includes("判断")));
});

test("背景が収まらないときだけスクロールの印と scrollMax", () => {
  const long = V2_MD + "\n" + Array.from({ length: 80 }, (_, i) => `- 行 ${i}`).join("\n") + "\n";
  const v = viewOf(decision(withExplanation(long)));
  const f = renderFrame(v, { cols: 140, rows: 24 });
  assert.ok(f.scrollMax > 0);
  const txt = stripAnsi(f.text);
  assert.ok(/▼ 1-\d+\/\d+/.test(txt), "位置表示");
  assert.ok(txt.includes("PgUp/PgDn 背景をスクロール · Tab 列の切替"));
  assert.ok(txt.includes("█"), "スクロールバー");
  const short = renderFrame(viewOf(), { cols: 140, rows: 60 });
  assert.equal(short.scrollMax, 0);
  assert.ok(!stripAnsi(short.text).includes("PgUp/PgDn"));
  const scrolled = renderFrame({ ...v, scroll: f.scrollMax }, { cols: 140, rows: 24 });
  assert.ok(stripAnsi(scrolled.text).includes("行 79"));
});

test("説明なし(複数選択)は生の選択肢とチェックボックス", () => {
  const d = decision({
    explanation: { path: "", markdown: "", has: { mermaid: false, table: false, diff: false }, match: "recency", attached_via: "none" },
    request: { questions: [{ question: "どれを入れますか？", header: "対象", multiSelect: true, options: [{ label: "A", description: "a です" }, { label: "B", description: "b です" }] }] },
  } as never);
  const out = stripAnsi(render(viewOf(d), { cols: 140, rows: 30 }));
  for (const s of ["どれを入れますか？", "[ ] A", "a です", "Space 切替", "エージェントは説明を書きませんでした"]) assert.ok(out.includes(s), s);
});

test("計画は承認 / auto / 却下のボタン", () => {
  const d = decision({ kind: "approve_plan", request: { plan: "# 計画の題\n\n## 影響範囲と可逆性\n\n小さい。", planFilePath: "/p" } } as never);
  const out = stripAnsi(render(viewOf(d), { cols: 140, rows: 30 }));
  for (const s of ["この計画を承認しますか", "[y] 承認", "[a] 承認して auto", "[n] 却下", "影響範囲と可逆性"]) assert.ok(out.includes(s), s);
});

test("保留が無ければ中央に「判断待ちはありません」", () => {
  const out = stripAnsi(render(new App().view(NOW), { cols: 100, rows: 20 }));
  assert.ok(out.includes("判断待ちはありません"));
  assert.ok(out.includes("保留 0"));
});

test("model だけからも描ける(buildModel の結果を view に載せる)", () => {
  const m = buildModel(decision(withExplanation(V2_MD)));
  const v: View = { ...viewOf(), model: m };
  assert.ok(stripAnsi(render(v, { cols: 140, rows: 40 })).includes(m.title));
});

test("blocker: 上段に「人の作業待ち」、見出し直下に「人にしてほしいこと」とコード、その下に 3 択、c コピーのヒント", () => {
  const out = stripAnsi(render(viewOf(blockerDecision()), { cols: 140, rows: 40 }));
  const lines = out.split("\n");
  assert.equal(lines[0]!.trim(), "人の作業待ち");
  for (const s of ["人にしてほしいこと", "gcloud auth login", "▸ ● 対応した。続けて", "○ この手順は飛ばして続けて", "○ ここで中断", "c コピー", "なぜ止まったか"]) {
    assert.ok(out.includes(s), `含まれない: ${s}`);
  }
  // 右列では「人にしてほしいこと」が 3 択より上
  const right = (s: string) => lines.findIndex((l) => l.split(" │ ").slice(1).join(" │ ").includes(s));
  assert.ok(right("人にしてほしいこと") >= 0 && right("人にしてほしいこと") < right("対応した。続けて"));
  // 左列には無い
  assert.ok(!lines.some((l) => l.split(" │ ")[0]!.includes("人にしてほしいこと")));
  assert.ok(!out.includes("┌─ 推奨"), "推奨が無ければボックスを出さない");
  assert.ok(render(viewOf(blockerDecision()), { cols: 140, rows: 40 }).includes("\x1b[43;30m 人の作業待ち"));
});

test("blocker: pbcopy が無いとヒントは「コピー非対応」", () => {
  const app = new App();
  app.copySupported = false;
  app.upsert(blockerDecision(), NOW);
  const out = stripAnsi(render(app.view(NOW), { cols: 140, rows: 40 }));
  assert.ok(out.includes("コピー非対応"));
  assert.ok(!out.includes("c コピー"));
});

test("blocker: 一覧の行に「作業」印", () => {
  const app = new App();
  app.upsert(blockerDecision(), NOW);
  app.upsert(decision({ id: "d2", created_at: "2026-10-02T00:00:10.000Z", ...withExplanation(V2_MD) }), NOW);
  app.handle({ name: "char", ch: "b" }, 1);
  const lines = stripAnsi(render(app.view(NOW), { cols: 100, rows: 20 })).split("\n");
  assert.ok(lines.some((l) => l.includes("作業") && l.includes("gcloud")), lines.join("\n"));
  assert.equal(lines.filter((l) => l.includes(" 作業 ")).length, 1);
});

test("blocker でない判断は帯も「c コピー」も出さない", () => {
  const out = stripAnsi(render(viewOf(), { cols: 140, rows: 40 }));
  assert.ok(!out.includes("人の作業待ち") && !out.includes("c コピー"));
});
