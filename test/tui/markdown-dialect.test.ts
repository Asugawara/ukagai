import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderMarkdown } from "../../src/tui/markdown.js";
import { stripAnsi, width } from "../../src/tui/width.js";

// One document with every construct of the ukagai Markdown dialect (docs/spec/markdown.md)
const DOC = [
  "> [!NOTE] Context title",
  "> Body of the note.",
  "",
  "> [!TIP]",
  "> Easy path.",
  "",
  "> [!IMPORTANT] Accept this premise",
  "> Must hold.",
  "",
  "> [!WARNING]",
  "> Costly.",
  "",
  "> [!CAUTION] Cannot be undone",
  "> Touches others.",
  "",
  "## Steps",
  "1. **Add the schema** [done] — `src/contract.ts:12`",
  "   - [x] zod type",
  "   - [ ] docs",
  "2. **Wire the route** [todo]",
  "3. **Ship** [blocked]",
  "",
  "A sentence with [done] in the middle and ==the one phrase== to keep.",
  "",
  "- [doing] working on it",
  "- [risk] might break",
  "- [skip] not now",
  "- plain item",
  "",
  "| Item | Status |",
  "|---|---|",
  "| Parser | [done] |",
  "| Docs | [blocked] with ==care== |",
  "",
  "<details>",
  "<summary>Full log</summary>",
  "",
  "```text",
  "line one",
  "line two",
  "```",
  "",
  "Some **body** text<br>after a break and H<sub>2</sub>O x<sup>2</sup>.",
  "",
  "</details>",
  "",
  "```mermaid",
  "flowchart LR",
  "  A[Start] --> B[End]",
  "```",
  "",
  "```mermaid",
  "sequenceDiagram",
  "  Alice->>Bob: Hello",
  "```",
  "",
  "```mermaid",
  "pie title Split",
  '  "a": 3',
  '  "b": 2',
  "```",
  "",
  '```ts title="src/serve/store.ts"',
  "const x = 1;",
  "```",
  "",
  "```diff",
  "@@ -1,2 +1,2 @@",
  "-old line",
  "+new line",
  " context",
  "```",
  "",
  "::: columns",
  "Left column text.",
  "",
  "---",
  "",
  "Right column text.",
  ":::",
  "",
  "![Settings page, dark theme](shots/settings-dark.png)",
  "",
  "<script>alert(1)</script>",
].join("\n");

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";

const LONG = [
  "> [!CAUTION] 戻せない操作です。この見出しはとても長いので折り返されなければなりません、本当に長い",
  "> body",
  "",
  "<details>",
  "<summary>とても長い要約の文章がここに入ります、折り返しが必要になるほど長い長い長い要約</summary>",
  "",
  "body",
  "</details>",
  "",
  "![とても長い代替テキストがここに入ります、折り返しが必要になるほど長い](shots/a-very-long-path-name-for-a-screenshot-file.png)",
  "",
  '```ts title="src/とても/長い/ファイル名/の/タイトル/が/ここに/入ります/長い/長い/長い.ts"',
  "x",
  "```",
  "",
  "```text",
  "+not added",
  "-not removed",
  "@@ not a hunk",
  "```",
].join("\n");

for (const w of [24, 40]) {
  test(`long CJK titles, summaries and alt text wrap at ${w} columns`, () => {
    const raw = renderMarkdown(LONG, w);
    for (const l of raw.map(stripAnsi)) assert.ok(width(l) <= w, `too wide (${width(l)}): ${l}`);
  });
}

test("a text fence is never diff-coloured", () => {
  const raw = renderMarkdown(LONG, 80);
  for (const s of ["+not added", "-not removed", "@@ not a hunk"]) {
    const l = raw.find((x) => stripAnsi(x).includes(s))!;
    assert.ok(!l.includes(GREEN) && !l.includes(RED) && !l.includes(CYAN), s);
  }
});

