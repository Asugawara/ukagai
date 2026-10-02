import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown, renderMarkdownRich } from "../../src/tui/markdown.js";
import { sliceCols, stripAnsi, width, wrap } from "../../src/tui/width.js";

const plain = (md: string, w = 60) => renderMarkdown(md, w).map(stripAnsi);

test("headings are bold; stripping color leaves only the text", () => {
  const raw = renderMarkdown("## Why now\n\nThe body.", 40);
  assert.ok(raw[0]!.includes("\x1b[1m"));
  assert.deepEqual(raw.map(stripAnsi), ["Why now", "", "The body."]);
});

test("**strong** is bold cyan, `code` is dim", () => {
  const [line] = renderMarkdown("**Key** and `code`", 40);
  assert.ok(line!.includes("\x1b[1;36mKey"));
  assert.ok(line!.includes("\x1b[2mcode"));
  assert.equal(stripAnsi(line!), "Key and code");
});

test("bullets use •", () => {
  assert.deepEqual(plain("- first\n- second\n"), ["• first", "• second"]);
});

test("tables are aligned text without borders, and strong text in the risk column is red", () => {
  const md = "| Option | What happens if chosen | Risks and how to undo |\n|---|---|---|\n| SSE | One-way | Has a **catch** |\n| WebSocket | Two-way | None |\n";
  const raw = renderMarkdown(md, 80);
  const lines = raw.map(stripAnsi);
  assert.equal(lines.length, 3);
  // Column start positions line up
  const col2 = (l: string) => width(l.slice(0, l.indexOf("One-way") >= 0 ? l.indexOf("One-way") : l.indexOf("Two-way")));
  assert.equal(col2(lines[1]!), col2(lines[2]!));
  assert.ok(raw[1]!.includes("\x1b[1;31mcatch"));
  assert.ok(!lines.join("").includes("|"));
});

test("diff: + is green, - is red, @@ is blue", () => {
  const raw = renderMarkdown("```diff\n@@ -1 +1 @@\n-old\n+new\n```\n", 40);
  assert.ok(raw[0]!.includes("\x1b[34m@@"));
  assert.ok(raw[1]!.includes("\x1b[31m-old"));
  assert.ok(raw[2]!.includes("\x1b[32m+new"));
});

test("mermaid is drawn as a box-drawing diagram (contains the node names, fits the column width)", () => {
  const lines = renderMarkdown("```mermaid\nflowchart LR\n  A[調査] --> B[判断] --> C[実装]\n```\n", 60).map(stripAnsi);
  const text = lines.join("\n");
  for (const s of ["調査", "判断", "実装", "┌", "►"]) assert.ok(text.includes(s), s);
  assert.ok(!text.includes("could not render"));
  for (const l of lines) assert.ok(width(l) <= 60, l);
  // The right edges of boxes line up even with full-width characters
  const tops = lines.filter((l) => l.includes("┌")).map((l) => l.indexOf("┌"));
  assert.ok(tops.length > 0);
  const row = lines.find((l) => l.includes("調査"))!;
  assert.equal(width(row), width(lines.find((l) => l.includes("┌"))!));
});

test("mermaid: drawn even when too narrow (truncated to the column, with a note, the full row is kept in wide)", () => {
  const r = renderMarkdownRich("```mermaid\nflowchart LR\n  A[調査] --> B[判断] --> C[実装]\n```\n", 20);
  const lines = r.lines.map(stripAnsi);
  const top = lines.findIndex((l) => l.includes("┌"));
  assert.match(lines.slice(0, top).join("").replace(/ /g, ""), /^\(Diagram:\d+columnswide\.←→\/horizontalwheeltoscroll·fforfullwidth\)$/);
  assert.ok(r.lines[0]!.includes("\x1b[2m"));
  assert.ok(lines.some((l) => l.includes("┌")));
  assert.ok(!lines.some((l) => l.includes("could not render")));
  for (const l of r.lines) assert.ok(width(l) <= 20, l);
  const k = r.wide.findIndex(Boolean);
  assert.ok(k > 0 && width(r.wide[k]!) > 20, "an overflowing row keeps its full text");
  assert.ok(r.wide.slice(0, top).every((x) => x === null), "the note row does not move");
  // When full width is not available, the note drops "f for full width"
  const nf = renderMarkdownRich("```mermaid\nflowchart LR\n  A[調査] --> B[判断]\n```\n", 12, { fullHint: false }).lines.map(stripAnsi);
  assert.match(nf.slice(0, nf.findIndex((l) => l.includes("┌"))).join("").replace(/ /g, ""), /^\(Diagram:\d+columnswide\.←→\/horizontalwheeltoscroll\)$/);
});

