// Instruct from a plan: the instruction card is always there (no `i` needed) and opens by itself when the cursor lands on it, like the
// free-text card; `i` jumps to it; presets are picked with a digit while the box is empty;
// a plan file with a session sends through the plan endpoint (effect), without one it says why.
import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../../src/tui/app.js";
import { DEFAULT_SETTINGS, type PlanContent, type PlanSummary } from "../../src/contract.js";
import type { Key } from "../../src/tui/keys.js";
import { renderFrame } from "../../src/tui/render.js";
import { stripAnsi } from "../../src/tui/width.js";
import { decision } from "./helpers.js";

const ch = (c: string): Key => ({ name: "char", ch: c });
const enter: Key = { name: "enter" };
const esc: Key = { name: "esc" };
const up: Key = { name: "up" };
const down: Key = { name: "down" };
let clock = Date.parse("2026-10-05T12:00:00.000Z");
const press = (app: App, ...keys: Key[]) => keys.flatMap((k) => app.handle(k, (clock += 10)));
const type = (app: App, s: string) => press(app, ...[...s].map(ch));
const draw = (app: App) => {
  let frame = renderFrame(app.view(clock), { cols: 120, rows: 40 });
  if (app.syncFrame(frame, clock)) frame = renderFrame(app.view(clock), { cols: 120, rows: 40 });
  return { text: stripAnsi(frame.text), hint: stripAnsi(frame.text) };
};

function approval(presets: string[] = []): App {
  const app = new App();
  app.settingsUpdated({ ...DEFAULT_SETTINGS, plans: { auto_show: true, instruction_presets: presets } });
  app.replacePending([decision({ kind: "approve_plan", request: { plan: "# P\n\n## Scope and reversibility\n\nx", planFilePath: "/p" } } as never)], clock);
  return app;
}

test("approval: i opens the instruction input, Enter sends { instruct, text }; empty text sends nothing", () => {
  const app = approval();
  press(app, ch("i"));
  assert.deepEqual(press(app, enter), []); // empty
  type(app, "have Fable review it");
  assert.match(draw(app).text, /Instruction: have Fable review it/);
  assert.deepEqual(press(app, enter), [{ type: "answer", id: "d1", body: { instruct: true, text: "have Fable review it" } }]);
});

test("approval: Esc closes the box and keeps the text for the next i", () => {
  const app = approval();
  press(app, ch("i"));
  type(app, "draft");
  press(app, esc);
  assert.doesNotMatch(draw(app).text, /Instruction: draft▏/);
  press(app, ch("i"));
  assert.match(draw(app).text, /Instruction: draft▏/);
});

test("approval: a preset is picked with its digit while the box is empty, then Enter sends it; digits type once there is text", () => {
  const app = approval(["Review adversarially", "Add a rollback plan"]);
  press(app, ch("i"));
  const open = draw(app);
  assert.match(open.text, /1 Review adversarially/);
  assert.match(open.text, /2 Add a rollback plan/);
  assert.match(open.hint, /1-9 preset/);
  press(app, ch("2"));
  assert.match(draw(app).text, /Instruction: Add a rollback plan▏/);
  assert.deepEqual(press(app, enter), [{ type: "answer", id: "d1", body: { instruct: true, text: "Add a rollback plan" } }]);
  const again = approval(["one"]);
  press(again, ch("i"), ch("x"), ch("1"));
  assert.match(draw(again).text, /Instruction: x1▏/);
});

test("approval: the hint line lists i Instruct, the Instruct option is shown as 2", () => {
  const app = approval();
  const { text, hint } = draw(app);
  assert.match(hint, /i Instruct/);
  assert.match(text, /\[2\] Instruct/);
});

