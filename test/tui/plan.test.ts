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
const up: Key = { name: "up" };
const down: Key = { name: "down" };
const left: Key = { name: "left" };
const right: Key = { name: "right" };
const home: Key = { name: "home" };
const end: Key = { name: "end" };
let clock = 1000;
const press = (app: App, ...keys: Key[]) => keys.flatMap((k) => app.handle(k, (clock += 10)));
const type = (app: App, text: string) => press(app, ...[...text].map(ch));

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
const LONG_ENTRIES = planOutline(LONG).entries.length;
/** Rows of the left column that are section headings: `▸ ☐ Title (n lines)` */
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

test("plan (long): every H2 is folded to one row except the first, there is no contents list, and the plan zone starts on the first section", () => {
  const app = open();
  const { text, frame } = draw(app);
  const hs = headings(text);
  assert.equal(hs.filter((h) => h.startsWith("▾")).length, 1, hs.join("\n"));
  assert.match(hs[0]!, /^▾ ☑ Context \(\d+ lines\)/);
  assert.match(hs[1]!, /^▸ ☐ Changes \(/);
  assert.ok(!text.includes("Contents"), "no contents list");
  assert.equal(text.split("\n").map((l) => l.split(" │ ")[1] ?? "").filter((l) => /[☐☑] .+ \d+ lines/.test(l)).length, 0, "no contents rows in the decision column");
  // the plan zone is the start: the first section is selected (inverted) and the background column has the focus
  const v = app.view(clock);
  assert.equal(v.plan!.zone, "plan");
  assert.equal(v.plan!.cur, 0);
  assert.equal(v.focus, "background");
  assert.ok(frame.text.includes("\x1b[7mContext"), "the selected section is inverted");
  // the body of a closed section is not drawn
  assert.ok(!text.includes("Handler step 1"));
  assert.ok(text.includes("Context step 1"));
});

test("plan (long): j / k and ↑ / ↓ move the section selection and Enter opens the section; the body appears and the mark turns ☑", () => {
  const app = open();
  press(app, ch("j"));
  assert.equal(app.view(clock).plan!.cur, 1);
  let { text, frame } = draw(app);
  assert.ok(frame.text.includes("\x1b[7mChanges"), "Changes is selected");
  assert.ok(!text.includes("Three pieces change"), "moving does not open");
  press(app, enter);
  ({ text } = draw(app));
  assert.ok(text.includes("Three pieces change"), "Changes is open");
  assert.ok(headings(text).some((h) => /^▾ ☑ Changes/.test(h)), headings(text).join("\n"));
  // its H3 children are folded rows of their own
  assert.ok(headings(text).some((h) => /^▸ ☐ 1\. Backend usecase/.test(h)), headings(text).join("\n"));
  press(app, down);
  assert.equal(app.view(clock).plan!.cur, 2);
  press(app, up, up);
  assert.equal(app.view(clock).plan!.cur, 0);
  press(app, up);
  assert.equal(app.view(clock).plan!.cur, 0, "stays at the first");
  press(app, down, enter); // Enter again folds it (the mark stays ☑: it has been read)
  ({ text } = draw(app));
  assert.ok(!text.includes("Three pieces change"));
  assert.ok(headings(text).some((h) => /^▸ ☑ Changes/.test(h)));
  assert.deepEqual(press(app, enter, enter), [], "Enter in the plan zone never approves");
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

test("plan (long): Space folds too, Home / End / gg / G jump, and the background follows the selection", () => {
  const app = open();
  press(app, ch("o")); // everything open: the last section is far down
  const last = LONG_ENTRIES - 1;
  press(app, end);
  assert.equal(app.view(clock).plan!.cur, last);
  let d = draw(app, 140, 24);
  assert.ok(d.lines.some((l) => /[☐☑] Scope and reversibility/.test(l.split(" │ ")[0]!)), d.lines.join("\n"));
  assert.ok(d.frame.scrollMax > 0, "the background scrolled to it");
  press(app, home);
  assert.equal(app.view(clock).plan!.cur, 0);
  d = draw(app, 140, 24);
  assert.ok(d.lines.some((l) => /[▾▸] ☑ Context/.test(l.split(" │ ")[0]!)), d.lines.join("\n"));
  press(app, ch("G"));
  assert.equal(app.view(clock).plan!.cur, last);
  press(app, ch("g"), ch("g"));
  assert.equal(app.view(clock).plan!.cur, 0);
  press(app, ch("j"), { name: "char", ch: " " }); // Changes was open: Space folds it
  d = draw(app, 140, 24);
  assert.ok(/▸ ☑ Changes/.test(d.text), d.text);
  press(app, { name: "char", ch: " " });
  d = draw(app, 140, 24);
  assert.ok(/▾ ☑ Changes/.test(d.text));
});

test("plan (long): → goes to the options zone, ← back (h and l too, Tab switches); the hint, the column focus and the cursor mark follow the zone", () => {
  const app = open();
  let d = draw(app);
  assert.equal(app.view(clock).plan!.zone, "plan");
  assert.match(d.text, /j\/k Section · Enter Open · o All · → Options/);
  assert.doesNotMatch(d.text, /▸ \[1\] Approve/, "no option has the cursor in the plan zone");
  press(app, right);
  d = draw(app);
  assert.equal(app.view(clock).plan!.zone, "opts");
  assert.equal(app.view(clock).focus, "decision");
  assert.match(d.text, /▸ \[1\] Approve \(continue in auto mode\)/);
  assert.match(d.text, /j\/k Pick · Enter Decide · ← Plan/);
  assert.ok(!d.frame.text.includes("\x1b[7mContext"), "the section is no longer inverted");
  press(app, left);
  assert.equal(app.view(clock).plan!.zone, "plan");
  press(app, ch("l"));
  assert.equal(app.view(clock).plan!.zone, "opts");
  press(app, ch("h"));
  assert.equal(app.view(clock).plan!.zone, "plan");
  press(app, tab);
  assert.equal(app.view(clock).plan!.zone, "opts");
  press(app, tab);
  assert.equal(app.view(clock).plan!.zone, "plan");
  // in the options zone j / k move between the options, not the sections; the selection and the cursor are both remembered
  press(app, ch("j")); // plan zone: Changes
  press(app, right);
  assert.equal(app.view(clock).plan!.cur, 1);
  press(app, ch("j")); // Instruct: its box opens
  assert.equal(app.view(clock).plan!.cur, 1, "the section selection did not move");
  assert.equal(app.view(clock).cursor, 1);
  assert.equal(app.view(clock).input?.kind, "instruct");
  press(app, left); // ← in an empty box leaves for the plan zone
  assert.equal(app.mode, "normal");
  assert.equal(app.view(clock).plan!.zone, "plan");
  press(app, right); // the cursor was on Instruct: the box opens again
  assert.equal(app.view(clock).input?.kind, "instruct");
  type(app, "x");
  press(app, left); // with text ← does not leave
  assert.equal(app.view(clock).plan!.zone, "opts");
});

test("plan (long): Enter on Approve in the options zone sends { approve, set_mode_auto }; y and 1 do too from the plan zone", () => {
  const app = open();
  press(app, right);
  assert.deepEqual(press(app, enter), [{ type: "answer", id: "d1", body: { approve: true, set_mode_auto: true } }]);
  assert.deepEqual(press(open(), ch("y")), [{ type: "answer", id: "d1", body: { approve: true, set_mode_auto: true } }]);
  assert.deepEqual(press(open(), ch("1")), [{ type: "answer", id: "d1", body: { approve: true, set_mode_auto: true } }]);
  const n = open();
  press(n, ch("n"));
  assert.equal(n.view(clock).plan!.zone, "opts", "n puts the plan in the options zone");
  assert.equal(n.view(clock).input?.kind, "reason");
});

test("plan (long): the live selection and zone are kept when the plan text changes", () => {
  const app = open();
  press(app, ch("j"), ch("j"), right);
  const st = app.view(clock).plan!;
  assert.equal(st.cur, 2);
  assert.equal(st.zone, "opts");
  app.upsert({ ...planDecision(LONG.replace("Three pieces change; each is described below.", "Three pieces change; each is described below, once more.")), id: "d1" }, clock);
  draw(app);
  const after = app.view(clock).plan!;
  assert.equal(after.cur, 2, "the selected section stays");
  assert.equal(after.zone, "opts", "the zone stays");
});

test("plan (long): [ and ] switch pending decisions; h and l do not (they are the zone keys)", () => {
  const app = new App();
  app.upsert({ ...planDecision(LONG), id: "a", created_at: "2026-10-03T00:00:00Z" }, clock);
  app.upsert({ ...planDecision(LONG), id: "b", tool_use_id: "b", created_at: "2026-10-03T00:00:01Z" }, clock);
  draw(app);
  assert.equal(app.shownId, "a");
  press(app, ch("h"), ch("l"), left, right);
  assert.equal(app.shownId, "a", "h l ← → are the zone keys on a long plan");
  press(app, ch("]"));
  assert.equal(app.shownId, "b");
  press(app, ch("["));
  assert.equal(app.shownId, "a");
});

test("plan (long): one y sends at once with auto; the unread sections are one dim line above the buttons and update live; a does nothing", () => {
  const app = open();
  let { lines } = draw(app);
  const at = lines.findIndex((l) => l.includes("Unread sections (7): Changes, Split and owners"));
  const btn = lines.findIndex((l) => l.includes("[1] Approve")); // the options follow: Approve, Instruct, Reject
  assert.ok(at >= 0 && btn > at && lines.findIndex((l) => l.includes("[2] Instruct")) > btn && lines.findIndex((l) => l.includes("[3] Reject")) > btn, lines.join("\n"));
  assert.match(lines.slice(at, btn).map((l) => l.split(" │ ")[1] ?? "").join(" "), /Verification, Observation path \+2$/, "the line (wrapped) ends right above the options");
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
  assert.ok(text.includes("[1] 承認（auto モードで続行）") && text.includes("[3] 却下"), text);
  assert.ok(!text.includes("目次"));
  assert.ok(lines.length <= 24);
});

test("plan (long): the unread line is in Japanese", () => {
  const app = open();
  app.lang = "ja";
  const { lines } = draw(app);
  assert.ok(lines.some((l) => /未読 7 節: Changes/.test(l)));
  assert.ok(lines.some((l) => l.includes("[1] 承認（auto モードで続行）")));
});
