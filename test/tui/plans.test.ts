// Plans flow in like questions (PL3c): a new plan arrives by itself, Esc is Done reading, a live update marks only the changed sections,
// the approval of the same plan upgrades the screen in place. No network: the App's fetcher and effect sink are stubbed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { App, type Effect } from "../../src/tui/app.js";
import type { PlanFile, PlanSummary } from "../../src/tui/api.js";
import type { Key } from "../../src/tui/keys.js";
import { MESSAGES } from "../../src/tui/i18n.js";
import { renderFrame } from "../../src/tui/render.js";
import { planOutline, sectionHashes } from "../../src/tui/plan.js";
import { sectionsOf } from "../../src/serve/plans.js";
import { stripAnsi } from "../../src/tui/width.js";
import { decision } from "./helpers.js";

const LONG = readFileSync(new URL("../gui/fixtures/long-plan.md", import.meta.url), "utf8");
const SHORT_C = "# Short plan C\n\n## One\n\nText.\n\n## Two\n\nMore.\n";
const ch = (c: string): Key => ({ name: "char", ch: c });
const enter: Key = { name: "enter" };
const esc: Key = { name: "esc" };
const tab: Key = { name: "tab" };
let clock = Date.parse("2026-10-03T12:00:00.000Z");
const press = (app: App, ...keys: Key[]) => keys.flatMap((k) => app.handle(k, (clock += 10)));
const tick = () => new Promise((r) => setTimeout(r, 5));
const ago = (ms: number) => new Date(clock - ms).toISOString();

function file(name: string, title: string, markdown: string, ageMs: number): PlanFile {
  return { name, title, mtime: ago(ageMs), markdown };
}
function summary(f: PlanFile, read = false): PlanSummary {
  const o = planOutline(f.markdown);
  return { name: f.name, title: f.title, mtime: f.mtime, bytes: f.markdown.length, sections: o.h2, lines: o.lines, read };
}

let FILES: Record<string, PlanFile>;
let fetched: string[];

/** An App with stubbed plan fetching; `effects` collects what would be POSTed outside a key press */
function setup(): { app: App; effects: Effect[] } {
  FILES = {
    "b.md": file("b.md", "Export retry", LONG, 3600_000),
    "c.md": file("c.md", "Short plan C", SHORT_C, 5 * 60_000),
    "old.md": file("old.md", "Old plan", SHORT_C, 30 * 3600_000),
  };
  fetched = [];
  const app = new App();
  const effects: Effect[] = [];
  app.onEffect = (e) => effects.push(...e);
  app.fetchPlan = async (name, since) => {
    fetched.push(name);
    const f = FILES[name]!;
    return since === f.mtime ? null : f;
  };
  return { app, effects };
}

function draw(app: App, cols = 140, rows = 50) {
  let frame = renderFrame(app.view(clock), { cols, rows });
  if (app.syncFrame(frame, clock)) frame = renderFrame(app.view(clock), { cols, rows });
  return { text: stripAnsi(frame.text), lines: frame.lines.map(stripAnsi) };
}

const foldedRows = (text: string) => text.split("\n").map((l) => l.split(" │ ")[0]!).filter((l) => /^\s*[▸▾] [☐☑] .+ \(\d+ lines\)/.test(l));

/** The plan b.md arrives while idle and comes up by itself */
async function arrive(app: App, name = "b.md") {
  app.planUpdated(summary(FILES[name]!), clock);
  await tick();
}

test("a new plan arriving on the idle screen comes up by itself: header, folded rows, no buttons; y a n do nothing (en and ja)", async () => {
  const { app, effects } = setup();
  await arrive(app);
  assert.equal(app.shownPlan, "b.md");
  const { text, lines } = draw(app, 140, 400);
  assert.ok(lines[0]!.includes("Export retry"), lines[0]);
  assert.ok(lines[1]!.includes("Plan") && lines[1]!.includes("updated 1h") && lines[1]!.includes("9 sections · 200 lines · 12 files") && lines[1]!.includes("b.md"), lines[1]);
  assert.ok(!/read only/i.test(text));
  const heads = foldedRows(text);
  assert.equal(heads.length, 9, "the H3 rows of folded sections are hidden");
  assert.equal(heads.filter((h) => h.trim().startsWith("▾")).length, 1, "the first H2 is open");
  const toc = text.split("\n").map((l) => l.split(" │ ")[1] ?? "").filter((l) => /[☐☑]/.test(l));
  assert.equal(toc.length, 15);
  assert.ok(text.includes("Done reading (Esc)"));
  for (const word of ["Approve", "Reject", "Free text", "None of these", "Can't answer", "[y]"]) assert.ok(!text.includes(word), word);
  assert.ok(text.includes("Pending 1"), "a new plan is counted");
  const posted = effects.length;
  for (const k of ["y", "a", "n"]) assert.deepEqual(press(app, ch(k)), []);
  assert.equal(effects.length, posted);
  assert.equal(app.shownPlan, "b.md");

  const ja = setup();
  ja.app.lang = "ja";
  await arrive(ja.app);
  const jd = draw(ja.app, 140, 400);
  assert.ok(jd.lines[1]!.includes("計画") && jd.lines[1]!.includes("更新 1") && jd.lines[1]!.includes("9 節 · 200 行 · 12 ファイル"), jd.lines[1]);
  assert.ok(jd.text.includes("読んだ (Esc)"));
});

