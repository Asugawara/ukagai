// Instruct from a plan: `i` on an approval opens the instruction input; presets are picked with a digit while the box is empty;
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

test("approval: the hint line lists i Instruct, the third button is shown", () => {
  const app = approval();
  const { text, hint } = draw(app);
  assert.match(hint, /i Instruct/);
  assert.match(text, /\[i\] Instruct/);
});

test("plan file: a session shows the box and sends through the plan endpoint; no session says why", async () => {
  const file = (session_id?: string): PlanContent => ({ name: "swift.md", title: "Swift", mtime: new Date(clock - 60_000).toISOString(), markdown: "# Swift\n\n## A\n\nx\n", read: false, ...(session_id ? { session_id } : {}) });
  const summary: PlanSummary = { name: "swift.md", title: "Swift", mtime: file().mtime, bytes: 20, sections: 1, lines: 5, read: false };
  for (const withSession of [true, false]) {
    const app = new App();
    app.fetchPlan = async () => file(withSession ? "s-live" : undefined);
    app.replacePlans([summary], clock);
    await new Promise((r) => setTimeout(r, 5));
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
  const summary: PlanSummary = { name: "swift.md", title: "Swift", mtime: file.mtime, bytes: 20, sections: 1, lines: 5, read: false };
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
