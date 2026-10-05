import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { App } from "../../src/tui/app.js";
import type { Key } from "../../src/tui/keys.js";
import { planOutline } from "../../src/tui/plan.js";
import { renderFrame } from "../../src/tui/render.js";
import { stripAnsi } from "../../src/tui/width.js";
import { decision } from "./helpers.js";

// The same synthetic long plan the GUI test uses: 200 lines, 9 H2, 6 H3, 2 code blocks, 12 distinct file paths
const LONG = readFileSync(new URL("../gui/fixtures/long-plan.md", import.meta.url), "utf8");
const ch = (c: string): Key => ({ name: "char", ch: c });
const enter: Key = { name: "enter" };
const tab: Key = { name: "tab" };
let clock = 1000;
const press = (app: App, ...keys: Key[]) => keys.flatMap((k) => app.handle(k, (clock += 10)));

const planDecision = (plan: string) => decision({ kind: "approve_plan", request: { plan, planFilePath: "/p/plan.md" } } as never);

/** Draw a frame the way index.ts does (a second pass when syncFrame asks for it) and return it as plain text rows */
function draw(app: App, cols = 140, rows = 50): { text: string; lines: string[]; frame: ReturnType<typeof renderFrame> } {
  let frame = renderFrame(app.view(clock), { cols, rows });
  if (app.syncFrame(frame, clock)) frame = renderFrame(app.view(clock), { cols, rows });
  return { text: stripAnsi(frame.text), lines: frame.lines.map(stripAnsi), frame };
}

const open = (plan = LONG): App => {
  const app = new App();
  app.upsert(planDecision(plan), clock);
  draw(app);
  return app;
};
/** Rows of the left column that are section headings: `▸ ☐ Title (n lines)` (the right column's contents rows have no parentheses) */
const headings = (text: string) => text.split("\n").map((l) => l.split(" │ ")[0]!).filter((l) => /^\s*[▸▾] [☐☑] .+ \(\d+ lines\)/.test(l)).map((l) => l.trim());

test("plan outline: the fixture has 9 sections, 15 contents rows, 200 lines, 12 files; the scope section is flagged", () => {
  const o = planOutline(LONG);
  assert.equal(o.h2, 9);
  assert.equal(o.entries.length, 15);
  assert.equal(o.lines, 200);
  assert.equal(o.files, 12);
  assert.equal(o.long, true);
  assert.deepEqual(o.entries.filter((e) => e.scope).map((e) => e.plain), ["Scope and reversibility"]);
  // paths inside code fences are not counted; a section counts its children's files
  const changes = o.entries.find((e) => e.plain === "Changes")!;
  assert.equal(changes.files.size, 4);
});

test("plan outline: a short plan (two H2, or 40 lines or fewer) is not long", () => {
  assert.equal(planOutline("# P\n\n## A\n\nx\n\n## B\n\ny\n").long, false);
  assert.equal(planOutline("# P\n\n## A\n\nx\n\n## B\n\ny\n\n## C\n\nz\n").long, false); // 3 H2 but 13 lines
  assert.equal(planOutline("# P\n\n## A\n\nx\n\n## B\n\ny\n" + "line\n".repeat(60)).long, false); // 2 H2
  assert.equal(planOutline("# P\n\n## A\n\nx\n\n## B\n\ny\n\n## C\n\nz\n" + "line\n".repeat(40)).long, true);
});

test("plan: headings in code fences and non-path code spans are not counted", () => {
  const md = "# P\n\n## A\n\n```md\n## not a heading\n```\n\n`npm test` `retry` `src/a.ts:12` `1.5` `x.js`\n";
  const o = planOutline(md);
  assert.equal(o.entries.length, 1);
  assert.deepEqual([...o.entries[0]!.files].sort(), ["src/a.ts", "x.js"]);
});