test("mermaid: a definition that cannot be drawn gives the failure note and the definition", () => {
  const lines = renderMarkdown("```mermaid\nnot a diagram at all\n```\n", 60).map(stripAnsi);
  assert.equal(lines[0], "(Diagram: could not render. Definition below)");
  assert.ok(lines.includes("  not a diagram at all"));
});

test("callouts are bands with the same labels and colors as the GUI", () => {
  const cases: [string, string, string][] = [
    ["NOTE", "Note", "\x1b[34m"],
    ["TIP", "Tip", "\x1b[32m"],
    ["WARNING", "Warning", "\x1b[33m"],
    ["CAUTION", "Caution", "\x1b[31m"],
  ];
  for (const [kind, label, color] of cases) {
    const raw = renderMarkdown(`> [!${kind}]\n> Body text\n`, 40);
    assert.equal(stripAnsi(raw[0]!), `▌ ${label}`);
    assert.equal(stripAnsi(raw[1]!), "▌ Body text");
    assert.ok(raw[0]!.includes(color));
  }
});

test("wrapping counts full-width characters as 2 columns", () => {
  const lines = wrap("あいうえおかきくけこ", 8);
  assert.deepEqual(lines, ["あいうえ", "おかきく", "けこ"]);
  for (const l of renderMarkdown("あいうえおかきくけこさしすせそ", 10)) assert.ok(width(l) <= 10);
});

test("English words wrap at spaces, and ANSI decoration carries across lines", () => {
  assert.deepEqual(wrap("aaa bbb ccc", 7).map(stripAnsi), ["aaa bbb", "ccc"]);
  const lines = wrap("\x1b[1;36maaa bbb ccc\x1b[0m", 7);
  assert.ok(lines[1]!.startsWith("\x1b[1;36m"));
  assert.ok(lines[0]!.endsWith("\x1b[0m"));
});

test("ANSI sequences are not counted in display width", () => {
  assert.equal(width("\x1b[1mあ\x1b[0mb"), 3);
});

test("ja: callout labels and the diagram note are Japanese", () => {
  const raw = renderMarkdown("> [!WARNING]\n> Body text\n", 40, { lang: "ja" });
  assert.equal(stripAnsi(raw[0]!), "▌ 注意");
  const r = renderMarkdownRich("```mermaid\nflowchart LR\n  A[調査] --> B[判断] --> C[実装]\n```\n", 20, { lang: "ja" });
  const lines = r.lines.map(stripAnsi);
  const top = lines.findIndex((l) => l.includes("┌"));
  assert.match(lines.slice(0, top).join("").replace(/ /g, ""), /^\(図:幅\d+桁。←→\/横ホイールでスクロール·fで全幅\)$/);
  assert.equal(renderMarkdown("```mermaid\nnot a diagram at all\n```\n", 60, { lang: "ja" }).map(stripAnsi)[0], "(図: 描画に失敗。以下は定義)");
});

test("table risk column is detected by the English or the Japanese header", () => {
  for (const head of ["| Option | What happens | Risks and how to undo |", "| 選択肢 | 起きること | リスクと戻し方 |"]) {
    const raw = renderMarkdown(`${head}\n|---|---|---|\n| A | x | **bad** |\n`, 80);
    assert.ok(raw[1]!.includes("\x1b[1;31mbad"), head);
  }
});

test("a footnote definition right after a bullet stays its own line (not folded into the bullet)", () => {
  const md = "- reads package.json.[^1]\n[^1]: grep -rn x (no hits)\n[^2]: second";
  const { lines, footnotes } = renderMarkdownRich(md, 60);
  const text = lines.map(stripAnsi);
  assert.equal(text[0], "• reads package.json.[1]");
  assert.ok(text.includes("[1] grep -rn x (no hits)") && text.includes("[2] second"), text.join("|"));
  assert.deepEqual(footnotes.map((f) => f.id), ["1", "2"]);
});