for (const w of [100, 160]) {
  test(`dialect at ${w} columns: every construct renders and no line is wider than the column`, () => {
    const raw = renderMarkdown(DOC, w);
    const text = raw.map(stripAnsi);
    for (const l of text) assert.ok(width(l) <= w, `too wide (${width(l)}): ${l}`);
    // The `:::` fences never print
    assert.ok(!text.some((l) => l.includes(":::")));
    // The script tag is text, not dropped or executed
    assert.ok(text.includes("<script>alert(1)</script>"));
    // Image: one dim line
    const img = raw.find((l) => stripAnsi(l).startsWith("[image]"))!;
    assert.equal(stripAnsi(img), "[image] Settings page, dark theme — shots/settings-dark.png");
    assert.ok(img.startsWith(DIM));
  });
}

test("callouts: [!KIND] Title in the kind's colour; without a title the localised word; IMPORTANT is magenta", () => {
  const raw = renderMarkdown(DOC, 100);
  const find = (s: string) => raw.find((l) => stripAnsi(l).includes(s))!;
  assert.equal(stripAnsi(find("[!NOTE]")), "▌ [!NOTE] Context title");
  assert.ok(find("[!NOTE]").startsWith("\x1b[34m"));
  assert.equal(stripAnsi(find("[!IMPORTANT]")), "▌ [!IMPORTANT] Accept this premise");
  assert.ok(find("[!IMPORTANT]").startsWith("\x1b[35m"));
  assert.ok(find("[!CAUTION]").startsWith(RED));
  assert.equal(stripAnsi(find("Cannot be undone")).includes("Costly"), false);
  assert.ok(raw.map(stripAnsi).includes("▌ Tip"));
  assert.ok(raw.map(stripAnsi).includes("▌ Warning"));
  // The body is not on the label line
  assert.ok(raw.map(stripAnsi).includes("▌ Body of the note."));
  const ja = renderMarkdown("> [!IMPORTANT]\n> x\n\n> [!CAUTION] 戻せない\n> y", 60, { lang: "ja" }).map(stripAnsi);
  assert.ok(ja.includes("▌ 重要"));
  assert.ok(ja.includes("▌ [!CAUTION] 戻せない"));
});

test("task lists use ☑ / ☐ and done items are dim; nesting and step numbers survive", () => {
  const raw = renderMarkdown(DOC, 100);
  const text = raw.map(stripAnsi);
  assert.ok(text.includes("1. Add the schema [done] — src/contract.ts:12"));
  assert.ok(text.includes("   ☑ zod type"));
  assert.ok(text.includes("   ☐ docs"));
  assert.ok(text.includes("2. Wire the route [todo]"));
  assert.ok(text.includes("3. Ship [blocked]"));
  const done = raw.find((l) => stripAnsi(l).includes("☑ zod type"))!;
  assert.ok(done.includes(`${DIM}zod type`));
  const open = raw.find((l) => stripAnsi(l).includes("☐ docs"))!;
  assert.ok(!open.includes(DIM));
});

test("badges colour the word at the start of an item / cell (or after a leading bold title), never mid-sentence", () => {
  const raw = renderMarkdown(DOC, 100);
  const find = (s: string) => raw.find((l) => stripAnsi(l).includes(s))!;
  assert.ok(find("working on it").includes(`[${CYAN}doing`));
  assert.ok(find("might break").includes(`[${RED}risk`));
  assert.ok(find("not now").includes(`[${DIM}skip`));
  assert.ok(find("Add the schema").includes(`[${GREEN}done`));
  assert.ok(find("Parser").includes(`[${GREEN}done`));
  assert.ok(find("Docs").includes(`[${RED}blocked`));
  assert.equal(stripAnsi(find("working on it")), "• [doing] working on it");
  const mid = find("in the middle");
  assert.ok(!mid.includes(`[${GREEN}done`));
  assert.ok(mid.includes("[done]"));
});

