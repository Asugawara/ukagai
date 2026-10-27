import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../../src/tui/app.js";
import { buildModel } from "../../src/tui/model.js";
import { initialPlanState, planOutline } from "../../src/tui/plan.js";
import { render } from "../../src/tui/render.js";
import { stripAnsi } from "../../src/tui/width.js";
import { V2_MD, decision, withExplanation } from "./helpers.js";

const NOW = Date.parse("2026-10-02T00:00:30.000Z");
const planDecision = (plan: string) =>
  decision({ kind: "approve_plan", request: { plan, planFilePath: "/p" } } as never);
const count = (text: string, needle: string) => text.split(needle).length - 1;

test("the right column of a plan never has a 'Scope and reversibility' box (the section is in the left column)", () => {
  const app = new App();
  app.upsert(planDecision("# P\n\n## Steps\n\n1. x\n\n## Scope and reversibility\n\n- scope: repo\n- reversible\n"), NOW);
  const out = stripAnsi(render(app.view(NOW), { cols: 140, rows: 40 }));
  assert.ok(!out.includes("┌─ Scope and reversibility"));
});

test("the scope section starts open and read wherever it is in a long plan (here the last H2)", () => {
  const filler = Array.from({ length: 45 }, (_, i) => `- step ${i}`).join("\n");
  const o = planOutline(`# P\n\n## Context\n\nA.\n\n## Steps\n\n${filler}\n\n## Scope and reversibility\n\n- scope: repo\n`);
  assert.equal(o.long, true);
  const scope = o.entries.find((e) => e.scope)!;
  const first = o.entries.find((e) => e.level === 2)!;
  const st = initialPlanState(o);
  assert.ok(st.open.has(scope.i), "the scope section is open");
  assert.ok(st.read.has(scope.i), "the scope section counts as read");
  assert.ok(st.open.has(first.i), "the first H2 is open");
  assert.equal(st.open.has(o.entries.find((e) => e.title === "Steps")!.i), false, "other sections start folded");
});

test("the condition sentence is drawn on its own line, so it is not in the recommendation box (two sentences: no box)", () => {
  const md = V2_MD.replace("I recommend SSE. It is the smaller implementation.", "I recommend SSE. If you need two-way messages, choose WebSocket.");
  const m = buildModel(decision(withExplanation(md)));
  assert.equal(m.cond, "If you need two-way messages, choose WebSocket.");
  assert.equal(m.headline, "I recommend SSE.");
  assert.equal(m.recRest, null);
});

test("the condition sentence is cut from the end of the recommendation box; the rest stays", () => {
  const md = V2_MD.replace("I recommend SSE. It is the smaller implementation.", "I recommend SSE. It is the smaller implementation. If you need two-way messages, choose WebSocket.");
  const m = buildModel(decision(withExplanation(md)));
  assert.equal(m.cond, "If you need two-way messages, choose WebSocket.");
  assert.equal(m.recRest, "It is the smaller implementation.");
});

test("a plan's '# H1' that says the header title is not drawn in the left column; a different H1 is kept", () => {
  const same = new App();
  same.upsert(planDecision("# Export retry\n\nBody line.\n\n## Steps\n\n1. x\n"), NOW);
  const outSame = stripAnsi(render(same.view(NOW), { cols: 140, rows: 40 }));
  assert.equal(count(outSame, "Export retry"), 1, "the title once: in the header");
  assert.ok(outSame.includes("Body line."));

  const differs = new App();
  differs.upsert(decision({ kind: "approve_plan", request: { plan: "# Export retry\n\nBody line.\n\n## Steps\n\n1. x\n", planFilePath: "/p" }, ...withExplanation("", { title: "Drop the store" }) } as never), NOW);
  const outDiffers = stripAnsi(render(differs.view(NOW), { cols: 140, rows: 40 }));
  assert.equal(count(outDiffers, "Export retry"), 1, "the different H1 is kept in the left column");
  assert.equal(count(outDiffers, "Drop the store"), 1, "the header carries the title");
});

test("the condition is cut from the middle of the recommendation even when a callout follows it; the callout stays", () => {
  const md = V2_MD.replace("I recommend SSE. It is the smaller implementation.", "A is best. Pick B if X happens.\n\n> [!NOTE] Note\n> extra");
  const m = buildModel(decision(withExplanation(md)));
  assert.equal(m.cond, "Pick B if X happens.");
  assert.ok(!(m.recRest ?? "").includes("Pick B if X happens."), m.recRest ?? "");
  assert.ok((m.recRest ?? "").includes("[!NOTE] Note"), m.recRest ?? "");
});
