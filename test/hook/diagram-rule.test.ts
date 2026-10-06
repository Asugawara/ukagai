import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { codexContextText, contextText } from "../../src/hook/context-hooks.js";
import { planContextText } from "../../src/hook/plan-context.js";

const SHOWS =
  "Draw a diagram only when it shows something the Options table cannot: a sequence of 3 or more steps between 2 or more actors, a state machine with 4 or more states, or a data flow between 3 or more components (a flowchart needs 5 or more nodes).";
const NEVER =
  "Never draw the options themselves as nodes (a branch into A / B / C) and never restate the table; at most one diagram; when in doubt, none.";
const REQUIRED =
  'When the decision is not reversible or the scope is machine / external, a diagram that meets this rule is required; if none does, write none and say why in one line under Options ("No diagram: <why>").';

const skill = readFileSync(fileURLToPath(new URL("../../skills/ukagai-explain/SKILL.md", import.meta.url)), "utf8");

// Each assertion fails when the sentence it names is removed from that text.
for (const [name, text] of [
  ["contextText (claude)", contextText("/d")],
  ["contextText (codex)", codexContextText("/d")],
  ["planContextText", planContextText(null)],
  ["SKILL.md", skill],
] as const) {
  test(`${name} carries the diagram rule`, () => {
    assert.ok(text.includes(SHOWS), "the 'only when it shows something the Options table cannot' sentence");
    assert.ok(text.includes(NEVER), "the 'never draw the options as nodes' sentence");
    assert.ok(text.includes(REQUIRED), "the 'required / No diagram: <why>' sentence");
  });
}

test("the old 'options differ in structure or flow' wording is gone from the hook texts", () => {
  for (const t of [contextText("/d"), codexContextText("/d")]) assert.ok(!t.includes("and the options differ in structure or flow"));
});
