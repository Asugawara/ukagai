import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMermaid } from "../../src/tui/mermaid.js";

const MAX = 80;

function check(src: string, names: string[]) {
  const r = renderMermaid(src);
  assert.ok(r.ok, "renders");
  if (!r.ok) return;
  const text = r.lines.join("\n");
  for (const n of names) assert.ok(text.includes(n), `missing: ${n}\n${text}`);
  assert.ok(r.width <= MAX, `width ${r.width}`);
}

test("flowchart LR with 3 nodes", () => check("flowchart LR\n A[調査] --> B[判断] --> C[実装]", ["調査", "判断", "実装"]));
test("TB with a branch", () => check("graph TB\n A[開始] --> B{分岐}\n B -->|はい| C[実行]\n B -->|いいえ| D[中止]", ["開始", "分岐", "実行", "中止", "はい", "いいえ"]));
test("subgraph", () => check("graph TB\n subgraph S[サーバ]\n  A[hook] --> B[store]\n end\n B --> C[GUI]", ["サーバ", "hook", "store", "GUI"]));
test("sequenceDiagram with 2 participants", () => check("sequenceDiagram\n participant A as Agent\n participant U as User\n A->>U: 質問\n U-->>A: 回答", ["Agent", "User", "質問", "回答"]));
test("stateDiagram-v2 with 3 states", () => check("stateDiagram-v2\n [*] --> pending\n pending --> answered\n answered --> done", ["pending", "answered", "done"]));

test("right edges line up with full-width characters (same display width as the box top)", async () => {
  const { width } = await import("../../src/tui/width.js");
  const r = renderMermaid("flowchart LR\n A[調査] --> B[判断]");
  assert.ok(r.ok);
  if (!r.ok) return;
  const box = r.lines.find((l) => l.includes("判断"))!;
  const top = r.lines.find((l) => l.includes("┌"))!;
  assert.equal(width(box), width(top));
});

test("a definition that cannot be drawn returns ok: false", () => {
  assert.equal(renderMermaid("garbage ???").ok, false);
});