test("plan (long): every H2 is folded to one row except the first, and the contents list 15 rows with marks and line counts", () => {
  const app = open();
  const { text } = draw(app);
  const hs = headings(text);
  assert.equal(hs.filter((h) => h.startsWith("▾")).length, 1, hs.join("\n"));
  assert.match(hs[0]!, /^▾ ☑ Context \(\d+ lines\)/);
  assert.match(hs[1]!, /^▸ ☐ Changes \(/);
  assert.ok(text.includes("Contents"));
  const toc = text.split("\n").map((l) => l.split(" │ ")[1] ?? "").filter((l) => /[☐☑] .+ \d+ lines/.test(l));
  assert.equal(toc.length, 15, toc.join("\n"));
  assert.ok(toc.some((l) => l.includes("☑") && l.includes("Scope and reversibility")), "the scope section counts as read");
  // the body of a closed section is not drawn
  assert.ok(!text.includes("Handler step 1"));
  assert.ok(text.includes("Context step 1"));
});

test("plan (long): j / k move the contents cursor and Enter opens the section; the body appears and the mark turns ☑", () => {
  const app = open();
  press(app, ch("j"));
  let { text } = draw(app);
  assert.match(text, /▸ ☐ Changes {2}\d+ lines/); // the contents cursor row
  press(app, enter);
  ({ text } = draw(app));
  assert.ok(text.includes("Three pieces change"), "Changes is open");
  assert.ok(headings(text).some((h) => /^▾ ☑ Changes/.test(h)), headings(text).join("\n"));
  // its H3 children are folded rows of their own
  assert.ok(headings(text).some((h) => /^▸ ☐ 1\. Backend usecase/.test(h)), headings(text).join("\n"));
  press(app, enter); // Enter again folds it (the mark stays ☑: it has been read)
  ({ text } = draw(app));
  assert.ok(!text.includes("Three pieces change"));
  assert.ok(headings(text).some((h) => /^▸ ☑ Changes/.test(h)));
});

test("plan (long): o opens everything, o again folds everything", () => {
  const app = open();
  press(app, ch("o"));
  let { text } = draw(app, 140, 400);
  assert.equal(headings(text).filter((h) => h.startsWith("▸")).length, 0, headings(text).join("\n"));
  assert.equal(headings(text).length, 15);
  assert.ok(text.includes("Question step 1"));
  press(app, ch("o"));
  ({ text } = draw(app));
  assert.equal(headings(text).filter((h) => h.startsWith("▾")).length, 0);
  assert.equal(headings(text).length, 9, "H3 rows are hidden under a folded H2");
});

test("plan (long): with the background focused Enter / ] / [ act on sections and scroll the background to them", () => {
  const app = open();
  press(app, tab);
  const before = draw(app, 140, 24);
  assert.equal(before.frame.scrollMax > 0 || before.text.includes("▸ ☐ Changes"), true);
  press(app, ch("]")); // Changes, opened
  let d = draw(app, 140, 24);
  assert.ok(d.text.includes("Three pieces change") || d.text.includes("▾ ☑ Changes"), d.text);
  // the heading is in the window (it cannot reach the top: little text follows the folded children)
  assert.ok(d.lines.some((l) => /▾ ☑ Changes/.test(l.split(" │ ")[0]!)), d.lines.join("\n"));
  press(app, ch("]"), ch("]")); // 1. Backend usecase (H3), then 2. HTTP handler
  d = draw(app, 140, 24);
  assert.ok(d.text.includes("2. HTTP handler"), d.text);
  press(app, ch("["));
  d = draw(app, 140, 24);
  assert.ok(/▾ ☑ 1\. Backend usecase/.test(d.text));
  // Space folds the section under the cursor too
  press(app, { name: "char", ch: " " });
  d = draw(app, 140, 24);
  assert.ok(/▸ ☑ 1\. Backend usecase/.test(d.text));
});

test("plan (long): [ and ] still switch pending decisions while the decision column is focused", () => {
  const app = new App();
  app.upsert({ ...planDecision(LONG), id: "a", created_at: "2026-10-03T00:00:00Z" }, clock);
  app.upsert({ ...planDecision(LONG), id: "b", tool_use_id: "b", created_at: "2026-10-03T00:00:01Z" }, clock);
  draw(app);
  assert.equal(app.shownId, "a");
  press(app, ch("]"));
  assert.equal(app.shownId, "b");
});

test("plan (long): one y sends at once with auto; the unread sections are one dim line above the buttons and update live; a does nothing", () => {
  const app = open();
  let { lines } = draw(app);
  const at = lines.findIndex((l) => l.includes("Unread sections (7): Changes, Split and owners"));
  const btn = lines.findIndex((l) => l.includes("[i] Instruct")); // the instruction card is the first row of the actions, Approve / Reject follow
  assert.ok(at >= 0 && btn > at && lines.findIndex((l) => l.includes("[y] Approve")) > btn, lines.join("\n"));
  assert.match(lines.slice(at, btn).map((l) => l.split(" │ ")[1] ?? "").join(" "), /Verification, Observation path \+2$/, "the line (wrapped) ends right above the actions");
  assert.ok(!lines.at(-1)!.includes("Press the same key"), "no confirmation in the footer");
  assert.deepEqual(press(app, ch("a")), []);
  assert.deepEqual(press(app, ch("y")), [{ type: "answer", id: "d1", body: { approve: true, set_mode_auto: true } }]);
  // opening sections shortens the list; reading everything removes the line
  const app2 = open();
  press(app2, ch("j"), enter);
  ({ lines } = draw(app2));
  assert.ok(lines.some((l) => /Unread sections \(6\): Split and owners/.test(l)));
  press(app2, ch("o"));
  ({ lines } = draw(app2));
  assert.ok(!lines.some((l) => l.includes("Unread sections")));
  assert.equal(press(app2, ch("y")).length, 1);
});

test("plan (long): an irreversible plan is approved with one y too", () => {
  const app = new App();
  app.upsert(decision({
    kind: "approve_plan", request: { plan: LONG, planFilePath: "/p/plan.md" },
    explanation: { path: "", title: "Drop it", reversibility: "irreversible", scope: "machine", markdown: LONG, has: { mermaid: false, table: false, diff: false }, match: "recency", attached_via: "first_call" },
  } as never), clock);
  draw(app);
  assert.deepEqual(press(app, ch("y")), [{ type: "answer", id: "d1", body: { approve: true, set_mode_auto: true } }]);
});

test("plan (short): no contents, one open document, y sends at once", () => {
  const app = open("# P\n\n## A\n\nalpha body\n\n## B\n\nbeta body\n\n## Scope and reversibility\n\nx\n");
  const { text } = draw(app);
  assert.ok(!text.includes("Contents"));
  assert.ok(text.includes("alpha body") && text.includes("beta body"));
  assert.equal(headings(text).length, 0);
  assert.equal(press(app, ch("y")).length, 1);
});

test("plan (long): the buttons stay on screen in a short terminal, and ja words are used", () => {
  const app = open();
  app.lang = "ja";
  const { text, lines } = draw(app, 100, 24); // stacked layout
  assert.ok(text.includes("[y] 承認") && text.includes("[n] 却下"), text);
  assert.ok(text.includes("目次"));
  assert.match(text, /[☐☑] .+ \d+ 行/);
  assert.ok(lines.length <= 24);
});

test("plan (long): the unread line is in Japanese", () => {
  const app = open();
  app.lang = "ja";
  const { lines } = draw(app);
  assert.ok(lines.some((l) => /未読 7 節: Changes/.test(l)));
  assert.ok(lines.some((l) => l.includes("[y] 承認")) && !lines.some((l) => l.includes("auto")));
});