test("==mark== is inverse video, removed from the width, and not applied inside code", () => {
  const raw = renderMarkdown(DOC, 100);
  const l = raw.find((x) => stripAnsi(x).includes("the one phrase"))!;
  assert.ok(l.includes("\x1b[7mthe one phrase\x1b[27m"));
  assert.ok(!stripAnsi(l).includes("=="));
  const narrow = renderMarkdown("aaa ==bbb ccc== ddd", 11);
  for (const x of narrow) assert.ok(width(x) <= 11);
  assert.equal(narrow.map(stripAnsi).join(" ").replace(/\s+/g, " "), "aaa bbb ccc ddd");
  assert.equal(stripAnsi(renderMarkdown("`==x==`", 20)[0]!), "==x==");
  const cell = renderMarkdown("| A | B |\n|---|---|\n| ==hi== | x |", 40);
  assert.ok(cell[1]!.includes("\x1b[7mhi\x1b[27m"));
  assert.equal(stripAnsi(cell[1]!), "hi  x");
});

test("<details> becomes a dim header with the line count; the body is Markdown; <br> breaks, sub / sup keep text", () => {
  const raw = renderMarkdown(DOC, 100);
  const text = raw.map(stripAnsi);
  const at = text.indexOf("▸ Full log (6 lines)");
  assert.ok(at >= 0, text.join("\n"));
  assert.ok(raw[at]!.startsWith(DIM));
  assert.ok(text.includes("  line one"));
  assert.ok(!text.some((l) => /<\/?(details|summary)>/.test(l)));
  assert.ok(text.includes("Some body text"));
  assert.ok(text.includes("after a break and H2O x2."));
  assert.equal(renderMarkdown("<details open>\n<summary>S</summary>\n\nx\n</details>", 40).map(stripAnsi)[0], "▸ S (1 line)");
  // A one-line <details> is not a block: it is printed as text
  assert.equal(renderMarkdown("<details><summary>S</summary></details>", 40).map(stripAnsi)[0], "<details><summary>S</summary></details>");
});

test("Mermaid: ASCII for flowchart and sequence diagrams, a `diagram: pie` box plus the source otherwise", () => {
  const text = renderMarkdown(DOC, 100).map(stripAnsi);
  assert.ok(text.some((l) => l.includes("Start") && l.includes("End")));
  assert.ok(text.some((l) => /[┌│└]/.test(l) && l.includes("Alice")));
  assert.ok(text.some((l) => l.includes("│ diagram: pie │")));
  assert.ok(text.includes("  pie title Split"));
  assert.ok(text.includes('    "a": 3'));
  assert.ok(!text.some((l) => l.includes("could not render")));
  const ja = renderMarkdown("```mermaid\ngantt\n  title T\n```", 60, { lang: "ja" }).map(stripAnsi);
  assert.ok(ja.some((l) => l.includes("図: gantt")));
  // Other ASCII-capable types do not take the fallback
  for (const src of ["stateDiagram-v2\n  [*] --> A", "classDiagram\n  A <|-- B", "erDiagram\n  A ||--o{ B : has"]) {
    assert.ok(!renderMarkdown("```mermaid\n" + src + "\n```", 80).map(stripAnsi).some((l) => l.includes("diagram:")), src);
  }
  // `%%` comments before the type line are skipped
  assert.ok(renderMarkdown("```mermaid\n%% note\ntimeline\n  2020 : x\n```", 60).map(stripAnsi).some((l) => l.includes("diagram: timeline")));
});

