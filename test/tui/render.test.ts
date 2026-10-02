import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../../src/tui/app.js";
import { buildModel } from "../../src/tui/model.js";
import { render, renderFrame, type View } from "../../src/tui/render.js";
import { stripAnsi, width } from "../../src/tui/width.js";
import { V2_MD, decision, withExplanation } from "./helpers.js";

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
    "なぜ今この判断が要るか", "確かめたこと", "(図: Mermaid は GUI で表示。以下は定義)",
    "推奨", "SSE を推します", "▸ ● SSE", "○ WebSocket", "server から GUI への一方向配信", "自由記述",
    "j/k 移動 · Enter 回答 · i 自由記述", "保留 1", "h/l 切替  b 一覧  q 終了",
  ]) assert.ok(out.includes(s), `含まれない: ${s}`);
  assert.ok(lines.some((l) => l.includes(" │ ")), "2 カラム");
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
  assert.ok(!lines.some((l) => l.includes(" │ ")));
});

test("背景が収まらないときだけスクロールの印と scrollMax", () => {
  const long = V2_MD + "\n" + Array.from({ length: 80 }, (_, i) => `- 行 ${i}`).join("\n") + "\n";
  const v = viewOf(decision(withExplanation(long)));
  const f = renderFrame(v, { cols: 140, rows: 24 });
  assert.ok(f.scrollMax > 0);
  assert.ok(stripAnsi(f.text).includes("Ctrl-U/D"));
  const short = renderFrame(viewOf(), { cols: 140, rows: 60 });
  assert.equal(short.scrollMax, 0);
  assert.ok(!stripAnsi(short.text).includes("Ctrl-U/D"));
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
