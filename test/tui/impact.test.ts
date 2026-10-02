import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../../src/tui/app.js";
import { buildModel } from "../../src/tui/model.js";
import { render } from "../../src/tui/render.js";
import { stripAnsi } from "../../src/tui/width.js";
import { decision } from "./helpers.js";

const dot = { name: "char", ch: "." } as const;

const NOW = Date.parse("2026-10-02T00:00:30.000Z");
const planDecision = (plan: string) =>
  decision({ kind: "approve_plan", request: { plan, planFilePath: "/p" } } as never);

test("plan model: the 'Scope and reversibility' section is picked up (present / absent / partial heading / Japanese alias)", () => {
  const withSec = buildModel(planDecision("# P\n\n## Scope and reversibility\n\n- scope: repo\n\n## Steps\n\n1. x\n"));
  assert.equal(withSec.impact, "- scope: repo");
  assert.equal(buildModel(planDecision("# P\n\n## Steps\n\n1. x\n")).impact, null);
  const partial = buildModel(planDecision("# P\n\n## Steps\n\n1. x\n\n## Scope and reversibility notes\n\n- undoable\n"));
  assert.equal(partial.impact, "- undoable");
  const exact = buildModel(planDecision("# P\n\n## Scope and reversibility: addendum\n\n- partial\n\n## Scope and reversibility\n\n- exact\n"));
  assert.equal(exact.impact, "- exact");
  const ja = buildModel(planDecision("# P\n\n## 手順\n\n1. x\n\n## 影響範囲と可逆性\n\n- 戻せる\n"));
  assert.equal(ja.impact, "- 戻せる");
});

test("render: the impact box appears above the y button, and not without the section", () => {
  const app = new App();
  app.upsert(planDecision("# P\n\n## Scope and reversibility\n\n- scope: repo\n- reversible\n"), NOW);
  const lines = stripAnsi(render(app.view(NOW), { cols: 140, rows: 40 })).split("\n");
  const imp = lines.findIndex((l) => l.includes("Scope and reversibility") && l.includes("┌"));
  const y = lines.findIndex((l) => l.includes("[y] Approve"));
  assert.ok(imp >= 0 && y > imp, `imp=${imp} y=${y}`);
  assert.ok(lines.some((l) => l.includes("scope: repo")));

  const none = new App();
  none.upsert(planDecision("# P\n\n## Steps\n\n1. x\n"), NOW);
  const out = stripAnsi(render(none.view(NOW), { cols: 140, rows: 40 }));
  assert.ok(!out.includes("┌─ Scope and reversibility"));
});

test("more than 8 lines are folded; '.' shows the full text, '.' again folds", () => {
  const items = Array.from({ length: 14 }, (_, i) => `- item${i}`).join("\n");
  const app = new App();
  app.upsert(planDecision(`# P\n\n## Scope and reversibility\n\n${items}\n`), NOW);
  const show = () => stripAnsi(render(app.view(NOW), { cols: 140, rows: 60 }));
  let out = show();
  // The plan body is also shown in the background (left), so count occurrences for the box on the right
  const count = (t: string, k: string) => t.split(k).length - 1;
  assert.equal(count(out, "item7"), 2);
  assert.equal(count(out, "item8"), 1);
  assert.ok(out.includes("(. to expand)"));
  app.handle(dot, NOW);
  out = show();
  assert.equal(count(out, "item13"), 2);
  assert.ok(out.includes("(. to collapse)"));
  app.handle(dot, NOW);
  assert.equal(count(show(), "item13"), 1);
});