test("code: title= is a dim line above the block; diff colours + green, - red, @@ cyan inside the block only", () => {
  const raw = renderMarkdown(DOC, 100);
  const text = raw.map(stripAnsi);
  const t = text.indexOf("src/serve/store.ts");
  assert.ok(t >= 0 && raw[t]!.startsWith(DIM));
  assert.equal(text[t + 1], "  const x = 1;");
  const find = (s: string) => raw.find((l) => stripAnsi(l).includes(s))!;
  assert.ok(find("new line").includes(`${GREEN}+new line`));
  assert.ok(find("old line").includes(`${RED}-old line`));
  assert.ok(find("@@ -1,2").includes(`${CYAN}@@`));
  assert.ok(!find("context").includes("\x1b[3"));
  // Outside a diff block a leading + / - is not coloured
  const outside = renderMarkdown("- item\n\n+ plus", 40);
  assert.ok(!outside.some((l) => l.includes(GREEN) || l.includes(RED)));
});

test("columns are stacked in order, each preceded by a dim rule", () => {
  const raw = renderMarkdown(DOC, 100);
  const text = raw.map(stripAnsi);
  const l = text.indexOf("Left column text.");
  const r = text.indexOf("Right column text.");
  assert.ok(l > 0 && r > l);
  const rule = "─".repeat(100);
  assert.equal(text[l - 1], rule);
  assert.equal(text[r - 1], rule);
  assert.ok(raw[l - 1]!.startsWith(DIM));
});

test("images: dim line, with (W×H) when an absolute PNG path has a readable header", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ukagai-md-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const png = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12, "latin1");
  png.writeUInt32BE(640, 16);
  png.writeUInt32BE(480, 20);
  writeFileSync(join(dir, "a.png"), png);
  const abs = renderMarkdown(`![shot](${join(dir, "a.png")})`, 200).map(stripAnsi);
  assert.equal(abs[0], `[image] shot — ${join(dir, "a.png")} (640×480)`);
  const rel = renderMarkdown("![shot](a.png)", 80, { baseDir: dir }).map(stripAnsi);
  assert.equal(rel[0], "[image] shot — a.png (640×480)");
  assert.equal(renderMarkdown("![shot](missing.png)", 80, { baseDir: dir }).map(stripAnsi)[0], "[image] shot — missing.png");
  assert.equal(renderMarkdown("![](x.png)", 80).map(stripAnsi)[0], "[image] x.png");
  assert.equal(renderMarkdown("![a](x.png)", 80, { lang: "ja" }).map(stripAnsi)[0], "[画像] a — x.png");
});

test("badge anchoring: a list item or table cell with [done] later in the text stays plain", () => {
  const raw = renderMarkdown("- see [done] later\n\n| A | B |\n|---|---|\n| x [done] | y |", 60);
  for (const l of raw) assert.ok(!l.includes(GREEN), stripAnsi(l));
  assert.ok(raw.map(stripAnsi).some((l) => l.includes("see [done] later")));
  assert.ok(renderMarkdown("`[done]` code", 40)[0]!.indexOf(GREEN) < 0);
  assert.ok(renderMarkdown("- `[done]` code", 40)[0]!.indexOf(GREEN) < 0);
});

