import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMermaid } from "../../src/tui/mermaid.js";

const MAX = 80;

function check(src: string, names: string[]) {
  const r = renderMermaid(src);
  assert.ok(r.ok, "描ける");
  if (!r.ok) return;
  const text = r.lines.join("\n");
  for (const n of names) assert.ok(text.includes(n), `含まれない: ${n}\n${text}`);
  assert.ok(r.width <= MAX, `幅 ${r.width}`);
}

test("flowchart LR 3 ノード", () => check("flowchart LR\n A[調査] --> B[判断] --> C[実装]", ["調査", "判断", "実装"]));
test("TB の分岐", () => check("graph TB\n A[開始] --> B{分岐}\n B -->|はい| C[実行]\n B -->|いいえ| D[中止]", ["開始", "分岐", "実行", "中止", "はい", "いいえ"]));
test("subgraph", () => check("graph TB\n subgraph S[サーバ]\n  A[hook] --> B[store]\n end\n B --> C[GUI]", ["サーバ", "hook", "store", "GUI"]));
test("sequenceDiagram 2 参加者", () => check("sequenceDiagram\n participant A as Agent\n participant U as User\n A->>U: 質問\n U-->>A: 回答", ["Agent", "User", "質問", "回答"]));
test("stateDiagram-v2 3 状態", () => check("stateDiagram-v2\n [*] --> pending\n pending --> answered\n answered --> done", ["pending", "answered", "done"]));

test("全角を含んでも行の右端がそろう(箱の上辺と同じ表示幅)", async () => {
  const { width } = await import("../../src/tui/width.js");
  const r = renderMermaid("flowchart LR\n A[調査] --> B[判断]");
  assert.ok(r.ok);
  if (!r.ok) return;
  const box = r.lines.find((l) => l.includes("判断"))!;
  const top = r.lines.find((l) => l.includes("┌"))!;
  assert.equal(width(box), width(top));
});

test("描けない定義は ok: false", () => {
  assert.equal(renderMermaid("garbage ???").ok, false);
});