test("Esc is Done reading: the read POST, then the idle screen with no plan on it", async () => {
  const { app, effects } = setup();
  await arrive(app);
  const out = press(app, esc);
  assert.deepEqual(out, [{ type: "read", name: "b.md", mtime: FILES["b.md"]!.mtime }]);
  assert.equal(app.shownPlan, null);
  const { text } = draw(app);
  assert.ok(text.includes("No pending decisions") && !text.includes("Recent plans") && !text.includes("Export retry"));
  assert.equal(app.count(clock), 0);
  assert.deepEqual(effects, []);
});

test("live update: a changed section turns unread with `updated`, unchanged ones keep their state, the scroll stays", async () => {
  const { app } = setup();
  await arrive(app);
  press(app, ch("o"));
  assert.equal(foldedRows(draw(app, 140, 30).text).filter((h) => h.trim().startsWith("▾")).length > 0, true);
  press(app, tab, { name: "pgdn" });
  draw(app, 140, 30);
  const scrolled = app.scroll;
  assert.ok(scrolled > 0, "scrolled down");
  // Only Rollout changes; the other sections are byte for byte the same
  FILES["b.md"] = { ...FILES["b.md"]!, mtime: ago(1000), markdown: LONG.replace("## Rollout\n", "## Rollout\n\nA new rollout note.\n") };
  app.planUpdated(summary(FILES["b.md"]), clock);
  await tick();
  draw(app, 140, 30);
  assert.equal(app.scroll, scrolled);
  const after = draw(app, 140, 400);
  const rows = foldedRows(after.text);
  const rollout = rows.find((r) => r.includes("Rollout"))!;
  assert.ok(rollout.includes("☐") && rollout.includes("updated") && rollout.trim().startsWith("▾"), "changed and open before: still open, unread, updated: " + rollout);
  assert.equal(rows.filter((r) => r.includes("updated")).length, 1, "only the changed section");
  assert.equal(rows.filter((r) => r.includes("☑")).length, 14, "the others stay read");
  assert.equal(rows.filter((r) => r.trim().startsWith("▾")).length, 15, "all stay open, the changed one too");
  // Opening it clears the word
  const i = app.view(clock).plan!;
  assert.equal(i.updated.size, 1);
  press(app, tab); // focus back to the decision column (j/k move the contents cursor)
  const idx = planOutline(FILES["b.md"].markdown).entries.findIndex((e) => e.plain === "Rollout");
  while (app.view(clock).plan!.cur !== idx) press(app, ch("j"));
  press(app, enter); // it is open already: Enter folds it, the next Enter opens it again and clears the word
  assert.equal(app.view(clock).plan!.updated.size, 1);
  press(app, enter);
  assert.equal(app.view(clock).plan!.updated.size, 0);
  assert.ok(!foldedRows(draw(app, 140, 400).text).some((r) => r.includes("updated")));
});

test("live update: a changed section that was folded stays folded (unread, updated)", async () => {
  const { app } = setup();
  await arrive(app);
  assert.ok(foldedRows(draw(app, 140, 400).text).find((r) => r.includes("Rollout"))!.trim().startsWith("▸"), "Rollout starts folded");
  FILES["b.md"] = { ...FILES["b.md"]!, mtime: ago(1000), markdown: LONG.replace("## Rollout\n", "## Rollout\n\nA new rollout note.\n") };
  app.planUpdated(summary(FILES["b.md"]), clock);
  await tick();
  const rollout = foldedRows(draw(app, 140, 400).text).find((r) => r.includes("Rollout"))!;
  assert.ok(rollout.trim().startsWith("▸") && rollout.includes("☐") && rollout.includes("updated"), rollout);
});