test("==mark== keeps inverse across a nested bold / code reset, and ignores runs of =", () => {
  const [l] = renderMarkdown("==a **b** c==", 40);
  assert.equal(stripAnsi(l!), "a b c");
  // After the reset that closes the bold, the inverse is opened again before the rest of the mark
  assert.ok(/\x1b\[0m\x1b\[7m c\x1b\[27m/.test(l!), JSON.stringify(l));
  const cell = renderMarkdown("| A |\n|---|\n| ==x **y** z== |", 40)[1]!;
  assert.ok(/\x1b\[0m\x1b\[7m z\x1b\[27m/.test(cell), JSON.stringify(cell));
  assert.equal(stripAnsi(renderMarkdown("a===b===c", 40)[0]!), "a===b===c");
  assert.equal(stripAnsi(renderMarkdown("Title\n======", 40)[0]!), "Title ======");
  assert.equal(stripAnsi(renderMarkdown("an ==unbalanced mark", 40)[0]!), "an ==unbalanced mark");
  assert.ok(!renderMarkdown("a ===b=== c", 40)[0]!.includes("\x1b[7m"));
});

test("stray ::: lines and unterminated columns / details do not lose text", () => {
  const stray = renderMarkdown("before\n\n:::\n\nafter", 40).map(stripAnsi);
  assert.deepEqual(stray, ["before", "", "after"]);
  const cols = renderMarkdown("::: columns\nA\n\n---\n\nB", 40).map(stripAnsi);
  assert.ok(cols.includes("A") && cols.includes("B") && !cols.some((l) => l.includes(":::")));
  const open = renderMarkdown("<details>\n<summary>S</summary>\n\nbody text", 40).map(stripAnsi);
  assert.equal(open[0], "▸ S (1 line)");
  assert.ok(open.includes("body text"));
  // An unclosed <summary> keeps the body: the first line is the summary
  const unclosed = renderMarkdown("<details>\n<summary>Why\n\nbody text\n</details>", 40).map(stripAnsi);
  assert.equal(unclosed[0], "▸ Why (1 line)");
  assert.ok(unclosed.includes("body text"));
  // Only known inline tags are stripped from the summary
  assert.equal(renderMarkdown("<details>\n<summary><b>Why</b> Map<string, number> fails</summary>\n\nx\n</details>", 60).map(stripAnsi)[0], "▸ Why Map<string, number> fails (1 line)");
});

test("ordered task items keep their number; an empty task has no trailing space", () => {
  assert.deepEqual(renderMarkdown("1. [x] first\n2. [ ] second", 40).map(stripAnsi), ["1. ☑ first", "2. ☐ second"]);
  assert.equal(renderMarkdown("- [x]", 40).map(stripAnsi)[0], "☑");
});

test("images: balanced parentheses in the path, localised label in table cells, empty code title prints nothing", () => {
  assert.equal(stripAnsi(renderMarkdown("![a](foo(1).png)", 60)[0]!), "[image] a — foo(1).png");
  assert.equal(stripAnsi(renderMarkdown("see ![a](foo(1).png) here", 60)[0]!), "see [image] a — foo(1).png here");
  const ja = renderMarkdown("| A |\n|---|\n| ![a](x.png) |", 60, { lang: "ja" }).map(stripAnsi);
  assert.ok(ja[1]!.startsWith("[画像] a — x.png"), ja[1]);
  assert.deepEqual(renderMarkdown('```ts title=""\nx\n```', 40).map(stripAnsi), ["  x"]);
});

test("Mermaid: front matter and %%{init}%% (also multi-line) are skipped; graph and xychart are drawn; classDiagram-v2 gets the box", () => {
  const draw = (src: string) => renderMarkdown("```mermaid\n" + src + "\n```", 80).map(stripAnsi);
  assert.ok(draw("---\ntitle: T\n---\nflowchart LR\n  A --> B").some((l) => l.includes("┌")));
  assert.ok(!draw("---\ntitle: T\n---\nflowchart LR\n  A --> B").some((l) => l.includes("could not render")));
  assert.ok(!draw("%%{init: {\n  'theme': 'dark'\n}}%%\nflowchart LR\n  A --> B").some((l) => l.includes("diagram:")));
  assert.ok(draw("graph TD\n  A --> B").some((l) => l.includes("┌")));
  assert.ok(!draw('xychart-beta\n  x-axis [a, b]\n  bar [3, 5]').some((l) => l.includes("diagram:")));
  assert.ok(draw("classDiagram-v2\n  A <|-- B").some((l) => l.includes("diagram: classDiagram-v2")));
});

test("an image path that is a FIFO does not hang the renderer", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ukagai-md-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fifo = join(dir, "x.png");
  if (spawnSync("mkfifo", [fifo]).status !== 0) return t.skip("mkfifo unavailable");
  assert.equal(renderMarkdown(`![x](${fifo})`, 200).map(stripAnsi)[0], `[image] x — ${fifo}`);
});
