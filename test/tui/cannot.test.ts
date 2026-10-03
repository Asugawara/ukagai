import { test } from "node:test";
import assert from "node:assert/strict";
import { App } from "../../src/tui/app.js";
import { MESSAGES } from "../../src/tui/i18n.js";
import type { Key } from "../../src/tui/keys.js";
import { buildModel } from "../../src/tui/model.js";
import { cannotAnswer } from "../../src/tui/cannot.js";
import { renderFrame } from "../../src/tui/render.js";
import { stripAnsi } from "../../src/tui/width.js";
import { Q, V2_MD, decision, withExplanation } from "./helpers.js";

const ch = (c: string): Key => ({ name: "char", ch: c });
const enter: Key = { name: "enter" };
const esc: Key = { name: "esc" };
let now = 1000;
const press = (app: App, ...keys: Key[]) => keys.flatMap((k) => app.handle(k, (now += 10)));
const draw = (app: App) => {
  const f = renderFrame(app.view(now), { cols: 200, rows: 70 });
  app.syncFrame(f, now);
  return { raw: f.text, text: stripAnsi(f.text) };
};
const answerOf = (e: ReturnType<typeof press>): string | undefined => {
  const a = e.find((x) => x.type === "answer");
  return a && a.type === "answer" ? (a.body["answers"] as Record<string, string>)[Q] : undefined;
};

// Modelled on the agent-web-memory question: internal codes are used and never defined.
const AWM_MD = `---
ukagai: 1
question: ${Q}
title: Whether to ship P-GH before the registry change
reversibility: costly
scope: repo
recommended: SSE
---

## Why this decision is needed now

P-GH publishes the image to GHCR. W-T2 and FT4 depend on it, and G-T2 gates TM28.

## Options

| Option | What happens if chosen | Risks and how to undo |
|---|---|---|
| SSE | One-way delivery. | Rewrite later (about 1 day). |
| WebSocket | Two-way is possible. | Adds a dependency. |

## Recommendation

I recommend SSE. It is the smaller implementation.
`;
const AWM_TERMS = ["P-GH", "W-T2", "FT4", "G-T2", "TM28"];

const open = (md: string): App => {
  const app = new App();
  app.upsert(decision(withExplanation(md)), now);
  return app;
};

test("coinedTerms: the codes without a definition, not GHCR", () => {
  const m = buildModel(decision(withExplanation(AWM_MD)));
  assert.deepEqual(m.coinedTerms, AWM_TERMS);
  assert.ok(!m.coinedTerms.includes("GHCR"));
  assert.deepEqual(buildModel(decision(withExplanation(V2_MD))).coinedTerms, []);
  assert.deepEqual(buildModel(decision()).coinedTerms, []);
});

test("coinedTerms: a Terms definition of 12+ characters exempts the term", () => {
  const md = AWM_MD + "\n## Terms\n\n- **W-T2** — the work item that publishes the image to the registry\n";
  assert.deepEqual(buildModel(decision(withExplanation(md))).coinedTerms, ["P-GH", "FT4", "G-T2", "TM28"]);
});

test("x opens the picker with Undefined terms; Space unticks one; Enter sends at once", () => {
  const app = open(AWM_MD);
  press(app, ch("x"));
  assert.equal(app.mode, "cannot");
  const text = draw(app).text;
  assert.match(text, /Can't answer this…/);
  assert.match(text, /\[x\] P-GH/);
  // rows: Undefined terms, P-GH, W-T2, ...
  press(app, ch("j"), ch("j"));
  const effects = press(app, ch(" "));
  assert.deepEqual(effects, []);
  assert.match(draw(app).text, /\[ \] W-T2/);
  const sent = press(app, enter);
  assert.equal(sent.length, 1);
  assert.equal(answerOf(sent), "Cannot answer — Undefined terms: P-GH, FT4, G-T2, TM28");
  assert.equal(app.mode, "normal");
});

test("the cursor can rest on 'Can't answer this' and Enter opens the picker (no send)", () => {
  const app = open(AWM_MD);
  press(app, ch("j"), ch("j")); // SSE -> WebSocket -> None of these
  assert.deepEqual(press(app, ch("j"), enter), []);
  assert.equal(app.mode, "cannot");
  // free text is still reachable after it
  press(app, esc);
  assert.equal(app.mode, "normal");
  press(app, ch("j"));
  press(app, ch("i"));
  assert.equal(app.mode, "input");
});

test("no suspicious token: default Unclear; i adds a note", () => {
  const app = open(V2_MD);
  press(app, ch("x"));
  assert.match(draw(app).text, /▸ Explanation unclear/);
  press(app, ch("i"), ...[..."too dense"].map(ch), enter);
  assert.equal(app.mode, "cannot");
  assert.equal(answerOf(press(app, enter)), "Cannot answer — Unclear: too dense");
});

test("Unclear without a note sends the bare reason; Too much at once is the third row", () => {
  const a = open(V2_MD);
  assert.equal(answerOf(press(a, ch("x"), enter)), "Cannot answer — Unclear");
  const b = open(V2_MD);
  press(b, ch("x"), ch("j"));
  assert.equal(answerOf(press(b, enter)), "Cannot answer — Too much at once");
});

test("unticking every term sends nothing and says why; typing one with i adds it", () => {
  const app = open(AWM_MD);
  press(app, ch("x"), ch("j"));
  for (let i = 0; i < AWM_TERMS.length; i++) press(app, ch(" "), ...(i < AWM_TERMS.length - 1 ? [ch("j")] : []));
  assert.deepEqual(press(app, enter), []);
  assert.equal(app.mode, "cannot");
  assert.match(draw(app).text, /Tick at least one term/);
  press(app, ch("i"), ...[..."ZZ9, Q-1"].map(ch), enter);
  assert.equal(answerOf(press(app, enter)), "Cannot answer — Undefined terms: ZZ9, Q-1");
});

test("a plan has no x", () => {
  const app = new App();
  app.upsert({ ...decision(), kind: "approve_plan", request: { plan: "# P\n\n1. x\n" } } as never, now);
  press(app, ch("x"));
  assert.equal(app.mode, "normal");
  assert.doesNotMatch(draw(app).text, /Can't answer/);
});

test("suspicious tokens are underlined in red in the background", () => {
  const app = open(AWM_MD);
  assert.match(draw(app).raw, /\x1b\[31;4mW-T2/);
});

test("cannotAnswer, i18n keys and the hint", () => {
  assert.equal(cannotAnswer(0, ["A-1"], ""), "Cannot answer — Undefined terms: A-1");
  assert.equal(cannotAnswer(0, [], ""), null);
  assert.equal(cannotAnswer(2, [], "  "), "Cannot answer — Too much at once");
  for (const k of ["cannot_answer", "cannot_terms", "cannot_unclear", "cannot_much", "cannot_terms_hint", "cannot_detail_hint", "hint_cannot", "term_undefined_tip"] as const) {
    assert.ok(MESSAGES.en[k] && MESSAGES.ja[k], k);
  }
  const app = open(V2_MD);
  assert.match(draw(app).text, /x Can't answer/);
  app.lang = "ja";
  assert.match(stripAnsi(renderFrame(app.view(now), { cols: 200, rows: 70 }).text), /x 返答不可/);
});
