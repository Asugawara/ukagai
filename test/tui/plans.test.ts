// The plan browser (`p`): the list of plan files and the read-only plan view, with no network (the App's fetchers are stubbed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { App } from "../../src/tui/app.js";
import type { PlanFile, PlanSummary } from "../../src/tui/api.js";
import type { Key } from "../../src/tui/keys.js";
import { MESSAGES } from "../../src/tui/i18n.js";
import { renderFrame } from "../../src/tui/render.js";
import { stripAnsi } from "../../src/tui/width.js";
import { decision } from "./helpers.js";

const LONG = readFileSync(new URL("../gui/fixtures/long-plan.md", import.meta.url), "utf8");
const SHORT_A = "# Short plan A\n\n## One\n\nText `src/a.ts`.\n";
const SHORT_C = "# Short plan C\n\n## One\n\nText.\n\n## Two\n\nMore.\n";
const ch = (c: string): Key => ({ name: "char", ch: c });
const enter: Key = { name: "enter" };
const esc: Key = { name: "esc" };
const tab: Key = { name: "tab" };
let clock = Date.parse("2026-10-03T12:00:00.000Z");
const press = (app: App, ...keys: Key[]) => keys.flatMap((k) => app.handle(k, (clock += 10)));
const tick = () => new Promise((r) => setTimeout(r, 5));

const ago = (ms: number) => new Date(clock - ms).toISOString();
const FILES: Record<string, PlanFile> = {
  "a.md": { name: "a.md", title: "Short plan A", mtime: ago(3 * 3600_000), markdown: SHORT_A },
  "b.md": { name: "b.md", title: "Export retry", mtime: ago(3600_000), markdown: LONG },
  "c.md": { name: "c.md", title: "Short plan C", mtime: ago(5 * 60_000), markdown: SHORT_C },
};
// Newest first, as the API returns them
const LIST: PlanSummary[] = [FILES["c.md"]!, FILES["b.md"]!, FILES["a.md"]!].map((f) => ({ name: f.name, title: f.title, mtime: f.mtime, bytes: f.markdown.length, sections: f.name === "b.md" ? 9 : f.name === "c.md" ? 2 : 1, lines: f.markdown.split("\n").length - 1 }));

function stubbed(files = LIST, calls: string[] = []): App {
  const app = new App();
  app.fetchPlans = async () => { calls.push("list"); return files; };
  app.fetchPlan = async (name, since) => {
    calls.push(`plan:${name}:${since ?? ""}`);
    const f = FILES[name]!;
    return since === f.mtime ? null : f;
  };
  return app;
}

function draw(app: App, cols = 140, rows = 50) {
  let frame = renderFrame(app.view(clock), { cols, rows });
  if (app.syncFrame(frame, clock)) frame = renderFrame(app.view(clock), { cols, rows });
  return { text: stripAnsi(frame.text), lines: frame.lines.map(stripAnsi) };
}

async function openList(app: App, cols = 140, rows = 50) {
  press(app, ch("p"));
  await tick();
  return draw(app, cols, rows);
}

test("p on the empty screen lists the plans in mtime order with section and line counts", async () => {
  const app = stubbed();
  const { text, lines } = await openList(app);
  const rows = lines.filter((l) => l.includes("·") && /sections?/.test(l));
  assert.equal(rows.length, 3);
  assert.ok(rows[0]!.includes("Short plan C") && rows[0]!.includes("5m") && rows[0]!.includes("2 sections · "), rows[0]);
  assert.ok(rows[1]!.includes("Export retry") && rows[1]!.includes("1h") && rows[1]!.includes("9 sections · 200 lines"), rows[1]);
  assert.ok(rows[2]!.includes("Short plan A") && rows[2]!.includes("3h") && rows[2]!.includes("1 section · "), rows[2]);
  assert.ok(text.includes("Plans"));
  assert.ok(lines.at(-1)!.includes("Esc close"));
});

test("an empty plans directory shows the dim line (en and ja)", async () => {
  for (const [lang, line] of [["en", "No plans in ~/.claude/plans"], ["ja", "~/.claude/plans に計画はありません"]] as const) {
    const app = stubbed([]);
    app.lang = lang;
    const { text } = await openList(app);
    assert.ok(text.includes(line), text);
  }
});