test("live update with no change in the text only ticks the age (the summary alone does not refetch)", async () => {
  const { app } = setup();
  await arrive(app);
  fetched.length = 0;
  app.planUpdated({ ...summary(FILES["b.md"]!), read: true }, clock); // a read mark from another UI: same mtime
  await tick();
  assert.deepEqual(fetched, []);
  assert.equal(app.shownPlan, "b.md");
});

test("decision precedence: a decision takes the screen (Pending 2); ] is the plan, [ the decision; answered leaves the plan", async () => {
  const { app } = setup();
  await arrive(app);
  app.upsert(decision({ id: "q1" }), clock);
  assert.equal(app.shownId, "q1");
  assert.equal(app.shownPlan, null);
  assert.ok(draw(app).text.includes("Pending 2"));
  press(app, ch("]"));
  assert.equal(app.shownPlan, "b.md");
  assert.equal(app.shownId, null);
  press(app, ch("["));
  assert.equal(app.shownId, "q1");
  app.upsert(decision({ id: "q1", status: "answered" }), clock);
  assert.equal(app.shownPlan, "b.md", "the plan is next");
});

test("upgrade in place: the approval of the shown plan keeps the folding state, shows the buttons, is one list row; answering marks the plan read", async () => {
  const { app, effects } = setup();
  await arrive(app);
  press(app, tab, ch("]"), ch("]"));
  const open = [...app.view(clock).plan!.open].sort();
  assert.ok(open.length >= 3, "three sections open");
  const ap = decision({ id: "ap", kind: "approve_plan", request: { plan: LONG, planFilePath: "/Users/a/.claude/plans/b.md" } } as never);
  app.upsert(ap, clock);
  assert.equal(app.shownId, "ap");
  assert.equal(app.shownPlan, null);
  const { text } = draw(app, 140, 400);
  assert.ok(text.includes("Approve this plan?") && text.includes("Approve") && text.includes("Reject"));
  assert.deepEqual([...app.view(clock).plan!.open].sort(), open, "open sections carried over");
  assert.equal(app.view(clock).list, null);
  press(app, ch("b"));
  assert.equal(app.view(clock).list!.items.length, 1, "the plan and its approval are one row");
  press(app, esc);
  assert.equal(app.count(clock), 1, "one item, counted once");
  // The unread line reflects what was read; it never blocks: one y sends
  assert.ok(draw(app, 140, 50).text.includes("Unread sections (6)"));
  const out = press(app, ch("y"));
  assert.deepEqual(out, [{ type: "answer", id: "ap", body: { approve: true, set_mode_auto: true } }]);
  app.answered({ ...ap, status: "answered" } as never, clock);
  assert.deepEqual(effects, [{ type: "read", name: "b.md", mtime: FILES["b.md"]!.mtime }]);
  assert.equal(app.shownPlan, null, "the plan is read, so nothing is next");
});

test("a plan with a pending approval is not shown or counted twice", async () => {
  const { app } = setup();
  app.upsert(decision({ id: "ap", kind: "approve_plan", request: { plan: LONG, planFilePath: "/x/b.md" } } as never), clock);
  app.planUpdated(summary(FILES["b.md"]!), clock);
  await tick();
  assert.equal(app.shownId, "ap");
  assert.equal(app.count(clock), 1);
});

test("the idle screen shows no plan row: a read plan and a plan unread for 30 hours are not listed anywhere", async () => {
  const { app } = setup();
  app.planUpdated(summary(FILES["old.md"]!), clock);
  app.planUpdated(summary(FILES["c.md"]!, true), clock);
  await tick();
  assert.equal(app.shownPlan, null);
  assert.equal(app.count(clock), 0);
  const { text } = draw(app);
  assert.ok(text.includes("No pending decisions"));
  assert.ok(!text.includes("Old plan") && !text.includes("Short plan C") && !text.includes("Recent plans"));
  press(app, ch("j"), enter);
  assert.equal(app.shownPlan, null);
  // a new one still shows by itself
  FILES["n.md"] = file("n.md", "Fresh plan", SHORT_C, 60_000);
  app.planUpdated(summary(FILES["n.md"]), clock);
  await tick();
  assert.equal(app.shownPlan, "n.md");
});