test("plan file: a session shows the box and sends through the plan endpoint; no session says why", async () => {
  const file = (session_id?: string): PlanContent => ({ name: "swift.md", title: "Swift", mtime: new Date(clock - 60_000).toISOString(), markdown: "# Swift\n\n## A\n\nx\n", read: false, ...(session_id ? { session_id } : {}) });
  const summary: PlanSummary = { name: "swift.md", title: "Swift", mtime: file().mtime, bytes: 20, sections: 1, lines: 5, read: false };
  for (const withSession of [true, false]) {
    const app = new App();
    app.fetchPlan = async () => file(withSession ? "s-live" : undefined);
    app.replacePlans([withSession ? { ...summary, session_id: "s-live" } : summary], clock);
    await new Promise((r) => setTimeout(r, 5));
    if (!withSession) {
      assert.equal(app.shownPlan, null, "a plan without a session does not come up by itself");
      press(app, ch("b"), enter); // opened by hand from the list
      await new Promise((r) => setTimeout(r, 5));
    }
    if (withSession) {
      assert.match(draw(app).text, /\[i\] Instruct/);
      press(app, ch("i"));
      type(app, "add tests");
      assert.deepEqual(press(app, enter), [{ type: "instruct_plan", name: "swift.md", text: "add tests" }]);
    } else {
      assert.match(draw(app).text, /The agent's session was not found/);
      press(app, ch("i"));
      assert.doesNotMatch(draw(app).text, /Instruction:/);
    }
  }
});

test("plan file: the draft survives a failed send, a second Enter while sending does nothing, success clears it", async () => {
  const file: PlanContent = { name: "swift.md", title: "Swift", mtime: new Date(clock - 60_000).toISOString(), markdown: "# Swift\n\n## A\n\nx\n", read: false, session_id: "s-live" };
  const summary: PlanSummary = { name: "swift.md", title: "Swift", mtime: file.mtime, bytes: 20, sections: 1, lines: 5, read: false, session_id: "s-live" };
  const app = new App();
  app.fetchPlan = async () => file;
  app.replacePlans([summary], clock);
  await new Promise((r) => setTimeout(r, 5));
  press(app, ch("i"));
  type(app, "add tests");
  assert.equal(press(app, enter).length, 1);
  press(app, ch("i"));
  assert.deepEqual(press(app, enter), [], "still sending");
  app.planInstructFailed("swift.md", "HTTP 409", clock);
  press(app, ch("i"));
  assert.match(draw(app).text, /Instruction: add tests▏/, "the failed send kept the text");
  assert.equal(press(app, enter).length, 1);
  app.planInstructed("swift.md", "hook", clock);
  press(app, ch("i"));
  assert.doesNotMatch(draw(app).text, /Instruction: add tests/);
});

test("approval: the options are one list, Approve (auto) / Instruct / Reject in that order; the cursor starts on Approve and nothing is typing", () => {
  const app = approval(["Review adversarially", "Add a rollback plan"]);
  const { text } = draw(app);
  assert.match(text, /\[2\] Instruct/);
  assert.match(text, /1 Review adversarially/);
  assert.match(text, /2 Add a rollback plan/);
  assert.match(text, /What should the agent do first\?/);
  const at = (s: string) => text.indexOf(s);
  assert.ok(at("[1] Approve (continue in auto mode)") >= 0, "Approve says auto mode");
  assert.ok(at("[1] Approve (continue in auto mode)") < at("[2] Instruct"), "Approve is first");
  assert.ok(at("[2] Instruct") < at("[3] Reject"), "Instruct sits between Approve and Reject");
  assert.match(text, /▸ \[1\] Approve/);
  assert.equal(app.mode, "normal");
  assert.equal(app.view(clock).cursor, 0, "the first render does not open the box; Approve is the cursor");
});

test("approval: ↓ from Approve lands on the Instruct card and opens the box; Esc leaves it keeping the text; ↓ with text stays in the box", () => {
  const app = approval();
  press(app, down);
  assert.equal(app.mode, "input");
  assert.equal(app.view(clock).input?.kind, "instruct");
  assert.equal(app.view(clock).cursor, 1);
  type(app, "draft");
  press(app, down);
  assert.equal(app.mode, "input", "with text the arrows stay in the box");
  assert.equal(app.view(clock).cursor, 1);
  press(app, esc);
  assert.equal(app.mode, "normal");
  assert.equal(app.view(clock).instruct, "draft");
  assert.match(draw(app).text, /Instruction: draft/);
  press(app, up);
  assert.equal(app.mode, "normal");
  assert.equal(app.view(clock).cursor, 0);
  press(app, down);
  assert.equal(app.mode, "input", "back on the card: the box opens with the kept text");
  assert.match(draw(app).text, /Instruction: draft▏/);
});

test("approval: ↓ in an empty box moves on to Reject and opens its reason box; ↑ in an empty reason box goes back to Instruct, then to Approve", () => {
  const app = approval();
  press(app, ch("i"));
  assert.equal(app.mode, "input");
  assert.equal(app.view(clock).cursor, 1);
  press(app, down);
  assert.equal(app.mode, "input");
  assert.equal(app.view(clock).input?.kind, "reason", "landing on Reject opens the reason box");
  assert.equal(app.view(clock).cursor, 2);
  press(app, up);
  assert.equal(app.view(clock).input?.kind, "instruct", "an empty reason box leaves; the cursor lands on Instruct, whose box opens");
  press(app, up);
  assert.equal(app.mode, "normal");
  assert.equal(app.view(clock).cursor, 0);
  assert.deepEqual(press(app, enter), [{ type: "answer", id: "d1", body: { approve: true, set_mode_auto: true } }], "Enter on Approve approves, in auto mode");
});

test("approval: Enter on the closed Instruct card opens the box and sends nothing", () => {
  const app = approval();
  press(app, down, esc);
  assert.equal(app.mode, "normal");
  assert.equal(app.view(clock).cursor, 1);
  assert.deepEqual(press(app, enter), []);
  assert.equal(app.mode, "input");
});

test("approval: i jumps to the card from anywhere and opens the box; y / n still approve / reject outside the box", () => {
  const app = approval();
  press(app, ch("n")); // Reject: the reason box
  assert.equal(app.view(clock).cursor, 2);
  press(app, esc);
  press(app, ch("i"));
  assert.equal(app.mode, "input");
  assert.equal(app.view(clock).input?.kind, "instruct");
  assert.equal(app.view(clock).cursor, 1);
  press(app, esc);
  assert.deepEqual(press(app, ch("y")), [{ type: "answer", id: "d1", body: { approve: true, set_mode_auto: true } }]);
  const b = approval();
  press(b, ch("n"));
  assert.equal(b.view(clock).input?.kind, "reason");
});

test("approval: Reject opens the reason box; Enter with a reason sends the rejection; Esc keeps the reason and Enter on Reject then sends it", () => {
  const app = approval();
  press(app, down, down); // Instruct (box opens), then the empty box leaves to Reject
  assert.equal(app.view(clock).input?.kind, "reason");
  assert.deepEqual(press(app, enter), [], "an empty reason sends nothing");
  type(app, "wrong approach");
  press(app, esc);
  assert.equal(app.mode, "normal");
  assert.equal(app.view(clock).reason, "wrong approach", "Esc kept the reason");
  assert.match(draw(app).text, /Reason: wrong approach/);
  assert.deepEqual(press(app, enter), [{ type: "answer", id: "d1", body: { approve: false, reason: "wrong approach" } }]);
  const again = approval();
  press(again, ch("n"));
  type(again, "no");
  assert.deepEqual(press(again, enter), [{ type: "answer", id: "d1", body: { approve: false, reason: "no" } }]);
});

test("approval: digits 1 / 2 / 3 act on Approve / Instruct / Reject at once", () => {
  assert.deepEqual(press(approval(), ch("1")), [{ type: "answer", id: "d1", body: { approve: true, set_mode_auto: true } }]);
  const b = approval();
  press(b, ch("2"));
  assert.equal(b.view(clock).input?.kind, "instruct");
  assert.equal(b.view(clock).cursor, 1);
  const c = approval();
  press(c, ch("3"));
  assert.equal(c.view(clock).input?.kind, "reason");
  assert.equal(c.view(clock).cursor, 2);
});

test("approval: in the box digits and letters are text once there is text; Enter on an empty box sends nothing", () => {
  const app = approval(["one", "two"]);
  press(app, down);
  assert.deepEqual(press(app, enter), []);
  type(app, "yn1");
  assert.match(draw(app).text, /Instruction: yn1▏/);
  assert.equal(press(app, enter).length, 1);
});

test("plan file with a session: the card is always there, no i needed; without a session it says why and there is no card", async () => {
  const file = (session_id?: string): PlanContent => ({ name: "swift.md", title: "Swift", mtime: new Date(clock - 60_000).toISOString(), markdown: "# Swift\n\n## A\n\nx\n", read: false, ...(session_id ? { session_id } : {}) });
  const summary: PlanSummary = { name: "swift.md", title: "Swift", mtime: file().mtime, bytes: 20, sections: 1, lines: 5, read: false };
  const app = new App();
  app.fetchPlan = async () => file("s-live");
  app.replacePlans([{ ...summary, session_id: "s-live" }], clock);
  await new Promise((r) => setTimeout(r, 5));
  assert.match(draw(app).text, /What should the agent do first\?/);
  assert.equal(app.mode, "normal");
  assert.match(draw(app).text, /\[i\] Instruct/, "the plan file's one card keeps the i key");
  press(app, ch("i"), ...[...("hi")].map(ch));
  assert.deepEqual(press(app, enter), [{ type: "instruct_plan", name: "swift.md", text: "hi" }]);
  const lone = new App();
  lone.fetchPlan = async () => file();
  lone.replacePlans([summary], clock);
  press(lone, ch("b"), enter);
  await new Promise((r) => setTimeout(r, 5));
  assert.doesNotMatch(draw(lone).text, /What should the agent do first\?/);
});