test("Esc and p close the list; q still quits", async () => {
  const app = stubbed();
  await openList(app);
  press(app, esc);
  assert.equal(app.mode, "normal");
  await openList(app);
  press(app, ch("p"));
  assert.equal(app.mode, "normal");
  await openList(app);
  assert.deepEqual(press(app, ch("q")), [{ type: "quit" }]);
});

test("Enter on the long plan: folded rows, contents and the read-only header; no buttons", async () => {
  const app = stubbed();
  await openList(app);
  press(app, ch("j"), enter);
  await tick();
  const { text, lines } = draw(app, 140, 400);
  assert.equal(app.mode, "planview");
  assert.ok(lines[0]!.includes("Plan (read only)") && lines[0]!.includes("9 sections · 200 lines · 12 files") && lines[0]!.includes("b.md"), lines[0]);
  assert.ok(lines[1]!.includes("Export retry"), lines[1]);
  const heads = text.split("\n").map((l) => l.split(" │ ")[0]!).filter((l) => /^\s*[▸▾] [☐☑] .+ \(\d+ lines\)/.test(l));
  assert.equal(heads.length, 9, "the H3 rows of folded sections are hidden");
  assert.equal(heads.filter((h) => h.trim().startsWith("▾")).length, 1);
  const toc = text.split("\n").map((l) => l.split(" │ ")[1] ?? "").filter((l) => /[☐☑]/.test(l));
  assert.equal(toc.length, 15);
  for (const word of ["Approve", "Reject", "Free text", "None of these", "Can't answer", "[y]"]) assert.ok(!text.includes(word), word);
  assert.ok(text.includes("j/k Contents · Enter Open · o All · [ ] Section"));
  assert.ok(lines.at(-1)!.includes("Esc back"), "the footer says how to go back");
});

test("plan view in ja: header and hint words", async () => {
  const app = stubbed();
  app.lang = "ja";
  await openList(app);
  press(app, ch("j"), enter);
  await tick();
  const { text, lines } = draw(app);
  assert.ok(lines[0]!.includes("計画(読むだけ)") && lines[0]!.includes("9 節 · 200 行 · 12 ファイル"), lines[0]);
  assert.ok(text.includes("j/k 目次") && lines.at(-1)!.includes("Esc 戻る"));
});

test("o opens everything; Enter folds the section under the cursor; y a n do nothing", async () => {
  const app = stubbed();
  await openList(app);
  press(app, ch("j"), enter);
  await tick();
  press(app, ch("o"));
  assert.equal(draw(app, 140, 400).text.split("\n").map((l) => l.split(" │ ")[0]!).filter((l) => /^\s*▾ [☐☑] /.test(l)).length, 15);
  press(app, ch("o"));
  assert.equal(draw(app, 140, 400).text.split("\n").map((l) => l.split(" │ ")[0]!).filter((l) => /^\s*▾ [☐☑] /.test(l)).length, 0);
  for (const k of ["y", "a", "n"]) assert.deepEqual(press(app, ch(k)), []);
  assert.equal(app.mode, "planview");
  // j moves the contents cursor to the second row, Enter opens it
  press(app, ch("j"), enter);
  assert.equal(draw(app, 140, 400).text.split("\n").map((l) => l.split(" │ ")[0]!).filter((l) => /^\s*▾ [☐☑] /.test(l)).length, 1);
});

test("Esc goes back to the list, a second Esc closes it", async () => {
  const app = stubbed();
  await openList(app);
  press(app, enter);
  await tick();
  assert.equal(app.mode, "planview");
  press(app, esc);
  assert.equal(app.mode, "plans");
  assert.ok(draw(app).text.includes("Short plan C"));
  press(app, esc);
  assert.equal(app.mode, "normal");
  assert.ok(draw(app).text.includes("No pending decisions"));
});

test("a short plan shows the whole document with no contents", async () => {
  const app = stubbed();
  await openList(app);
  press(app, enter); // Short plan C: 2 H2
  await tick();
  const { text, lines } = draw(app);
  assert.ok(lines[0]!.includes("Plan (read only)") && lines[0]!.includes("c.md") && !lines[0]!.includes("sections"), lines[0]);
  assert.ok(text.includes("More.") && !text.includes("Contents"));
  assert.ok(!/[☐☑]/.test(text));
});