test("a plan removed while shown goes to the idle screen without a word", async () => {
  const { app } = setup();
  await arrive(app);
  app.planRemoved("b.md", clock);
  assert.equal(app.shownPlan, null);
  const { text } = draw(app);
  assert.ok(text.includes("No pending decisions") && !text.includes("Export retry"));
});

test("p does nothing (the plan browser is gone) and the footer has no p hint", async () => {
  const { app } = setup();
  assert.deepEqual(press(app, ch("p")), []);
  assert.equal(app.mode, "normal");
  app.upsert(decision({ id: "q1" }), clock);
  assert.deepEqual(press(app, ch("p")), []);
  assert.ok(!draw(app).lines.at(-1)!.includes("p Plans"));
});

test("works at 100x24 stacked: the plan screen and the idle screen", async () => {
  const { app } = setup();
  await arrive(app);
  const { text, lines } = draw(app, 100, 24);
  assert.ok(!text.includes(" │ "), "one column");
  assert.ok(lines[0]!.includes("Export retry") && lines[1]!.includes("Plan"));
  assert.ok(text.includes("Contents") && text.includes("Done reading (Esc)"));
  assert.ok(!text.includes("Approve"));
  press(app, esc);
  const idle = draw(app, 100, 24);
  assert.ok(idle.text.includes("No pending decisions") && !idle.text.includes("Export retry"));
});

test("a short plan shows the whole document with no contents", async () => {
  const { app } = setup();
  await arrive(app, "c.md");
  const { text, lines } = draw(app);
  assert.ok(lines[1]!.includes("Plan") && lines[1]!.includes("c.md") && !lines[1]!.includes("sections"), lines[1]);
  assert.ok(text.includes("More.") && !text.includes("Contents") && text.includes("Done reading (Esc)"));
  assert.ok(!/[☐☑]/.test(text));
});

test("the list (b) holds decisions first, then new plans newest first with the `plan` word and the dot", async () => {
  const { app } = setup();
  app.planUpdated(summary(FILES["old.md"]!), clock);
  await arrive(app, "c.md");
  app.upsert(decision({ id: "q1" }), clock);
  press(app, ch("b"));
  const { lines } = draw(app);
  const titles = lines.filter((l) => /^ ?[▸ ] /.test(l) && !l.startsWith("      ")).map((l) => l.trim());
  assert.ok(titles[0]!.includes("Should notifications") || titles[0]!.includes("SSE"), titles[0]);
  const plan = lines.findIndex((l) => l.includes("●") && l.includes("Short plan C"));
  assert.ok(plan > 0);
  assert.ok(lines[plan + 1]!.includes("plan") && lines[plan + 1]!.includes("2 sections"), lines[plan + 1]);
  assert.ok(!lines.some((l) => l.includes("Old plan")), "a plan unread for 30 hours is not in the list");
});

test("section hashes computed in the TUI equal the server's", () => {
  const ours = sectionHashes(planOutline(LONG), LONG);
  assert.deepEqual(ours, sectionsOf(LONG).map((s) => s.hash));
});

test("TUI and GUI use the same words for plans", async () => {
  const { MESSAGES: GUI } = (await import(new URL("../../public/i18n.js", import.meta.url).href)) as { MESSAGES: Record<"en" | "ja", Record<string, string>> };
  const table = {
    plan_kind: ["plan", "計画"],
    plan_updated_ago: ["updated {age}", "更新 {age}"],
    plan_done_reading: ["Done reading", "読んだ"],
    plan_section_updated: ["updated", "更新"],
  } as const;
  for (const [k, [en, ja]] of Object.entries(table)) {
    assert.equal(MESSAGES.en[k as keyof typeof MESSAGES.en], en, `en.${k}`);
    assert.equal(MESSAGES.ja[k as keyof typeof MESSAGES.ja], ja, `ja.${k}`);
    // The GUI side adds the same keys in its own brief; compare once it has them
    for (const [lang, want] of [["en", en], ["ja", ja]] as const) if (GUI[lang]![k] !== undefined) assert.equal(GUI[lang]![k], want, `gui ${lang}.${k}`);
  }
  for (const lang of ["en", "ja"] as const) {
    for (const k of ["plan_sections", "plan_sections_one", "plan_lines", "plan_lines_one", "plan_files", "plan_files_one"] as const) assert.equal(MESSAGES[lang][k], GUI[lang]![k], `${lang}.${k}`);
  }
});
