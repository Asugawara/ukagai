import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../../src/tui/markdown.js";
import { stripAnsi, width, wrap } from "../../src/tui/width.js";

const plain = (md: string, w = 60) => renderMarkdown(md, w).map(stripAnsi);

test("見出しは太字、色を剥がすと本文だけ", () => {
  const raw = renderMarkdown("## なぜ今\n\n本文です。", 40);
  assert.ok(raw[0]!.includes("\x1b[1m"));
  assert.deepEqual(raw.map(stripAnsi), ["なぜ今", "", "本文です。"]);
});

test("**強調** は cyan 太字、`code` は dim", () => {
  const [line] = renderMarkdown("**大事** と `code`", 40);
  assert.ok(line!.includes("\x1b[1;36m大事"));
  assert.ok(line!.includes("\x1b[2mcode"));
  assert.equal(stripAnsi(line!), "大事 と code");
});

test("箇条書きは •", () => {
  assert.deepEqual(plain("- 一つ目\n- 二つ目\n"), ["• 一つ目", "• 二つ目"]);
});

test("表は列幅をそろえた罫線なしテキストで、リスク列の強調は赤", () => {
  const md = "| 選択肢 | 選ぶと起きること | リスクと戻し方 |\n|---|---|---|\n| SSE | 一方向 | **注意**あり |\n| WebSocket | 双方向 | なし |\n";
  const raw = renderMarkdown(md, 80);
  const lines = raw.map(stripAnsi);
  assert.equal(lines.length, 3);
  // 列の開始位置がそろう
  const col2 = (l: string) => width(l.slice(0, l.indexOf("一方向") >= 0 ? l.indexOf("一方向") : l.indexOf("双方向")));
  assert.equal(col2(lines[1]!), col2(lines[2]!));
  assert.ok(raw[1]!.includes("\x1b[1;31m注意"));
  assert.ok(!lines.join("").includes("|"));
});

test("diff は + 緑 / - 赤 / @@ 青", () => {
  const raw = renderMarkdown("```diff\n@@ -1 +1 @@\n-old\n+new\n```\n", 40);
  assert.ok(raw[0]!.includes("\x1b[34m@@"));
  assert.ok(raw[1]!.includes("\x1b[31m-old"));
  assert.ok(raw[2]!.includes("\x1b[32m+new"));
});

test("mermaid は罫線の図に描く(ノード名を含み、幅は列幅以内)", () => {
  const lines = renderMarkdown("```mermaid\nflowchart LR\n  A[調査] --> B[判断] --> C[実装]\n```\n", 60).map(stripAnsi);
  const text = lines.join("\n");
  for (const s of ["調査", "判断", "実装", "┌", "►"]) assert.ok(text.includes(s), s);
  assert.ok(!text.includes("描画に失敗"));
  for (const l of lines) assert.ok(width(l) <= 60, l);
  // 全角を含んでも箱の右辺がそろう
  const tops = lines.filter((l) => l.includes("┌")).map((l) => l.indexOf("┌"));
  assert.ok(tops.length > 0);
  const row = lines.find((l) => l.includes("調査"))!;
  assert.equal(width(row), width(lines.find((l) => l.includes("┌"))!));
});

test("mermaid: 幅が足りないときは退避文と定義", () => {
  const raw = renderMarkdown("```mermaid\nflowchart LR\n  A[調査] --> B[判断] --> C[実装]\n```\n", 20);
  const lines = raw.map(stripAnsi);
  assert.match(lines[0]!, /^\(図は幅 \d+ 列が必要。端末を広げるか GUI で表示\)$/);
  assert.ok(lines.includes("  flowchart LR"));
  assert.ok(raw[1]!.includes("\x1b[2m"));
});

test("mermaid: 描けない定義は失敗の退避文と定義", () => {
  const lines = renderMarkdown("```mermaid\nnot a diagram at all\n```\n", 60).map(stripAnsi);
  assert.equal(lines[0], "(図: 描画に失敗。以下は定義)");
  assert.ok(lines.includes("  not a diagram at all"));
});

test("callout は GUI と同じラベルと色の帯", () => {
  const cases: [string, string, string][] = [
    ["NOTE", "補足", "\x1b[34m"],
    ["TIP", "ヒント", "\x1b[32m"],
    ["WARNING", "注意", "\x1b[33m"],
    ["CAUTION", "警告", "\x1b[31m"],
  ];
  for (const [kind, label, color] of cases) {
    const raw = renderMarkdown(`> [!${kind}]\n> 中身です\n`, 40);
    assert.equal(stripAnsi(raw[0]!), `▌ ${label}`);
    assert.equal(stripAnsi(raw[1]!), "▌ 中身です");
    assert.ok(raw[0]!.includes(color));
  }
});

test("折り返しは全角 2 桁で数える", () => {
  const lines = wrap("あいうえおかきくけこ", 8);
  assert.deepEqual(lines, ["あいうえ", "おかきく", "けこ"]);
  for (const l of renderMarkdown("あいうえおかきくけこさしすせそ", 10)) assert.ok(width(l) <= 10);
});

test("英単語は空白で折り返し、ANSI の装飾は行をまたいで引き継ぐ", () => {
  assert.deepEqual(wrap("aaa bbb ccc", 7).map(stripAnsi), ["aaa bbb", "ccc"]);
  const lines = wrap("\x1b[1;36maaa bbb ccc\x1b[0m", 7);
  assert.ok(lines[1]!.startsWith("\x1b[1;36m"));
  assert.ok(lines[0]!.endsWith("\x1b[0m"));
});

test("ANSI を含む出力は表示幅の計算に数えない", () => {
  assert.equal(width("\x1b[1mあ\x1b[0mb"), 3);
});