test("works at 100x24 stacked: the list, the plan and the hint", async () => {
  const app = stubbed();
  await openList(app, 100, 24);
  press(app, ch("j"), enter);
  await tick();
  const { text, lines } = draw(app, 100, 24);
  assert.ok(!text.includes(" │ "), "one column");
  assert.ok(lines[0]!.includes("Plan (read only)"));
  assert.ok(text.includes("Contents") && lines.at(-1)!.includes("Esc back"));
  assert.ok(!text.includes("Approve"));
});

test("with a pending decision: p overlays it and Esc returns with the cursor where it was; a decision arriving meanwhile waits", async () => {
  const app = stubbed();
  app.upsert(decision({ id: "q1" }), clock);
  draw(app);
  press(app, ch("j"));
  const before = draw(app).text;
  await openList(app);
  press(app, ch("j"), enter);
  await tick();
  // a second decision arrives while the plan is open: the plan stays
  app.upsert(decision({ id: "q2", tool_use_id: "t2", created_at: "2026-10-02T00:01:00.000Z" }), clock);
  assert.equal(app.mode, "planview");
  const view = draw(app);
  assert.ok(view.text.includes("Plan (read only)") && view.text.includes("Pending 2"), "pending indicator in the footer");
  press(app, esc, esc);
  assert.equal(app.mode, "normal");
  assert.equal(app.shownId, "q1");
  assert.equal(draw(app).text.replace(/Pending \d/, "").includes("Should notifications use SSE"), true);
  assert.equal(draw(app).text.split("\n").find((l) => l.includes("▸")), before.split("\n").find((l) => l.includes("▸")));
});

test("a pending decision that is answered elsewhere while a plan is open does not change the plan view", async () => {
  const app = stubbed();
  app.upsert(decision({ id: "q1" }), clock);
  await openList(app);
  press(app, ch("j"), enter);
  await tick();
  const before = draw(app).text;
  app.upsert(decision({ id: "q1", status: "answered" }), clock);
  assert.equal(draw(app).text.replace(/Pending \d+  ?/, ""), before.replace(/Pending \d+  ?/, ""));
  press(app, esc, esc);
  assert.equal(app.shownId, null);
});

test("refresh: the list re-fetches; the plan re-fetches with ?since and rebuilds only on a change", async () => {
  const calls: string[] = [];
  const app = stubbed(LIST, calls);
  await openList(app);
  calls.length = 0;
  await app.refreshPlans();
  assert.deepEqual(calls, ["list"]);
  press(app, ch("j"), enter);
  await tick();
  press(app, ch("o"));
  calls.length = 0;
  await app.refreshPlans();
  assert.deepEqual(calls, [`plan:b.md:${FILES["b.md"]!.mtime}`]);
  // unchanged (304): the open state stays
  assert.equal(draw(app, 140, 400).text.split("\n").map((l) => l.split(" │ ")[0]!).filter((l) => /^\s*▾ [☐☑] /.test(l)).length, 15);
  // same headings, new text: the open state stays; changed headings: it starts over
  FILES["b.md"] = { ...FILES["b.md"]!, mtime: ago(1000), markdown: LONG.replace("Retry export jobs", "Retry export jobs!") };
  await app.refreshPlans();
  assert.equal(draw(app, 140, 400).text.split("\n").map((l) => l.split(" │ ")[0]!).filter((l) => /^\s*▾ [☐☑] /.test(l)).length, 15);
  FILES["b.md"] = { ...FILES["b.md"]!, mtime: ago(500), markdown: LONG.replace("## Context", "## Background") };
  await app.refreshPlans();
  assert.equal(draw(app, 140, 400).text.split("\n").map((l) => l.split(" │ ")[0]!).filter((l) => /^\s*▾ [☐☑] /.test(l)).length, 1);
});

test("TUI and GUI use the same words for the plan browser", async () => {
  const { MESSAGES: GUI } = (await import(new URL("../../public/i18n.js", import.meta.url).href)) as { MESSAGES: Record<"en" | "ja", Record<string, string>> };
  for (const lang of ["en", "ja"] as const) {
    for (const k of ["plans_title", "plans_empty", "plan_readonly", "plan_sections", "plan_sections_one", "plan_lines", "plan_lines_one", "plan_files", "plan_files_one"] as const) {
      assert.equal(MESSAGES[lang][k], GUI[lang]![k], `${lang}.${k}`);
    }
    assert.equal(MESSAGES[lang].footer_plans_key, `p ${GUI[lang]!.hint_plans}`);
  }
});
