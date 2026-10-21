// Which AskUserQuestion fields the TUI shows (test/support/question-fields.ts): each one is on the screen, or hidden for a stated reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../../src/tui/app.js";
import { renderFrame } from "../../src/tui/render.js";
import { stripAnsi } from "../../src/tui/width.js";
import { EXPLAINED_MD, FIELD_RULES, V, options } from "../support/question-fields.js";
import { decision, withExplanation } from "./helpers.js";

const NOW = Date.parse("2026-10-02T00:00:30.000Z");

function screen(explained: boolean, multiSelect = false, move = 0): string {
  const app = new App();
  app.upsert(decision({
    request: { questions: [{ question: V.question, header: V.header, multiSelect, options: options() }] },
    ...(explained ? withExplanation(EXPLAINED_MD) : {}),
  }), NOW);
  for (let i = 0; i < move; i++) app.handle({ name: "char", ch: "j" }, NOW);
  return stripAnsi(renderFrame(app.view(NOW), { cols: 100, rows: 200 }).text);
}

for (const mode of ["plain", "explained"] as const) {
  test(`TUI fields (${mode}): shown ones are on the screen, hidden ones are not`, () => {
    const text = screen(mode === "explained");
    for (const r of FIELD_RULES) {
      if (r[mode] === true) assert.ok(text.includes(r.word), `${r.field}: ${r.word} is not shown`);
      else assert.ok(!text.includes(r.word), `${r.field}: hidden (${r[mode]}) but ${r.word} is on the screen`);
    }
  });
}

test("TUI fields: the preview is under the cursor card only, tabs expanded, and moves with the cursor", () => {
  const first = screen(false);
  assert.ok(first.includes("FPREVALPHA first row"));
  assert.ok(first.includes("    FPREVTAB second row"), "the tab is four spaces");
  assert.ok(!first.includes("FPREVBETA") && !first.includes("FPREVGAMMA"));
  const second = screen(false, false, 1);
  assert.ok(second.includes("FPREVBETA") && !second.includes("FPREVALPHA"));
});

test("TUI fields: multiSelect draws checkboxes", () => {
  assert.ok(screen(false, true).includes("[ ] FBETA"));
  assert.ok(screen(false, false).includes("○ FBETA"));
});

test("TUI fields: a preview is cut at 12 rows with …, ANSI and CR are removed, a non-string preview is ignored", () => {
  const app = new App();
  const rows = Array.from({ length: 15 }, (_, i) => `ROW${i + 1}`).join("\r\n");
  app.upsert(decision({ request: { questions: [{ question: "Q?", header: "H", multiSelect: false, options: [
    { label: "One", description: "d", preview: `\x1b[31m${rows}\x1b[0m` },
    { label: "Two", description: "d", preview: 42 },
  ] }] } }), NOW);
  const text = stripAnsi(renderFrame(app.view(NOW), { cols: 100, rows: 200 }).text);
  assert.ok(text.includes("ROW12") && !text.includes("ROW13"), "12 rows");
  assert.ok(/\n\s+…\n/.test(text), "the cut ends in …");
  assert.ok(!text.includes("\r") && !text.includes("[31m"));
  app.handle({ name: "char", ch: "j" }, NOW);
  assert.ok(!stripAnsi(renderFrame(app.view(NOW), { cols: 100, rows: 200 }).text).includes("42"));
});
